/**
 * Interactive-CLI structural-advisory evidence writer (SYMPH-1140).
 * The interactive/CLI surfaces (`symphony-manager-plan` for emission,
 * `symphony-advisory-grade` for the session agent's decision) journal into the
 * SAME dispatcher run journal the automated tick and the calibration digest
 * already use — this is NOT a parallel persistence system. It reuses the
 * existing structural-advisory fingerprint identity and the existing journal
 * writer (`appendDispatcherRunJournalEntriesWithLock`), tagging records with a
 * `source` discriminator so CLI evidence stays distinguishable from tick and
 * symphonyctl evidence in the digest.
 */

import {
  structuralAdvisoryFingerprint,
  structuralAdvisoryMemberSetHash,
  validateStructuralAdvisoryMembers,
} from "../agent/advisory-lifecycle.js";
import type { DispatcherRunJournalEntry } from "../domain/model.js";
import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import type { IntentActor } from "../orchestrator/intent.js";
import {
  type AdvisoryMemberActivitySnapshot,
  type StructuralAdvisoryGradeDecision,
  type StructuralAdvisorySource,
  buildStructuralAdvisoryGradeJournalEntry,
  buildStructuralAdvisoryJournalEntry,
  expandBacklogManagerCalibrationJournal,
} from "../orchestrator/structural-advisory-journal.js";
import {
  appendDispatcherRunJournalEntry,
  appendDispatcherRunJournalEntryToDisk,
  readDispatcherRunJournal,
  withDispatcherRunJournalWriteLock,
} from "./run-journal.js";
import { appendStructuralAdvisoryEntriesWithProjectionDedup } from "./structural-advisory-journal-append.js";
/** The interactive CLI channel writes evidence as `cli-session`. */
const CLI_STRUCTURAL_ADVISORY_SOURCE: StructuralAdvisorySource = "cli-session";

/** Normalize a member set the same way the live lifecycle does (KTD-1). */
function normalizeMembers(identifiers: readonly string[]): string[] {
  return [...new Set(identifiers.map((identifier) => identifier.trim()))]
    .filter((identifier) => identifier.length > 0)
    .sort();
}

/**
 * Resolve the fingerprint identity for an advisory, computing it from the
 * member set + root hypothesis when the preview advisory has not been through
 * the lifecycle yet. Members are normalized so the CLI identity matches the
 * identity the automated tick would mint for the same advisory.
 */
function withFingerprintIdentity(advisory: StructuralAdvisory): {
  advisory: StructuralAdvisory;
  members: string[];
} | null {
  const members = normalizeMembers(advisory.memberIssueIdentifiers);
  if (members.length === 0) {
    return null;
  }
  const memberSetHash =
    advisory.memberSetHash ?? structuralAdvisoryMemberSetHash(members);
  const advisoryFingerprint =
    advisory.advisoryFingerprint ??
    structuralAdvisoryFingerprint(memberSetHash, advisory.rootCauseHypothesis);
  return {
    members,
    advisory: {
      ...advisory,
      memberIssueIdentifiers: members,
      memberSetHash,
      advisoryFingerprint,
    },
  };
}

export interface JournalCliStructuralAdvisoriesInput {
  /** Workspace root containing `.symphony/run-journals/`. */
  root: string;
  advisories: readonly StructuralAdvisory[];
  /** Exact identifiers visible in the planner context that emitted the rows. */
  presentedIssueIdentifiers: ReadonlySet<string>;
  /** Best available observation-time activity for the presented issues. */
  memberActivityByIdentifier?: ReadonlyMap<
    string,
    AdvisoryMemberActivitySnapshot
  >;
  /** Defaults to `cli-session`. */
  source?: StructuralAdvisorySource;
  ownerId?: string | null;
  now?: () => Date;
}

export interface JournalCliStructuralAdvisoriesResult {
  appended: DispatcherRunJournalEntry[];
  skipped: DispatcherRunJournalEntry[];
  invalidAdvisoryCount: number;
}

/**
 * Journal each emitted structural advisory as a `structural_advisory`
 * transition record (none -> active) with a CLI source discriminator. Records
 * are deduped by the existing fingerprint-scoped idempotency key, so re-running
 * the same plan does not double-count evidence.
 */
export async function journalCliStructuralAdvisories(
  input: JournalCliStructuralAdvisoriesInput,
): Promise<JournalCliStructuralAdvisoriesResult> {
  const now = input.now ?? (() => new Date());
  const source = input.source ?? CLI_STRUCTURAL_ADVISORY_SOURCE;
  const ownerId = input.ownerId ?? null;
  const timestamp = now().toISOString();
  let invalidAdvisoryCount = 0;

  const drafts = input.advisories.flatMap((advisory) => {
    const validation = validateStructuralAdvisoryMembers(
      advisory.memberIssueIdentifiers,
      input.presentedIssueIdentifiers,
    );
    if (!validation.valid) {
      invalidAdvisoryCount += 1;
      return [];
    }
    const resolved = withFingerprintIdentity({
      ...advisory,
      memberIssueIdentifiers: validation.members,
    });
    if (resolved === null) return [];
    const membersAtObservation = input.memberActivityByIdentifier
      ? resolved.members.map(
          (identifier) =>
            input.memberActivityByIdentifier?.get(identifier) ??
            unknownMemberActivity(identifier),
        )
      : undefined;
    return [
      buildStructuralAdvisoryJournalEntry({
        record: {
          advisory: { ...resolved.advisory, lifecycleState: "active" },
          from: null,
          to: "active",
          timestamp,
          // CLI emission is one stable observation channel per fingerprint,
          // independent of when a repeated Manager run happens.
          occurrence: source,
        },
        ownerId,
        source,
        ...(membersAtObservation === undefined ? {} : { membersAtObservation }),
      }),
    ];
  });

  if (drafts.length === 0) {
    return { appended: [], skipped: [], invalidAdvisoryCount };
  }

  const result = await appendStructuralAdvisoryEntriesWithProjectionDedup(
    input.root,
    drafts,
  );
  return {
    appended: result.appendedEntries,
    skipped: result.skippedEntries,
    invalidAdvisoryCount,
  };
}

export interface JournalCliStructuralAdvisoryGradeInput {
  /** Workspace root containing `.symphony/run-journals/`. */
  root: string;
  advisory: StructuralAdvisory;
  decision: StructuralAdvisoryGradeDecision;
  /** Required for a `partial` grade; ignored otherwise. */
  acceptedIdentifiers?: readonly string[];
  /** Optional live member activity; defaults to the advisory's members. */
  membersAtGrade?: readonly AdvisoryMemberActivitySnapshot[];
  droppedIdentifiers?: readonly string[];
  actor: IntentActor;
  reason: string;
  /** Defaults to `cli-session`. */
  source?: StructuralAdvisorySource;
  ownerId?: string | null;
  now?: () => Date;
}

export interface JournalCliStructuralAdvisoryGradeResult {
  status: "applied" | "conflict";
  entry: DispatcherRunJournalEntry;
}
/**
 * Journal a `structural_advisory_grade` decision through the existing journal
 * writer (the primary interactive grade path). First-decision immutability per
 * fingerprint+actor is enforced by the writer's idempotency key: a duplicate
 * grade is reported as `conflict` and the original row is returned unchanged.
 */
export async function journalCliStructuralAdvisoryGrade(
  input: JournalCliStructuralAdvisoryGradeInput,
): Promise<JournalCliStructuralAdvisoryGradeResult> {
  const resolved = withFingerprintIdentity(input.advisory);
  if (resolved === null) {
    throw new Error(
      "Cannot grade a structural advisory with an empty member set.",
    );
  }
  const now = input.now ?? (() => new Date());
  const source = input.source ?? CLI_STRUCTURAL_ADVISORY_SOURCE;
  const acceptedIdentifiers =
    input.decision === "accept"
      ? resolved.members
      : input.decision === "partial"
        ? (input.acceptedIdentifiers ?? [])
        : [];
  validateAcceptedIdentifiers(
    input.decision,
    resolved.members,
    acceptedIdentifiers,
  );

  return withDispatcherRunJournalWriteLock(input.root, async () => {
    const journal = await readDispatcherRunJournal(input.root);
    const expanded = expandBacklogManagerCalibrationJournal(journal);
    const membersAtGrade =
      input.membersAtGrade ??
      activitySnapshotsFromJournal(
        expanded,
        resolved.advisory.advisoryFingerprint,
        resolved.members,
      );
    const draft = buildStructuralAdvisoryGradeJournalEntry({
      advisory: resolved.advisory,
      decision: input.decision,
      acceptedIdentifiers,
      membersAtGrade,
      droppedIdentifiers: input.droppedIdentifiers ?? [],
      actor: input.actor,
      reason: input.reason,
      ownerId: input.ownerId ?? null,
      timestamp: now().toISOString(),
      source,
    });

    // Compaction replaces covered rows with a checkpoint projection. Inspect
    // that expanded view before allocating or writing so first-decision
    // immutability survives checkpointing without opening a lock race.
    const existing = expanded.find(
      (entry) => entry.idempotencyKey === draft.idempotencyKey,
    );
    if (existing !== undefined) {
      return { status: "conflict" as const, entry: existing };
    }
    const appended = appendDispatcherRunJournalEntry(journal, draft);
    if (!appended.appended) {
      return { status: "conflict" as const, entry: appended.entry };
    }
    await appendDispatcherRunJournalEntryToDisk(input.root, appended.entry);
    return { status: "applied" as const, entry: appended.entry };
  });
}

function validateAcceptedIdentifiers(
  decision: StructuralAdvisoryGradeDecision,
  members: readonly string[],
  acceptedIdentifiers: readonly string[],
): void {
  if (decision !== "partial") return;
  const accepted = [...new Set(acceptedIdentifiers)];
  const membersSet = new Set(members);
  if (accepted.length === 0) {
    throw new Error("A partial grade requires a non-empty accepted subset.");
  }
  if (accepted.some((identifier) => !membersSet.has(identifier))) {
    throw new Error(
      "Partial accepted identifiers must belong to the advisory member set.",
    );
  }
  if (accepted.length >= membersSet.size) {
    throw new Error(
      "Partial accepted identifiers must be a proper subset of the advisory member set.",
    );
  }
}

function activitySnapshotsFromJournal(
  journal: readonly DispatcherRunJournalEntry[],
  advisoryId: string | undefined,
  members: readonly string[],
): AdvisoryMemberActivitySnapshot[] {
  const observation = [...journal]
    .reverse()
    .find(
      (entry) =>
        entry.kind === "structural_advisory" &&
        entry.metadata.advisory_id === advisoryId &&
        Array.isArray(entry.metadata.member_activity),
    );
  const observed = new Map<string, AdvisoryMemberActivitySnapshot>();
  if (Array.isArray(observation?.metadata.member_activity)) {
    for (const value of observation.metadata.member_activity) {
      const snapshot = parseMemberActivitySnapshot(value);
      if (snapshot !== null) observed.set(snapshot.identifier, snapshot);
    }
  }
  return members.map(
    (identifier) =>
      observed.get(identifier) ?? unknownMemberActivity(identifier),
  );
}

function parseMemberActivitySnapshot(
  value: unknown,
): AdvisoryMemberActivitySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.identifier !== "string" ||
    typeof snapshot.state !== "string" ||
    !isNullableString(snapshot.stateUpdatedAt) ||
    !isNullableString(snapshot.latestCommentAt) ||
    !isNullableString(snapshot.activityAt)
  ) {
    return null;
  }
  return {
    identifier: snapshot.identifier,
    state: snapshot.state,
    stateUpdatedAt: snapshot.stateUpdatedAt,
    latestCommentAt: snapshot.latestCommentAt,
    activityAt: snapshot.activityAt,
  };
}

function unknownMemberActivity(
  identifier: string,
): AdvisoryMemberActivitySnapshot {
  return {
    identifier,
    state: "unknown",
    stateUpdatedAt: null,
    latestCommentAt: null,
    activityAt: null,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
