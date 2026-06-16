import type {
  DispatcherLease,
  DispatcherRunJournalEntry,
} from "../domain/model.js";

export const MERGE_CANDIDATE_SCHEMA_VERSION = 1;

export const MERGE_ACTUATION_ACTIONS = [
  "mark_ready",
  "enqueue",
  "poll",
  "tracker_done",
  "stale",
  "timeout",
  "failed",
  "completed",
  "recovered",
] as const;

export type MergeActuationAction = (typeof MERGE_ACTUATION_ACTIONS)[number];
type SideEffectActuationAction = Exclude<
  MergeActuationAction,
  "failed" | "completed" | "recovered"
>;

export type MergeCandidateStatus =
  | "candidate"
  | "superseded"
  | "stale"
  | "ready_marked"
  | "merge_queue_pending"
  | "merged"
  | "blocked";

export interface MergeCandidateRecord {
  candidateId: string;
  issueId: string;
  issueIdentifier: string;
  repo: string;
  prNumber: number;
  prUrl: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  reviewedHeadSha: string;
  reviewResultPath: string;
  councilVerdict: "pass";
  decorrelationMergeEligible: true;
  round: number;
  stage: string | null;
  actorKind: string | null;
  actorId: string | null;
  ownerId: string | null;
  leaseId: string | null;
  status: MergeCandidateStatus;
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
  lastActuation: MergeActuationAction | null;
  mergeCommit: string | null;
  mergedAt: string | null;
  blockedReason: string | null;
  cursorRange: {
    firstSequence: number;
    lastSequence: number;
  };
}

export interface MergeActuatorLiveState {
  repo: string;
  prNumber: number;
  prUrl?: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeStateStatus: string | null;
  mergeable: string | null;
  reviewDecision: string | null;
  headSha: string;
  baseRef: string;
  baseSha: string;
  requiredChecks: Array<{ name: string; status: "pass" | "fail" | "pending" }>;
  requiresGithubReview: boolean;
  mergeQueueRequired: boolean;
  mergedAt: string | null;
  mergeCommit: string | null;
}

export interface MergeActuatorDecision {
  action:
    | "noop"
    | "mark_ready"
    | "enqueue"
    | "poll"
    | "tracker_done"
    | "stale"
    | "timeout"
    | "blocked";
  reason: string;
  blockers: string[];
  sideEffectKey: string | null;
}

export interface MergeActuationJournalDraft
  extends Omit<DispatcherRunJournalEntry, "sequence"> {}

export interface MergeActuatorSideEffects {
  markReady(candidate: MergeCandidateRecord): Promise<void>;
  enqueue(candidate: MergeCandidateRecord): Promise<void>;
  writeTrackerDone(candidate: MergeCandidateRecord): Promise<void>;
}

export interface RunMergeActuatorResult {
  decision: MergeActuatorDecision;
  journalEntry: DispatcherRunJournalEntry | null;
  failureEntry: DispatcherRunJournalEntry | null;
  recoveryEntry: DispatcherRunJournalEntry | null;
  sideEffect: "none" | "mark_ready" | "enqueue" | "tracker_done";
  error: string | null;
}

export function buildMergeCandidateEntryFromReviewGate(
  entry: DispatcherRunJournalEntry,
): Omit<DispatcherRunJournalEntry, "sequence"> | null {
  if (entry.kind !== "review_gate_result") {
    return null;
  }
  if (stringField(entry.metadata.gate_verdict) !== "pass") {
    return null;
  }
  if (booleanField(entry.metadata.decorrelation_merge_eligible) !== true) {
    return null;
  }

  const repo = stringField(entry.metadata.repo);
  const prNumber = numberField(entry.metadata.pr_number);
  const baseRef = stringField(entry.metadata.base_ref);
  const baseSha = stringField(entry.metadata.base_sha);
  const headRef = stringField(entry.metadata.head_ref);
  const headSha = stringField(entry.metadata.head_sha);
  const reviewedHeadSha =
    stringField(entry.metadata.reviewed_head_sha) ?? headSha;
  const reviewResultPath = stringField(entry.metadata.review_result_path);
  const round = numberField(entry.metadata.round);

  if (
    repo === null ||
    prNumber === null ||
    baseRef === null ||
    baseSha === null ||
    headRef === null ||
    headSha === null ||
    reviewedHeadSha === null ||
    reviewResultPath === null ||
    round === null
  ) {
    return null;
  }

  const candidateId = mergeCandidateId({
    issueId: entry.issueId,
    repo,
    prNumber,
    reviewedHeadSha,
    round,
  });
  const actor = recordField(entry.metadata.actor);

  return {
    idempotencyKey: `merge_candidate:${candidateId}`,
    timestamp: entry.timestamp,
    kind: "merge_candidate",
    issueId: entry.issueId,
    issueIdentifier: entry.issueIdentifier,
    operation: "gate",
    stage: "merge",
    attempt: entry.attempt,
    ownerId: entry.ownerId,
    lease: entry.lease,
    summary: `Merge candidate ${candidateId} recorded for ${entry.issueIdentifier}.`,
    metadata: {
      schema_version: MERGE_CANDIDATE_SCHEMA_VERSION,
      candidate_id: candidateId,
      source_review_sequence: entry.sequence > 0 ? entry.sequence : undefined,
      source_review_idempotency_key: entry.idempotencyKey,
      repo,
      pr_number: prNumber,
      pr_url: `https://github.com/${repo}/pull/${prNumber}`,
      base_ref: baseRef,
      base_sha: baseSha,
      head_ref: headRef,
      head_sha: headSha,
      reviewed_head_sha: reviewedHeadSha,
      review_result_path: reviewResultPath,
      council_verdict: "pass",
      decorrelation_merge_eligible: true,
      round,
      actor_kind: stringField(actor?.kind),
      actor_id: stringField(actor?.id),
    },
  };
}

export function reduceMergeCandidates(
  entries: readonly DispatcherRunJournalEntry[],
): Record<string, MergeCandidateRecord> {
  const byIssue = new Map<string, MergeCandidateRecord[]>();
  for (const entry of entries) {
    if (entry.kind === "merge_candidate") {
      const record = candidateFromEntry(entry);
      if (record === null) {
        continue;
      }
      const records = byIssue.get(record.issueId) ?? [];
      records.push(record);
      byIssue.set(record.issueId, records);
      continue;
    }
    if (entry.kind !== "merge_actuation") {
      continue;
    }
    const candidateId = stringField(entry.metadata.candidate_id);
    if (candidateId === null) {
      continue;
    }
    for (const records of byIssue.values()) {
      const record = records.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      if (record !== undefined) {
        applyActuation(record, entry);
      }
    }
  }

  const reduced: Record<string, MergeCandidateRecord> = {};
  for (const [issueId, records] of byIssue) {
    const sorted = records.sort(compareCandidateFreshness);
    const latest = sorted.at(-1);
    if (latest === undefined) {
      continue;
    }
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      if (current === undefined) {
        continue;
      }
      sorted[index] = {
        ...current,
        status: current.status === "candidate" ? "superseded" : current.status,
        supersededBy: latest.candidateId,
      };
    }
    reduced[issueId] = latest;
  }
  return reduced;
}

export function decideMergeActuation(input: {
  candidate: MergeCandidateRecord;
  live: MergeActuatorLiveState;
  lease: DispatcherLease | null;
  ownerId: string;
  nowMs: number;
  enqueuedAtMs: number | null;
  maxWaitMs: number;
  completedSideEffectKeys: ReadonlySet<string>;
}): MergeActuatorDecision {
  const leaseDecision = validateLease(
    input.lease,
    input.candidate,
    input.ownerId,
  );
  if (leaseDecision !== null) {
    return leaseDecision;
  }

  if (input.live.state === "MERGED") {
    const blocker = firstLiveIdentityBlocker(input.candidate, input.live);
    if (blocker !== null) {
      return {
        action: "stale",
        reason: blocker,
        blockers: [blocker],
        sideEffectKey: mergeActuationKey(input.candidate, "stale"),
      };
    }
    if (input.live.mergedAt === null || input.live.mergeCommit === null) {
      return {
        action: "blocked",
        reason: "merged_without_durable_proof",
        blockers: ["merged_without_durable_proof"],
        sideEffectKey: null,
      };
    }
    return {
      action: "tracker_done",
      reason: "durable_merge_proof",
      blockers: [],
      sideEffectKey: mergeActuationKey(input.candidate, "tracker_done"),
    };
  }

  if (input.live.state !== "OPEN") {
    return {
      action: "stale",
      reason: "pr_closed_unmerged",
      blockers: ["pr_closed_unmerged"],
      sideEffectKey: mergeActuationKey(input.candidate, "stale"),
    };
  }

  const blocker = firstLiveBlocker(input.candidate, input.live);
  if (blocker !== null) {
    return {
      action: "stale",
      reason: blocker,
      blockers: [blocker],
      sideEffectKey: mergeActuationKey(input.candidate, "stale"),
    };
  }

  const failingChecks = input.live.requiredChecks
    .filter((check) => check.status === "fail")
    .map((check) => check.name);
  const pendingChecks = input.live.requiredChecks
    .filter((check) => check.status === "pending")
    .map((check) => check.name);
  if (failingChecks.length > 0) {
    return {
      action: "blocked",
      reason: "failing_checks",
      blockers: failingChecks,
      sideEffectKey: null,
    };
  }
  if (
    pendingChecks.length > 0 &&
    input.candidate.status !== "merge_queue_pending"
  ) {
    return {
      action: "blocked",
      reason: "pending_checks",
      blockers: pendingChecks,
      sideEffectKey: null,
    };
  }
  if (
    input.live.requiresGithubReview &&
    input.live.reviewDecision !== "APPROVED"
  ) {
    return {
      action: "blocked",
      reason: "missing_required_review",
      blockers: ["missing_required_review"],
      sideEffectKey: null,
    };
  }
  if (input.live.isDraft) {
    return sideEffectDecision(
      input.candidate,
      "mark_ready",
      input.completedSideEffectKeys,
      "draft_pr",
    );
  }
  if (
    input.candidate.status !== "merge_queue_pending" &&
    !hasGreenMergeability(input.live)
  ) {
    if (hasExceededCandidateWait(input)) {
      return {
        action: "blocked",
        reason: "mergeability_unknown",
        blockers: ["mergeability_unknown"],
        sideEffectKey: null,
      };
    }
    return {
      action: "poll",
      reason: "mergeability_unknown",
      blockers: ["mergeability_unknown"],
      sideEffectKey: mergeActuationKey(input.candidate, "poll"),
    };
  }
  if (input.candidate.status !== "merge_queue_pending") {
    return sideEffectDecision(
      input.candidate,
      "enqueue",
      input.completedSideEffectKeys,
      input.live.mergeQueueRequired ? "merge_queue_required" : "auto_merge",
    );
  }
  if (
    input.enqueuedAtMs !== null &&
    input.nowMs - input.enqueuedAtMs > input.maxWaitMs
  ) {
    return sideEffectDecision(
      input.candidate,
      "timeout",
      input.completedSideEffectKeys,
      "merge_queue_max_wait_exceeded",
    );
  }
  return sideEffectDecision(
    input.candidate,
    "poll",
    input.completedSideEffectKeys,
    "merge_queue_pending",
  );
}

export function buildMergeActuationEntry(input: {
  candidate: MergeCandidateRecord;
  action: MergeActuationAction;
  subjectAction?: SideEffectActuationAction;
  timestamp: string;
  ownerId: string;
  lease: DispatcherLease;
  live?: Partial<MergeActuatorLiveState>;
  reason?: string;
}): MergeActuationJournalDraft {
  const key =
    input.action === "poll"
      ? `${mergeActuationKey(input.candidate, input.action)}:${input.lease.leaseId}`
      : mergeActuationKey(input.candidate, input.action, input.subjectAction);
  return {
    idempotencyKey: key,
    timestamp: input.timestamp,
    kind: "merge_actuation",
    issueId: input.candidate.issueId,
    issueIdentifier: input.candidate.issueIdentifier,
    operation: "dispatcher",
    stage: "merge",
    attempt: null,
    ownerId: input.ownerId,
    lease: input.lease,
    summary: `Merge actuator ${input.action} for ${input.candidate.issueIdentifier}.`,
    metadata: {
      schema_version: MERGE_CANDIDATE_SCHEMA_VERSION,
      candidate_id: input.candidate.candidateId,
      action: input.action,
      subject_action: input.subjectAction,
      reason: input.reason,
      repo: input.candidate.repo,
      pr_number: input.candidate.prNumber,
      head_sha: input.live?.headSha,
      merged_at: input.live?.mergedAt,
      merge_commit: input.live?.mergeCommit,
    },
  };
}

export async function runMergeActuator(input: {
  candidate: MergeCandidateRecord;
  live: MergeActuatorLiveState;
  lease: DispatcherLease | null;
  ownerId: string;
  now: Date;
  enqueuedAtMs: number | null;
  maxWaitMs: number;
  completedSideEffectKeys: ReadonlySet<string>;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
  sideEffects: MergeActuatorSideEffects;
}): Promise<RunMergeActuatorResult> {
  const decision = decideMergeActuation({
    candidate: input.candidate,
    live: input.live,
    lease: input.lease,
    ownerId: input.ownerId,
    nowMs: input.now.getTime(),
    enqueuedAtMs: input.enqueuedAtMs,
    maxWaitMs: input.maxWaitMs,
    completedSideEffectKeys: input.completedSideEffectKeys,
  });

  if (decision.sideEffectKey === null || input.lease === null) {
    return {
      decision,
      journalEntry: null,
      failureEntry: null,
      recoveryEntry: null,
      sideEffect: "none",
      error: null,
    };
  }

  const action = decisionToActuationAction(decision.action);
  if (action === null) {
    return {
      decision,
      journalEntry: null,
      failureEntry: null,
      recoveryEntry: null,
      sideEffect: "none",
      error: null,
    };
  }

  const journalEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action,
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      live: input.live,
      reason: decision.reason,
    }),
  );
  const needsRecoveryEntry = isRedrivingFailedAction(input.candidate, action);

  try {
    if (decision.action === "mark_ready") {
      await input.sideEffects.markReady(input.candidate);
      await appendCompletionEntry({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
      });
      const recoveryEntry = await appendRecoveryEntryIfNeeded({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
        needsRecoveryEntry,
      });
      return {
        decision,
        journalEntry,
        failureEntry: null,
        recoveryEntry,
        sideEffect: "mark_ready",
        error: null,
      };
    }
    if (decision.action === "enqueue") {
      await input.sideEffects.enqueue(input.candidate);
      await appendCompletionEntry({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
      });
      const recoveryEntry = await appendRecoveryEntryIfNeeded({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
        needsRecoveryEntry,
      });
      return {
        decision,
        journalEntry,
        failureEntry: null,
        recoveryEntry,
        sideEffect: "enqueue",
        error: null,
      };
    }
    if (decision.action === "tracker_done") {
      await input.sideEffects.writeTrackerDone(input.candidate);
      await appendCompletionEntry({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
      });
      const recoveryEntry = await appendRecoveryEntryIfNeeded({
        appendActuation: input.appendActuation,
        candidate: input.candidate,
        action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
        needsRecoveryEntry,
      });
      return {
        decision,
        journalEntry,
        failureEntry: null,
        recoveryEntry,
        sideEffect: "tracker_done",
        error: null,
      };
    }
  } catch (error) {
    const errorMessage = formatError(error);
    const failureEntry = await input.appendActuation(
      buildMergeActuationEntry({
        candidate: input.candidate,
        action: "failed",
        subjectAction: action,
        timestamp: input.now.toISOString(),
        ownerId: input.ownerId,
        lease: input.lease,
        live: input.live,
        reason: `${decision.action}_failed:${errorMessage}`,
      }),
    );
    return {
      decision,
      journalEntry,
      failureEntry,
      recoveryEntry: null,
      sideEffect: "none",
      error: errorMessage,
    };
  }

  return {
    decision,
    journalEntry,
    failureEntry: null,
    recoveryEntry: null,
    sideEffect: "none",
    error: null,
  };
}

function candidateFromEntry(
  entry: DispatcherRunJournalEntry,
): MergeCandidateRecord | null {
  const metadata = entry.metadata;
  const candidateId = stringField(metadata.candidate_id);
  const repo = stringField(metadata.repo);
  const prNumber = numberField(metadata.pr_number);
  const baseRef = stringField(metadata.base_ref);
  const baseSha = stringField(metadata.base_sha);
  const headRef = stringField(metadata.head_ref);
  const headSha = stringField(metadata.head_sha);
  const reviewedHeadSha = stringField(metadata.reviewed_head_sha);
  const reviewResultPath = stringField(metadata.review_result_path);
  const round = numberField(metadata.round);
  if (
    candidateId === null ||
    repo === null ||
    prNumber === null ||
    baseRef === null ||
    baseSha === null ||
    headRef === null ||
    headSha === null ||
    reviewedHeadSha === null ||
    reviewResultPath === null ||
    round === null ||
    stringField(metadata.council_verdict) !== "pass" ||
    booleanField(metadata.decorrelation_merge_eligible) !== true
  ) {
    return null;
  }
  return {
    candidateId,
    issueId: entry.issueId,
    issueIdentifier: entry.issueIdentifier,
    repo,
    prNumber,
    prUrl: stringField(metadata.pr_url),
    baseRef,
    baseSha,
    headRef,
    headSha,
    reviewedHeadSha,
    reviewResultPath,
    councilVerdict: "pass",
    decorrelationMergeEligible: true,
    round,
    stage: entry.stage,
    actorKind: stringField(metadata.actor_kind),
    actorId: stringField(metadata.actor_id),
    ownerId: entry.ownerId,
    leaseId: entry.lease?.leaseId ?? null,
    status: "candidate",
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
    supersededBy: null,
    lastActuation: null,
    mergeCommit: null,
    mergedAt: null,
    blockedReason: null,
    cursorRange: {
      firstSequence: entry.sequence,
      lastSequence: entry.sequence,
    },
  };
}

function applyActuation(
  record: MergeCandidateRecord,
  entry: DispatcherRunJournalEntry,
): void {
  const action = mergeActuationAction(entry.metadata.action);
  if (action === null) {
    return;
  }
  record.updatedAt = entry.timestamp;
  record.lastActuation = action;
  record.cursorRange.lastSequence = entry.sequence;
  if (action === "poll") {
    if (stringField(entry.metadata.reason) === "mergeability_unknown") {
      return;
    }
    record.status = "merge_queue_pending";
  } else if (action === "stale") {
    record.status = "stale";
    record.blockedReason = stringField(entry.metadata.reason) ?? "stale";
  } else if (action === "timeout") {
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_queue_max_wait_exceeded";
  } else if (action === "failed") {
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_actuation_failed";
  } else if (action === "completed" || action === "recovered") {
    applyRecoveredActuation(record, entry);
  }
}

function applyRecoveredActuation(
  record: MergeCandidateRecord,
  entry: DispatcherRunJournalEntry,
): void {
  const subjectAction = mergeActuationAction(entry.metadata.subject_action);
  if (
    subjectAction === null ||
    subjectAction === "failed" ||
    subjectAction === "completed" ||
    subjectAction === "recovered"
  ) {
    return;
  }
  record.blockedReason = null;
  if (subjectAction === "mark_ready") {
    record.status = "ready_marked";
  } else if (subjectAction === "enqueue" || subjectAction === "poll") {
    record.status = "merge_queue_pending";
  } else if (subjectAction === "tracker_done") {
    record.status = "merged";
    record.mergedAt = stringField(entry.metadata.merged_at);
    record.mergeCommit = stringField(entry.metadata.merge_commit);
  } else if (subjectAction === "stale") {
    record.status = "stale";
  } else if (subjectAction === "timeout") {
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_queue_max_wait_exceeded";
  }
}

function firstLiveBlocker(
  candidate: MergeCandidateRecord,
  live: MergeActuatorLiveState,
): string | null {
  const identityBlocker = firstLiveIdentityBlocker(candidate, live);
  if (identityBlocker !== null) {
    return identityBlocker;
  }
  if (live.mergeStateStatus === "DIRTY" || live.mergeable === "CONFLICTING") {
    return "merge_conflict";
  }
  if (
    live.mergeStateStatus === "BEHIND" &&
    candidate.status !== "merge_queue_pending"
  ) {
    return "behind_base";
  }
  return null;
}

function firstLiveIdentityBlocker(
  candidate: MergeCandidateRecord,
  live: MergeActuatorLiveState,
): string | null {
  if (live.repo !== candidate.repo || live.prNumber !== candidate.prNumber) {
    return "wrong_pr";
  }
  if (live.headSha !== candidate.reviewedHeadSha) {
    return "stale_reviewed_head";
  }
  if (live.baseRef !== candidate.baseRef) {
    return "base_ref_changed";
  }
  return null;
}

function hasGreenMergeability(live: MergeActuatorLiveState): boolean {
  return live.mergeable === "MERGEABLE" && live.mergeStateStatus !== "UNKNOWN";
}

function hasExceededCandidateWait(input: {
  candidate: MergeCandidateRecord;
  nowMs: number;
  maxWaitMs: number;
}): boolean {
  const createdAtMs = Date.parse(input.candidate.createdAt);
  return (
    !Number.isNaN(createdAtMs) && input.nowMs - createdAtMs > input.maxWaitMs
  );
}

function validateLease(
  lease: DispatcherLease | null,
  candidate: MergeCandidateRecord,
  ownerId: string,
): MergeActuatorDecision | null {
  if (lease === null) {
    return {
      action: "noop",
      reason: "missing_live_issue_lease",
      blockers: ["missing_live_issue_lease"],
      sideEffectKey: null,
    };
  }
  if (
    lease.issueId !== candidate.issueId ||
    lease.ownerId !== ownerId ||
    lease.status !== "active"
  ) {
    return {
      action: "noop",
      reason: "foreign_or_inactive_lease",
      blockers: ["foreign_or_inactive_lease"],
      sideEffectKey: null,
    };
  }
  return null;
}

function sideEffectDecision(
  candidate: MergeCandidateRecord,
  action: SideEffectActuationAction,
  completedSideEffectKeys: ReadonlySet<string>,
  reason: string,
): MergeActuatorDecision {
  const sideEffectKey = mergeActuationKey(candidate, action);
  const canRedriveFailedAction = isRedrivingFailedAction(candidate, action);
  if (completedSideEffectKeys.has(sideEffectKey) && !canRedriveFailedAction) {
    return {
      action: "noop",
      reason: "side_effect_already_journaled",
      blockers: [],
      sideEffectKey,
    };
  }
  return { action, reason, blockers: [], sideEffectKey };
}

function compareCandidateFreshness(
  left: MergeCandidateRecord,
  right: MergeCandidateRecord,
): number {
  const roundDelta = left.round - right.round;
  if (roundDelta !== 0) {
    return roundDelta;
  }
  return left.createdAt.localeCompare(right.createdAt, "en");
}

function mergeCandidateId(input: {
  issueId: string;
  repo: string;
  prNumber: number;
  reviewedHeadSha: string;
  round: number;
}): string {
  return [
    input.issueId,
    input.repo,
    `pr-${input.prNumber}`,
    `round-${input.round}`,
    input.reviewedHeadSha,
  ]
    .map((part) => String(part).replace(/[^a-z0-9_.-]+/gi, "-"))
    .join(":");
}

function mergeActuationKey(
  candidate: MergeCandidateRecord,
  action: MergeActuationAction,
  subjectAction?: SideEffectActuationAction,
): string {
  if (
    (action === "failed" || action === "completed" || action === "recovered") &&
    subjectAction !== undefined
  ) {
    return `merge_actuation:${candidate.candidateId}:${action}:${subjectAction}`;
  }
  return `merge_actuation:${candidate.candidateId}:${action}`;
}

function mergeActuationAction(value: unknown): MergeActuationAction | null {
  return MERGE_ACTUATION_ACTIONS.includes(value as MergeActuationAction)
    ? (value as MergeActuationAction)
    : null;
}

function decisionToActuationAction(
  action: MergeActuatorDecision["action"],
): SideEffectActuationAction | null {
  if (action === "blocked" || action === "noop") {
    return null;
  }
  return action;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRedrivingFailedAction(
  candidate: MergeCandidateRecord,
  action: SideEffectActuationAction,
): boolean {
  return (
    candidate.lastActuation === "failed" &&
    candidate.blockedReason?.startsWith(`${action}_failed:`) === true
  );
}

async function appendCompletionEntry(input: {
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
  candidate: MergeCandidateRecord;
  action: SideEffectActuationAction;
  timestamp: string;
  ownerId: string;
  lease: DispatcherLease;
  live: MergeActuatorLiveState;
}): Promise<DispatcherRunJournalEntry> {
  return input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "completed",
      subjectAction: input.action,
      timestamp: input.timestamp,
      ownerId: input.ownerId,
      lease: input.lease,
      live: input.live,
      reason: `${input.action}_completed`,
    }),
  );
}

async function appendRecoveryEntryIfNeeded(input: {
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
  candidate: MergeCandidateRecord;
  action: SideEffectActuationAction;
  timestamp: string;
  ownerId: string;
  lease: DispatcherLease;
  live: MergeActuatorLiveState;
  needsRecoveryEntry: boolean;
}): Promise<DispatcherRunJournalEntry | null> {
  if (!input.needsRecoveryEntry) {
    return null;
  }
  return input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "recovered",
      subjectAction: input.action,
      timestamp: input.timestamp,
      ownerId: input.ownerId,
      lease: input.lease,
      live: input.live,
      reason: `${input.action}_recovered`,
    }),
  );
}
