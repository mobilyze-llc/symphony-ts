/**
 * Calibration digest: verdict↔outcome joins from the dispatcher run journal
 * (SYMPH-411).
 *
 * Pure read-model over journal entries — no orchestrator coupling, fully
 * deletable. Joins verdict-class events (dispatch_verdict and
 * breaker_transition from SYMPH-405; triage_verdict + intent from
 * SYMPH-399/422) against each issue's eventual terminal outcome, and renders a
 * markdown digest where every number carries the journal cursors (sequences)
 * backing it.
 *
 * Join semantics (documented here because they ARE the metric definitions):
 *
 * - Terminal success for an issue = a completed terminal tracker write: a
 *   `tracker_write` entry whose idempotencyKey contains ":terminal:" and ends
 *   with ":completed" (the orchestrator's "Move X to terminal state Y" write).
 * - Re-park for an issue = a `failure_exhausted` entry.
 * - Operator resume = an `intent` entry with metadata.actor.kind "operator",
 *   metadata.status "applied", and a dispatch-restoring verb
 *   (release / retry_once / rework_with_hint / resume).
 */

import type { DispatcherRunJournalEntry } from "../domain/model.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type JoinOutcome = "recovered" | "re_parked" | "unresolved";

export interface TriageJoinRow {
  issueId: string;
  issueIdentifier: string;
  /** Effective action the envelope executed (metadata.action). */
  action: string;
  /** Model classification (metadata.classification), if any. */
  classification: string | null;
  parkKind: string | null;
  verdictSequence: number;
  outcome: JoinOutcome;
  outcomeSequence: number | null;
}

export interface PrecisionRow {
  /** Group key: effective action or classification. */
  key: string;
  recovered: number;
  reParked: number;
  unresolved: number;
  /** recovered / (recovered + reParked); null when no resolved joins. */
  precision: number | null;
  /** verdict→outcome cursor pairs backing the row. */
  cursors: Array<{ verdictSequence: number; outcomeSequence: number | null }>;
}

export interface HygieneProposalDecisionJoinRow {
  proposalId: string;
  issueId: string;
  issueIdentifier: string;
  findingType: string;
  proposalSequence: number;
  decision: "accepted" | "rejected" | "undecided";
  decisionSequence: number | null;
}

export interface HygieneProposalPrecisionRow {
  findingType: string;
  accepted: number;
  rejected: number;
  undecided: number;
  /** accepted / (accepted + rejected); null when no decided proposals. */
  precision: number | null;
  /** proposal→decision cursor pairs backing the row. */
  cursors: Array<{ proposalSequence: number; decisionSequence: number | null }>;
}

interface StructuralAdvisoryDecisionJoinRow {
  advisoryId: string;
  advisoryClass: string;
  advisorySequence: number;
  decision: "accepted" | "partial" | "rejected" | "undecided";
  gradeSequence: number | null;
  flipCount: number;
}

interface StructuralAdvisoryPrecisionRow {
  advisoryClass: string;
  accepted: number;
  partial: number;
  rejected: number;
  undecided: number;
  precision: number | null;
  cursors: Array<{ advisorySequence: number; gradeSequence: number | null }>;
}

interface StructuralAdvisoryStabilityRow {
  advisoryId: string;
  advisoryClass: string;
  firstSeenAt: string;
  lastSeenAt: string;
  flipCount: number;
  decision: StructuralAdvisoryDecisionJoinRow["decision"];
  undecidedAgeMs: number | null;
}

interface OrphanStructuralAdvisoryGradeRow {
  advisoryId: string;
  gradeSequence: number;
  decision: string;
}

export type ParkJudgement =
  | "true_park"
  | "false_park"
  | "unresolved"
  | "unjudged";

export interface NoveltyParkRow {
  issueId: string;
  issueIdentifier: string;
  parkSequence: number;
  resumeSequence: number | null;
  judgement: ParkJudgement;
  outcomeSequence: number | null;
}

export interface BreakerSaveRow {
  issueId: string;
  issueIdentifier: string;
  parkSequence: number;
  resumeSequence: number | null;
  judgement: ParkJudgement;
  outcomeSequence: number | null;
}

export interface BreakerWindowRow {
  stage: string | null;
  signature: string;
  openedSequence: number;
  closedSequence: number | null;
  saves: BreakerSaveRow[];
}

export interface AlertVolumeRow {
  disposition: string;
  /** gate/halt are the alerting tiers; admit/skip are quiet. */
  alerting: boolean;
  count: number;
  firstSequence: number | null;
  lastSequence: number | null;
}

export interface OperatorActionRow {
  verb: string;
  count: number;
  sequences: number[];
}

export interface QueueBaselineSample {
  sequence: number;
  comparatorVersion: string;
  consideredIssueIds: string[];
  dispatchPicks: string[];
  manualJumpsReorders: unknown[];
  quietDeathOutcomes: unknown[];
  urgentReopenOutcomes: unknown[];
  deliveryOutcomes: unknown[];
}

export interface CalibrationReport {
  journalEntryCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  triageJoins: TriageJoinRow[];
  triagePrecisionByAction: PrecisionRow[];
  triagePrecisionByClassification: PrecisionRow[];
  noveltyParks: NoveltyParkRow[];
  breakerWindows: BreakerWindowRow[];
  alertVolume: AlertVolumeRow[];
  operatorActions: OperatorActionRow[];
  queueBaseline: QueueBaselineSample[];
  hygieneProposalDecisions: HygieneProposalDecisionJoinRow[];
  hygieneProposalPrecisionByFindingType: HygieneProposalPrecisionRow[];
  structuralAdvisoryDecisions: StructuralAdvisoryDecisionJoinRow[];
  structuralAdvisoryPrecisionByClass: StructuralAdvisoryPrecisionRow[];
  structuralAdvisoryStability: StructuralAdvisoryStabilityRow[];
  orphanStructuralAdvisoryGrades: OrphanStructuralAdvisoryGradeRow[];
}

// ---------------------------------------------------------------------------
// Join helpers
// ---------------------------------------------------------------------------

const OPERATOR_RESUME_VERBS = new Set([
  "release",
  "retry_once",
  "rework_with_hint",
  "resume",
]);

function metaString(
  entry: DispatcherRunJournalEntry,
  key: string,
): string | null {
  const value = entry.metadata[key];
  return typeof value === "string" ? value : null;
}

function metaNumber(
  entry: DispatcherRunJournalEntry,
  key: string,
): number | null {
  const value = entry.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rehydrateBacklogManagerCalibration(
  journal: DispatcherRunJournalEntry[],
): DispatcherRunJournalEntry[] {
  const checkpoint = [...journal]
    .reverse()
    .find(
      (entry) =>
        entry.kind === "journal_checkpoint" &&
        isValidDigestCalibrationProjection(
          entry.metadata.backlogManagerCalibration,
        ) &&
        isDigestSequence(entry.metadata.coveredThroughSequence),
    );
  if (checkpoint === undefined) return [...journal];
  const projection = checkpoint.metadata.backlogManagerCalibration;
  if (!isDigestRecord(projection) || projection.schemaVersion !== 1) {
    return [...journal];
  }
  const synthetic: DispatcherRunJournalEntry[] = [];
  if (isDigestRecord(projection.advisories)) {
    for (const value of Object.values(projection.advisories)) {
      if (
        !isDigestRecord(value) ||
        typeof value.advisoryId !== "string" ||
        typeof value.memberSetHash !== "string" ||
        typeof value.advisoryClass !== "string" ||
        typeof value.firstSeenSequence !== "number" ||
        typeof value.firstSeenAt !== "string"
      )
        continue;
      synthetic.push(
        digestSyntheticEntry({
          sequence: value.firstSeenSequence,
          timestamp: value.firstSeenAt,
          kind: "structural_advisory",
          metadata: {
            advisory_id: value.advisoryId,
            member_set_hash: value.memberSetHash,
            advisory_class: value.advisoryClass,
            projection_first_seen_at: value.firstSeenAt,
            projection_last_seen_at: value.lastSeenAt,
            projection_flip_count: value.flipCount,
            lifecycle_from: null,
            lifecycle_to: value.latestLifecycleTo,
          },
        }),
      );
      if (Array.isArray(value.grades)) {
        for (const grade of value.grades) {
          if (
            !isDigestRecord(grade) ||
            !isDigestRecord(grade.metadata) ||
            typeof grade.sequence !== "number" ||
            typeof grade.timestamp !== "string"
          )
            continue;
          synthetic.push(
            digestSyntheticEntry({
              sequence: grade.sequence,
              timestamp: grade.timestamp,
              kind: "structural_advisory_grade",
              metadata: grade.metadata,
            }),
          );
        }
      }
    }
  }
  if (isDigestRecord(projection.hygieneProposals)) {
    for (const value of Object.values(projection.hygieneProposals)) {
      if (
        !isDigestRecord(value) ||
        !isDigestRecord(value.metadata) ||
        typeof value.sequence !== "number" ||
        typeof value.timestamp !== "string" ||
        typeof value.summary !== "string"
      )
        continue;
      synthetic.push(
        digestSyntheticEntry({
          sequence: value.sequence,
          timestamp: value.timestamp,
          kind: "hygiene_proposal",
          metadata: value.metadata,
          summary: value.summary,
        }),
      );
      if (Array.isArray(value.decisions)) {
        for (const decision of value.decisions) {
          if (
            !isDigestRecord(decision) ||
            !isDigestRecord(decision.metadata) ||
            typeof decision.sequence !== "number" ||
            typeof decision.timestamp !== "string"
          )
            continue;
          synthetic.push(
            digestSyntheticEntry({
              sequence: decision.sequence,
              timestamp: decision.timestamp,
              kind: "hygiene_proposal_decision",
              metadata: decision.metadata,
            }),
          );
        }
      }
    }
  }
  const covered = checkpoint.metadata.coveredThroughSequence as number;
  return [
    ...synthetic,
    ...journal.filter(
      (entry) =>
        entry.kind !== "journal_checkpoint" && entry.sequence > covered,
    ),
  ];
}

function digestSyntheticEntry(input: {
  sequence: number;
  timestamp: string;
  kind:
    | "structural_advisory"
    | "structural_advisory_grade"
    | "hygiene_proposal"
    | "hygiene_proposal_decision";
  metadata: Record<string, unknown>;
  summary?: string;
}): DispatcherRunJournalEntry {
  return {
    sequence: input.sequence,
    idempotencyKey: `checkpoint-projection:${input.kind}:${input.sequence}`,
    timestamp: input.timestamp,
    kind: input.kind,
    issueId: `__${input.kind}__`,
    issueIdentifier: input.kind.toUpperCase(),
    operation: "dispatcher",
    stage: null,
    attempt: null,
    ownerId: null,
    lease: null,
    summary: input.summary ?? `Projected ${input.kind}`,
    metadata: input.metadata,
  };
}

function isDigestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDigestCalibrationProjection(value: unknown): boolean {
  if (
    !isDigestRecord(value) ||
    value.schemaVersion !== 1 ||
    !isDigestSequence(value.coveredThroughSequence) ||
    !isDigestRecord(value.advisories) ||
    !isDigestRecord(value.hygieneProposals)
  ) {
    return false;
  }
  const validGrade = (grade: unknown) =>
    isDigestRecord(grade) &&
    isDigestSequence(grade.sequence) &&
    isDigestString(grade.timestamp) &&
    typeof grade.actorKey === "string" &&
    (grade.idempotencyKey === undefined ||
      isDigestString(grade.idempotencyKey)) &&
    isDigestRecord(grade.metadata);
  return (
    Object.entries(value.advisories).every(
      ([key, advisory]) =>
        isDigestRecord(advisory) &&
        advisory.advisoryId === key &&
        isDigestString(advisory.memberSetHash) &&
        isDigestString(advisory.advisoryClass) &&
        isDigestSequence(advisory.firstSeenSequence) &&
        isDigestString(advisory.firstSeenAt) &&
        isDigestSequence(advisory.lastSeenSequence) &&
        isDigestString(advisory.lastSeenAt) &&
        (advisory.latestLifecycleFrom === null ||
          typeof advisory.latestLifecycleFrom === "string") &&
        isDigestString(advisory.latestLifecycleTo) &&
        isDigestSequence(advisory.transitionOccurrenceCount) &&
        isDigestSequence(advisory.flipCount) &&
        Array.isArray(advisory.grades) &&
        advisory.grades.every(validGrade),
    ) &&
    Object.entries(value.hygieneProposals).every(
      ([key, proposal]) =>
        isDigestRecord(proposal) &&
        proposal.proposalId === key &&
        isDigestSequence(proposal.sequence) &&
        isDigestString(proposal.timestamp) &&
        typeof proposal.summary === "string" &&
        isDigestString(proposal.issueId) &&
        isDigestString(proposal.issueIdentifier) &&
        isDigestRecord(proposal.metadata) &&
        Array.isArray(proposal.decisions) &&
        proposal.decisions.every(validGrade),
    )
  );
}

function isDigestSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigestString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function metaStringArray(
  entry: DispatcherRunJournalEntry,
  key: string,
): string[] {
  const value = entry.metadata[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function metaArray(entry: DispatcherRunJournalEntry, key: string): unknown[] {
  const value = entry.metadata[key];
  return Array.isArray(value) ? value : [];
}

function actorKind(entry: DispatcherRunJournalEntry): string | null {
  const actor = entry.metadata.actor;
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) {
    return null;
  }
  const kind = (actor as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function isTerminalSuccess(entry: DispatcherRunJournalEntry): boolean {
  return (
    entry.kind === "tracker_write" &&
    entry.idempotencyKey.includes(":terminal:") &&
    entry.idempotencyKey.endsWith(":completed")
  );
}

function isRePark(entry: DispatcherRunJournalEntry): boolean {
  return entry.kind === "failure_exhausted";
}

function isOperatorResume(entry: DispatcherRunJournalEntry): boolean {
  if (entry.kind !== "intent") {
    return false;
  }
  const verb = metaString(entry, "verb");
  return (
    actorKind(entry) === "operator" &&
    metaString(entry, "status") === "applied" &&
    verb !== null &&
    OPERATOR_RESUME_VERBS.has(verb)
  );
}

/**
 * First terminal outcome for an issue strictly after `afterSequence`:
 * whichever of terminal-success or re-park appears first wins.
 */
function joinOutcomeAfter(
  journal: DispatcherRunJournalEntry[],
  issueId: string,
  afterSequence: number,
): { outcome: JoinOutcome; outcomeSequence: number | null } {
  for (const entry of journal) {
    if (entry.sequence <= afterSequence || entry.issueId !== issueId) {
      continue;
    }
    if (isTerminalSuccess(entry)) {
      return { outcome: "recovered", outcomeSequence: entry.sequence };
    }
    if (isRePark(entry)) {
      return { outcome: "re_parked", outcomeSequence: entry.sequence };
    }
  }
  return { outcome: "unresolved", outcomeSequence: null };
}

/**
 * Judge a park: was it a false park (succeeded immediately on operator
 * resume) or a true park (re-parked after resume)? Unjudged when the
 * operator never resumed it.
 */
function judgePark(
  journal: DispatcherRunJournalEntry[],
  issueId: string,
  parkSequence: number,
): {
  resumeSequence: number | null;
  judgement: ParkJudgement;
  outcomeSequence: number | null;
} {
  const resume = journal.find(
    (entry) =>
      entry.sequence > parkSequence &&
      entry.issueId === issueId &&
      isOperatorResume(entry),
  );
  if (resume === undefined) {
    return {
      resumeSequence: null,
      judgement: "unjudged",
      outcomeSequence: null,
    };
  }
  const { outcome, outcomeSequence } = joinOutcomeAfter(
    journal,
    issueId,
    resume.sequence,
  );
  const judgement: ParkJudgement =
    outcome === "recovered"
      ? "false_park"
      : outcome === "re_parked"
        ? "true_park"
        : "unresolved";
  return { resumeSequence: resume.sequence, judgement, outcomeSequence };
}

function buildPrecisionRows(
  joins: TriageJoinRow[],
  keyOf: (row: TriageJoinRow) => string | null,
): PrecisionRow[] {
  const groups = new Map<string, TriageJoinRow[]>();
  for (const row of joins) {
    const key = keyOf(row);
    if (key === null) {
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const recovered = rows.filter((r) => r.outcome === "recovered").length;
      const reParked = rows.filter((r) => r.outcome === "re_parked").length;
      const unresolved = rows.filter((r) => r.outcome === "unresolved").length;
      const resolved = recovered + reParked;
      return {
        key,
        recovered,
        reParked,
        unresolved,
        precision: resolved === 0 ? null : recovered / resolved,
        cursors: rows.map((r) => ({
          verdictSequence: r.verdictSequence,
          outcomeSequence: r.outcomeSequence,
        })),
      };
    });
}

function metaProposalDecision(
  entry: DispatcherRunJournalEntry,
): "accepted" | "rejected" | null {
  const decision = metaString(entry, "decision");
  return decision === "accepted" || decision === "rejected" ? decision : null;
}

function buildHygieneProposalPrecisionRows(
  joins: HygieneProposalDecisionJoinRow[],
): HygieneProposalPrecisionRow[] {
  const groups = new Map<string, HygieneProposalDecisionJoinRow[]>();
  for (const row of joins) {
    const bucket = groups.get(row.findingType) ?? [];
    bucket.push(row);
    groups.set(row.findingType, bucket);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([findingType, rows]) => {
      const accepted = rows.filter((row) => row.decision === "accepted").length;
      const rejected = rows.filter((row) => row.decision === "rejected").length;
      const undecided = rows.filter(
        (row) => row.decision === "undecided",
      ).length;
      const decided = accepted + rejected;
      return {
        findingType,
        accepted,
        rejected,
        undecided,
        precision: decided === 0 ? null : accepted / decided,
        cursors: rows.map((row) => ({
          proposalSequence: row.proposalSequence,
          decisionSequence: row.decisionSequence,
        })),
      };
    });
}

// ---------------------------------------------------------------------------
// Report computation
// ---------------------------------------------------------------------------

export function computeCalibrationReport(
  journal: DispatcherRunJournalEntry[],
): CalibrationReport {
  const sorted = rehydrateBacklogManagerCalibration(journal).sort(
    (a, b) => a.sequence - b.sequence,
  );

  // --- L2 triage joins (triage_verdict → terminal outcome) -----------------
  const triageJoins: TriageJoinRow[] = sorted.flatMap((entry) => {
    if (
      entry.kind !== "triage_verdict" ||
      metaString(entry, "status") !== "applied"
    ) {
      return [];
    }
    const action = metaString(entry, "action");
    if (action === null) {
      return [];
    }
    const { outcome, outcomeSequence } = joinOutcomeAfter(
      sorted,
      entry.issueId,
      entry.sequence,
    );
    return [
      {
        issueId: entry.issueId,
        issueIdentifier: entry.issueIdentifier,
        action,
        classification: metaString(entry, "classification"),
        parkKind: metaString(entry, "parkKind"),
        verdictSequence: entry.sequence,
        outcome,
        outcomeSequence,
      },
    ];
  });

  // --- Novelty-park accuracy ------------------------------------------------
  // Parked-as-futile = applied triage verdict whose effective action is park
  // on a novelty park. False park = succeeded immediately on operator resume.
  const noveltyParks: NoveltyParkRow[] = sorted
    .filter(
      (entry) =>
        entry.kind === "triage_verdict" &&
        metaString(entry, "status") === "applied" &&
        metaString(entry, "action") === "park" &&
        metaString(entry, "parkKind") === "novelty",
    )
    .map((entry) => {
      const judged = judgePark(sorted, entry.issueId, entry.sequence);
      return {
        issueId: entry.issueId,
        issueIdentifier: entry.issueIdentifier,
        parkSequence: entry.sequence,
        ...judged,
      };
    });

  // --- Breaker value ----------------------------------------------------------
  // For each breaker opened-window, the issues parked by it are the
  // failure_exhausted entries inside the window carrying the breaker's
  // failure_signature (signature match only — summary text would double-count
  // saves across overlapping windows). True save =
  // the parked issue re-parked after operator resume (the breaker correctly
  // predicted the failure); false save = it succeeded on resume.
  const breakerWindows: BreakerWindowRow[] = [];
  for (const entry of sorted) {
    if (
      entry.kind !== "breaker_transition" ||
      metaString(entry, "transition") !== "opened"
    ) {
      continue;
    }
    const signature = metaString(entry, "signature") ?? "unknown";
    const close = sorted.find(
      (candidate) =>
        candidate.sequence > entry.sequence &&
        candidate.kind === "breaker_transition" &&
        metaString(candidate, "transition") === "closed" &&
        metaString(candidate, "signature") === signature &&
        candidate.stage === entry.stage,
    );
    const windowEnd = close?.sequence ?? Number.POSITIVE_INFINITY;
    const parkedInWindow = sorted.filter(
      (candidate) =>
        candidate.sequence > entry.sequence &&
        candidate.sequence < windowEnd &&
        candidate.kind === "failure_exhausted" &&
        metaString(candidate, "failure_signature") === signature,
    );
    breakerWindows.push({
      stage: entry.stage,
      signature,
      openedSequence: entry.sequence,
      closedSequence: close?.sequence ?? null,
      saves: parkedInWindow.map((parked) => {
        const judged = judgePark(sorted, parked.issueId, parked.sequence);
        return {
          issueId: parked.issueId,
          issueIdentifier: parked.issueIdentifier,
          parkSequence: parked.sequence,
          ...judged,
        };
      }),
    });
  }

  // --- Alert volume per tier vs operator actions ----------------------------
  const volumeByDisposition = new Map<string, number[]>();
  for (const entry of sorted) {
    if (entry.kind !== "dispatch_verdict") {
      continue;
    }
    const disposition = metaString(entry, "disposition") ?? "unknown";
    const bucket = volumeByDisposition.get(disposition) ?? [];
    bucket.push(entry.sequence);
    volumeByDisposition.set(disposition, bucket);
  }
  const alertVolume: AlertVolumeRow[] = [...volumeByDisposition.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([disposition, sequences]) => ({
      disposition,
      alerting: disposition === "gate" || disposition === "halt",
      count: sequences.length,
      firstSequence: sequences[0] ?? null,
      lastSequence: sequences[sequences.length - 1] ?? null,
    }));

  const operatorByVerb = new Map<string, number[]>();
  for (const entry of sorted) {
    if (
      entry.kind !== "intent" ||
      actorKind(entry) !== "operator" ||
      metaString(entry, "status") !== "applied"
    ) {
      continue;
    }
    const verb = metaString(entry, "verb") ?? "unknown";
    const bucket = operatorByVerb.get(verb) ?? [];
    bucket.push(entry.sequence);
    operatorByVerb.set(verb, bucket);
  }
  const operatorActions: OperatorActionRow[] = [...operatorByVerb.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([verb, sequences]) => ({ verb, count: sequences.length, sequences }));

  const queueBaseline: QueueBaselineSample[] = sorted.flatMap((entry) => {
    if (entry.kind !== "queue_baseline") {
      return [];
    }
    return [
      {
        sequence: entry.sequence,
        comparatorVersion: metaString(entry, "comparator_version") ?? "unknown",
        consideredIssueIds: metaStringArray(entry, "considered_issue_ids"),
        dispatchPicks: metaStringArray(entry, "dispatch_picks"),
        manualJumpsReorders: metaArray(entry, "manual_jumps_reorders"),
        quietDeathOutcomes: metaArray(entry, "quiet_death_outcomes"),
        urgentReopenOutcomes: metaArray(entry, "urgent_reopen_outcomes"),
        deliveryOutcomes: metaArray(entry, "delivery_outcomes"),
      },
    ];
  });

  const hygieneProposalDecisions: HygieneProposalDecisionJoinRow[] =
    sorted.flatMap((proposal) => {
      if (proposal.kind !== "hygiene_proposal") {
        return [];
      }
      const proposalId = metaString(proposal, "proposal_id");
      const findingType = metaString(proposal, "finding_type");
      if (proposalId === null || findingType === null) {
        return [];
      }
      const decision = sorted.find(
        (candidate) =>
          candidate.sequence > proposal.sequence &&
          candidate.kind === "hygiene_proposal_decision" &&
          metaString(candidate, "proposal_id") === proposalId &&
          metaProposalDecision(candidate) !== null,
      );
      const proposalDecision =
        decision === undefined ? null : metaProposalDecision(decision);
      return [
        {
          proposalId,
          issueId: proposal.issueId,
          issueIdentifier: proposal.issueIdentifier,
          findingType,
          proposalSequence: proposal.sequence,
          decision: proposalDecision ?? "undecided",
          decisionSequence: decision?.sequence ?? null,
        },
      ];
    });

  const advisoryFirstSeen = new Map<string, DispatcherRunJournalEntry>();
  const advisoryTransitions = new Map<string, DispatcherRunJournalEntry[]>();
  for (const entry of sorted) {
    if (entry.kind !== "structural_advisory") continue;
    const advisoryId = metaString(entry, "advisory_id");
    if (advisoryId === null) continue;
    if (!advisoryFirstSeen.has(advisoryId))
      advisoryFirstSeen.set(advisoryId, entry);
    const transitions = advisoryTransitions.get(advisoryId) ?? [];
    transitions.push(entry);
    advisoryTransitions.set(advisoryId, transitions);
  }
  const structuralAdvisoryDecisions: StructuralAdvisoryDecisionJoinRow[] = [
    ...advisoryFirstSeen.entries(),
  ].map(([advisoryId, advisory]) => {
    const grade = sorted.find(
      (candidate) =>
        candidate.kind === "structural_advisory_grade" &&
        metaString(candidate, "advisory_id") === advisoryId,
    );
    const rawDecision =
      grade === undefined ? null : metaString(grade, "decision");
    const decision =
      rawDecision === "accept"
        ? "accepted"
        : rawDecision === "partial"
          ? "partial"
          : rawDecision === "reject"
            ? "rejected"
            : "undecided";
    const projectedFlipCount = metaNumber(advisory, "projection_flip_count");
    const flipCount =
      projectedFlipCount ??
      (advisoryTransitions.get(advisoryId) ?? []).filter((transition) => {
        const from = metaString(transition, "lifecycle_from");
        const to = metaString(transition, "lifecycle_to");
        return (
          (from === "active" && to === "dormant") ||
          (from === "dormant" && to === "active")
        );
      }).length;
    return {
      advisoryId,
      advisoryClass: metaString(advisory, "advisory_class") ?? "unknown",
      advisorySequence: advisory.sequence,
      decision,
      gradeSequence: grade?.sequence ?? null,
      flipCount,
    };
  });
  const structuralAdvisoryPrecisionByClass =
    buildStructuralAdvisoryPrecisionRows(structuralAdvisoryDecisions);
  const asOfMs = Date.parse(sorted.at(-1)?.timestamp ?? "");
  const structuralAdvisoryStability: StructuralAdvisoryStabilityRow[] =
    structuralAdvisoryDecisions.map((row) => {
      const first = advisoryFirstSeen.get(row.advisoryId);
      const transitions = advisoryTransitions.get(row.advisoryId) ?? [];
      const firstSeenAt =
        (first === undefined
          ? null
          : metaString(first, "projection_first_seen_at")) ??
        first?.timestamp ??
        "unknown";
      const lastSeenCandidates = [
        first === undefined
          ? null
          : metaString(first, "projection_last_seen_at"),
        transitions.at(-1)?.timestamp ?? null,
        firstSeenAt,
      ]
        .filter((value): value is string => value !== null)
        .sort();
      const lastSeenAt = lastSeenCandidates.at(-1) ?? firstSeenAt;
      const firstMs = Date.parse(firstSeenAt);
      return {
        advisoryId: row.advisoryId,
        advisoryClass: row.advisoryClass,
        firstSeenAt,
        lastSeenAt,
        flipCount: row.flipCount,
        decision: row.decision,
        undecidedAgeMs:
          row.decision === "undecided" &&
          Number.isFinite(asOfMs) &&
          Number.isFinite(firstMs)
            ? Math.max(0, asOfMs - firstMs)
            : null,
      };
    });
  const orphanStructuralAdvisoryGrades = sorted.flatMap((entry) => {
    if (entry.kind !== "structural_advisory_grade") return [];
    const advisoryId = metaString(entry, "advisory_id");
    if (
      advisoryId === null ||
      sorted.some(
        (candidate) =>
          candidate.kind === "structural_advisory" &&
          metaString(candidate, "advisory_id") === advisoryId,
      )
    ) {
      return [];
    }
    return [
      {
        advisoryId,
        gradeSequence: entry.sequence,
        decision: metaString(entry, "decision") ?? "unknown",
      },
    ];
  });

  return {
    journalEntryCount: sorted.length,
    firstSequence: sorted[0]?.sequence ?? null,
    lastSequence: sorted[sorted.length - 1]?.sequence ?? null,
    triageJoins,
    triagePrecisionByAction: buildPrecisionRows(triageJoins, (r) => r.action),
    triagePrecisionByClassification: buildPrecisionRows(
      triageJoins,
      (r) => r.classification,
    ),
    noveltyParks,
    breakerWindows,
    alertVolume,
    operatorActions,
    queueBaseline,
    hygieneProposalDecisions,
    hygieneProposalPrecisionByFindingType: buildHygieneProposalPrecisionRows(
      hygieneProposalDecisions,
    ),
    structuralAdvisoryDecisions,
    structuralAdvisoryPrecisionByClass,
    structuralAdvisoryStability,
    orphanStructuralAdvisoryGrades,
  };
}

function buildStructuralAdvisoryPrecisionRows(
  rows: readonly StructuralAdvisoryDecisionJoinRow[],
): StructuralAdvisoryPrecisionRow[] {
  const byClass = new Map<string, StructuralAdvisoryDecisionJoinRow[]>();
  for (const row of rows) {
    const bucket = byClass.get(row.advisoryClass) ?? [];
    bucket.push(row);
    byClass.set(row.advisoryClass, bucket);
  }
  return [...byClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([advisoryClass, grouped]) => {
      const accepted = grouped.filter(
        (row) => row.decision === "accepted",
      ).length;
      const partial = grouped.filter(
        (row) => row.decision === "partial",
      ).length;
      const rejected = grouped.filter(
        (row) => row.decision === "rejected",
      ).length;
      const undecided = grouped.filter(
        (row) => row.decision === "undecided",
      ).length;
      const decided = accepted + partial + rejected;
      return {
        advisoryClass,
        accepted,
        partial,
        rejected,
        undecided,
        precision: decided === 0 ? null : (accepted + partial) / decided,
        cursors: grouped.map((row) => ({
          advisorySequence: row.advisorySequence,
          gradeSequence: row.gradeSequence,
        })),
      };
    });
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export interface RenderDigestOptions {
  /** ISO timestamp for the header; injectable for golden-file determinism. */
  generatedAt: string;
  /** Human label for the journal source (path or product name). */
  journalLabel: string;
}

/**
 * Robustness escaping for journal-derived strings interpolated into markdown
 * tables, headings, and bullets: pipes would break table column counts and
 * newlines would break row structure. Not a security boundary.
 */
function escapeMarkdownCell(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").replaceAll("|", "\\|");
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatCursorPair(verdict: number, outcome: number | null): string {
  return outcome === null ? `seq ${verdict}→?` : `seq ${verdict}→${outcome}`;
}

function formatPrecisionTable(
  rows: PrecisionRow[],
  keyHeader: string,
): string[] {
  if (rows.length === 0) {
    return ["_No verdicts in window._"];
  }
  const lines = [
    `| ${keyHeader} | recovered | re-parked | unresolved | precision | cursors |`,
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const cursors = row.cursors
      .map((c) => formatCursorPair(c.verdictSequence, c.outcomeSequence))
      .join(", ");
    lines.push(
      `| ${escapeMarkdownCell(row.key)} | ${row.recovered} | ${row.reParked} | ${row.unresolved} | ${formatPercent(row.precision)} | ${cursors} |`,
    );
  }
  return lines;
}

function formatHygieneProposalPrecisionTable(
  rows: HygieneProposalPrecisionRow[],
): string[] {
  if (rows.length === 0) {
    return ["_No hygiene proposals in window._"];
  }
  const lines = [
    "| finding type | accepted | rejected | undecided | proposal precision | cursors |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const cursors = row.cursors
      .map((cursor) =>
        cursor.decisionSequence === null
          ? `seq ${cursor.proposalSequence}→?`
          : `seq ${cursor.proposalSequence}→${cursor.decisionSequence}`,
      )
      .join(", ");
    lines.push(
      `| ${escapeMarkdownCell(row.findingType)} | ${row.accepted} | ${row.rejected} | ${row.undecided} | ${formatPercent(row.precision)} | ${cursors} |`,
    );
  }
  return lines;
}

function formatStructuralAdvisoryPrecisionTable(
  rows: StructuralAdvisoryPrecisionRow[],
): string[] {
  if (rows.length === 0) return ["_No structural advisories in window._"];
  const lines = [
    "| advisory class | accepted | partial | rejected | undecided | precision | cursors |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.advisoryClass)} | ${row.accepted} | ${row.partial} | ${row.rejected} | ${row.undecided} | ${formatPercent(row.precision)} | ${row.cursors.map((cursor) => formatCursorPair(cursor.advisorySequence, cursor.gradeSequence)).join(", ")} |`,
    );
  }
  return lines;
}

function formatStructuralAdvisoryStabilityTable(
  rows: StructuralAdvisoryStabilityRow[],
): string[] {
  if (rows.length === 0) return ["_No structural advisory stability rows._"];
  return [
    "| advisory | class | first seen | last seen | flips | decision | undecided age |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${escapeMarkdownCell(row.advisoryId)} | ${escapeMarkdownCell(row.advisoryClass)} | ${row.firstSeenAt} | ${row.lastSeenAt} | ${row.flipCount} | ${row.decision} | ${row.undecidedAgeMs === null ? "—" : `${row.undecidedAgeMs}ms`} |`,
    ),
  ];
}

function formatParkRows(
  rows: Array<NoveltyParkRow | BreakerSaveRow>,
): string[] {
  const lines = [
    "| issue | park | resume | judgement | outcome cursor |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.issueIdentifier)} | seq ${row.parkSequence} | ${row.resumeSequence === null ? "—" : `seq ${row.resumeSequence}`} | ${row.judgement} | ${row.outcomeSequence === null ? "—" : `seq ${row.outcomeSequence}`} |`,
    );
  }
  return lines;
}

function parkAccuracy(rows: Array<{ judgement: ParkJudgement }>): {
  trueParks: number;
  falseParks: number;
  accuracy: number | null;
} {
  const trueParks = rows.filter((r) => r.judgement === "true_park").length;
  const falseParks = rows.filter((r) => r.judgement === "false_park").length;
  const judged = trueParks + falseParks;
  return {
    trueParks,
    falseParks,
    accuracy: judged === 0 ? null : trueParks / judged,
  };
}

export function renderCalibrationDigest(
  report: CalibrationReport,
  options: RenderDigestOptions,
): string {
  const lines: string[] = [];
  lines.push("# Calibration digest — verdict↔outcome joins");
  lines.push("");
  lines.push(
    "> **Graduation evidence for SYMPH-399.** Watchdog-L2 stuck-ticket triage",
    "> is **default-disabled per product until calibrated**; this digest is the",
    "> evidence an operator reviews to decide whether to enable it for a",
    "> product. Every number below carries the dispatcher run-journal cursors",
    "> (sequences) backing it.",
  );
  lines.push("");
  lines.push(`- Journal: ${options.journalLabel}`);
  lines.push(`- Generated at: ${options.generatedAt}`);
  lines.push(
    `- Entries: ${report.journalEntryCount}${
      report.firstSequence === null
        ? ""
        : ` (cursor range seq ${report.firstSequence}–${report.lastSequence})`
    }`,
  );
  lines.push("");

  lines.push("## L2 triage precision (verdict → eventual outcome)");
  lines.push("");
  lines.push(
    "Joins each applied `triage_verdict` to the issue's first subsequent",
    "terminal event: a completed terminal tracker write counts as",
    "**recovered**, a later `failure_exhausted` counts as **re-parked**.",
    "Precision = recovered / (recovered + re-parked).",
  );
  lines.push("");
  lines.push("### By effective action");
  lines.push("");
  lines.push(...formatPrecisionTable(report.triagePrecisionByAction, "action"));
  lines.push("");
  lines.push("### By model classification");
  lines.push("");
  lines.push(
    ...formatPrecisionTable(
      report.triagePrecisionByClassification,
      "classification",
    ),
  );
  lines.push("");

  lines.push("## Novelty-park accuracy");
  lines.push("");
  lines.push(
    "Parked-as-futile (novelty parks) that succeeded immediately on operator",
    "resume are **false parks**; parks that re-parked after resume are **true",
    "parks**. Accuracy = true parks / (true + false parks). Parks the operator",
    "never resumed are listed but unjudged.",
  );
  lines.push("");
  if (report.noveltyParks.length === 0) {
    lines.push("_No novelty parks in window._");
  } else {
    const { trueParks, falseParks, accuracy } = parkAccuracy(
      report.noveltyParks,
    );
    lines.push(
      `True parks: ${trueParks} · False parks: ${falseParks} · Accuracy: ${formatPercent(accuracy)}`,
    );
    lines.push("");
    lines.push(...formatParkRows(report.noveltyParks));
  }
  lines.push("");

  lines.push("## Breaker value (true saves)");
  lines.push("");
  lines.push(
    "Issues parked while a stage circuit breaker was open. A parked issue that",
    "re-failed after operator resume is a **true save** (true_park); one that",
    "succeeded on resume is a **false save** (false_park).",
  );
  lines.push("");
  if (report.breakerWindows.length === 0) {
    lines.push("_No breaker windows in window._");
  } else {
    for (const window of report.breakerWindows) {
      const { trueParks, falseParks, accuracy } = parkAccuracy(window.saves);
      lines.push(
        `### Breaker ${escapeMarkdownCell(window.signature)} on stage ${window.stage === null ? "(none)" : escapeMarkdownCell(window.stage)} — opened seq ${window.openedSequence}${window.closedSequence === null ? " (still open)" : `, closed seq ${window.closedSequence}`}`,
      );
      lines.push("");
      lines.push(
        `Parked issues: ${window.saves.length} · True saves: ${trueParks} · False saves: ${falseParks} · Save rate: ${formatPercent(accuracy)}`,
      );
      if (window.saves.length > 0) {
        lines.push("");
        lines.push(...formatParkRows(window.saves));
      }
      lines.push("");
    }
  }

  lines.push("## Alert volume per tier vs operator actions");
  lines.push("");
  lines.push(
    "Dispatch verdict volume by disposition (gate/halt are the alerting",
    "tiers) against operator intent actions actually taken in the window.",
  );
  lines.push("");
  if (report.alertVolume.length === 0) {
    lines.push("_No dispatch verdicts in window._");
  } else {
    lines.push("| disposition | tier | count | cursor range |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of report.alertVolume) {
      lines.push(
        `| ${escapeMarkdownCell(row.disposition)} | ${row.alerting ? "alerting" : "quiet"} | ${row.count} | ${row.firstSequence === null ? "—" : `seq ${row.firstSequence}–${row.lastSequence}`} |`,
      );
    }
  }
  lines.push("");
  if (report.operatorActions.length === 0) {
    lines.push("Operator actions taken: none.");
  } else {
    lines.push("Operator actions taken:");
    lines.push("");
    for (const row of report.operatorActions) {
      lines.push(
        `- ${escapeMarkdownCell(row.verb)}: ${row.count} (${row.sequences.map((s) => `seq ${s}`).join(", ")})`,
      );
    }
  }
  lines.push("");

  lines.push("## Backlog hygiene proposal precision");
  lines.push("");
  lines.push(
    "Proposal precision joins each journaled `hygiene_proposal` to the first",
    "subsequent `hygiene_proposal_decision` for the same proposal. Operator",
    "accept/reject is calibration signal only; it does not imply issue-state",
    "mutation. Precision = accepted / (accepted + rejected).",
  );
  lines.push("");
  lines.push(
    ...formatHygieneProposalPrecisionTable(
      report.hygieneProposalPrecisionByFindingType,
    ),
  );
  lines.push("");

  lines.push("## Structural advisory precision and lifecycle stability");
  lines.push("");
  lines.push(
    "Transition-only advisory records join to the first grade by fingerprint.",
    "Partial grades count as accepted-with-member-delta. Class precision is",
    "reported separately from per-fingerprint lifecycle stability.",
  );
  lines.push("");
  lines.push(
    ...formatStructuralAdvisoryStabilityTable(
      report.structuralAdvisoryStability,
    ),
  );
  lines.push("");
  lines.push(
    ...formatStructuralAdvisoryPrecisionTable(
      report.structuralAdvisoryPrecisionByClass,
    ),
  );
  lines.push("");
  if (report.orphanStructuralAdvisoryGrades.length === 0) {
    lines.push("Orphan grades: none.");
  } else {
    lines.push(
      `Orphan grades: ${report.orphanStructuralAdvisoryGrades.length} (${report.orphanStructuralAdvisoryGrades.map((row) => `${escapeMarkdownCell(row.advisoryId)} seq ${row.gradeSequence}`).join(", ")}).`,
    );
  }
  lines.push("");

  lines.push("## Queue baseline (week zero)");
  lines.push("");
  lines.push(
    "FIFO-control samples recorded before queue-triage lanes gain authority.",
    "Each row keeps the comparator version, considered issue ids, dispatch",
    "picks, manual jumps/reorders, quiet-death and urgent-reopen outcomes,",
    "plus spend/delivery outcomes per delivered ticket.",
  );
  lines.push("");
  if (report.queueBaseline.length === 0) {
    lines.push("_No queue baseline samples in window._");
  } else {
    lines.push(
      "| seq | comparator | considered | picks | manual | quiet-death | urgent-reopen | delivery |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const sample of report.queueBaseline) {
      lines.push(
        `| seq ${sample.sequence} | ${escapeMarkdownCell(sample.comparatorVersion)} | ${sample.consideredIssueIds.length} | ${sample.dispatchPicks.length} | ${sample.manualJumpsReorders.length} | ${sample.quietDeathOutcomes.length} | ${sample.urgentReopenOutcomes.length} | ${sample.deliveryOutcomes.length} |`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}
