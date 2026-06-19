/**
 * SYMPH-794 — no-ambient-control-surfaces admission guardrail (core integration).
 *
 * Drives pollTick with the `resolveAdmittedIdentifiers` hook injected directly
 * (the runtime-host wires it from config + the standing-plan store; here we fake
 * it). Locks the invariant: a bare Linear `project` field never arms dispatch —
 * an issue dispatches only via an explicit admit signal (the hook's set or the
 * plan-released set this tick).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type PlanDrivenDispatchDecision,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("admission guardrail (SYMPH-794)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createCore(options: {
    candidates: Issue[];
    resolveAdmittedIdentifiers?: () => Promise<ReadonlySet<string> | null>;
    planDrivenDispatch?: () => Promise<PlanDrivenDispatchDecision>;
  }) {
    const spawned: string[] = [];
    const core = new OrchestratorCore({
      config: createConfig(),
      tracker: createTracker(options.candidates),
      spawnWorker: async ({ issue }) => {
        spawned.push(issue.identifier);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      ...(options.resolveAdmittedIdentifiers
        ? { resolveAdmittedIdentifiers: options.resolveAdmittedIdentifiers }
        : {}),
      ...(options.planDrivenDispatch
        ? { planDrivenDispatch: options.planDrivenDispatch }
        : {}),
      now: () => new Date("2026-06-19T12:00:00.000Z"),
    });
    return { core, spawned };
  }

  it("is inert when the hook returns null — every eligible candidate dispatches (zero-diff)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      resolveAdmittedIdentifiers: async () => null,
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds.sort()).toEqual(["1", "2"]);
    expect(spawned.sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("with no hook at all, dispatch is unchanged (zero-diff default)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(spawned).toEqual(["SYMPH-1"]);
  });

  it("dispatches ONLY explicitly-admitted issues; a bare-project candidate is held", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      resolveAdmittedIdentifiers: async () => new Set(["SYMPH-2"]),
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["2"]);
    expect(spawned).toEqual(["SYMPH-2"]);
    // The held bare-project candidate is journaled (observable), not dispatched.
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
  });

  it("holds EVERYTHING when the hook returns an empty set (bare project ≠ admit / fail-closed)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      resolveAdmittedIdentifiers: async () => new Set<string>(),
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(spawned).toEqual([]);
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
    expect(core.getState().issueDispositions["2"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
  });

  it("fails closed when the hook throws — nothing dispatches this tick (never falls open)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
      resolveAdmittedIdentifiers: async () => {
        throw new Error("journal read failed");
      },
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("admits a plan-RELEASED issue even when it is not in the explicit approval set", async () => {
    // The plan drove dispatch and released SYMPH-1; the explicit-approval set is
    // empty (auto-release frontier, no per-ticket operator approval). Released
    // == admitted, so SYMPH-1 still dispatches; the un-released SYMPH-2 does not
    // even reach the guardrail (the plan already subset it out).
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      planDrivenDispatch: async () => ({
        mode: "plan",
        orderedIssueIdentifiers: ["SYMPH-1"],
      }),
      resolveAdmittedIdentifiers: async () => new Set<string>(),
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(spawned).toEqual(["SYMPH-1"]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function createTracker(candidates: Issue[]): IssueTracker {
  return {
    fetchCandidateIssues: vi.fn(async () => candidates),
    fetchIssuesByStates: vi.fn(async () => [] as Issue[]),
    fetchIssueStatesByIds: vi.fn(async () => []),
  } satisfies IssueTracker;
}

function createConfig(): ResolvedWorkflowConfig {
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
      maxConcurrentAgents: 4,
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
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
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
    stages: createStages(),
    escalationState: "Blocked",
  };
}

function createStages(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "codex",
        model: null,
        prompt: "investigate.liquid",
        maxTurns: 8,
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
