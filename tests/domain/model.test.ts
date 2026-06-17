import { describe, expect, it } from "vitest";

import {
  type ExecutionHistory,
  FAILURE_CLASSES,
  ORCHESTRATOR_EVENTS,
  ORCHESTRATOR_ISSUE_STATUSES,
  RUN_ATTEMPT_PHASES,
  type StageRecord,
  containsStageCompleteSignal,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
  parseFailureSignal,
  parseHumanBlockSignal,
  toSessionId,
  toWorkspaceKey,
} from "../../src/domain/model.js";

describe("domain model", () => {
  it("tracks the orchestrator issue lifecycle states from the spec", () => {
    expect(ORCHESTRATOR_ISSUE_STATUSES).toEqual([
      "unclaimed",
      "claimed",
      "running",
      "retry_queued",
      "released",
    ]);
  });

  it("tracks the run attempt phases and orchestrator events required by the spec", () => {
    expect(RUN_ATTEMPT_PHASES).toEqual([
      "preparing_workspace",
      "building_prompt",
      "launching_agent_process",
      "initializing_session",
      "streaming_turn",
      "finishing",
      "succeeded",
      "failed",
      "timed_out",
      "stalled",
      "canceled_by_reconciliation",
    ]);
    expect(ORCHESTRATOR_EVENTS).toEqual([
      "poll_tick",
      "poll_tick_completed",
      "worker_exit_normal",
      "worker_exit_paused",
      "worker_exit_abnormal",
      "stage_completed",
      "codex_update_event",
      "retry_timer_fired",
      "reconciliation_state_refresh",
      "stall_timeout",
      "shutdown_complete",
    ]);
  });

  it("normalizes state, workspace, and session identifiers deterministically", () => {
    expect(normalizeIssueState(" In Progress ")).toBe("in progress");
    expect(toWorkspaceKey("ABC-123/needs review")).toBe("ABC-123_needs_review");
    expect(toSessionId("thread-1", "turn-2")).toBe("thread-1-turn-2");
  });

  it("creates empty live session and orchestrator state baselines", () => {
    expect(createEmptyLiveSession()).toEqual({
      sessionId: null,
      threadId: null,
      turnId: null,
      codexAppServerPid: null,
      codexAppServerIdentity: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      codexCacheReadTokens: 0,
      codexCacheWriteTokens: 0,
      codexNoCacheTokens: 0,
      codexReasoningTokens: 0,
      codexTotalInputTokens: 0,
      codexTotalOutputTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      lastReportedCacheReadTokens: 0,
      lastReportedCacheWriteTokens: 0,
      lastReportedNoCacheTokens: 0,
      lastReportedReasoningTokens: 0,
      turnCount: 0,
      totalStageInputTokens: 0,
      totalStageOutputTokens: 0,
      totalStageTotalTokens: 0,
      totalStageCacheReadTokens: 0,
      totalStageCacheWriteTokens: 0,
      totalStageCompactions: 0,
      turnHistory: [],
      recentActivity: [],
      tokenTelemetry: [],
      tokenTelemetryObservedCount: 0,
      codexSessionLogs: [],
      rateLimitWindows: {
        primary: null,
        secondary: null,
      },
    });

    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 10,
    });

    expect(state.pollIntervalMs).toBe(30_000);
    expect(state.maxConcurrentAgents).toBe(10);
    expect(state.running).toEqual({});
    expect([...state.claimed]).toEqual([]);
    expect(state.retryAttempts).toEqual({});
    expect([...state.completed]).toEqual([]);
    expect([...state.failed]).toEqual([]);
    expect(state.codexTotals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toBeNull();
    expect(state.codexRateLimitsObservedAt).toBeNull();
    expect(state.rateLimitAdmission).toBeNull();
    expect(state.issueExecutionHistory).toEqual({});
    expect(state.managerRunJournal).toEqual([]);
    expect(state.managerRuns).toEqual({});
  });
});

describe("ExecutionHistory", () => {
  it("stage record captures all fields", () => {
    const record: StageRecord = {
      stageName: "implement",
      durationMs: 12000,
      totalTokens: 5000,
      turns: 10,
      outcome: "success",
    };
    expect(record.stageName).toBe("implement");
    expect(record.durationMs).toBe(12000);
    expect(record.totalTokens).toBe(5000);
    expect(record.turns).toBe(10);
    expect(record.outcome).toBe("success");
  });

  it("stage record appended on worker exit", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 1000,
      maxConcurrentAgents: 2,
    });
    const record: StageRecord = {
      stageName: "investigate",
      durationMs: 5000,
      totalTokens: 1000,
      turns: 3,
      outcome: "success",
    };
    // Simulate appending a StageRecord on worker exit
    state.issueExecutionHistory["issue-1"] = [];
    state.issueExecutionHistory["issue-1"].push(record);
    expect(state.issueExecutionHistory["issue-1"]).toHaveLength(1);
    expect(state.issueExecutionHistory["issue-1"][0]).toEqual(record);

    // Simulate a second stage completing
    const record2: StageRecord = {
      stageName: "implement",
      durationMs: 8000,
      totalTokens: 2500,
      turns: 5,
      outcome: "success",
    };
    state.issueExecutionHistory["issue-1"].push(record2);
    expect(state.issueExecutionHistory["issue-1"]).toHaveLength(2);
  });

  it("execution history cleaned up after completion", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 1000,
      maxConcurrentAgents: 2,
    });
    const history: ExecutionHistory = [
      {
        stageName: "investigate",
        durationMs: 1000,
        totalTokens: 100,
        turns: 1,
        outcome: "success",
      },
      {
        stageName: "implement",
        durationMs: 2000,
        totalTokens: 200,
        turns: 2,
        outcome: "success",
      },
      {
        stageName: "review",
        durationMs: 3000,
        totalTokens: 300,
        turns: 3,
        outcome: "success",
      },
      {
        stageName: "ship",
        durationMs: 4000,
        totalTokens: 400,
        turns: 4,
        outcome: "success",
      },
    ];
    state.issueExecutionHistory["issue-1"] = history;
    expect(state.issueExecutionHistory["issue-1"]).toHaveLength(4);

    // Simulate cleanup when issue reaches Done terminal state
    // biome-ignore lint/performance/noDelete: delete required here - Record type doesn't accept undefined
    delete state.issueExecutionHistory["issue-1"];
    expect(state.issueExecutionHistory["issue-1"]).toBeUndefined();
  });
});

describe("parseFailureSignal", () => {
  it("defines the expected failure classes", () => {
    expect(FAILURE_CLASSES).toEqual([
      "verify",
      "review",
      "rebase",
      "spec",
      "infra",
    ]);
  });

  it("parses each failure class from agent output", () => {
    expect(parseFailureSignal("[STAGE_FAILED: verify]")).toEqual({
      failureClass: "verify",
    });
    expect(parseFailureSignal("[STAGE_FAILED: review]")).toEqual({
      failureClass: "review",
    });
    expect(parseFailureSignal("[STAGE_FAILED: rebase]")).toEqual({
      failureClass: "rebase",
    });
    expect(parseFailureSignal("[STAGE_FAILED: spec]")).toEqual({
      failureClass: "spec",
    });
    expect(parseFailureSignal("[STAGE_FAILED: infra]")).toEqual({
      failureClass: "infra",
    });
  });

  it("returns null for null, undefined, or empty input", () => {
    expect(parseFailureSignal(null)).toBeNull();
    expect(parseFailureSignal(undefined)).toBeNull();
    expect(parseFailureSignal("")).toBeNull();
  });

  it("returns null when no failure signal is present", () => {
    expect(parseFailureSignal("[STAGE_COMPLETE]")).toBeNull();
  });
});

describe("containsStageCompleteSignal", () => {
  it("detects the marker at the start of any line", () => {
    expect(containsStageCompleteSignal("[STAGE_COMPLETE]")).toBe(true);
    expect(
      containsStageCompleteSignal("Done with investigation.\n[STAGE_COMPLETE]"),
    ).toBe(true);
    // Verbatim SYMPH-330 round-3 shape: marker leads, explanation follows.
    expect(
      containsStageCompleteSignal(
        "[STAGE_COMPLETE]  Investigation workpad updated on the existing Linear comment.",
      ),
    ).toBe(true);
    expect(
      containsStageCompleteSignal("Workpad posted.\n  [STAGE_COMPLETE]\n"),
    ).toBe(true);
  });

  it("does not fire on instruction echoes or mid-prose mentions", () => {
    // The stage prompts quote the marker; echoing instructions must not
    // complete the stage.
    expect(
      containsStageCompleteSignal(
        "I'll output [STAGE_COMPLETE] once the workpad is posted. Starting now.",
      ),
    ).toBe(false);
    expect(
      containsStageCompleteSignal("Workpad posted. [STAGE_COMPLETE] Thanks!"),
    ).toBe(false);
    expect(
      containsStageCompleteSignal(
        "When done, output the exact text [STAGE_COMPLETE] as the last line.",
      ),
    ).toBe(false);
  });

  it("does not fire without the exact marker", () => {
    expect(containsStageCompleteSignal(null)).toBe(false);
    expect(containsStageCompleteSignal(undefined)).toBe(false);
    expect(containsStageCompleteSignal("")).toBe(false);
    expect(containsStageCompleteSignal("STAGE_COMPLETE")).toBe(false);
    expect(containsStageCompleteSignal("[STAGE_FAILED: verify]")).toBe(false);
  });
});

describe("parseHumanBlockSignal", () => {
  it("parses structured terminal human-block markers from their own line", () => {
    expect(parseHumanBlockSignal("[BLOCKED_NEEDS_HUMAN: pr_creation]")).toEqual(
      { operation: "pr_creation", blockers: null },
    );
    expect(
      parseHumanBlockSignal(
        "Verification passed.\n[BLOCKED_NEEDS_HUMAN: auto-merge]\n",
      ),
    ).toEqual({ operation: "auto_merge", blockers: null });
    expect(
      parseHumanBlockSignal("Done.\n  [BLOCKED_NEEDS_HUMAN: gate_bypass]"),
    ).toEqual({ operation: "gate_bypass", blockers: null });
  });

  it("parses structured blocker context from its own line", () => {
    expect(
      parseHumanBlockSignal(
        'Readiness blocked.\n[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["behind_base"],"permission":["auto_merge_denied"]}]\n[BLOCKED_NEEDS_HUMAN: auto_merge]',
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers:
        '{"readiness":["behind_base"],"permission":["auto_merge_denied"]}',
    });
  });

  it("accepts bracket-like blocker payload content verbatim", () => {
    expect(
      parseHumanBlockSignal(
        [
          "Readiness blocked.",
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["needs [deploy] window"],"note":"keep [literal] brackets"}]',
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers:
        '{"readiness":["needs [deploy] window"],"note":"keep [literal] brackets"}',
    });
  });

  it("accepts malformed JSON-shaped blocker payload text without parsing JSON", () => {
    expect(
      parseHumanBlockSignal(
        [
          "Readiness blocked.",
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["behind_base",],"permission":oops}]',
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers: '{"readiness":["behind_base",],"permission":oops}',
    });
  });

  it("accepts unescaped closing brackets inside blocker payloads verbatim", () => {
    expect(
      parseHumanBlockSignal(
        [
          "Readiness blocked.",
          "[BLOCKED_NEEDS_HUMAN_BLOCKERS: permission denied ] while queue was open]",
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers: "permission denied ] while queue was open",
    });
  });

  it("uses the blocker context immediately adjacent to the terminal marker", () => {
    expect(
      parseHumanBlockSignal(
        [
          'Draft blocker summary: [BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["draft"]}]',
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["behind_base"],"permission":["auto_merge_denied"]}]',
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers:
        '{"readiness":["behind_base"],"permission":["auto_merge_denied"]}',
    });
  });

  it("does not attach stale blocker context that is not adjacent to the marker", () => {
    expect(
      parseHumanBlockSignal(
        [
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["stale"]}]',
          "Recomputed readiness after rebase.",
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({ operation: "auto_merge", blockers: null });
  });

  it("does not attach a stale malformed blocker summary to a later terminal marker", () => {
    expect(
      parseHumanBlockSignal(
        [
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["stale"]}',
          "Recomputed readiness after rebase.",
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({ operation: "auto_merge", blockers: null });
  });

  it("uses the last terminal human-block marker when output contains revisions", () => {
    expect(
      parseHumanBlockSignal(
        [
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"permission":["pr_creation_denied"]}]',
          "[BLOCKED_NEEDS_HUMAN: pr_creation]",
          "Correction: PR exists, merge readiness is the active boundary.",
          '[BLOCKED_NEEDS_HUMAN_BLOCKERS: {"readiness":["pending_checks"],"permission":["auto_merge_denied"]}]',
          "[BLOCKED_NEEDS_HUMAN: auto_merge]",
        ].join("\n"),
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers:
        '{"readiness":["pending_checks"],"permission":["auto_merge_denied"]}',
    });
  });

  it("keeps a bare BLOCKED-needs-human line as a legacy safe fallback", () => {
    expect(
      parseHumanBlockSignal("Verification passed.\nBLOCKED-needs-human"),
    ).toEqual({ operation: "other", blockers: null });
  });

  it("does not fire on instruction echoes or mid-prose mentions", () => {
    expect(
      parseHumanBlockSignal(
        "If denied, report BLOCKED-needs-human instead of running the command.",
      ),
    ).toBeNull();
    expect(
      parseHumanBlockSignal(
        "When done, output [BLOCKED_NEEDS_HUMAN: pr_creation] on its own line.",
      ),
    ).toBeNull();
    expect(parseHumanBlockSignal(null)).toBeNull();
  });
});

describe("parseFailureSignal extraction cases", () => {
  it("returns null for non-signal prose", () => {
    expect(parseFailureSignal("All tests passed successfully.")).toBeNull();
    expect(parseFailureSignal("STAGE_FAILED: verify")).toBeNull();
  });

  it("extracts signal from longer agent output", () => {
    const output =
      "Tests failed.\n[STAGE_FAILED: verify]\nSee logs for details.";
    expect(parseFailureSignal(output)).toEqual({ failureClass: "verify" });
  });

  it("handles extra whitespace inside brackets", () => {
    expect(parseFailureSignal("[STAGE_FAILED:  spec ]")).toEqual({
      failureClass: "spec",
    });
    expect(parseFailureSignal("[STAGE_FAILED:review]")).toEqual({
      failureClass: "review",
    });
  });

  it("rejects unknown failure classes", () => {
    expect(parseFailureSignal("[STAGE_FAILED: unknown]")).toBeNull();
    expect(parseFailureSignal("[STAGE_FAILED: timeout]")).toBeNull();
  });
});
