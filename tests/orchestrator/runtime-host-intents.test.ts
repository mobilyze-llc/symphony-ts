/**
 * SYMPH-408b: the runtime host as the dashboard's intent adapter.
 *
 * - requestIntent resolves the target issue (id, running lane, retry lane,
 *   tracker active states) and routes writeIntent — no verb semantics of
 *   its own.
 * - requestPipelinePause/Resume journal a pipeline-scoped, actor-attributed
 *   intent entry BEFORE any tracker (Linear halt-issue) manipulation: the
 *   Linear state change is a view applied after journaling intent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { StructuredLogger } from "../../src/logging/structured-logger.js";
import { OrchestratorRuntimeHost } from "../../src/orchestrator/runtime-host.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("OrchestratorRuntimeHost.requestIntent", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createHost(input?: { activeIssues?: Issue[] }) {
    const root = mkdtempSync(join(tmpdir(), "symphony-intents-"));
    roots.push(root);
    const tracker = createTracker({
      activeIssues: input?.activeIssues ?? [],
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(root),
      tracker,
      logger: new StructuredLogger([]),
      agentRunner: {
        run: () =>
          new Promise(() => {
            /* never resolves; tests never dispatch */
          }),
      },
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });
    return { host, tracker };
  }

  function intentEntries(host: OrchestratorRuntimeHost) {
    return host
      .getState()
      .dispatcherRunJournal.filter((entry) => entry.kind === "intent");
  }

  it("applies a park by explicit issueId and journals the request actor", async () => {
    const { host } = createHost();
    const result = await host.requestIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      reason: "pausing for deploy",
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
    });

    expect(result.status).toBe("applied");
    expect(result.issue_id).toBe("1");
    expect(typeof result.sequence).toBe("number");
    expect(host.getState().resumeRequired.has("1")).toBe(true);

    const entry = intentEntries(host)[0];
    expect(entry?.metadata.verb).toBe("park");
    expect(entry?.metadata.actor).toEqual({
      kind: "operator",
      host: "pro14",
      session: "symphonyctl",
    });
    expect(entry?.metadata.reason).toEqual({
      class: "api:park",
      human: "pausing for deploy",
    });
  });

  it("resolves an issueIdentifier through the tracker's active states", async () => {
    const { host, tracker } = createHost({
      activeIssues: [createIssue({ id: "42", identifier: "SYMPH-42" })],
    });
    const result = await host.requestIntent({
      verb: "park",
      issueIdentifier: "SYMPH-42",
      reason: "operator park via identifier",
      actor: { kind: "operator", host: "pro14" },
    });

    expect(result.status).toBe("applied");
    expect(result.issue_id).toBe("42");
    expect(result.issue_identifier).toBe("SYMPH-42");
    expect(tracker.fetchIssuesByStates).toHaveBeenCalled();
    expect(host.getState().resumeRequired.has("42")).toBe(true);
  });

  it("returns issue_not_found for an unresolvable identifier", async () => {
    const { host } = createHost();
    const result = await host.requestIntent({
      verb: "release",
      issueIdentifier: "SYMPH-404",
      reason: "release",
      actor: { kind: "operator", host: "pro14" },
    });

    expect(result.status).toBe("issue_not_found");
    expect(result.sequence).toBeNull();
    expect(intentEntries(host)).toHaveLength(0);
  });

  it("forwards a stale fence and reports rejected_stale", async () => {
    const { host } = createHost();
    const result = await host.requestIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      reason: "release with stale fence",
      actor: { kind: "operator", host: "pro14" },
      fence: { expectedParkSeq: 999 },
    });
    expect(result.status).toBe("rejected_stale");
    expect(result.detail).toContain("stale fence");
  });
});

describe("pipeline pause/resume journal-first intent (SYMPH-408b)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createHost() {
    const root = mkdtempSync(join(tmpdir(), "symphony-pipeline-intents-"));
    roots.push(root);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(root),
      tracker: createTracker({ activeIssues: [] }),
      logger: new StructuredLogger([]),
      agentRunner: {
        run: () =>
          new Promise(() => {
            /* never resolves; tests never dispatch */
          }),
      },
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });
    return host;
  }

  it("pause journals an applied pipeline_pause intent attributed to the requesting actor", async () => {
    const host = createHost();
    await host.requestPipelinePause({
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
      reason: "halting for deploy",
    });

    const entry = host
      .getState()
      .dispatcherRunJournal.find(
        (candidate) =>
          candidate.kind === "intent" &&
          candidate.metadata.verb === "pipeline_pause",
      );
    expect(entry).toBeDefined();
    expect(entry?.metadata.status).toBe("applied");
    expect(entry?.metadata.scope).toBe("pipeline");
    expect(entry?.metadata.actor).toEqual({
      kind: "operator",
      host: "pro14",
      session: "symphonyctl",
    });
    expect(entry?.metadata.reason).toEqual({
      class: "operator_pipeline_pause",
      human: "halting for deploy",
    });
    expect(entry?.summary).toContain("by operator@pro14");
  });

  it("resume on a non-paused pipeline journals a no_op pipeline_resume intent", async () => {
    const host = createHost();
    await host.requestPipelineResume({
      actor: { kind: "watchdog-l2", host: "pro14" },
      reason: "resuming after page",
    });

    const entry = host
      .getState()
      .dispatcherRunJournal.find(
        (candidate) =>
          candidate.kind === "intent" &&
          candidate.metadata.verb === "pipeline_resume",
      );
    expect(entry).toBeDefined();
    expect(entry?.metadata.status).toBe("no_op");
    expect(entry?.metadata.actor).toEqual({
      kind: "watchdog-l2",
      host: "pro14",
      session: null,
    });
  });

  it("an attribution-less pause defaults to an operator actor on this host", async () => {
    const host = createHost();
    await host.requestPipelinePause();

    const entry = host
      .getState()
      .dispatcherRunJournal.find(
        (candidate) =>
          candidate.kind === "intent" &&
          candidate.metadata.verb === "pipeline_pause",
      );
    expect(entry).toBeDefined();
    const actor = entry?.metadata.actor as { kind: string; host: string };
    expect(actor.kind).toBe("operator");
    expect(actor.host.length).toBeGreaterThan(0);
  });

  it("pipeline-scoped intent entries do not leak issue state on replay", async () => {
    const host = createHost();
    await host.requestPipelinePause({
      actor: { kind: "operator", host: "pro14" },
      reason: "halting for deploy",
    });

    // The synthetic "pipeline" issue scope must never surface as a parked
    // issue: replay reduction ignores pipeline_* verbs.
    expect(host.getState().resumeRequired.has("pipeline")).toBe(false);
    expect(host.getState().resumeRequiredMarks.pipeline).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTracker(input: { activeIssues: Issue[] }) {
  return {
    fetchCandidateIssues: vi.fn(async () => [] as Issue[]),
    fetchIssuesByStates: vi.fn(async () => input.activeIssues),
    fetchIssueStatesByIds: vi.fn(async () => []),
  } satisfies IssueTracker & {
    fetchIssuesByStates: ReturnType<typeof vi.fn>;
  };
}

function createConfig(workspaceRoot: string): ResolvedWorkflowConfig {
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
    workspace: { root: workspaceRoot },
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
    pauseTriage: { baseUrl: null, model: null, apiKey: null, maxResumes: 2 },
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    budgetEscalation: { maxSteps: null, multiplier: 2 },
    rateLimitAdmission: {
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: null,
    },
    server: { port: null, slackNotifyChannel: null },
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
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}
