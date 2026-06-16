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
  "live_state_failed",
  "parked",
] as const;

export type MergeActuationAction = (typeof MERGE_ACTUATION_ACTIONS)[number];
type SideEffectActuationAction = Exclude<
  MergeActuationAction,
  "failed" | "completed" | "recovered" | "live_state_failed" | "parked"
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

/**
 * Configured ceilings for the bounded merge-actuator recovery (SYMPH-746).
 * Both counts are derived from the durable journal, never process memory, so
 * they survive restart/replay.
 */
export interface MergeActuatorRecoveryLimits {
  /** Max live-state fetch failures (throw + null/incomplete) before parking. */
  maxLiveStateFailures: number;
  /** Max post-decision side-effect failures (e.g. tracker_done) before parking. */
  maxSideEffectFailures: number;
}

/** Operator-visible blocker recorded when a candidate parks after exhaustion. */
export interface MergeActuatorBlocker {
  candidateId: string;
  prNumber: number;
  reviewedHeadSha: string;
  reason: string;
  attempts: number;
  lastErrorOrStateSummary: string;
  nextOperatorAction: string;
}

/**
 * Outcome of a single bounded merge-actuator cycle:
 * - `actuated`: the actuator ran (or no-oped) against usable live state.
 * - `retry`: a recoverable failure occurred and countable evidence was journaled.
 * - `parked`: the configured ceiling was reached; a durable blocker was journaled.
 */
export type MergeActuatorCycleResult =
  | { outcome: "actuated"; run: RunMergeActuatorResult }
  | {
      outcome: "retry";
      reason: string;
      attempts: number;
      evidenceEntry: DispatcherRunJournalEntry;
    }
  | {
      outcome: "parked";
      blocker: MergeActuatorBlocker;
      parkEntry: DispatcherRunJournalEntry;
    };

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
    if (input.live.mergedAt === null || input.live.mergeCommit === null) {
      return {
        action: "blocked",
        reason: "merged_without_durable_proof",
        blockers: ["merged_without_durable_proof"],
        sideEffectKey: null,
      };
    }
    return sideEffectDecision(
      input.candidate,
      "tracker_done",
      input.completedSideEffectKeys,
      "durable_merge_proof",
    );
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
  // A candidate is "waiting on the queue" once it is confirmed pending or holds
  // an unconfirmed enqueue intent. While waiting, pending checks (e.g. the merge
  // queue check itself) are expected and must not re-block the candidate.
  const hasUnconfirmedEnqueue = isUnconfirmedEnqueueIntent(input.candidate);
  const isWaitingOnQueue =
    input.candidate.status === "merge_queue_pending" || hasUnconfirmedEnqueue;
  if (failingChecks.length > 0) {
    return {
      action: "blocked",
      reason: "failing_checks",
      blockers: failingChecks,
      sideEffectKey: null,
    };
  }
  if (
    isWaitingOnQueue &&
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
  if (pendingChecks.length > 0 && !isWaitingOnQueue) {
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
  if (hasUnconfirmedEnqueue) {
    // Enqueue was intended but not yet confirmed (e.g. a crash before the
    // completion entry). Poll for confirmation rather than re-enqueuing; the
    // bounded queue wait above will eventually time out and park.
    return {
      action: "poll",
      reason:
        pendingChecks.length > 0
          ? "merge_queue_pending"
          : "enqueue_status_uncertain",
      blockers: pendingChecks,
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
  metadata?: Record<string, unknown>;
}): MergeActuationJournalDraft {
  const baseKey = mergeActuationKey(
    input.candidate,
    input.action,
    input.subjectAction,
  );
  // Poll, failed, and live-state-failure entries are countable progress
  // evidence: one durable, replay-stable entry per dispatch cycle, made unique
  // by the lease id so the journal does not collapse them into one row.
  const key =
    input.action === "poll" ||
    input.action === "failed" ||
    input.action === "live_state_failed"
      ? `${baseKey}:${input.lease.leaseId}`
      : baseKey;
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
      reviewed_head_sha: input.candidate.reviewedHeadSha,
      head_sha: input.live?.headSha,
      merged_at: input.live?.mergedAt,
      merge_commit: input.live?.mergeCommit,
      ...input.metadata,
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
      // Completion evidence: a raw enqueue intent must not advance the candidate
      // into the queue until the side effect actually succeeds (SYMPH-746).
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

/**
 * Run one bounded, replay-stable merge-actuator cycle (SYMPH-746).
 *
 * Wraps {@link runMergeActuator} with the full recovery envelope: it fetches
 * live state and treats every non-decision failure path — a fetch that throws,
 * a fetch that returns null/incomplete state, and a post-decision side-effect
 * failure (notably `tracker_done`) — as countable progress evidence in the
 * durable journal. Attempt counts are derived from that journal on every cycle
 * (never from process memory), so they are restored after restart/replay, and
 * once a configured ceiling is reached the candidate parks with an
 * operator-visible blocker instead of retrying forever.
 */
export async function runMergeActuatorCycle(input: {
  candidate: MergeCandidateRecord;
  journal: readonly DispatcherRunJournalEntry[];
  lease: DispatcherLease | null;
  ownerId: string;
  now: Date;
  enqueuedAtMs: number | null;
  maxWaitMs: number;
  limits: MergeActuatorRecoveryLimits;
  fetchLiveState: () => Promise<MergeActuatorLiveState | null>;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
  sideEffects: MergeActuatorSideEffects;
}): Promise<MergeActuatorCycleResult> {
  if (input.lease === null) {
    // Without a live, same-owner lease the actuator cannot act or journal
    // countable evidence; defer to the pure actuator's no-op semantics.
    return {
      outcome: "actuated",
      run: {
        decision: {
          action: "noop",
          reason: "missing_live_issue_lease",
          blockers: ["missing_live_issue_lease"],
          sideEffectKey: null,
        },
        journalEntry: null,
        failureEntry: null,
        recoveryEntry: null,
        sideEffect: "none",
        error: null,
      },
    };
  }
  const lease = input.lease;

  // Terminal: a candidate that already parked stays parked. Re-deriving the
  // blocker from the durable entry keeps re-invocation idempotent across replay.
  const existingPark = findParkEntry(
    input.journal,
    input.candidate.candidateId,
  );
  if (existingPark !== null) {
    return {
      outcome: "parked",
      blocker: parkBlockerFromEntry(existingPark),
      parkEntry: existingPark,
    };
  }

  let live: MergeActuatorLiveState | null;
  try {
    live = await input.fetchLiveState();
  } catch (error) {
    return recordLiveStateFailure({
      candidate: input.candidate,
      journal: input.journal,
      lease,
      ownerId: input.ownerId,
      now: input.now,
      limits: input.limits,
      reason: "live_state_throw",
      summary: formatError(error),
      appendActuation: input.appendActuation,
    });
  }
  if (live === null || !isUsableLiveState(live)) {
    // Treat a non-null but incomplete/unusable live state the same as null, so
    // an actuator decision never runs on malformed input and throws outside the
    // recovery envelope (SYMPH-746, path 2: "null, incomplete, or otherwise
    // unusable state").
    return recordLiveStateFailure({
      candidate: input.candidate,
      journal: input.journal,
      lease,
      ownerId: input.ownerId,
      now: input.now,
      limits: input.limits,
      reason: "live_state_incomplete",
      summary: "live state provider returned null or unusable state",
      appendActuation: input.appendActuation,
    });
  }

  // Derive the enqueue/queue wait start from the durable journal when the caller
  // does not supply it, so an unconfirmed enqueue intent stays bounded across
  // restart/replay instead of polling forever — the journal, not process memory,
  // is the source of truth for the wait (SYMPH-746, path 4).
  const effectiveEnqueuedAtMs =
    input.enqueuedAtMs ??
    enqueueIntentStartMs(input.journal, input.candidate.candidateId);

  const run = await runMergeActuator({
    candidate: input.candidate,
    live,
    lease,
    ownerId: input.ownerId,
    now: input.now,
    enqueuedAtMs: effectiveEnqueuedAtMs,
    maxWaitMs: input.maxWaitMs,
    completedSideEffectKeys: completedSideEffectKeysFromJournal(input.journal),
    appendActuation: input.appendActuation,
    sideEffects: input.sideEffects,
  });

  if (run.error !== null && run.failureEntry !== null) {
    const subjectAction = stringField(run.failureEntry.metadata.subject_action);
    const attempts = countSideEffectFailures(
      input.journal,
      input.candidate.candidateId,
      subjectAction,
      run.failureEntry,
    );
    const reason = `${subjectAction ?? "side_effect"}_side_effect_failed`;
    if (attempts >= input.limits.maxSideEffectFailures) {
      return parkCandidate({
        candidate: input.candidate,
        lease,
        ownerId: input.ownerId,
        now: input.now,
        live,
        reason,
        attempts,
        lastErrorOrStateSummary: run.error,
        nextOperatorAction: sideEffectNextOperatorAction(
          subjectAction,
          input.candidate,
        ),
        appendActuation: input.appendActuation,
      });
    }
    return {
      outcome: "retry",
      reason,
      attempts,
      evidenceEntry: run.failureEntry,
    };
  }

  return { outcome: "actuated", run };
}

async function recordLiveStateFailure(input: {
  candidate: MergeCandidateRecord;
  journal: readonly DispatcherRunJournalEntry[];
  lease: DispatcherLease;
  ownerId: string;
  now: Date;
  limits: MergeActuatorRecoveryLimits;
  reason: "live_state_throw" | "live_state_incomplete";
  summary: string;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
}): Promise<MergeActuatorCycleResult> {
  const evidenceEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "live_state_failed",
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      reason: input.reason,
      metadata: { last_error: input.summary },
    }),
  );
  const attempts = countLiveStateFailures(
    input.journal,
    input.candidate.candidateId,
    evidenceEntry,
  );
  if (attempts >= input.limits.maxLiveStateFailures) {
    return parkCandidate({
      candidate: input.candidate,
      lease: input.lease,
      ownerId: input.ownerId,
      now: input.now,
      live: null,
      // Throw and null/incomplete share one umbrella ceiling; the distinct
      // per-failure reason is preserved on each evidence entry.
      reason: "live_state_unavailable",
      attempts,
      lastErrorOrStateSummary: input.summary,
      nextOperatorAction: liveStateNextOperatorAction(input.candidate),
      appendActuation: input.appendActuation,
    });
  }
  return { outcome: "retry", reason: input.reason, attempts, evidenceEntry };
}

async function parkCandidate(input: {
  candidate: MergeCandidateRecord;
  lease: DispatcherLease;
  ownerId: string;
  now: Date;
  live: MergeActuatorLiveState | null;
  reason: string;
  attempts: number;
  lastErrorOrStateSummary: string;
  nextOperatorAction: string;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
}): Promise<MergeActuatorCycleResult> {
  const blocker: MergeActuatorBlocker = {
    candidateId: input.candidate.candidateId,
    prNumber: input.candidate.prNumber,
    reviewedHeadSha: input.candidate.reviewedHeadSha,
    reason: input.reason,
    attempts: input.attempts,
    lastErrorOrStateSummary: input.lastErrorOrStateSummary,
    nextOperatorAction: input.nextOperatorAction,
  };
  const parkEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "parked",
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      ...(input.live !== null ? { live: input.live } : {}),
      reason: input.reason,
      metadata: { blocker, attempts: input.attempts },
    }),
  );
  return { outcome: "parked", blocker, parkEntry };
}

function countLiveStateFailures(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
  appended: DispatcherRunJournalEntry,
): number {
  const keys = new Set<string>();
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.action) === "live_state_failed" &&
      stringField(entry.metadata.candidate_id) === candidateId
    ) {
      keys.add(entry.idempotencyKey);
    }
  }
  keys.add(appended.idempotencyKey);
  return keys.size;
}

function countSideEffectFailures(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
  subjectAction: string | null,
  appended: DispatcherRunJournalEntry,
): number {
  const keys = new Set<string>();
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.action) === "failed" &&
      stringField(entry.metadata.candidate_id) === candidateId &&
      stringField(entry.metadata.subject_action) === subjectAction
    ) {
      keys.add(entry.idempotencyKey);
    }
  }
  keys.add(appended.idempotencyKey);
  return keys.size;
}

function completedSideEffectKeysFromJournal(
  journal: readonly DispatcherRunJournalEntry[],
): Set<string> {
  const keys = new Set<string>();
  for (const entry of journal) {
    if (entry.kind === "merge_actuation") {
      keys.add(entry.idempotencyKey);
    }
  }
  return keys;
}

function isUsableLiveState(live: MergeActuatorLiveState): boolean {
  // Runtime guard at the I/O boundary: a fetcher can violate its TS return type
  // and hand back a non-null but incomplete object. The actuator decision
  // dereferences these fields (e.g. requiredChecks.filter), so an unusable
  // shape must be routed through the bounded recovery, not run on.
  return (
    (live.state === "OPEN" ||
      live.state === "MERGED" ||
      live.state === "CLOSED") &&
    typeof live.isDraft === "boolean" &&
    typeof live.headSha === "string" &&
    live.headSha.length > 0 &&
    typeof live.baseRef === "string" &&
    live.baseRef.length > 0 &&
    Array.isArray(live.requiredChecks) &&
    live.requiredChecks.every(isUsableRequiredCheck)
  );
}

function isUsableRequiredCheck(check: unknown): boolean {
  // The actuator decision dereferences `check.status`, so an array element that
  // is null or the wrong shape would throw outside the recovery envelope.
  if (typeof check !== "object" || check === null) {
    return false;
  }
  const record = check as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    (record.status === "pass" ||
      record.status === "fail" ||
      record.status === "pending")
  );
}

function enqueueIntentStartMs(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
): number | null {
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.action) === "enqueue" &&
      stringField(entry.metadata.candidate_id) === candidateId
    ) {
      const parsed = Date.parse(entry.timestamp);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function findParkEntry(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
): DispatcherRunJournalEntry | null {
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.action) === "parked" &&
      stringField(entry.metadata.candidate_id) === candidateId
    ) {
      return entry;
    }
  }
  return null;
}

function parkBlockerFromEntry(
  entry: DispatcherRunJournalEntry,
): MergeActuatorBlocker {
  const raw = recordField(entry.metadata.blocker);
  return {
    candidateId:
      stringField(raw?.candidateId) ??
      stringField(entry.metadata.candidate_id) ??
      "",
    prNumber:
      numberField(raw?.prNumber) ?? numberField(entry.metadata.pr_number) ?? 0,
    reviewedHeadSha:
      stringField(raw?.reviewedHeadSha) ??
      stringField(entry.metadata.reviewed_head_sha) ??
      "",
    reason:
      stringField(raw?.reason) ??
      stringField(entry.metadata.reason) ??
      "merge_actuator_parked",
    attempts:
      numberField(raw?.attempts) ?? numberField(entry.metadata.attempts) ?? 0,
    lastErrorOrStateSummary: stringField(raw?.lastErrorOrStateSummary) ?? "",
    nextOperatorAction: stringField(raw?.nextOperatorAction) ?? "",
  };
}

function liveStateNextOperatorAction(candidate: MergeCandidateRecord): string {
  const target = `${candidate.repo}#${candidate.prNumber}`;
  return `Investigate live GitHub/tracker state for ${target} (reviewed head ${candidate.reviewedHeadSha}); once reachable, re-queue the issue (Todo -> Resume).`;
}

function sideEffectNextOperatorAction(
  subjectAction: string | null,
  candidate: MergeCandidateRecord,
): string {
  if (subjectAction === "tracker_done") {
    return `The merge is proven but the tracker write keeps failing for ${candidate.issueIdentifier}; fix the underlying tracker write failure, then re-queue the issue (Todo -> Resume).`;
  }
  const target = `${candidate.repo}#${candidate.prNumber}`;
  const effect = subjectAction ?? "merge";
  return `The ${effect} side effect keeps failing for ${target}; resolve the underlying GitHub/tracker failure, then re-queue the issue (Todo -> Resume).`;
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
  const previousStatus = record.status;
  const previousLastActuation = record.lastActuation;
  record.updatedAt = entry.timestamp;
  record.cursorRange.lastSequence = entry.sequence;
  if (action === "live_state_failed") {
    // Countable progress evidence only. It must not mutate status or
    // lastActuation, so a transient live-state outage cannot erase an in-flight
    // enqueue intent or otherwise rewrite the candidate's recovery state.
    return;
  }
  if (action === "mark_ready") {
    record.lastActuation = action;
    record.status = "ready_marked";
  } else if (action === "enqueue") {
    // A raw enqueue intent is recorded but must not advance the candidate into
    // the queue until completion evidence is journaled (SYMPH-746, path 4).
    record.lastActuation = action;
  } else if (action === "poll") {
    const reason = stringField(entry.metadata.reason);
    const preservesUnconfirmedEnqueue =
      previousStatus !== "merge_queue_pending" &&
      previousLastActuation === "enqueue" &&
      (reason === "enqueue_status_uncertain" ||
        reason === "merge_queue_pending");
    if (preservesUnconfirmedEnqueue) {
      // Keep the unconfirmed enqueue intent intact across pending-check polls.
      return;
    }
    record.lastActuation = action;
    record.status = "merge_queue_pending";
  } else if (action === "tracker_done") {
    record.lastActuation = action;
    record.status = "merged";
    record.mergedAt = stringField(entry.metadata.merged_at);
    record.mergeCommit = stringField(entry.metadata.merge_commit);
  } else if (action === "stale") {
    record.lastActuation = action;
    record.status = "stale";
    record.blockedReason = stringField(entry.metadata.reason) ?? "stale";
  } else if (action === "timeout") {
    record.lastActuation = action;
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_queue_max_wait_exceeded";
  } else if (action === "failed") {
    record.lastActuation = action;
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_actuation_failed";
  } else if (action === "parked") {
    record.lastActuation = action;
    record.status = "blocked";
    record.blockedReason =
      stringField(entry.metadata.reason) ?? "merge_actuator_parked";
  } else if (action === "completed" || action === "recovered") {
    record.lastActuation = action;
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
    subjectAction === "recovered" ||
    subjectAction === "live_state_failed" ||
    subjectAction === "parked"
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
  if (live.repo !== candidate.repo || live.prNumber !== candidate.prNumber) {
    return "wrong_pr";
  }
  if (live.headSha !== candidate.reviewedHeadSha) {
    return "stale_reviewed_head";
  }
  if (live.baseRef !== candidate.baseRef) {
    return "base_ref_changed";
  }
  if (live.mergeStateStatus === "DIRTY" || live.mergeable === "CONFLICTING") {
    return "merge_conflict";
  }
  if (live.mergeStateStatus === "BEHIND") {
    return "behind_base";
  }
  return null;
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

function isUnconfirmedEnqueueIntent(candidate: MergeCandidateRecord): boolean {
  return (
    candidate.status !== "merge_queue_pending" &&
    candidate.lastActuation === "enqueue"
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
