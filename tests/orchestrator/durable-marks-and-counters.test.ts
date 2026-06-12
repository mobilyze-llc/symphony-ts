/**
 * SYMPH-406 + SYMPH-401: replay-reduced explicit-resume marks and durable
 * escalation/triage/spend counters.
 *
 * Both tickets collapse into the SYMPH-405 journal: the marks and counters
 * are REDUCED from already-journaled events at startup (recoverFromRunJournal)
 * instead of living in a bespoke persistence store. These tests restart the
 * orchestrator by handing one core's journal to a fresh core.
 */
import { describe, expect, it } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  Issue,
} from "../../src/domain/model.js";
import { buildRuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

const NOW = new Date("2026-06-12T00:00:05.000Z");

const BUDGET_PAUSE = {
  outcome: "PAUSED-budget" as const,
  trigger: "token_budget" as const,
  reason: "Token budget exceeded: 250001 >= 250000.",
  turnCount: 2,
  totalTokens: 250_001,
  estimatedCostUsd: 5.2,
};

describe("SYMPH-406: requires-explicit-resume marks are persistent and visible", () => {
  it("surfaces the mark in the snapshot with reason + event cursor, and the skip emits a deduped verdict", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });

    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    const hardStopEntry = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) =>
          entry.kind === "hard_stop_trigger" &&
          entry.metadata.outcome === "PAUSED-budget",
      );
    expect(hardStopEntry).toBeDefined();

    const snapshot = buildRuntimeSnapshot(orchestrator.getState(), {
      now: NOW,
    });
    expect(snapshot.explicit_resume_required?.["1"]).toEqual({
      reason: "hard_stop:token_budget",
      set_by_sequence: hardStopEntry?.sequence,
      since: expect.any(String),
    });

    // Todo alone is skipped — loudly, once.
    const todoIssue = createIssue({ id: "1", state: "Todo" });
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    const skips = verdictEntries(orchestrator).filter(
      (entry) => entry.metadata.reason_code === "requires_explicit_resume",
    );
    expect(skips).toHaveLength(1);
    expect(skips[0]?.metadata.disposition).toBe("skip");
  });

  it("preserves the mark across a restart via journal replay; a skipped Todo issue still says so", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.pollTick();
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    const todoIssue = createIssue({ id: "1", state: "Todo" });
    expect(orchestrator.isDispatchEligible(todoIssue)).toBe(false);
    const hardStopSequence = orchestrator
      .getState()
      .dispatcherRunJournal.find(
        (entry) => entry.kind === "hard_stop_trigger",
      )?.sequence;

    // Restart: a fresh core reduces the same journal back into state.
    const restarted = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });

    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toMatchObject({
      reason: "hard_stop:token_budget",
      set_by_sequence: hardStopSequence,
    });

    // The skip is still visible post-restart: the disposition replayed and
    // a fresh eligibility check stays deduped (no duplicate verdict entry).
    expect(restarted.isDispatchEligible(todoIssue)).toBe(false);
    expect(restarted.getState().issueDispositions["1"]).toMatchObject({
      disposition: "skip",
      reasonCode: "requires_explicit_resume",
    });
    expect(
      verdictEntries(restarted).filter(
        (entry) => entry.metadata.reason_code === "requires_explicit_resume",
      ),
    ).toHaveLength(1);
  });

  it("clears the mark only via the fenced release verb with actor attribution in the Linear comment", async () => {
    const comments: string[] = [];
    const orchestrator = createOrchestrator({
      postComment: async (_issueId, body) => {
        comments.push(body);
      },
    });

    const parked = await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_park", human: "operator parked for review" },
      issueState: "In Progress",
    });
    expect(parked.status).toBe("applied");

    let snapshot = buildRuntimeSnapshot(orchestrator.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toMatchObject({
      reason: "intent:park:manual_park",
      set_by_sequence: parked.sequence,
    });

    // A stale fence is rejected and the mark stands.
    const stale = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "stale release" },
      fence: { expectedParkSeq: 9_999 },
    });
    expect(stale.status).toBe("rejected_stale");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(true);

    // The current park generation is journaled on the park entry; a
    // correctly fenced release clears the mark and renders attribution.
    const parkEntry = orchestrator
      .getState()
      .dispatcherRunJournal.find((entry) => entry.sequence === parked.sequence);
    const generation = parkEntry?.metadata.parkGeneration as number;
    const released = await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "reviewed; releasing" },
      fence: { expectedParkSeq: generation },
    });
    expect(released.status).toBe("applied");
    expect(orchestrator.getState().resumeRequired.has("1")).toBe(false);
    snapshot = buildRuntimeSnapshot(orchestrator.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required?.["1"]).toBeUndefined();
    expect(
      comments.some(
        (body) =>
          body.includes("Intent applied: release") &&
          body.includes("by operator@pro14"),
      ),
    ).toBe(true);
  });

  it("converges a replayed park → release on released (mark stays cleared after restart)", async () => {
    const orchestrator = createOrchestrator();
    await orchestrator.writeIntent({
      verb: "park",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_park", human: "park" },
    });
    await orchestrator.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "release" },
    });

    const restarted = createOrchestrator({
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().resumeRequired.has("1")).toBe(false);
    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    expect(snapshot.explicit_resume_required).toEqual({});
  });
});

describe("SYMPH-401: budget-escalation steps survive restarts", () => {
  it("resumes the ladder at step 2 after a restart with no duplicate step-1 event", async () => {
    const config = createConfig({
      budgetEscalation: { maxSteps: 3, multiplier: 2 },
    });
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    const first = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(first?.delayType).toBe("continuation");
    await orchestrator.onRetryTimer("1");
    const second = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(second?.delayType).toBe("continuation");
    expect(orchestrator.getState().issueBudgetEscalations["1"]).toBe(2);

    // Restart: the ladder position reduces from the journaled steps.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    expect(restarted.getState().issueBudgetEscalations["1"]).toBe(2);
    expect(restarted.budgetMultiplierForIssue("1")).toBe(4);

    // The next pause escalates to step 3 — not back to step 1.
    await restarted.pollTick();
    const third = await restarted.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(third?.delayType).toBe("continuation");
    expect(restarted.getState().issueBudgetEscalations["1"]).toBe(3);

    const escalationSteps = restarted
      .getState()
      .dispatcherRunJournal.filter(
        (entry) => entry.kind === "budget_escalation",
      )
      .map((entry) => entry.metadata.step);
    expect(escalationSteps).toEqual([1, 2, 3]);
  });
});

describe("SYMPH-401: pause-triage resume counts survive restarts", () => {
  it("enforces the authorized-resume cap across a deploy boundary", async () => {
    const config = createConfig({
      pauseTriage: {
        baseUrl: "http://studio2.local:8000/v1",
        model: "deepseek-v4-flash",
        apiKey: null,
        maxResumes: 1,
      },
    });
    const orchestrator = createOrchestrator({
      config,
      runPauseTriage: async () => ({
        verdict: "continue",
        rationale: "Real diff in progress; one unit should finish.",
      }),
    });

    await orchestrator.pollTick();
    const resumed = await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(resumed?.delayType).toBe("continuation");
    expect(orchestrator.getState().issuePauseTriageResumes["1"]).toBe(1);

    // Restart: the consumed resume reduces back from the journal, so the
    // post-restart pause parks WITHOUT consulting triage again.
    const postRestartTriageCalls: string[] = [];
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
      runPauseTriage: async (evidence) => {
        postRestartTriageCalls.push(evidence.issueIdentifier);
        return { verdict: "continue", rationale: "should never be asked" };
      },
    });
    expect(restarted.getState().issuePauseTriageResumes["1"]).toBe(1);

    await restarted.pollTick();
    const parked = await restarted.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(parked).toBeNull();
    expect(postRestartTriageCalls).toEqual([]);
    expect(restarted.getState().resumeRequired.has("1")).toBe(true);
  });
});

describe("SYMPH-401: per-issue cumulative spend survives restarts", () => {
  it("reports pre-restart spend + post-restart deltas in the /state snapshot", async () => {
    const config = createConfig({ stages: createImplementStages() });
    const orchestrator = createOrchestrator({ config });
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    feedTokens(orchestrator, { inputTokens: 60, outputTokens: 40 });
    await orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      hardStop: BUDGET_PAUSE,
    });
    expect(
      orchestrator.getState().issueExecutionHistory["1"]?.[0]?.totalTokens,
    ).toBe(100);

    // Restart: the stage record reduces back into execution history.
    const restarted = createOrchestrator({
      config,
      runJournal: orchestrator.getState().dispatcherRunJournal,
    });
    const replayedHistory = restarted.getState().issueExecutionHistory["1"];
    expect(replayedHistory).toHaveLength(1);
    expect(replayedHistory?.[0]).toMatchObject({
      stageName: "implement",
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
    });

    // Release the park, re-dispatch, accrue a post-restart delta: the
    // snapshot's pipeline total is pre-restart + post-restart.
    const release = await restarted.writeIntent({
      verb: "release",
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      actor: { kind: "operator", host: "pro14" },
      reason: { class: "manual_release", human: "resume after deploy" },
    });
    expect(release.status).toBe("applied");
    const tick = await restarted.pollTick();
    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    feedTokens(restarted, { inputTokens: 30, outputTokens: 20 });

    const snapshot = buildRuntimeSnapshot(restarted.getState(), { now: NOW });
    const row = snapshot.running.find((entry) => entry.issue_id === "1");
    expect(row?.total_pipeline_tokens).toBe(150);
    expect(row?.pipeline_tokens.input_tokens).toBe(90);
    expect(row?.pipeline_tokens.output_tokens).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function feedTokens(
  orchestrator: OrchestratorCore,
  usage: { inputTokens: number; outputTokens: number },
): void {
  orchestrator.onCodexEvent({
    issueId: "1",
    event: {
      event: "turn_completed",
      timestamp: NOW.toISOString(),
      codexAppServerPid: "1001",
      sessionId: "s1",
      threadId: "t1",
      turnId: "turn-1",
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
      rateLimits: {},
      message: "done",
    },
  });
}

function verdictEntries(
  orchestrator: OrchestratorCore,
): DispatcherRunJournalEntry[] {
  return orchestrator
    .getState()
    .dispatcherRunJournal.filter((entry) => entry.kind === "dispatch_verdict");
}

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  runJournal?: DispatcherRunJournal;
  postComment?: OrchestratorCoreOptions["postComment"];
  runPauseTriage?: OrchestratorCoreOptions["runPauseTriage"];
}): OrchestratorCore {
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker: createTracker(),
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: () => NOW,
  };
  if (overrides?.runJournal !== undefined) {
    options.runJournal = overrides.runJournal;
  }
  if (overrides?.postComment !== undefined) {
    options.postComment = overrides.postComment;
  }
  if (overrides?.runPauseTriage !== undefined) {
    options.runPauseTriage = overrides.runPauseTriage;
  }
  return new OrchestratorCore(options);
}

function createTracker(): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return [createIssue({ id: "1", identifier: "ISSUE-1" })];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
    },
  };
}

function createImplementStages(): NonNullable<
  ResolvedWorkflowConfig["stages"]
> {
  return {
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
        transitions: { onComplete: null, onApprove: null, onRework: null },
        linearState: null,
      },
    },
  };
}

function createConfig(overrides?: {
  budgetEscalation?: ResolvedWorkflowConfig["budgetEscalation"];
  pauseTriage?: ResolvedWorkflowConfig["pauseTriage"];
  stages?: ResolvedWorkflowConfig["stages"];
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      // NOTE: "Resume" must stay in active_states whenever stages exist or
      // validateDispatchConfig silently fails the whole pollTick.
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
    rateLimitAdmission: {
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
    acGate: { enabled: false },
    specFidelity: { enabled: false },
    admissionCard: { enabled: false },
    watchdog: {
      systemicThreshold: 2,
      circuitBreaker: true,
      maxFilingsPerHour: 3,
    },
    server: { port: null, slackNotifyChannel: null },
    notifications: { slackEnabled: true },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: { kind: "codex", model: null },
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
    createdAt: overrides?.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-06-01T00:00:00.000Z",
  };
}
