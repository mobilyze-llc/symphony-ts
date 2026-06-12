import { describe, expect, it } from "vitest";

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

describe("dispatcher decision event emission", () => {
  it("emits measurable admission, right-sizing, and model-routing events on dispatch", async () => {
    const orchestrator = createOrchestrator({
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

    await orchestrator.pollTick();

    const decisionEntries = orchestrator
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "dispatcher_decision",
      );

    expect(decisionEntries).toHaveLength(3);
    expect(
      decisionEntries.map((entry) => entry.metadata.decisionEvent),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "admission",
          expectedOutcome: expect.objectContaining({
            decision: "admit",
          }),
          observedOutcome: expect.objectContaining({
            decision: "admit",
          }),
        }),
        expect.objectContaining({
          category: "right_sizing",
          expectedOutcome: expect.objectContaining({
            decision: "prototype",
          }),
          observedOutcome: null,
        }),
        expect.objectContaining({
          category: "model_routing",
          expectedOutcome: expect.objectContaining({
            decision: "stay_deterministic",
          }),
          observedOutcome: null,
        }),
      ]),
    );
  });

  it("emits measurable pause and re-steer events when deterministic supervision blocks a co-run", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            description: "## Declared file scope\n- src/shared/config.ts\n",
          }),
          createIssue({
            id: "2",
            identifier: "ISSUE-2",
            priority: 2,
            description:
              "## Declared file scope\n- src/shared/config.ts\n- src/features/two.ts\n",
          }),
        ],
      }),
      requestSupervisionResteer: async () => undefined,
    });

    await orchestrator.pollTick();

    const decisionEvents = orchestrator
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "dispatcher_decision",
      )
      .map((entry) => entry.metadata.decisionEvent);

    expect(decisionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "admission",
          issueIdentifier: "ISSUE-2",
          expectedOutcome: expect.objectContaining({
            decision: "pause",
          }),
          observedOutcome: expect.objectContaining({
            decision: "pause",
          }),
        }),
        expect.objectContaining({
          category: "re_steer",
          expectedOutcome: expect.objectContaining({
            decision: "request_re_steer",
          }),
          observedOutcome: expect.objectContaining({
            decision: "request_re_steer",
          }),
        }),
      ]),
    );
  });
});

function createOrchestrator(overrides?: {
  tracker?: IssueTracker;
  requestSupervisionResteer?: OrchestratorCoreOptions["requestSupervisionResteer"];
  stages?: StagesConfig | null;
}): OrchestratorCore {
  const stages = overrides?.stages !== undefined ? overrides.stages : null;
  const options: OrchestratorCoreOptions = {
    config: createConfig({ stages }),
    tracker: overrides?.tracker ?? createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: () => new Date("2026-03-06T00:00:05.000Z"),
  };
  if (overrides?.requestSupervisionResteer !== undefined) {
    options.requestSupervisionResteer = overrides.requestSupervisionResteer;
  }
  return new OrchestratorCore(options);
}

function createTracker(input?: { candidates?: Issue[] }): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return (
        input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })]
      );
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [];
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
      activeStates: ["Todo", "In Progress", "In Review", "Resume"],
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
    runner: {
      kind: "codex",
      model: null,
    },
    stages: overrides?.stages ?? null,
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
