import { describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { classifyCouncilRiskPaths } from "../../src/orchestrator/council-risk-predicate.js";
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
    expect(decision.signals.impactSurface).toBe("shared");
    expect(decision.triggerHits).toEqual(
      expect.arrayContaining([
        "heavy_gate_requirements",
        "high_cost_budget",
        "high_risk_files",
        "priority_high",
        "repeat_retry",
      ]),
    );
    expect(decision.riskPredicate).toMatchObject({
      triggerHits: expect.arrayContaining([
        "high_risk_path",
        "journal_producer",
        "state_journal_projection",
      ]),
      matchedPaths: [
        "src/config/config-resolver.ts",
        "src/orchestrator/runtime-host.ts",
      ],
    });
    expect(decision.modelRouting.allowed).toBe(true);
  });

  it("uses the shared predicate for the existing right-sizing high-risk path set", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/tracker/linear.ts\n",
      }),
      config: createConfig(),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.signals.highRiskFiles).toEqual(["src/tracker/linear.ts"]);
    expect(decision.triggerHits).toContain("high_risk_files");
    expect(decision.riskPredicate).toMatchObject({
      triggerHits: ["high_risk_path"],
      matchedPaths: ["src/tracker/linear.ts"],
    });
    expect(decision.modelRouting.allowed).toBe(true);
  });

  it("keeps highRiskFiles as a compatibility alias for matched risk-predicate paths", () => {
    const decision = createRightSizingDecision({
      issue: createIssue(),
      config: createConfig(),
      stageName: "implement",
      attempt: null,
      changedFiles: [
        "src/orchestrator/B.ts",
        "src/orchestrator/a.ts",
        "src/orchestrator/B.ts",
      ],
    });

    expect(decision.signals.highRiskFiles).toBe(
      decision.riskPredicate.matchedPaths,
    );
    expect(decision.signals.highRiskFiles).toEqual([
      "src/orchestrator/a.ts",
      "src/orchestrator/B.ts",
    ]);
  });

  it("treats journal-risk paths as right-sizing high-risk inputs", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/logging/run-journal.ts\n",
      }),
      config: createConfig(),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.signals.impactSurface).toBe("shared");
    expect(decision.signals.highRiskFiles).toEqual([
      "src/logging/run-journal.ts",
    ]);
    expect(decision.triggerHits).toContain("high_risk_files");
    expect(decision.riskPredicate).toMatchObject({
      triggerHits: ["journal_producer"],
      matchedPaths: ["src/logging/run-journal.ts"],
    });
    expect(decision.modelRouting.allowed).toBe(true);
  });

  it("escalates investigate reasoning effort for risk-predicate matches when configured", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/logging/run-journal.ts\n",
      }),
      config: createConfig({
        riskPredicateReasoning: { effort: "high" },
      }),
      stageName: "investigate",
      attempt: null,
    });

    expect(decision.reasoningEffort).toMatchObject({
      configuredEffort: "high",
      selectedEffort: "high",
      escalated: true,
      reason: "risk_predicate",
      stageEligible: true,
      riskPredicateTriggers: ["journal_producer"],
      matchedPaths: ["src/logging/run-journal.ts"],
      sameFamilyTripwire: false,
    });
  });

  for (const sample of [
    {
      label: "journal replay reducer",
      path: "src/orchestrator/decision-quality.ts",
      stageName: "implement",
      trigger: "journal_replay_reducer",
    },
    {
      label: "dispatcher event vocabulary",
      path: "src/domain/model.ts",
      stageName: "implement",
      trigger: "dispatcher_event_vocabulary",
    },
    {
      label: "state journal projection",
      path: "src/logging/runtime-snapshot.ts",
      stageName: "investigate",
      trigger: "state_journal_projection",
    },
    {
      label: "high-risk path",
      path: "src/config/config-resolver.ts",
      stageName: "investigate",
      trigger: "high_risk_path",
    },
  ] as const) {
    it(`escalates ${sample.stageName} reasoning effort for ${sample.label} matches`, () => {
      const decision = createRightSizingDecision({
        issue: createIssue({
          description: `## Declared file scope\n- ${sample.path}\n`,
        }),
        config: createConfig({
          riskPredicateReasoning: { effort: "high" },
        }),
        stageName: sample.stageName,
        attempt: null,
      });

      expect(decision.reasoningEffort).toMatchObject({
        selectedEffort: "high",
        escalated: true,
        reason: "risk_predicate",
        stageEligible: true,
        matchedPaths: [sample.path],
      });
      expect(decision.reasoningEffort.riskPredicateTriggers).toContain(
        sample.trigger,
      );
    });
  }

  it("keeps risk-predicate effort bounded to investigate and implement stages", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/logging/run-journal.ts\n",
      }),
      config: createConfig({
        riskPredicateReasoning: { effort: "high" },
      }),
      stageName: "review",
      attempt: null,
    });

    expect(decision.reasoningEffort).toMatchObject({
      configuredEffort: "high",
      selectedEffort: null,
      escalated: false,
      reason: "stage_not_eligible",
      stageEligible: false,
    });
  });

  it("escalates implement rework after a same-family trip-wire fires", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config: createConfig({
        riskPredicateReasoning: { effort: "high" },
      }),
      stageName: "implement",
      attempt: 1,
      sameFamilyTripwire: true,
    });

    expect(decision.riskPredicate.triggerHits).toEqual([]);
    expect(decision.reasoningEffort).toMatchObject({
      selectedEffort: "high",
      escalated: true,
      reason: "same_family_tripwire",
      stageEligible: true,
      sameFamilyTripwire: true,
    });
  });

  it("does not escalate reasoning effort without the config knob", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/logging/run-journal.ts\n",
      }),
      config: createConfig(),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.reasoningEffort).toMatchObject({
      configuredEffort: null,
      selectedEffort: null,
      escalated: false,
      reason: "not_configured",
    });
  });

  it("keeps reasoning effort at command defaults until a stage opts in", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        labels: ["mode:full"],
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config: createConfig({
        stages: createStages({
          initialStage: "implement",
          stages: {
            implement: createAgentStage({
              maxTurns: 30,
              onComplete: "done",
            }),
            done: createTerminalStage(),
          },
        }),
      }),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.mode).toBe("full");
    expect(decision.reasoningEffort).toMatchObject({
      stageEffort: null,
      modeEffort: null,
      selectedEffort: null,
      reason: "not_configured",
    });
  });

  it("adjusts opted-in implement reasoning effort by right-sizing mode", () => {
    const config = createConfig({
      stages: createStages({
        initialStage: "implement",
        stages: {
          implement: createAgentStage({
            maxTurns: 30,
            onComplete: "done",
            reasoningEffort: "medium",
          }),
          done: createTerminalStage(),
        },
      }),
    });

    const prototype = createRightSizingDecision({
      issue: createIssue({
        labels: ["mode:prototype"],
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config,
      stageName: "implement",
      attempt: null,
    });
    const full = createRightSizingDecision({
      issue: createIssue({
        labels: ["mode:full"],
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config,
      stageName: "implement",
      attempt: null,
    });

    expect(prototype.reasoningEffort).toMatchObject({
      stageEffort: "medium",
      modeEffort: "low",
      selectedEffort: "low",
      reason: "mode_mapping",
    });
    expect(full.reasoningEffort).toMatchObject({
      stageEffort: "medium",
      modeEffort: "high",
      selectedEffort: "high",
      reason: "mode_mapping",
    });
  });

  it("leaves benign ordinary source files outside the risk predicate", () => {
    const decision = createRightSizingDecision({
      issue: createIssue({
        description: "## Declared file scope\n- src/features/copy.ts\n",
      }),
      config: createConfig(),
      stageName: "implement",
      attempt: null,
    });

    expect(decision.signals.highRiskFiles).toEqual([]);
    expect(decision.riskPredicate).toEqual({
      triggerHits: [],
      matchedPaths: [],
      matches: [],
    });
    expect(decision.modelRouting).toEqual({
      allowed: false,
      reason: "not_needed",
    });
  });
});

describe("Council v2 risk predicate", () => {
  it("fires for journal producers", () => {
    const result = classifyCouncilRiskPaths(["src/logging/run-journal.ts"]);

    expect(result.triggerHits).toContain("journal_producer");
    expect(result.matchedPaths).toEqual(["src/logging/run-journal.ts"]);
    expect(result.matches).toContainEqual(
      expect.objectContaining({
        trigger: "journal_producer",
        path: "src/logging/run-journal.ts",
      }),
    );
  });

  it("fires for journal replay reducer paths", () => {
    const result = classifyCouncilRiskPaths(["src/orchestrator/core.ts"]);

    expect(result.triggerHits).toContain("journal_replay_reducer");
    expect(result.matchedPaths).toEqual(["src/orchestrator/core.ts"]);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trigger: "journal_replay_reducer",
          path: "src/orchestrator/core.ts",
        }),
      ]),
    );
  });

  it("fires for dispatcher run-journal event-kind vocabulary", () => {
    const result = classifyCouncilRiskPaths(["src/domain/model.ts"]);

    expect(result.triggerHits).toEqual(["dispatcher_event_vocabulary"]);
    expect(result.matchedPaths).toEqual(["src/domain/model.ts"]);
  });

  it("fires for state delta and snapshot journal projection", () => {
    const result = classifyCouncilRiskPaths([
      "src/logging/runtime-snapshot.ts",
    ]);

    expect(result.triggerHits).toEqual(["state_journal_projection"]);
    expect(result.matchedPaths).toEqual(["src/logging/runtime-snapshot.ts"]);
  });

  it("deduplicates and sorts matched paths with shared path ordering", () => {
    const result = classifyCouncilRiskPaths([
      "src/orchestrator/B.ts",
      "src/orchestrator/a.ts",
      "./src/orchestrator/B.ts",
      " src/orchestrator/a.ts ",
    ]);

    expect(result.matchedPaths).toEqual([
      "src/orchestrator/a.ts",
      "src/orchestrator/B.ts",
    ]);
    expect(result.matches.map((match) => match.path)).toEqual([
      "src/orchestrator/a.ts",
      "src/orchestrator/B.ts",
    ]);
  });

  it("does not fire for benign ordinary source files", () => {
    expect(classifyCouncilRiskPaths(["src/features/copy.ts"])).toEqual({
      triggerHits: [],
      matchedPaths: [],
      matches: [],
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
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
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
    acGate: {
      enabled: false,
    },
    specFidelity: {
      enabled: false,
    },
    admissionCard: {
      enabled: false,
    },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
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
      host: null,
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
  reasoningEffort?: "low" | "medium" | "high";
}) {
  return {
    type: "agent" as const,
    runner: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: input.reasoningEffort ?? null,
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
