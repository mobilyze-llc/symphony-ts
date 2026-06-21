import {
  DELEGATED_STAGE_ATTEMPT_STATUSES,
  type DelegatedStageAttemptStatus,
  type DispatcherRunJournal,
  type DispatcherRunJournalEntry,
  type DispatcherRunJournalEventKind,
} from "../domain/model.js";
import {
  type StageUsageMeasurement,
  isStageUsageMeasurement,
} from "../domain/stage-usage.js";
import type { DispatcherRunJournalEntryDraft } from "../logging/run-journal.js";

/**
 * SYMPH-811 — project crabrunner delegated stage execution into Symphony's
 * durable run journal, and reconstruct it by replay.
 *
 * Delegated execution is only safe if Symphony can reconstruct it from durable
 * journal/artifact refs and external results cannot corrupt state after retries,
 * cancellation, or manual intervention. This module is the read/write contract:
 *
 *   - Writes are idempotent (the journal dedupes by `idempotencyKey`, which is
 *     distinct per attempt+status), and go through the run journal's single
 *     writer — Symphony stays the only writer of journal and stage state.
 *   - Replay reconstructs pending / running / terminal / degraded / ignored-late
 *     state from the journal alone.
 *   - A late result from a superseded attempt is recorded but never advances the
 *     active (newest) attempt.
 *   - A duplicate result never double-advances (the reducer computes the latest
 *     state, not a counter).
 *   - An unknown/renamed status or missing required metadata maps to an explicit
 *     `degraded` classification — it never silently presents as success.
 *   - Usage that was unavailable is preserved as unavailable/unknown (tokens
 *     stay null), never coerced to zero.
 *
 * The projection is a pure reducer (like `reduceMergeCandidates`); it does not
 * advance stage state. Stage transitions, rework, and merge-readiness remain
 * orchestrator-owned and journal-derived.
 */

export const DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND: DispatcherRunJournalEventKind =
  "delegated_stage_attempt";

export const DELEGATED_STAGE_ATTEMPT_METADATA_SCHEMA =
  "symphony.delegated-stage-attempt.v1";

export interface ProjectedDelegatedStageAttempt {
  runGroupId: string;
  stageName: string;
  stageAttempt: number;
  status: DelegatedStageAttemptStatus;
  failureClass: string | null;
  /** Usage measurement — unavailable stays unavailable (never zeroed). */
  usage: StageUsageMeasurement | null;
  artifactPaths: readonly string[];
  attemptIdempotencyKey: string | null;
  /** Journal sequence of the entry that produced this state. */
  sequence: number;
}

export interface DelegatedStageProjectionDegradedEntry {
  sequence: number;
  idempotencyKey: string | null;
  /** e.g. "missing_metadata:runGroupId" or "unknown_status:<value>". */
  reason: string;
}

export interface DelegatedStageProjection {
  /** Newest attempt per (runGroupId, stageName). */
  active: ProjectedDelegatedStageAttempt[];
  /** Results from superseded attempts — recorded, never advancing the active. */
  ignoredLate: ProjectedDelegatedStageAttempt[];
  /** Entries that could not be parsed — explicit degraded, never silent success. */
  degraded: DelegatedStageProjectionDegradedEntry[];
}

export interface BuildDelegatedStageAttemptEntryInput {
  issueId: string;
  issueIdentifier: string;
  ownerId?: string | null;
  runGroupId: string;
  stageName: string;
  stageAttempt: number;
  status: DelegatedStageAttemptStatus;
  /** The per-attempt idempotency key (e.g. the StageExecutionJobSpec key). */
  attemptIdempotencyKey: string;
  failureClass?: string | null;
  usage?: StageUsageMeasurement | null;
  artifactPaths?: readonly string[];
  timestamp: string;
  summary?: string;
}

/**
 * Build an idempotent `delegated_stage_attempt` journal draft. The journal
 * idempotency key is distinct per attempt+status so transitions are all
 * recorded, but a repeated identical transition dedupes on append.
 */
export function buildDelegatedStageAttemptJournalEntry(
  input: BuildDelegatedStageAttemptEntryInput,
): DispatcherRunJournalEntryDraft {
  return {
    idempotencyKey: `delegated_stage_attempt:${input.attemptIdempotencyKey}:${input.status}`,
    timestamp: input.timestamp,
    kind: DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND,
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    operation: "dispatcher",
    stage: input.stageName,
    attempt: input.stageAttempt,
    ownerId: input.ownerId ?? null,
    lease: null,
    summary:
      input.summary ??
      `delegated ${input.stageName} attempt ${input.stageAttempt}: ${input.status}`,
    metadata: {
      schema: DELEGATED_STAGE_ATTEMPT_METADATA_SCHEMA,
      runGroupId: input.runGroupId,
      stageName: input.stageName,
      stageAttempt: input.stageAttempt,
      status: input.status,
      attemptIdempotencyKey: input.attemptIdempotencyKey,
      failureClass: input.failureClass ?? null,
      usage: input.usage ?? null,
      artifactPaths: input.artifactPaths ?? [],
    },
  };
}

export function reduceDelegatedStageAttempts(
  journal: DispatcherRunJournal,
): DelegatedStageProjection {
  const activeByKey = new Map<string, ProjectedDelegatedStageAttempt>();
  const maxAttemptByKey = new Map<string, number>();
  const ignoredLate: ProjectedDelegatedStageAttempt[] = [];
  const degraded: DelegatedStageProjectionDegradedEntry[] = [];

  for (const entry of journal) {
    if (entry.kind !== DELEGATED_STAGE_ATTEMPT_JOURNAL_KIND) {
      continue;
    }
    const parsed = parseDelegatedAttempt(entry);
    if (typeof parsed === "string") {
      // Explicit degraded — unknown status / missing metadata never silently
      // presents as a successful active attempt.
      degraded.push({
        sequence: entry.sequence,
        idempotencyKey: entry.idempotencyKey ?? null,
        reason: parsed,
      });
      continue;
    }

    // Collision-free key over (runGroupId, stageName).
    const key = JSON.stringify([parsed.runGroupId, parsed.stageName]);
    const currentMax = maxAttemptByKey.get(key) ?? -1;
    if (parsed.stageAttempt < currentMax) {
      // Late result from a superseded attempt: recorded, never advances active.
      ignoredLate.push({ ...parsed, status: "ignored_late_result" });
      continue;
    }
    if (parsed.stageAttempt > currentMax) {
      maxAttemptByKey.set(key, parsed.stageAttempt);
    }
    // Latest state for the active attempt (idempotent: latest entry wins).
    activeByKey.set(key, parsed);
  }

  return {
    active: [...activeByKey.values()],
    ignoredLate,
    degraded,
  };
}

function parseDelegatedAttempt(
  entry: DispatcherRunJournalEntry,
): ProjectedDelegatedStageAttempt | string {
  const m = entry.metadata;
  const runGroupId = readNonBlankString(m.runGroupId);
  if (runGroupId === null) return "missing_metadata:runGroupId";
  const stageName = readNonBlankString(m.stageName);
  if (stageName === null) return "missing_metadata:stageName";
  const stageAttempt = readInteger(m.stageAttempt);
  if (stageAttempt === null) return "missing_metadata:stageAttempt";
  const statusRaw = readNonBlankString(m.status);
  if (statusRaw === null) return "missing_metadata:status";
  if (!isDelegatedStageAttemptStatus(statusRaw)) {
    return `unknown_status:${statusRaw}`;
  }
  return {
    runGroupId,
    stageName,
    stageAttempt,
    status: statusRaw,
    failureClass: readNonBlankString(m.failureClass),
    usage: isStageUsageMeasurement(m.usage) ? m.usage : null,
    artifactPaths: readStringArray(m.artifactPaths),
    attemptIdempotencyKey: readNonBlankString(m.attemptIdempotencyKey),
    sequence: entry.sequence,
  };
}

export interface DelegatedStageOperatorSummary {
  active: {
    stageName: string;
    stageAttempt: number;
    status: DelegatedStageAttemptStatus;
    failureClass: string | null;
    /** Usage quality label (e.g. "true", "unavailable") — never a raw count. */
    usageQuality: string;
  }[];
  ignoredLateCount: number;
  degradedCount: number;
  degradedReasons: string[];
}

/**
 * Operator-facing summary: exposes substrate failure class and usage quality
 * without dumping raw journal JSON as the primary surface (SYMPH-811).
 */
export function summarizeDelegatedStageProjection(
  projection: DelegatedStageProjection,
): DelegatedStageOperatorSummary {
  return {
    active: projection.active.map((attempt) => ({
      stageName: attempt.stageName,
      stageAttempt: attempt.stageAttempt,
      status: attempt.status,
      failureClass: attempt.failureClass,
      usageQuality: attempt.usage?.measurementQuality ?? "unavailable",
    })),
    ignoredLateCount: projection.ignoredLate.length,
    degradedCount: projection.degraded.length,
    degradedReasons: projection.degraded.map((entry) => entry.reason),
  };
}

function isDelegatedStageAttemptStatus(
  value: string,
): value is DelegatedStageAttemptStatus {
  return (DELEGATED_STAGE_ATTEMPT_STATUSES as readonly string[]).includes(
    value,
  );
}

function readNonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
