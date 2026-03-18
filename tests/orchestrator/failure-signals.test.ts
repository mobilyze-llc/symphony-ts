import { describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StageDefinition,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("failure signal routing in onWorkerExit", () => {
  it("advances stage normally when no failure signal is present", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE]",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBeNull();
  });

  it("advances stage normally when agentMessage is undefined", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("schedules retry with backoff on [STAGE_FAILED: verify]", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "Tests failed.\n[STAGE_FAILED: verify]\nSee logs.",
    });

    // Stage should NOT advance — stays at investigate
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: verify");
  });

  it("schedules retry with backoff on [STAGE_FAILED: infra]", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: infra");
  });

  it("escalates immediately on [STAGE_FAILED: spec] — no retry", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
  });

  it("triggers rework on [STAGE_FAILED: review] with gate workflow", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createGateWorkflowConfig(),
    });

    // First dispatch puts issue in "implement" stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Should rework back to implement (gate's onRework target)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");
  });

  it("escalates review failure when max rework exceeded", async () => {
    const base = createGateWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 1 },
      },
    };

    const orchestrator = createStagedOrchestrator({ stages });

    await orchestrator.pollTick();

    // First review failure — rework (count 1 of max 1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Re-dispatch from rework
    await orchestrator.onRetryTimer("1");

    // Second review failure — should escalate (count would exceed max)
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
  });

  it("falls back to retry for review failure when no stages configured", async () => {
    const orchestrator = createStagedOrchestrator({ stages: null });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: review");
  });

  it("falls back to retry for review failure when no downstream gate exists", async () => {
    // Three stage config has no gate stages
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // No gate found → falls back to retry
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: review");
  });

  it("does not parse failure signals on abnormal exits", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "process crashed",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    // Abnormal exit should use existing retry behavior, ignoring failure signal
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("worker exited: process crashed");
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
  });

  it("increments rework count across multiple review failures", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createGateWorkflowConfig(),
    });

    await orchestrator.pollTick();

    // First review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    // Re-dispatch
    await orchestrator.onRetryTimer("1");

    // Second review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);
  });
});

// --- Helpers ---

function createStagedOrchestrator(overrides?: {
  stages?: StagesConfig | null;
  candidates?: Issue[];
  onSpawn?: (input: {
    issue: Issue;
    attempt: number | null;
    stage: StageDefinition | null;
    stageName: string | null;
  }) => void;
}) {
  const stages = overrides?.stages !== undefined
    ? overrides.stages
    : createThreeStageConfig();

  const tracker = createTracker({
    candidates: overrides?.candidates ?? [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
    ],
  });

  const options: OrchestratorCoreOptions = {
    config: createConfig({ stages }),
    tracker,
    spawnWorker: async (input) => {
      overrides?.onSpawn?.(input);
      return {
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      };
    },
    now: () => new Date("2026-03-06T00:00:05.000Z"),
  };

  return new OrchestratorCore(options);
}

function createThreeStageConfig(): StagesConfig {
  return {
    initialStage: "investigate",
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
    },
  };
}

function createGateWorkflowConfig(): StagesConfig {
  return {
    initialStage: "implement",
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
        maxRework: 3,
        reviewers: [],
        transitions: {
          onComplete: null,
          onApprove: "merge",
          onRework: "implement",
        },
        linearState: null,
      },
      merge: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "merge.liquid",
        maxTurns: 5,
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
    },
  };
}

function createTracker(input?: {
  candidates?: Issue[];
}): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return input?.candidates?.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        state: issue.state,
      })) ?? [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createConfig(overrides?: {
  stages?: StagesConfig | null;
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
      maxConcurrentAgentsByState: {},
    },
    runner: {
      kind: "codex",
      model: null,
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    server: {
      port: null,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    stages: overrides?.stages !== undefined ? overrides.stages : null,
    escalationState: null,
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
