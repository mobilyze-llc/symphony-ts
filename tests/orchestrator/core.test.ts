import { describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  ReviewerDefinition,
} from "../../src/config/types.js";
import type { DispatcherRunJournal, Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  type SupervisionResteerRequest,
  classifyExitOutcome,
  computeFailureRetryDelayMs,
  sortIssuesForDispatch,
} from "../../src/orchestrator/core.js";
import type { TrackerIssueWriteRequest } from "../../src/orchestrator/tracker-write.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

describe("orchestrator core", () => {
  it("sorts dispatch candidates by priority, age, and identifier", () => {
    const issues = sortIssuesForDispatch([
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        priority: 2,
        createdAt: "2026-03-05T00:00:00.000Z",
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        priority: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
      }),
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        priority: 1,
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
    ]);

    expect(issues.map((issue) => issue.id)).toEqual(["1", "2", "3"]);
  });

  it("rejects Todo issues with non-terminal blockers and allows terminal blockers", () => {
    const orchestrator = createOrchestrator();

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-1",
          identifier: "ISSUE-1",
          state: "Todo",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-2",
          identifier: "ISSUE-2",
          state: "Todo",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects non-Todo issues with non-terminal blockers", () => {
    const orchestrator = createOrchestrator();

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "ip-1",
          identifier: "ISSUE-IP-1",
          state: "In Progress",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "ip-2",
          identifier: "ISSUE-IP-2",
          state: "In Progress",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects Resume-state issues with non-terminal blockers", () => {
    // Resume is an active state in some configurations — blockedBy check must
    // apply to it just like Todo and In Progress (SYMPH-50).
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({ config });

    // Blocked by a non-terminal issue → must NOT dispatch
    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "resume-1",
          identifier: "ISSUE-RESUME-1",
          state: "Resume",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    // Blocked by a terminal issue → may dispatch
    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "resume-2",
          identifier: "ISSUE-RESUME-2",
          state: "Resume",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("dispatches eligible issues on poll tick until slots are exhausted", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", priority: 1 }),
          createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
        ],
      }),
    });

    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
    expect([...orchestrator.getState().claimed]).toEqual(["1", "2"]);
  });

  it("emits a structured right-sizing decision from pollTick", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            priority: 3,
            labels: ["trivial"],
            description: "## Declared file scope\n- src/features/copy.ts\n",
          }),
        ],
      }),
    });

    const result = await orchestrator.pollTick();

    expect(result.modeDecisions).toEqual([
      expect.objectContaining({
        classifier: "deterministic-v1",
        mode: "prototype",
        modelRouting: {
          allowed: false,
          reason: "not_needed",
        },
        signals: expect.objectContaining({
          declaredScopeFiles: ["src/features/copy.ts"],
          impactSurface: "narrow",
          labels: ["trivial"],
        }),
      }),
    ]);
  });

  it("pauses dispatch when declared file scopes overlap a co-running worker", async () => {
    const resteers: SupervisionResteerRequest[] = [];
    const trackerWrites: TrackerIssueWriteRequest[] = [];
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            description: "## Declared file scope\n- src/shared/config.ts",
          }),
          createIssue({
            id: "2",
            identifier: "ISSUE-2",
            priority: 2,
            description:
              "## Declared file scope\n- `src/shared/config.ts`\n- src/features/two.ts",
          }),
        ],
      }),
      requestSupervisionResteer: (input) => {
        resteers.push(input);
      },
      requestTrackerIssueWrite: (input) => {
        trackerWrites.push(input);
      },
    });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1"]);
    expect(resteers).toHaveLength(1);
    expect(resteers[0]).toMatchObject({
      phase: "dispatch",
      findings: [
        {
          kind: "declared_scope_overlap",
          action: "pause",
          workerIds: ["1", "2"],
          issueIdentifiers: ["ISSUE-1", "ISSUE-2"],
          files: ["src/shared/config.ts"],
        },
      ],
    });
    expect(resteers[0]!.comment).toContain(
      "Deterministic dispatch supervision paused a co-run",
    );
    expect(trackerWrites).toEqual([
      {
        boundary: {
          type: "explicit_finding",
          phase: "dispatch",
          finding: {
            kind: "declared_scope_overlap",
            action: "pause",
            workerIds: ["1", "2"],
            issueIdentifiers: ["ISSUE-1", "ISSUE-2"],
            files: ["src/shared/config.ts"],
            message: "ISSUE-1 and ISSUE-2 declared overlapping file scope.",
          },
        },
      },
    ]);
  });

  it("updates running issue state during reconciliation", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Review" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(orchestrator.getState().running["1"]?.issue.state).toBe("In Review");
  });

  it("requests stop without cleanup when a running issue becomes non-active", async () => {
    const stopRequests: unknown[] = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Backlog" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      stopRunningIssue: async (input) => {
        stopRequests.push(input);
      },
    });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
    expect(stopRequests).toHaveLength(1);
  });

  it("requests stop with cleanup when a running issue becomes terminal", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Done" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
  });

  it("requests stop when reconciliation no longer returns a running issue", async () => {
    const tracker = createTracker({
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
  });

  it("treats reconciliation with no running issues as a no-op", async () => {
    const tracker = createTracker({
      candidates: [],
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(result.reconciliationFetchFailed).toBe(false);
  });

  it("schedules continuation retry after a normal worker exit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: null,
      dueAtMs: Date.parse("2026-03-06T00:00:06.000Z"),
    });
    expect(timers.scheduled[0]?.delayMs).toBe(1_000);
  });

  it("records a hard_stop_trigger journal entry and does not continue a paused unit", async () => {
    let issueState = "Todo";
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
    });

    await orchestrator.pollTick();
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "premium_spend_near_ceiling",
        reason: "Estimated premium spend is near ceiling.",
        turnCount: 2,
        totalTokens: 150_000,
        estimatedCostUsd: 40,
      },
    });

    expect(retry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(
      orchestrator
        .getState()
        .dispatcherRunJournal.some(
          (entry) =>
            entry.kind === "hard_stop_trigger" &&
            entry.issueId === "1" &&
            entry.metadata.outcome === "PAUSED-budget" &&
            entry.metadata.trigger === "premium_spend_near_ceiling" &&
            entry.metadata.issueState === "Todo",
        ),
    ).toBe(true);

    const stillTodo = await orchestrator.pollTick();
    expect(stillTodo.dispatchedIssueIds).toEqual([]);
    expect(orchestrator.getState().failed.has("1")).toBe(false);

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("pauses for headless Codex input-required exits until explicit Resume", async () => {
    let issueState = "Todo";
    const comments: string[] = [];
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: `${ERROR_CODES.codexUserInputRequired}: Codex requested operator input during a turn.`,
    });

    expect(retry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(comments.at(-1)).toContain(
      "Headless Codex requested operator input",
    );
    expect(comments.at(-1)).toContain(
      "Move the issue to Resume after human review to requeue it.",
    );
    expect(
      orchestrator
        .getState()
        .dispatcherRunJournal.some(
          (entry) =>
            entry.kind === "operator_input_required" &&
            entry.issueId === "1" &&
            entry.metadata.errorCode === ERROR_CODES.codexUserInputRequired,
        ),
    ).toBe(true);

    const stillTodo = await orchestrator.pollTick();
    expect(stillTodo.dispatchedIssueIds).toEqual([]);

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("instructs out-of-and-back-into Resume when input-required pause hits an issue already in Resume", async () => {
    let issueState = "Resume";
    const comments: string[] = [];
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "In Progress", "Resume"];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: `${ERROR_CODES.codexUserInputRequired}: Codex requested operator input during a turn.`,
    });

    expect(retry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(comments.at(-1)).toContain("already in Resume when it paused");
    expect(comments.at(-1)).toContain(
      "move it out of Resume (if it is still there) and back into Resume",
    );

    // Staying in Resume must not requeue: the guard demands a fresh transition.
    const stillResume = await orchestrator.pollTick();
    expect(stillResume.dispatchedIssueIds).toEqual([]);

    // The out-of-and-back-into dance the comment instructs actually requeues.
    issueState = "Blocked";
    const observedOut = await orchestrator.pollTick();
    expect(observedOut.dispatchedIssueIds).toEqual([]);

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("instructs out-of-and-back-into Resume when a hard stop pauses an issue already in Resume", async () => {
    const comments: string[] = [];
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "In Progress", "Resume"];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
        ],
      }),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "premium_spend_near_ceiling",
        reason: "Estimated premium spend is near ceiling.",
        turnCount: 2,
        totalTokens: 150_000,
        estimatedCostUsd: 40,
      },
    });

    expect(retry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(comments.at(-1)).toContain(
      "The worker has paused instead of continuing silently.",
    );
    expect(comments.at(-1)).toContain("already in Resume when it paused");
    expect(comments.at(-1)).toContain(
      "move it out of Resume (if it is still there) and back into Resume",
    );
  });

  it("preserves stage continuity while a paused unit waits for explicit Resume", async () => {
    let issueState = "Todo";
    const spawnedStageNames: Array<string | null> = [];
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "Resume"];
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
          linearState: "Done",
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    expect(spawnedStageNames).toEqual(["investigate"]);
    const firstDispatchedAt =
      orchestrator.getState().issueFirstDispatchedAt["1"];

    const continuation = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });
    expect(continuation).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      delayType: "continuation",
    });
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issuePassedStages["1"]).toEqual([
      "investigate",
    ]);

    const retryDispatch = await orchestrator.onRetryTimer("1");
    expect(retryDispatch.dispatched).toBe(true);
    expect(spawnedStageNames).toEqual(["investigate", "implement"]);
    orchestrator.getState().issueReworkCounts["1"] = 2;

    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:02:05.000Z"),
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "premium_spend_near_ceiling",
        reason: "Estimated premium spend is near ceiling.",
        turnCount: 2,
        totalTokens: 150_000,
        estimatedCostUsd: 40,
      },
    });

    expect(retry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issuePassedStages["1"]).toEqual([
      "investigate",
    ]);
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);
    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBe(
      firstDispatchedAt,
    );
    expect(
      orchestrator
        .getState()
        .issueExecutionHistory["1"]?.map((record) => record.stageName),
    ).toEqual(["investigate", "implement"]);
    expect(
      orchestrator.getState().issueExecutionHistory["1"]?.[1],
    ).toMatchObject({
      stageName: "implement",
      outcome: "PAUSED-budget",
    });

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();

    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(spawnedStageNames).toEqual([
      "investigate",
      "implement",
      "implement",
    ]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("keeps worker running state when dispatcher lease completion cannot be persisted", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      writeRunJournalEntry: async (entry) => {
        if (entry.lease?.status === "completed") {
          throw new Error("journal disk unavailable");
        }
      },
    });

    await orchestrator.pollTick();

    await expect(
      orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        endedAt: new Date("2026-03-06T00:00:05.000Z"),
      }),
    ).rejects.toThrow("journal disk unavailable");

    const state = orchestrator.getState();
    expect(state.running["1"]).toBeDefined();
    expect(
      state.dispatcherRunJournal.some(
        (entry) => entry.lease?.status === "completed",
      ),
    ).toBe(false);
    expect(timers.scheduled).toEqual([]);
  });

  it("schedules exponential backoff retries for abnormal exits and caps the delay", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({
        agent: { maxRetryBackoffMs: 30_000 },
      }),
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(timers.scheduled[0]?.delayMs).toBe(10_000);
    expect(computeFailureRetryDelayMs(3, 30_000)).toBe(30_000);
  });

  it("does not retry or redispatch a manually stopped issue until explicit Resume", async () => {
    const timers = createFakeTimerScheduler();
    const stopRunningIssue = vi.fn();
    let issueState = "Todo";
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({
      config,
      timerScheduler: timers,
      stopRunningIssue,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
    });

    await orchestrator.pollTick();
    const stopRequest = await orchestrator.requestStopByIdentifier("ISSUE-1");
    expect(stopRequest).toMatchObject({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      reason: "manual_stop",
    });
    expect(stopRunningIssue).toHaveBeenCalledTimes(1);

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped after manual_stop",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(timers.scheduled).toEqual([]);
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const stillTodo = await orchestrator.pollTick();
    expect(stillTodo.dispatchedIssueIds).toEqual([]);

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("does not record a manual-stop resume guard when the stop lease is already active", async () => {
    const timers = createFakeTimerScheduler();
    const stopRunningIssue = vi.fn();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      stopRunningIssue,
    });

    await orchestrator.pollTick();
    orchestrator.getState().dispatcherLeases[
      "dispatcher:1:no-stage:initial:hard_stop_manual_stop"
    ] = {
      leaseId: "dispatcher:1:no-stage:initial:hard_stop_manual_stop",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      operation: "dispatcher",
      ownerId: "other-runtime",
      status: "active",
      acquiredAt: "2026-03-06T00:00:00.000Z",
      expiresAt: "2026-03-06T00:10:00.000Z",
      completedAt: null,
      stage: null,
      attempt: null,
      lastJournalSequence: 1,
    };

    const stopRequest = await orchestrator.requestStopByIdentifier("ISSUE-1");

    expect(stopRequest).toMatchObject({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      reason: "manual_stop",
    });
    expect(stopRunningIssue).not.toHaveBeenCalled();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("does not redispatch a manually stopped issue that was already in Resume", async () => {
    const timers = createFakeTimerScheduler();
    const stopRunningIssue = vi.fn();
    let issueState = "Resume";
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    const orchestrator = createOrchestrator({
      config,
      timerScheduler: timers,
      stopRunningIssue,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
    });

    await orchestrator.pollTick();
    const stopRequest = await orchestrator.requestStopByIdentifier("ISSUE-1");
    expect(stopRequest).toMatchObject({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      reason: "manual_stop",
    });

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "worker exited: codex_protocol_error",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(timers.scheduled).toEqual([]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const stillResume = await orchestrator.pollTick();
    expect(stillResume.dispatchedIssueIds).toEqual([]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    issueState = "Blocked";
    const blocked = await orchestrator.pollTick();
    expect(blocked.dispatchedIssueIds).toEqual([]);

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("applies codex session events to the running entry and aggregate counters", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    const result = orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:04.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 13,
          outputTokens: 8,
          totalTokens: 21,
        },
        rateLimits: {
          requestsRemaining: 9,
        },
        message: "turn completed",
      },
    });

    expect(result).toEqual({ applied: true, rateLimitsUpdated: true });
    expect(orchestrator.getState().running["1"]).toMatchObject({
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexMessage: "turn completed",
      codexTotalTokens: 21,
    });
    expect(orchestrator.getState().codexTotals.totalTokens).toBe(21);
    expect(orchestrator.getState().codexRateLimits).toEqual({
      requestsRemaining: 9,
    });
  });

  it("requeues retry timers when slots are exhausted", async () => {
    const timers = createFakeTimerScheduler();
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
    const orchestrator = createOrchestrator({
      tracker,
      timerScheduler: timers,
      config: createConfig({
        agent: { maxConcurrentAgents: 0 },
      }),
    });

    // Create a queued retry entry without dispatching the issue.
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      identifier: "ISSUE-1",
      error: "no available orchestrator slots",
    });
  });

  it("reschedules timer-fired retry failures when lease expiry persistence fails", async () => {
    const timers = createFakeTimerScheduler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      writeRunJournalEntry: async (entry) => {
        if (entry.lease?.status === "expired") {
          throw new Error("journal disk unavailable");
        }
      },
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "worker failed",
    });
    expect(retryEntry).toMatchObject({ attempt: 1, delayType: "failure" });

    orchestrator.getState().dispatcherLeases["dispatcher:stale:lease"] = {
      leaseId: "dispatcher:stale:lease",
      issueId: "stale",
      issueIdentifier: "STALE-1",
      operation: "dispatcher",
      ownerId: "previous-runtime",
      status: "active",
      acquiredAt: "2026-03-06T00:00:00.000Z",
      expiresAt: "2026-03-06T00:00:01.000Z",
      completedAt: null,
      stage: null,
      attempt: null,
      lastJournalSequence: 1,
    };

    timers.scheduled[0]?.callback();

    await vi.waitFor(() => {
      expect(orchestrator.getState().retryAttempts["1"]).toMatchObject({
        attempt: 2,
        delayType: "failure",
        error: "retry timer failed: journal disk unavailable",
      });
    });
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[orchestrator] Retry timer failed for ISSUE-1: journal disk unavailable",
    );
    warn.mockRestore();
  });

  it("requests stop for stalled sessions before tracker refresh", async () => {
    const stopCalls: Array<{ issueId: string; reason: string }> = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      now: () => new Date("2026-03-06T00:10:00.000Z"),
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
      stopRunningIssue: async (input) => {
        stopCalls.push({ issueId: input.issueId, reason: input.reason });
      },
    });

    await orchestrator.pollTick();
    const runningEntry = orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(stopCalls).toContainEqual({
      issueId: "1",
      reason: "stall_timeout",
    });
  });

  it("skips all dispatch when an open pipeline-halt issue exists", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
  });

  it("dispatches normally when no pipeline-halt issue exists", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("auto-resumes a budget pause via the escalation ladder and scales the next unit", async () => {
    const spawnInputs: Array<{ budgetMultiplier: number }> = [];
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 2, multiplier: 2 },
      }),
      tracker,
      spawnWorker: async (input) => {
        spawnInputs.push({ budgetMultiplier: input.budgetMultiplier });
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    expect(spawnInputs).toEqual([{ budgetMultiplier: 1 }]);

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded: 250001 >= 250000.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5.2,
      },
    });

    // Escalated instead of parking: continuation retry scheduled, no
    // operator-resume requirement, step recorded.
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.delayType).toBe("continuation");
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBe(1);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);

    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);
    expect(spawnInputs).toEqual([
      { budgetMultiplier: 1 },
      { budgetMultiplier: 2 },
    ]);
  });

  it("parks for the operator when the escalation ladder is exhausted", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 1, multiplier: 2 },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueBudgetEscalations["1"] = 1;

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "dollar_budget",
        reason: "Estimated dollar budget exceeded.",
        turnCount: 3,
        totalTokens: 100,
        estimatedCostUsd: 9,
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
  });

  it("never escalates when unconfigured or for non-budget hard stops", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 100,
        estimatedCostUsd: 1,
      },
    });
    // Default config (maxSteps null): parks exactly as before SYMPH-337.
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBeUndefined();
  });

  it("defers escalation to the operator while the admission floor is blocked", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 2, multiplier: 2 },
        rateLimitAdmission: {
          minPrimaryHeadroomPct: null,
          minSecondaryHeadroomPct: 5,
        },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 1,
        totalTokens: 100,
        estimatedCostUsd: 1,
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBeUndefined();
  });

  it("never escalates rate_limit_budget pauses — the ladder cannot relieve a window constraint", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 2, multiplier: 2 },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "rate_limit_budget",
        reason: "Rate-limit budget exceeded.",
        turnCount: 1,
        totalTokens: 100,
        estimatedCostUsd: 1,
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBeUndefined();
  });

  it("carries the escalated multiplier into later dispatches, including operator resumes", async () => {
    const spawnInputs: Array<{ budgetMultiplier: number }> = [];
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 2, multiplier: 2 },
      }),
      tracker,
      spawnWorker: async (input) => {
        spawnInputs.push({ budgetMultiplier: input.budgetMultiplier });
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Two consumed steps (e.g. ladder exhausted, then operator resumed):
    // the widened budget persists for the issue's next unit.
    orchestrator.getState().issueBudgetEscalations["1"] = 2;
    await orchestrator.pollTick();

    expect(spawnInputs).toEqual([{ budgetMultiplier: 4 }]);
  });

  it("defers retry dispatch while the rate-limit admission floor is blocked", async () => {
    const timers = createFakeTimerScheduler();
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      timerScheduler: timers,
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: null,
          minSecondaryHeadroomPct: 5,
        },
      }),
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });
    expect(orchestrator.getState().retryAttempts["1"]).toBeDefined();

    orchestrator.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };

    const result = await orchestrator.onRetryTimer("1");
    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    // Deferred, not consumed: a fresh retry entry exists at the same attempt.
    expect(orchestrator.getState().retryAttempts["1"]).toBeDefined();
    expect(orchestrator.getState().retryAttempts["1"]?.error).toContain(
      "rate-limit admission floor",
    );
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
  });

  it("resumes once on a pause-triage continue verdict when the ladder is unconfigured", async () => {
    const triageCalls: string[] = [];
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 1,
        },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runPauseTriage: async (evidence) => {
        triageCalls.push(evidence.issueIdentifier);
        return {
          verdict: "continue",
          rationale: "Real diff in progress; one unit should finish.",
        };
      },
    });

    await orchestrator.pollTick();
    const budgetPause = {
      outcome: "PAUSED-budget" as const,
      trigger: "token_budget" as const,
      reason: "Token budget exceeded.",
      turnCount: 2,
      totalTokens: 250001,
      estimatedCostUsd: 5,
    };

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });

    expect(triageCalls).toEqual(["ISSUE-1"]);
    expect(retryEntry?.delayType).toBe("continuation");
    expect(orchestrator.getState().issuePauseTriageResumes["1"]).toBe(1);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);

    // Resume bound exhausted: the next pause parks without consulting triage.
    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);
    const second = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });
    expect(second).toBeNull();
    expect(triageCalls).toEqual(["ISSUE-1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
  });

  it("parks with the verdict recorded on hold/split or triage failure", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const comments: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
      runPauseTriage: async () => ({
        verdict: "hold",
        rationale: "Worker is repeating discovery; needs human review.",
      }),
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "dollar_budget",
        reason: "Estimated dollar budget exceeded.",
        turnCount: 3,
        totalTokens: 100,
        estimatedCostUsd: 9,
      },
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(
      orchestrator.getState().issuePauseTriageResumes["1"],
    ).toBeUndefined();
    expect(
      comments.some((body) => body.includes("Pause triage verdict: hold")),
    ).toBe(true);
  });

  it("lets the ladder absorb pauses before triage is consulted", async () => {
    const triageCalls: string[] = [];
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        budgetEscalation: { maxSteps: 1, multiplier: 2 },
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runPauseTriage: async (evidence) => {
        triageCalls.push(
          `${evidence.issueIdentifier}:steps=${evidence.escalationStepsUsed}`,
        );
        return { verdict: "continue", rationale: "Keep going." };
      },
    });

    await orchestrator.pollTick();
    const budgetPause = {
      outcome: "PAUSED-budget" as const,
      trigger: "token_budget" as const,
      reason: "Token budget exceeded.",
      turnCount: 2,
      totalTokens: 250001,
      estimatedCostUsd: 5,
    };

    // First pause: ladder absorbs it without any triage call.
    const first = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });
    expect(first?.delayType).toBe("continuation");
    expect(triageCalls).toEqual([]);

    // Second pause: ladder exhausted, triage consulted with the step count.
    await orchestrator.onRetryTimer("1");
    const second = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });
    expect(second?.delayType).toBe("continuation");
    expect(triageCalls).toEqual(["ISSUE-1:steps=1"]);
  });

  it("parks immediately and applies the deferred continue verdict when it arrives", async () => {
    const deferred: Array<() => Promise<void>> = [];
    let resolveVerdict: (v: {
      verdict: "continue";
      rationale: string;
    }) => void = () => {};
    const comments: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
      runPauseTriage: () =>
        new Promise((resolve) => {
          resolveVerdict = resolve;
        }),
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5,
      },
    });

    // The exit path never waited on the model: parked immediately. The
    // only queued work is the park-generation capture, not the verdict.
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(deferred).toHaveLength(1);
    await deferred[0]?.();

    // The verdict lands later and is applied as a serialized task.
    resolveVerdict({
      verdict: "continue",
      rationale: "Real progress; one more unit should finish.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deferred).toHaveLength(2);
    await deferred[1]?.();

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    expect(orchestrator.getState().issuePauseTriageResumes["1"]).toBe(1);
    expect(orchestrator.getState().retryAttempts["1"]?.delayType).toBe(
      "continuation",
    );
    expect(
      comments.some((body) =>
        body.includes("Pause triage verdict: continue (resume 1/2)"),
      ),
    ).toBe(true);
  });

  it("never lets a stale verdict resume a different, later pause cycle", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const verdictResolvers: Array<
      (v: { verdict: "continue"; rationale: string } | null) => void
    > = [];
    const budgetPause = {
      outcome: "PAUSED-budget" as const,
      trigger: "token_budget" as const,
      reason: "Token budget exceeded.",
      turnCount: 2,
      totalTokens: 250001,
      estimatedCostUsd: 5,
    };
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runPauseTriage: () =>
        new Promise((resolve) => {
          verdictResolvers.push(resolve);
        }),
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    // Pause A parks the issue; its park-generation capture runs.
    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });
    await deferred[0]?.();

    // Operator resumes; the issue re-dispatches and pauses AGAIN within
    // what used to be the staleness window (same fake clock instant).
    orchestrator.getState().resumeRequired.delete("1");
    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: budgetPause,
    });

    // Pause A's verdict finally lands — it must NOT resume pause B.
    verdictResolvers[0]?.({ verdict: "continue", rationale: "Stale." });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[deferred.length - 1]?.();

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(
      orchestrator.getState().issuePauseTriageResumes["1"],
    ).toBeUndefined();
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
  });

  it("leaves the park standing when the deferred triage promise rejects", async () => {
    const deferred: Array<() => Promise<void>> = [];
    let rejectVerdict: (error: Error) => void = () => {};
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runPauseTriage: () =>
        new Promise((_resolve, reject) => {
          rejectVerdict = reject;
        }),
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5,
      },
    });
    await deferred[0]?.();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rejectVerdict(new Error("endpoint exploded"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[1]?.();
    warn.mockRestore();

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(
      orchestrator.getState().issuePauseTriageResumes["1"],
    ).toBeUndefined();
  });

  it("leaves the park standing on a deferred hold verdict", async () => {
    const deferred: Array<() => Promise<void>> = [];
    let resolveVerdict: (v: { verdict: "hold"; rationale: string }) => void =
      () => {};
    const comments: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        pauseTriage: {
          baseUrl: "http://studio2.local:8000/v1",
          model: "deepseek-v4-flash",
          apiKey: null,
          maxResumes: 2,
        },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
      runPauseTriage: () =>
        new Promise((resolve) => {
          resolveVerdict = resolve;
        }),
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "dollar_budget",
        reason: "Estimated dollar budget exceeded.",
        turnCount: 3,
        totalTokens: 100,
        estimatedCostUsd: 9,
      },
    });

    await deferred[0]?.();
    resolveVerdict({
      verdict: "hold",
      rationale: "Worker is spinning; needs human review.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[1]?.();

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();
    expect(
      comments.some((body) => body.includes("Pause triage verdict: hold")),
    ).toBe(true);
  });

  it("holds investigate at the AC gate, then routes pass/rework/fail-open verdicts", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const comments: string[] = [];
    let verdict: { verdict: "pass" | "rework"; feedback: string } | null = null;
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      acGate: { enabled: true },
      stages: {
        initialStage: "investigate",
        fastTrack: null,
        stages: {
          investigate: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: "implement",
              onRework: null,
              onApprove: null,
            },
          },
          implement: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: { onComplete: null, onRework: null, onApprove: null },
          },
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_id, body) => {
        comments.push(body);
      },
      runAcGate: async () => verdict,
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    // Exit investigate: HELD — no retry entry, no park, claim kept.
    verdict = { verdict: "rework", feedback: "AC 2 is untestable; tag it." };
    const held = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] workpad updated",
    });
    expect(held).toBeNull();
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    expect(orchestrator.getState().retryAttempts["1"]).toBeUndefined();

    // Rework verdict: same stage reruns with feedback comment.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[0]?.();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(orchestrator.getState().retryAttempts["1"]?.delayType).toBe(
      "continuation",
    );
    expect(
      comments.some((body) => body.includes("Review Findings (AC gate)")),
    ).toBe(true);

    // Re-run, then a pass verdict advances to implement.
    await orchestrator.onRetryTimer("1");
    verdict = { verdict: "pass", feedback: "All criteria falsifiable." };
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] ACs revised",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[1]?.();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Fail-open: null verdict also advances (implement has no on_complete:
    // exiting it completes the issue).
    await orchestrator.onRetryTimer("1");
    verdict = null;
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] done",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // implement is not the initial stage — gate does not hold it.
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("fires the advisory spec-fidelity judge at review exit and records the verdict", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const comments: string[] = [];
    const judged: string[] = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      specFidelity: { enabled: true },
      stages: {
        initialStage: "review",
        fastTrack: null,
        stages: {
          review: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: null,
              onRework: "review",
              onApprove: null,
            },
          },
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_id, body) => {
        comments.push(body);
      },
      runSpecFidelityJudge: async (evidence) => {
        judged.push(evidence.issueIdentifier);
        return {
          verdict: "rework",
          findings: "AC1 FAIL: named test absent from diff.",
        };
      },
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    await orchestrator.pollTick();
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] review done",
    });

    // Advisory: the stage advanced normally without waiting on the judge.
    expect(retryEntry).toBeNull();
    expect(judged).toEqual(["ISSUE-1"]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const verdictTask = deferred[deferred.length - 1];
    await verdictTask?.();

    expect(
      comments.some((body) =>
        body.includes("Spec-fidelity verdict (independent judge): rework"),
      ),
    ).toBe(true);
    const journal = orchestrator
      .getState()
      .dispatcherRunJournal.filter((e) => e.kind === "spec_fidelity");
    expect(journal).toHaveLength(1);
  });

  it("freezes the gate-passed AC snapshot, serves it to dispatch and the judge, and clears it at terminal (SYMPH-374)", async () => {
    const deferred: Array<() => Promise<void>> = [];
    const judgedAcs: Array<string | null> = [];
    const dispatchedAcs: Array<string | null> = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      acGate: { enabled: true },
      specFidelity: { enabled: true },
      stages: {
        initialStage: "investigate",
        fastTrack: null,
        stages: {
          investigate: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: "review",
              onRework: null,
              onApprove: null,
            },
          },
          review: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: null,
              onRework: "review",
              onApprove: null,
            },
          },
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async (input) => {
        dispatchedAcs.push(input.acceptanceCriteria);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async () => {},
      runAcGate: async () => ({
        verdict: "pass" as const,
        feedback: "All criteria falsifiable.",
      }),
      runSpecFidelityJudge: async (evidence) => {
        judgedAcs.push(evidence.acceptanceCriteria);
        return { verdict: "pass", findings: "AC1 PASS: covered by diff." };
      },
      scheduleDeferred: (task) => {
        deferred.push(task);
      },
    });

    const expectedSnapshot = [
      "### Acceptance Criteria",
      "- [ ] `test: tests/foo.test.ts covers bar`",
      "- [ ] `check: npx tsc --noEmit exits 0`",
    ].join("\n");

    await orchestrator.pollTick();
    expect(dispatchedAcs).toEqual([null]);

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: [
        "Investigation workpad posted.",
        "### Acceptance Criteria",
        "- [ ] `test: tests/foo.test.ts covers bar`",
        "- [ ] `check: npx tsc --noEmit exits 0`",
        "### Validation",
        "- npx vitest run tests/foo.test.ts",
        "[STAGE_COMPLETE]",
      ].join("\n"),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await deferred[0]?.();

    // Frozen in state and journaled for replay.
    expect(orchestrator.getState().issueAcSnapshots["1"]).toBe(
      expectedSnapshot,
    );
    const gateEntry = orchestrator
      .getState()
      .dispatcherRunJournal.find((entry) => entry.kind === "ac_gate");
    expect(gateEntry?.metadata.acceptanceCriteria).toBe(expectedSnapshot);

    // The review dispatch renders the snapshot into the prompt context.
    expect(orchestrator.getState().issueStages["1"]).toBe("review");
    await orchestrator.onRetryTimer("1");
    expect(dispatchedAcs).toEqual([null, expectedSnapshot]);

    // The judge receives the frozen snapshot, never null.
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE] review done",
    });
    expect(judgedAcs).toEqual([expectedSnapshot]);
    expect(orchestrator.getState().completed.has("1")).toBe(true);

    // Terminal completion clears the snapshot — a redispatched issue id
    // must never be judged against a stale rubric (council R1 P1).
    expect(orchestrator.getState().issueAcSnapshots["1"]).toBeUndefined();
  });

  it("posts the admission card once, on first dispatch only (SYMPH-379)", async () => {
    const comments: string[] = [];
    let spawnCount = 0;
    const orchestrator = new OrchestratorCore({
      config: createConfig({ admissionCard: { enabled: true } }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => {
        spawnCount += 1;
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_id, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cards = comments.filter((body) => body.includes("## Admission Card"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("**Issue:** ISSUE-1");
    expect(cards[0]).toContain("**Right-sizing:**");
    // No AC snapshot exists at first dispatch, so the card must render the
    // not-yet-frozen branch of the verification path (council R1 P3).
    expect(cards[0]).toContain(
      "**Verification path:** acceptance criteria not yet frozen",
    );

    // A continuation dispatch of the same issue (normal exit without a
    // completion signal) genuinely re-dispatches — and does not re-card.
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });
    await orchestrator.onRetryTimer("1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnCount).toBe(2);
    expect(
      comments.filter((body) => body.includes("## Admission Card")),
    ).toHaveLength(1);
  });

  it("does not re-post the admission card after a restart — the first-dispatch marker survives journal recovery (SYMPH-379, council R1 P2)", async () => {
    const comments: string[] = [];
    const makeTracker = () =>
      createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      });
    const first = new OrchestratorCore({
      config: createConfig({ admissionCard: { enabled: true } }),
      tracker: makeTracker(),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_id, body) => {
        comments.push(body);
      },
    });
    await first.pollTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      comments.filter((body) => body.includes("## Admission Card")),
    ).toHaveLength(1);

    // Restart: a new core recovers from the first run's journal. The clock
    // has advanced past the recovered lease TTL, so the issue is genuinely
    // dispatchable again — only the journal carries dispatch history.
    let redispatched = false;
    const second = new OrchestratorCore({
      config: createConfig({ admissionCard: { enabled: true } }),
      tracker: makeTracker(),
      spawnWorker: async () => {
        redispatched = true;
        return {
          workerHandle: { pid: 1002 },
          monitorHandle: { ref: "monitor-2" },
        };
      },
      now: () => new Date("2026-03-06T02:00:00.000Z"),
      postComment: async (_id, body) => {
        comments.push(body);
      },
      runJournal: first.getState().dispatcherRunJournal,
    });

    // The marker is rehydrated from the journaled right_sizing entry...
    expect(second.getState().issueFirstDispatchedAt["1"]).toBeDefined();

    // ...so the post-restart dispatch is not treated as a first dispatch.
    await second.pollTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redispatched).toBe(true);
    expect(
      comments.filter((body) => body.includes("## Admission Card")),
    ).toHaveLength(1);
  });

  it("rehydrates gate-passed AC snapshots from the run journal (SYMPH-374)", () => {
    const journalEntry = (
      sequence: number,
      metadata: Record<string, unknown>,
    ) => ({
      sequence,
      idempotencyKey: `ac_gate:test:${sequence}`,
      timestamp: "2026-03-06T00:00:05.000Z",
      kind: "ac_gate" as const,
      issueId: `${sequence}`,
      issueIdentifier: `ISSUE-${sequence}`,
      operation: "dispatcher" as const,
      stage: "investigate",
      attempt: null,
      ownerId: "orchestrator-core",
      lease: null,
      summary: "AC gate verdict.",
      metadata,
    });
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker: createTracker({ candidates: [] }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runJournal: [
        journalEntry(1, {
          status: "completed",
          verdict: "pass",
          acceptanceCriteria: "### Acceptance Criteria\n- [ ] `check: ok`",
        }),
        // Rework verdicts and snapshot-less entries must not rehydrate.
        journalEntry(2, {
          status: "completed",
          verdict: "rework",
          acceptanceCriteria: "### Acceptance Criteria\n- rejected",
        }),
        journalEntry(3, {
          status: "completed",
          verdict: "pass_open",
          acceptanceCriteria: null,
        }),
      ],
    });

    expect(orchestrator.getState().issueAcSnapshots).toEqual({
      "1": "### Acceptance Criteria\n- [ ] `check: ok`",
    });
  });

  it("clears a replay-rehydrated AC snapshot on fresh admission — a new run never inherits a prior run's rubric (SYMPH-374)", async () => {
    const dispatchedAcs: Array<string | null> = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      stages: {
        initialStage: "investigate",
        fastTrack: null,
        stages: {
          investigate: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: null,
              onRework: null,
              onApprove: null,
            },
          },
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async (input) => {
        dispatchedAcs.push(input.acceptanceCriteria);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      runJournal: [
        {
          sequence: 1,
          idempotencyKey: "ac_gate:stale:1",
          timestamp: "2026-03-05T00:00:05.000Z",
          kind: "ac_gate" as const,
          issueId: "1",
          issueIdentifier: "ISSUE-1",
          operation: "dispatcher" as const,
          stage: "investigate",
          attempt: null,
          ownerId: "orchestrator-core",
          lease: null,
          summary: "AC gate verdict from a prior completed run.",
          metadata: {
            status: "completed",
            verdict: "pass",
            acceptanceCriteria: "### Acceptance Criteria\n- stale rubric",
          },
        },
      ],
    });

    // Rehydration restored the prior run's snapshot...
    expect(orchestrator.getState().issueAcSnapshots["1"]).toBe(
      "### Acceptance Criteria\n- stale rubric",
    );

    // ...but a fresh admission (no live or gate-recovered stage) must not
    // inherit it: dispatch serves null and the stale entry is gone.
    await orchestrator.pollTick();
    expect(dispatchedAcs).toEqual([null]);
    expect(orchestrator.getState().issueAcSnapshots["1"]).toBeUndefined();
  });

  it("never consults triage for non-budget hard stops or while the floor is blocked", async () => {
    const triageCalls: string[] = [];
    const makeOrchestrator = (rateLimitAdmission?: {
      minPrimaryHeadroomPct: number | null;
      minSecondaryHeadroomPct: number | null;
    }) =>
      new OrchestratorCore({
        config: createConfig({
          pauseTriage: {
            baseUrl: "http://studio2.local:8000/v1",
            model: "deepseek-v4-flash",
            apiKey: null,
            maxResumes: 2,
          },
          ...(rateLimitAdmission === undefined ? {} : { rateLimitAdmission }),
        }),
        tracker: createTracker({
          candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
          statesById: [
            { id: "1", identifier: "ISSUE-1", state: "In Progress" },
          ],
        }),
        spawnWorker: async () => ({
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        }),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
        runPauseTriage: async (evidence) => {
          triageCalls.push(evidence.issueIdentifier);
          return { verdict: "continue", rationale: "Keep going." };
        },
      });

    // Non-budget hard stop (STALLED iteration cap): triage never consulted.
    const stalled = makeOrchestrator();
    await stalled.pollTick();
    const stalledEntry = await stalled.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "STALLED",
        trigger: "iteration_cap",
        reason: "Iteration cap reached.",
        turnCount: 5,
        totalTokens: 100,
        estimatedCostUsd: 1,
      },
    });
    expect(stalledEntry).toBeNull();
    expect(triageCalls).toEqual([]);

    // Budget pause with the admission floor blocked: triage never consulted.
    const gated = makeOrchestrator({
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: 5,
    });
    await gated.pollTick();
    gated.getState().codexRateLimits = {
      secondary: {
        used_percent: 98,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };
    const gatedEntry = await gated.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 100,
        estimatedCostUsd: 1,
      },
    });
    expect(gatedEntry).toBeNull();
    expect(triageCalls).toEqual([]);
    expect(gated.getState().resumeRequired.has("1")).toBe(true);
  });

  it("admits a wedged Resume pause when the tracker shows a newer transition into Resume", async () => {
    const transitionCalls: Array<{ issueId: string; stateName: string }> = [];
    let transitionAt: string | null = null;
    let nowIso = "2026-03-06T00:10:00.000Z";
    const spawns: string[] = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
        ],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
        latestStateTransitionAt: async (issueId, stateName) => {
          transitionCalls.push({ issueId, stateName });
          return transitionAt;
        },
      }),
      spawnWorker: async (input) => {
        spawns.push(input.issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date(nowIso),
    });

    // Dispatch from Resume, then pause IN Resume — the wedged-guard shape.
    await orchestrator.pollTick();
    expect(spawns).toEqual(["1"]);
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5,
      },
    });
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    // No transition evidence: observation can never arrive (the issue only
    // ever appears in Resume), so the issue stays parked.
    transitionAt = null;
    await orchestrator.pollTick();
    expect(spawns).toEqual(["1"]);

    // A transition OLDER than the pause is stale evidence.
    nowIso = "2026-03-06T00:12:00.000Z";
    transitionAt = "2026-03-06T00:05:00.000Z";
    await orchestrator.pollTick();
    expect(spawns).toEqual(["1"]);

    // A transition NEWER than the pause (beyond the skew margin) is
    // explicit operator resume evidence — admits without any state dance.
    nowIso = "2026-03-06T00:14:00.000Z";
    transitionAt = "2026-03-06T00:15:00.000Z";
    await orchestrator.pollTick();
    expect(spawns).toEqual(["1", "1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    expect(
      transitionCalls.every(
        (call) => call.issueId === "1" && call.stateName === "Resume",
      ),
    ).toBe(true);
  });

  it("treats transitions inside the clock-skew margin as ambiguous and throttles lookups", async () => {
    const lookups: number[] = [];
    let transitionAt: string | null = "2026-03-06T00:10:30.000Z";
    let nowIso = "2026-03-06T00:10:00.000Z";
    const spawns: string[] = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
        ],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
        latestStateTransitionAt: async () => {
          lookups.push(1);
          return transitionAt;
        },
      }),
      spawnWorker: async (input) => {
        spawns.push(input.issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date(nowIso),
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5,
      },
    });
    expect(spawns).toEqual(["1"]);

    // 30s after the pause is inside the 60s skew margin — ambiguous, parked.
    await orchestrator.pollTick();
    expect(spawns).toEqual(["1"]);
    expect(lookups).toHaveLength(1);

    // Immediate re-poll is throttled: no second lookup within 60s.
    await orchestrator.pollTick();
    expect(lookups).toHaveLength(1);

    // Past the throttle window with evidence beyond the margin: admits.
    nowIso = "2026-03-06T00:12:00.000Z";
    transitionAt = "2026-03-06T00:11:30.000Z";
    await orchestrator.pollTick();
    expect(lookups).toHaveLength(2);
    expect(spawns).toEqual(["1", "1"]);
  });

  it("keeps observation-only semantics when the tracker lacks history support", async () => {
    const spawns: string[] = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        activeStates: ["Todo", "In Progress", "In Review", "Resume"],
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
        ],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "Resume" }],
      }),
      spawnWorker: async (input) => {
        spawns.push(input.issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:10:00.000Z"),
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: {
        outcome: "PAUSED-budget",
        trigger: "token_budget",
        reason: "Token budget exceeded.",
        turnCount: 2,
        totalTokens: 250001,
        estimatedCostUsd: 5,
      },
    });

    await orchestrator.pollTick();
    expect(spawns).toEqual(["1"]);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);
  });

  it("enforces a live write collision by stopping exactly the lower-precedence lane", async () => {
    const comments: Array<{ issueId: string; body: string }> = [];
    const baseConfig = createConfig();
    const config = {
      ...baseConfig,
      stages: {
        initialStage: "investigate",
        fastTrack: null,
        stages: {
          investigate: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: {
              onComplete: "implement",
              onRework: null,
              onApprove: null,
            },
          },
          implement: {
            type: "agent" as const,
            runner: null,
            model: null,
            maxTurns: null,
            maxRework: null,
            gateType: null,
            prompt: null,
            promptPath: null,
            reviewers: [],
            hardStops: null,
            linearState: null,
            mcpServers: {},
            timeoutMs: null,
            concurrency: null,
            transitions: { onComplete: null, onRework: null, onApprove: null },
          },
        },
      },
    };
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1" }),
          createIssue({ id: "2", identifier: "ISSUE-2" }),
        ],
        statesById: [
          { id: "1", identifier: "ISSUE-1", state: "In Progress" },
          { id: "2", identifier: "ISSUE-2", state: "In Progress" },
        ],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (issueId, body) => {
        comments.push({ issueId, body });
      },
      getRunningSupervisionSnapshots: async (entries) =>
        entries.map((entry) => ({
          workerId: entry.issue.id,
          issueIdentifier: entry.identifier,
          branchName: `branch-${entry.issue.id}`,
          declaredFileScope: [],
          changedFiles: ["src/orchestrator/runtime-host.ts"],
          evalFileScope: [],
        })),
    });

    await orchestrator.pollTick();
    expect(Object.keys(orchestrator.getState().running)).toHaveLength(2);

    // Advance issue 1 to implement so it outranks issue 2 (investigate).
    orchestrator.getState().issueStages["1"] = "implement";
    orchestrator.getState().issueStages["2"] = "investigate";

    const result = await orchestrator.pollTick();
    const collisionStops = result.stopRequests.filter(
      (stop) => stop.issueId === "2",
    );
    expect(collisionStops).toHaveLength(1);
    expect(result.stopRequests.some((stop) => stop.issueId === "1")).toBe(
      false,
    );
    expect(
      comments.some(
        (c) =>
          c.issueId === "2" &&
          c.body.includes(
            "Supervision enforcement: paused for write collision",
          ),
      ),
    ).toBe(true);
  });

  it("refuses all dispatch when rate-limit headroom is below the configured floor", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
      }),
      // pollTick "now" is 2026-03-06T00:00:05Z (epoch 1772755205).
    });
    orchestrator.getState().codexRateLimits = {
      limit_id: "codex",
      primary: {
        used_percent: 40,
        window_minutes: 300,
        resets_at: 1772760000,
      },
      secondary: {
        used_percent: 98,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };

    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
    expect(orchestrator.getState().rateLimitAdmission).toMatchObject({
      blocked: true,
      minSecondaryHeadroomPct: 5,
      primaryUsedPercent: 40,
      secondaryUsedPercent: 98,
    });
    expect(orchestrator.getState().rateLimitAdmission?.reason).toContain(
      "secondary window headroom 2.0% < 5% floor",
    );
  });

  it("dispatches when a low-headroom snapshot has expired past resets_at", async () => {
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
      }),
    });
    // Both resets_at are before the orchestrator clock (1772755205): the
    // windows have rolled over, so the stale snapshot must not block.
    orchestrator.getState().codexRateLimits = {
      primary: {
        used_percent: 99,
        window_minutes: 300,
        resets_at: 1772755000,
      },
      secondary: {
        used_percent: 99,
        window_minutes: 10080,
        resets_at: 1772755100,
      },
    };

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(orchestrator.getState().rateLimitAdmission).toMatchObject({
      blocked: false,
      primaryUsedPercent: null,
      secondaryUsedPercent: null,
    });
  });

  it("fails open with no rate-limit snapshot and stays inert when unconfigured", async () => {
    const noSnapshotTracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const gated = createOrchestrator({
      tracker: noSnapshotTracker,
      config: createConfig({
        rateLimitAdmission: {
          minPrimaryHeadroomPct: 10,
          minSecondaryHeadroomPct: 5,
        },
      }),
    });

    const gatedResult = await gated.pollTick();
    expect(gatedResult.dispatchedIssueIds).toEqual(["1"]);
    expect(gated.getState().rateLimitAdmission).toMatchObject({
      blocked: false,
      reason: null,
    });

    const unconfiguredTracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const unconfigured = createOrchestrator({ tracker: unconfiguredTracker });
    unconfigured.getState().codexRateLimits = {
      secondary: {
        used_percent: 99.5,
        window_minutes: 10080,
        resets_at: 1772800000,
      },
    };

    const unconfiguredResult = await unconfigured.pollTick();
    expect(unconfiguredResult.dispatchedIssueIds).toEqual(["1"]);
    expect(unconfigured.getState().rateLimitAdmission).toBeNull();
  });

  it("dispatches normally when pipeline-halt issue is in terminal state", async () => {
    const closedHaltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "Done",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [closedHaltIssue];
        }
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("continues dispatch when fetchIssuesByLabels throws an error", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        throw new Error("Linear API error");
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("dispatches normally when tracker does not implement fetchIssuesByLabels", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      // Note: fetchIssuesByLabels is not implemented (optional)
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });
  it("uses fetchOpenIssuesByLabels for halt check when available (P2: server-side filtering)", async () => {
    let openIssuesByLabelsCalled = false;
    let issuesByLabelsCalled = false;

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        issuesByLabelsCalled = true;
        return [];
      },
      async fetchOpenIssuesByLabels() {
        openIssuesByLabelsCalled = true;
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    await orchestrator.pollTick();

    expect(openIssuesByLabelsCalled).toBe(true);
    expect(issuesByLabelsCalled).toBe(false);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels throws", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    // Should halt dispatch because the fallback found the halt issue
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
  });
});

describe("retry timer pipeline-halt guard", () => {
  it("skips dispatch and requeues retry at same attempt when pipeline is halted", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchOpenIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Manually set up a retry entry at attempt 2
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should NOT dispatch
    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(spawnCalls).toEqual([]);

    // Should requeue at the SAME attempt (2), not increment to 3
    expect(result.retryEntry).not.toBeNull();
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      identifier: "ISSUE-1",
      error: "pipeline halted: SYMPH-99",
      delayType: "failure",
    });

    // Claim should still be held
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("dispatches normally when halt check returns no open issues", async () => {
    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
      async fetchOpenIssuesByLabels() {
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Set up a retry entry
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(true);
    expect(result.released).toBe(false);
    expect(spawnCalls).toEqual(["1"]);
  });

  it("continues dispatch when halt check throws (fail-open)", async () => {
    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Set up a retry entry
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should proceed with dispatch despite halt check failure
    expect(result.dispatched).toBe(true);
    expect(spawnCalls).toEqual(["1"]);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels throws", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should halt because fallback found the halt issue
    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toMatchObject({
      attempt: 2,
      error: "pipeline halted: SYMPH-99",
    });
    expect(spawnCalls).toEqual([]);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels is not available", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      // Only fetchIssuesByLabels, no fetchOpenIssuesByLabels
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toMatchObject({
      attempt: 2,
      error: "pipeline halted: SYMPH-99",
    });
    expect(spawnCalls).toEqual([]);
  });
});

describe("dispatcher run journal restart recovery", () => {
  it("restart recovery prevents duplicate dispatch after crash between decision emission and side effect", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
      spawnWorker,
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "dispatcher:1:no-stage:initial:lease:admission",
          kind: "admission",
          operation: "dispatcher",
          leaseId: "dispatcher:1:no-stage:initial:lease",
          leaseStatus: "active",
          expiresAt: "2026-03-06T00:20:00.000Z",
        }),
      ],
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("restart recovery preserves budget hard-stop pause until explicit Resume", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "Resume"];
    let issueState = "Todo";
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
      spawnWorker,
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "hard_stop:1:investigate:initial:token_budget:1",
          kind: "hard_stop_trigger",
          operation: "dispatcher",
          leaseId: "hard_stop:1:investigate:initial:token_budget:1",
          leaseStatus: "completed",
          stage: "investigate",
          metadata: {
            status: "completed",
            outcome: "PAUSED-budget",
            trigger: "token_budget",
            reason: "Token budget exceeded: 300000 >= 200000.",
            issueState: "Todo",
          },
        }),
      ],
    });

    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const stillTodo = await orchestrator.pollTick();
    expect(stillTodo.dispatchedIssueIds).toEqual([]);
    expect(spawnWorker).not.toHaveBeenCalled();

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("journals retry exhaustion and keeps the park across restart replay", async () => {
    const comments: string[] = [];
    const config = createConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    // Exhaust the failure budget in one step.
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]\nCannot satisfy the ticket.",
    });
    expect(retryEntry).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const journal = orchestrator.getState().dispatcherRunJournal;
    const exhausted = journal.filter((e) => e.kind === "failure_exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.summary).toContain("Parked for operator");

    // A cold restart replays the journal: the issue must stay parked, not
    // silently re-dispatch.
    const spawns: string[] = [];
    const restarted = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async (input) => {
        spawns.push(input.issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T01:00:00.000Z"),
      runJournal: journal,
    });

    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
    await restarted.pollTick();
    expect(spawns).toEqual([]);
  });

  it("restart recovery admits a replay-wedged Resume pause on newer tracker evidence", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "Resume"];
    let transitionAt: string | null = null;
    let nowIso = "2026-03-06T01:00:00.000Z";
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
        ],
        latestStateTransitionAt: async () => transitionAt,
      }),
      spawnWorker,
      now: () => new Date(nowIso),
      runJournal: [
        // Pause recorded while the issue was already IN Resume — after a
        // restart, replay re-creates the wedged guard and the issue can
        // never be observed in a non-Resume state.
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "hard_stop:1:implement:initial:token_budget:1",
          kind: "hard_stop_trigger",
          operation: "dispatcher",
          leaseId: "hard_stop:1:implement:initial:token_budget:1",
          leaseStatus: "completed",
          stage: "implement",
          metadata: {
            status: "completed",
            outcome: "PAUSED-budget",
            trigger: "token_budget",
            reason: "Token budget exceeded: 300000 >= 250000.",
            issueState: "Resume",
          },
        }),
      ],
    });

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    // Replay-wedged: Resume-only observations never clear the guard.
    const wedged = await orchestrator.pollTick();
    expect(wedged.dispatchedIssueIds).toEqual([]);

    // Evidence older than the journaled pause stays parked.
    nowIso = "2026-03-06T01:02:00.000Z";
    transitionAt = "2026-03-05T23:00:00.000Z";
    const stale = await orchestrator.pollTick();
    expect(stale.dispatchedIssueIds).toEqual([]);

    // Operator re-entered Resume after the pause: admit without a dance.
    nowIso = "2026-03-06T01:04:00.000Z";
    transitionAt = "2026-03-06T00:59:00.000Z";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("restart recovery preserves input-required pause until explicit Resume", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const config = createConfig();
    config.tracker.activeStates = ["Todo", "Resume"];
    let issueState = "Todo";
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidatesFn: () => [
          createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
        ],
      }),
      spawnWorker,
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "operator_input_required:1:investigate:initial",
          kind: "operator_input_required",
          operation: "dispatcher",
          leaseId: "operator_input_required:1:investigate:initial",
          leaseStatus: "completed",
          stage: "investigate",
          metadata: {
            status: "completed",
            reason: `${ERROR_CODES.codexUserInputRequired}: Codex requested operator input during a turn.`,
            errorCode: ERROR_CODES.codexUserInputRequired,
            issueState: "Todo",
          },
        }),
      ],
    });

    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const stillTodo = await orchestrator.pollTick();
    expect(stillTodo.dispatchedIssueIds).toEqual([]);
    expect(spawnWorker).not.toHaveBeenCalled();

    issueState = "Resume";
    const resumed = await orchestrator.pollTick();
    expect(resumed.dispatchedIssueIds).toEqual(["1"]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
  });

  it("restart recovery does not re-block a hard-stop pause consumed by later dispatch", async () => {
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const config = createConfig();
    config.tracker.activeStates = ["In Progress", "Resume"];
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", state: "In Progress" }),
        ],
      }),
      spawnWorker,
      now: () => new Date("2026-03-06T00:10:00.000Z"),
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "hard_stop:1:investigate:initial:token_budget:1",
          kind: "hard_stop_trigger",
          operation: "dispatcher",
          leaseId: "hard_stop:1:investigate:initial:token_budget:1",
          leaseStatus: "completed",
          stage: "investigate",
          metadata: {
            status: "completed",
            outcome: "PAUSED-budget",
            trigger: "token_budget",
            reason: "Token budget exceeded: 300000 >= 200000.",
            issueState: "Todo",
          },
        }),
        createJournalEntry({
          sequence: 2,
          idempotencyKey: "dispatcher:1:no-stage:initial:admission",
          kind: "admission",
          operation: "dispatcher",
          leaseId: "dispatcher:1:no-stage:initial:lease",
          leaseStatus: "active",
          expiresAt: "2026-03-06T00:01:00.000Z",
          metadata: {
            status: "started",
            attemptKey: "initial",
          },
        }),
      ],
    });

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);

    const result = await orchestrator.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it("restart recovery avoids duplicate gate side effect after crash during gate", async () => {
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "pass",
    }));
    const orchestrator = new OrchestratorCore({
      config: createGateConfig(),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      runEnsembleGate,
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey: "gate:1:review_gate:initial:lease:started",
          kind: "gate_started",
          operation: "gate",
          stage: "review_gate",
          leaseId: "gate:1:review_gate:initial:lease",
          leaseStatus: "active",
          expiresAt: "2026-03-06T00:20:00.000Z",
        }),
      ],
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(runEnsembleGate).not.toHaveBeenCalled();
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("restart recovery skips completed tracker write after crash during tracker write", async () => {
    const updateIssueState = vi.fn(async () => {});
    const spawnWorker = vi.fn(async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }));
    const orchestrator = new OrchestratorCore({
      config: createLinearStateStageConfig(),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      }),
      spawnWorker,
      updateIssueState,
      runJournal: [
        createJournalEntry({
          sequence: 1,
          idempotencyKey:
            "tracker_write:1:stage:implement:In Progress:initial:completed",
          kind: "tracker_write",
          operation: "tracker_write",
          stage: "implement",
          leaseId:
            "tracker_write:1:implement:initial:tracker_write_1_stage_implement_In_Progress_initial",
          leaseStatus: "completed",
          completedAt: "2026-03-06T00:00:03.000Z",
        }),
      ],
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const result = await orchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(updateIssueState).not.toHaveBeenCalled();
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });
});

describe("continuous feedback lane", () => {
  it("records a non-authoritative feedback pass checkpoint", async () => {
    const runContinuousFeedback = vi.fn(() => ({
      summary: "No issues found.",
      findings: [],
    }));
    const orchestrator = createOrchestrator({ runContinuousFeedback });

    await orchestrator.pollTick();
    const result = await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });

    expect(result).toMatchObject({
      ran: true,
      status: "pass",
      findingSignatures: [],
      reviewerLane: {
        runner: "pi",
        model: "local-flash",
        role: "continuous-feedback",
      },
      workerLane: {
        runner: "codex",
        model: null,
        role: "worker",
      },
    });
    expect(orchestrator.getState().continuousFeedback["1"]).toMatchObject({
      status: "pass",
      findings: [],
    });
    expect(orchestrator.getState().dispatcherRunJournal.at(-1)).toMatchObject({
      kind: "continuous_feedback",
      operation: "feedback_lane",
      metadata: {
        status: "pass",
        authoritative: false,
      },
    });
  });

  it("dedupes repeated findings and bounces the worker for inner-loop rework", async () => {
    const comments: string[] = [];
    const runContinuousFeedback = vi.fn(() => ({
      summary: "One issue found.",
      findings: [
        {
          signature: "src/core.ts:null-check",
          title: "Missing null check",
          detail: "Guard the optional reviewer output before dereferencing.",
          severity: "blocking" as const,
          file: "src/core.ts",
          line: 42,
        },
      ],
    }));
    const orchestrator = createOrchestrator({
      runContinuousFeedback,
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });

    expect(orchestrator.getState().continuousFeedback["1"]?.findings).toEqual([
      expect.objectContaining({
        signature: "src/core.ts:null-check",
        occurrences: 2,
        status: "open",
      }),
    ]);

    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(retry).toMatchObject({
      issueId: "1",
      error: "continuous feedback requested inner-loop rework",
      delayType: "continuation",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(
      orchestrator.getState().continuousFeedback["1"]?.findings[0]?.status,
    ).toBe("bounced");
    expect(comments[0]).toContain("non-authoritative");
    expect(comments[0]).toContain("Missing null check");
  });

  it("clears stale open findings after a later clean checkpoint before worker exit", async () => {
    const results = [
      {
        summary: "One issue found.",
        findings: [
          {
            signature: "src/core.ts:null-check",
            title: "Missing null check",
            detail: "Guard the optional reviewer output before dereferencing.",
            severity: "blocking" as const,
            file: "src/core.ts",
            line: 42,
          },
        ],
      },
      {
        summary: "No issues found.",
        findings: [],
      },
    ];
    const orchestrator = createOrchestrator({
      config: createImplementThenGateConfig(),
      runContinuousFeedback: () => results.shift() ?? results[0]!,
    });

    await orchestrator.pollTick();
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(
      orchestrator.getState().continuousFeedback["1"]?.findings[0],
    ).toMatchObject({
      signature: "src/core.ts:null-check",
      status: "resolved",
    });
    expect(retry).toMatchObject({
      issueId: "1",
      delayType: "continuation",
    });
    expect(orchestrator.getState().issueStages["1"]).toBe("review_gate");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
  });

  it("keeps feedback bounce out of the normal failure retry budget", async () => {
    const orchestrator = createOrchestrator({
      config: createConfig({ agent: { maxRetryAttempts: 0 } }),
      runContinuousFeedback: () => ({
        summary: "One issue found.",
        findings: [
          {
            signature: "src/core.ts:null-check",
            title: "Missing null check",
            detail: "Guard the optional reviewer output before dereferencing.",
            severity: "warning" as const,
            file: "src/core.ts",
            line: 42,
          },
        ],
      }),
    });

    await orchestrator.pollTick();
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(retry).toMatchObject({
      issueId: "1",
      delayType: "continuation",
      error: "continuous feedback requested inner-loop rework",
    });
    expect(orchestrator.getState().failed.has("1")).toBe(false);
    expect(orchestrator.getState().retryAttempts["1"]).toMatchObject({
      delayType: "continuation",
    });
  });

  it("does not treat feedback pass as terminal gate approval", async () => {
    const orchestrator = createOrchestrator({
      config: createImplementThenGateConfig(),
      runContinuousFeedback: () => ({
        summary: "Looks fine.",
        findings: [],
      }),
    });

    await orchestrator.pollTick();
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });
    const retry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(retry).toMatchObject({
      issueId: "1",
      delayType: "continuation",
    });
    expect(orchestrator.getState().issueStages["1"]).toBe("review_gate");
    expect(orchestrator.getState().completed.has("1")).toBe(false);
    expect(orchestrator.getState().issuePassedStages["1"]).toEqual([
      "implement",
    ]);
  });

  it("uses a decorrelated reviewer lane when the worker already uses the cheap default", async () => {
    const seen: Array<{
      worker: { runner: string; model: string | null };
      reviewer: { runner: string; model: string | null; role: string };
    }> = [];
    const orchestrator = createOrchestrator({
      config: createConfig({
        runner: { kind: "pi", model: "local-flash" },
      }),
      runContinuousFeedback: ({ workerLane, reviewerLane }) => {
        seen.push({ worker: workerLane, reviewer: reviewerLane });
        return { summary: "Pass.", findings: [] };
      },
    });

    await orchestrator.pollTick();
    await orchestrator.runContinuousFeedbackCheckpoint({
      issueId: "1",
      event: "checkpoint",
    });

    expect(seen).toEqual([
      {
        worker: { runner: "pi", model: "local-flash", role: "worker" },
        reviewer: {
          runner: "pi",
          model: "local-flash-reviewer",
          role: "continuous-feedback-decorrelated",
        },
      },
    ]);
  });
});

describe("decorrelated terminal gates", () => {
  it("records an authoritative thin-mode gate pass with separated verifier lanes", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "gate passed",
    }));
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            labels: ["mode:thin"],
          }),
        ],
      }),
      runEnsembleGate,
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");
    await waitForGateOutcome(orchestrator, "1");

    expect(runEnsembleGate).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().decorrelatedGateOutcomes["1"]).toEqual([
      expect.objectContaining({
        mode: "thin",
        status: "passed",
        aggregate: "pass",
        verifierSeparated: true,
        authoritative: true,
        reworkTarget: null,
        workerLane: expect.objectContaining({
          runner: "codex",
          model: null,
          role: "worker",
          stageName: "implement",
        }),
        reviewerLanes: [
          expect.objectContaining({
            runner: "pi",
            model: "local-flash",
            role: "decorrelated-reviewer",
          }),
        ],
      }),
    ]);
    expect(orchestrator.getState().dispatcherRunJournal.at(-1)).toMatchObject({
      kind: "gate_result",
      metadata: {
        aggregate: "pass",
        mode: "thin",
        verifierSeparated: true,
        authoritative: true,
      },
    });
  });

  it("replays a production gate pass as the approved continuation after restart", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runJournal: DispatcherRunJournal = [];
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "gate passed",
    }));
    const tracker = createTracker({
      candidates: [
        createIssue({
          id: "1",
          identifier: "ISSUE-1",
          labels: ["mode:thin"],
          state: "In Progress",
        }),
      ],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const firstOrchestrator = createOrchestrator({
      config,
      tracker,
      runEnsembleGate,
      writeRunJournalEntry: async (entry) => {
        runJournal.push(entry);
      },
    });

    await firstOrchestrator.pollTick();
    await firstOrchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await firstOrchestrator.onRetryTimer("1");
    await waitForGateOutcome(firstOrchestrator, "1");

    expect(firstOrchestrator.getState().issueStages["1"]).toBe("done");
    expect(runJournal).toContainEqual(
      expect.objectContaining({
        kind: "gate_result",
        issueId: "1",
        metadata: expect.objectContaining({
          aggregate: "pass",
          mode: "thin",
          authoritative: true,
        }),
      }),
    );

    const restartedOrchestrator = createOrchestrator({
      config,
      tracker,
      runJournal,
      runEnsembleGate,
    });

    expect(restartedOrchestrator.getState().issueStages["1"]).toBe("done");
    expect(
      restartedOrchestrator.getState().decorrelatedGateOutcomes["1"],
    ).toEqual([
      expect.objectContaining({
        mode: "thin",
        status: "passed",
        aggregate: "pass",
        authoritative: true,
      }),
    ]);

    const result = await restartedOrchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(runEnsembleGate).toHaveBeenCalledTimes(1);
    expect(restartedOrchestrator.getState().completed.has("1")).toBe(true);
    expect(restartedOrchestrator.getState().issueStages["1"]).toBeUndefined();
  });

  it("records a full-mode gate failure and routes the unit back to rework", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "fail" as const,
      results: [],
      comment: "blocking review finding",
    }));
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            labels: ["mode:full"],
          }),
        ],
      }),
      runEnsembleGate,
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");
    await waitForGateOutcome(orchestrator, "1");

    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(orchestrator.getState().decorrelatedGateOutcomes["1"]).toEqual([
      expect.objectContaining({
        mode: "full",
        status: "failed",
        aggregate: "fail",
        verifierSeparated: true,
        authoritative: true,
        reworkTarget: "implement",
      }),
    ]);
  });

  it("replays max-rework production gate failure as terminal after restart", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runJournal: DispatcherRunJournal = [];
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "fail" as const,
      results: [],
      comment: "blocking review finding",
    }));
    const tracker = createTracker({
      candidates: [
        createIssue({
          id: "1",
          identifier: "ISSUE-1",
          labels: ["mode:full"],
          state: "In Progress",
        }),
      ],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const firstOrchestrator = createOrchestrator({
      config,
      tracker,
      runEnsembleGate,
      writeRunJournalEntry: async (entry) => {
        runJournal.push(entry);
      },
    });

    await firstOrchestrator.pollTick();
    await firstOrchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await firstOrchestrator.onRetryTimer("1");
    await waitForGateOutcomeCount(firstOrchestrator, "1", 1);

    expect(firstOrchestrator.getState().issueStages["1"]).toBe("implement");
    expect(firstOrchestrator.getState().issueReworkCounts["1"]).toBe(1);

    await firstOrchestrator.onRetryTimer("1");
    await firstOrchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await firstOrchestrator.onRetryTimer("1");
    await waitForGateOutcomeCount(firstOrchestrator, "1", 2);

    const beforeRestart = firstOrchestrator.getState();
    expect(beforeRestart.failed.has("1")).toBe(true);
    expect(beforeRestart.issueStages["1"]).toBeUndefined();
    expect(runEnsembleGate).toHaveBeenCalledTimes(2);

    const gateResults = runJournal.filter(
      (entry) => entry.kind === "gate_result" && entry.operation === "gate",
    );
    expect(gateResults).toHaveLength(2);
    expect(new Set(gateResults.map((entry) => entry.idempotencyKey)).size).toBe(
      2,
    );
    expect(gateResults.at(-1)).toMatchObject({
      metadata: expect.objectContaining({
        aggregate: "fail",
        terminal: true,
        terminalReason: "max_rework_exceeded",
        reworkCount: 1,
      }),
    });

    const restartedOrchestrator = createOrchestrator({
      config,
      tracker,
      runJournal,
      runEnsembleGate,
    });

    expect(restartedOrchestrator.getState().failed.has("1")).toBe(true);
    expect(restartedOrchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(
      restartedOrchestrator.getState().decorrelatedGateOutcomes["1"],
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        reworkTarget: "implement",
      }),
      expect.objectContaining({
        status: "failed",
        reworkTarget: null,
      }),
    ]);

    const result = await restartedOrchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(restartedOrchestrator.getState().failed.has("1")).toBe(true);
    expect(runEnsembleGate).toHaveBeenCalledTimes(2);
  });

  it("blocks a production gate when the verifier lane matches the worker lane", async () => {
    const config = createImplementThenGateConfigWithReviewers([
      {
        runner: "codex",
        model: null,
        role: "worker",
        prompt: null,
      },
    ]);
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "should not run",
    }));
    const comments: string[] = [];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            labels: ["mode:full"],
          }),
        ],
      }),
      runEnsembleGate,
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    expect(runEnsembleGate).not.toHaveBeenCalled();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().decorrelatedGateOutcomes["1"]).toEqual([
      expect.objectContaining({
        status: "blocked",
        aggregate: "fail",
        verifierSeparated: false,
        reworkTarget: "implement",
      }),
    ]);
    expect(comments[0]).toContain("Decorrelated gate blocked");
  });

  it("fails closed when a production gate has no verifier lanes", async () => {
    const config = createImplementThenGateConfigWithReviewers([]);
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "should not run",
    }));
    const comments: string[] = [];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            labels: ["mode:thin"],
          }),
        ],
      }),
      runEnsembleGate,
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    expect(runEnsembleGate).not.toHaveBeenCalled();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().decorrelatedGateOutcomes["1"]).toEqual([
      expect.objectContaining({
        mode: "thin",
        status: "blocked",
        aggregate: "fail",
        reviewerLanes: [],
        verifierSeparated: false,
        authoritative: true,
        reworkTarget: "implement",
      }),
    ]);
    expect(comments[0]).toContain("no decorrelated verifier lane");
  });

  it("keeps prototype mode out of the merge path and records promotion boundary", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "should not run",
    }));
    const comments: string[] = [];
    const trackerWrites: TrackerIssueWriteRequest[] = [];
    const orchestrator = createOrchestrator({
      config,
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            labels: ["mode:prototype"],
          }),
        ],
      }),
      runEnsembleGate,
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
      requestTrackerIssueWrite: (input) => {
        trackerWrites.push(input);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    expect(runEnsembleGate).not.toHaveBeenCalled();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().decorrelatedGateOutcomes["1"]).toEqual([
      expect.objectContaining({
        mode: "prototype",
        status: "skipped_prototype",
        aggregate: null,
        authoritative: false,
      }),
    ]);
    expect(comments[0]).toContain("Prototype promotion boundary");
    expect(comments[0]).toContain("new `thin` or `full` production unit");
    expect(trackerWrites).toEqual([
      {
        boundary: {
          type: "promotion_boundary",
          label: "prototype promotion for ISSUE-1",
          summary:
            "Prototype boundary reached for ISSUE-1; promotion requires a new gated production unit.",
          sourceIssueIds: ["1"],
        },
      },
    ]);
  });

  it("replays prototype boundary completion as terminal after restart", async () => {
    const config = createImplementThenGateConfigWithReviewers();
    const runJournal: DispatcherRunJournal = [];
    const runEnsembleGate = vi.fn(async () => ({
      aggregate: "pass" as const,
      results: [],
      comment: "should not run",
    }));
    const tracker = createTracker({
      candidates: [
        createIssue({
          id: "1",
          identifier: "ISSUE-1",
          labels: ["mode:prototype"],
          state: "In Progress",
        }),
      ],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const firstOrchestrator = createOrchestrator({
      config,
      tracker,
      runEnsembleGate,
      writeRunJournalEntry: async (entry) => {
        runJournal.push(entry);
      },
    });

    await firstOrchestrator.pollTick();
    await firstOrchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await firstOrchestrator.onRetryTimer("1");

    expect(firstOrchestrator.getState().completed.has("1")).toBe(true);
    expect(runJournal).toContainEqual(
      expect.objectContaining({
        kind: "gate_result",
        issueId: "1",
        metadata: expect.objectContaining({
          status: "skipped_prototype",
          authoritative: false,
        }),
      }),
    );

    const restartedOrchestrator = createOrchestrator({
      config,
      tracker,
      runJournal,
      runEnsembleGate,
    });

    const result = await restartedOrchestrator.pollTick();

    expect(result.dispatchedIssueIds).toEqual([]);
    expect(runEnsembleGate).not.toHaveBeenCalled();
    expect(restartedOrchestrator.getState().completed.has("1")).toBe(true);
    expect(restartedOrchestrator.getState().issueStages["1"]).toBeUndefined();
  });
});

describe("orchestrator core integration flows", () => {
  it("redispatches a retried issue through a fake runner boundary after an abnormal exit", async () => {
    const harness = createIntegrationHarness();

    const initialTick = await harness.orchestrator.pollTick();

    expect(initialTick.dispatchedIssueIds).toEqual(["1"]);
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
    ]);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);

    const retryEntry = await harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(harness.orchestrator.getState().running).toEqual({});

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: true,
      released: false,
      retryEntry: null,
    });
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: 1,
      },
    ]);
    expect(harness.orchestrator.getState().running["1"]?.retryAttempt).toBe(1);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);
  });

  it("requests terminal cleanup through the fake runner boundary and releases the claim once the issue disappears", async () => {
    const harness = createIntegrationHarness();

    await harness.orchestrator.pollTick();
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
    expect(harness.stopCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);

    await harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped after terminal reconciliation",
    });
    harness.setCandidates([]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
    expect(harness.orchestrator.getState().failed.has("1")).toBe(true);
  });

  it("stops a stalled worker through the fake runner boundary and releases it when the issue is no longer active", async () => {
    const harness = createIntegrationHarness({
      now: "2026-03-06T00:10:00.000Z",
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
    });

    await harness.orchestrator.pollTick();
    const runningEntry = harness.orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(harness.stopCalls).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });

    await harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stalled",
    });
    harness.setCandidates([
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        state: "Backlog",
      }),
    ]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
    expect(harness.orchestrator.getState().failed.has("1")).toBe(true);
  });
});

describe("max retry safety net", () => {
  it("retries normally when attempt is under the max limit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({ agent: { maxRetryAttempts: 3 } }),
    });

    await orchestrator.pollTick();
    // Simulate abnormal exit — attempt will be 1 (under limit of 3)
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(orchestrator.getState().completed.has("1")).toBe(false);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("escalates when failure retry attempt exceeds the max limit", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const escalationStates: Array<{ issueId: string; state: string }> = [];
    const timers = createFakeTimerScheduler();

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 2 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      updateIssueState: async (issueId, _identifier, state) => {
        escalationStates.push({ issueId, state });
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // Simulate: attempt 1 (under limit of 2)
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });
    expect(retry1).not.toBeNull();
    expect(retry1).toMatchObject({ attempt: 1 });

    // Fire retry timer → redispatch → exit again → attempt 2 (still at limit)
    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed again",
    });
    expect(retry2).not.toBeNull();
    expect(retry2).toMatchObject({ attempt: 2 });

    // Fire retry timer → redispatch → exit again → attempt 3 (exceeds limit of 2)
    const retryResult2 = await orchestrator.onRetryTimer("1");
    expect(retryResult2.dispatched).toBe(true);

    const retry3 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed yet again",
    });

    // Should be null — escalated
    expect(retry3).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(orchestrator.getState().retryAttempts).not.toHaveProperty("1");

    // Verify escalation side effects were fired
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (2) exceeded",
    );
  });

  it("escalates on onRetryTimer failure retry when attempt exceeds limit", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const timers = createFakeTimerScheduler();

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxConcurrentAgents: 0, maxRetryAttempts: 2 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Manually create a retry entry at attempt 2 (the limit)
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    // When onRetryTimer fires and slots are exhausted, it calls scheduleRetry
    // with attempt 3, which exceeds maxRetryAttempts=2
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (2) exceeded",
    );
  });

  it("does not count continuation retries against the max limit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({ agent: { maxRetryAttempts: 1 } }),
    });

    await orchestrator.pollTick();

    // Normal exit with no failure signal → continuation retry with attempt=1
    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    // Should still succeed even though maxRetryAttempts=1
    // because continuation retries don't count against the limit
    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: null,
    });
    // After the fix for SYMPH-126, continuations no longer add to completed —
    // only terminal completions do.
    expect(orchestrator.getState().completed.has("1")).toBe(false);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("respects the limit for verify failure signals", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 1 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // First exit with verify failure → attempt 1 (at limit, still OK)
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: verify]",
    });
    expect(retry1).not.toBeNull();
    expect(retry1).toMatchObject({ attempt: 1 });

    // Fire retry, redispatch, exit with verify failure again → attempt 2 (exceeds limit=1)
    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: verify]",
    });

    expect(retry2).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (1) exceeded",
    );
  });

  it("respects the limit for infra failure signals", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 1 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // First exit with infra failure → attempt 1 (at limit)
    const retry1 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });
    expect(retry1).not.toBeNull();

    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    // Second exit with infra failure → attempt 2 (exceeds limit=1)
    const retry2 = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });

    expect(retry2).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(escalationComments).toHaveLength(1);
  });

  it("defaults maxRetryAttempts to 5 from config resolver", () => {
    const config = createConfig();
    expect(config.agent.maxRetryAttempts).toBe(5);
  });
});

describe("completed issue resume guard", () => {
  it("does NOT re-dispatch a completed issue still in 'In Review' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    // Include Resume and Blocked in active_states for this test
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });

    // Mark issue as completed (simulates having finished the pipeline)
    orchestrator.getState().completed.add("1");

    // Issue is still "In Review" on the tracker — should NOT be re-dispatched
    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "In Review" }),
    );

    expect(eligible).toBe(false);
    // completed flag should NOT be cleared
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("does NOT re-dispatch a completed issue still in 'In Progress' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "In Progress" }),
    );

    expect(eligible).toBe(false);
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("re-dispatches a completed issue moved to 'Resume' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
    );

    expect(eligible).toBe(true);
    // completed flag should be cleared
    expect(orchestrator.getState().completed.has("1")).toBe(false);
  });

  it("re-dispatches a completed issue moved to 'Todo' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    );

    expect(eligible).toBe(true);
    expect(orchestrator.getState().completed.has("1")).toBe(false);
  });

  it("skips terminal_state stop for worker in final active stage (merge → done)", async () => {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "merge", onApprove: null, onRework: null },
          linearState: null,
        },
        merge: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
          linearState: "Done",
        },
      },
    };
    const harness = createIntegrationHarness({ config });

    // Dispatch the issue, which puts it in running state
    await harness.orchestrator.pollTick();

    // Simulate: worker is in the "merge" stage (final active stage before terminal "done")
    harness.orchestrator.getState().issueStages["1"] = "merge";

    // Issue transitions to Done (e.g., advanceStage fired updateIssueState)
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const result = await harness.orchestrator.pollTick();

    // Worker should NOT be stopped — it's in the final active stage
    expect(result.stopRequests).toEqual([]);
    expect(harness.stopCalls).toEqual([]);
  });

  it("stops worker in non-final stage when issue reaches terminal state", async () => {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "merge", onApprove: null, onRework: null },
          linearState: null,
        },
        merge: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
          linearState: "Done",
        },
      },
    };
    const harness = createIntegrationHarness({ config });

    // Dispatch the issue
    await harness.orchestrator.pollTick();

    // Worker is in "investigate" stage (NOT the final active stage)
    harness.orchestrator.getState().issueStages["1"] = "investigate";

    // Issue manually moved to Done by a human
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const result = await harness.orchestrator.pollTick();

    // Worker SHOULD be stopped — investigate is not the final active stage
    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
  });

  it("does NOT re-dispatch a completed issue in escalation state ('Blocked')", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Blocked" }),
    );

    expect(eligible).toBe(false);
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

describe("execution history stage records", () => {
  function createStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
    return config;
  }

  it("stage record appended on worker exit", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    // Set the issue to the investigate stage
    orchestrator.getState().issueStages["1"] = "investigate";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:10.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
  });

  it("stage record captures all fields", async () => {
    const config = createStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    // Apply codex event to give the running entry some token/turn data
    orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:06.000Z",
        codexAppServerPid: "1001",
        sessionId: "s1",
        threadId: "t1",
        turnId: "turn-1",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        rateLimits: {},
        message: "done",
      },
    });

    const startedAt = orchestrator.getState().running["1"]?.startedAt;
    expect(startedAt).toBeDefined();

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    const record = history![0]!;
    expect(record.stageName).toBe("investigate");
    expect(record.durationMs).toBe(60_000);
    expect(record.totalTokens).toBeGreaterThanOrEqual(0);
    expect(typeof record.turns).toBe("number");
    expect(record.outcome).toBe("normal");
  });

  it("StageRecord captures per-type tokens on stage completion", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({
      config,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    // Simulate turn_completed with 3000 input and 2000 output tokens
    orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:06.000Z",
        codexAppServerPid: "1001",
        sessionId: "s1",
        threadId: "t1",
        turnId: "turn-1",
        usage: { inputTokens: 3000, outputTokens: 2000, totalTokens: 5000 },
        rateLimits: {},
        message: "done",
      },
    });

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    const record = history![0]!;
    expect(record.stageName).toBe("investigate");
    expect(record.inputTokens).toBe(3000);
    expect(record.outputTokens).toBe(2000);
    expect(record.totalTokens).toBe(5000);
  });

  it("accumulates records across multiple stages", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({ config });

    // First stage: investigate
    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:00.000Z"),
    });

    // After normal exit, stage advances to "implement"
    // issueExecutionHistory should have 1 record for "investigate"
    const historyAfterFirst =
      orchestrator.getState().issueExecutionHistory["1"];
    expect(historyAfterFirst).toHaveLength(1);
    expect(historyAfterFirst![0]!.stageName).toBe("investigate");

    // Second stage: implement
    await orchestrator.onRetryTimer("1");
    orchestrator.getState().issueStages["1"] = "implement";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      endedAt: new Date("2026-03-06T00:02:00.000Z"),
    });

    // issueExecutionHistory should have 2 records
    const historyAfterSecond =
      orchestrator.getState().issueExecutionHistory["1"];
    expect(historyAfterSecond).toHaveLength(2);
    expect(historyAfterSecond![1]!.stageName).toBe("implement");
    expect(historyAfterSecond![1]!.outcome).toBe("failed_to_start");
  });

  it("does not append a stage record when no stage is set for the issue", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    // No issueStages entry — no stage configured

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:00.000Z"),
    });

    // issueExecutionHistory should have no entry for this issue
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
  });
});

describe("execution report on terminal state", () => {
  function createTerminalStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "merge",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        merge: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
          linearState: "Done",
        },
      },
    };
    return config;
  }

  it("posts execution report on terminal state", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.body).toMatch(/^## Execution Report/);
  });

  it("execution report contains stage timeline", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Manually inject history for investigate and merge stages
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    // Table columns
    expect(body).toContain("| Stage |");
    expect(body).toContain("| Duration |");
    expect(body).toContain("| Tokens |");
    expect(body).toContain("| Turns |");
    expect(body).toContain("| Outcome |");
    // Stage rows
    expect(body).toContain("investigate");
    expect(body).toContain("merge");
  });

  it("execution report contains total tokens", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 200_000,
        turns: 10,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 45_000,
        totalTokens: 80_000,
        turns: 3,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    expect(body).toContain("Total tokens");
    // 50000 + 200000 + 80000 = 330000, plus merge stage tokens (0 in this test)
    // The merge stage exit adds its record too
    expect(body).toMatch(/Total tokens.*\d/);
  });

  it("execution report shows rework count", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    expect(body).toContain("Rework count");
    expect(body).toContain("1");
  });

  it("execution report includes rework stages", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Simulate: investigate, implement, review (fail), implement (rework), review (pass)
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 10_000,
        turns: 3,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 60_000,
        totalTokens: 80_000,
        turns: 8,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 20_000,
        totalTokens: 30_000,
        turns: 2,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 50_000,
        totalTokens: 70_000,
        turns: 7,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 25_000,
        totalTokens: 35_000,
        turns: 2,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    // 5 pre-existing records + 1 merge record = 6 total stage rows
    const tableRows = body
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| ") &&
          !line.startsWith("| Stage") &&
          !line.startsWith("|----"),
      );
    expect(tableRows).toHaveLength(6);
  });

  it("execution report failure does not block terminal transition", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("postComment failed");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Terminal transition: returns null (no retry), issue is completed
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("history cleaned up even if report posting fails", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("postComment failed");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 10_000,
        turns: 3,
        outcome: "normal",
      },
    ];

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // State should be cleaned up regardless of postComment failure
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
    // History may contain the merge record from onWorkerExit, but after advanceStage it's deleted
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
  });

  it("no execution report without postComment", async () => {
    // No postComment configured — just verify it completes normally without error
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      // postComment intentionally not configured
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Issue completes normally
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    // No side effects
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
  });

  it("execution history cleaned up after completion", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Pre-populate execution history with 4 stages
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 200_000,
        turns: 10,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 45_000,
        totalTokens: 80_000,
        turns: 3,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    // Execution history must be deleted from orchestrator state after Done
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
    // Stages and rework counts also cleaned up
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
    // Issue is marked completed
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    // Report was still posted before cleanup
    expect(postedComments).toHaveLength(1);
  });
});

describe("review findings comment on agent review failure", () => {
  /**
   * Build a stage config with:
   *   implement (agent) → review (agent, onRework: implement, maxRework: N) → done (terminal)
   */
  function createReviewStageConfig(maxRework = 2) {
    const config = createConfig();
    config.escalationState = "Blocked";
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
    ];
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "implement",
          },
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
          linearState: "Done",
        },
      },
    };
    return config;
  }

  it("posts review findings comment on agent review failure", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    // Flush microtasks so the void promise resolves
    await Promise.resolve();

    const reviewComment = postedComments.find((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewComment).toBeDefined();
    expect(reviewComment?.issueId).toBe("1");
  });

  it("review findings comment includes agent message", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    await Promise.resolve();

    const reviewComment = postedComments.find((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewComment?.body).toContain(
      "Missing null check in handler.ts line 42",
    );
  });

  it("review failure triggers rework after posting comment", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    // Should schedule a rework retry (continuation, not failure)
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
    // Stage should be updated to the rework target
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("review findings comment failure does not block rework", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("Comment service unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Some failure",
    });

    // Rework must proceed despite postComment throwing
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
  });

  it("postComment error is swallowed for review findings", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("Comment service unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    // Should not throw — error must be swallowed
    let threw = false;
    try {
      await orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        agentMessage: "[STAGE_FAILED: review] Some failure",
      });
      // Allow microtasks to flush so the void promise rejects internally
      await Promise.resolve();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("skips review findings when postComment not configured", async () => {
    const config = createReviewStageConfig();
    // No postComment wired — omit it entirely
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Some failure",
    });

    // Rework still proceeds
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
    // No comment was posted (no postComment configured — no crash either)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("escalation fires on max rework exceeded", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const stateUpdates: Array<{ issueId: string; state: string }> = [];
    const config = createReviewStageConfig(1); // maxRework=1
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      updateIssueState: async (issueId, _issueIdentifier, stateName) => {
        stateUpdates.push({ issueId, state: stateName });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";
    // Already used 1 rework — next failure should trigger escalation
    orchestrator.getState().issueReworkCounts["1"] = 1;

    const retryEntry = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Another null check failure",
    });

    await Promise.resolve();

    // Escalation: issue is failed, no retry
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    // Escalation side effects fire
    expect(stateUpdates).toHaveLength(1);
    expect(stateUpdates[0]?.state).toBe("Blocked");
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "max rework attempts exceeded",
    );
  });

  it("no review findings on escalation", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig(1); // maxRework=1
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      updateIssueState: async (_issueId, _identifier, _state) => {
        // no-op
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Another null check failure",
    });

    await Promise.resolve();

    // Only the escalation comment should have been posted — not a review findings comment
    const reviewFindings = postedComments.filter((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewFindings).toHaveLength(0);

    // The escalation comment should be present
    const escalation = postedComments.filter(
      (c) => !c.body.startsWith("## Review Findings"),
    );
    expect(escalation).toHaveLength(1);
    expect(escalation[0]?.body).toContain("max rework attempts exceeded");
  });
});

describe("auto-close parent", () => {
  function createTerminalStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
          linearState: "Done",
        },
      },
    };
    return config;
  }

  it("auto-close parent fires on terminal state transition", async () => {
    const autoCloseCalls: Array<{
      issueId: string;
      issueIdentifier: string;
    }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      autoCloseParentIssue: async (issueId, issueIdentifier) => {
        autoCloseCalls.push({ issueId, issueIdentifier });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    expect(autoCloseCalls).toHaveLength(1);
    expect(autoCloseCalls[0]).toEqual({
      issueId: "1",
      issueIdentifier: "SYMPH-1",
    });
  });

  it("auto-close parent does not fire on non-terminal stage transitions", async () => {
    const autoCloseCalls: Array<{
      issueId: string;
      issueIdentifier: string;
    }> = [];
    const config = createConfig();
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
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
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
          linearState: "Done",
        },
      },
    };

    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      autoCloseParentIssue: async (issueId, issueIdentifier) => {
        autoCloseCalls.push({ issueId, issueIdentifier });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks to flush
    await Promise.resolve();

    // Should not fire — this was a non-terminal transition (implement → review)
    expect(autoCloseCalls).toHaveLength(0);
  });

  it("auto-close parent failure does not block terminal transition", async () => {
    const updateStateCalls: Array<{
      issueId: string;
      stateName: string;
    }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      updateIssueState: async (issueId, _identifier, stateName) => {
        updateStateCalls.push({ issueId, stateName });
      },
      autoCloseParentIssue: async () => {
        throw new Error("Linear API unreachable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks to flush
    await Promise.resolve();

    // The terminal state update should still have fired despite autoCloseParentIssue failure
    expect(updateStateCalls).toHaveLength(1);
    expect(updateStateCalls[0]).toEqual({ issueId: "1", stateName: "Done" });

    // Issue should be completed (not blocked by the auto-close failure)
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("auto-close parent is not called when callback is not provided", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    // Should not throw even without autoCloseParentIssue callback
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

describe("fast-track label-based stage routing", () => {
  function createFastTrackConfig(
    overrides?: Partial<ResolvedWorkflowConfig>,
  ): ResolvedWorkflowConfig {
    return {
      ...createConfig(),
      stages: {
        initialStage: "investigate",
        fastTrack: {
          label: "trivial",
          labels: ["trivial", "kind:test"],
          initialStage: "implement",
        },
        stages: Object.freeze({
          investigate: {
            type: "agent",
            runner: null,
            model: null,
            prompt: null,
            maxTurns: null,
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
            runner: null,
            model: null,
            prompt: null,
            maxTurns: null,
            timeoutMs: null,
            concurrency: null,
            gateType: null,
            maxRework: null,
            reviewers: [],
            transitions: {
              onComplete: "done",
              onApprove: null,
              onRework: null,
            },
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
        }),
      },
      ...overrides,
    };
  }

  it("fast-track: trivial-labeled issue starts at fast-track initial stage", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["implement"]);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("fast-track: kind:test issue starts at fast-track initial stage", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["kind:test"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["implement"]);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("fast-track: non-trivial issue follows normal pipeline (starts at investigate)", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: [],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["investigate"]);
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
  });

  it("fast-track: case-insensitive label matching (label already normalized to lowercase by linear-normalize.ts)", async () => {
    // Labels are normalized to lowercase upstream — "trivial" in config matches "trivial" in issue
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          // label is already normalized to lowercase "trivial" (as linear-normalize.ts does)
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["implement"]);
  });

  it("fast-track: issue with cached stage ignores fast-track and continues from cached stage", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Pre-set a cached stage for this issue
    orchestrator.getState().issueStages["1"] = "review" as unknown as string;

    // Manually add a "review" stage to handle the cached stage scenario
    // (The orchestrator will use the cached "review" value — which is not in our test stage config
    // so stage will be null, but stageName will be "review", proving cached stage takes priority)
    const config = createFastTrackConfig();
    const orchestratorWithReview = new OrchestratorCore({
      config: {
        ...config,
        stages: config.stages
          ? {
              ...config.stages,
              stages: Object.freeze({
                ...config.stages.stages,
                review: {
                  type: "agent" as const,
                  runner: null,
                  model: null,
                  prompt: null,
                  maxTurns: null,
                  timeoutMs: null,
                  concurrency: null,
                  gateType: null,
                  maxRework: null,
                  reviewers: [],
                  transitions: {
                    onComplete: "done",
                    onApprove: null,
                    onRework: null,
                  },
                  linearState: null,
                },
              }),
            }
          : null,
      },
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Pre-set the cached stage — fast-track should be ignored
    orchestratorWithReview.getState().issueStages["1"] = "review";

    await orchestratorWithReview.pollTick();

    expect(spawnedStageNames).toEqual(["review"]);
    expect(orchestratorWithReview.getState().issueStages["1"]).toBe("review");
  });

  it("no fast-track: issue with trivial label uses default initialStage when no fast_track config", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const configWithoutFastTrack = createFastTrackConfig();
    const orchestrator = new OrchestratorCore({
      config: {
        ...configWithoutFastTrack,
        stages: configWithoutFastTrack.stages
          ? { ...configWithoutFastTrack.stages, fastTrack: null }
          : null,
      },
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["investigate"]);
  });

  it("fast-track: logs activation message when fast-track is applied", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const orchestrator = new OrchestratorCore({
        config: createFastTrackConfig(),
        tracker: createTracker({
          candidates: [
            createIssue({
              id: "1",
              identifier: "ISSUE-1",
              state: "Todo",
              labels: ["trivial"],
            }),
          ],
        }),
        spawnWorker: async () => ({
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        }),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await orchestrator.pollTick();
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContainEqual(
      "[orchestrator] Fast-tracking ISSUE-1 to implement (label: trivial)",
    );
  });
});

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  tracker?: IssueTracker;
  timerScheduler?: ReturnType<typeof createFakeTimerScheduler>;
  stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];
  onIssueDropped?: OrchestratorCoreOptions["onIssueDropped"];
  getRunningSupervisionSnapshots?: OrchestratorCoreOptions["getRunningSupervisionSnapshots"];
  requestSupervisionResteer?: OrchestratorCoreOptions["requestSupervisionResteer"];
  runEnsembleGate?: OrchestratorCoreOptions["runEnsembleGate"];
  requestTrackerIssueWrite?: OrchestratorCoreOptions["requestTrackerIssueWrite"];
  runContinuousFeedback?: OrchestratorCoreOptions["runContinuousFeedback"];
  postComment?: OrchestratorCoreOptions["postComment"];
  writeRunJournalEntry?: OrchestratorCoreOptions["writeRunJournalEntry"];
  now?: () => Date;
  runJournal?: DispatcherRunJournal;
}) {
  const tracker =
    overrides?.tracker ??
    createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker,
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: overrides?.now ?? (() => new Date("2026-03-06T00:00:05.000Z")),
  };

  if (overrides?.runJournal !== undefined) {
    options.runJournal = overrides.runJournal;
  }

  if (overrides?.writeRunJournalEntry !== undefined) {
    options.writeRunJournalEntry = overrides.writeRunJournalEntry;
  }

  if (overrides?.stopRunningIssue !== undefined) {
    options.stopRunningIssue = overrides.stopRunningIssue;
  }

  if (overrides?.onIssueDropped !== undefined) {
    options.onIssueDropped = overrides.onIssueDropped;
  }

  if (overrides?.getRunningSupervisionSnapshots !== undefined) {
    options.getRunningSupervisionSnapshots =
      overrides.getRunningSupervisionSnapshots;
  }

  if (overrides?.requestSupervisionResteer !== undefined) {
    options.requestSupervisionResteer = overrides.requestSupervisionResteer;
  }

  if (overrides?.runEnsembleGate !== undefined) {
    options.runEnsembleGate = overrides.runEnsembleGate;
  }

  if (overrides?.requestTrackerIssueWrite !== undefined) {
    options.requestTrackerIssueWrite = overrides.requestTrackerIssueWrite;
  }

  if (overrides?.runContinuousFeedback !== undefined) {
    options.runContinuousFeedback = overrides.runContinuousFeedback;
  }

  if (overrides?.postComment !== undefined) {
    options.postComment = overrides.postComment;
  }

  if (overrides?.timerScheduler !== undefined) {
    options.timerScheduler = overrides.timerScheduler;
  }

  return new OrchestratorCore(options);
}

async function waitForGateOutcome(
  orchestrator: OrchestratorCore,
  issueId: string,
): Promise<void> {
  await waitForGateOutcomeCount(orchestrator, issueId, 1);
}

async function waitForGateOutcomeCount(
  orchestrator: OrchestratorCore,
  issueId: string,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (
      (orchestrator.getState().decorrelatedGateOutcomes[issueId] ?? [])
        .length >= count
    ) {
      return;
    }
    await Promise.resolve();
  }
}

function createTracker(input?: {
  candidates?: Issue[];
  candidatesFn?: () => Issue[];
  statesById?: IssueStateSnapshot[];
  latestStateTransitionAt?: (
    issueId: string,
    stateName: string,
  ) => Promise<string | null>;
}): IssueTracker {
  const tracker: IssueTracker = {
    async fetchCandidateIssues() {
      return (
        input?.candidatesFn?.() ??
        input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })]
      );
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return input?.statesById ?? [];
    },
  };
  if (input?.latestStateTransitionAt !== undefined) {
    tracker.fetchLatestStateTransitionAt = input.latestStateTransitionAt;
  }
  return tracker;
}

function createConfig(overrides?: {
  agent?: Partial<ResolvedWorkflowConfig["agent"]>;
  codex?: Partial<ResolvedWorkflowConfig["codex"]>;
  runner?: Partial<ResolvedWorkflowConfig["runner"]>;
  continuousFeedback?: ResolvedWorkflowConfig["continuousFeedback"];
  rateLimitAdmission?: ResolvedWorkflowConfig["rateLimitAdmission"];
  budgetEscalation?: ResolvedWorkflowConfig["budgetEscalation"];
  pauseTriage?: ResolvedWorkflowConfig["pauseTriage"];
  acGate?: ResolvedWorkflowConfig["acGate"];
  specFidelity?: ResolvedWorkflowConfig["specFidelity"];
  admissionCard?: ResolvedWorkflowConfig["admissionCard"];
}): ResolvedWorkflowConfig {
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
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/workspaces",
    },
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
      ...overrides?.agent,
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
      ...overrides?.codex,
    },
    rateLimitAdmission: overrides?.rateLimitAdmission ?? {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    budgetEscalation: overrides?.budgetEscalation ?? {
      maxSteps: null,
      multiplier: 2,
    },
    pauseTriage: overrides?.pauseTriage ?? {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
    },
    acGate: overrides?.acGate ?? { enabled: false },
    specFidelity: overrides?.specFidelity ?? { enabled: false },
    admissionCard: overrides?.admissionCard ?? { enabled: false },
    server: {
      port: null,
      slackNotifyChannel: null,
    },
    notifications: {
      slackEnabled: true,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: {
      kind: "codex",
      model: null,
      ...overrides?.runner,
    },
    continuousFeedback: overrides?.continuousFeedback ?? {
      enabled: true,
      events: ["checkpoint"],
      runner: "pi",
      model: "local-flash",
      role: "continuous-feedback",
      bounceOnFinding: true,
    },
    stages: null,
    escalationState: null,
  };
}

function createGateConfig(): ResolvedWorkflowConfig {
  const config = createConfig();
  config.stages = {
    initialStage: "review_gate",
    fastTrack: null,
    stages: {
      review_gate: {
        type: "gate",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: "ensemble",
        maxRework: 1,
        reviewers: [],
        transitions: {
          onComplete: null,
          onApprove: "done",
          onRework: null,
        },
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
        transitions: {
          onComplete: null,
          onApprove: null,
          onRework: null,
        },
        linearState: "Done",
      },
    },
  };
  return config;
}

function createImplementThenGateConfig(): ResolvedWorkflowConfig {
  const config = createConfig();
  config.stages = {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "review_gate",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      review_gate: {
        type: "gate",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: "ensemble",
        maxRework: 1,
        reviewers: [],
        transitions: {
          onComplete: null,
          onApprove: "done",
          onRework: "implement",
        },
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
        transitions: {
          onComplete: null,
          onApprove: null,
          onRework: null,
        },
        linearState: "Done",
      },
    },
  };
  return config;
}

function createImplementThenGateConfigWithReviewers(
  reviewers: ReviewerDefinition[] = [
    {
      runner: "pi",
      model: "local-flash",
      role: "decorrelated-reviewer",
      prompt: null,
    },
  ],
): ResolvedWorkflowConfig {
  const config = createImplementThenGateConfig();
  const implement = config.stages?.stages.implement;
  const reviewGate = config.stages?.stages.review_gate;
  if (implement === undefined || reviewGate === undefined) {
    throw new Error("Expected implement and review_gate stages.");
  }

  implement.runner = "codex";
  implement.model = null;
  reviewGate.reviewers = reviewers;
  return config;
}

function createLinearStateStageConfig(): ResolvedWorkflowConfig {
  const config = createConfig();
  config.stages = {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: null,
          onApprove: null,
          onRework: null,
        },
        linearState: "In Progress",
      },
    },
  };
  return config;
}

function createJournalEntry(input: {
  sequence: number;
  idempotencyKey: string;
  kind: DispatcherRunJournal[number]["kind"];
  operation: DispatcherRunJournal[number]["operation"];
  leaseId: string;
  leaseStatus: "active" | "completed" | "expired";
  stage?: string | null;
  expiresAt?: string;
  completedAt?: string | null;
  metadata?: Record<string, unknown>;
}): DispatcherRunJournal[number] {
  const stage = input.stage ?? null;
  const completedAt =
    input.completedAt ??
    (input.leaseStatus === "active" ? null : (input.expiresAt ?? null));
  return {
    sequence: input.sequence,
    idempotencyKey: input.idempotencyKey,
    timestamp: "2026-03-06T00:00:00.000Z",
    kind: input.kind,
    issueId: "1",
    issueIdentifier: "ISSUE-1",
    operation: input.operation,
    stage,
    attempt: null,
    ownerId: "previous-runtime",
    lease: {
      leaseId: input.leaseId,
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      operation: input.operation,
      ownerId: "previous-runtime",
      status: input.leaseStatus,
      acquiredAt: "2026-03-06T00:00:00.000Z",
      expiresAt: input.expiresAt ?? "2026-03-06T00:10:00.000Z",
      completedAt,
      stage,
      attempt: null,
      lastJournalSequence: input.sequence,
    },
    summary: "journal fixture",
    metadata: {
      status: input.leaseStatus === "active" ? "started" : input.leaseStatus,
      ...input.metadata,
    },
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? null,
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? null,
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}

function createFakeTimerScheduler() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  return {
    scheduled,
    set(callback: () => void, delayMs: number) {
      scheduled.push({ callback, delayMs });
      return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {},
  };
}

function createIntegrationHarness(input?: {
  config?: ResolvedWorkflowConfig;
  now?: string;
  candidates?: Issue[];
  statesById?: IssueStateSnapshot[];
}) {
  const trackerState = {
    candidates: input?.candidates ?? [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
    ],
    statesById: input?.statesById ?? [
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ],
  };
  const spawnCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number | null;
  }> = [];
  const stopCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    cleanupWorkspace: boolean;
    reason: string;
  }> = [];

  const tracker: IssueTracker = {
    async fetchCandidateIssues() {
      return trackerState.candidates.map((issue) => ({ ...issue }));
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds(issueIds) {
      return trackerState.statesById
        .filter((snapshot) => issueIds.includes(snapshot.id))
        .map((snapshot) => ({ ...snapshot }));
    },
  };

  const orchestrator = new OrchestratorCore({
    config: input?.config ?? createConfig(),
    tracker,
    now: () => new Date(input?.now ?? "2026-03-06T00:00:05.000Z"),
    spawnWorker: async ({ issue, attempt }) => {
      spawnCalls.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt,
      });
      return {
        workerHandle: { issueId: issue.id, attempt },
        monitorHandle: { issueId: issue.id, attempt },
      };
    },
    stopRunningIssue: async (stopRequest) => {
      stopCalls.push({
        issueId: stopRequest.issueId,
        issueIdentifier: stopRequest.runningEntry.identifier,
        cleanupWorkspace: stopRequest.cleanupWorkspace,
        reason: stopRequest.reason,
      });
    },
  });

  return {
    orchestrator,
    spawnCalls,
    stopCalls,
    setCandidates(candidates: Issue[]) {
      trackerState.candidates = candidates;
    },
    setStateSnapshots(statesById: IssueStateSnapshot[]) {
      trackerState.statesById = statesById;
    },
  };
}

describe("classifyExitOutcome", () => {
  it("classifies abnormal exit with turnCount=0 as failed_to_start", () => {
    expect(classifyExitOutcome("abnormal", 0, "some error")).toBe(
      "failed_to_start",
    );
  });

  it("classifies abnormal exit with stall_timeout in reason as timed_out", () => {
    expect(
      classifyExitOutcome("abnormal", 5, "stopped after stall_timeout"),
    ).toBe("timed_out");
  });

  it("classifies abnormal exit without stall_timeout as error", () => {
    expect(classifyExitOutcome("abnormal", 3, "some error message")).toBe(
      "error",
    );
  });

  it("classifies Codex input-required exits as input_required", () => {
    expect(
      classifyExitOutcome(
        "abnormal",
        2,
        `${ERROR_CODES.codexUserInputRequired}: Codex requested operator input during a turn.`,
      ),
    ).toBe("input_required");
    expect(classifyExitOutcome("abnormal", 2, "turn_input_required")).toBe(
      "input_required",
    );
    expect(classifyExitOutcome("abnormal", 0, "turn_input_required")).toBe(
      "input_required",
    );
  });

  it("passes through normal outcome unchanged", () => {
    expect(classifyExitOutcome("normal", 2, undefined)).toBe("normal");
  });

  it("passes through already classified outcomes unchanged", () => {
    expect(classifyExitOutcome("failed_to_start", 0, undefined)).toBe(
      "failed_to_start",
    );
    expect(classifyExitOutcome("timed_out", 3, undefined)).toBe("timed_out");
    expect(classifyExitOutcome("error", 1, undefined)).toBe("error");
  });
});

describe("dispatch failure diagnostics", () => {
  it("logs error message and stack trace to session log on dispatch failure", async () => {
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const spawnError = new Error("spawn failed: ENOENT");
      const orchestrator = new OrchestratorCore({
        config: createConfig(),
        tracker: createTracker({
          candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        }),
        spawnWorker: async () => {
          throw spawnError;
        },
        timerScheduler: createFakeTimerScheduler(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await orchestrator.pollTick();

      const dispatchWarning = warnings.find(
        (args) =>
          typeof args[0] === "string" && args[0].includes("Dispatch failure"),
      );
      expect(dispatchWarning).toBeDefined();
      // Error message includes the issue identifier for correlation
      expect(dispatchWarning![0]).toContain("ISSUE-1");
      expect(dispatchWarning![0]).toContain("spawn failed: ENOENT");
      // Stack trace is logged as the second argument
      expect(typeof dispatchWarning![1]).toBe("string");
      expect(dispatchWarning![1] as string).toContain("spawn failed: ENOENT");
    } finally {
      console.warn = origWarn;
    }
  });

  it("captures error message in running entry failureReason field", async () => {
    let capturedFailureReason: string | null | undefined;
    const origWarn = console.warn;
    console.warn = () => {};

    try {
      const orchestrator = new OrchestratorCore({
        config: createConfig(),
        tracker: createTracker({
          candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        }),
        spawnWorker: async () => {
          throw new Error("workspace init failed");
        },
        timerScheduler: createFakeTimerScheduler(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      // Intercept state to capture the transient running entry
      const state = orchestrator.getState();
      const origRunning = state.running;
      const handler: ProxyHandler<typeof state.running> = {
        set(_target, prop, value) {
          if (
            typeof prop === "string" &&
            value?.failureReason &&
            !capturedFailureReason
          ) {
            capturedFailureReason = value.failureReason;
          }
          _target[prop as string] = value;
          return true;
        },
        deleteProperty(_target, prop) {
          delete _target[prop as string];
          return true;
        },
        get(_target, prop, receiver) {
          return Reflect.get(_target, prop, receiver);
        },
      };
      (state as { running: typeof state.running }).running = new Proxy(
        origRunning,
        handler,
      );

      await orchestrator.pollTick();

      expect(capturedFailureReason).toBe("workspace init failed");
    } finally {
      console.warn = origWarn;
    }
  });

  it("stores error message in retry entry on dispatch failure", async () => {
    const origWarn = console.warn;
    console.warn = () => {};

    try {
      const orchestrator = new OrchestratorCore({
        config: createConfig(),
        tracker: createTracker({
          candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        }),
        spawnWorker: async () => {
          throw new Error("connection refused");
        },
        timerScheduler: createFakeTimerScheduler(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await orchestrator.pollTick();

      const retry = orchestrator.getState().retryAttempts["1"];
      expect(retry).toBeDefined();
      expect(retry!.error).toBe("connection refused");
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("onIssueDropped callback", () => {
  it("calls onIssueDropped when retry timer releases issue not in candidates", async () => {
    const timers = createFakeTimerScheduler();
    const dropped: Array<{
      issueId: string;
      identifier: string;
      title: string | null;
      reason: string;
    }> = [];
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      onIssueDropped: (input) => {
        dropped.push(input);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped",
    });

    // Set candidates to empty so issue won't be found
    const emptyTracker = createTracker({ candidates: [] });
    orchestrator.updateTracker(emptyTracker);

    await orchestrator.onRetryTimer("1");

    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.identifier).toBe("ISSUE-1");
    expect(dropped[0]!.reason).toBe("issue no longer in candidate list");
  });

  it("calls onIssueDropped when retry timer releases ineligible issue", async () => {
    const timers = createFakeTimerScheduler();
    const dropped: Array<{
      issueId: string;
      identifier: string;
      title: string | null;
      reason: string;
    }> = [];
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      onIssueDropped: (input) => {
        dropped.push(input);
      },
    });

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped",
    });

    // Issue still in candidates but in a non-active state (Backlog)
    const backlogTracker = createTracker({
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1", state: "Backlog" }),
      ],
    });
    orchestrator.updateTracker(backlogTracker);

    await orchestrator.onRetryTimer("1");

    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.identifier).toBe("ISSUE-1");
    expect(dropped[0]!.reason).toBe("issue no longer eligible for retry");
  });
});

describe("isFirstDispatch flag", () => {
  it("passes isFirstDispatch true on first dispatch and false on retry", async () => {
    const timers = createFakeTimerScheduler();
    const dispatches: Array<{ identifier: string; isFirstDispatch: boolean }> =
      [];

    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });

    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async (input) => {
        dispatches.push({
          identifier: input.issue.identifier,
          isFirstDispatch: input.isFirstDispatch,
        });
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // First dispatch
    await orchestrator.pollTick();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.isFirstDispatch).toBe(true);

    // Abnormal exit -> retry
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "error",
    });

    await orchestrator.onRetryTimer("1");
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]!.isFirstDispatch).toBe(false);
  });
});
