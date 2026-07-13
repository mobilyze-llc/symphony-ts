import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
} from "../domain/model.js";
import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import {
  type IntentActor,
  formatIntentActorKey,
  formatIntentAttribution,
} from "./intent.js";

const STRUCTURAL_ADVISORY_GRADE_DECISIONS = [
  "accept",
  "partial",
  "reject",
] as const;

export type StructuralAdvisoryGradeDecision =
  (typeof STRUCTURAL_ADVISORY_GRADE_DECISIONS)[number];

/**
 * Evidence channel for shared-journal advisory rows (SYMPH-1140). Fingerprints
 * remain the join key; source distinguishes CLI, tick, and escape-hatch rows.
 */
const STRUCTURAL_ADVISORY_SOURCES = [
  "tick",
  "cli-session",
  "symphonyctl",
] as const;

export type StructuralAdvisorySource =
  (typeof STRUCTURAL_ADVISORY_SOURCES)[number];

const DEFAULT_STRUCTURAL_ADVISORY_SOURCE: StructuralAdvisorySource = "tick";

export interface AdvisoryMemberActivitySnapshot {
  identifier: string;
  state: string;
  stateUpdatedAt: string | null;
  latestCommentAt: string | null;
  activityAt: string | null;
}

export interface StructuralAdvisoryRejection {
  advisoryId: string;
  memberSetHash: string;
  memberActivityAtGrade: Record<string, string | null>;
  gradeSequence: number;
}

export interface StructuralAdvisoryGradeEvidence {
  advisoryId: string;
  memberSetHash: string;
  decision: StructuralAdvisoryGradeDecision;
  acceptedIdentifiers: string[];
  memberDelta: string[];
  gradeSequence: number;
}

export interface StructuralAdvisoryLifecycleRecord {
  advisory: StructuralAdvisory;
  from: string | null;
  to: string;
  timestamp: string;
  occurrence?: number | string;
}

const BACKLOG_MANAGER_CALIBRATION_SCHEMA_VERSION = 1;

interface ProjectedGrade {
  sequence: number;
  timestamp: string;
  actorKey: string;
  idempotencyKey?: string;
  metadata: Record<string, unknown>;
}
interface ProjectedCliObservation {
  // The CLI is one stable evidence channel per fingerprint. Retaining this
  // single observation keeps compaction bounded regardless of transition age.
  sequence: number;
  timestamp: string;
  idempotencyKey: string;
  memberActivity?: unknown[];
}
interface ProjectedAdvisory {
  advisoryId: string;
  memberSetHash: string;
  advisoryClass: string;
  idempotencyKey?: string;
  memberActivity?: unknown[];
  firstSeenSequence: number;
  firstSeenAt: string;
  lastSeenSequence: number;
  lastSeenAt: string;
  latestLifecycleFrom: string | null;
  latestLifecycleTo: string;
  transitionOccurrenceCount: number;
  flipCount: number;
  cliObservation?: ProjectedCliObservation;
  grades: ProjectedGrade[];
}
interface ProjectedHygieneProposal {
  proposalId: string;
  sequence: number;
  timestamp: string;
  summary: string;
  issueId: string;
  issueIdentifier: string;
  metadata: Record<string, unknown>;
  decisions: ProjectedGrade[];
}
export interface BacklogManagerCalibrationProjection {
  schemaVersion: 1;
  coveredThroughSequence: number;
  advisories: Record<string, ProjectedAdvisory>;
  hygieneProposals: Record<string, ProjectedHygieneProposal>;
}

export function buildBacklogManagerCalibrationProjection(
  journal: DispatcherRunJournal,
): BacklogManagerCalibrationProjection {
  const checkpoint = latestCalibrationCheckpoint(journal);
  const projection = checkpoint?.projection ?? emptyCalibrationProjection();
  const floor = checkpoint?.coveredThroughSequence ?? 0;
  for (const entry of [...journal].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.kind === "journal_checkpoint" || entry.sequence <= floor)
      continue;
    foldCalibrationEntry(projection, entry);
  }
  projection.coveredThroughSequence = Math.max(
    projection.coveredThroughSequence,
    ...journal.map((entry) => entry.sequence),
  );
  return projection;
}

/**
 * Rehydrate compacted Manager calibration rows for read-model consumers. Raw
 * retained-tail duplicates are excluded through coveredThroughSequence.
 */
export function expandBacklogManagerCalibrationJournal(
  journal: DispatcherRunJournal,
): DispatcherRunJournal {
  const checkpoint = latestCalibrationCheckpoint(journal);
  if (checkpoint === null) return journal;
  const projection = buildBacklogManagerCalibrationProjection(journal);
  const synthetic: DispatcherRunJournalEntry[] = [];
  for (const advisory of Object.values(projection.advisories)) {
    const firstObservationIsCli =
      advisory.cliObservation?.idempotencyKey === advisory.idempotencyKey;
    synthetic.push({
      sequence: advisory.firstSeenSequence,
      idempotencyKey:
        advisory.idempotencyKey ??
        `projected:structural_advisory:${advisory.advisoryId}`,
      timestamp: advisory.firstSeenAt,
      kind: "structural_advisory",
      issueId: "__structural_advisory__",
      issueIdentifier: "STRUCTURAL_ADVISORY",
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: null,
      lease: null,
      summary: `Projected structural advisory ${advisory.advisoryId}.`,
      metadata: {
        schema_version: 1,
        advisory_id: advisory.advisoryId,
        member_set_hash: advisory.memberSetHash,
        advisory_class: advisory.advisoryClass,
        lifecycle_from: null,
        lifecycle_to: advisory.latestLifecycleTo,
        projection_first_seen_at: advisory.firstSeenAt,
        projection_last_seen_at: advisory.lastSeenAt,
        projection_last_seen_sequence: advisory.lastSeenSequence,
        projection_flip_count: advisory.flipCount,
        projection_transition_count: advisory.transitionOccurrenceCount,
        ...(firstObservationIsCli ? { source: "cli-session" } : {}),
        ...(advisory.memberActivity === undefined
          ? {}
          : { member_activity: advisory.memberActivity }),
      },
    });
    if (advisory.cliObservation !== undefined && !firstObservationIsCli) {
      synthetic.push(
        projectedCliObservationEntry(advisory, advisory.cliObservation),
      );
    }
    synthetic.push(
      ...advisory.grades.map((grade) => projectedGradeEntry(grade)),
    );
  }
  for (const proposal of Object.values(projection.hygieneProposals)) {
    synthetic.push({
      sequence: proposal.sequence,
      idempotencyKey: `projected:hygiene_proposal:${proposal.proposalId}`,
      timestamp: proposal.timestamp,
      kind: "hygiene_proposal",
      issueId: proposal.issueId,
      issueIdentifier: proposal.issueIdentifier,
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: null,
      lease: null,
      summary: proposal.summary,
      metadata: proposal.metadata,
    });
    synthetic.push(
      ...proposal.decisions.map((grade) =>
        projectedGradeEntry(grade, "hygiene_proposal_decision"),
      ),
    );
  }
  const rawAfterCheckpoint = journal.filter(
    (entry) =>
      entry.kind !== "journal_checkpoint" &&
      entry.sequence > checkpoint.coveredThroughSequence,
  );
  return [...synthetic, ...rawAfterCheckpoint].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function projectedCliObservationEntry(
  advisory: ProjectedAdvisory,
  observation: ProjectedCliObservation,
): DispatcherRunJournalEntry {
  return {
    sequence: observation.sequence,
    idempotencyKey: observation.idempotencyKey,
    timestamp: observation.timestamp,
    kind: "structural_advisory",
    issueId: "__structural_advisory__",
    issueIdentifier: "STRUCTURAL_ADVISORY",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: null,
    lease: null,
    summary: `Projected CLI observation for structural advisory ${advisory.advisoryId}.`,
    metadata: {
      schema_version: 1,
      source: "cli-session",
      advisory_id: advisory.advisoryId,
      member_set_hash: advisory.memberSetHash,
      advisory_class: advisory.advisoryClass,
      lifecycle_from: null,
      lifecycle_to: "active",
      ...(observation.memberActivity === undefined
        ? {}
        : { member_activity: observation.memberActivity }),
    },
  };
}

function projectedGradeEntry(
  grade: ProjectedGrade,
  kind:
    | "structural_advisory_grade"
    | "hygiene_proposal_decision" = "structural_advisory_grade",
): DispatcherRunJournalEntry {
  return {
    sequence: grade.sequence,
    // Preserve the actor-scoped key so restart-time immutable-decision checks
    // see checkpointed grades exactly as they saw the original journal row.
    idempotencyKey:
      grade.idempotencyKey ?? `projected:${kind}:${grade.sequence}`,
    timestamp: grade.timestamp,
    kind,
    issueId:
      kind === "structural_advisory_grade"
        ? "__structural_advisory__"
        : "__backlog_hygiene__",
    issueIdentifier:
      kind === "structural_advisory_grade"
        ? "STRUCTURAL_ADVISORY"
        : "BACKLOG_HYGIENE",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: null,
    lease: null,
    summary: `Projected ${kind} at seq ${grade.sequence}.`,
    metadata: grade.metadata,
  };
}

function foldCalibrationEntry(
  projection: BacklogManagerCalibrationProjection,
  entry: DispatcherRunJournalEntry,
): void {
  if (entry.kind === "structural_advisory") {
    const advisoryId = stringMeta(entry, "advisory_id");
    const memberSetHash = stringMeta(entry, "member_set_hash");
    if (advisoryId === null || memberSetHash === null) return;
    const from = stringMeta(entry, "lifecycle_from");
    const to = stringMeta(entry, "lifecycle_to") ?? "active";
    const current = projection.advisories[advisoryId];
    if (current === undefined) {
      const cliObservation = projectedCliObservation(entry);
      projection.advisories[advisoryId] = {
        advisoryId,
        memberSetHash,
        advisoryClass: stringMeta(entry, "advisory_class") ?? "unknown",
        idempotencyKey: entry.idempotencyKey,
        ...(Array.isArray(entry.metadata.member_activity)
          ? { memberActivity: entry.metadata.member_activity }
          : {}),
        firstSeenSequence: entry.sequence,
        firstSeenAt: entry.timestamp,
        lastSeenSequence: entry.sequence,
        lastSeenAt: entry.timestamp,
        latestLifecycleFrom: from,
        latestLifecycleTo: to,
        transitionOccurrenceCount: 1,
        flipCount: isFlip(from, to) ? 1 : 0,
        ...(cliObservation === undefined ? {} : { cliObservation }),
        grades: [],
      };
    } else {
      current.lastSeenSequence = entry.sequence;
      current.lastSeenAt = entry.timestamp;
      current.latestLifecycleFrom = from;
      current.latestLifecycleTo = to;
      current.transitionOccurrenceCount += 1;
      if (isFlip(from, to)) current.flipCount += 1;
      if (current.cliObservation === undefined) {
        const cliObservation = projectedCliObservation(entry);
        if (cliObservation !== undefined) {
          current.cliObservation = cliObservation;
        }
      }
    }
    return;
  }
  if (entry.kind === "structural_advisory_grade") {
    const advisoryId = stringMeta(entry, "advisory_id");
    if (advisoryId === null) return;
    const advisory = projection.advisories[advisoryId];
    if (advisory === undefined) return;
    appendFirstActorGrade(advisory.grades, entry);
    return;
  }
  if (entry.kind === "hygiene_proposal") {
    const proposalId = stringMeta(entry, "proposal_id");
    if (
      proposalId === null ||
      projection.hygieneProposals[proposalId] !== undefined
    )
      return;
    projection.hygieneProposals[proposalId] = {
      proposalId,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      summary: entry.summary,
      issueId: entry.issueId,
      issueIdentifier: entry.issueIdentifier,
      metadata: entry.metadata,
      decisions: [],
    };
    return;
  }
  if (entry.kind === "hygiene_proposal_decision") {
    const proposalId = stringMeta(entry, "proposal_id");
    if (proposalId === null) return;
    const proposal = projection.hygieneProposals[proposalId];
    if (proposal !== undefined)
      appendFirstActorGrade(proposal.decisions, entry);
  }
}

function projectedCliObservation(
  entry: DispatcherRunJournalEntry,
): ProjectedCliObservation | undefined {
  if (stringMeta(entry, "source") !== "cli-session") return undefined;
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    idempotencyKey: entry.idempotencyKey,
    ...(Array.isArray(entry.metadata.member_activity)
      ? { memberActivity: entry.metadata.member_activity }
      : {}),
  };
}

function appendFirstActorGrade(
  grades: ProjectedGrade[],
  entry: DispatcherRunJournalEntry,
): void {
  const actorKey = JSON.stringify(entry.metadata.actor ?? null);
  if (grades.some((grade) => grade.actorKey === actorKey)) return;
  grades.push({
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    actorKey,
    idempotencyKey: entry.idempotencyKey,
    metadata: entry.metadata,
  });
  grades.sort((left, right) => left.sequence - right.sequence);
}

function latestCalibrationCheckpoint(journal: DispatcherRunJournal): {
  coveredThroughSequence: number;
  projection: BacklogManagerCalibrationProjection;
} | null {
  for (const entry of [...journal].reverse()) {
    if (entry.kind !== "journal_checkpoint") continue;
    const projection = parseCalibrationProjection(
      entry.metadata.backlogManagerCalibration,
    );
    const covered = entry.metadata.coveredThroughSequence;
    if (projection !== null && isSequence(covered)) {
      return { coveredThroughSequence: covered, projection };
    }
  }
  return null;
}

function parseCalibrationProjection(
  value: unknown,
): BacklogManagerCalibrationProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.schemaVersion !== BACKLOG_MANAGER_CALIBRATION_SCHEMA_VERSION ||
    !isSequence(value.coveredThroughSequence) ||
    !isRecord(value.advisories) ||
    !isRecord(value.hygieneProposals) ||
    !Object.entries(value.advisories).every(
      ([key, advisory]) =>
        isRecord(advisory) &&
        advisory.advisoryId === key &&
        isNonemptyString(advisory.memberSetHash) &&
        isNonemptyString(advisory.advisoryClass) &&
        (advisory.idempotencyKey === undefined ||
          isNonemptyString(advisory.idempotencyKey)) &&
        (advisory.memberActivity === undefined ||
          Array.isArray(advisory.memberActivity)) &&
        isSequence(advisory.firstSeenSequence) &&
        isNonemptyString(advisory.firstSeenAt) &&
        isSequence(advisory.lastSeenSequence) &&
        isNonemptyString(advisory.lastSeenAt) &&
        (advisory.latestLifecycleFrom === null ||
          typeof advisory.latestLifecycleFrom === "string") &&
        isNonemptyString(advisory.latestLifecycleTo) &&
        isSequence(advisory.transitionOccurrenceCount) &&
        isSequence(advisory.flipCount) &&
        (advisory.cliObservation === undefined ||
          isProjectedCliObservation(advisory.cliObservation)) &&
        Array.isArray(advisory.grades) &&
        advisory.grades.every(isProjectedGrade),
    ) ||
    !Object.entries(value.hygieneProposals).every(
      ([key, proposal]) =>
        isRecord(proposal) &&
        proposal.proposalId === key &&
        isSequence(proposal.sequence) &&
        isNonemptyString(proposal.timestamp) &&
        typeof proposal.summary === "string" &&
        isNonemptyString(proposal.issueId) &&
        isNonemptyString(proposal.issueIdentifier) &&
        isRecord(proposal.metadata) &&
        Array.isArray(proposal.decisions) &&
        proposal.decisions.every(isProjectedGrade),
    )
  ) {
    return null;
  }
  return structuredClone(
    value as unknown as BacklogManagerCalibrationProjection,
  );
}
function isProjectedCliObservation(
  value: unknown,
): value is ProjectedCliObservation {
  return (
    isRecord(value) &&
    isSequence(value.sequence) &&
    isNonemptyString(value.timestamp) &&
    isNonemptyString(value.idempotencyKey) &&
    (value.memberActivity === undefined || Array.isArray(value.memberActivity))
  );
}
function isProjectedGrade(value: unknown): value is ProjectedGrade {
  return (
    isRecord(value) &&
    isSequence(value.sequence) &&
    isNonemptyString(value.timestamp) &&
    typeof value.actorKey === "string" &&
    (value.idempotencyKey === undefined ||
      isNonemptyString(value.idempotencyKey)) &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function emptyCalibrationProjection(): BacklogManagerCalibrationProjection {
  return {
    schemaVersion: BACKLOG_MANAGER_CALIBRATION_SCHEMA_VERSION,
    coveredThroughSequence: 0,
    advisories: {},
    hygieneProposals: {},
  };
}

function isFlip(from: string | null, to: string): boolean {
  return (
    (from === "active" && to === "dormant") ||
    (from === "dormant" && to === "active")
  );
}
function structuralAdvisoryClass(advisory: StructuralAdvisory): string {
  const count = advisory.memberIssueIdentifiers.length;
  const bucket = count <= 2 ? "2" : count <= 5 ? "3-5" : "6+";
  const rootKind =
    advisory.rootIssueIdentifier === undefined ||
    advisory.rootIssueIdentifier === null
      ? "proposed-new-root"
      : "existing-root";
  return `${bucket}:${rootKind}`;
}

export function buildStructuralAdvisoryJournalEntry(input: {
  record: StructuralAdvisoryLifecycleRecord;
  ownerId: string | null;
  source?: StructuralAdvisorySource;
  membersAtObservation?: readonly AdvisoryMemberActivitySnapshot[];
}): Omit<DispatcherRunJournalEntry, "sequence"> {
  const { advisory } = input.record;
  const advisoryId = required(
    advisory.advisoryFingerprint,
    "advisory fingerprint",
  );
  const memberSetHash = required(advisory.memberSetHash, "member-set hash");
  const transition = `${input.record.from ?? "none"}->${input.record.to}`;
  return {
    idempotencyKey: `structural_advisory:${advisoryId}:${transition}:${input.record.occurrence ?? input.record.timestamp}`,
    timestamp: input.record.timestamp,
    kind: "structural_advisory",
    issueId: "__structural_advisory__",
    issueIdentifier: "STRUCTURAL_ADVISORY",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: input.ownerId,
    lease: null,
    summary: `Structural advisory ${advisoryId} transitioned ${transition}.`,
    metadata: {
      schema_version: 1,
      source: input.source ?? DEFAULT_STRUCTURAL_ADVISORY_SOURCE,
      advisory_id: advisoryId,
      member_set_hash: memberSetHash,
      member_identifiers: advisory.memberIssueIdentifiers,
      advisory_class: structuralAdvisoryClass(advisory),
      root_hypothesis_kind:
        advisory.rootIssueIdentifier == null
          ? "proposed-new-root"
          : "existing-root",
      root_issue_identifier: advisory.rootIssueIdentifier ?? null,
      root_cause_hypothesis: advisory.rootCauseHypothesis,
      structural_fix: advisory.structuralFix,
      lifecycle_from: input.record.from,
      lifecycle_to: input.record.to,
      status: input.record.to,
      ...(input.membersAtObservation === undefined
        ? {}
        : { member_activity: input.membersAtObservation }),
    },
  };
}
export function buildStructuralAdvisoryGradeJournalEntry(input: {
  advisory: StructuralAdvisory;
  decision: StructuralAdvisoryGradeDecision;
  acceptedIdentifiers: readonly string[];
  membersAtGrade: readonly AdvisoryMemberActivitySnapshot[];
  droppedIdentifiers: readonly string[];
  actor: IntentActor;
  reason: string;
  ownerId: string | null;
  timestamp: string;
  source?: StructuralAdvisorySource;
}): Omit<DispatcherRunJournalEntry, "sequence"> {
  const advisoryId = required(
    input.advisory.advisoryFingerprint,
    "advisory fingerprint",
  );
  const memberSetHash = required(
    input.advisory.memberSetHash,
    "member-set hash",
  );
  const membersAtGrade = input.membersAtGrade.map(
    (member) => member.identifier,
  );
  const activityByIdentifier = new Map(
    input.membersAtGrade.map((member) => [
      member.identifier,
      member.activityAt,
    ]),
  );
  const originalMembers = [...new Set(input.advisory.memberIssueIdentifiers)];
  const accepted = [...new Set(input.acceptedIdentifiers)].sort();
  return {
    // First decision is immutable per fingerprint+actor. Deliberately exclude
    // the decision value from this key: accept-then-reject is one conflict,
    // never two valid calibration rows.
    idempotencyKey: `structural_advisory_grade:${advisoryId}:${formatIntentActorKey(input.actor)}`,
    timestamp: input.timestamp,
    kind: "structural_advisory_grade",
    issueId: "__structural_advisory__",
    issueIdentifier: "STRUCTURAL_ADVISORY",
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: input.ownerId,
    lease: null,
    summary: `Structural advisory ${advisoryId} graded ${input.decision} ${formatIntentAttribution(input.actor)}.`,
    metadata: {
      schema_version: 1,
      status: "applied",
      source: input.source ?? DEFAULT_STRUCTURAL_ADVISORY_SOURCE,
      advisory_id: advisoryId,
      member_set_hash: memberSetHash,
      advisory_class: structuralAdvisoryClass(input.advisory),
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
      attribution: formatIntentAttribution(input.actor),
      original_member_identifiers: input.advisory.memberIssueIdentifiers,
      members_at_grade: membersAtGrade,
      dropped_identifiers: input.droppedIdentifiers,
      accepted_identifiers: accepted,
      member_delta: originalMembers.filter(
        (identifier) => !accepted.includes(identifier),
      ),
      member_activity: input.membersAtGrade,
      member_activity_at_grade: Object.fromEntries(
        originalMembers.map((identifier) => [
          identifier,
          activityByIdentifier.get(identifier) ?? null,
        ]),
      ),
    },
  };
}

export function projectStructuralAdvisoryRejections(
  journal: DispatcherRunJournal,
): StructuralAdvisoryRejection[] {
  const expanded = expandBacklogManagerCalibrationJournal(journal);
  return projectStructuralAdvisoryGradeEvidence(expanded).flatMap((grade) => {
    if (grade.decision !== "reject") return [];
    const entry = expanded.find(
      (candidate) => candidate.sequence === grade.gradeSequence,
    );
    return [
      {
        advisoryId: grade.advisoryId,
        memberSetHash: grade.memberSetHash,
        memberActivityAtGrade: stringNullableRecord(
          entry?.metadata.member_activity_at_grade,
        ),
        gradeSequence: grade.gradeSequence,
      },
    ];
  });
}

/** Earliest grade globally is authoritative; later actors remain audit rows. */
export function projectStructuralAdvisoryGradeEvidence(
  journal: DispatcherRunJournal,
): StructuralAdvisoryGradeEvidence[] {
  const expanded = journal.some(
    (entry) =>
      entry.kind === "journal_checkpoint" &&
      entry.metadata.backlogManagerCalibration !== undefined,
  )
    ? expandBacklogManagerCalibrationJournal(journal)
    : journal;
  const seenAdvisories = new Set<string>();
  const result: StructuralAdvisoryGradeEvidence[] = [];
  for (const entry of [...expanded].sort((a, b) => a.sequence - b.sequence)) {
    if (entry.kind !== "structural_advisory_grade") continue;
    const advisoryId = stringMeta(entry, "advisory_id");
    const memberSetHash = stringMeta(entry, "member_set_hash");
    if (advisoryId === null || memberSetHash === null) continue;
    if (seenAdvisories.has(advisoryId)) continue;
    const decision = stringMeta(entry, "decision");
    if (
      decision !== "accept" &&
      decision !== "partial" &&
      decision !== "reject"
    ) {
      continue;
    }
    seenAdvisories.add(advisoryId);
    result.push({
      advisoryId,
      memberSetHash,
      decision,
      acceptedIdentifiers: stringArray(entry.metadata.accepted_identifiers),
      memberDelta: stringArray(entry.metadata.member_delta),
      gradeSequence: entry.sequence,
    });
  }
  return result;
}

function stringMeta(
  entry: DispatcherRunJournalEntry,
  key: string,
): string | null {
  const value = entry.metadata[key];
  return typeof value === "string" ? value : null;
}
function stringNullableRecord(value: unknown): Record<string, string | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      item === null || typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Structural advisory ${label} is required.`);
  }
  return value;
}
