import { describe, expect, it } from "vitest";

import type {
  DispatcherLease,
  DispatcherRunJournalEntry,
} from "../../src/domain/model.js";
import {
  type MergeActuationJournalDraft,
  type MergeActuatorCycleResult,
  type MergeActuatorLiveState,
  type MergeActuatorSideEffects,
  type MergeCandidateRecord,
  buildMergeActuationEntry,
  buildMergeCandidateEntryFromReviewGate,
  decideMergeActuation,
  reduceMergeCandidates,
  runMergeActuator,
  runMergeActuatorCycle,
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

  it("keeps durable merged proof ahead of stale-head checks", () => {
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
      action: "tracker_done",
      reason: "durable_merge_proof",
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
    expect(events).toEqual(["journal:tracker_done", "tracker_done"]);
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
      action: "noop",
      reason: "side_effect_already_journaled",
    });
  });
});

describe("merge actuator bounded recovery (SYMPH-746)", () => {
  // ---- Path 4: raw enqueue intent preservation ----

  it("does not treat a raw enqueue intent as queue-pending side-effect proof", () => {
    const candidateEntry = candidateJournalEntry();
    const rawEnqueueIntent = enqueueIntentEntry(candidateEntry, {
      sequence: 3,
    });
    const candidate = candidateFromJournal([candidateEntry, rawEnqueueIntent]);

    // A raw enqueue intent is recorded but must NOT advance status into the queue.
    expect(candidate.status).toBe("candidate");
    expect(candidate.lastActuation).toBe("enqueue");

    expect(
      decideMergeActuation({
        candidate,
        live: liveState(),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:03:00.000Z"),
        enqueuedAtMs: Date.parse("2026-06-16T01:00:00.000Z"),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({ action: "poll", reason: "enqueue_status_uncertain" });
  });

  it("keeps a raw enqueue intent unconfirmed across a pending-check poll replay", () => {
    const candidateEntry = candidateJournalEntry();
    const rawEnqueueIntent = enqueueIntentEntry(candidateEntry, {
      sequence: 3,
    });
    const pendingPoll = {
      ...buildMergeActuationEntry({
        candidate: candidateFromJournal([candidateEntry, rawEnqueueIntent]),
        action: "poll",
        timestamp: "2026-06-16T01:03:00.000Z",
        ownerId: "owner-1",
        lease: lease({ leaseId: "lease-2" }),
        live: liveState({
          requiredChecks: [{ name: "merge queue", status: "pending" }],
        }),
        reason: "merge_queue_pending",
      }),
      sequence: 4,
    };
    const candidate = candidateFromJournal([
      candidateEntry,
      rawEnqueueIntent,
      pendingPoll,
    ]);

    // The poll must not overwrite the unconfirmed enqueue into queued/waiting.
    expect(candidate.status).toBe("candidate");
    expect(candidate.lastActuation).toBe("enqueue");
  });

  it("advances to merge_queue_pending only after enqueue completion evidence", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();

    const result = await runMergeActuator({
      candidate: candidateFromJournal([candidateEntry]),
      live: liveState(),
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      completedSideEffectKeys: new Set(),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });
    expect(result.sideEffect).toBe("enqueue");

    // Both the raw intent and a completion entry are journaled; only the
    // completion evidence advances the candidate into the queue.
    expect(harness.entries.some((e) => e.metadata.action === "enqueue")).toBe(
      true,
    );
    expect(
      harness.entries.some(
        (e) =>
          e.metadata.action === "completed" &&
          e.metadata.subject_action === "enqueue",
      ),
    ).toBe(true);

    const confirmed = candidateFromJournal([
      candidateEntry,
      ...harness.entries,
    ]);
    expect(confirmed.status).toBe("merge_queue_pending");
  });

  it("times out a raw enqueue intent after the bounded queue wait", () => {
    const candidateEntry = candidateJournalEntry();
    const rawEnqueueIntent = enqueueIntentEntry(candidateEntry, {
      sequence: 3,
    });
    const candidate = candidateFromJournal([candidateEntry, rawEnqueueIntent]);

    expect(
      decideMergeActuation({
        candidate,
        live: liveState(),
        lease: lease(),
        ownerId: "owner-1",
        nowMs: Date.parse("2026-06-16T01:00:00.000Z") + 31 * 60_000,
        enqueuedAtMs: Date.parse("2026-06-16T01:00:00.000Z"),
        maxWaitMs: 30 * 60_000,
        completedSideEffectKeys: new Set(),
      }),
    ).toMatchObject({
      action: "timeout",
      reason: "merge_queue_max_wait_exceeded",
    });
  });

  // ---- Path 1: live-state fetch throws ----

  it("writes countable evidence and parks after repeated live-state throws", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = { maxLiveStateFailures: 3, maxSideEffectFailures: 2 };
    const results: MergeActuatorCycleResult[] = [];

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      results.push(
        await runMergeActuatorCycle({
          candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
          journal: [candidateEntry, ...harness.entries],
          lease: lease({ leaseId: `lease-${cycle}` }),
          ownerId: "owner-1",
          now: new Date(`2026-06-16T01:0${cycle}:00.000Z`),
          enqueuedAtMs: null,
          maxWaitMs: 30 * 60_000,
          limits,
          fetchLiveState: async () => {
            throw new Error("gh pr view exploded");
          },
          appendActuation: harness.appendActuation,
          sideEffects: noopSideEffects(),
        }),
      );
    }

    expect(results[0]).toMatchObject({
      outcome: "retry",
      reason: "live_state_throw",
      attempts: 1,
    });
    expect(results[1]).toMatchObject({
      outcome: "retry",
      reason: "live_state_throw",
      attempts: 2,
    });

    const evidence = harness.entries.filter(
      (e) => e.metadata.action === "live_state_failed",
    );
    expect(evidence).toHaveLength(3);
    expect(
      evidence.every((e) => e.metadata.reason === "live_state_throw"),
    ).toBe(true);
    // Countable: one distinct entry per dispatch cycle, keyed by candidate + reason + lease.
    expect(new Set(evidence.map((e) => e.idempotencyKey)).size).toBe(3);
    for (const entry of evidence) {
      expect(entry.metadata.candidate_id).toBe(
        candidateFromJournal([candidateEntry]).candidateId,
      );
      expect(entry.metadata.pr_number).toBe(552);
      expect(entry.metadata.reviewed_head_sha).toBe("head-1");
    }

    const park = results[2];
    expect(park?.outcome).toBe("parked");
    if (park?.outcome !== "parked") {
      throw new Error("expected the third cycle to park");
    }
    expect(park.blocker).toMatchObject({
      candidateId: candidateFromJournal([candidateEntry]).candidateId,
      prNumber: 552,
      reviewedHeadSha: "head-1",
      reason: "live_state_unavailable",
      attempts: 3,
    });
    expect(park.blocker.lastErrorOrStateSummary).toContain(
      "gh pr view exploded",
    );
    expect(park.blocker.nextOperatorAction.length).toBeGreaterThan(0);
    expect(park.parkEntry.metadata.action).toBe("parked");
    expect(park.parkEntry.metadata.blocker).toMatchObject({ attempts: 3 });

    const parked = candidateFromJournal([candidateEntry, ...harness.entries]);
    expect(parked).toMatchObject({
      status: "blocked",
      blockedReason: "live_state_unavailable",
    });
  });

  it("restores the live-state failure count from the journal across replay", async () => {
    const candidateEntry = candidateJournalEntry();
    const limits = { maxLiveStateFailures: 3, maxSideEffectFailures: 2 };
    const original = makeJournalHarness();

    // Two live-state throws are durably journaled, then the process "restarts".
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await runMergeActuatorCycle({
        candidate: candidateFromJournal([candidateEntry, ...original.entries]),
        journal: [candidateEntry, ...original.entries],
        lease: lease({ leaseId: `lease-${cycle}` }),
        ownerId: "owner-1",
        now: new Date(`2026-06-16T01:0${cycle}:00.000Z`),
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        limits,
        fetchLiveState: async () => {
          throw new Error("down");
        },
        appendActuation: original.appendActuation,
        sideEffects: noopSideEffects(),
      });
    }

    // Fresh process: only the durable journal carries state across the restart.
    const restarted = makeJournalHarness(original.entries);
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...restarted.entries]),
      journal: [candidateEntry, ...restarted.entries],
      lease: lease({ leaseId: "lease-3" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:05:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => {
        throw new Error("still down");
      },
      appendActuation: restarted.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("parked");
    if (result.outcome !== "parked") {
      throw new Error("expected park after restart");
    }
    // Count restored from the journal (2 prior + 1) rather than reset to 1.
    expect(result.blocker.attempts).toBe(3);
  });

  // ---- Path 2: live-state fetch returns null / incomplete ----

  it("writes countable evidence with a distinct reason and parks after repeated incomplete live state", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = { maxLiveStateFailures: 2, maxSideEffectFailures: 2 };
    const results: MergeActuatorCycleResult[] = [];

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      results.push(
        await runMergeActuatorCycle({
          candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
          journal: [candidateEntry, ...harness.entries],
          lease: lease({ leaseId: `lease-${cycle}` }),
          ownerId: "owner-1",
          now: new Date(`2026-06-16T01:0${cycle}:00.000Z`),
          enqueuedAtMs: null,
          maxWaitMs: 30 * 60_000,
          limits,
          fetchLiveState: async () => null,
          appendActuation: harness.appendActuation,
          sideEffects: noopSideEffects(),
        }),
      );
    }

    expect(results[0]).toMatchObject({
      outcome: "retry",
      reason: "live_state_incomplete",
      attempts: 1,
    });
    expect(results[1]?.outcome).toBe("parked");

    const evidence = harness.entries.filter(
      (e) => e.metadata.action === "live_state_failed",
    );
    expect(evidence).toHaveLength(2);
    expect(
      evidence.every((e) => e.metadata.reason === "live_state_incomplete"),
    ).toBe(true);
  });

  it("records distinct reasons for live-state throws versus incomplete responses", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = { maxLiveStateFailures: 5, maxSideEffectFailures: 5 };

    await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-1" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => {
        throw new Error("boom");
      },
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });
    await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-2" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:02:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => null,
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    const reasons = harness.entries
      .filter((e) => e.metadata.action === "live_state_failed")
      .map((e) => e.metadata.reason);
    expect(reasons).toEqual(["live_state_throw", "live_state_incomplete"]);
  });

  // ---- Path 3: post-proof side-effect failure ----

  it("parks after the configured number of post-proof side-effect failures", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = { maxLiveStateFailures: 5, maxSideEffectFailures: 2 };
    const results: MergeActuatorCycleResult[] = [];

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      results.push(
        await runMergeActuatorCycle({
          candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
          journal: [candidateEntry, ...harness.entries],
          lease: lease({ leaseId: `lease-${cycle}` }),
          ownerId: "owner-1",
          now: new Date(`2026-06-16T01:0${cycle}:00.000Z`),
          enqueuedAtMs: null,
          maxWaitMs: 30 * 60_000,
          limits,
          fetchLiveState: async () => mergedLiveState(),
          appendActuation: harness.appendActuation,
          sideEffects: throwingTrackerDone("linear done failed"),
        }),
      );
    }

    expect(results[0]).toMatchObject({
      outcome: "retry",
      reason: "tracker_done_side_effect_failed",
      attempts: 1,
    });

    const failures = harness.entries.filter(
      (e) =>
        e.metadata.action === "failed" &&
        e.metadata.subject_action === "tracker_done",
    );
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((e) => e.idempotencyKey)).size).toBe(2);

    const park = results[1];
    expect(park?.outcome).toBe("parked");
    if (park?.outcome !== "parked") {
      throw new Error("expected park after side-effect exhaustion");
    }
    expect(park.blocker).toMatchObject({
      candidateId: candidateFromJournal([candidateEntry]).candidateId,
      prNumber: 552,
      reviewedHeadSha: "head-1",
      reason: "tracker_done_side_effect_failed",
      attempts: 2,
    });
    expect(park.blocker.lastErrorOrStateSummary).toContain(
      "linear done failed",
    );
    expect(park.blocker.nextOperatorAction.length).toBeGreaterThan(0);

    const parked = candidateFromJournal([candidateEntry, ...harness.entries]);
    expect(parked.status).toBe("blocked");
  });

  it("restores the side-effect failure count from the journal across replay", async () => {
    const candidateEntry = candidateJournalEntry();
    const limits = { maxLiveStateFailures: 5, maxSideEffectFailures: 2 };
    const original = makeJournalHarness();

    await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...original.entries]),
      journal: [candidateEntry, ...original.entries],
      lease: lease({ leaseId: "lease-1" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => mergedLiveState(),
      appendActuation: original.appendActuation,
      sideEffects: throwingTrackerDone("linear down"),
    });

    const restarted = makeJournalHarness(original.entries);
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...restarted.entries]),
      journal: [candidateEntry, ...restarted.entries],
      lease: lease({ leaseId: "lease-2" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:02:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => mergedLiveState(),
      appendActuation: restarted.appendActuation,
      sideEffects: throwingTrackerDone("linear still down"),
    });

    expect(result.outcome).toBe("parked");
    if (result.outcome !== "parked") {
      throw new Error("expected park after restart");
    }
    expect(result.blocker.attempts).toBe(2);
  });

  // ---- Healthy passthrough ----

  it("actuates normally when live state is healthy", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();

    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits: { maxLiveStateFailures: 3, maxSideEffectFailures: 2 },
      fetchLiveState: async () => liveState(),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("actuated");
    if (result.outcome !== "actuated") {
      throw new Error("expected actuated");
    }
    expect(result.run.sideEffect).toBe("enqueue");
  });

  it("actuates tracker_done on durable merge proof", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();

    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits: { maxLiveStateFailures: 3, maxSideEffectFailures: 2 },
      fetchLiveState: async () => mergedLiveState(),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("actuated");
    if (result.outcome !== "actuated") {
      throw new Error("expected actuated");
    }
    expect(result.run.sideEffect).toBe("tracker_done");

    const merged = candidateFromJournal([candidateEntry, ...harness.entries]);
    expect(merged.status).toBe("merged");
  });

  // Path 4 — the unconfirmed enqueue wait must be bounded from the durable
  // journal, not caller memory, so it terminates after restart.
  it("bounds an unconfirmed enqueue across restart when the caller omits enqueuedAtMs", async () => {
    const candidateEntry = candidateJournalEntry();
    // A raw enqueue intent is durably journaled at T; the process then restarts.
    const rawEnqueueIntent = enqueueIntentEntry(candidateEntry, {
      sequence: 3,
    });
    const harness = makeJournalHarness([rawEnqueueIntent]);
    const enqueueMs = Date.parse("2026-06-16T01:00:00.000Z");

    // Fresh process: enqueuedAtMs is null (lost with process memory), well past
    // the bounded queue wait.
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-restart" }),
      ownerId: "owner-1",
      now: new Date(enqueueMs + 31 * 60_000),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits: { maxLiveStateFailures: 3, maxSideEffectFailures: 2 },
      fetchLiveState: async () => liveState(),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    // It times out (does not poll forever) and the candidate is blocked — never
    // falsely advanced into the queue.
    expect(result.outcome).toBe("actuated");
    if (result.outcome !== "actuated") {
      throw new Error("expected actuated");
    }
    expect(result.run.decision).toMatchObject({
      action: "timeout",
      reason: "merge_queue_max_wait_exceeded",
    });
    const bounded = candidateFromJournal([candidateEntry, ...harness.entries]);
    expect(bounded.status).toBe("blocked");
    expect(bounded.blockedReason).toBe("merge_queue_max_wait_exceeded");
  });

  // Path 2 — a non-null but incomplete live state must be bounded, not throw
  // out of the recovery envelope.
  it("treats an incomplete non-null live state as a bounded recovery failure", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    // Fetcher violates its return contract: a non-null object missing required
    // fields (here requiredChecks/isDraft/headSha/baseRef).
    const malformed = {
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 552,
      state: "OPEN",
    } as unknown as MergeActuatorLiveState;

    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits: { maxLiveStateFailures: 1, maxSideEffectFailures: 2 },
      fetchLiveState: async () => malformed,
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    // No throw escaped: the unusable state is journaled as incomplete and parks
    // at the ceiling.
    expect(result.outcome).toBe("parked");
    if (result.outcome !== "parked") {
      throw new Error("expected parked");
    }
    expect(result.blocker.reason).toBe("live_state_unavailable");
    const evidence = harness.entries.filter(
      (e) => e.metadata.action === "live_state_failed",
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.metadata.reason).toBe("live_state_incomplete");
  });

  // Path 2 — a malformed required-check element (passes Array.isArray but would
  // throw on check.status) must also be bounded, not escape the envelope.
  it("treats malformed required-check elements as a bounded recovery failure", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const malformed = {
      ...liveStateBase(),
      requiredChecks: [null],
    } as unknown as MergeActuatorLiveState;

    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease(),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits: { maxLiveStateFailures: 1, maxSideEffectFailures: 2 },
      fetchLiveState: async () => malformed,
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("parked");
    if (result.outcome !== "parked") {
      throw new Error("expected parked");
    }
    expect(result.blocker.reason).toBe("live_state_unavailable");
  });

  // Idempotency — re-invoking after a park stays parked and appends nothing.
  it("stays parked and appends no new evidence when re-invoked after a park", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = { maxLiveStateFailures: 2, maxSideEffectFailures: 2 };
    const cycle = (n: number) =>
      runMergeActuatorCycle({
        candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
        journal: [candidateEntry, ...harness.entries],
        lease: lease({ leaseId: `lease-${n}` }),
        ownerId: "owner-1",
        now: new Date(`2026-06-16T01:0${n}:00.000Z`),
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        limits,
        fetchLiveState: async () => {
          throw new Error("down");
        },
        appendActuation: harness.appendActuation,
        sideEffects: noopSideEffects(),
      });

    await cycle(1); // retry (1/2)
    const parkResult = await cycle(2); // parks at the ceiling
    expect(parkResult.outcome).toBe("parked");
    const entryCountAfterPark = harness.entries.length;

    // Re-invoke against the same journal (already contains the park entry).
    const reinvoke = await cycle(3);
    expect(reinvoke.outcome).toBe("parked");
    if (reinvoke.outcome === "parked" && parkResult.outcome === "parked") {
      expect(reinvoke.blocker).toEqual(parkResult.blocker);
    }
    // The park short-circuit fired: no new evidence appended, no extra fetch.
    expect(harness.entries.length).toBe(entryCountAfterPark);
  });

  // Persistent-draft no-progress loop (SYMPH-748): a PR that stays draft after
  // mark_ready must be bounded and park, not poll forever.
  it("bounds a persistently-draft PR and parks after the configured observations", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = {
      maxLiveStateFailures: 5,
      maxSideEffectFailures: 5,
      maxDraftWaitObservations: 2,
    };
    const results: MergeActuatorCycleResult[] = [];
    for (let n = 1; n <= 4; n += 1) {
      results.push(
        await runMergeActuatorCycle({
          candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
          journal: [candidateEntry, ...harness.entries],
          lease: lease({ leaseId: `lease-${n}` }),
          ownerId: "owner-1",
          now: new Date(`2026-06-16T01:0${n}:00.000Z`),
          enqueuedAtMs: null,
          maxWaitMs: 30 * 60_000,
          limits,
          fetchLiveState: async () => liveState({ isDraft: true }),
          appendActuation: harness.appendActuation,
          sideEffects: noopSideEffects(),
        }),
      );
      if (results[results.length - 1]?.outcome === "parked") {
        break;
      }
    }

    // Cycle 1 marks the PR ready; subsequent still-draft cycles are bounded
    // no-progress observations; the 2nd observation parks.
    expect(results[0]).toMatchObject({ outcome: "actuated" });
    const park = results[results.length - 1];
    expect(park?.outcome).toBe("parked");
    if (park?.outcome !== "parked") {
      throw new Error("expected a park");
    }
    expect(park.blocker).toMatchObject({
      candidateId: candidateFromJournal([candidateEntry]).candidateId,
      prNumber: 552,
      reviewedHeadSha: "head-1",
      reason: "persistent_draft",
      attempts: 2,
    });
    expect(park.blocker.nextOperatorAction.length).toBeGreaterThan(0);

    const evidence = harness.entries.filter(
      (e) => e.metadata.action === "draft_wait",
    );
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((e) => e.idempotencyKey)).size).toBe(2);

    const parked = candidateFromJournal([candidateEntry, ...harness.entries]);
    expect(parked.status).toBe("blocked");
    expect(parked.blockedReason).toBe("persistent_draft");
  });

  it("restores the draft-wait observation count from the journal across replay", async () => {
    const candidateEntry = candidateJournalEntry();
    const limits = {
      maxLiveStateFailures: 5,
      maxSideEffectFailures: 5,
      maxDraftWaitObservations: 2,
    };
    const original = makeJournalHarness();
    // Cycle 1 marks ready; cycle 2 records the first draft-wait observation.
    for (let n = 1; n <= 2; n += 1) {
      await runMergeActuatorCycle({
        candidate: candidateFromJournal([candidateEntry, ...original.entries]),
        journal: [candidateEntry, ...original.entries],
        lease: lease({ leaseId: `lease-${n}` }),
        ownerId: "owner-1",
        now: new Date(`2026-06-16T01:0${n}:00.000Z`),
        enqueuedAtMs: null,
        maxWaitMs: 30 * 60_000,
        limits,
        fetchLiveState: async () => liveState({ isDraft: true }),
        appendActuation: original.appendActuation,
        sideEffects: noopSideEffects(),
      });
    }

    // Fresh process: only the durable journal carries state across the restart.
    const restarted = makeJournalHarness(original.entries);
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...restarted.entries]),
      journal: [candidateEntry, ...restarted.entries],
      lease: lease({ leaseId: "lease-3" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:05:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => liveState({ isDraft: true }),
      appendActuation: restarted.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("parked");
    if (result.outcome !== "parked") {
      throw new Error("expected park after restart");
    }
    expect(result.blocker.attempts).toBe(2);
  });

  it("does not park a draft PR that is readied within the wait", async () => {
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const limits = {
      maxLiveStateFailures: 5,
      maxSideEffectFailures: 5,
      maxDraftWaitObservations: 2,
    };

    // Cycle 1: draft → mark_ready.
    await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-1" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => liveState({ isDraft: true }),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    // Cycle 2: the PR is readied within the wait → normal actuation, no park.
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-2" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:02:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => liveState({ isDraft: false }),
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("actuated");
    if (result.outcome !== "actuated") {
      throw new Error("expected actuated");
    }
    expect(result.run.sideEffect).toBe("enqueue");
    expect(
      harness.entries.filter((e) => e.metadata.action === "draft_wait"),
    ).toHaveLength(0);
  });

  it("does not treat a merged-but-draft tracker_done noop as a persistent draft", async () => {
    // A MERGED PR that also reports isDraft (a contradictory live state) noops on
    // an already-journaled tracker_done. That must NOT be misclassified as a
    // persistent-draft wait — the detector keys on the mark_ready side-effect.
    const candidateEntry = candidateJournalEntry();
    const harness = makeJournalHarness();
    const mergedDraft = liveState({
      state: "MERGED",
      isDraft: true,
      mergedAt: "2026-06-16T01:00:00Z",
      mergeCommit: "merge-1",
    });
    const limits = {
      maxLiveStateFailures: 5,
      maxSideEffectFailures: 5,
      maxDraftWaitObservations: 1,
    };

    // Cycle 1: tracker_done fires and is journaled (candidate becomes merged).
    await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-1" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:01:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => mergedDraft,
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    // Cycle 2: tracker_done already journaled -> noop while isDraft. With
    // maxDraftWaitObservations=1 a misfire would park immediately; it must not.
    const result = await runMergeActuatorCycle({
      candidate: candidateFromJournal([candidateEntry, ...harness.entries]),
      journal: [candidateEntry, ...harness.entries],
      lease: lease({ leaseId: "lease-2" }),
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:02:00.000Z"),
      enqueuedAtMs: null,
      maxWaitMs: 30 * 60_000,
      limits,
      fetchLiveState: async () => mergedDraft,
      appendActuation: harness.appendActuation,
      sideEffects: noopSideEffects(),
    });

    expect(result.outcome).toBe("actuated");
    expect(
      harness.entries.filter((e) => e.metadata.action === "draft_wait"),
    ).toHaveLength(0);
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
    leaseId: "lease-1",
    issueId: "issue-1",
    issueIdentifier: "SYMPH-722",
    operation: "dispatcher",
    ownerId: "owner-1",
    status: "active",
    acquiredAt: "2026-06-16T00:00:00.000Z",
    expiresAt: "2026-06-16T01:00:00.000Z",
    completedAt: null,
    stage: "merge",
    attempt: null,
    lastJournalSequence: 1,
    ...overrides,
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

function mergedLiveState(): MergeActuatorLiveState {
  return liveState({
    state: "MERGED",
    mergedAt: "2026-06-16T01:00:00Z",
    mergeCommit: "merge-1",
  });
}

function candidateJournalEntry(input?: {
  round?: number;
  headSha?: string;
}): DispatcherRunJournalEntry {
  return {
    ...buildMergeCandidateEntryFromReviewGate(reviewGateEntry(input))!,
    sequence: 2,
  };
}

function candidateFromJournal(
  journal: readonly DispatcherRunJournalEntry[],
): MergeCandidateRecord {
  const reduced = reduceMergeCandidates(journal)["issue-1"];
  if (reduced === undefined) {
    throw new Error("expected a reduced candidate for issue-1");
  }
  return reduced;
}

function enqueueIntentEntry(
  candidateEntry: DispatcherRunJournalEntry,
  options: { sequence: number; leaseId?: string },
): DispatcherRunJournalEntry {
  return {
    ...buildMergeActuationEntry({
      candidate: candidateFromJournal([candidateEntry]),
      action: "enqueue",
      timestamp: "2026-06-16T01:00:00.000Z",
      ownerId: "owner-1",
      lease: lease({ leaseId: options.leaseId ?? "lease-1" }),
      live: liveState(),
      reason: "merge_queue_required",
    }),
    sequence: options.sequence,
  };
}

function makeJournalHarness(
  initial: readonly DispatcherRunJournalEntry[] = [],
): {
  entries: DispatcherRunJournalEntry[];
  appendActuation: (
    draft: MergeActuationJournalDraft,
  ) => Promise<DispatcherRunJournalEntry>;
} {
  const entries: DispatcherRunJournalEntry[] = [...initial];
  let sequence = entries.reduce(
    (max, entry) => Math.max(max, entry.sequence),
    9,
  );
  const appendActuation = async (
    draft: MergeActuationJournalDraft,
  ): Promise<DispatcherRunJournalEntry> => {
    const existing = entries.find(
      (entry) => entry.idempotencyKey === draft.idempotencyKey,
    );
    if (existing !== undefined) {
      return existing;
    }
    sequence += 1;
    const appended: DispatcherRunJournalEntry = { ...draft, sequence };
    entries.push(appended);
    return appended;
  };
  return { entries, appendActuation };
}

function noopSideEffects(): MergeActuatorSideEffects {
  return {
    markReady: async () => {},
    enqueue: async () => {},
    writeTrackerDone: async () => {},
  };
}

function throwingTrackerDone(message: string): MergeActuatorSideEffects {
  return {
    markReady: async () => {},
    enqueue: async () => {},
    writeTrackerDone: async () => {
      throw new Error(message);
    },
  };
}
