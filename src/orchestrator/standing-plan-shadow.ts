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
      // SYMPH-841: carry the recorded blocker identifiers through to the planner
      // so its dependency reasoning is grounded in the real graph, not just titles.
      blockedBy: issue.blockedBy
        .map((ref) => ref.identifier)
        .filter((identifier): identifier is string => identifier !== null),
      // SYMPH-874: carry the body + labels so the Manager reasons over real
      // ticket content (surface / area / intent), not just one-line titles.
      description: issue.description,
      labels: issue.labels,
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
  lastRunAtMs?: number;
}): boolean {
  if (input.plan === null) {
    return true;
  }
  const updatedMs = Date.parse(input.plan.updatedAt);
  if (Number.isNaN(updatedMs)) {
    return true;
  }
  const lastRunAtMs = input.lastRunAtMs ?? updatedMs;
  return input.nowMs - Math.max(updatedMs, lastRunAtMs) >= input.heartbeatMs;
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
  | {
      status: "skipped";
      reason: "disabled" | "heartbeat" | "cadence" | "error";
    };

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

const shadowPlanLastRunAtByWorkspace = new Map<string, number>();

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
    const now = deps.now();
    const nowMs = now.getTime();
    const lastRunAtMs = shadowPlanLastRunAtByWorkspace.get(deps.workspaceRoot);
    // SYMPH-828: rate-limit by ATTEMPTED-run time. The marker below is advanced
    // on every ATTEMPT (not only on success), so a persistently THROWING cycle
    // (a fetch/record/planner exception) respects the heartbeat cadence instead
    // of retrying — and re-emitting the noisy degradation log — every poll. This
    // gate ALSO covers the no-plan-yet outage that shouldRunShadowPlanCycle
    // cannot: that helper returns `true` whenever plan === null, ignoring the
    // marker, so without this a planner outage with no plan recorded would re-run
    // every poll. A forced re-plan (operator intent / tripped predicate) bypasses
    // the cadence. The skip reason is distinct ("cadence" — rate-limited by a
    // recent attempt, success OR failure) from the plan-freshness "heartbeat"
    // gate below, so the two remain separable if a result consumer is ever added
    // (today the tick result is fire-and-forget at the poll-loop call site).
    if (
      deps.force !== true &&
      lastRunAtMs !== undefined &&
      nowMs - lastRunAtMs < config.heartbeatMs
    ) {
      return { status: "skipped", reason: "cadence" };
    }
    const plan = await loadStandingPlan(deps.workspaceRoot);
    if (
      deps.force !== true &&
      !shouldRunShadowPlanCycle({
        plan,
        nowMs,
        heartbeatMs: config.heartbeatMs,
        ...(lastRunAtMs === undefined ? {} : { lastRunAtMs }),
      })
    ) {
      return { status: "skipped", reason: "heartbeat" };
    }

    // Committed to an attempt: advance the attempted-run marker NOW, before the
    // expensive fetch/plan, so a throwing cycle still respects cadence
    // (SYMPH-828). The marker is in-memory, so a process restart permits one
    // extra attempt before the cadence re-establishes — accepted as cheaper than
    // a durable heartbeat (one planner call per restart, not per poll).
    shadowPlanLastRunAtByWorkspace.set(deps.workspaceRoot, nowMs);

    // Note: shadow_mode=false is now functional — the consumer (SYMPH-787)
    // drives dispatch from this plan. The planner heartbeat itself runs in both
    // modes; shadowMode only gates whether the plan drives dispatch (in the
    // consumer), so there is nothing to warn about here.

    const candidates = await deps.fetchCandidates();
    const context = assembleShadowPlannerContext({
      candidates,
      inFlight: deps.getInFlight(),
      envelope: config.envelope,
    });
    const runClaude = deps.createPlannerRunner(config.plannerModel);
    const result = await runShadowPlanCycle({
      workspaceRoot: deps.workspaceRoot,
      context,
      planner: { runClaude },
      log: deps.log,
      now: () => now,
    });
    return result;
  } catch (error) {
    await deps.log(
      "queue_triage_shadow_failed",
      "Standing-plan shadow tick failed (best-effort; dispatch unaffected).",
      { outcome: "degraded", detail: (error as Error).message },
    );
    return { status: "skipped", reason: "error" };
  }
}
