import type {
  DispatcherLease,
  DispatcherRunJournalEntry,
} from "../domain/model.js";

export const MERGE_CANDIDATE_SCHEMA_VERSION = 1;

export const MERGE_ACTUATION_ACTIONS = [
  "mark_ready",
  "enqueue",
  // Dequeue side effect (SYMPH-766): `gh pr merge --disable-auto` pulls an
  // already-enqueued candidate out of GitHub's merge queue when a late
  // spec-fidelity rework lands, so the queue cannot merge it behind the rework.
  // Idempotent (disabling auto-merge twice is harmless), so it follows the
  // enqueue intent/completion pattern and is safe to redrive on failure.
  "disable_auto_merge",
  "poll",
  "tracker_done",
  "stale",
  "timeout",
  "failed",
  "completed",
  "recovered",
  "live_state_failed",
  "draft_wait",
  // Bounded pre-enqueue waits (SYMPH-752/755): countable, replay-stable
  // no-progress observations for transient non-terminal states before enqueue
  // (in-flight required checks; UNKNOWN mergeability). Like draft_wait they are
  // evidence only — never a side effect and never a status mutation.
  "pending_checks_wait",
  "unknown_mergeability_wait",
  "parked",
] as const;

export type MergeActuationAction = (typeof MERGE_ACTUATION_ACTIONS)[number];
type SideEffectActuationAction = Exclude<
  MergeActuationAction,
  | "failed"
  | "completed"
  | "recovered"
  | "live_state_failed"
  | "draft_wait"
  | "pending_checks_wait"
  | "unknown_mergeability_wait"
  | "parked"
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
    | "disable_auto_merge"
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
  /**
   * Dequeue the candidate from GitHub's merge queue / disable auto-merge
   * (SYMPH-766), invoked when a late spec-fidelity rework lands on an
   * already-enqueued candidate. Must be idempotent (the actuator may redrive it)
   * and must throw on failure so the bounded recovery can park it as
   * `cannot_dequeue` rather than falsely claiming containment.
   *
   * Optional only for ergonomics: a provider that omits it cannot contain a late
   * rework on an already-enqueued candidate, so the actuator parks those
   * candidates as `cannot_dequeue` (the {@link runMergeActuator} guard throws,
   * routing through bounded recovery) rather than silently claiming containment.
   * The production provider (runtime-host) always supplies it.
   */
  disableAutoMerge?(candidate: MergeCandidateRecord): Promise<void>;
  writeTrackerDone(candidate: MergeCandidateRecord): Promise<void>;
}

export interface RunMergeActuatorResult {
  decision: MergeActuatorDecision;
  journalEntry: DispatcherRunJournalEntry | null;
  failureEntry: DispatcherRunJournalEntry | null;
  recoveryEntry: DispatcherRunJournalEntry | null;
  sideEffect:
    | "none"
    | "mark_ready"
    | "enqueue"
    | "disable_auto_merge"
    | "tracker_done";
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
  /**
   * Max persistent-draft no-progress observations (a PR that stays draft after
   * mark_ready) before parking. Optional; defaults to
   * {@link DEFAULT_MAX_DRAFT_WAIT_OBSERVATIONS}.
   */
  maxDraftWaitObservations?: number;
  /**
   * Max in-flight required-check (pending) observations for a fresh, not-yet-
   * enqueued candidate before parking (SYMPH-755). Optional; defaults to
   * {@link DEFAULT_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS}.
   */
  maxPendingChecksWaitObservations?: number;
  /**
   * Max UNKNOWN-mergeability observations for a fresh, not-yet-enqueued
   * candidate before parking (SYMPH-752). Optional; defaults to
   * {@link DEFAULT_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS}.
   */
  maxUnknownMergeabilityWaitObservations?: number;
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

/**
 * SYMPH-758: report whether a CURRENT spec-fidelity `rework` verdict stands for
 * the candidate's reviewed head. The advisory spec-fidelity judge (SYMPH-343)
 * posts verdicts asynchronously, so a `rework` can race in AFTER a passed review
 * gate has already promoted a merge candidate (the SYMPH-639 canary: a rework
 * landed between enqueue and merge). Correlating verdicts to the candidate by
 * `reviewed_head_sha` lets the merge actuator hold actuation until the rework is
 * resolved or superseded.
 *
 * "Current" = the LATEST spec-fidelity verdict (in durable journal order) keyed
 * to this candidate's reviewed head is `rework`. A later `pass` for the same
 * head supersedes an earlier `rework`. Verdicts with no recorded head, or keyed
 * to a different head (e.g. a prior review round), are ignored: a candidate is
 * only held by a verdict that provably judged its reviewed commit, so a stale or
 * uncorrelated verdict never spuriously parks a clean merge.
 */
export function hasCurrentSpecFidelityRework(
  journal: readonly DispatcherRunJournalEntry[],
  candidate: Pick<MergeCandidateRecord, "issueId" | "reviewedHeadSha">,
): boolean {
  let latestVerdict: string | null = null;
  for (const entry of journal) {
    if (entry.kind !== "spec_fidelity" || entry.issueId !== candidate.issueId) {
      continue;
    }
    const head = stringField(entry.metadata.reviewed_head_sha);
    if (head === null || head !== candidate.reviewedHeadSha) {
      continue;
    }
    const verdict = stringField(entry.metadata.verdict);
    if (verdict !== null) {
      latestVerdict = verdict;
    }
  }
  return latestVerdict === "rework";
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
  /**
   * Actuator auto-merge/enqueue permission (SYMPH-754). The actuator — not the
   * worker — is the SOLE auto-merge actor, so this per-workflow permission (from
   * `mergeActuator.autoMerge`), not the worker's Mode Permission Envelope, is the
   * coherent auto-merge envelope. DEFAULT-CLOSED: omitted or false gates the
   * ENQUEUE specifically — a fresh, otherwise-enqueue-ready candidate returns a
   * terminal `blocked` decision with reason `auto_merge_permission_denied` and NO
   * side-effect key (so the pure actuator writes no enqueue row and runs no
   * enqueue), which the coordinator parks for an operator. Static per workflow, so
   * the decision stays a pure function of its inputs and remains replay-stable.
   */
  autoMergePermission?: boolean;
  /**
   * Whether a current spec-fidelity `rework` verdict stands for the candidate's
   * reviewed head (SYMPH-758), derived by {@link hasCurrentSpecFidelityRework}
   * from the durable journal. When true, every merge-advancing action is held
   * (see the gate below). Default false keeps spec-fidelity non-gating in the
   * absence of a rework — the advisory judge (SYMPH-343) only blocks when it has
   * actually returned a rework for this commit.
   */
  specFidelityRework?: boolean;
}): MergeActuatorDecision {
  const leaseDecision = validateLease(
    input.lease,
    input.candidate,
    input.ownerId,
  );
  if (leaseDecision !== null) {
    return leaseDecision;
  }

  // Spec-fidelity rework gate (SYMPH-758 + SYMPH-766). The advisory judge
  // (SYMPH-343) posts verdicts asynchronously, so an independent-judge `rework`
  // can land AFTER a passed review gate promoted — and possibly enqueued — this
  // candidate. While that rework stands for the reviewed head, SYMPH-758 holds
  // every merge-advancing action (mark_ready, enqueue, tracker_done) so the
  // issue never auto-completes as Done. Placed first, before the MERGED/OPEN
  // branches, so even an already-merged PR does not auto-complete while the
  // rework is unresolved — the exact ordering defect the canary hit. SYMPH-766
  // extends the hold into active CONTAINMENT and explicit reconciliation: an
  // already-enqueued candidate is pulled out of GitHub's merge queue (so the
  // queue cannot merge it behind the rework), and each terminal state carries a
  // precise operator-facing reason instead of a silent Blocked-while-merged.
  if (input.specFidelityRework === true) {
    if (input.live.state === "MERGED") {
      // GitHub merged from the queue before we could dequeue (or the rework
      // landed post-merge). Do NOT auto-complete (SYMPH-758) and do NOT pretend
      // we contained it: surface an explicit already-merged reconciliation so
      // the operator sees "parked but already merged", never a silent Blocked
      // while origin/main already carries the merge (the canary split-brain).
      return {
        action: "blocked",
        reason: "spec_fidelity_rework_already_merged",
        blockers: ["spec_fidelity_rework_already_merged"],
        sideEffectKey: null,
      };
    }
    const dequeueCompletionKey = mergeActuationKey(
      input.candidate,
      "completed",
      "disable_auto_merge",
    );
    if (input.completedSideEffectKeys.has(dequeueCompletionKey)) {
      // The dequeue side effect is confirmed: the PR is out of the merge queue
      // and contained. Park with the precise dequeued reconciliation reason.
      return {
        action: "blocked",
        reason: "spec_fidelity_rework_dequeued",
        blockers: ["spec_fidelity_rework_dequeued"],
        sideEffectKey: null,
      };
    }
    const wasEnqueued =
      input.candidate.status === "merge_queue_pending" ||
      isUnconfirmedEnqueueIntent(input.candidate) ||
      // A failed dequeue attempt also proves the candidate was enqueued, and
      // must keep redriving the disable-auto rather than falling through to the
      // never-queued hold below.
      isRedrivingFailedAction(input.candidate, "disable_auto_merge");
    if (!wasEnqueued) {
      // Never entered the merge queue (fresh candidate, draft, or a pre-enqueue
      // blocked state): there is nothing to dequeue, so hold with the original
      // SYMPH-758 semantics. The coordinator parks it for an operator.
      return {
        action: "blocked",
        reason: "spec_fidelity_rework",
        blockers: ["spec_fidelity_rework"],
        sideEffectKey: null,
      };
    }
    // Already enqueued and not yet confirmed dequeued: pull it out of the queue
    // before claiming containment (AC #1). The action key is returned directly
    // (not via sideEffectDecision) so a crash between the intent row and the
    // side effect re-attempts rather than stalling on a side_effect_already_
    // journaled noop — `disable_auto_merge` is idempotent, so repeated calls are
    // safe. On success a completion row is journaled (handled above as
    // `_dequeued`); repeated failures accrue countable `failed` rows the bounded
    // recovery parks as `disable_auto_merge_side_effect_failed` (cannot_dequeue).
    return {
      action: "disable_auto_merge",
      reason: "spec_fidelity_rework_dequeue",
      blockers: ["spec_fidelity_rework"],
      sideEffectKey: mergeActuationKey(input.candidate, "disable_auto_merge"),
    };
  }

  if (input.live.state === "MERGED") {
    // A merged PR whose identity drifted from the reviewed candidate (different
    // PR, head, or base) is an unreviewed merge — park it, do not auto-complete
    // the issue as if the reviewed work shipped (SYMPH-735).
    const identityBlocker = firstLiveIdentityBlocker(
      input.candidate,
      input.live,
    );
    if (identityBlocker !== null) {
      return {
        action: "stale",
        reason: identityBlocker,
        blockers: [identityBlocker],
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
    // Fresh (pre-enqueue) candidate with in-flight required checks and no
    // failing check: a healthy PR whose CI has not finished. Do not park it —
    // signal a BOUNDED pending-checks wait the coordinator converts into
    // countable, replay-stable journal evidence + a ceiling (SYMPH-755),
    // mirroring draft_wait. The decision stays `blocked` (so the pure actuator
    // writes no side-effect row); the non-null sideEffectKey is the coordinator's
    // signal to record a pending_checks_wait observation, not to park.
    return {
      action: "blocked",
      reason: "pending_checks_pre_enqueue",
      blockers: pendingChecks,
      sideEffectKey: mergeActuationKey(input.candidate, "pending_checks_wait"),
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
    // Green-mergeability gate before enqueue (SYMPH-752). Only a fresh,
    // not-yet-enqueued candidate reaches here (isWaitingOnQueue paths return
    // above), so never enqueue until GitHub has computed a green merge state.
    // DIRTY/BEHIND/CONFLICTING are already parked by firstLiveBlocker above;
    // this handles the remaining UNKNOWN and non-green-terminal states.
    const mergeabilityDecision = mergeabilityGateDecision(
      input.candidate,
      input.live,
    );
    if (mergeabilityDecision !== null) {
      return mergeabilityDecision;
    }
    // Auto-merge permission gate (SYMPH-754). A fresh, green, ready candidate is
    // about to be ENQUEUED — the actuator's one auto-merge act. Default-CLOSED:
    // unless the per-workflow `mergeActuator.autoMerge` permission is granted,
    // return a terminal `blocked` decision with NO side-effect key, so the pure
    // actuator writes no enqueue row and never enqueues; the coordinator parks it
    // with an operator-visible `auto_merge_permission_denied` blocker. Gated only
    // here (the final enqueue), AFTER the real merge-state blockers above, so a
    // denial never masks DIRTY/BEHIND/UNKNOWN/non-green state, and so mark_ready,
    // poll, tracker_done, and already-enqueued/merged candidates are unaffected.
    if (input.autoMergePermission !== true) {
      return {
        action: "blocked",
        reason: "auto_merge_permission_denied",
        blockers: ["auto_merge_permission_denied"],
        sideEffectKey: null,
      };
    }
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
  // Poll, failed, live-state-failure, draft-wait, and the bounded pre-enqueue
  // waits are countable progress evidence: one durable, replay-stable entry per
  // dispatch cycle, made unique by the lease id so the journal does not collapse
  // them into one row.
  const key =
    input.action === "poll" ||
    input.action === "failed" ||
    input.action === "live_state_failed" ||
    input.action === "draft_wait" ||
    input.action === "pending_checks_wait" ||
    input.action === "unknown_mergeability_wait"
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
  /** Actuator auto-merge/enqueue permission (SYMPH-754); default-CLOSED. See {@link decideMergeActuation}. */
  autoMergePermission?: boolean;
  /** Current spec-fidelity rework for the reviewed head (SYMPH-758); default false. See {@link decideMergeActuation}. */
  specFidelityRework?: boolean;
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
    autoMergePermission: input.autoMergePermission ?? false,
    specFidelityRework: input.specFidelityRework ?? false,
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
    if (decision.action === "disable_auto_merge") {
      if (input.sideEffects.disableAutoMerge === undefined) {
        // A provider without dequeue capability cannot contain the rework;
        // throw so the catch below records a countable failure and the bounded
        // recovery parks it as cannot_dequeue rather than falsely claiming the
        // PR was pulled from the queue.
        throw new Error(
          "disable_auto_merge requested but no disableAutoMerge side effect is configured",
        );
      }
      await input.sideEffects.disableAutoMerge(input.candidate);
      // Completion evidence (mirrors enqueue, SYMPH-746/766): the dequeue is
      // only "confirmed" once the side effect actually succeeds, so the decision
      // keys `_dequeued` off this completion row, never the raw intent row.
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
        sideEffect: "disable_auto_merge",
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
  /** Actuator auto-merge/enqueue permission (SYMPH-754); default-CLOSED. See {@link decideMergeActuation}. */
  autoMergePermission?: boolean;
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
    autoMergePermission: input.autoMergePermission ?? false,
    // Derived from the durable journal so the rework hold is replay-stable: a
    // verdict that landed late is just as authoritative on the next cycle.
    specFidelityRework: hasCurrentSpecFidelityRework(
      input.journal,
      input.candidate,
    ),
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

  if (
    live.isDraft &&
    run.decision.action === "noop" &&
    run.decision.reason === "side_effect_already_journaled" &&
    run.decision.sideEffectKey ===
      mergeActuationKey(input.candidate, "mark_ready")
  ) {
    // Persistent draft: mark_ready already succeeded but the PR is still draft
    // (e.g. re-drafted by an external actor). This is a no-progress noop loop,
    // not a failure, so bound it on its own countable ceiling instead of
    // polling forever (SYMPH-748). The mark_ready side-effect-key check is
    // required: a MERGED PR reporting isDraft can also noop on an
    // already-journaled tracker_done, which must NOT be treated as draft.
    return recordDraftWaitObservation({
      candidate: input.candidate,
      journal: input.journal,
      lease,
      ownerId: input.ownerId,
      now: input.now,
      limits: input.limits,
      appendActuation: input.appendActuation,
    });
  }

  // Bounded pending-checks wait (SYMPH-755): a fresh, not-yet-enqueued candidate
  // whose required CI is still in-flight. The pure actuator returns a `blocked`
  // decision (no side-effect row) keyed to the pending_checks_wait action; bound
  // it on its own countable ceiling instead of parking a healthy in-flight-CI PR.
  if (
    run.decision.action === "blocked" &&
    run.decision.reason === "pending_checks_pre_enqueue" &&
    run.decision.sideEffectKey ===
      mergeActuationKey(input.candidate, "pending_checks_wait")
  ) {
    return recordPendingChecksWaitObservation({
      candidate: input.candidate,
      journal: input.journal,
      lease,
      ownerId: input.ownerId,
      now: input.now,
      limits: input.limits,
      pendingChecks: run.decision.blockers,
      appendActuation: input.appendActuation,
    });
  }

  // Bounded UNKNOWN-mergeability wait (SYMPH-752): a fresh candidate GitHub has
  // not yet computed mergeability for. Same shape as the pending-checks wait —
  // never enqueue while UNKNOWN, bound the wait, then park.
  if (
    run.decision.action === "blocked" &&
    run.decision.reason === "mergeability_unknown" &&
    run.decision.sideEffectKey ===
      mergeActuationKey(input.candidate, "unknown_mergeability_wait")
  ) {
    return recordUnknownMergeabilityWaitObservation({
      candidate: input.candidate,
      journal: input.journal,
      lease,
      ownerId: input.ownerId,
      now: input.now,
      limits: input.limits,
      appendActuation: input.appendActuation,
    });
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

const DEFAULT_MAX_DRAFT_WAIT_OBSERVATIONS = 20;

async function recordDraftWaitObservation(input: {
  candidate: MergeCandidateRecord;
  journal: readonly DispatcherRunJournalEntry[];
  lease: DispatcherLease;
  ownerId: string;
  now: Date;
  limits: MergeActuatorRecoveryLimits;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
}): Promise<MergeActuatorCycleResult> {
  const evidenceEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "draft_wait",
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      reason: "persistent_draft",
      metadata: { last_error: "pull request still draft after mark_ready" },
    }),
  );
  const attempts = countDraftWaitObservations(
    input.journal,
    input.candidate.candidateId,
    evidenceEntry,
  );
  const ceiling =
    input.limits.maxDraftWaitObservations ??
    DEFAULT_MAX_DRAFT_WAIT_OBSERVATIONS;
  if (attempts >= ceiling) {
    return parkCandidate({
      candidate: input.candidate,
      lease: input.lease,
      ownerId: input.ownerId,
      now: input.now,
      live: null,
      reason: "persistent_draft",
      attempts,
      lastErrorOrStateSummary: `pull request still draft after ${attempts} mark_ready waits`,
      nextOperatorAction: draftWaitNextOperatorAction(input.candidate),
      appendActuation: input.appendActuation,
    });
  }
  return {
    outcome: "retry",
    reason: "persistent_draft",
    attempts,
    evidenceEntry,
  };
}

const DEFAULT_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS = 30;

/**
 * Record one bounded pending-checks wait observation (SYMPH-755). Mirrors
 * {@link recordDraftWaitObservation}: append a countable, replay-stable
 * `pending_checks_wait` row (per-cycle keyed by lease id), count distinct rows
 * from the durable journal, and park with a `pending_checks_timeout` blocker on
 * ceiling exhaustion. Otherwise return a retry so the candidate re-polls.
 */
async function recordPendingChecksWaitObservation(input: {
  candidate: MergeCandidateRecord;
  journal: readonly DispatcherRunJournalEntry[];
  lease: DispatcherLease;
  ownerId: string;
  now: Date;
  limits: MergeActuatorRecoveryLimits;
  pendingChecks: readonly string[];
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
}): Promise<MergeActuatorCycleResult> {
  const pendingSummary =
    input.pendingChecks.length > 0
      ? input.pendingChecks.join(", ")
      : "required checks";
  const evidenceEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "pending_checks_wait",
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      reason: "pending_checks_pre_enqueue",
      metadata: {
        last_error: `required checks still pending: ${pendingSummary}`,
        pending_checks: [...input.pendingChecks],
      },
    }),
  );
  const attempts = countWaitObservations(
    input.journal,
    input.candidate.candidateId,
    "pending_checks_wait",
    evidenceEntry,
  );
  const ceiling =
    input.limits.maxPendingChecksWaitObservations ??
    DEFAULT_MAX_PENDING_CHECKS_WAIT_OBSERVATIONS;
  if (attempts >= ceiling) {
    return parkCandidate({
      candidate: input.candidate,
      lease: input.lease,
      ownerId: input.ownerId,
      now: input.now,
      live: null,
      reason: "pending_checks_timeout",
      attempts,
      lastErrorOrStateSummary: `required checks still pending after ${attempts} waits: ${pendingSummary}`,
      nextOperatorAction: pendingChecksNextOperatorAction(input.candidate),
      appendActuation: input.appendActuation,
    });
  }
  return {
    outcome: "retry",
    reason: "pending_checks_pre_enqueue",
    attempts,
    evidenceEntry,
  };
}

const DEFAULT_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS = 20;

/**
 * Record one bounded UNKNOWN-mergeability wait observation (SYMPH-752). Same
 * shape as {@link recordPendingChecksWaitObservation}: countable, replay-stable
 * `unknown_mergeability_wait` evidence + a ceiling, parking with a
 * `mergeability_unknown` blocker on exhaustion. The candidate is never enqueued
 * while mergeability is UNKNOWN.
 */
async function recordUnknownMergeabilityWaitObservation(input: {
  candidate: MergeCandidateRecord;
  journal: readonly DispatcherRunJournalEntry[];
  lease: DispatcherLease;
  ownerId: string;
  now: Date;
  limits: MergeActuatorRecoveryLimits;
  appendActuation: (
    entry: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
}): Promise<MergeActuatorCycleResult> {
  const evidenceEntry = await input.appendActuation(
    buildMergeActuationEntry({
      candidate: input.candidate,
      action: "unknown_mergeability_wait",
      timestamp: input.now.toISOString(),
      ownerId: input.ownerId,
      lease: input.lease,
      reason: "mergeability_unknown",
      metadata: {
        last_error: "GitHub has not computed mergeability (UNKNOWN/null)",
      },
    }),
  );
  const attempts = countWaitObservations(
    input.journal,
    input.candidate.candidateId,
    "unknown_mergeability_wait",
    evidenceEntry,
  );
  const ceiling =
    input.limits.maxUnknownMergeabilityWaitObservations ??
    DEFAULT_MAX_UNKNOWN_MERGEABILITY_WAIT_OBSERVATIONS;
  if (attempts >= ceiling) {
    return parkCandidate({
      candidate: input.candidate,
      lease: input.lease,
      ownerId: input.ownerId,
      now: input.now,
      live: null,
      reason: "mergeability_unknown",
      attempts,
      lastErrorOrStateSummary: `GitHub mergeability still UNKNOWN after ${attempts} waits`,
      nextOperatorAction: unknownMergeabilityNextOperatorAction(
        input.candidate,
      ),
      appendActuation: input.appendActuation,
    });
  }
  return {
    outcome: "retry",
    reason: "mergeability_unknown",
    attempts,
    evidenceEntry,
  };
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

function countDraftWaitObservations(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
  appended: DispatcherRunJournalEntry,
): number {
  return countWaitObservations(journal, candidateId, "draft_wait", appended);
}

/**
 * Countable re-poll actions whose cadence the SYMPH-753 backoff governs: the
 * merge-queue `poll` plus the bounded pre-enqueue/draft waits. Each leaves one
 * distinct-keyed `merge_actuation` row per dispatch cycle.
 */
const MERGE_ACTUATOR_POLL_ACTIONS: ReadonlySet<MergeActuationAction> = new Set([
  "poll",
  "draft_wait",
  "pending_checks_wait",
  "unknown_mergeability_wait",
]);

/**
 * The 1-based attempt index for the merge-actuator re-poll backoff (SYMPH-753),
 * derived from the durable journal so it is replay-stable: the count of distinct
 * countable re-poll rows ({@link MERGE_ACTUATOR_POLL_ACTIONS}) for the candidate.
 * Call AFTER the current cycle's poll/wait evidence has been appended, so the
 * first re-poll returns 1 (the first backoff rung). Returns 1 when there is no
 * such evidence yet, so the cadence never under-counts to a zero/negative rung.
 */
export function mergeActuatorPollAttempt(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
): number {
  const keys = new Set<string>();
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.candidate_id) === candidateId
    ) {
      const action = stringField(entry.metadata.action);
      if (
        action !== null &&
        MERGE_ACTUATOR_POLL_ACTIONS.has(action as MergeActuationAction)
      ) {
        keys.add(entry.idempotencyKey);
      }
    }
  }
  return Math.max(keys.size, 1);
}

/**
 * Count distinct idempotency keys of `merge_actuation` rows with the given
 * countable wait `action` for a candidate (SYMPH-752/755). Each dispatch cycle
 * holds a distinct lease id, so each cycle's wait row is a distinct key — this
 * is exactly the per-cycle countable, replay-stable bound the draft_wait pattern
 * uses. The just-appended row is always included.
 */
function countWaitObservations(
  journal: readonly DispatcherRunJournalEntry[],
  candidateId: string,
  action: MergeActuationAction,
  appended: DispatcherRunJournalEntry,
): number {
  const keys = new Set<string>();
  for (const entry of journal) {
    if (
      entry.kind === "merge_actuation" &&
      stringField(entry.metadata.action) === action &&
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
    // The green-mergeability gate (SYMPH-752) dereferences these and keys the
    // UNKNOWN branch on `=== null`. A fetcher returning `undefined` would slip
    // past that check (undefined !== null) and either enqueue on unverified
    // mergeability or throw on mergeStateStatus.toLowerCase() outside the
    // recovery envelope. Require the same string|null shape the fetcher promises
    // so a violating value is routed through bounded recovery instead.
    (typeof live.mergeable === "string" || live.mergeable === null) &&
    (typeof live.mergeStateStatus === "string" ||
      live.mergeStateStatus === null) &&
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

/**
 * Operator-facing park detail for the SYMPH-766 late-rework reconciliation
 * reasons. Returns null for any other reason so the coordinator keeps its
 * default detail. Keeps the message accurate — notably, an already-merged PR
 * must NOT be described as "not mergeable" (it merged); the operator needs to
 * see the split-brain to reconcile it.
 */
export function mergeReworkParkDetail(
  reason: string,
  prNumber: number,
): string | null {
  switch (reason) {
    case "spec_fidelity_rework_already_merged":
      return `A late spec-fidelity rework landed for the reviewed head AFTER GitHub merged PR #${prNumber} from the queue — Symphony could not dequeue it in time. origin/main already carries the merge, but Symphony did NOT auto-complete the issue (split-brain). Reconcile deliberately: accept the merge (mark Done) or revert it, then clear the resume hold.`;
    case "spec_fidelity_rework_dequeued":
      return `A late spec-fidelity rework landed for the reviewed head; PR #${prNumber} was dequeued from the merge queue before it merged (contained). Resolve the rework, then re-queue the issue (Todo -> Resume).`;
    case "spec_fidelity_rework":
      return `A late spec-fidelity rework landed for the reviewed head before PR #${prNumber} entered the merge queue; merge actuation is held. Resolve the rework, then re-queue the issue (Todo -> Resume).`;
    default:
      return null;
  }
}

function sideEffectNextOperatorAction(
  subjectAction: string | null,
  candidate: MergeCandidateRecord,
): string {
  if (subjectAction === "tracker_done") {
    return `The merge is proven but the tracker write keeps failing for ${candidate.issueIdentifier}; fix the underlying tracker write failure, then re-queue the issue (Todo -> Resume).`;
  }
  if (subjectAction === "disable_auto_merge") {
    return `A late spec-fidelity rework landed but the dequeue (disable auto-merge) keeps failing for ${candidate.repo}#${candidate.prNumber}; the PR may still be in GitHub's merge queue. Manually dequeue/cancel it in GitHub, resolve the rework, then re-queue the issue (Todo -> Resume).`;
  }
  const target = `${candidate.repo}#${candidate.prNumber}`;
  const effect = subjectAction ?? "merge";
  return `The ${effect} side effect keeps failing for ${target}; resolve the underlying GitHub/tracker failure, then re-queue the issue (Todo -> Resume).`;
}

function draftWaitNextOperatorAction(candidate: MergeCandidateRecord): string {
  const target = `${candidate.repo}#${candidate.prNumber}`;
  return `${target} is still a draft after the actuator marked it ready; mark the PR ready (or close it), then re-queue the issue (Todo -> Resume).`;
}

function pendingChecksNextOperatorAction(
  candidate: MergeCandidateRecord,
): string {
  const target = `${candidate.repo}#${candidate.prNumber}`;
  return `${target} still has required checks pending after the bounded wait; investigate the stuck/slow CI checks, then re-queue the issue (Todo -> Resume).`;
}

function unknownMergeabilityNextOperatorAction(
  candidate: MergeCandidateRecord,
): string {
  const target = `${candidate.repo}#${candidate.prNumber}`;
  return `GitHub never computed a mergeability for ${target} within the bounded wait; check the PR's merge state, then re-queue the issue (Todo -> Resume).`;
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
  if (
    action === "live_state_failed" ||
    action === "draft_wait" ||
    action === "pending_checks_wait" ||
    action === "unknown_mergeability_wait"
  ) {
    // Countable progress evidence only. It must not mutate status or
    // lastActuation, so a transient live-state outage, a draft-wait, or a
    // bounded pre-enqueue wait (pending checks / UNKNOWN mergeability) cannot
    // erase an in-flight enqueue intent or otherwise rewrite the candidate's
    // recovery state (SYMPH-746/752/755).
    return;
  }
  if (action === "mark_ready") {
    record.lastActuation = action;
    record.status = "ready_marked";
  } else if (action === "enqueue") {
    // A raw enqueue intent is recorded but must not advance the candidate into
    // the queue until completion evidence is journaled (SYMPH-746, path 4).
    record.lastActuation = action;
    // NOTE (SYMPH-769, council R1): a `disable_auto_merge` intent must NOT set
    // lastActuation. Doing so overwrites the `"enqueue"` marker that
    // isUnconfirmedEnqueueIntent reads, so a crash between the dequeue intent and
    // its side effect would lose the unconfirmed-enqueue signal and drop the
    // dequeue redrive — leaving a possibly-queued PR uncontained. The
    // fall-through (no branch) is the correct, replay-stable behavior; the
    // dequeue is visible via its journaled action/completion rows instead.
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

/**
 * Merge-state statuses that are safe to enqueue behind (SYMPH-752). UNSTABLE
 * (non-required checks pending/failing) and HAS_HOOKS are mergeable; the
 * required-check gate above already bounds genuinely in-flight required checks.
 */
const GREEN_MERGE_STATE_STATUSES: ReadonlySet<string> = new Set([
  "CLEAN",
  "HAS_HOOKS",
  "UNSTABLE",
]);

/**
 * Green-mergeability gate before enqueue (SYMPH-752). Returns `null` when the
 * PR is green and may enqueue; otherwise a non-enqueue decision:
 * - UNKNOWN (`mergeable`/`mergeStateStatus` null — GitHub has not computed
 *   mergeability yet): a BOUNDED wait (reason `mergeability_unknown`, signaled
 *   by an `unknown_mergeability_wait` sideEffectKey the coordinator counts and
 *   bounds). Never enqueue while UNKNOWN.
 * - Non-green terminal merge state (e.g. BLOCKED): park via `merge_state_<status>`.
 *
 * DIRTY/BEHIND/CONFLICTING are NOT handled here — firstLiveBlocker already
 * parks them as merge_conflict/behind_base before the decision reaches enqueue.
 */
function mergeabilityGateDecision(
  candidate: MergeCandidateRecord,
  live: MergeActuatorLiveState,
): MergeActuatorDecision | null {
  if (live.mergeable === null || live.mergeStateStatus === null) {
    return {
      action: "blocked",
      reason: "mergeability_unknown",
      blockers: ["mergeability_unknown"],
      sideEffectKey: mergeActuationKey(candidate, "unknown_mergeability_wait"),
    };
  }
  if (
    live.mergeable === "MERGEABLE" &&
    GREEN_MERGE_STATE_STATUSES.has(live.mergeStateStatus)
  ) {
    return null;
  }
  const status = live.mergeStateStatus.toLowerCase();
  return {
    action: "blocked",
    reason: `merge_state_${status}`,
    blockers: [`merge_state_${status}`],
    sideEffectKey: null,
  };
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
  if (live.mergeStateStatus === "BEHIND") {
    return "behind_base";
  }
  return null;
}

/**
 * PR identity vs the reviewed candidate: wrong PR, a head that drifted from the
 * reviewed SHA, or a changed base. Checked on the MERGED path too (SYMPH-735):
 * once the actuator can auto-complete, a PR merged at a head other than the
 * reviewed one is an unreviewed merge and must park, not be marked done.
 */
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
