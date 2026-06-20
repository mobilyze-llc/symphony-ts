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
import { PORTFOLIO_TAXONOMY_PROJECTS } from "../../src/portfolio/taxonomy.js";
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
      timerScheduler: createFakeTimerScheduler(),
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

  it("holds portfolio-invalid candidates before dispatch even when the admission hook is disabled", async () => {
    const project = PORTFOLIO_TAXONOMY_PROJECTS.find(
      (entry) => entry.name === "Runtime Operations & Admission Safety",
    )!;
    const { core, spawned } = createCore({
      candidates: [
        issue("1", "SYMPH-1", {
          teamKey: "SYMPH",
          projectId: null,
          projectSlug: null,
          projectName: null,
        }),
        issue("2", "SYMPH-2", {
          teamKey: "SYMPH",
          projectId: project.id,
          projectSlug: project.slugId,
          projectName: project.name,
        }),
      ],
    });

    const result = await core.pollTick();

    expect(result.dispatchedIssueIds).toEqual(["2"]);
    expect(spawned).toEqual(["SYMPH-2"]);
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "portfolio_project_missing",
    });
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
    // The plan drove dispatch and released SYMPH-1 (auto-release frontier, no
    // per-ticket operator approval). On the plan path the guardrail is SKIPPED
    // (dispatchList is already the released set), so SYMPH-1 dispatches and the
    // un-released SYMPH-2 was already subset out by the plan.
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

  it("on the plan path, a throwing approval hook does NOT block plan-released dispatch (guardrail skipped)", async () => {
    // council R1 (Codex P1): when the plan drove, admission is enforced by
    // release, so the guardrail is skipped entirely — a store error reading the
    // EXTRA approvals can neither block a validly-released issue nor fall open.
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
      planDrivenDispatch: async () => ({
        mode: "plan",
        orderedIssueIdentifiers: ["SYMPH-1"],
      }),
      resolveAdmittedIdentifiers: async () => {
        throw new Error("approve store read failed");
      },
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["1"]);
    expect(spawned).toEqual(["SYMPH-1"]);
  });

  it("on an explicit plan DEGRADE, a bare-project candidate is held (council R1, Pi P2)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      planDrivenDispatch: async () => ({ mode: "degrade" }),
      resolveAdmittedIdentifiers: async () => new Set(["SYMPH-2"]),
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["2"]);
    expect(spawned).toEqual(["SYMPH-2"]);
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
  });

  it("when the plan hook THROWS, the guardrail still gates the comparator frontier (council R1, Pi P2)", async () => {
    // The plan hook throwing degrades to the comparator (planDroveThisTick=false),
    // so the guardrail runs over the full frontier — a bare-project candidate is
    // held, the explicitly-approved one dispatches.
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1"), issue("2", "SYMPH-2")],
      planDrivenDispatch: async () => {
        throw new Error("plan hook failed");
      },
      resolveAdmittedIdentifiers: async () => new Set(["SYMPH-2"]),
    });
    const result = await core.pollTick();
    expect(result.dispatchedIssueIds).toEqual(["2"]);
    expect(spawned).toEqual(["SYMPH-2"]);
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
  });

  // The retry-timer path is a second dispatch entry point that reads
  // fetchCandidateIssues() (the team-scoped backlog when armed) and calls
  // dispatchIssue(). It must honor the same gate as pollTick (council finding A):
  // a retry whose admit signal was revoked / superseded must NOT re-dispatch.
  it("retry path enforces the gate: a retry whose admit signal was revoked is HELD, not re-dispatched (SYMPH-794, council A)", async () => {
    let admitCall = 0;
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
      resolveAdmittedIdentifiers: async () => {
        admitCall += 1;
        // Admitted on the first dispatch (pollTick), then the operator revokes
        // (or a re-plan supersedes) the approval before the retry fires.
        return admitCall <= 1 ? new Set(["SYMPH-1"]) : new Set<string>();
      },
    });

    await core.pollTick();
    expect(spawned).toEqual(["SYMPH-1"]); // first dispatch admitted

    const retryEntry = await core.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      endedAt: new Date("2026-06-19T12:00:05.000Z"),
    });
    expect(retryEntry).not.toBeNull();

    const result = await core.onRetryTimer("1");
    expect(result.dispatched).toBe(false);
    expect(spawned).toEqual(["SYMPH-1"]); // NO second spawn — the gate held it
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });
  });

  it("retry path still dispatches when the issue remains admitted (no false hold)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
      resolveAdmittedIdentifiers: async () => new Set(["SYMPH-1"]),
    });

    await core.pollTick();
    expect(spawned).toEqual(["SYMPH-1"]);

    await core.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      endedAt: new Date("2026-06-19T12:00:05.000Z"),
    });
    const result = await core.onRetryTimer("1");
    expect(result.dispatched).toBe(true);
    expect(spawned).toEqual(["SYMPH-1", "SYMPH-1"]); // re-dispatched (still admitted)
  });

  it("retry path is inert when the gate is disabled (null) — zero-diff for project-scoped (council A)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
      resolveAdmittedIdentifiers: async () => null, // guardrail off
    });

    await core.pollTick();
    expect(spawned).toEqual(["SYMPH-1"]);

    await core.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      endedAt: new Date("2026-06-19T12:00:05.000Z"),
    });
    const result = await core.onRetryTimer("1");
    expect(result.dispatched).toBe(true);
    expect(spawned).toEqual(["SYMPH-1", "SYMPH-1"]); // unchanged legacy behavior
  });

  // SYMPH-825: the chokepoint is the structural backstop. Drive it directly to
  // prove that an unadmitted issue reaching it (the bug a forgotten per-path gate
  // would cause) fails CLOSED — it never spawns and journals a gate verdict.
  it("chokepoint backstop: admitAndDispatch fails closed for an unadmitted issue and never spawns (SYMPH-825)", async () => {
    const { core, spawned } = createCore({
      candidates: [issue("1", "SYMPH-1")],
    });
    const chokepoint = (
      core as unknown as {
        admitAndDispatch: (
          issue: Issue,
          attempt: number | null,
          admitted: ReadonlySet<string> | null,
        ) => Promise<{ dispatched: boolean; disposition: string }>;
      }
    ).admitAndDispatch.bind(core);

    // Admitted set excludes SYMPH-1 → held, no spawn, observable gate verdict.
    const gated = await chokepoint(
      issue("1", "SYMPH-1"),
      null,
      new Set<string>(),
    );
    expect(gated.dispatched).toBe(false);
    expect(gated.disposition).toBe("admission_gate");
    expect(spawned).toEqual([]);
    expect(core.getState().issueDispositions["1"]).toMatchObject({
      disposition: "gate",
      reasonCode: "admit_signal_required",
    });

    // A null admitted set is inert (gate off) → dispatch proceeds and spawns.
    const dispatched = await chokepoint(issue("1", "SYMPH-1"), null, null);
    expect(dispatched.dispatched).toBe(true);
    expect(spawned).toEqual(["SYMPH-1"]);
  });
});

function createFakeTimerScheduler() {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    scheduled,
    set(callback: () => void, delayMs: number) {
      scheduled.push({ callback, delayMs });
      return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issue(
  id: string,
  identifier: string,
  overrides: Partial<Issue> = {},
): Issue {
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
    ...overrides,
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
