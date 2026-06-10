import { describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { createRightSizingDecision } from "../../src/orchestrator/right-sizing.js";

describe("deterministic right-sizing", () => {
  it("classifies a trivial narrow unit as prototype", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        labels: ["trivial"],
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config: createConfig({
        stages: createStages({
          initialStage: "implement",
          stages: {
            implement: createAgentStage({
              maxTurns: 6,
              onComplete: "done",
            }),
            done: createTerminalStage(),
          },
        }),
      }),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.mode).toBe("prototype");
    expect(decision.signals.impactSurface).toBe("narrow");
    expect(decision.modelRouting).toEqual({
      allowed: false,
      reason: "not_needed",
    });
  });

  it("classifies a narrow merge-path unit as thin", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/features/timeline.ts\n",
      }),
      config: createConfig({
        stages: createStages({
          initialStage: "implement",
          stages: {
            implement: createAgentStage({
              maxTurns: 18,
              onComplete: "review",
            }),
            review: createGateStage({
              onApprove: "merge",
            }),
            merge: createAgentStage({
              maxTurns: 10,
              onComplete: "done",
            }),
            done: createTerminalStage(),
          },
        }),
      }),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.mode).toBe("thin");
    expect(decision.signals.gateCount).toBe(1);
    expect(decision.signals.budget).toBe("medium");
  });

  it("classifies a retried high-risk unit as full and allows model routing on trigger hits", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        priority: 1,
        labels: ["risk:high"],
        description:
          "## Declared file scope\n- src/orchestrator/runtime-host.ts\n- src/config/config-resolver.ts\n",
      }),
      config: createConfig({
        stages: createStages({
          initialStage: "investigate",
          stages: {
            investigate: createAgentStage({
              maxTurns: 12,
              onComplete: "review",
            }),
            review: createGateStage({
              onApprove: "merge",
              reviewers: 2,
            }),
            merge: createAgentStage({
              maxTurns: 30,
              onComplete: "acceptance",
            }),
            acceptance: createGateStage({
              gateType: "human",
              onApprove: "done",
            }),
            done: createTerminalStage(),
          },
        }),
      }),
      stageName: "investigate",
      attempt: 2,
      changedFiles: ["src/orchestrator/runtime-host.ts"],
    });

    expect(decision.mode).toBe("full");
    expect(decision.triggerHits).toEqual(
      expect.arrayContaining([
        "heavy_gate_requirements",
        "high_cost_budget",
        "high_risk_files",
        "priority_high",
        "repeat_retry",
      ]),
    );
    expect(decision.modelRouting).toEqual({
      allowed: true,
      reason: "risk_trigger",
    });
  });
});

function createConfig(
  overrides?: Partial<ResolvedWorkflowConfig>,
): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Ship it.",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example",
      apiKey: "token",
      projectSlug: "ENG",
      activeStates: ["Todo", "In Progress", "In Review"],
      terminalStates: ["Done"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/symphony",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 4,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 4,
      maxConcurrentAgentsByState: {},
    },
    runner: {
      kind: "codex",
      model: null,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    },
    pauseTriage: {
      baseUrl: null,
      model: null,
      apiKey: null,
      maxResumes: 2,
    },
    budgetEscalation: {
      maxSteps: null,
      multiplier: 2,
    },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    server: {
      port: null,
      slackNotifyChannel: null,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    stages: null,
    escalationState: null,
    ...overrides,
  };
}

function createStages(overrides: Partial<StagesConfig>): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {},
    ...overrides,
  };
}

function createAgentStage(input: {
  maxTurns: number;
  onComplete: string | null;
}) {
  return {
    type: "agent" as const,
    runner: "codex",
    model: "gpt-5.3-codex",
    prompt: null,
    maxTurns: input.maxTurns,
    timeoutMs: null,
    concurrency: null,
    gateType: null,
    maxRework: null,
    reviewers: [],
    transitions: {
      onComplete: input.onComplete,
      onApprove: null,
      onRework: null,
    },
    linearState: null,
  };
}

function createGateStage(input: {
  onApprove: string | null;
  gateType?: "ensemble" | "human";
  reviewers?: number;
}) {
  return {
    type: "gate" as const,
    runner: null,
    model: null,
    prompt: null,
    maxTurns: null,
    timeoutMs: null,
    concurrency: null,
    gateType: input.gateType ?? "ensemble",
    maxRework: null,
    reviewers: Array.from({ length: input.reviewers ?? 1 }, (_, index) => ({
      runner: "codex",
      model: `reviewer-${index + 1}`,
      role: `reviewer-${index + 1}`,
      prompt: null,
    })),
    transitions: {
      onComplete: null,
      onApprove: input.onApprove,
      onRework: "implement",
    },
    linearState: null,
  };
}

function createTerminalStage() {
  return {
    type: "terminal" as const,
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
    linearState: null,
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Issue 1",
    description: null,
    priority: 2,
    state: "Todo",
    branchName: "codex/ISSUE-1",
    url: "https://linear.example/ISSUE-1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-06T00:00:00.000Z",
    updatedAt: "2026-03-06T00:00:00.000Z",
    ...overrides,
  };
}
