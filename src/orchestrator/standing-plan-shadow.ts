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
  PlannerCandidateGroundingEvidence,
  PlannerContext,
  PlannerInFlight,
  PlannerPrInfo,
  PlannerRunResult,
  QueueHealth,
  TriageIntakeHealth,
  TriagePlannerDeps,
} from "../agent/triage-planner.js";
import { runTriagePlanner } from "../agent/triage-planner.js";
import type {
  WorkflowOperatorAnchorsConfig,
  WorkflowQueueTriageCommentEnrichmentConfig,
  WorkflowQueueTriageConfig,
} from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { PlanEnvelope, StandingPlan } from "../domain/standing-plan.js";
import type { LinearIssueComment } from "../tracker/linear-client.js";
import type { BacklogHygieneProposal } from "./backlog-hygiene.js";
import { extractGroundingPathHints } from "./code-grounding.js";
import { runPlanPostEmitReview } from "./plan-post-emit-review.js";
import {
  buildQueueHealth,
  computeResidualShare,
  computeTriageIntake,
} from "./standing-plan-queue-health.js";
import { loadStandingPlan, recordPlanRevision } from "./standing-plan-store.js";
import type { RecordPlanRevisionResult } from "./standing-plan-store.js";
import type {
  PlanBody,
  RotateRevisionOptions,
} from "./standing-plan-supersession.js";

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

export {
  RESIDUAL_TRACK_MARKER,
  TRIAGE_INFLOW_WINDOW_MS,
  buildQueueHealth,
  computeResidualShare,
  computeTriageIntake,
} from "./standing-plan-queue-health.js";

export interface AssembleShadowPlannerContextInput {
  candidates: Issue[];
  inFlight: PlannerInFlight[];
  envelope: PlanEnvelope;
  openPrs?: PlannerPrInfo[];
  recentlyMerged?: PlannerPrInfo[];
  auditDispositions?: readonly ShadowPlannerAuditDisposition[];
  /**
   * Pre-computed per-queue health (SYMPH-939). Computed by the async caller
   * (runStandingPlanShadowTick) from injected deps and passed into this pure,
   * synchronous assembler — which only threads it onto `context.health`. Absent →
   * `health` omitted (back-compat).
   */
  triageHealthInput?: QueueHealth;
  groundingEvidenceByIssueId?:
    | ReadonlyMap<string, PlannerCandidateGroundingEvidence>
    | Readonly<Record<string, PlannerCandidateGroundingEvidence>>;
}

export type ShadowPlannerAuditDispositionType =
  | "kill"
  | "stale"
  | "duplicate"
  | "supersession";

export interface ShadowPlannerAuditDisposition {
  type: ShadowPlannerAuditDispositionType;
  issueIdentifiers: readonly string[];
}

export function buildShadowPlannerAuditDispositions(
  proposals: readonly BacklogHygieneProposal[],
): ShadowPlannerAuditDisposition[] {
  const dispositions: ShadowPlannerAuditDisposition[] = [];
  for (const proposal of proposals) {
    const issueIdentifiers = uniqueNonBlankIdentifiers(
      proposal.issueIdentifiers,
    );
    if (issueIdentifiers.length === 0) {
      continue;
    }
    if (proposal.cull?.classification === "kill") {
      dispositions.push({ type: "kill", issueIdentifiers });
      continue;
    }
    if (proposal.findingType === "stale") {
      dispositions.push({ type: "stale", issueIdentifiers });
      continue;
    }
    if (proposal.findingType === "supersession") {
      dispositions.push({ type: "supersession", issueIdentifiers });
      continue;
    }
    if (proposal.findingType === "duplicate") {
      dispositions.push({ type: "duplicate", issueIdentifiers });
    }
  }
  return dispositions;
}

export function buildShadowPlannerSupersessionRelationDispositions(
  issues: readonly Issue[],
): ShadowPlannerAuditDisposition[] {
  const dispositions: ShadowPlannerAuditDisposition[] = [];
  for (const issue of issues) {
    const supersededBy = issue.supersededBy ?? [];
    if (
      supersededBy.some((ref) => isCompletedSupersedingIssueState(ref.state))
    ) {
      dispositions.push({
        type: "supersession",
        issueIdentifiers: [issue.identifier],
      });
    }
  }
  return dispositions;
}

export function assembleShadowPlannerContext(
  input: AssembleShadowPlannerContextInput,
): PlannerContext {
  const inFlightIdentifiers = new Set(
    input.inFlight.map((entry) => entry.issueIdentifier),
  );
  const { excludedIdentifiers, duplicateClustersByIdentifier } =
    buildAuditDispositionIndex(input.auditDispositions ?? []);
  const backlog = input.candidates
    .filter((issue) => !inFlightIdentifiers.has(issue.identifier))
    .filter((issue) => !excludedIdentifiers.has(issue.identifier))
    .map((issue) => {
      const groundingEvidence = readGroundingEvidence(
        input.groundingEvidenceByIssueId,
        issue,
      );
      return {
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
        advisoryRelations: {
          relatesTo: issue.relatesTo?.flatMap(toRelationIdentifier) ?? [],
          duplicates: issue.duplicates?.flatMap(toRelationIdentifier) ?? [],
          duplicatedBy: issue.duplicatedBy?.flatMap(toRelationIdentifier) ?? [],
          supersedes: issue.supersedes?.flatMap(toRelationIdentifier) ?? [],
          supersededBy: issue.supersededBy?.flatMap(toRelationIdentifier) ?? [],
          relationsTruncated: issue.advisoryRelationsTruncated === true,
          parent: issue.parent?.identifier ?? null,
          children: issue.children?.flatMap(toRelationIdentifier) ?? [],
          childrenTruncated: issue.childrenTruncated === true,
        },
        // SYMPH-874: carry the body + labels so the Manager reasons over real
        // ticket content (surface / area / intent), not just one-line titles.
        description: issue.description,
        labels: issue.labels,
        ...(groundingEvidence === undefined ? {} : { groundingEvidence }),
        // SYMPH-874 Tier 2 / SYMPH-895: the strongest same-surface signal —
        // concrete file overlap. Deterministically extract the repo-relative
        // paths the ticket itself cites (title + body) via the code-grounding
        // path vocabulary. Absent/blank/no-path → [] → rendered as nothing.
        pathHints: extractGroundingPathHints(
          [issue.title, issue.description]
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim() !== "",
            )
            .join("\n"),
        ),
        ...(duplicateClustersByIdentifier.has(issue.identifier)
          ? {
              duplicateClusterIdentifiers:
                duplicateClustersByIdentifier.get(issue.identifier) ?? [],
            }
          : {}),
      };
    });
  return {
    backlog,
    inFlight: input.inFlight,
    openPrs: input.openPrs ?? [],
    recentlyMerged: input.recentlyMerged ?? [],
    envelope: input.envelope,
    ...(input.triageHealthInput === undefined
      ? {}
      : { health: input.triageHealthInput }),
  };
}

function toRelationIdentifier(ref: { identifier: string | null }): string[] {
  return ref.identifier === null ? [] : [ref.identifier];
}

function readGroundingEvidence(
  evidence:
    | ReadonlyMap<string, PlannerCandidateGroundingEvidence>
    | Readonly<Record<string, PlannerCandidateGroundingEvidence>>
    | undefined,
  issue: Issue,
): PlannerCandidateGroundingEvidence | undefined {
  if (evidence === undefined) {
    return undefined;
  }
  if (isGroundingEvidenceMap(evidence)) {
    return evidence.get(issue.id) ?? evidence.get(issue.identifier);
  }
  return evidence[issue.id] ?? evidence[issue.identifier];
}

function isGroundingEvidenceMap(
  evidence:
    | ReadonlyMap<string, PlannerCandidateGroundingEvidence>
    | Readonly<Record<string, PlannerCandidateGroundingEvidence>>,
): evidence is ReadonlyMap<string, PlannerCandidateGroundingEvidence> {
  return typeof (evidence as { get?: unknown }).get === "function";
}

function buildAuditDispositionIndex(
  dispositions: readonly ShadowPlannerAuditDisposition[],
): {
  excludedIdentifiers: Set<string>;
  duplicateClustersByIdentifier: Map<string, string[]>;
} {
  const excludedIdentifiers = new Set<string>();
  const duplicateClustersByIdentifier = new Map<string, string[]>();
  for (const disposition of dispositions) {
    const identifiers = uniqueNonBlankIdentifiers(disposition.issueIdentifiers);
    if (identifiers.length === 0) {
      continue;
    }
    if (
      disposition.type === "kill" ||
      disposition.type === "stale" ||
      disposition.type === "supersession"
    ) {
      for (const identifier of identifiers) {
        excludedIdentifiers.add(identifier);
      }
      continue;
    }
    for (const identifier of identifiers) {
      const existing = duplicateClustersByIdentifier.get(identifier) ?? [];
      duplicateClustersByIdentifier.set(
        identifier,
        uniqueNonBlankIdentifiers([...existing, ...identifiers]),
      );
    }
  }
  return { excludedIdentifiers, duplicateClustersByIdentifier };
}

function isCompletedSupersedingIssueState(state: string | null): boolean {
  if (state === null) {
    return false;
  }
  const normalized = state.trim().toLowerCase();
  return (
    normalized === "done" ||
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "closed" ||
    normalized === "merged" ||
    normalized === "released" ||
    normalized === "shipped"
  );
}

function uniqueNonBlankIdentifiers(identifiers: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const identifier of identifiers) {
    const normalized = identifier.trim();
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

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
  log: (
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ) => void | Promise<void>;
  now: () => Date;
  planId?: string;
  persistPlanRevision?: (
    workspaceRoot: string,
    body: PlanBody,
    options: RotateRevisionOptions,
  ) => Promise<RecordPlanRevisionResult>;
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
        detail: planned.detail,
        attempts: planned.attempts,
      },
    );
    return { status: "invalid", detail: planned.detail };
  }

  const review = await runPlanPostEmitReview({
    context: deps.context,
    body: planned.body,
    runClaude: deps.planner.runClaude,
  });

  const persistPlanRevision = deps.persistPlanRevision ?? recordPlanRevision;
  const record = await persistPlanRevision(deps.workspaceRoot, planned.body, {
    createdAt: deps.now().toISOString(),
    planId: deps.planId ?? STANDING_PLAN_ID,
    findings: review.findings,
  });

  await deps.log(
    "queue_triage_shadow_plan",
    "Standing-plan shadow cycle computed a plan (shadow mode — dispatch unchanged).",
    {
      outcome: "shadow",
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
  /** Fetch the Backlog+Triage population for residual-share (the [track:] marker fraction). */
  fetchResidualIssues?: () => Promise<Issue[]>;
  /** Read the persisted review-round depth (rounds_per_cycle); null when no recent reviews. */
  getReviewRoundDepth?: () => Promise<number | null>;
  /** Read hot-file growth (bound thunk over the git-churn reader); null on any read failure. */
  getHotFileGrowth?: () => Promise<HotFileGrowth | null>;
  auditDispositions?: readonly ShadowPlannerAuditDisposition[];
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

    // SYMPH-939 health signals: compute each part independently and best-effort.
    // EVERY read is wrapped so a throw degrades to null — this tick is fire-and-forget
    // and must never break the poll. A null in any of the three CORE parts (triage
    // intake / residual / hot-file) makes buildQueueHealth return undefined → health is
    // simply omitted from the context (prompt byte-unchanged), and the tick continues.
    let triageIntake: TriageIntakeHealth | null = null;
    try {
      const triageIssues = (await deps.fetchTriageIssues?.()) ?? null;
      triageIntake =
        triageIssues === null ? null : computeTriageIntake(triageIssues, nowMs);
    } catch {
      triageIntake = null;
    }
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
      inFlight: deps.getInFlight(),
      envelope: config.envelope,
      ...(deps.auditDispositions === undefined
        ? {}
        : { auditDispositions: deps.auditDispositions }),
      ...(health === undefined ? {} : { triageHealthInput: health }),
    });
    // Curated-comment enrichment (SYMPH-896): default-off; when an operator opts
    // in AND a comment fetch is wired, inject curated comments into the planner
    // context and log a report-only cost measurement. Best-effort — never breaks
    // the tick.
    if (config.commentEnrichment.enabled) {
      if (deps.fetchIssueComments === undefined) {
        // Enabled but no comment fetch wired (e.g. a non-Linear tracker): the
        // feature is inert. Log it so an operator who flipped the flag is not
        // left guessing why no measurement appears (council Track).
        await deps.log(
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
        await deps.log(
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
        await deps.log(
          "queue_triage_planner_grounding_measure",
          "Planner code grounding measured (report-only; dispatch unaffected).",
          {
            outcome: "shadow",
            wall_clock_ms: Math.max(0, deps.now().getTime() - startedAt),
            ...summarizePlannerGrounding(context),
          },
        );
      } catch (error) {
        await deps.log(
          "queue_triage_planner_grounding_failed",
          "Planner code grounding failed (report-only; continuing without grounding evidence).",
          { outcome: "degraded", detail: (error as Error).message },
        );
      }
    }
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
