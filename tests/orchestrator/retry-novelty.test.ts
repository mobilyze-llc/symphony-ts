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

function createConfig(stages?: StagesConfig): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
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
      maxConcurrentAgents: 2,
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
    server: { port: null, slackNotifyChannel: null },
    observability: {
      dashboardEnabled: false,
      refreshMs: 1_000,
      renderIntervalMs: 16,
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
