/**
 * Tests for the retry-without-novelty short-circuit (SYMPH-396).
 *
 * Key invariants:
 * - First occurrence of any failure signature always gets its normal retry.
 * - Second+ occurrence with an identical signature AND class != "transient" parks
 *   immediately (failure_exhausted), skipping the budget-escalation ladder.
 * - Differing signatures still escalate normally.
 * - Transient signatures keep the normal retry ladder regardless of repetition.
 * - Continuation retries are never affected.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

// ---------------------------------------------------------------------------
// SYMPH-332 fixture: EPERM errors with differing /var/folders paths
// ---------------------------------------------------------------------------

/** Raw error strings from attempt 1 and attempt 2 in the SYMPH-332 incident.
 * The paths under /var/folders contain random workspace identifiers that vary
 * per attempt, but the error kind is identical (EPERM). */
const SYMPH332_EPERM_ATTEMPT1 =
  "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-12345/workspace/src/index.ts'";
const SYMPH332_EPERM_ATTEMPT2 =
  "EPERM: operation not permitted, open '/var/folders/zp/9mhd1b7xyq0/T/tmp-67890/workspace/src/index.ts'";

describe("SYMPH-332 fixture: identical EPERM across attempts parks on second attempt", () => {
  it("parks on attempt 2 when same EPERM class with differing paths", async () => {
    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createOrchestrator({ updateIssueState, postComment });

    // Attempt 1: dispatch and fail with first EPERM
    await orchestrator.pollTick();

    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT1,
    });

    // First occurrence — should get a normal retry
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    // Attempt 2: timer fires, re-dispatch
    await orchestrator.onRetryTimer("1");

    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT2,
    });

    // Second occurrence with identical signature — must park immediately
    expect(retry2).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);

    // Allow async side-effects to fire
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("retry futile: identical failure signature"),
    );
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("permanent"),
    );
  });

  it("park comment includes the signature hash", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createOrchestrator({ postComment });

    await orchestrator.pollTick();

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT1,
    });
    await orchestrator.onRetryTimer("1");
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: SYMPH332_EPERM_ATTEMPT2,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const comment = postComment.mock.calls[0]?.[1] as string;
    // Comment should contain a 7-char hex signature
    expect(comment).toMatch(/[0-9a-f]{7}/);
  });
});

describe("retry-without-novelty: differing signatures still escalate normally", () => {
  it("does not park when second failure has a different signature", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();

    // Attempt 1: EPERM
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "EPERM: operation not permitted, open '/some/path/a.ts'",
    });
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    await orchestrator.onRetryTimer("1");

    // Attempt 2: a completely different error
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "Cannot find module './missing-module' from 'src/index.ts'",
    });

    // Different signature — should still retry
    expect(retry2).not.toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("retry-without-novelty: transient repeats keep normal ladder", () => {
  it("does not park when repeated failure is transient (timeout)", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();

    // Attempt 1: timeout
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "Error: request timeout after 30 seconds",
    });
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    await orchestrator.onRetryTimer("1");

    // Attempt 2: same timeout error
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "Error: request timeout after 30 seconds",
    });

    // Transient — should NOT park
    expect(retry2).not.toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });

  it("does not park when a mid-turn Codex session closure repeats (SYMPH-412)", async () => {
    // A mid-turn closure retries in a FRESH session, so a repeated identical
    // signature carries genuine novelty (new session, new context) and must
    // NOT be short-circuited as "retry futile". The stage circuit breaker
    // (SYMPH-398) and the max-retry ladder still bound repeated closures.
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();

    // Worker exit reason shape produced by formatWorkerErrorReason:
    // "<error_code>: <message>".
    const midTurnClosure =
      "codex_session_closed_mid_turn: Codex session closed while a turn was running.";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: midTurnClosure,
    });
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    await orchestrator.onRetryTimer("1");

    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: midTurnClosure,
    });

    expect(retry2).not.toBeNull();
    expect(retry2!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });

  it("does not park when repeated failure is transient (ECONNRESET)", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();

    const transientError = "ECONNRESET: read ECONNRESET socket closed";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: transientError,
    });
    await orchestrator.onRetryTimer("1");

    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: transientError,
    });

    expect(retry2).not.toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("retry-without-novelty: continuation retries are never short-circuited", () => {
  it("continuation retries with 'identical' error strings pass through", async () => {
    // Continuations have delayType "continuation" and should never be subject to
    // the signature short-circuit regardless of content.
    const orchestrator = createOrchestrator();

    // We drive a fresh poll to get the issue into the running state,
    // then trigger two consecutive normal exits (which become continuations).
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    // Stage-complete continuation
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE]",
    });
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("continuation");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });

  it("two repeated identical continuation exits never park (regression: second continuation must not park)", async () => {
    // Validates the invariant that continuations can never trigger the
    // signature park short-circuit, even on the second consecutive identical exit.
    // We use a single-stage config (initialStage loops back to itself on continuation)
    // by manually resetting the stage after the first continuation fires, so the
    // second continuation also stays within the same stage rather than completing.
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    // First continuation: investigate advances to implement
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE]",
    });
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("continuation");
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    // Reset stage back to investigate so the second continuation fires the same
    // code path again within a live stage (not a terminal advance to "done").
    orchestrator.getState().issueStages["1"] = "investigate";

    await orchestrator.onRetryTimer("1");

    // Second identical continuation (same investigate → implement path) — must still not park
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE]",
    });
    expect(retry2).not.toBeNull();
    expect(retry2!.delayType).toBe("continuation");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("retry-without-novelty: first failure always gets a retry", () => {
  it("first EPERM (attempt 1) schedules a retry, not a park", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();

    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "EPERM: operation not permitted, open '/some/path/file.ts'",
    });

    expect(retry1).not.toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });
});

describe("rework signature lifecycle (SYMPH-396 regression)", () => {
  it("first failure of a reworked stage gets a normal retry, not a park", async () => {
    // Scenario: implement fails once (signature stored) → issue advances past
    // implement (simulated) → reworkGate bounces back to implement → first
    // failure of the new implement visit with the SAME signature must NOT park.
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();

    // Step 1: implement fails once (attempt 1) — stores the signature
    const epermError =
      "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-99/workspace/src/foo.ts'";
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    // Step 2: Simulate the issue advancing past implement to implement (re-entry
    // via rework). We manipulate stage state directly to simulate a downstream
    // gate reworking back to implement — the same path reworkGate takes.
    // First, put the issue in the "implement" stage as the gate target and clear
    // the prior retry so we can re-dispatch cleanly.
    //
    // We call reworkGate. For reworkGate to fire on "implement" we need the
    // current stage to have onRework pointing to a target. Instead of
    // reconfiguring, we directly reproduce what reworkGate does: set stage to
    // reworkTarget and call clearStageFailureSignature. We use the public
    // reworkGate method by first setting up a stage that supports it.
    //
    // Simpler: directly invoke the state manipulation that triggers the bug path.
    // Set the stage to "implement" again (simulates rework bounce) with attempt=2
    // already in the retry queue so the NEXT failure arrives at attempt=2.
    const state = orchestrator.getState();
    state.issueStages["1"] = "implement";

    // Manually clear the retry entry so we can re-dispatch attempt=2 (as if the
    // rework continuation fires).
    // biome-ignore lint/performance/noDelete: test state reset requires real deletion
    delete state.retryAttempts["1"];
    state.claimed.delete("1");

    // Also manually advance the running entry to reflect the rework re-dispatch.
    // Re-poll to get it back into running.
    await orchestrator.pollTick();

    // Step 3: First failure of the reworked implement visit, same EPERM signature,
    // but this time with the same raw error (after rework the signature was cleared).
    // This should get a normal retry, NOT park.
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });

    // The cleared signature means this is treated as a first occurrence — normal retry
    expect(retry2).not.toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
  });

  it("second identical failure of a reworked stage parks (only the first gets a free retry)", async () => {
    // After rework: first failure → normal retry; second identical failure → park.
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();

    const epermError =
      "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-99/workspace/src/bar.ts'";

    // Rework first-visit failure (stores signature then clears on advance)
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });

    // Simulate rework bounce — clear retry state, reset stage
    const state = orchestrator.getState();
    state.issueStages["1"] = "implement";
    // biome-ignore lint/performance/noDelete: test state reset requires real deletion
    delete state.retryAttempts["1"];
    state.claimed.delete("1");
    // Clear signature (mimicking what clearStageFailureSignature does on rework)
    const sigKey = "1:implement";
    delete state.issueFailureSignatures[sigKey];

    await orchestrator.pollTick();

    // First failure of reworked visit — normal retry
    const retryAfterRework1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retryAfterRework1).not.toBeNull();
    expect(state.failed.has("1")).toBe(false);

    await orchestrator.onRetryTimer("1");

    // Second identical failure of reworked visit — must park
    const retryAfterRework2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retryAfterRework2).toBeNull();
    expect(state.failed.has("1")).toBe(true);
  });
});

describe("approveGate signature lifecycle (SYMPH-396 regression)", () => {
  it("first failure after approveGate advances to a stage with a stale signature retries normally", async () => {
    // Scenario: implement runs and stores a failure signature, then advances
    // through a gate (review → merge). Later, approveGate from review sends
    // back to implement (or to merge which has a stale signature). The first
    // failure of the new visit must NOT park — approveGate must clear the
    // destination stage's signature just as advanceStage and reworkGate do.
    //
    // Pipeline: implement → review (gate, onApprove=implement) to create a
    // re-entry into the same stage via approveGate.
    const orchestrator = createOrchestrator({
      stages: createGateBackToImplementConfig(),
    });

    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    const epermError =
      "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-12/workspace/src/index.ts'";

    // Step 1: implement fails once — signature stored for implement
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("failure");

    const state = orchestrator.getState();
    // Verify the signature was stored
    expect(state.issueFailureSignatures["1:implement"]).toBeDefined();

    // Step 2: Simulate advance to the gate stage (review) and then approveGate
    // back to implement — reproduces the false-park path.
    state.issueStages["1"] = "review";
    // biome-ignore lint/performance/noDelete: test state reset requires real deletion
    delete state.retryAttempts["1"];
    state.claimed.delete("1");

    const nextStage = orchestrator.approveGate("1");
    expect(nextStage).toBe("implement");

    // The stale signature must have been cleared by approveGate
    expect(state.issueFailureSignatures["1:implement"]).toBeUndefined();

    // Step 3: re-dispatch and fail with the same error — must get a normal retry
    await orchestrator.pollTick();
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });

    // This should be a normal retry (first visit of the new implement run), not a park
    expect(retry2).not.toBeNull();
    expect(state.failed.has("1")).toBe(false);
  });
});

describe("admission deferrals are exempt from novelty short-circuit (SYMPH-396 P2)", () => {
  it("two consecutive same-reason no-slots deferrals do NOT park the issue", async () => {
    // Scenario: issue "2" is in the retry queue; when its timer fires, no slots
    // are available (issue "1" is running).  The deferral re-schedules with the
    // same synthetic error "no available orchestrator slots".  A second timer
    // fire with the same reason must still not park the issue — the deferral
    // flag must prevent any signature recording/comparison.
    const postComment = vi.fn().mockResolvedValue(undefined);

    // Two-issue tracker: issue "1" dispatched first (fills the single slot),
    // issue "2" queued for retry.
    const twoIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
      createIssue({ id: "2", identifier: "ISSUE-2" }),
    ];
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return twoIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [
          { id: "1", identifier: "ISSUE-1", state: "In Progress" },
          { id: "2", identifier: "ISSUE-2", state: "In Progress" },
        ];
      },
    };

    const orchestrator = new OrchestratorCore({
      config: createConfig(undefined, { maxConcurrentAgents: 1 }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 9002 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment,
      now: () => new Date("2026-06-11T12:00:00.000Z"),
    });

    // Dispatch issue 1 — fills the single slot.
    await orchestrator.pollTick();
    const state = orchestrator.getState();
    expect(Object.keys(state.running)).toContain("1");

    // Manually put issue 2 into the retry queue at attempt 2 (as if it had
    // already failed once — the important invariant is that the retry timer
    // fires when no slots are available).
    state.claimed.add("2");
    state.retryAttempts["2"] = {
      issueId: "2",
      identifier: "ISSUE-2",
      attempt: 2,
      dueAtMs: Date.now(),
      timerHandle: null,
      error: "no available orchestrator slots",
      delayType: "failure",
    };

    // First deferral: timer fires, no slots → re-schedules as deferral.
    const result1 = await orchestrator.onRetryTimer("2");
    expect(result1.dispatched).toBe(false);
    expect(result1.retryEntry).not.toBeNull();
    expect(state.failed.has("2")).toBe(false);
    // No signature should have been recorded for issue 2.
    const sigKey = `2:${state.issueStages["2"] ?? ""}`;
    expect(state.issueFailureSignatures[sigKey]).toBeUndefined();

    // Second deferral: same synthetic error again — must NOT park.
    const result2 = await orchestrator.onRetryTimer("2");
    expect(result2.dispatched).toBe(false);
    expect(result2.retryEntry).not.toBeNull();
    expect(state.failed.has("2")).toBe(false);

    // Allow async side-effects to settle; no park comment expected.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(postComment).not.toHaveBeenCalledWith(
      "2",
      expect.stringContaining("retry futile"),
    );
  });

  it("deferral does not pre-store a signature; first real failure with same text retries normally", async () => {
    // Validates the interaction contract from the council finding: after a
    // deferral (which records no signature), a real worker failure whose text
    // happens to match the synthetic deferral reason is still treated as a
    // first-occurrence failure and gets a normal retry — NOT an immediate park.
    //
    // We verify this indirectly: if two consecutive deferral-text failures DO
    // park on the second attempt (rather than the first), that means they went
    // through the normal signature ladder (first records, second parks), proving
    // no deferral had pre-stored the signature.
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({ postComment });

    await orchestrator.pollTick();

    // Attempt 1: real worker failure whose text equals the synthetic deferral
    // reason (the text itself is not special — only the deferral: true flag
    // would have short-circuited recording).
    const realFailure1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "no available orchestrator slots",
    });
    // First occurrence — must get a normal retry (signature recorded, not parked).
    expect(realFailure1).not.toBeNull();
    expect(realFailure1!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    await orchestrator.onRetryTimer("1");

    // Attempt 2: identical text — now parks because the real failure on
    // attempt 1 stored the signature.  This proves no prior deferral had
    // already stored it (which would have caused a park on attempt 1 itself
    // if combined with a pre-existing entry, or would have left a stale
    // entry that corrupts the ladder).
    const realFailure2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "no available orchestrator slots",
    });
    expect(realFailure2).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
  });

  it("first real failure after a deferral stores the signature; second identical real failure parks", async () => {
    // Validates the correct interaction: deferral doesn't pollute the signature
    // record, so the usual "two identical real failures → park" ladder still works
    // correctly when real failures DO occur after a deferral.
    const postComment = vi.fn().mockResolvedValue(undefined);
    const orchestrator = createOrchestrator({ postComment });

    await orchestrator.pollTick();
    const state = orchestrator.getState();

    // Simulate a deferral by directly manipulating state (no signature should exist).
    const sigKey = `1:${state.issueStages["1"] ?? ""}`;
    expect(state.issueFailureSignatures[sigKey]).toBeUndefined();

    // Fail with a real error once — signature stored, normal retry.
    const epermError =
      "EPERM: operation not permitted, open '/var/folders/xk/3q8vz5cd2r1/T/tmp-defer/workspace/src/foo.ts'";
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retry1).not.toBeNull();
    expect(state.failed.has("1")).toBe(false);
    // Signature was recorded.
    expect(state.issueFailureSignatures[sigKey]).toBeDefined();

    await orchestrator.onRetryTimer("1");

    // Second identical real failure → park.
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retry2).toBeNull();
    expect(state.failed.has("1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-gate rework path clears stage failure signature (SYMPH-396 R4)
// ---------------------------------------------------------------------------

describe("AC-gate rework clears stage failure signature (SYMPH-396 R4)", () => {
  /**
   * Scenario:
   *   1. investigate runs and fails — signature stored, normal retry (attempt 1).
   *   2. investigate re-runs and completes — AC gate fires with "rework" verdict.
   *      The rework path MUST clear the stored failure signature.
   *   3. The reworked investigate run fails again with the same error text.
   *      Because the signature was cleared, this is treated as a fresh first
   *      occurrence: normal retry is scheduled (not an immediate park).
   *   4. The next identical failure parks (signature was re-stored at step 3).
   */
  it("clears the stage signature on AC-gate rework so the reworked run's first identical failure retries normally", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const acVerdict: { verdict: "pass" | "rework"; feedback: string } | null = {
      verdict: "rework",
      feedback: "AC is untestable",
    };

    const stages: StagesConfig = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: "claude-code",
          model: "claude-opus-4",
          prompt: "investigate.liquid",
          maxTurns: 8,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "implement",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        implement: {
          type: "agent",
          runner: "claude-code",
          model: "claude-sonnet-4-5",
          prompt: "implement.liquid",
          maxTurns: 30,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };

    const config = { ...createConfig(stages), acGate: { enabled: true } };

    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker(),
      spawnWorker: async () => ({
        workerHandle: { pid: 9001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
      runAcGate: async () => acVerdict,
      now: () => new Date("2026-06-11T12:00:00.000Z"),
    });

    // === Step 1: investigate dispatched; fails once — signature stored. ===
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    const epermError =
      "EPERM: operation not permitted, open '/var/folders/xk/3q8/T/ws/src/index.ts'";

    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    // First failure — must get a normal retry (not parked).
    expect(retry1).not.toBeNull();
    expect(retry1!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    const sigKey = "1:investigate";
    expect(
      orchestrator.getState().issueFailureSignatures[sigKey],
    ).toBeDefined();

    // === Step 2: re-run; completes normally — AC gate fires with "rework". ===
    await orchestrator.onRetryTimer("1");

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] workpad updated",
    });

    // Let the deferred AC-gate task execute.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deferredTask = deferred.shift();
    expect(deferredTask).toBeDefined();
    await deferredTask!();

    // Rework continuation retry should be scheduled; failure signature cleared.
    expect(orchestrator.getState().retryAttempts["1"]?.delayType).toBe(
      "continuation",
    );
    expect(
      orchestrator.getState().issueFailureSignatures[sigKey],
    ).toBeUndefined();

    // === Step 3: reworked run dispatched; fails with the same error. ===
    // Because the signature was cleared, this is a fresh first occurrence.
    await orchestrator.onRetryTimer("1");

    const retryAfterRework = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    // Must NOT park — this is the first time the signature is seen after the clear.
    expect(retryAfterRework).not.toBeNull();
    expect(retryAfterRework!.delayType).toBe("failure");
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    // Signature re-stored for this new visit.
    expect(
      orchestrator.getState().issueFailureSignatures[sigKey],
    ).toBeDefined();

    // === Step 4: second identical failure in this visit parks. ===
    await orchestrator.onRetryTimer("1");

    const retryAfterRework2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: epermError,
    });
    expect(retryAfterRework2).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOrchestrator(overrides?: {
  updateIssueState?: OrchestratorCoreOptions["updateIssueState"];
  postComment?: OrchestratorCoreOptions["postComment"];
  stages?: StagesConfig;
}) {
  const tracker = createTracker();
  const options: OrchestratorCoreOptions = {
    config: createConfig(overrides?.stages),
    tracker,
    spawnWorker: async () => ({
      workerHandle: { pid: 9001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    ...(overrides?.updateIssueState !== undefined
      ? { updateIssueState: overrides.updateIssueState }
      : {}),
    ...(overrides?.postComment !== undefined
      ? { postComment: overrides.postComment }
      : {}),
    now: () => new Date("2026-06-11T12:00:00.000Z"),
  };
  return new OrchestratorCore(options);
}

function createTracker(): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return [createIssue()];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createConfig(
  stages?: StagesConfig,
  agentOverrides?: { maxConcurrentAgents?: number },
): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: agentOverrides?.maxConcurrentAgents ?? 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    runner: { kind: "codex", model: null },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    pauseTriage: {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
    },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    server: { port: null, host: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    stages: stages ?? createThreeStageConfig(),
    escalationState: "Blocked",
  };
}

function createThreeStageConfig(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "claude-code",
        model: "claude-opus-4",
        prompt: "investigate.liquid",
        maxTurns: 8,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "implement",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: { onComplete: "done", onApprove: null, onRework: null },
        linearState: null,
      },
      done: {
        type: "terminal",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: { onComplete: null, onApprove: null, onRework: null },
        linearState: null,
      },
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Example issue",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Pipeline: implement → review (gate, onApprove=implement).
 * The gate's onApprove loops back to implement so approveGate re-enters
 * a stage that may have a stale failure signature from a prior visit.
 */
function createGateBackToImplementConfig(): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "review",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      review: {
        type: "gate",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: "ensemble",
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: null,
          onApprove: "implement",
          onRework: null,
        },
        linearState: null,
      },
    },
  };
}
