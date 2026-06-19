import type {
  PlannerContext,
  PlannerInFlight,
  PlannerPrInfo,
  PlannerRunResult,
  TriagePlannerDeps,
} from "../agent/triage-planner.js";
import { runTriagePlanner } from "../agent/triage-planner.js";
import type { WorkflowQueueTriageConfig } from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { PlanEnvelope, StandingPlan } from "../domain/standing-plan.js";
import { loadStandingPlan, recordPlanRevision } from "./standing-plan-store.js";

// ---------------------------------------------------------------------------
// Shadow plan cycle (SYMPH-784 PR1)
//
// Runs the planner on the heartbeat cadence, persists the resulting revision to
// the standing-plan store, and LOGS the plan. In shadow mode this is the whole
// behavior — dispatch is untouched (zero-diff). PR2 promotes the plan to drive
// dispatch. Everything here is best-effort: a planner outage degrades (the
// consumer falls back to the comparator) and never breaks the poll.
// ---------------------------------------------------------------------------

/** Stable identity of the single living plan (v2 is single-project, SYMPH). */
export const STANDING_PLAN_ID = "symphony-standing-plan";

export interface AssembleShadowPlannerContextInput {
  candidates: Issue[];
  inFlight: PlannerInFlight[];
  envelope: PlanEnvelope;
  openPrs?: PlannerPrInfo[];
  recentlyMerged?: PlannerPrInfo[];
}

export function assembleShadowPlannerContext(
  input: AssembleShadowPlannerContextInput,
): PlannerContext {
  const inFlightIdentifiers = new Set(
    input.inFlight.map((entry) => entry.issueIdentifier),
  );
  const backlog = input.candidates
    .filter((issue) => !inFlightIdentifiers.has(issue.identifier))
    .map((issue) => ({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: issue.title,
      priority: issue.priority,
      state: issue.state,
    }));
  return {
    backlog,
    inFlight: input.inFlight,
    openPrs: input.openPrs ?? [],
    recentlyMerged: input.recentlyMerged ?? [],
    envelope: input.envelope,
  };
}

export function shouldRunShadowPlanCycle(input: {
  plan: StandingPlan | null;
  nowMs: number;
  heartbeatMs: number;
}): boolean {
  if (input.plan === null) {
    return true;
  }
  const updatedMs = Date.parse(input.plan.updatedAt);
  if (Number.isNaN(updatedMs)) {
    return true;
  }
  return input.nowMs - updatedMs >= input.heartbeatMs;
}

export type ShadowPlanCycleResult =
  | { status: "ok"; recorded: boolean; revision: number; batchCount: number }
  | { status: "unavailable"; detail: string }
  | { status: "invalid"; detail: string };

export interface ShadowPlanCycleDeps {
  workspaceRoot: string;
  context: PlannerContext;
  planner: TriagePlannerDeps;
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
  now: () => Date;
  planId?: string;
}

export async function runShadowPlanCycle(
  deps: ShadowPlanCycleDeps,
): Promise<ShadowPlanCycleResult> {
  const planned = await runTriagePlanner(deps.context, deps.planner);

  if (planned.status === "unavailable") {
    await deps.log(
      "queue_triage_planner_unavailable",
      "Standing-plan planner unavailable; pipeline keeps using the deterministic comparator.",
      { outcome: "degraded", detail: planned.detail },
    );
    return { status: "unavailable", detail: planned.detail };
  }
  if (planned.status === "invalid") {
    await deps.log(
      "queue_triage_planner_invalid",
      "Standing-plan planner produced unparseable output; no revision recorded.",
      { outcome: "degraded", detail: planned.detail },
    );
    return { status: "invalid", detail: planned.detail };
  }

  const record = await recordPlanRevision(deps.workspaceRoot, planned.body, {
    createdAt: deps.now().toISOString(),
    planId: deps.planId ?? STANDING_PLAN_ID,
  });

  await deps.log(
    "queue_triage_shadow_plan",
    "Standing-plan shadow cycle computed a plan (shadow mode — dispatch unchanged).",
    {
      outcome: "shadow",
      recorded: record.recorded,
      revision: record.plan.revision,
      plan_id: record.plan.planId,
      content_hash: record.plan.contentHash,
      batch_count: record.plan.batches.length,
      rationale: record.plan.rationale,
      batches: record.plan.batches.map((batch) => ({
        batch_id: batch.batchId,
        mode: batch.mode,
        status: batch.status,
        members: batch.members.map((member) => member.issueIdentifier),
      })),
    },
  );

  return {
    status: "ok",
    recorded: record.recorded,
    revision: record.plan.revision,
    batchCount: record.plan.batches.length,
  };
}

export type StandingPlanShadowTickResult =
  | ShadowPlanCycleResult
  | { status: "skipped"; reason: "disabled" | "heartbeat" | "error" };

export interface StandingPlanShadowTickDeps {
  config: WorkflowQueueTriageConfig | undefined;
  workspaceRoot: string;
  fetchCandidates: () => Promise<Issue[]>;
  getInFlight: () => PlannerInFlight[];
  /** Build a model runner for the configured planner model (cmux in prod). */
  createPlannerRunner: (
    model: string,
  ) => (prompt: string) => Promise<PlannerRunResult>;
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
  now: () => Date;
  /**
   * Bypass the heartbeat cadence and re-plan now (SYMPH-787/789): a re-plan
   * trigger predicate tripped, or an operator modify_plan intent landed.
   */
  force?: boolean;
}

/**
 * One heartbeat-gated, best-effort shadow tick wired into the poll loop. It is
 * inert unless explicitly enabled, runs entirely AFTER the dispatch decision,
 * and writes only to the standing-plan store — so the dispatch path is
 * byte-identical whether or not the feature is on (zero-diff). Any failure is
 * swallowed: the planner is never allowed to break the poll.
 */
export async function runStandingPlanShadowTick(
  deps: StandingPlanShadowTickDeps,
): Promise<StandingPlanShadowTickResult> {
  const config = deps.config;
  if (config === undefined || !config.enabled) {
    return { status: "skipped", reason: "disabled" };
  }
  try {
    const plan = await loadStandingPlan(deps.workspaceRoot);
    if (
      deps.force !== true &&
      !shouldRunShadowPlanCycle({
        plan,
        nowMs: deps.now().getTime(),
        heartbeatMs: config.heartbeatMs,
      })
    ) {
      return { status: "skipped", reason: "heartbeat" };
    }

    if (!config.shadowMode) {
      // shadow_mode:false is reserved for the PR2 dispatch consumer. Until it
      // lands, the planner is shadow-only regardless — warn so an operator who
      // set the flag expecting plan-driven dispatch is not silently misled
      // (council R1, Pi P2).
      await deps.log(
        "queue_triage_shadow_mode_required",
        "queue_triage shadow_mode=false is not yet supported; the planner remains shadow-only until the dispatch consumer (SYMPH-787) lands.",
        { outcome: "degraded" },
      );
    }

    const candidates = await deps.fetchCandidates();
    const context = assembleShadowPlannerContext({
      candidates,
      inFlight: deps.getInFlight(),
      envelope: config.envelope,
    });
    const runClaude = deps.createPlannerRunner(config.plannerModel);
    return await runShadowPlanCycle({
      workspaceRoot: deps.workspaceRoot,
      context,
      planner: { runClaude },
      log: deps.log,
      now: deps.now,
    });
  } catch (error) {
    await deps.log(
      "queue_triage_shadow_failed",
      "Standing-plan shadow tick failed (best-effort; dispatch unaffected).",
      { outcome: "degraded", detail: (error as Error).message },
    );
    return { status: "skipped", reason: "error" };
  }
}
