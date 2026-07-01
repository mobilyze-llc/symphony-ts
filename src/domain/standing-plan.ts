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

import { isValidPlanBatch } from "./plan-batch.js";
export {
  PLAN_BATCH_MODES,
  PLAN_BATCH_STATUSES,
} from "./plan-batch-contract.js";
export type {
  PlanBatch,
  PlanBatchMember,
  PlanBatchMode,
  PlanBatchStatus,
  PlanCanaryStructure,
} from "./plan-batch-contract.js";
import {
  PLAN_BATCH_MODES,
  PLAN_BATCH_STATUSES,
  type PlanBatch,
  type PlanBatchMode,
  type PlanBatchStatus,
} from "./plan-batch-contract.js";

/**
 * A resolved, directed execution-dependency edge (SYMPH-843): `issueIdentifier`
 * must run AFTER `dependsOn` (i.e. `dependsOn` is a prerequisite). The plan's
 * `dependencyEdges` is the union of the model's emitted cross-batch dependencies
 * (intelligence-driven soft edges), recorded `blockedBy` relations (SYMPH-841,
 * hard edges), and canary head→contingent edges — restricted to planned members
 * and kept acyclic (cycle-closing edges are dropped).
 */
export interface PlanDependencyEdge {
  issueIdentifier: string;
  dependsOn: string;
}

/**
 * Layer planned issues into ordered execution waves by their dependency edges
 * (SYMPH-843): wave 0 holds issues with no in-set prerequisites, and each later
 * wave holds issues whose prerequisites all sit in earlier waves. Issues in the
 * same wave can run in parallel. Edges whose endpoints are not members are
 * ignored; the edge set is assumed acyclic (buildPlanBody drops cycles), with a
 * defensive guard so a stray cycle terminates instead of looping.
 */
export function computeDependencyWaves(
  memberIdentifiers: readonly string[],
  edges: readonly PlanDependencyEdge[],
): string[][] {
  const members = new Set(memberIdentifiers);
  const prerequisites = new Map<string, string[]>();
  for (const identifier of memberIdentifiers) {
    prerequisites.set(identifier, []);
  }
  for (const edge of edges) {
    if (members.has(edge.issueIdentifier) && members.has(edge.dependsOn)) {
      prerequisites.get(edge.issueIdentifier)?.push(edge.dependsOn);
    }
  }
  const waveOf = new Map<string, number>();
  const inProgress = new Set<string>();
  const wave = (identifier: string): number => {
    const cached = waveOf.get(identifier);
    if (cached !== undefined) {
      return cached;
    }
    if (inProgress.has(identifier)) {
      return 0; // defensive: a cycle slipped through — treat as a root
    }
    inProgress.add(identifier);
    const deps = prerequisites.get(identifier) ?? [];
    const depth =
      deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => wave(dep)));
    inProgress.delete(identifier);
    waveOf.set(identifier, depth);
    return depth;
  };
  const byWave = new Map<number, string[]>();
  for (const identifier of memberIdentifiers) {
    const depth = wave(identifier);
    const bucket = byWave.get(depth);
    if (bucket === undefined) {
      byWave.set(depth, [identifier]);
    } else {
      bucket.push(identifier);
    }
  }
  return [...byWave.keys()]
    .sort((left, right) => left - right)
    .map((depth) => byWave.get(depth) ?? []);
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
  /** sha256 over the normalized batches+DAG+options+envelope. */
  contentHash: string;
  /** The prior revision this one replaces (null for the first). */
  supersedes: number | null;
  createdAt: string;
  envelope: PlanEnvelope;
  /** Ordered: committed (immutable) batches first, then the lookahead tail. */
  batches: PlanBatch[];
  /** Persisted execution-dependency DAG over planned issue identifiers. */
  dependencyEdges: PlanDependencyEdge[];
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
  dependencyEdges: PlanDependencyEdge[];
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
 * Stable content hash of the meaningful structural plan body (batches +
 * dependency edges + options + envelope + source). Excludes rationale,
 * revision, createdAt, and contentHash so an
 * unchanged plan re-proposed later hashes identically (idempotency: no churn).
 */
export function computePlanContentHash(
  body: Pick<
    PlanRevision,
    | "planId"
    | "batches"
    | "dependencyEdges"
    | "options"
    | "envelope"
    | "rationale"
    | "source"
  >,
): string {
  const normalized = {
    planId: body.planId,
    source: body.source,
    envelope: normalizeEnvelopeForHash(body.envelope),
    batches: body.batches.map(normalizeBatchForHash),
    dependencyEdges: normalizeDependencyEdgesForHash(body.dependencyEdges),
    options: body.options.map(normalizeOptionForHash),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function normalizeDependencyEdgesForHash(
  edges: readonly PlanDependencyEdge[],
): unknown {
  return edges
    .map((edge) => ({
      issueIdentifier: edge.issueIdentifier,
      dependsOn: edge.dependsOn,
    }))
    .sort((left, right) => {
      const issueOrder = left.issueIdentifier.localeCompare(
        right.issueIdentifier,
      );
      return issueOrder === 0
        ? left.dependsOn.localeCompare(right.dependsOn)
        : issueOrder;
    });
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
 * Spine default allowed mode: parallel-isolated only — the one mode whose
 * execution path is complete. canary-chain (its contingent-release flow) and
 * shared-surface (shared-branch execution, Track 2) are intentionally EXCLUDED
 * by default until their execution paths ship, so the planner never proposes a
 * mode the consumer cannot fully execute. canary-chain is enabled now that its
 * contingent-release execution path shipped (SYMPH-800); shared-surface stays
 * gated until its path ships. An operator can still narrow this per workflow.
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
    value.batches.every(isValidPlanBatch) &&
    // Legacy plan_revision rows before SYMPH-843 did not persist the DAG. They
    // remain readable and project as an empty edge set in the store.
    (value.dependencyEdges === undefined ||
      isPlanDependencyEdges(value.dependencyEdges)) &&
    Array.isArray(value.options) &&
    value.options.every(isPlanOptionLine) &&
    typeof value.rationale === "string" &&
    PLAN_REVISION_SOURCES.includes(value.source as PlanRevisionSource)
  );
}

function isPlanDependencyEdges(value: unknown): value is PlanDependencyEdge[] {
  return Array.isArray(value) && value.every(isPlanDependencyEdge);
}

function isPlanDependencyEdge(value: unknown): value is PlanDependencyEdge {
  return (
    isRecord(value) &&
    typeof value.issueIdentifier === "string" &&
    value.issueIdentifier.trim().length > 0 &&
    typeof value.dependsOn === "string" &&
    value.dependsOn.trim().length > 0 &&
    value.issueIdentifier !== value.dependsOn
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

export function isPlanBatch(value: unknown): value is PlanBatch {
  return isValidPlanBatch(value);
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
