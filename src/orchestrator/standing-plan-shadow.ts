import { join } from "node:path";

import {
  type CuratedPlannerComment,
  type PlannerCommentCurationConfig,
  type PlannerCommentCurationResult,
  type PlannerCommentEnrichmentMeasurement,
  type PlannerCommentRelevanceScorer,
  curatePlannerComments,
  measurePlannerCommentEnrichment,
} from "../agent/planner-comment-curation.js";
import type {
  HotFileGrowth,
  PlannerContext,
  PlannerInFlight,
  PlannerRunResult,
  TriagePlannerDeps,
} from "../agent/triage-planner.js";
import { runTriagePlanner } from "../agent/triage-planner.js";
import type {
  WorkflowOperatorAnchorsConfig,
  WorkflowQueueTriageCommentEnrichmentConfig,
  WorkflowQueueTriageConfig,
} from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { PlanRevision, StandingPlan } from "../domain/standing-plan.js";
import type { LinearIssueComment } from "../tracker/linear-client.js";
import {
  type PlanPostEmitReviewDeps,
  type PlanPostEmitReviewResult,
  runPlanPostEmitReview,
} from "./plan-post-emit-review.js";
import {
  applyStandingPlanAdvisoryLifecycle,
  prepareBacklogAdvisoryInput,
} from "./standing-plan-advisory-lifecycle.js";
import type { ShadowPlannerAuditDisposition } from "./standing-plan-audit-dispositions.js";
import {
  type AssembleShadowPlannerContextInput,
  assembleShadowPlannerContext as assembleStandingPlanContext,
} from "./standing-plan-context.js";
import {
  buildQueueHealth,
  computeResidualShare,
} from "./standing-plan-queue-health.js";
import {
  loadLastReviewedContentHash,
  loadStandingPlan,
  recordPlanRevision,
} from "./standing-plan-store.js";
import type { RecordPlanRevisionResult } from "./standing-plan-store.js";
import type {
  PlanBody,
  RotateRevisionOptions,
} from "./standing-plan-supersession.js";
import { rotateRevision } from "./standing-plan-supersession.js";
import type {
  StructuralAdvisoryGradeEvidence,
  StructuralAdvisoryRejection,
} from "./structural-advisory-journal.js";
import {
  type TriageIntakePublisher,
  collectTriageIntakeHealth,
} from "./triage-intake-reporting.js";
import type {
  PrepareTriagePlannerContextResult,
  ShadowTriagePrepInput,
} from "./triage-prep.js";

export type { AssembleShadowPlannerContextInput };

const ADVISORY_ACTIVITY_ISSUE_LIMIT = 100;

export {
  buildShadowPlannerAuditDispositions,
  buildShadowPlannerSupersessionRelationDispositions,
} from "./standing-plan-audit-dispositions.js";
export function assembleShadowPlannerContext(
  input: AssembleShadowPlannerContextInput,
): PlannerContext {
  return assembleStandingPlanContext(input);
}

/**
 * Filter fetched issues down to the operator-configured planner candidate states
 * (SYMPH-1142). This is the PRIMARY, running-set-independent exclusion of
 * in-flight states (In Progress, In Review, Resume): the planner backlog is seeded
 * only from these states, so an issue that is In Progress but momentarily absent
 * from the runtime running set can never leak into a plan. Comparison is
 * case-insensitive and trims tracker whitespace. An empty configured list disables
 * state filtering (pass-through) rather than emptying the backlog — the running
 * subtraction belt and disposition exclusion still apply downstream.
 */
export function filterPlannerCandidateStates(
  candidates: readonly Issue[],
  states: readonly string[],
): Issue[] {
  const allowed = new Set(
    states
      .map((state) => state.trim().toLowerCase())
      .filter((state) => state !== ""),
  );
  if (allowed.size === 0) {
    return [...candidates];
  }
  return candidates.filter((issue) =>
    allowed.has(issue.state.trim().toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Shadow plan cycle (SYMPH-784 PR1)
//
// Runs the planner on the heartbeat cadence, persists the resulting revision to
// the standing-plan store, and LOGS the plan. In shadow mode this is the whole
// behavior — dispatch is untouched. A planner outage degrades (the
// consumer falls back to the comparator) and never breaks the poll.
// ---------------------------------------------------------------------------

/** Stable identity of the single living plan (v2 is single-project, SYMPH). */
export const STANDING_PLAN_ID = "symphony-standing-plan";

export {
  RESIDUAL_TRACK_MARKER,
  TRIAGE_INFLOW_WINDOW_MS,
  buildQueueHealth,
  computeResidualShare,
  computeTriageIntake,
} from "./standing-plan-queue-health.js";

export interface EnrichPlannerContextWithCommentsDeps {
  context: PlannerContext;
  config: WorkflowQueueTriageCommentEnrichmentConfig;
  fetchIssueComments: (
    issueId: string,
    options: { maxPages?: number },
  ) => Promise<LinearIssueComment[]>;
  operatorConfig?: Pick<
    WorkflowOperatorAnchorsConfig,
    "operatorAllowlist" | "serviceAccounts"
  >;
  commentRelevanceScorer?: PlannerCommentRelevanceScorer;
}

export interface EnrichPlannerContextWithCommentsResult {
  context: PlannerContext;
  measurement: PlannerCommentEnrichmentMeasurement;
}

/**
 * Curated-comment enrichment (SYMPH-874 Tier 3 / SYMPH-896). Fetches issue
 * comments for the head of the backlog (bounded by `maxCandidates` — the N+1
 * fetch is the measured cost), curates each deterministically, attaches the
 * survivors to a NEW candidate (never mutates input), and returns the enriched
 * context plus a report-only measurement. Per-candidate fetch failures are
 * swallowed (best-effort): one bad fetch must never abort enrichment or the tick.
 */
export async function enrichPlannerContextWithComments(
  deps: EnrichPlannerContextWithCommentsDeps,
): Promise<EnrichPlannerContextWithCommentsResult> {
  const { context, config } = deps;
  const curationConfig: PlannerCommentCurationConfig = {
    maxComments: config.maxComments,
    maxCommentChars: config.maxCommentChars,
    maxTotalChars: config.maxTotalChars,
  };
  const toFetch = context.backlog.slice(0, Math.max(0, config.maxCandidates));
  const candidatesTruncated = context.backlog.length - toFetch.length;

  const results: PlannerCommentCurationResult[] = [];
  const enrichedById = new Map<string, CuratedPlannerComment[]>();
  let candidatesFailed = 0;
  for (const candidate of toFetch) {
    let curation: PlannerCommentCurationResult | null = null;
    try {
      const comments = await deps.fetchIssueComments(candidate.issueId, {
        maxPages: config.maxCommentPages,
      });
      curation = curatePlannerComments(
        comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          actor: comment.botActor ?? comment.user,
        })),
        {
          config: curationConfig,
          ...(deps.commentRelevanceScorer === undefined
            ? {}
            : { relevanceScorer: deps.commentRelevanceScorer }),
          ...(deps.operatorConfig === undefined
            ? {}
            : { operatorConfig: deps.operatorConfig }),
        },
      );
    } catch {
      // Best-effort per candidate: a single comment-fetch failure must not abort
      // the whole enrichment (or the tick). Count it so the measurement reflects
      // the N+1 cost actually paid (council Track) — a failed fetch still cost a
      // round trip and must not make the surface look cheaper than it is.
      candidatesFailed += 1;
      curation = null;
    }
    if (curation !== null) {
      results.push(curation);
      if (curation.comments.length > 0) {
        enrichedById.set(candidate.issueId, curation.comments);
      }
    }
  }

  const enrichedBacklog = context.backlog.map((candidate) => {
    const comments = enrichedById.get(candidate.issueId);
    return comments === undefined ? candidate : { ...candidate, comments };
  });

  return {
    context: { ...context, backlog: enrichedBacklog },
    measurement: measurePlannerCommentEnrichment({
      candidatesConsidered: context.backlog.length,
      candidatesTruncated,
      candidatesFailed,
      results,
    }),
  };
}

function summarizePlannerGrounding(
  context: PlannerContext,
): Record<string, number> {
  let evidenceCount = 0;
  let groundedCount = 0;
  let ungroundedCount = 0;
  let extractorCallCount = 0;
  let evidenceWallClockMs = 0;
  for (const candidate of context.backlog) {
    const evidence = candidate.groundingEvidence;
    if (evidence === undefined) {
      continue;
    }
    evidenceCount += 1;
    if (evidence.status === "grounded") {
      groundedCount += 1;
    } else {
      ungroundedCount += 1;
    }
    extractorCallCount += evidence.extractorCallCount;
    evidenceWallClockMs += evidence.wallClockMs;
  }
  return {
    candidate_count: context.backlog.length,
    evidence_count: evidenceCount,
    grounded_count: groundedCount,
    ungrounded_count: ungroundedCount,
    extractor_call_count: extractorCallCount,
    evidence_wall_clock_ms: evidenceWallClockMs,
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
  /** Effective lane settings recorded with the live planner journal event. */
  plannerAttribution?: {
    model: string;
    effort: WorkflowQueueTriageConfig["plannerEffort"];
  };
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
  now: () => Date;
  planId?: string;
  planReview?: {
    enabled: boolean;
    plannerGroundingEnabled: boolean;
    lastReviewedContentHash: string | null;
    artifactDir: string;
    workspace: string;
    env?: NodeJS.ProcessEnv;
  };
  runPlanPostEmitReview?: (
    deps: PlanPostEmitReviewDeps,
  ) => Promise<PlanPostEmitReviewResult>;
  persistPlanRevision?: (
    workspaceRoot: string,
    body: PlanBody,
    options: RotateRevisionOptions,
  ) => Promise<RecordPlanRevisionResult>;
  advisoryLifecycle?: {
    previous: PlanRevision["structuralAdvisories"];
    dormantOkTicks: number;
    renderCap: number;
    scanComplete: boolean;
    terminalIssueIdentifiers: ReadonlySet<string>;
    resolveRootIssueIdentifier?: (identifier: string) => Promise<boolean>;
    rejectedMemberSets?: readonly StructuralAdvisoryRejection[];
    issueActivity?: ReadonlyMap<string, string | null>;
    recordTransition?: (input: {
      advisory: NonNullable<PlanRevision["structuralAdvisories"]>[number];
      from: string | null;
      to: string;
    }) => Promise<void>;
  };
}

export async function runShadowPlanCycle(
  deps: ShadowPlanCycleDeps,
): Promise<ShadowPlanCycleResult> {
  const planned = await runTriagePlanner(deps.context, deps.planner);

  if (planned.status === "unavailable") {
    await deps.log(
      "queue_triage_planner_unavailable",
      "Standing-plan planner unavailable; pipeline keeps using the deterministic comparator.",
      {
        outcome: "degraded",
        ...plannerAttributionFields(deps.plannerAttribution),
        detail: planned.detail,
        attempts: planned.attempts,
      },
    );
    return { status: "unavailable", detail: planned.detail };
  }
  if (planned.status === "invalid") {
    await deps.log(
      "queue_triage_planner_invalid",
      "Standing-plan planner produced unparseable output; no revision recorded.",
      {
        outcome: "degraded",
        ...plannerAttributionFields(deps.plannerAttribution),
        detail: planned.detail,
        attempts: planned.attempts,
      },
    );
    return { status: "invalid", detail: planned.detail };
  }

  let body = planned.body;
  if (deps.context.structuralAdvisoriesEnabled === false) {
    body = { ...body, structuralAdvisories: [] };
  } else if (deps.advisoryLifecycle !== undefined) {
    body = await applyStandingPlanAdvisoryLifecycle({
      body,
      previous: deps.advisoryLifecycle.previous ?? [],
      context: deps.context,
      config: {
        dormantOkTicks: deps.advisoryLifecycle.dormantOkTicks,
        renderCap: deps.advisoryLifecycle.renderCap,
      },
      scanComplete: deps.advisoryLifecycle.scanComplete,
      terminalIssueIdentifiers: deps.advisoryLifecycle.terminalIssueIdentifiers,
      log: deps.log,
      ...(deps.advisoryLifecycle.rejectedMemberSets === undefined
        ? {}
        : {
            rejectedMemberSets: deps.advisoryLifecycle.rejectedMemberSets,
          }),
      ...(deps.advisoryLifecycle.issueActivity === undefined
        ? {}
        : { issueActivity: deps.advisoryLifecycle.issueActivity }),
      ...(deps.advisoryLifecycle.recordTransition === undefined
        ? {}
        : { recordTransition: deps.advisoryLifecycle.recordTransition }),
      ...(deps.advisoryLifecycle.resolveRootIssueIdentifier === undefined
        ? {}
        : {
            resolveRootIssueIdentifier:
              deps.advisoryLifecycle.resolveRootIssueIdentifier,
          }),
    });
  }
  const planId = deps.planId ?? STANDING_PLAN_ID;
  const createdAt = deps.now().toISOString();
  const tier2Body =
    deps.planReview?.enabled === true
      ? planBodyFromRevision(
          rotateRevision(await loadStandingPlan(deps.workspaceRoot), body, {
            createdAt,
            planId,
          }),
        )
      : undefined;
  const postEmitReview = deps.runPlanPostEmitReview ?? runPlanPostEmitReview;
  const review = await postEmitReview({
    context: deps.context,
    body,
    runClaude: deps.planner.runClaude,
    ...(deps.planReview?.enabled === true
      ? {
          tier2: {
            enabled: true,
            planId,
            artifactDir: deps.planReview.artifactDir,
            workspace: deps.planReview.workspace,
            plannerGroundingEnabled: deps.planReview.plannerGroundingEnabled,
            ...(tier2Body === undefined ? {} : { body: tier2Body }),
            lastReviewedContentHash: deps.planReview.lastReviewedContentHash,
            ...(deps.planReview.env === undefined
              ? {}
              : { env: deps.planReview.env }),
          },
        }
      : {}),
  });

  const persistPlanRevision = deps.persistPlanRevision ?? recordPlanRevision;
  const reviewOptions: RotateRevisionOptions = {
    createdAt,
    planId,
    findings: review.findings,
    ...(review.reviewRecords.length === 0
      ? {}
      : { reviewRecords: review.reviewRecords }),
  };
  const record = await persistPlanRevision(
    deps.workspaceRoot,
    body,
    reviewOptions,
  );
  const tier2Record = review.reviewRecords.find(
    (record) => record.tier === "tier-2",
  );

  await deps.log(
    "queue_triage_shadow_plan",
    "Standing-plan shadow cycle computed a plan (shadow mode — dispatch unchanged).",
    {
      outcome: "shadow",
      ...plannerAttributionFields(deps.plannerAttribution),
      attempts: planned.attempts,
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
      review_findings: record.plan.findings ?? [],
      ...(tier2Record === undefined
        ? {}
        : {
            review_tier2: {
              gate_reason: tier2Record.gateReason,
              status: tier2Record.status,
              aggregate_verdict: tier2Record.aggregateVerdict,
              finding_count: tier2Record.findingFingerprints.length,
              // Skip disambiguation (SYMPH-1068): `note` separates the legitimate
              // "plan content hash already reviewed" (content_hash_unchanged) skip
              // from the inert-state "no grounded evidence" skip, which share
              // status=skipped and can share gate_reason — so the noise does not
              // pollute the SYMPH-1034 catch/FP math.
              note: tier2Record.note,
              // Per-lane telemetry (SYMPH-1068): decorrelation attribution (which
              // lane caught what) + cost-per-catch. Empty when no lanes ran.
              per_lane: (tier2Record.perLane ?? []).map((lane) => ({
                reviewer: lane.reviewer,
                verdict: lane.verdict,
                finding_count: lane.findingCount,
                input_tokens: lane.inputTokens,
                output_tokens: lane.outputTokens,
              })),
            },
          }),
    },
  );

  return {
    status: "ok",
    recorded: record.recorded,
    revision: record.plan.revision,
    batchCount: record.plan.batches.length,
  };
}

function plannerAttributionFields(
  attribution: ShadowPlanCycleDeps["plannerAttribution"],
): Record<string, unknown> {
  return attribution === undefined
    ? {}
    : {
        planner_model: attribution.model,
        planner_effort: attribution.effort,
      };
}

export type StandingPlanShadowTickResult =
  | ShadowPlanCycleResult
  | {
      status: "skipped";
      reason: "disabled" | "heartbeat" | "cadence" | "error" | "empty_backlog";
    };

export interface StandingPlanShadowGroundingInput {
  context: PlannerContext;
  candidates: readonly Issue[];
  now: () => Date;
}

export interface StandingPlanShadowGroundingResult {
  context: PlannerContext;
}

export interface StandingPlanShadowTickDeps {
  config: WorkflowQueueTriageConfig | undefined;
  workspaceRoot: string;
  fetchCandidates: () => Promise<Issue[]>;
  /** Backlog-state scan input; used only when structural advisories are armed. */
  fetchAdvisoryInput?: () => Promise<Issue[]>;
  /** Tracker states that count as terminal for majority-terminal withdrawal. */
  terminalStates?: readonly string[];
  resolveIssueByIdentifier?: (identifier: string) => Promise<Issue | null>;
  getAdvisoryRejections?: () => readonly StructuralAdvisoryRejection[];
  getAdvisoryGradeEvidence?: () => readonly StructuralAdvisoryGradeEvidence[];
  recordAdvisoryTransition?: (input: {
    advisory: NonNullable<PlanRevision["structuralAdvisories"]>[number];
    from: string | null;
    to: string;
  }) => Promise<void>;
  getInFlight: () => PlannerInFlight[];
  /**
   * Resolved crabrunner planner lane host (SYMPH-1144), e.g. "pro16", or "local"
   * when no host is configured. Recorded on EVERY planner tick journal record
   * (including skipped_empty_backlog) so lane placement is observable. Defaults to
   * "local" when absent.
   */
  plannerHost?: string;
  /** Build a model runner for the configured planner model (crabrunner in prod). */
  createPlannerRunner: (
    model: string,
    effort: WorkflowQueueTriageConfig["plannerEffort"],
  ) => (prompt: string) => Promise<PlannerRunResult>;
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
  now: () => Date;
  /**
   * Inject the Linear comment fetch for curated-comment enrichment (SYMPH-896).
   * Optional: enrichment is skipped when this is absent OR when
   * `commentEnrichment.enabled` is false (the default).
   */
  fetchIssueComments?: (
    issueId: string,
    options: { maxPages?: number },
  ) => Promise<LinearIssueComment[]>;
  /**
   * Report-only code grounding for planner candidates (SYMPH-1065).
   * Optional and injected by runtime-host only when planner/code grounding are
   * both enabled; absent preserves the default shadow tick byte-for-byte and
   * avoids target resolution, cloning, extraction, or telemetry cost.
   */
  groundPlannerContext?: (
    input: StandingPlanShadowGroundingInput,
  ) => Promise<StandingPlanShadowGroundingResult>;
  /** Flag-gated deterministic evidence transform for backlog/advisory findings. */
  prepareTriagePlannerContext?: (
    input: ShadowTriagePrepInput,
  ) => Promise<PrepareTriagePlannerContextResult>;
  /**
   * Operator/service-account sets for comment noise classification (SYMPH-896).
   * Service-account comments (Symphony's own writes) are dropped as noise.
   */
  operatorConfig?: Pick<
    WorkflowOperatorAnchorsConfig,
    "operatorAllowlist" | "serviceAccounts"
  >;
  /**
   * SYMPH-939 health signals — all OPTIONAL and injected (mirroring fetchIssueComments).
   * When wired, runStandingPlanShadowTick computes QueueHealth from them; when absent,
   * health is omitted and the prompt is byte-unchanged. Each is independently best-effort.
   *
   * Production binding in runtime-host.ts wires these to
   * fetchIssuesByStates(['Triage']) / fetchIssuesByStates(['Backlog','Triage']) / the
   * persisted review journal / () => readHotFileGrowth({ repoPath: resolveRuntimeRepoRoot() }).
   */
  /** Fetch Triage-state issues for Triage-intake (depth + recent inflow). */
  fetchTriageIssues?: () => Promise<Issue[]>;
  onTriageIntakeComputed?: TriageIntakePublisher;
  /** Fetch the Backlog+Triage population for residual-share (the [track:] marker fraction). */
  fetchResidualIssues?: () => Promise<Issue[]>;
  /** Read the persisted review-round depth (rounds_per_cycle); null when no recent reviews. */
  getReviewRoundDepth?: () => Promise<number | null>;
  /** Read hot-file growth (bound thunk over the git-churn reader); null on any read failure. */
  getHotFileGrowth?: () => Promise<HotFileGrowth | null>;
  /** Durable tier-2 diff-gate baseline read. Defaults to the standing-plan store. */
  loadLastReviewedContentHash?: (
    workspaceRoot: string,
  ) => Promise<string | null>;
  /** Optional tier-2 artifact directory override for tests or custom runtimes. */
  planReviewArtifactDir?: string;
  /** Optional review workspace override. Defaults to the current process cwd. */
  planReviewWorkspace?: string;
  runPlanPostEmitReview?: (
    deps: PlanPostEmitReviewDeps,
  ) => Promise<PlanPostEmitReviewResult>;
  auditDispositions?: readonly ShadowPlannerAuditDisposition[];
  /**
   * Bypass the heartbeat cadence and re-plan now (SYMPH-787/789): a re-plan
   * trigger predicate tripped, or an operator modify_plan intent landed.
   */
  force?: boolean;
}

const shadowPlanLastRunAtByWorkspace = new Map<string, number>();

function latestIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
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
  // Every planner tick journal record carries the resolved crabrunner planner
  // lane host (SYMPH-1144) so lane placement is observable — including the
  // skipped_empty_backlog marker below and the records the delegated plan cycle
  // emits. Wrapping deps.log here (rather than threading the field into each
  // call) guarantees the field on every record without a per-call opt-in.
  const plannerHost = deps.plannerHost ?? "local";
  const log: StandingPlanShadowTickDeps["log"] = (event, message, fields) =>
    deps.log(event, message, { ...fields, planner_host: plannerHost });
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

    const fetchedCandidates = await deps.fetchCandidates();
    // SYMPH-1142: filter to the operator-configured planner candidate states
    // BEFORE prompt/lane creation and comment enrichment. This is the PRIMARY
    // exclusion of in-flight states (In Progress, In Review, Resume): it holds
    // even when the runtime running set is momentarily empty. The in-flight
    // (running) subtraction inside assembleShadowPlannerContext stays as a belt.
    const candidates = filterPlannerCandidateStates(
      fetchedCandidates,
      config.plannerCandidateStates,
    );
    const advisoryRejections = deps.getAdvisoryRejections?.() ?? [];
    const advisoryGradeEvidence = deps.getAdvisoryGradeEvidence?.() ?? [];
    let advisoryInputCandidates: Issue[] = [];
    let advisoryInputScanComplete = false;
    let terminalIssueIdentifiers = new Set<string>();
    let issueActivity = new Map<string, string | null>();
    if (config.structuralAdvisories === true) {
      if (deps.fetchAdvisoryInput === undefined) {
        await log(
          "queue_triage_structural_advisory_input_failed",
          "Backlog advisory-input fetch is not wired; preserving lifecycle state.",
          { outcome: "degraded", detail: "fetch_not_wired" },
        );
      } else {
        try {
          const advisoryIssues = await deps.fetchAdvisoryInput();
          const prepared = prepareBacklogAdvisoryInput(
            advisoryIssues,
            deps.terminalStates,
          );
          advisoryInputCandidates = prepared.eligible;
          terminalIssueIdentifiers = prepared.terminalIssueIdentifiers;
          advisoryInputScanComplete = true;
          const activityIssues = new Map(
            [...advisoryIssues, ...candidates].map((issue) => [
              issue.identifier,
              issue,
            ]),
          );
          const relevantIdentifiers = [
            ...new Set([
              ...advisoryRejections.flatMap((rejection) =>
                Object.keys(rejection.memberActivityAtGrade),
              ),
              ...(plan?.structuralAdvisories ?? []).flatMap(
                (advisory) => advisory.memberIssueIdentifiers,
              ),
            ]),
          ].slice(0, ADVISORY_ACTIVITY_ISSUE_LIMIT);
          if (deps.resolveIssueByIdentifier !== undefined) {
            await Promise.all(
              relevantIdentifiers
                .filter((identifier) => !activityIssues.has(identifier))
                .map(async (identifier) => {
                  try {
                    const resolved =
                      await deps.resolveIssueByIdentifier?.(identifier);
                    if (resolved !== null && resolved !== undefined) {
                      activityIssues.set(identifier, resolved);
                    }
                  } catch (error) {
                    await log(
                      "queue_triage_advisory_member_activity_resolve_failed",
                      "Advisory member activity could not be resolved; preserving available activity evidence.",
                      {
                        outcome: "degraded",
                        issue_identifier: identifier,
                        detail: (error as Error).message,
                      },
                    );
                  }
                }),
            );
          }
          const terminalStates = new Set(
            (deps.terminalStates ?? []).map((state) => state.toLowerCase()),
          );
          const alreadyPresented = new Set([
            ...candidates.map((issue) => issue.identifier),
            ...advisoryInputCandidates.map((issue) => issue.identifier),
          ]);
          for (const identifier of relevantIdentifiers) {
            const issue = activityIssues.get(identifier);
            if (issue === undefined || alreadyPresented.has(identifier))
              continue;
            if (terminalStates.has(issue.state.toLowerCase())) {
              terminalIssueIdentifiers.add(identifier);
            } else {
              advisoryInputCandidates.push(issue);
              alreadyPresented.add(identifier);
            }
          }
          const relevantSet = new Set(relevantIdentifiers);
          const boundedActivityIssues = [
            ...relevantIdentifiers.flatMap((identifier) => {
              const issue = activityIssues.get(identifier);
              return issue === undefined ? [] : [issue];
            }),
            ...[...activityIssues.values()].filter(
              (issue) => !relevantSet.has(issue.identifier),
            ),
          ].slice(0, ADVISORY_ACTIVITY_ISSUE_LIMIT);
          issueActivity = new Map(
            boundedActivityIssues.map((issue) => [
              issue.identifier,
              issue.updatedAt,
            ]),
          );
          if (deps.fetchIssueComments !== undefined) {
            await Promise.all(
              boundedActivityIssues.map(async (issue) => {
                try {
                  const comments = await deps.fetchIssueComments?.(issue.id, {
                    maxPages: 10,
                  });
                  const latestCommentAt = (comments ?? []).reduce<
                    string | null
                  >(
                    (latest, comment) => latestIso(latest, comment.updatedAt),
                    null,
                  );
                  issueActivity.set(
                    issue.identifier,
                    latestIso(issue.updatedAt, latestCommentAt),
                  );
                } catch (error) {
                  await log(
                    "queue_triage_advisory_comment_activity_failed",
                    "Advisory member comment activity could not be read; using issue activity only.",
                    {
                      outcome: "degraded",
                      issue_id: issue.id,
                      issue_identifier: issue.identifier,
                      detail: (error as Error).message,
                    },
                  );
                }
              }),
            );
          }
          if (prepared.heldCount > 0) {
            await log(
              "queue_triage_structural_advisory_portfolio_held",
              "Portfolio-held Backlog issues were excluded from advisory input.",
              { outcome: "report_only", held_count: prepared.heldCount },
            );
          }
        } catch (error) {
          await log(
            "queue_triage_structural_advisory_input_failed",
            "Backlog advisory-input fetch failed; preserving lifecycle state.",
            { outcome: "degraded", detail: (error as Error).message },
          );
        }
      }
    }

    // SYMPH-939 health signals: compute each part independently and best-effort.
    // EVERY read is wrapped so a throw degrades to null — this tick is fire-and-forget
    // and must never break the poll. A null in any of the three CORE parts (triage
    // intake / residual / hot-file) makes buildQueueHealth return undefined → health is
    // simply omitted from the context (prompt byte-unchanged), and the tick continues.
    const triageIntake = await collectTriageIntakeHealth({
      fetch: deps.fetchTriageIssues,
      nowMs,
      publish: deps.onTriageIntakeComputed,
    });
    let residualShare: number | null = null;
    try {
      // REGRESSION GUARD: residual is fed from the state-aware Backlog/Triage fetch,
      // NOT from `candidates`/`context.backlog` (the activeStates set excludes
      // Backlog/Triage and would read ~0). See computeResidualShare's doc.
      const residualIssues = (await deps.fetchResidualIssues?.()) ?? null;
      residualShare =
        residualIssues === null ? null : computeResidualShare(residualIssues);
    } catch {
      residualShare = null;
    }
    let hotFileGrowth: HotFileGrowth | null = null;
    try {
      hotFileGrowth = (await deps.getHotFileGrowth?.()) ?? null;
    } catch {
      hotFileGrowth = null;
    }
    let reviewRoundDepth: number | null = null;
    try {
      reviewRoundDepth = (await deps.getReviewRoundDepth?.()) ?? null;
    } catch {
      reviewRoundDepth = null;
    }
    const health = buildQueueHealth({
      triageIntake,
      residualShare,
      hotFileGrowth,
      reviewRoundDepth,
    });

    let context = assembleShadowPlannerContext({
      candidates,
      advisoryInputCandidates,
      structuralAdvisoriesEnabled: config.structuralAdvisories === true,
      inFlight: deps.getInFlight(),
      envelope: config.envelope,
      ...(deps.auditDispositions === undefined
        ? {}
        : { auditDispositions: deps.auditDispositions }),
      ...(health === undefined ? {} : { triageHealthInput: health }),
      ...(advisoryRejections.length === 0 ? {} : { advisoryRejections }),
      ...(advisoryGradeEvidence.length === 0 ? {} : { advisoryGradeEvidence }),
    });
    // SYMPH-1143: after state filtering, disposition exclusion, and in-flight
    // subtraction (all applied by assembleShadowPlannerContext), an empty
    // plannable set short-circuits deterministically — no prompt, no planner
    // lane, no runCrabrunner call. Emit a TYPED skipped_empty_backlog marker
    // (distinct from the hygiene/cadence skips and from a real recorded plan) and
    // return before any model runner is built. The structural-advisory lane is
    // exempt: when advisories are armed the cycle must still run its lifecycle
    // bookkeeping (e.g. withdrawing an advisory whose members went terminal) even
    // with an empty backlog, so we preserve that path unchanged. Production
    // (WORKFLOW-symphony.md) leaves structural advisories off, so the short-circuit
    // is the live path there.
    if (config.structuralAdvisories !== true && context.backlog.length === 0) {
      // Persist the empty observation through the normal revision contract before
      // returning. A prior non-empty revision may carry an honored approval; the
      // deterministic empty revision supersedes it so journal-derived admission is
      // revoked even though no model lane runs (SYMPH-1143 review fix).
      const emptyRecord = await recordPlanRevision(
        deps.workspaceRoot,
        {
          batches: [],
          dependencyEdges: [],
          options: [],
          envelope: config.envelope,
          rationale:
            "Eligible backlog is empty; no standing-plan batches proposed.",
          premises: [
            {
              decisionAnchor: "plan",
              kind: "verifiable",
              statement: "Eligible backlog is empty.",
            },
          ],
          structuralAdvisories: [],
          // Preserve the existing deterministic empty-plan body emitted by
          // runTriagePlanner; only its prompt/lane-free persistence point moves.
          source: "planner",
        },
        {
          createdAt: now.toISOString(),
          planId: STANDING_PLAN_ID,
        },
      );
      await log(
        "queue_triage_skipped_empty_backlog",
        "Standing-plan tick finalized an empty current revision after state filtering, disposition exclusion, and in-flight subtraction; skipping deterministically (no prompt, no planner lane, no runner).",
        {
          outcome: "skipped",
          reason: "empty_backlog",
          candidates_fetched: fetchedCandidates.length,
          candidates_after_state_filter: candidates.length,
          plannable_after_exclusions: context.backlog.length,
          planner_candidate_states: config.plannerCandidateStates,
          empty_revision_recorded: emptyRecord.recorded,
          revision: emptyRecord.plan.revision,
        },
      );
      return { status: "skipped", reason: "empty_backlog" };
    }
    // Curated-comment enrichment (SYMPH-896): default-off; when an operator opts
    // in AND a comment fetch is wired, inject curated comments into the planner
    // context and log a report-only cost measurement. Best-effort — never breaks
    // the tick.
    if (config.commentEnrichment.enabled) {
      if (deps.fetchIssueComments === undefined) {
        // Enabled but no comment fetch wired (e.g. a non-Linear tracker): the
        // feature is inert. Log it so an operator who flipped the flag is not
        // left guessing why no measurement appears (council Track).
        await log(
          "queue_triage_comment_enrichment_skipped",
          "Comment enrichment is enabled but no comment fetch is wired (non-Linear tracker?); the feature is inert.",
          { outcome: "shadow", reason: "no_comment_fetch_wired" },
        );
      } else if (context.backlog.length > 0) {
        const enriched = await enrichPlannerContextWithComments({
          context,
          config: config.commentEnrichment,
          fetchIssueComments: deps.fetchIssueComments,
          ...(deps.operatorConfig === undefined
            ? {}
            : { operatorConfig: deps.operatorConfig }),
        });
        context = enriched.context;
        await log(
          "queue_triage_comment_enrichment_measure",
          "Planner comment enrichment measured (report-only; topology tuned from this).",
          { outcome: "shadow", ...enriched.measurement },
        );
      }
    }
    if (deps.groundPlannerContext !== undefined && context.backlog.length > 0) {
      const startedAt = deps.now().getTime();
      try {
        const grounded = await deps.groundPlannerContext({
          context,
          candidates,
          now: deps.now,
        });
        context = grounded.context;
        await log(
          "queue_triage_planner_grounding_measure",
          "Planner code grounding measured (report-only; dispatch unaffected).",
          {
            outcome: "shadow",
            wall_clock_ms: Math.max(0, deps.now().getTime() - startedAt),
            ...summarizePlannerGrounding(context),
          },
        );
      } catch (error) {
        await log(
          "queue_triage_planner_grounding_failed",
          "Planner code grounding failed (report-only; continuing without grounding evidence).",
          { outcome: "degraded", detail: (error as Error).message },
        );
      }
    }
    if (config.triagePrep) {
      if (deps.prepareTriagePlannerContext === undefined) {
        await log(
          "queue_triage_prep_skipped",
          "Triage prep is enabled but its read-only context transform is not wired.",
          { outcome: "shadow", reason: "transform_not_wired" },
        );
      } else {
        try {
          const prepared = await deps.prepareTriagePlannerContext({
            context,
            candidates: [...candidates, ...advisoryInputCandidates],
            familyCandidates: [...candidates, ...advisoryInputCandidates],
            ...(deps.fetchIssueComments === undefined
              ? {}
              : { fetchIssueComments: deps.fetchIssueComments }),
            now: deps.now,
          });
          context = prepared.context;
          await log(
            "queue_triage_prep_emitted",
            "Fresh deterministic triage evidence emitted as a run artifact (read-only; no verdict or Linear write).",
            {
              outcome: "shadow",
              artifact_path: prepared.artifactPath,
              sheet_count: prepared.batch.sheets.length,
            },
          );
        } catch (error) {
          await log(
            "queue_triage_prep_failed",
            "Deterministic triage prep failed; continuing without its report-only evidence.",
            { outcome: "degraded", detail: (error as Error).message },
          );
        }
      }
    }
    const runClaude = deps.createPlannerRunner(
      config.plannerModel,
      config.plannerEffort,
    );
    const planReview = await buildShadowPlanReviewConfig({
      config,
      workspaceRoot: deps.workspaceRoot,
      loadLastReviewedContentHash:
        deps.loadLastReviewedContentHash ?? loadLastReviewedContentHash,
      log,
      ...(deps.planReviewArtifactDir === undefined
        ? {}
        : { artifactDir: deps.planReviewArtifactDir }),
      ...(deps.planReviewWorkspace === undefined
        ? {}
        : { workspace: deps.planReviewWorkspace }),
    });
    const result = await runShadowPlanCycle({
      workspaceRoot: deps.workspaceRoot,
      context,
      planner: { runClaude },
      plannerAttribution: {
        model: config.plannerModel,
        effort: config.plannerEffort,
      },
      log,
      now: () => now,
      ...(config.structuralAdvisories === true
        ? {
            advisoryLifecycle: {
              previous: plan?.structuralAdvisories,
              dormantOkTicks: config.structuralAdvisoryDormantOkTicks ?? 3,
              renderCap: config.structuralAdvisoryRenderCap ?? 3,
              scanComplete: advisoryInputScanComplete,
              terminalIssueIdentifiers,
              issueActivity,
              ...(advisoryRejections.length === 0
                ? {}
                : { rejectedMemberSets: advisoryRejections }),
              ...(deps.recordAdvisoryTransition === undefined
                ? {}
                : { recordTransition: deps.recordAdvisoryTransition }),
              ...(deps.resolveIssueByIdentifier === undefined
                ? {}
                : {
                    resolveRootIssueIdentifier: async (identifier: string) =>
                      (await deps.resolveIssueByIdentifier?.(identifier)) !==
                      null,
                  }),
            },
          }
        : {}),
      ...(planReview === undefined ? {} : { planReview }),
      ...(deps.runPlanPostEmitReview === undefined
        ? {}
        : { runPlanPostEmitReview: deps.runPlanPostEmitReview }),
    });
    return result;
  } catch (error) {
    await log(
      "queue_triage_shadow_failed",
      "Standing-plan shadow tick failed (best-effort; dispatch unaffected).",
      { outcome: "degraded", detail: (error as Error).message },
    );
    return { status: "skipped", reason: "error" };
  }
}

async function buildShadowPlanReviewConfig(input: {
  config: WorkflowQueueTriageConfig;
  workspaceRoot: string;
  loadLastReviewedContentHash: (
    workspaceRoot: string,
  ) => Promise<string | null>;
  log: StandingPlanShadowTickDeps["log"];
  artifactDir?: string;
  workspace?: string;
}): Promise<ShadowPlanCycleDeps["planReview"] | undefined> {
  if (!input.config.planReview.enabled) {
    return undefined;
  }
  let lastReviewedContentHash: string | null = null;
  try {
    lastReviewedContentHash = await input.loadLastReviewedContentHash(
      input.workspaceRoot,
    );
  } catch (error) {
    await input.log(
      "queue_triage_plan_review_baseline_failed",
      "Standing-plan tier-2 baseline read failed (report-only; treating as no baseline).",
      { outcome: "degraded", detail: (error as Error).message },
    );
  }
  return {
    enabled: true,
    plannerGroundingEnabled: input.config.planReview.plannerGroundingEnabled,
    lastReviewedContentHash,
    artifactDir:
      input.artifactDir ??
      join(input.workspaceRoot, ".symphony", "standing-plan", "tier-2"),
    workspace: input.workspace ?? process.cwd(),
    env: process.env,
  };
}

function planBodyFromRevision(revision: PlanRevision): PlanBody {
  const premises = revision.premises ?? [];
  return {
    batches: revision.batches,
    options: revision.options,
    envelope: revision.envelope,
    rationale: revision.rationale,
    source: revision.source,
    dependencyEdges: revision.dependencyEdges,
    structuralAdvisories: revision.structuralAdvisories ?? [],
    ...(premises.length === 0 ? {} : { premises }),
  };
}
