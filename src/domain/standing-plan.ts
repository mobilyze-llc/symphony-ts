// ---------------------------------------------------------------------------
// Queue Triage v2 — Standing plan domain model (SYMPH-784 / SYMPH-785)
// ---------------------------------------------------------------------------
//
// The Manager's source of truth is a durable, journaled standing plan:
// `[in-flight committed batches] + [lookahead of undispatched batches]`.
// The living control doc (SYMPH-790) is a *view* of this — never the reverse.
//
// These are pure declarations + small pure helpers (no I/O). The journal
// (src/logging/standing-plan-journal.ts) and the store
// (src/orchestrator/standing-plan-store.ts) build on them.
//
// NOTE on naming: this is deliberately "standing-plan" / "triage", NEVER
// "manager*", to avoid collision with the unrelated existing ManagerRun journal
// (src/logging/manager-run-journal.ts), which models a different concept.

import { createHash } from "node:crypto";

/**
 * Batch modes (design "Core objects"). A batch is the new first-class unit the
 * Manager commits; its mode tells the runner how to execute it.
 */
export const PLAN_BATCH_MODES = [
  // N independent tickets → N worktrees / N PRs (today's max_concurrent_agents).
  "parallel-isolated",
  // M same-surface tickets → one branch / one PR (token + wall-clock win).
  "shared-surface",
  // Ordered + contingent: run the head; if it validates, release the tail.
  "canary-chain",
] as const;

export type PlanBatchMode = (typeof PLAN_BATCH_MODES)[number];

/**
 * Batch lifecycle within the standing plan. Only `lookahead` batches are the
 * speculative, freely-superseded tail; everything past `released` is committed
 * and immutable to a re-plan (SYMPH-788).
 */
export const PLAN_BATCH_STATUSES = [
  "lookahead", // undispatched, speculative — a re-plan may rewrite/drop it
  "released", // operator-approved for dispatch (posture-B frontier, SYMPH-789)
  "in_flight", // dispatched / committed — immutable to a re-plan
  "completed", // terminal
  "superseded", // dropped by a re-plan (journaled)
] as const;

export type PlanBatchStatus = (typeof PLAN_BATCH_STATUSES)[number];

/** A batch member is a reference to a tracker issue. */
export interface PlanBatchMember {
  issueId: string;
  issueIdentifier: string;
}

/**
 * Canary-chain structure: the head member(s) gate the contingent tail. The
 * consumer (SYMPH-787) only releases the contingent members once the head
 * validates.
 */
export interface PlanCanaryStructure {
  headIssueIdentifiers: string[];
  contingentIssueIdentifiers: string[];
}

export interface PlanBatch {
  /** Stable id within a plan (carried across revisions for committed batches). */
  batchId: string;
  mode: PlanBatchMode;
  status: PlanBatchStatus;
  members: PlanBatchMember[];
  rationale: string;
  canary: PlanCanaryStructure | null;
}

/** Risk tiers the envelope can permit (mirrors reasoning-effort granularity). */
export const PLAN_RISK_TIERS = ["low", "medium", "high"] as const;

export type PlanRiskTier = (typeof PLAN_RISK_TIERS)[number];

/**
 * The operating envelope (SYMPH-793). The Manager reads it and plans strictly
 * within it. v2 sources it statically from config; the Ramp Governor (Track 4)
 * writes it later. `version` is monotonic — a change is a re-plan trigger
 * (consumer guard #4, SYMPH-787).
 */
export interface PlanEnvelope {
  version: number;
  concurrencyCeiling: number;
  allowedRisk: PlanRiskTier;
  allowedModes: PlanBatchMode[];
}

/**
 * An option line rendered in the control doc (SYMPH-790). Each carries a unique
 * `[opt-N]` marker so a doc comment can be resolved to it (SYMPH-791). The
 * intent it maps to is the typed PR2 intent (release_batch / hold / modify_plan).
 */
export interface PlanOptionLine {
  marker: string;
  label: string;
  intent: PlanOptionIntent | null;
}

export interface PlanOptionIntent {
  verb: string;
  batchId: string | null;
}

export const PLAN_REVISION_SOURCES = [
  "planner", // produced by the Opus@max planner (SYMPH-786)
  "supersession", // produced by a supersession rotation (SYMPH-788)
  "manual", // produced by an operator modify_plan intent
] as const;

export type PlanRevisionSource = (typeof PLAN_REVISION_SOURCES)[number];

/**
 * A single revision of the standing plan — the journaled unit. The latest
 * `plan_revision` entry projects to the current StandingPlan read-model.
 */
export interface PlanRevision {
  /** Monotonic within a planId. */
  revision: number;
  /** Stable identity of the living plan across revisions. */
  planId: string;
  /** sha256 over the normalized batches+options+envelope (idempotency/dedup). */
  contentHash: string;
  /** The prior revision this one replaces (null for the first). */
  supersedes: number | null;
  createdAt: string;
  envelope: PlanEnvelope;
  /** Ordered: committed (immutable) batches first, then the lookahead tail. */
  batches: PlanBatch[];
  options: PlanOptionLine[];
  rationale: string;
  source: PlanRevisionSource;
}

export const PLAN_DECISION_KINDS = [
  "approve",
  "modify",
  "reject",
  "hold",
] as const;

export type PlanDecisionKind = (typeof PLAN_DECISION_KINDS)[number];

/**
 * An operator decision against a specific revision (the calibration substrate,
 * SYMPH-792, and the posture-B release signal, SYMPH-789). Bound to a revision:
 * a decision against a superseded revision is void (SYMPH-788).
 */
export interface PlanDecision {
  decisionId: string;
  planId: string;
  /** The revision the decision was made against (binding). */
  revision: number;
  /** The batch targeted, if any. */
  batchId: string | null;
  kind: PlanDecisionKind;
  /** The operator actor (allowlist-gated upstream, SYMPH-791). */
  actor: string;
  /** The `[opt-N]` marker the decision resolved from, if any. */
  optionMarker: string | null;
  createdAt: string;
  note: string | null;
}

/**
 * A batch outcome (merged / parked / failed). Reserved here so the calibration
 * join (SYMPH-792, PR3) does not require a journal-schema migration.
 */
export interface PlanOutcome {
  outcomeId: string;
  planId: string;
  revision: number;
  batchId: string;
  result: string;
  issueIdentifiers: string[];
  createdAt: string;
}

/**
 * The projected current standing plan — the read-model. Store is truth, this is
 * the view derived from the journal.
 */
export interface StandingPlan {
  planId: string;
  revision: number;
  contentHash: string;
  envelope: PlanEnvelope;
  batches: PlanBatch[];
  options: PlanOptionLine[];
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Journal (append-only, the durable source of truth)
// ---------------------------------------------------------------------------

export const STANDING_PLAN_JOURNAL_EVENT_KINDS = [
  "plan_revision",
  "plan_decision",
  "plan_outcome",
] as const;

export type StandingPlanJournalEventKind =
  (typeof STANDING_PLAN_JOURNAL_EVENT_KINDS)[number];

interface StandingPlanJournalEntryBase {
  sequence: number;
  idempotencyKey: string;
  timestamp: string;
  kind: StandingPlanJournalEventKind;
  planId: string;
}

export interface PlanRevisionJournalEntry extends StandingPlanJournalEntryBase {
  kind: "plan_revision";
  revision: PlanRevision;
}

export interface PlanDecisionJournalEntry extends StandingPlanJournalEntryBase {
  kind: "plan_decision";
  decision: PlanDecision;
}

export interface PlanOutcomeJournalEntry extends StandingPlanJournalEntryBase {
  kind: "plan_outcome";
  outcome: PlanOutcome;
}

export type StandingPlanJournalEntry =
  | PlanRevisionJournalEntry
  | PlanDecisionJournalEntry
  | PlanOutcomeJournalEntry;

export type StandingPlanJournal = StandingPlanJournalEntry[];

// Distributive omit: a plain Omit<Union, K> collapses the union to its common
// keys, dropping the discriminated `revision`/`decision`/`outcome` payloads.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type StandingPlanJournalEntryDraft = DistributiveOmit<
  StandingPlanJournalEntry,
  "sequence"
>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Stable content hash of the meaningful plan body (batches + options +
 * envelope + rationale + source). Excludes revision/createdAt/contentHash so an
 * unchanged plan re-proposed later hashes identically (idempotency: no churn).
 */
export function computePlanContentHash(
  body: Pick<
    PlanRevision,
    "planId" | "batches" | "options" | "envelope" | "rationale" | "source"
  >,
): string {
  const normalized = {
    planId: body.planId,
    source: body.source,
    rationale: body.rationale,
    envelope: normalizeEnvelopeForHash(body.envelope),
    batches: body.batches.map(normalizeBatchForHash),
    options: body.options.map(normalizeOptionForHash),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeEnvelopeForHash(envelope: PlanEnvelope): unknown {
  return {
    version: envelope.version,
    concurrencyCeiling: envelope.concurrencyCeiling,
    allowedRisk: envelope.allowedRisk,
    allowedModes: [...envelope.allowedModes].sort(),
  };
}

function normalizeBatchForHash(batch: PlanBatch): unknown {
  return {
    batchId: batch.batchId,
    mode: batch.mode,
    status: batch.status,
    rationale: batch.rationale,
    members: batch.members.map((member) => ({
      issueId: member.issueId,
      issueIdentifier: member.issueIdentifier,
    })),
    canary: batch.canary
      ? {
          headIssueIdentifiers: [...batch.canary.headIssueIdentifiers].sort(),
          contingentIssueIdentifiers: [
            ...batch.canary.contingentIssueIdentifiers,
          ].sort(),
        }
      : null,
  };
}

function normalizeOptionForHash(option: PlanOptionLine): unknown {
  return {
    marker: option.marker,
    label: option.label,
    intent: option.intent
      ? { verb: option.intent.verb, batchId: option.intent.batchId }
      : null,
  };
}

/** A committed batch is immutable to a re-plan; only `lookahead` is mutable. */
export function isCommittedBatchStatus(status: PlanBatchStatus): boolean {
  return status !== "lookahead" && status !== "superseded";
}

// ---------------------------------------------------------------------------
// Envelope resolution (SYMPH-793). Pure domain logic so the config layer can
// resolve an envelope from frontmatter without importing the orchestrator.
// ---------------------------------------------------------------------------

/**
 * Spine default allowed modes: parallel-isolated (today's runner) plus
 * canary-chain (ordered isolated dispatch with a release gate, SYMPH-789).
 * shared-surface is intentionally EXCLUDED until Track 2 ships shared-branch
 * execution — the planner must not propose a mode the runner cannot execute.
 */
export const DEFAULT_ENVELOPE_ALLOWED_MODES: PlanBatchMode[] = [
  "parallel-isolated",
  "canary-chain",
];

export const DEFAULT_ENVELOPE_ALLOWED_RISK: PlanRiskTier = "medium";

export interface StandingPlanEnvelopeInput {
  version?: number;
  concurrencyCeiling: number;
  allowedRisk?: PlanRiskTier;
  allowedModes?: PlanBatchMode[];
}

/**
 * Resolve a normalized PlanEnvelope from a static config input, applying spine
 * defaults and validating the contract. Throws on an invalid envelope so a
 * misconfiguration fails loudly rather than silently widening the Manager's
 * authority.
 */
export function resolveStandingPlanEnvelope(
  input: StandingPlanEnvelopeInput,
): PlanEnvelope {
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `standing-plan envelope: version must be a positive integer (got ${version})`,
    );
  }

  const concurrencyCeiling = input.concurrencyCeiling;
  if (!Number.isInteger(concurrencyCeiling) || concurrencyCeiling < 1) {
    throw new Error(
      `standing-plan envelope: concurrencyCeiling must be a positive integer (got ${concurrencyCeiling})`,
    );
  }

  const allowedRisk = input.allowedRisk ?? DEFAULT_ENVELOPE_ALLOWED_RISK;
  if (!PLAN_RISK_TIERS.includes(allowedRisk)) {
    throw new Error(
      `standing-plan envelope: unknown risk tier "${allowedRisk}"`,
    );
  }

  const allowedModes = input.allowedModes ?? [
    ...DEFAULT_ENVELOPE_ALLOWED_MODES,
  ];
  if (allowedModes.length === 0) {
    throw new Error(
      "standing-plan envelope: allowedModes must list at least one mode",
    );
  }
  for (const mode of allowedModes) {
    if (!PLAN_BATCH_MODES.includes(mode)) {
      throw new Error(`standing-plan envelope: unknown batch mode "${mode}"`);
    }
  }

  return { version, concurrencyCeiling, allowedRisk, allowedModes };
}

export function isStandingPlanJournalEntry(
  value: unknown,
): value is StandingPlanJournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.sequence !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.planId !== "string" ||
    typeof value.kind !== "string" ||
    !STANDING_PLAN_JOURNAL_EVENT_KINDS.includes(
      value.kind as StandingPlanJournalEventKind,
    )
  ) {
    return false;
  }
  switch (value.kind) {
    case "plan_revision":
      return isPlanRevision(value.revision);
    case "plan_decision":
      return isPlanDecision(value.decision);
    case "plan_outcome":
      return isPlanOutcome(value.outcome);
    default:
      return false;
  }
}

function isPlanRevision(value: unknown): value is PlanRevision {
  return (
    isRecord(value) &&
    typeof value.revision === "number" &&
    typeof value.planId === "string" &&
    typeof value.contentHash === "string" &&
    (value.supersedes === null || typeof value.supersedes === "number") &&
    typeof value.createdAt === "string" &&
    isPlanEnvelope(value.envelope) &&
    Array.isArray(value.batches) &&
    value.batches.every(isPlanBatch) &&
    Array.isArray(value.options) &&
    value.options.every(isPlanOptionLine) &&
    typeof value.rationale === "string" &&
    PLAN_REVISION_SOURCES.includes(value.source as PlanRevisionSource)
  );
}

// Deep validation so a malformed-but-shape-loose journal row cannot poison the
// projection or supersession carry-forward (council R1, Codex P2). The store is
// the source of truth, so a row that fails here is dropped on read.
function isPlanEnvelope(value: unknown): value is PlanEnvelope {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.concurrencyCeiling === "number" &&
    PLAN_RISK_TIERS.includes(value.allowedRisk as PlanRiskTier) &&
    Array.isArray(value.allowedModes) &&
    value.allowedModes.every((mode) =>
      PLAN_BATCH_MODES.includes(mode as PlanBatchMode),
    )
  );
}

function isPlanBatch(value: unknown): value is PlanBatch {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    !PLAN_BATCH_MODES.includes(value.mode as PlanBatchMode) ||
    !PLAN_BATCH_STATUSES.includes(value.status as PlanBatchStatus) ||
    typeof value.rationale !== "string" ||
    !Array.isArray(value.members) ||
    !value.members.every(isPlanBatchMember)
  ) {
    return false;
  }
  if (value.canary === null) {
    return true;
  }
  if (!isPlanCanaryStructure(value.canary)) {
    return false;
  }
  // Canary invariant on READ, mirroring the planner's normalizeCanary: a
  // non-empty head whose head+contingent refs are all batch members. A
  // corrupt/hand-edited row that violates it is dropped, so a deadlocking
  // canary can never become store truth (council R2, Codex+Pi P2).
  const memberIdentifiers = new Set(
    (value.members as PlanBatchMember[]).map(
      (member) => member.issueIdentifier,
    ),
  );
  return (
    value.canary.headIssueIdentifiers.length > 0 &&
    value.canary.headIssueIdentifiers.every((id) =>
      memberIdentifiers.has(id),
    ) &&
    value.canary.contingentIssueIdentifiers.every((id) =>
      memberIdentifiers.has(id),
    )
  );
}

function isPlanBatchMember(value: unknown): value is PlanBatchMember {
  return (
    isRecord(value) &&
    typeof value.issueId === "string" &&
    typeof value.issueIdentifier === "string"
  );
}

function isPlanCanaryStructure(value: unknown): value is PlanCanaryStructure {
  return (
    isRecord(value) &&
    Array.isArray(value.headIssueIdentifiers) &&
    value.headIssueIdentifiers.every((id) => typeof id === "string") &&
    Array.isArray(value.contingentIssueIdentifiers) &&
    value.contingentIssueIdentifiers.every((id) => typeof id === "string")
  );
}

function isPlanOptionLine(value: unknown): value is PlanOptionLine {
  return (
    isRecord(value) &&
    typeof value.marker === "string" &&
    typeof value.label === "string" &&
    (value.intent === null || isPlanOptionIntent(value.intent))
  );
}

function isPlanOptionIntent(value: unknown): value is PlanOptionIntent {
  return (
    isRecord(value) &&
    typeof value.verb === "string" &&
    (value.batchId === null || typeof value.batchId === "string")
  );
}

function isPlanDecision(value: unknown): value is PlanDecision {
  return (
    isRecord(value) &&
    typeof value.decisionId === "string" &&
    typeof value.planId === "string" &&
    typeof value.revision === "number" &&
    (value.batchId === null || typeof value.batchId === "string") &&
    PLAN_DECISION_KINDS.includes(value.kind as PlanDecisionKind) &&
    typeof value.actor === "string" &&
    (value.optionMarker === null || typeof value.optionMarker === "string") &&
    typeof value.createdAt === "string" &&
    (value.note === null || typeof value.note === "string")
  );
}

function isPlanOutcome(value: unknown): value is PlanOutcome {
  return (
    isRecord(value) &&
    typeof value.outcomeId === "string" &&
    typeof value.planId === "string" &&
    typeof value.revision === "number" &&
    typeof value.batchId === "string" &&
    typeof value.result === "string" &&
    Array.isArray(value.issueIdentifiers)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
