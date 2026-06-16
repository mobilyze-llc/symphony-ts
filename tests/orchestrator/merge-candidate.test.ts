import { describe, expect, it } from "vitest";

import type {
  DispatcherLease,
  DispatcherRunJournalEntry,
} from "../../src/domain/model.js";
import {
  type MergeActuatorLiveState,
  buildMergeActuationEntry,
  buildMergeCandidateEntryFromReviewGate,
  decideMergeActuation,
  reduceMergeCandidates,
  runMergeActuator,
} from "../../src/orchestrator/merge-candidate.js";
import {
  createModeScopedPermissionPolicy,
  evaluateModePermission,
} from "../../src/policy/hard-stops.js";

describe("merge candidates", () => {
  it("persists a candidate only from a clean decorrelated council pass", () => {
    const candidate = buildMergeCandidateEntryFromReviewGate(reviewGateEntry());

    expect(candidate).toMatchObject({
      kind: "merge_candidate",
      issueId: "issue-1",
      issueIdentifier: "SYMPH-722",
      metadata: expect.objectContaining({
        repo: "mobilyze-llc/symphony-ts",
        pr_number: 552,
        reviewed_head_sha: "head-1",
        review_result_path: "/tmp/review-result.json",
        council_verdict: "pass",
        decorrelation_merge_eligible: true,
      }),
    });
  });

  it("does not build candidates from non-pass, non-decorrelated, or incomplete review gates", () => {
    const failed = reviewGateEntry();
    failed.metadata.gate_verdict = "fail";
    expect(buildMergeCandidateEntryFromReviewGate(failed)).toBeNull();

    const ineligible = reviewGateEntry();
    ineligible.metadata.decorrelation_merge_eligible = false;
    expect(buildMergeCandidateEntryFromReviewGate(ineligible)).toBeNull();

    const incomplete = reviewGateEntry();
    const { review_result_path: _reviewResultPath, ...metadataWithoutPath } =
      incomplete.metadata;
    incomplete.metadata = metadataWithoutPath;
    expect(buildMergeCandidateEntryFromReviewGate(incomplete)).toBeNull();
  });

  it("supersedes older candidates and never promotes stale heads", () => {
    const first = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry({ round: 1 }))!,
      sequence: 2,
    };
    const second = {
      ...buildMergeCandidateEntryFromReviewGate(
        reviewGateEntry({ round: 2, headSha: "head-2" }),
      )!,
      sequence: 4,
    };

    const reduced = reduceMergeCandidates([first, second]);

    expect(reduced["issue-1"]).toMatchObject({
      round: 2,
      reviewedHeadSha: "head-2",
      status: "candidate",
    });

    const staleDecision = decideMergeActuation({
      candidate: reduced["issue-1"]!,
      live: liveState({ headSha: "head-moved" }),
      lease: lease(),
      ownerId: "owner-1",
      nowMs: 0,
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
    });
    expect(staleDecision).toMatchObject({
      action: "stale",
      reason: "stale_reviewed_head",
    });
  });

  it("requires a live same-owner lease before any actuator side effect", () => {
    const candidate = reduceMergeCandidates([
      {
        ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
        sequence: 2,
      },
    ])["issue-1"]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState(),
        lease: null,
        ownerId: "owner-1",
        nowMs: 0,
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "noop",
      reason: "missing_live_issue_lease",
    });
  });

  it("rejects durable merged proof when the reviewed head is stale", () => {
    const candidate = reduceMergeCandidates([
      {
        ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
        sequence: 2,
      },
    ])["issue-1"]!;

    const decision = decideMergeActuation({
      candidate,
      live: liveState({
        state: "MERGED",
        headSha: "head-after-merge",
        mergedAt: "2026-06-16T01:00:00Z",
        mergeCommit: "merge-1",
      }),
      lease: lease(),
      ownerId: "owner-1",
      nowMs: 0,
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
    });

    expect(decision).toMatchObject({
      action: "stale",
      reason: "stale_reviewed_head",
    });
  });

  it("journals actuator side effects as deterministic idempotency barriers", () => {
    const candidate = reduceMergeCandidates([
      {
        ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
        sequence: 2,
      },
    ])["issue-1"]!;

    const decision = decideMergeActuation({
      candidate,
      live: liveState({ isDraft: true }),
      lease: lease(),
      ownerId: "owner-1",
      nowMs: 0,
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
    });
    expect(decision).toMatchObject({
      action: "mark_ready",
      reason: "draft_pr",
    });
    expect(decision.sideEffectKey).toContain(":mark_ready");

    const entry = buildMergeActuationEntry({
      candidate,
      action: "mark_ready",
      timestamp: "2026-06-16T01:00:00.000Z",
      ownerId: "owner-1",
      lease: lease(),
      live: liveState({ isDraft: true }),
      reason: decision.reason,
    });
    expect(entry.idempotencyKey).toBe(decision.sideEffectKey);

    const markReadyFailure = buildMergeActuationEntry({
      candidate,
      action: "failed",
      subjectAction: "mark_ready",
      timestamp: "2026-06-16T01:00:01.000Z",
      ownerId: "owner-1",
      lease: lease(),
      live: liveState({ isDraft: true }),
      reason: "mark_ready_failed:gh pr ready failed",
    });
    const enqueueFailure = buildMergeActuationEntry({
      candidate,
      action: "failed",
      subjectAction: "enqueue",
      timestamp: "2026-06-16T01:00:02.000Z",
      ownerId: "owner-1",
      lease: lease(),
      live: liveState(),
      reason: "enqueue_failed:gh pr merge failed",
    });
    expect(markReadyFailure.idempotencyKey).toContain(":failed:mark_ready");
    expect(enqueueFailure.idempotencyKey).toContain(":failed:enqueue");
    expect(markReadyFailure.idempotencyKey).not.toBe(
      enqueueFailure.idempotencyKey,
    );

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({ isDraft: true }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: 0,
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set([entry.idempotencyKey]),
      }),
    ).toMatchObject({
      action: "noop",
      reason: "side_effect_already_journaled",
    });
  });

  it("keeps worker merge permissions denied while allowing a separate actuator model", () => {
    const policy = createModeScopedPermissionPolicy({
      mode: "full",
      stageName: "merge",
      configuredApprovalPolicy: "never",
      configuredThreadSandbox: "workspace-write",
      configuredTurnSandboxPolicy: { type: "workspace-write" },
      maxBudgetUsd: 100,
    });

    expect(policy.canAutoMerge).toBe(false);
    expect(policy.canBypassGates).toBe(false);
    expect(
      evaluateModePermission({ policy, action: "mark_pull_request_ready" }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluateModePermission({ policy, action: "auto_merge" }),
    ).toMatchObject({ allowed: false });
  });

  it("continues polling queued PRs while required checks are pending", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = {
      ...reduceMergeCandidates([candidateEntry])["issue-1"]!,
      status: "merge_queue_pending" as const,
    };

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          requiredChecks: [{ name: "merge queue", status: "pending" }],
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse("2026-06-16T01:00:00.000Z"),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "merge_queue_pending",
    });
  });

  it("continues polling queued PRs while GitHub reports the queue branch behind", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = {
      ...reduceMergeCandidates([candidateEntry])["issue-1"]!,
      status: "merge_queue_pending" as const,
    };

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          mergeStateStatus: "BEHIND",
          mergeable: "MERGEABLE",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse("2026-06-16T01:00:00.000Z"),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "merge_queue_pending",
    });
  });

  it("continues polling unconfirmed enqueue recovery while GitHub reports the queue branch behind", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const rawEnqueueIntent = {
      ...buildMergeActuationEntry({
        candidate: reduceMergeCandidates([candidateEntry])["issue-1"]!,
        action: "enqueue",
        timestamp: "2026-06-16T01:00:00.000Z",
        ownerId: "owner-1",
        lease: lease(),
        live: liveState(),
        reason: "merge_queue_required",
      }),
      sequence: 3,
    };
    const candidate = reduceMergeCandidates([candidateEntry, rawEnqueueIntent])[
      "issue-1"
    ]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          mergeStateStatus: "BEHIND",
          mergeable: "MERGEABLE",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse(rawEnqueueIntent.timestamp),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "enqueue_status_uncertain",
    });
  });

  it("blocks pre-enqueue candidates when GitHub reports a non-green merge state", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = reduceMergeCandidates([candidateEntry])["issue-1"]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "stale",
      reason: "merge_state_blocked",
      blockers: ["merge_state_blocked"],
    });
  });

  it("polls pre-enqueue GitHub mergeability unknown before parking after the bounded wait", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = reduceMergeCandidates([candidateEntry])["issue-1"]!;

    const decision = decideMergeActuation({
      candidate,
      live: liveState({
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
      }),
      lease: lease(),
      ownerId: "owner-1",
      nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 90 * 60_000,
      completedSideEffectKeys: new Set(),
    });

    expect(decision).toMatchObject({
      action: "poll",
      reason: "mergeability_unknown",
      blockers: ["mergeability_unknown"],
    });

    const firstPoll = {
      ...buildMergeActuationEntry({
        candidate,
        action: "poll",
        timestamp: "2026-06-16T01:03:00.000Z",
        ownerId: "owner-1",
        lease: lease({ leaseId: "lease-1" }),
        live: liveState({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" }),
        reason: decision.reason,
      }),
      sequence: 3,
    };
    const secondPoll = {
      ...buildMergeActuationEntry({
        candidate,
        action: "poll",
        timestamp: "2026-06-16T01:03:01.000Z",
        ownerId: "owner-1",
        lease: lease({ leaseId: "lease-2" }),
        live: liveState({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" }),
        reason: decision.reason,
      }),
      sequence: 4,
    };
    expect(firstPoll.idempotencyKey).not.toBe(secondPoll.idempotencyKey);
    const polled = reduceMergeCandidates([
      candidateEntry,
      firstPoll,
      secondPoll,
    ])["issue-1"]!;
    expect(polled).toMatchObject({
      status: "candidate",
      cursorRange: { lastSequence: 4 },
    });

    expect(
      decideMergeActuation({
        candidate: polled,
        live: liveState({
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T02:40:00.000Z"),
        enqueuedAtMs: null,
        mergeabilityWaitStartedAtMs: Date.parse(firstPoll.timestamp),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "blocked",
      reason: "mergeability_unknown",
    });
  });

  it("starts the pre-enqueue mergeability wait at the first unknown observation", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = reduceMergeCandidates([candidateEntry])["issue-1"]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T02:40:00.000Z"),
        enqueuedAtMs: null,
        mergeabilityWaitStartedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "mergeability_unknown",
    });
  });

  it("does not treat a raw enqueue intent as queue-pending side-effect proof", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const rawEnqueueIntent = {
      ...buildMergeActuationEntry({
        candidate: reduceMergeCandidates([candidateEntry])["issue-1"]!,
        action: "enqueue",
        timestamp: "2026-06-16T01:00:00.000Z",
        ownerId: "owner-1",
        lease: lease(),
        live: liveState(),
        reason: "merge_queue_required",
      }),
      sequence: 3,
    };
    const candidate = reduceMergeCandidates([candidateEntry, rawEnqueueIntent])[
      "issue-1"
    ]!;

    expect(candidate.status).toBe("candidate");
    expect(candidate.lastActuation).toBe("enqueue");
    expect(
      decideMergeActuation({
        candidate,
        live: liveState(),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse(rawEnqueueIntent.timestamp),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "enqueue_status_uncertain",
    });
  });

  it("polls pending checks after replaying a raw enqueue intent", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const rawEnqueueIntent = {
      ...buildMergeActuationEntry({
        candidate: reduceMergeCandidates([candidateEntry])["issue-1"]!,
        action: "enqueue",
        timestamp: "2026-06-16T01:00:00.000Z",
        ownerId: "owner-1",
        lease: lease(),
        live: liveState(),
        reason: "merge_queue_required",
      }),
      sequence: 3,
    };
    const candidate = reduceMergeCandidates([candidateEntry, rawEnqueueIntent])[
      "issue-1"
    ]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState({
          requiredChecks: [{ name: "merge queue", status: "pending" }],
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse(rawEnqueueIntent.timestamp),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "poll",
      reason: "merge_queue_pending",
      blockers: ["merge queue"],
    });
  });

  it("times out a raw enqueue intent after the bounded queue wait", () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const rawEnqueueIntent = {
      ...buildMergeActuationEntry({
        candidate: reduceMergeCandidates([candidateEntry])["issue-1"]!,
        action: "enqueue",
        timestamp: "2026-06-16T01:00:00.000Z",
        ownerId: "owner-1",
        lease: lease(),
        live: liveState(),
        reason: "merge_queue_required",
      }),
      sequence: 3,
    };
    const candidate = reduceMergeCandidates([candidateEntry, rawEnqueueIntent])[
      "issue-1"
    ]!;

    expect(
      decideMergeActuation({
        candidate,
        live: liveState(),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:31:00.000Z"),
        enqueuedAtMs: Date.parse(rawEnqueueIntent.timestamp),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "timeout",
      reason: "merge_queue_max_wait_exceeded",
    });
  });

  it("runs side effects only after appending the actuation journal barrier", async () => {
    const candidate = reduceMergeCandidates([
      {
        ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
        sequence: 2,
      },
    ])["issue-1"]!;
    const events: string[] = [];

    const result = await runMergeActuator({
      candidate,
      live: liveState({
        state: "MERGED",
        mergedAt: "2026-06-16T01:00:00Z",
        mergeCommit: "merge-1",
      }),
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
      appendActuation: async (entry) => {
        events.push(`journal:${entry.metadata.action}`);
        return { ...entry, sequence: 3 };
      },
      sideEffects: {
        markReady: async () => {
          events.push("mark_ready");
        },
        enqueue: async () => {
          events.push("enqueue");
        },
        writeTrackerDone: async () => {
          events.push("tracker_done");
        },
      },
    });

    expect(result).toMatchObject({
      sideEffect: "tracker_done",
      journalEntry: { kind: "merge_actuation" },
    });
    expect(events).toEqual([
      "journal:tracker_done",
      "tracker_done",
      "journal:completed",
    ]);
  });

  it("records side-effect failures and journals recovery after a retry succeeds", async () => {
    const candidateEntry = {
      ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry())!,
      sequence: 2,
    };
    const candidate = reduceMergeCandidates([candidateEntry])["issue-1"]!;
    const actuationEntries: DispatcherRunJournalEntry[] = [];
    const events: string[] = [];
    let shouldFailTrackerDone = true;
    const appendActuation = async (
      entry: Parameters<
        Parameters<typeof runMergeActuator>[0]["appendActuation"]
      >[0],
    ) => {
      const existing = actuationEntries.find(
        (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
      );
      if (existing !== undefined) {
        events.push(`journal:dedupe:${entry.metadata.action}`);
        return existing;
      }
      const appended = { ...entry, sequence: actuationEntries.length + 3 };
      events.push(
        `journal:${entry.metadata.action}:${entry.metadata.subject_action ?? ""}`,
      );
      actuationEntries.push(appended);
      return appended;
    };

    const result = await runMergeActuator({
      candidate,
      live: liveState({
        state: "MERGED",
        mergedAt: "2026-06-16T01:00:00Z",
        mergeCommit: "merge-1",
      }),
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
      appendActuation,
      sideEffects: {
        markReady: async () => {
          events.push("mark_ready");
        },
        enqueue: async () => {
          events.push("enqueue");
        },
        writeTrackerDone: async () => {
          events.push("tracker_done");
          if (shouldFailTrackerDone) {
            shouldFailTrackerDone = false;
            throw new Error("linear done failed");
          }
        },
      },
    });

    expect(result).toMatchObject({
      sideEffect: "none",
      error: "linear done failed",
      journalEntry: { metadata: { action: "tracker_done" } },
      failureEntry: {
        kind: "merge_actuation",
        metadata: {
          action: "failed",
          subject_action: "tracker_done",
          reason: "tracker_done_failed:linear done failed",
        },
      },
    });
    expect(events).toEqual([
      "journal:tracker_done:",
      "tracker_done",
      "journal:failed:tracker_done",
    ]);

    const blocked = reduceMergeCandidates([
      candidateEntry,
      result.journalEntry!,
      result.failureEntry!,
    ])["issue-1"]!;

    expect(blocked).toMatchObject({
      status: "blocked",
      lastActuation: "failed",
      blockedReason: "tracker_done_failed:linear done failed",
    });
    expect(
      decideMergeActuation({
        candidate: blocked,
        live: liveState({
          state: "MERGED",
          mergedAt: "2026-06-16T01:00:00Z",
          mergeCommit: "merge-1",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: 0,
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set([result.journalEntry!.idempotencyKey]),
      }),
    ).toMatchObject({
      action: "tracker_done",
      reason: "durable_merge_proof",
    });

    const retry = await runMergeActuator({
      candidate: blocked,
      live: liveState({
        state: "MERGED",
        mergedAt: "2026-06-16T01:00:00Z",
        mergeCommit: "merge-1",
      }),
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:02:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set([result.journalEntry!.idempotencyKey]),
      appendActuation,
      sideEffects: {
        markReady: async () => {
          events.push("mark_ready");
        },
        enqueue: async () => {
          events.push("enqueue");
        },
        writeTrackerDone: async () => {
          events.push("tracker_done");
        },
      },
    });

    expect(retry).toMatchObject({
      sideEffect: "tracker_done",
      error: null,
      recoveryEntry: {
        metadata: {
          action: "recovered",
          subject_action: "tracker_done",
          reason: "tracker_done_recovered",
        },
      },
    });
    expect(
      actuationEntries.some(
        (entry) =>
          entry.metadata.action === "completed" &&
          entry.metadata.subject_action === "tracker_done" &&
          entry.metadata.reason === "tracker_done_completed",
      ),
    ).toBe(true);

    const recovered = reduceMergeCandidates([
      candidateEntry,
      ...actuationEntries,
    ])["issue-1"]!;
    expect(recovered).toMatchObject({
      status: "merged",
      lastActuation: "recovered",
      blockedReason: null,
      mergeCommit: "merge-1",
      mergedAt: "2026-06-16T01:00:00Z",
    });
    expect(
      decideMergeActuation({
        candidate: recovered,
        live: liveState({
          state: "MERGED",
          mergedAt: "2026-06-16T01:00:00Z",
          mergeCommit: "merge-1",
        }),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: 0,
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set([result.journalEntry!.idempotencyKey]),
      }),
    ).toMatchObject({
      action: "tracker_done",
      reason: "durable_merge_proof",
    });
  });
});

function reviewGateEntry(input?: {
  round?: number;
  headSha?: string;
}): DispatcherRunJournalEntry {
  const round = input?.round ?? 1;
  const headSha = input?.headSha ?? "head-1";
  return {
    sequence: round,
    idempotencyKey: `review:issue-1:round-${round}`,
    timestamp: `2026-06-16T00:0${round}:00.000Z`,
    kind: "review_gate_result",
    issueId: "issue-1",
    issueIdentifier: "SYMPH-722",
    operation: "gate",
    stage: "review",
    attempt: null,
    ownerId: "owner-1",
    lease: lease(),
    summary: "Council review gate pass for SYMPH-722.",
    metadata: {
      actor: { kind: "dispatcher", id: "owner-1" },
      repo: "mobilyze-llc/symphony-ts",
      pr_number: 552,
      base_ref: "main",
      base_sha: "base-1",
      head_ref: "codex/SYMPH-722-merge-candidates",
      head_sha: headSha,
      reviewed_head_sha: headSha,
      review_result_path: "/tmp/review-result.json",
      round,
      gate_verdict: "pass",
      decorrelation_merge_eligible: true,
    },
  };
}

function lease(overrides: Partial<DispatcherLease> = {}): DispatcherLease {
  return {
    leaseId: overrides.leaseId ?? "lease-1",
    issueId: overrides.issueId ?? "issue-1",
    issueIdentifier: overrides.issueIdentifier ?? "SYMPH-722",
    operation: overrides.operation ?? "dispatcher",
    ownerId: overrides.ownerId ?? "owner-1",
    status: overrides.status ?? "active",
    acquiredAt: overrides.acquiredAt ?? "2026-06-16T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-06-16T01:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    stage: overrides.stage ?? "merge",
    attempt: overrides.attempt ?? null,
    lastJournalSequence: overrides.lastJournalSequence ?? 1,
  };
}

function liveState(
  overrides: Partial<MergeActuatorLiveState> = {},
): MergeActuatorLiveState {
  return { ...liveStateBase(), ...overrides };
}

function liveStateBase(): MergeActuatorLiveState {
  return {
    repo: "mobilyze-llc/symphony-ts",
    prNumber: 552,
    prUrl: "https://github.com/mobilyze-llc/symphony-ts/pull/552",
    state: "OPEN" as const,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    headSha: "head-1",
    baseRef: "main",
    baseSha: "base-1",
    requiredChecks: [],
    requiresGithubReview: false,
    mergeQueueRequired: true,
    mergedAt: null,
    mergeCommit: null,
  };
}
