import { describe, expect, it } from "vitest";

import {
  type DispatcherRunJournalEntry,
  type ManagerRunJournal,
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import { formatEasternTimestamp } from "../../src/logging/format-timestamp.js";
import {
  STAGE_STALL_THRESHOLDS,
  STATE_DELTA_MAX_LIMIT,
  buildRuntimeSnapshot,
  buildStateDelta,
  getStallThreshold,
} from "../../src/logging/runtime-snapshot.js";
import { reduceManagerRunJournal } from "../../src/orchestrator/manager-run.js";

describe("runtime snapshot", () => {
  it("projects emergency-stop cleanup proof and redacted process identity", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const processIdentity = {
      pid: 1001,
      processGroupId: 1001,
      sessionId: 1001,
      startedAt: "linux-starttime:123456",
      command: "bash -lc codex app-server --token secret",
      launchToken: "secret-token",
    };
    state.resumeRequired = new Set([
      "confirmed",
      "confirmed-mismatch",
      "unconfirmed",
      "missing",
      "mismatch",
    ]);
    state.resumeRequiredMarks = {
      confirmed: {
        reason: "killed_mid_run",
        setBySequence: 11,
        since: "2026-03-06T00:00:10.000Z",
      },
      "confirmed-mismatch": {
        reason: "killed_mid_run",
        setBySequence: 12,
        since: "2026-03-06T00:00:10.500Z",
      },
      unconfirmed: {
        reason: "killed_mid_run_unconfirmed",
        setBySequence: 13,
        since: "2026-03-06T00:00:11.000Z",
      },
      missing: {
        reason: "killed_mid_run_unconfirmed",
        setBySequence: 14,
        since: "2026-03-06T00:00:12.000Z",
      },
      mismatch: {
        reason: "killed_mid_run_unconfirmed",
        setBySequence: 15,
        since: "2026-03-06T00:00:13.000Z",
      },
    };
    state.emergencyStop = {
      active: true,
      since: "2026-03-06T00:00:00.000Z",
      reason: "runaway spend",
      actor: { kind: "operator", host: "pro14", session: "symphonyctl" },
      setBySequence: 10,
      interruptedIssues: [
        {
          issueId: "confirmed",
          issueIdentifier: "ISSUE-CONFIRMED",
          stage: "implement",
          attempt: null,
          codexAppServerPid: "1001",
          codexAppServerIdentity: processIdentity,
        },
        {
          issueId: "confirmed-mismatch",
          issueIdentifier: "ISSUE-CONFIRMED-MISMATCH",
          stage: "implement",
          attempt: null,
          codexAppServerPid: "1001",
          codexAppServerIdentity: { ...processIdentity, pid: 2002 },
        },
        {
          issueId: "unconfirmed",
          issueIdentifier: "ISSUE-UNCONFIRMED",
          stage: "review",
          attempt: 1,
          codexAppServerPid: "1001",
          codexAppServerIdentity: processIdentity,
        },
        {
          issueId: "resumed-without-confirmed-mark",
          issueIdentifier: "ISSUE-RESUMED-WITHOUT-CONFIRMED-MARK",
          stage: "review",
          attempt: 2,
          codexAppServerPid: "1001",
          codexAppServerIdentity: processIdentity,
        },
        {
          issueId: "missing",
          issueIdentifier: "ISSUE-MISSING",
          stage: null,
          attempt: null,
          codexAppServerPid: null,
          codexAppServerIdentity: null,
        },
        {
          issueId: "mismatch",
          issueIdentifier: "ISSUE-MISMATCH",
          stage: "implement",
          attempt: null,
          codexAppServerPid: "1001",
          codexAppServerIdentity: { ...processIdentity, pid: 2002 },
        },
      ],
    };

    const interruptedIssues =
      buildRuntimeSnapshot(state).emergency_stop?.interrupted_issues;

    expect(interruptedIssues).toEqual([
      expect.objectContaining({
        issue_identifier: "ISSUE-CONFIRMED",
        identity_status: "present",
        cleanup_status: "confirmed",
        process_identity: {
          pid: 1001,
          process_group_id: 1001,
          session_id: 1001,
          started_at: "linux-starttime:123456",
          command_present: true,
          launch_token_present: true,
        },
      }),
      expect.objectContaining({
        issue_identifier: "ISSUE-CONFIRMED-MISMATCH",
        identity_status: "mismatch",
        cleanup_status: "confirmed",
        cleanup_status_reason:
          "Cleanup proof is confirmed, but captured process identity does not match the tracked app-server PID; see identity_status.",
      }),
      expect.objectContaining({
        issue_identifier: "ISSUE-UNCONFIRMED",
        identity_status: "present",
        cleanup_status: "unconfirmed",
      }),
      expect.objectContaining({
        issue_identifier: "ISSUE-RESUMED-WITHOUT-CONFIRMED-MARK",
        identity_status: "present",
        cleanup_status: "unconfirmed",
      }),
      expect.objectContaining({
        issue_identifier: "ISSUE-MISSING",
        identity_status: "missing",
        cleanup_status: "missing_identity",
        process_identity: null,
      }),
      expect.objectContaining({
        issue_identifier: "ISSUE-MISMATCH",
        identity_status: "mismatch",
        cleanup_status: "identity_mismatch",
      }),
    ]);
    expect(interruptedIssues?.[0]?.process_identity).not.toHaveProperty(
      "command",
    );
    expect(interruptedIssues?.[0]?.process_identity).not.toHaveProperty(
      "launch_token",
    );
  });

  it("projects the computed dispatch order read-model", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.computedDispatchOrder = {
      comparator_version: "dispatch-comparator-v1",
      generated_at: "2026-06-13T12:00:00.000Z",
      status: "linearized",
      positions: [
        {
          position: 1,
          issue_id: "issue-1",
          issue_identifier: "SYMPH-485",
          priority: 1,
          created_at: "2026-06-13T00:00:00.000Z",
          rationale: ["priority 1", "fifo 2026-06-13T00:00:00.000Z"],
        },
      ],
      exclusions: [],
      advisory_warnings: [],
      would_have_been_excluded_by_advisory_edges: [],
      hard_cycle: null,
      hard_cycles: [],
      hard_cycle_omitted_count: 0,
      superseded_native_hard_blockers: [],
      warnings: [],
    };

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-06-13T12:00:01.000Z"),
    });

    expect(snapshot.computed_order).toEqual(state.computedDispatchOrder);
  });

  it("projects manager-run aggregates for dashboard inspection", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const journal: ManagerRunJournal = [
      {
        sequence: 1,
        idempotencyKey: "run:start",
        timestamp: "2026-06-08T12:00:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Manager run started.",
        type: "manager_run_started",
        managerThreadId: "manager-thread",
        title: "Wave run",
      },
      {
        sequence: 2,
        idempotencyKey: "run:lane",
        timestamp: "2026-06-08T12:01:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Lane admitted.",
        type: "worker_lane_admitted",
        laneId: "lane-1",
        workerThreadId: "worker-thread",
        issueIdentifier: "MOB-87",
        title: "Map manager-thread runs",
      },
      {
        sequence: 3,
        idempotencyKey: "run:follow-up",
        timestamp: "2026-06-08T12:02:00.000Z",
        runId: "run-1",
        sourceSessionId: "019ea700-80b7-7032-8ef5-dd8e638f0205",
        summary: "Follow-up spawned.",
        type: "follow_up_spawned",
        laneId: "lane-1",
        issueIdentifier: "SYMPH-262",
        title: "Backfill historical manager-run import CLI",
        parentIssueIdentifier: "MOB-87",
        url: "https://linear.app/mobilyze-llc/issue/SYMPH-262/backfill-historical-manager-run-import-cli",
      },
    ];
    state.managerRunJournal = journal;
    state.managerRuns = reduceManagerRunJournal(journal, {
      now: new Date("2026-06-08T12:03:00.000Z"),
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-06-08T12:03:00.000Z"),
    });

    expect(snapshot.manager_runs).toEqual([
      expect.objectContaining({
        run_id: "run-1",
        manager_thread_id: "manager-thread",
        counts: expect.objectContaining({
          active_lanes: 1,
          spawned_follow_ups: 1,
          missing_closeout_evidence: 3,
        }),
        lanes: [
          expect.objectContaining({
            lane_id: "lane-1",
            issue_identifier: "MOB-87",
            status: "active",
            follow_up_issue_identifiers: ["SYMPH-262"],
          }),
        ],
        follow_ups: [
          expect.objectContaining({
            issue_identifier: "SYMPH-262",
            parent_issue_identifier: "MOB-87",
          }),
        ],
      }),
    ]);
  });

  it("includes pipeline_stage and activity_summary in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing src/foo.ts",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.pipeline_stage).toBe("implement");
    expect(snapshot.running[0]!.activity_summary).toBe("Editing src/foo.ts");
  });

  it("projects continuous feedback status and deduped findings", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Feedback checkpoint",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.continuousFeedback["issue-1"] = {
      status: "finding",
      summary: "One issue found.",
      lastEvent: "checkpoint",
      lastCheckedAt: "2026-03-06T10:00:05.000Z",
      reviewerLane: {
        runner: "pi",
        model: "local-flash",
        role: "continuous-feedback",
      },
      workerLane: {
        runner: "codex",
        model: null,
        role: "implement",
      },
      findings: [
        {
          signature: "src/core.ts:null-check",
          title: "Missing null check",
          detail: "Guard optional reviewer output.",
          severity: "blocking",
          file: "src/core.ts",
          line: 42,
          firstSeenAt: "2026-03-06T10:00:01.000Z",
          lastSeenAt: "2026-03-06T10:00:05.000Z",
          occurrences: 2,
          status: "bounced",
          reviewerLane: {
            runner: "pi",
            model: "local-flash",
            role: "continuous-feedback",
          },
        },
      ],
    };

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.continuous_feedback).toEqual({
      status: "finding",
      summary: "One issue found.",
      unavailable_summary: null,
      last_event: "checkpoint",
      last_checked_at: "2026-03-06T10:00:05.000Z",
      reviewer_lane: {
        runner: "pi",
        model: "local-flash",
        role: "continuous-feedback",
      },
      worker_lane: {
        runner: "codex",
        model: null,
        role: "implement",
      },
      findings: [
        {
          signature: "src/core.ts:null-check",
          title: "Missing null check",
          detail: "Guard optional reviewer output.",
          severity: "blocking",
          file: "src/core.ts",
          line: 42,
          occurrences: 2,
          status: "bounced",
          first_seen_at: "2026-03-06T10:00:01.000Z",
          last_seen_at: "2026-03-06T10:00:05.000Z",
        },
      ],
    });
  });

  it("projects decorrelated gate outcomes", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.decorrelatedGateOutcomes["issue-1"] = [
      {
        issueId: "issue-1",
        issueIdentifier: "ABC-1",
        gateStage: "review_gate",
        mode: "full",
        status: "failed",
        aggregate: "fail",
        checkedAt: "2026-03-06T10:00:05.000Z",
        workerLane: {
          runner: "codex",
          model: null,
          role: "worker",
          stageName: "implement",
        },
        reviewerLanes: [
          {
            runner: "pi",
            model: "local-flash",
            role: "decorrelated-reviewer",
            stageName: "review_gate",
          },
        ],
        verifierSeparated: true,
        authoritative: true,
        reworkTarget: "implement",
        summary: "Decorrelated gate review_gate failed for ABC-1.",
      },
    ];

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.decorrelated_gates).toEqual([
      {
        issue_id: "issue-1",
        issue_identifier: "ABC-1",
        gate_stage: "review_gate",
        mode: "full",
        status: "failed",
        aggregate: "fail",
        checked_at: "2026-03-06T10:00:05.000Z",
        worker_lane: {
          runner: "codex",
          model: null,
          role: "worker",
          stage_name: "implement",
        },
        reviewer_lanes: [
          {
            runner: "pi",
            model: "local-flash",
            role: "decorrelated-reviewer",
            stage_name: "review_gate",
          },
        ],
        verifier_separated: true,
        authoritative: true,
        rework_target: "implement",
        summary: "Decorrelated gate review_gate failed for ABC-1.",
      },
    ]);
  });

  it("includes a loop trace preview for running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing src/foo.ts",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.loopTraceJournal["issue-1"] = [
      {
        sequence: 1,
        timestamp: "2026-03-06T10:00:01.000Z",
        kind: "session_start",
        issueId: "issue-1",
        issueIdentifier: "ABC-1",
        stage: "implement",
        attempt: null,
        sessionId: "thread-a-turn-1",
        summary: "Session started.",
      },
    ];

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.loop_trace_preview).toEqual({
      total_entries: 1,
      stored_entries: 1,
      truncated: false,
      entries: [
        {
          sequence: 1,
          at: "2026-03-06T10:00:01.000Z",
          kind: "session_start",
          summary: "Session started.",
          stage: "implement",
          attempt: null,
          session_id: "thread-a-turn-1",
          prompt: null,
          tool_action: null,
          file_delta: null,
          stage_transition: null,
          worker_exit: null,
        },
      ],
    });
  });

  it("includes rework_count in running row when greater than zero", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Fixing review comments",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueReworkCounts["issue-1"] = 2;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.rework_count).toBe(2);
  });

  it("omits rework_count from running row when zero", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.rework_count).toBeUndefined();
  });

  it("sets pipeline_stage to null when no stage is set for the issue", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.pipeline_stage).toBeNull();
  });

  it("projects per-stage rate-limit window usage into running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    entry.rateLimitWindows = {
      primary: { startPercent: 39, latestPercent: 42.5, lastResetsAt: null },
      secondary: null,
    };
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.rate_limit_window).toEqual({
      primary: { start_pct: 39, latest_pct: 42.5, delta_pct: 3.5 },
      secondary: null,
    });
  });

  it("leaves rate_limit_window null without observations and projects admission state", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });

    const bare = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    expect(bare.running[0]!.rate_limit_window).toBeNull();
    expect(bare.rate_limit_admission).toBeNull();

    state.rateLimitAdmission = {
      blocked: true,
      reason: "secondary window headroom 2.0% < 5% floor",
      evaluatedAt: "2026-03-06T10:00:09.000Z",
      minPrimaryHeadroomPct: 10,
      minSecondaryHeadroomPct: 5,
      primaryUsedPercent: 39,
      secondaryUsedPercent: 98,
      expectedUnitBurnPct: 3,
      deferredUntil: "2026-03-06T12:00:00.000Z",
    };
    const gated = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    expect(gated.rate_limit_admission).toEqual({
      blocked: true,
      reason: "secondary window headroom 2.0% < 5% floor",
      evaluated_at: "2026-03-06T10:00:09.000Z",
      min_primary_headroom_pct: 10,
      min_secondary_headroom_pct: 5,
      primary_used_pct: 39,
      secondary_used_pct: 98,
      expected_unit_burn_pct: 3,
      deferred_until: "2026-03-06T12:00:00.000Z",
    });
  });

  it("includes stage_duration_seconds and tokens_per_turn in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const startedAt = new Date(now.getTime() - 300_000).toISOString(); // 300 seconds ago
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt,
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-21T10:04:59.000Z",
      lastCodexMessage: "Finished",
      turnCount: 10,
      codexInputTokens: 50000,
      codexOutputTokens: 70000,
      codexTotalTokens: 120000,
    });
    entry.totalStageTotalTokens = 120000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.stage_duration_seconds).toBeCloseTo(300, 0);
    expect(snapshot.running[0]!.tokens_per_turn).toBe(12000);
  });

  it("builds a sorted state snapshot with live runtime totals", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.codexTotals.inputTokens = 100;
    state.codexTotals.outputTokens = 50;
    state.codexTotals.totalTokens = 150;
    state.codexTotals.secondsRunning = 12.5;
    state.codexRateLimits = {
      requestsRemaining: 7,
      tokensRemaining: 700,
    };
    const entry2 = createRunningEntry({
      issueId: "issue-2",
      identifier: "ZZZ-2",
      startedAt: "2026-03-06T10:00:03.000Z",
      sessionId: "thread-z-turn-1",
      lastCodexEvent: "notification",
      lastCodexTimestamp: "2026-03-06T10:00:04.000Z",
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 12,
      codexOutputTokens: 8,
      codexTotalTokens: 20,
    });
    entry2.totalStageInputTokens = 12;
    entry2.totalStageOutputTokens = 8;
    entry2.totalStageTotalTokens = 20;
    state.running["issue-2"] = entry2;
    const entry1 = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Finished",
      turnCount: 1,
      codexInputTokens: 30,
      codexOutputTokens: 20,
      codexTotalTokens: 50,
    });
    entry1.totalStageInputTokens = 30;
    entry1.totalStageOutputTokens = 20;
    entry1.totalStageTotalTokens = 50;
    state.running["issue-1"] = entry1;
    state.retryAttempts["issue-3"] = {
      issueId: "issue-3",
      identifier: "MMM-3",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T10:00:20.000Z"),
      timerHandle: null,
      error: "no available orchestrator slots",
      delayType: "failure",
    };

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.generated_at).toBe(
      formatEasternTimestamp(new Date("2026-03-06T10:00:10.000Z")),
    );
    expect(snapshot.counts).toEqual({
      running: 2,
      retrying: 1,
      completed: 0,
      failed: 0,
    });
    expect(snapshot.running.map((row) => row.issue_identifier)).toEqual([
      "AAA-1",
      "ZZZ-2",
    ]);
    expect(snapshot.running[0]).toMatchObject({
      issue_id: "issue-1",
      issue_identifier: "AAA-1",
      issue_title: "AAA-1",
      state: "In Progress",
      session_id: "thread-a-turn-1",
      turn_count: 1,
      last_event: "turn_completed",
      last_message: "Finished",
      started_at: "2026-03-06T10:00:00.000Z",
      tokens: {
        input_tokens: 30,
        output_tokens: 20,
        total_tokens: 50,
      },
    });
    // last_event_at is now formatted in Eastern time (ISO-8601 with Eastern offset)
    expect(snapshot.running[0]!.last_event_at).toMatch(/-0[45]:00$/);
    expect(snapshot.retrying).toEqual([
      {
        issue_id: "issue-3",
        issue_identifier: "MMM-3",
        attempt: 2,
        due_at: formatEasternTimestamp(new Date("2026-03-06T10:00:20.000Z")),
        error: "no available orchestrator slots",
      },
    ]);
    expect(snapshot.codex_totals).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      seconds_running: 29.5,
    });
    expect(snapshot.rate_limits).toEqual({
      requestsRemaining: 7,
      tokensRemaining: 700,
    });
  });

  it("includes cumulative ticket stats in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    // Set up execution history with two completed stages
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        turns: 10,
        outcome: "completed",
      },
    ];

    // Running entry with 30K tokens accumulated in the current stage
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Finished",
      turnCount: 3,
      codexInputTokens: 10_000,
      codexOutputTokens: 5_000,
      codexTotalTokens: 15_000,
    });
    // Simulate 30K tokens accumulated in the current stage
    entry.totalStageTotalTokens = 30_000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    const row = snapshot.running[0]!;

    // total_pipeline_tokens = 50K (investigate) + 80K (implement) + 30K (current stage) = 160K
    expect(row.total_pipeline_tokens).toBe(160_000);

    // execution_history should include the two completed stage records
    expect(row.execution_history).toEqual([
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        turns: 10,
        outcome: "completed",
      },
    ]);
  });

  it("includes turn_history in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing src/foo.ts",
      turnCount: 2,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.turnHistory = [
      {
        turnNumber: 1,
        timestamp: "2026-03-06T10:00:03.000Z",
        message: "Checking tests",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cacheReadTokens: 50,
        reasoningTokens: 20,
        event: "turn_completed",
      },
      {
        turnNumber: 2,
        timestamp: "2026-03-06T10:00:05.000Z",
        message: "Editing src/foo.ts",
        inputTokens: 300,
        outputTokens: 200,
        totalTokens: 500,
        cacheReadTokens: 80,
        reasoningTokens: 30,
        event: "turn_completed",
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.turn_history).toHaveLength(2);
    expect(snapshot.running[0]!.turn_history[0]).toMatchObject({
      turnNumber: 1,
      message: "Checking tests",
      inputTokens: 200,
      cacheReadTokens: 50,
      reasoningTokens: 20,
    });
    expect(snapshot.running[0]!.turn_history[1]).toMatchObject({
      turnNumber: 2,
      message: "Editing src/foo.ts",
    });
  });

  it("populates last_tool_call from the last recentActivity entry", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing",
      turnCount: 2,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.recentActivity = [
      {
        timestamp: "2026-03-06T10:00:03.000Z",
        toolName: "Read",
        context: "model.ts",
        totalTokens: 100,
      },
      {
        timestamp: "2026-03-06T10:00:04.000Z",
        toolName: "Bash",
        context: "npm test",
        totalTokens: 200,
      },
      {
        timestamp: "2026-03-06T10:00:05.000Z",
        toolName: "Grep",
        context: "pattern",
        totalTokens: 150,
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBe("Grep pattern");
  });

  it("sets last_tool_call to tool name only when context is null", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing",
      turnCount: 1,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.recentActivity = [
      {
        timestamp: "2026-03-06T10:00:05.000Z",
        toolName: "Agent",
        context: null,
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBe("Agent");
  });

  it("sets last_tool_call to null when recentActivity is empty", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Starting",
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBeNull();
  });

  it("includes full token breakdown with cache and reasoning fields in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1000,
      codexOutputTokens: 500,
      codexTotalTokens: 1500,
    });
    // Cumulative stage token fields (used by the dashboard snapshot)
    entry.totalStageInputTokens = 1000;
    entry.totalStageOutputTokens = 500;
    entry.totalStageTotalTokens = 1500;
    entry.totalStageCacheReadTokens = 200;
    entry.totalStageCacheWriteTokens = 150;
    entry.codexReasoningTokens = 75;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    const row = snapshot.running[0]!;
    expect(row.tokens.input_tokens).toBe(1000);
    expect(row.tokens.output_tokens).toBe(500);
    expect(row.tokens.total_tokens).toBe(1500);
    expect(row.tokens.cache_read_tokens).toBe(200);
    expect(row.tokens.cache_write_tokens).toBe(150);
    expect(row.tokens.reasoning_tokens).toBe(75);
  });

  it("includes stage usage measurement quality in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 1000,
      codexOutputTokens: 500,
      codexTotalTokens: 1500,
    });
    entry.totalStageInputTokens = 1000;
    entry.totalStageOutputTokens = 500;
    entry.totalStageTotalTokens = 1500;
    entry.usageMeasurement = {
      schema: "symphony.stage-usage.v1",
      source: "claude_code_ai_sdk",
      runnerKind: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      profile: "write.local",
      measurementQuality: "true",
      tokens: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      cost: {
        amountUsd: 0.42,
        currency: "USD",
        source: "subscription_advisory",
        authority: "advisory",
        sourceDescription: "subscription equivalent",
      },
    };
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]?.tokens.total_tokens).toBe(1500);
    expect(snapshot.running[0]?.usage_measurement).toMatchObject({
      measurementQuality: "true",
      source: "claude_code_ai_sdk",
      cost: {
        amountUsd: 0.42,
        authority: "advisory",
      },
    });
  });

  it("classifies health as green when session is active and token burn is normal", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const recentTimestamp = new Date(now.getTime() - 30_000).toISOString(); // 30s ago
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: recentTimestamp,
      lastCodexMessage: "Working",
      turnCount: 5,
      codexInputTokens: 10_000,
      codexOutputTokens: 5_000,
      codexTotalTokens: 15_000,
    });
    entry.totalStageTotalTokens = 15_000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("green");
    expect(snapshot.running[0]!.health_reason).toBeNull();
  });

  it("classifies health as red when session exceeds 80% of stage stall threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // merge stage has 300s threshold; 80% = 240s. 250s > 240s → red
    const stalledTimestamp = new Date(now.getTime() - 250_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 300_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: stalledTimestamp,
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "merge";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("stalled");
    expect(snapshot.running[0]!.health_reason).toContain("merge stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 300s");
  });

  it("classifies health as yellow when tokens_per_turn exceeds 20000", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const recentTimestamp = new Date(now.getTime() - 10_000).toISOString(); // 10s ago (not stalled)
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: recentTimestamp,
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 30_000,
      codexOutputTokens: 12_000,
      codexTotalTokens: 42_001,
    });
    entry.totalStageTotalTokens = 42_001;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("token");
  });

  it("does not mark cache-dominant low-rate-window turns yellow on burn alone", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-06-14T23:05:49.000Z");
    const entry = createRunningEntry({
      issueId: "issue-294",
      identifier: "SYMPH-294",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: new Date(now.getTime() - 10_000).toISOString(),
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 122_456,
      codexOutputTokens: 1_518,
      codexTotalTokens: 123_974,
    });
    entry.totalStageInputTokens = 122_456;
    entry.totalStageOutputTokens = 1_518;
    entry.totalStageTotalTokens = 123_974;
    entry.totalStageCacheReadTokens = 102_016;
    entry.rateLimitWindows = {
      primary: { startPercent: 10, latestPercent: 10, lastResetsAt: null },
      secondary: { startPercent: 23, latestPercent: 23, lastResetsAt: null },
    };
    state.running["issue-294"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.tokens_per_turn).toBe(123_974);
    expect(snapshot.running[0]!.health).toBe("green");
    expect(snapshot.running[0]!.health_reason).toBeNull();
  });

  it("exposes resolved output caps and compactions per stage", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 8_000,
        turns: 1,
        compactions: 1,
        outcome: "completed",
      },
    ];
    const now = new Date("2026-03-21T10:05:00.000Z");
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "compaction",
      lastCodexTimestamp: new Date(now.getTime() - 10_000).toISOString(),
      lastCodexMessage: "thread/autoCompact/completed",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 200,
      codexTotalTokens: 1_200,
    });
    entry.totalStageCompactions = 2;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, {
      now,
      enrichment: {
        codexCaps: {
          toolOutputTokenLimit: 1_234,
          modelAutoCompactTokenLimit: 12_345,
          maxHealthyCompactionsPerStage: 3,
        },
      },
    });

    expect(snapshot.running[0]!.output_caps).toEqual({
      tool_output_token_limit: 1_234,
      model_auto_compact_token_limit: 12_345,
    });
    expect(snapshot.running[0]!.churn).toEqual({
      compactions_per_stage: {
        investigate: 1,
        implement: 2,
      },
      current_stage_compactions: 2,
      max_healthy_compactions_per_stage: 3,
    });
  });

  it("classifies health as yellow when current-stage compactions exceed the healthy envelope", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "compaction",
      lastCodexTimestamp: new Date(now.getTime() - 10_000).toISOString(),
      lastCodexMessage: "thread/autoCompact/completed",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 200,
      codexTotalTokens: 1_200,
    });
    entry.totalStageTotalTokens = 1_200;
    entry.totalStageCompactions = 4;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("compaction churn");
    expect(snapshot.running[0]!.health_reason).toContain("implement stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 3");
  });

  it("preserves token-burn and compaction reasons when both thresholds trip", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "compaction",
      lastCodexTimestamp: new Date(now.getTime() - 10_000).toISOString(),
      lastCodexMessage: "thread/autoCompact/completed",
      turnCount: 2,
      codexInputTokens: 40_000,
      codexOutputTokens: 2_000,
      codexTotalTokens: 42_001,
    });
    entry.totalStageTotalTokens = 42_001;
    entry.totalStageCompactions = 4;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("high token burn");
    expect(snapshot.running[0]!.health_reason).toContain("compaction churn");
  });

  it("tokens in running row reflect cumulative stage totals, not per-turn absolute counters", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    // Simulate a session where codex absolute counters are small (e.g. start of a new turn)
    // but the stage has already accumulated significant tokens across prior turns
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "session_started",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Starting",
      turnCount: 5,
      codexInputTokens: 0, // Absolute counters reset at turn boundary
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    // Cumulative stage totals have been accumulating across 4 completed turns
    entry.totalStageInputTokens = 40_000;
    entry.totalStageOutputTokens = 20_000;
    entry.totalStageTotalTokens = 60_000;
    entry.totalStageCacheReadTokens = 5_000;
    entry.totalStageCacheWriteTokens = 2_000;
    entry.codexReasoningTokens = 1_000; // accumulated via +=
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    const row = snapshot.running[0]!;
    // tokens should show cumulative stage values, not the zero absolute counters
    expect(row.tokens.input_tokens).toBe(40_000);
    expect(row.tokens.output_tokens).toBe(20_000);
    expect(row.tokens.total_tokens).toBe(60_000);
    expect(row.tokens.cache_read_tokens).toBe(5_000);
    expect(row.tokens.cache_write_tokens).toBe(2_000);
    expect(row.tokens.reasoning_tokens).toBe(1_000);
  });

  it("includes first_dispatched_at from issueFirstDispatchedAt when set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueFirstDispatchedAt["issue-1"] = "2026-01-15T08:00:00.000Z";

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("falls back to startedAt for first_dispatched_at when issueFirstDispatchedAt is not set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
  });

  it("returns zero total_pipeline_tokens and empty execution_history when no history exists", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.total_pipeline_tokens).toBe(0);
    expect(snapshot.running[0]!.execution_history).toEqual([]);
  });

  it("sets issue_title from entry.issue.title", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    entry.issue.title = "Add login page";
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.issue_title).toBe("Add login page");
  });

  it("formats last_event_at as Eastern time instead of raw UTC", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T15:30:45.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T15:31:00.000Z"),
    });

    const lastEventAt = snapshot.running[0]!.last_event_at!;
    // Should be formatted in Eastern time, not raw UTC (Z suffix)
    expect(lastEventAt).not.toMatch(/Z$/);
    // Should contain Eastern timezone offset (-05:00 for EST)
    expect(lastEventAt).toMatch(/-0[45]:00$/);
    // 15:30:45 UTC = 10:30:45 ET (EST)
    expect(lastEventAt).toContain("10:30:45");
  });

  it("returns null last_event_at when lastCodexTimestamp is null", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_event_at).toBeNull();
  });

  it("counts completed and failed issues from state Sets", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.completed.add("done-1");
    state.completed.add("done-2");
    state.failed.add("fail-1");

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.counts.completed).toBe(2);
    expect(snapshot.counts.failed).toBe(1);
  });

  it("returns zero completed/failed when no execution history exists", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.counts.completed).toBe(0);
    expect(snapshot.counts.failed).toBe(0);
  });

  it("computes pipeline total time from first_dispatched_at for multi-stage issues", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-06T11:00:00.000Z");
    // First dispatched 1 hour ago
    state.issueFirstDispatchedAt["issue-1"] = "2026-03-06T10:00:00.000Z";
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 600_000,
        totalTokens: 10_000,
        turns: 5,
        outcome: "success",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:30:00.000Z", // current stage started 30min ago
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:59:50.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    // first_dispatched_at should be 1 hour before now
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
    // Pipeline column uses first_dispatched_at for total wall-clock time
    // The dashboard formats elapsed from first_dispatched_at to generated_at
  });

  it("uses started_at as pipeline total time for single-stage issues", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-06T10:05:00.000Z");
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:04:50.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    // For single-stage, first_dispatched_at falls back to started_at
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
  });
});

describe("getStallThreshold", () => {
  it("returns stage-specific thresholds for known stages", () => {
    expect(getStallThreshold("investigate")).toBe(600);
    expect(getStallThreshold("implement")).toBe(480);
    expect(getStallThreshold("review")).toBe(600);
    expect(getStallThreshold("merge")).toBe(300);
  });

  it("returns default threshold for unknown stages", () => {
    expect(getStallThreshold("custom-stage")).toBe(480);
  });

  it("returns default threshold for null stage", () => {
    expect(getStallThreshold(null)).toBe(480);
  });
});

describe("stage-aware health classification", () => {
  it("classifies health as yellow at 50%+ of investigate stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // investigate threshold=600s; 50% = 300s. 310s > 300s → yellow
    const timestamp = new Date(now.getTime() - 310_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Exploring codebase",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "investigate";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("investigate stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 600s");
  });

  it("classifies health as red at 80%+ of investigate stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // investigate threshold=600s; 80% = 480s. 500s > 480s → red
    const timestamp = new Date(now.getTime() - 500_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Exploring codebase",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "investigate";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("stalled");
    expect(snapshot.running[0]!.health_reason).toContain("investigate stage");
  });

  it("classifies health as green within 50% of implement stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // implement threshold=480s; 50% = 240s. 200s < 240s → green
    const timestamp = new Date(now.getTime() - 200_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Writing code",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("green");
    expect(snapshot.running[0]!.health_reason).toBeNull();
  });

  it("uses default threshold for unknown stage names", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // default threshold=480s; 80% = 384s. 400s > 384s → red
    const timestamp = new Date(now.getTime() - 400_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "custom-stage";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("custom-stage stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 480s");
  });

  it("uses default threshold when no stage is set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // default threshold=480s; 50% = 240s. 250s > 240s → yellow
    const timestamp = new Date(now.getTime() - 250_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    // No issueStages entry → null stage

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("unknown stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 480s");
  });

  it("health reason includes seconds of inactivity for yellow", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // review threshold=600s; 50% = 300s. 312s > 300s → yellow
    const timestamp = new Date(now.getTime() - 312_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Reviewing",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "review";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toBe(
      "slow: no activity for 312s (review stage, threshold 600s)",
    );
  });

  it("STAGE_STALL_THRESHOLDS has expected values", () => {
    expect(STAGE_STALL_THRESHOLDS).toEqual({
      investigate: 600,
      implement: 480,
      review: 600,
      merge: 300,
    });
  });
});

describe("formatEasternTimestamp", () => {
  it("formats a UTC date to Eastern time (ISO-8601 with EST offset)", () => {
    // 2026-03-06 is in EST (UTC-5)
    const result = formatEasternTimestamp(new Date("2026-03-06T15:30:45.000Z"));
    // 15:30:45 UTC = 10:30:45 Eastern (EST = UTC-5)
    expect(result).toContain("10:30:45");
    expect(result).toContain("-05:00");
    expect(result).not.toMatch(/Z$/);
  });

  it("handles EDT dates correctly", () => {
    // 2026-07-15 is in EDT (UTC-4)
    const result = formatEasternTimestamp(new Date("2026-07-15T18:00:00.000Z"));
    // 18:00:00 UTC = 14:00:00 Eastern (EDT = UTC-4)
    expect(result).toContain("14:00:00");
    expect(result).toContain("-04:00");
    expect(result).not.toMatch(/Z$/);
  });

  it("returns n/a for invalid dates", () => {
    expect(formatEasternTimestamp(new Date("invalid"))).toBe("n/a");
  });
});

describe("pipeline_tokens cumulative computation", () => {
  it("shows cumulative pipeline totals across completed and current stages", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 8_000,
        inputTokens: 5_000,
        outputTokens: 2_000,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        turns: 5,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Implementing",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageInputTokens = 3_000;
    entry.totalStageOutputTokens = 1_500;
    entry.totalStageTotalTokens = 5_000;
    entry.totalStageCacheReadTokens = 400;
    entry.totalStageCacheWriteTokens = 100;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(8_000);
    expect(row.pipeline_tokens.output_tokens).toBe(3_500);
    expect(row.pipeline_tokens.total_tokens).toBe(13_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(1_200);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(300);
    expect(row.total_pipeline_tokens).toBe(13_000);
  });
  it("includes tokens from completed stages via execution_history across stage transitions", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        inputTokens: 30_000,
        outputTokens: 15_000,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 1_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        inputTokens: 50_000,
        outputTokens: 25_000,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 2_000,
        turns: 10,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Reviewing",
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    entry.totalStageInputTokens = 0;
    entry.totalStageOutputTokens = 0;
    entry.totalStageTotalTokens = 0;
    entry.totalStageCacheReadTokens = 0;
    entry.totalStageCacheWriteTokens = 0;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(80_000);
    expect(row.pipeline_tokens.output_tokens).toBe(40_000);
    expect(row.pipeline_tokens.total_tokens).toBe(130_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(7_000);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(3_000);
    expect(row.total_pipeline_tokens).toBe(130_000);
  });
  it("shows current stage tokens only when no execution_history exists (first stage)", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Investigating",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageInputTokens = 4_000;
    entry.totalStageOutputTokens = 2_000;
    entry.totalStageTotalTokens = 7_000;
    entry.totalStageCacheReadTokens = 600;
    entry.totalStageCacheWriteTokens = 400;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(4_000);
    expect(row.pipeline_tokens.output_tokens).toBe(2_000);
    expect(row.pipeline_tokens.total_tokens).toBe(7_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(600);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(400);
    expect(row.total_pipeline_tokens).toBe(7_000);
  });
  it("handles execution_history with missing optional token fields (backward compat)", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Implementing",
      turnCount: 1,
      codexInputTokens: 500,
      codexOutputTokens: 250,
      codexTotalTokens: 750,
    });
    entry.totalStageInputTokens = 2_000;
    entry.totalStageOutputTokens = 1_000;
    entry.totalStageTotalTokens = 3_000;
    entry.totalStageCacheReadTokens = 100;
    entry.totalStageCacheWriteTokens = 50;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(2_000);
    expect(row.pipeline_tokens.output_tokens).toBe(1_000);
    expect(row.pipeline_tokens.total_tokens).toBe(53_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(100);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(50);
  });
});

function createRunningEntry(input: {
  issueId: string;
  identifier: string;
  startedAt: string;
  sessionId: string;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  turnCount: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
}): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    sessionId: input.sessionId,
    threadId: input.sessionId.split("-turn-")[0] ?? null,
    turnId: input.sessionId.split("-").at(-1) ?? null,
    lastCodexEvent: input.lastCodexEvent,
    lastCodexTimestamp: input.lastCodexTimestamp,
    lastCodexMessage: input.lastCodexMessage,
    turnCount: input.turnCount,
    codexInputTokens: input.codexInputTokens,
    codexOutputTokens: input.codexOutputTokens,
    codexTotalTokens: input.codexTotalTokens,
    issue: {
      id: input.issueId,
      identifier: input.identifier,
      title: input.identifier,
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    identifier: input.identifier,
    retryAttempt: null,
    startedAt: input.startedAt,
    workerHandle: null,
    monitorHandle: null,
    failureReason: null,
  };
}

describe("state-document enrichment (SYMPH-407)", () => {
  function makeJournalEntry(input: {
    sequence: number;
    kind: DispatcherRunJournalEntry["kind"];
    issueId?: string;
    issueIdentifier?: string;
    metadata?: Record<string, unknown>;
  }): DispatcherRunJournalEntry {
    return {
      sequence: input.sequence,
      idempotencyKey: `entry:${input.sequence}`,
      timestamp: "2026-06-12T10:00:00.000Z",
      kind: input.kind,
      issueId: input.issueId ?? "issue-1",
      issueIdentifier: input.issueIdentifier ?? "ABC-1",
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: null,
      lease: null,
      summary: `entry ${input.sequence}`,
      metadata: input.metadata ?? {},
    };
  }

  function reviewMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      source: "pipeline",
      contract_version: "structured_v1",
      repo: "mobilyze-llc/symphony-ts",
      pr_number: 451,
      base_ref: "main",
      head_ref: "codex/SYMPH-451-review-state",
      base_sha: "base-sha",
      head_sha: "head-sha",
      routing_mode: "full",
      round: 1,
      ...metadata,
    };
  }

  function makeState() {
    return createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
  }

  it("carries as_of_sequence from the journal, preferring the enrichment cursor", () => {
    const state = makeState();
    expect(buildRuntimeSnapshot(state).as_of_sequence).toBe(0);

    state.dispatcherRunJournal = [
      makeJournalEntry({ sequence: 1, kind: "admission" }),
      makeJournalEntry({ sequence: 7, kind: "dispatch_verdict" }),
    ];
    expect(buildRuntimeSnapshot(state).as_of_sequence).toBe(7);
    expect(
      buildRuntimeSnapshot(state, { enrichment: { asOfSequence: 9 } })
        .as_of_sequence,
    ).toBe(9);
  });

  it("projects a clean Council review pass from review journal events", () => {
    const state = makeState();
    const cleanMetadata = (metadata: Record<string, unknown>) =>
      reviewMetadata({
        bundle_hash: "bundle-clean",
        head_sha: "head-clean",
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 10,
        kind: "review_round",
        metadata: cleanMetadata({
          round: 1,
          routing_mode: "full",
        }),
      }),
      makeJournalEntry({
        sequence: 11,
        kind: "review_lane",
        metadata: cleanMetadata({
          lane_id: "claude-opus",
          lane_agent: "claude",
          lane_role: "reviewer",
          lane_model: "opus",
          lane_state: "completed",
          lane_verdict: "pass",
          independent_reviewer: true,
          parse_status: "synthesized_from_markdown",
          finding_count: 0,
        }),
      }),
      makeJournalEntry({
        sequence: 12,
        kind: "review_gate_result",
        metadata: cleanMetadata({
          gate_verdict: "pass",
          reviewed_head_sha: "reviewed-clean",
          lane_count: 1,
          finding_count: 0,
          blocking_finding_count: 0,
          degraded_condition_count: 0,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review).toMatchObject({
      issue_id: "issue-1",
      issue_identifier: "ABC-1",
      status: "passed",
      availability: "available",
      current_round: 1,
      last_round: 1,
      routing_mode: "full",
      bundle_hash: "bundle-clean",
      reviewed_head_sha: "reviewed-clean",
      author_family: null,
      fixer_family: null,
      verdict: "pass",
      next_action: "continue_pipeline",
      cursor_range: {
        first_sequence: 10,
        last_sequence: 12,
      },
    });
    expect(review.decorrelation_basis).toEqual({
      repo: "mobilyze-llc/symphony-ts",
      pr_number: 451,
      base_ref: "main",
      head_ref: "codex/SYMPH-451-review-state",
      base_sha: "base-sha",
      head_sha: "head-clean",
    });
    expect(review.lanes).toEqual([
      {
        lane_id: "claude-opus",
        lane_agent: "claude",
        lane_role: "reviewer",
        lane_model: "opus",
        lane_state: "completed",
        lane_verdict: "pass",
        independent_reviewer: true,
        parse_status: "synthesized_from_markdown",
        degraded_reason: null,
        finding_count: 0,
      },
    ]);
    expect(review.finding_counts_by_disposition).toEqual({});
  });

  it("projects Council termination ladder thresholds from review events", () => {
    const state = makeState();
    const ladderMetadata = (metadata: Record<string, unknown>) =>
      reviewMetadata({
        round: 3,
        routing_mode: "convergence",
        bundle_hash: "bundle-ladder",
        head_sha: "head-ladder",
        rounds_per_cycle: 3,
        round_warning_threshold: 2,
        round_cap: 3,
        termination_alert_level: "operator",
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 13,
        kind: "review_round",
        metadata: ladderMetadata({}),
      }),
      makeJournalEntry({
        sequence: 14,
        kind: "review_escalation",
        metadata: ladderMetadata({
          escalation_reason: "spine_escalate",
          termination_status: "operator_decision",
          termination_reason: "spine_escalate",
          termination_action: "operator_decision_required_with_synthesis",
          synthesis_count: 2,
          blocking_finding_count: 1,
          non_blocking_finding_count: 1,
          track_finding_count: 1,
        }),
      }),
      makeJournalEntry({
        sequence: 15,
        kind: "review_gate_result",
        metadata: ladderMetadata({
          gate_verdict: "fail",
          termination_status: "operator_decision",
          termination_reason: "spine_escalate",
          termination_action: "operator_decision_required_with_synthesis",
          synthesis_count: 2,
          blocking_finding_count: 1,
          non_blocking_finding_count: 1,
          track_finding_count: 1,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("escalated");
    expect(review.next_action).toBe("operator_decision_required");
    expect(review.rounds_per_cycle).toEqual({
      current: 3,
      warning_threshold: 2,
      cap: 3,
      alert_level: "operator",
    });
    expect(review.termination).toEqual({
      status: "operator_decision",
      reason: "spine_escalate",
      action: "operator_decision_required_with_synthesis",
      alert_level: "operator",
      synthesis_count: 2,
      blocking_finding_count: 1,
      non_blocking_finding_count: 1,
      track_finding_count: 1,
    });
  });

  it("projects Council termination continue action instead of generic rework", () => {
    const state = makeState();
    const continueMetadata = (metadata: Record<string, unknown>) =>
      reviewMetadata({
        round: 2,
        routing_mode: "convergence",
        bundle_hash: "bundle-continue",
        head_sha: "head-continue",
        rounds_per_cycle: 2,
        round_warning_threshold: 2,
        round_cap: 3,
        termination_alert_level: "warning",
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 16,
        kind: "review_round",
        metadata: continueMetadata({}),
      }),
      makeJournalEntry({
        sequence: 17,
        kind: "review_gate_result",
        metadata: continueMetadata({
          gate_verdict: "fail",
          termination_status: "continue",
          termination_reason: "blocking_findings",
          termination_action: "continue_fix_loop",
          blocking_finding_count: 1,
          non_blocking_finding_count: 0,
          track_finding_count: 0,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("failed");
    expect(review.next_action).toBe("continue_fix_loop");
    expect(review.termination).toMatchObject({
      status: "continue",
      reason: "blocking_findings",
      action: "continue_fix_loop",
      alert_level: "warning",
      blocking_finding_count: 1,
    });
  });

  it("projects Council findings and fix-round rework without reviewer prose", () => {
    const state = makeState();
    const reworkMetadata = (metadata: Record<string, unknown>) =>
      reviewMetadata({
        round: 2,
        routing_mode: "convergence",
        bundle_hash: "bundle-rework",
        head_sha: "head-rework",
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 20,
        kind: "review_round",
        metadata: reworkMetadata({}),
      }),
      makeJournalEntry({
        sequence: 21,
        kind: "fix_round",
        metadata: reworkMetadata({
          fix_round: 2,
          previous_head_sha: "head-before-fix",
        }),
      }),
      makeJournalEntry({
        sequence: 22,
        kind: "review_rework",
        metadata: reworkMetadata({
          rework_finding_count: 1,
          introduced_in: ["fix_round_2"],
        }),
      }),
      makeJournalEntry({
        sequence: 23,
        kind: "review_finding",
        metadata: reworkMetadata({
          finding_fingerprint: "fp-open",
          finding_severity: "P1",
          finding_disposition: "open",
          related_paths: ["src/private.ts"],
          evidence_locations: [{ path: "src/private.ts", line_start: 1 }],
        }),
      }),
      makeJournalEntry({
        sequence: 24,
        kind: "review_finding",
        metadata: reworkMetadata({
          finding_fingerprint: "fp-fixed",
          finding_severity: "P3",
          finding_disposition: "fixed",
        }),
      }),
      makeJournalEntry({
        sequence: 25,
        kind: "review_finding",
        metadata: reworkMetadata({
          finding_fingerprint: "fp-open",
          finding_severity: "P1",
          finding_disposition: "open",
          lane_id: "second-reviewer",
        }),
      }),
      makeJournalEntry({
        sequence: 26,
        kind: "review_gate_result",
        metadata: reworkMetadata({
          gate_verdict: "fail",
          finding_count: 2,
          blocking_finding_count: 1,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("failed");
    expect(review.routing_mode).toBe("convergence");
    expect(review.fixer_family).toBeNull();
    expect(review.finding_counts_by_disposition).toEqual({
      fixed: 1,
      open: 1,
    });
    expect(review.next_action).toBe("rework_required");
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("src/private.ts");
    expect(serialized).not.toContain("evidence_locations");
    expect(serialized).not.toContain("related_paths");
  });

  it("projects Council escalation and malformed/degraded lane status", () => {
    const state = makeState();
    const degradedMetadata = (metadata: Record<string, unknown>) =>
      reviewMetadata({
        routing_mode: "thin",
        bundle_hash: "bundle-degraded",
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 30,
        kind: "review_round",
        metadata: degradedMetadata({
          round: 1,
        }),
      }),
      makeJournalEntry({
        sequence: 31,
        kind: "review_lane",
        metadata: degradedMetadata({
          lane_id: "codex-excavation",
          lane_agent: "codex",
          lane_role: "excavation",
          lane_state: "degraded",
          lane_verdict: "error",
          degraded_reason: "artifact_parse_failed",
          parse_status: "malformed",
          finding_count: 0,
        }),
      }),
      makeJournalEntry({
        sequence: 32,
        kind: "review_escalation",
        metadata: degradedMetadata({
          escalation_reason: "degraded_review_substrate",
          degraded_condition_count: 1,
          degraded_conditions: ["artifact_parse_failed"],
        }),
      }),
      makeJournalEntry({
        sequence: 33,
        kind: "review_gate_result",
        metadata: degradedMetadata({
          gate_verdict: "error",
          degraded_condition_count: 1,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("degraded");
    expect(review.escalation).toEqual({
      predicate: "degraded_review_substrate",
      reason: "degraded_review_substrate",
      sequence: 32,
    });
    expect(review.degraded).toEqual({
      status: "malformed",
      reasons: ["artifact_parse_failed", "degraded_review_substrate"],
      malformed_lane_count: 1,
    });
    expect(review.next_action).toBe("inspect_review_substrate");
  });

  it("clears stale degradation and findings when a later review round passes cleanly", () => {
    const state = makeState();
    const roundMetadata = (round: number, metadata: Record<string, unknown>) =>
      reviewMetadata({
        round,
        bundle_hash: `bundle-round-${round}`,
        head_sha: `head-round-${round}`,
        ...metadata,
      });
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 40,
        kind: "review_round",
        metadata: roundMetadata(1, {}),
      }),
      makeJournalEntry({
        sequence: 41,
        kind: "review_lane",
        metadata: roundMetadata(1, {
          lane_id: "claude-opus",
          lane_state: "degraded",
          lane_verdict: "error",
          degraded_reason: "artifact_parse_failed",
          parse_status: "malformed",
        }),
      }),
      makeJournalEntry({
        sequence: 42,
        kind: "review_finding",
        metadata: roundMetadata(1, {
          finding_fingerprint: "fp-stale",
          finding_disposition: "open",
        }),
      }),
      makeJournalEntry({
        sequence: 43,
        kind: "review_gate_result",
        metadata: roundMetadata(1, {
          gate_verdict: "error",
          degraded_condition_count: 1,
        }),
      }),
      makeJournalEntry({
        sequence: 44,
        kind: "review_round",
        metadata: roundMetadata(2, {}),
      }),
      makeJournalEntry({
        sequence: 45,
        kind: "review_lane",
        metadata: roundMetadata(2, {
          lane_id: "claude-opus",
          lane_state: "completed",
          lane_verdict: "pass",
          parse_status: "synthesized_from_markdown",
          finding_count: 0,
        }),
      }),
      makeJournalEntry({
        sequence: 46,
        kind: "review_gate_result",
        metadata: roundMetadata(2, {
          gate_verdict: "pass",
          degraded_condition_count: 0,
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("passed");
    expect(review.current_round).toBe(2);
    expect(review.last_round).toBe(2);
    expect(review.bundle_hash).toBe("bundle-round-2");
    expect(review.reviewed_head_sha).toBe("head-round-2");
    expect(review.finding_counts_by_disposition).toEqual({});
    expect(review.degraded).toEqual({
      status: "ok",
      reasons: [],
      malformed_lane_count: 0,
    });
    expect(review.lanes).toEqual([
      expect.objectContaining({
        lane_id: "claude-opus",
        lane_state: "completed",
        lane_verdict: "pass",
        parse_status: "synthesized_from_markdown",
      }),
    ]);
    expect(review.cursor_range).toEqual({
      first_sequence: 40,
      last_sequence: 46,
    });
  });

  it("separates in-progress current rounds from the last completed gate round", () => {
    const state = makeState();
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 50,
        kind: "review_round",
        metadata: reviewMetadata({ round: 1, head_sha: "head-round-1" }),
      }),
      makeJournalEntry({
        sequence: 51,
        kind: "review_gate_result",
        metadata: reviewMetadata({
          round: 1,
          head_sha: "head-round-1",
          gate_verdict: "fail",
        }),
      }),
      makeJournalEntry({
        sequence: 52,
        kind: "review_round",
        metadata: reviewMetadata({
          round: 2,
          head_sha: "head-round-2",
          routing_mode: "convergence",
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("in_progress");
    expect(review.current_round).toBe(2);
    expect(review.last_round).toBe(1);
    expect(review.verdict).toBeNull();
    expect(review.next_action).toBe("await_review_gate_result");
    expect(review.decorrelation_basis.head_sha).toBe("head-round-2");
  });

  it("keeps malformed lane degradation even when the lane id is missing", () => {
    const state = makeState();
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 60,
        kind: "review_round",
        metadata: reviewMetadata({ round: 1 }),
      }),
      makeJournalEntry({
        sequence: 61,
        kind: "review_lane",
        metadata: reviewMetadata({
          round: 1,
          degraded_reason: "missing_lane_id",
          parse_status: "malformed",
        }),
      }),
    ];

    const review = buildRuntimeSnapshot(state).council_reviews!["issue-1"]!;

    expect(review.status).toBe("degraded");
    expect(review.lanes).toEqual([]);
    expect(review.degraded).toEqual({
      status: "malformed",
      reasons: ["missing_lane_id"],
      malformed_lane_count: 1,
    });
  });

  it("renders explicit Council not_started/unavailable when review-stage events are absent", () => {
    const state = makeState();
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-06-12T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    state.issueStages["issue-1"] = "review";

    expect(buildRuntimeSnapshot(state).council_reviews!["issue-1"]).toEqual({
      issue_id: "issue-1",
      issue_identifier: "ABC-1",
      status: "not_started",
      availability: "unavailable",
      current_round: null,
      last_round: null,
      routing_mode: null,
      decorrelation_basis: {
        repo: null,
        pr_number: null,
        base_ref: null,
        head_ref: null,
        base_sha: null,
        head_sha: null,
      },
      author_family: null,
      fixer_family: null,
      bundle_hash: null,
      reviewed_head_sha: null,
      lanes: [],
      verdict: null,
      finding_counts_by_disposition: {},
      escalation: null,
      degraded: {
        status: "ok",
        reasons: [],
        malformed_lane_count: 0,
      },
      next_action: "await_review_events",
      cursor_range: {
        first_sequence: null,
        last_sequence: null,
      },
    });
  });

  it("renders per-issue counters coherently (escalations, triage resumes, rework, spend)", () => {
    const state = makeState();
    state.issueBudgetEscalations["issue-1"] = 2;
    state.issuePauseTriageResumes["issue-1"] = 1;
    state.issueReworkCounts["issue-1"] = 3;
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 1_800_000,
        totalTokens: 40_000,
        rateLimitWindows: {
          primary: { startPercent: 10, latestPercent: 12.5, lastResetsAt: 1 },
          secondary: { startPercent: 90, latestPercent: 91, lastResetsAt: 2 },
        },
        usageEventCadence: {
          observedCount: 4,
          retainedCount: 3,
          truncated: true,
          maxTotalTokensDelta: 8_000,
        },
        turns: 12,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 600_000,
        totalTokens: 0,
        turns: 3,
        outcome: "completed",
      },
      {
        stageName: "review",
        durationMs: 300_000,
        totalTokens: 0,
        rateLimitWindows: {
          primary: { startPercent: 20.2, latestPercent: 19.1, lastResetsAt: 3 },
          secondary: { startPercent: 91, latestPercent: 90, lastResetsAt: 4 },
        },
        turns: 1,
        outcome: "completed",
      },
    ];
    const running = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-06-12T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 2,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    running.totalStageTotalTokens = 5_000;
    running.rateLimitWindows.primary = {
      startPercent: 12.5,
      latestPercent: 13,
      lastResetsAt: 1,
    };
    running.tokenTelemetryObservedCount = 2;
    running.tokenTelemetry = [
      {
        timestamp: "2026-06-12T10:00:30.000Z",
        event: "turn_completed",
        sessionId: "thread-a-turn-1",
        turnId: "turn-2",
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        noCacheTokens: null,
        reasoningTokens: null,
        inputTokensDelta: 1_000,
        outputTokensDelta: 500,
        totalTokensDelta: 1_500,
        cacheReadTokensDelta: 0,
        cacheWriteTokensDelta: 0,
        noCacheTokensDelta: 0,
        reasoningTokensDelta: 0,
      },
    ];
    state.running["issue-1"] = running;
    state.issueBudgetEscalations["issue-3"] = 1;
    state.running["issue-3"] = createRunningEntry({
      issueId: "issue-3",
      identifier: "ABC-3",
      startedAt: "2026-06-12T10:00:00.000Z",
      sessionId: "thread-c-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 1,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    // issue with no non-zero counters must not appear
    state.issueExecutionHistory["issue-2"] = [];

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-06-12T10:01:00.000Z"),
    });
    expect(snapshot.counters["issue-1"]).toEqual({
      escalation_steps: 2,
      triage_resumes: 1,
      rework_count: 3,
      spend: {
        total_tokens: 45_000,
        completed_stage_tokens: 40_000,
        live_stage_tokens: 5_000,
        rate_limit_window_delta_pct: {
          primary: 3,
          secondary: 1,
        },
        usage_events: {
          observed: 6,
          retained: 4,
          truncated: true,
          max_total_tokens_delta: 8_000,
        },
      },
    });
    expect(snapshot.counters["issue-3"]).toMatchObject({
      escalation_steps: 1,
      spend: {
        rate_limit_window_delta_pct: {
          primary: 0,
          secondary: 0,
        },
        usage_events: {
          observed: 0,
          retained: 0,
          truncated: false,
          max_total_tokens_delta: 0,
        },
      },
    });
    expect(snapshot.counters["issue-2"]).toBeUndefined();
  });

  it("renders both rate views with sources and disagrees visibly when trackers disagree", () => {
    const state = makeState();
    state.codexRateLimits = {
      primary: { used_percent: 40, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 97, window_minutes: 10080, resets_at: 2 },
    };
    state.codexRateLimitsObservedAt = "2026-06-12T09:58:00.000Z";
    state.rateLimitAdmission = {
      blocked: true,
      reason: "secondary window headroom 2.0% < 5% floor",
      evaluatedAt: "2026-06-12T10:00:00.000Z",
      minPrimaryHeadroomPct: 10,
      minSecondaryHeadroomPct: 5,
      primaryUsedPercent: 39,
      secondaryUsedPercent: 98,
      expectedUnitBurnPct: 3,
      deferredUntil: "2026-06-12T12:00:00.000Z",
    };
    const snapshot = buildRuntimeSnapshot(state, {
      enrichment: {
        rateLimitFile: {
          path: "/workspaces/.symphony/rate-limits.json",
          observedAt: "2026-06-12T09:55:00.000Z",
          rateLimits: {
            primary: { used_percent: 39, window_minutes: 300, resets_at: 1 },
            secondary: { used_percent: 6, window_minutes: 10080, resets_at: 2 },
          },
        },
      },
    });

    expect(snapshot.rate_limit_views.runner_snapshot_file).toMatchObject({
      source: "/workspaces/.symphony/rate-limits.json",
      observed_at: "2026-06-12T09:55:00.000Z",
      primary_used_pct: 39,
      secondary_used_pct: 6,
    });
    expect(snapshot.rate_limit_views.gate).toMatchObject({
      source: "dispatch admission gate (rate_limit_admission evaluation)",
      blocked: true,
      primary_used_pct: 39,
      secondary_used_pct: 98,
    });
    expect(snapshot.rate_limit_views.live_telemetry).toEqual({
      source: "in-memory runner telemetry (orchestrator state)",
      observed_at: "2026-06-12T09:58:00.000Z",
      primary_used_pct: 40,
      secondary_used_pct: 97,
    });
    // The SYMPH-338 case: file says 6%, gate says 98% — visible disagreement.
    expect(snapshot.rate_limit_views.disagreement).toBe(true);
  });

  it("reports agreement and null when a view is missing", () => {
    const state = makeState();
    expect(buildRuntimeSnapshot(state).rate_limit_views).toEqual({
      runner_snapshot_file: null,
      gate: null,
      live_telemetry: null,
      disagreement: null,
    });

    state.rateLimitAdmission = {
      blocked: false,
      reason: null,
      evaluatedAt: "2026-06-12T10:00:00.000Z",
      minPrimaryHeadroomPct: 10,
      minSecondaryHeadroomPct: 5,
      primaryUsedPercent: 39.4,
      secondaryUsedPercent: 97.8,
    };
    const agreeing = buildRuntimeSnapshot(state, {
      enrichment: {
        rateLimitFile: {
          path: "/workspaces/.symphony/rate-limits.json",
          observedAt: "2026-06-12T09:55:00.000Z",
          rateLimits: {
            primary: { used_percent: 39, window_minutes: 300, resets_at: 1 },
            secondary: {
              used_percent: 98,
              window_minutes: 10080,
              resets_at: 2,
            },
          },
        },
      },
    });
    expect(agreeing.rate_limit_views.disagreement).toBe(false);
  });

  it("surfaces snapshot observation time and staleness on the gate view (SYMPH-778)", () => {
    const state = makeState();
    state.codexRateLimits = {
      secondary: { used_percent: 98, window_minutes: 10080, resets_at: 2 },
    };
    state.codexRateLimitsObservedAt = "2026-06-12T03:00:00.000Z";
    state.rateLimitAdmission = {
      blocked: true,
      reason: "stale telemetry observed 2026-06-12T03:00:00.000Z",
      evaluatedAt: "2026-06-12T10:00:00.000Z",
      minPrimaryHeadroomPct: null,
      minSecondaryHeadroomPct: 5,
      primaryUsedPercent: null,
      secondaryUsedPercent: 98,
      snapshotObservedAt: "2026-06-12T03:00:00.000Z",
      snapshotStale: true,
      staleBypass: false,
    };

    const snapshot = buildRuntimeSnapshot(state);

    // The gate view distinguishes telemetry age (snapshot_observed_at) from the
    // gate evaluation time (evaluated_at).
    expect(snapshot.rate_limit_views.gate).toMatchObject({
      evaluated_at: "2026-06-12T10:00:00.000Z",
      snapshot_observed_at: "2026-06-12T03:00:00.000Z",
      stale: true,
      stale_bypass: false,
    });
  });

  it("summarizes watchdog clusters and breakers with journal cursors", () => {
    const state = makeState();
    state.dispatcherRunJournal = [
      makeJournalEntry({
        sequence: 4,
        kind: "cluster_transition",
        metadata: { signature: "abc1234" },
      }),
      makeJournalEntry({
        sequence: 6,
        kind: "cluster_transition",
        metadata: { signature: "abc1234" },
      }),
      makeJournalEntry({
        sequence: 8,
        kind: "breaker_transition",
        metadata: { stage: "implement", signature: "abc1234" },
      }),
    ];
    const snapshot = buildRuntimeSnapshot(state, {
      enrichment: {
        watchdog: {
          clusters: [
            {
              signature: "abc1234",
              error_class: "infra",
              cluster_size: 2,
              member_issue_identifiers: ["ABC-1", "ABC-2"],
              last_alert_size: 2,
            },
          ],
          openBreakers: [
            {
              stage_name: "implement",
              signature: "abc1234",
              opened_at: "2026-06-12T10:00:00.000Z",
              opened_for_issue_ids: ["issue-1", "issue-2"],
            },
          ],
        },
      },
    });

    expect(snapshot.watchdog.clusters).toEqual([
      {
        signature: "abc1234",
        error_class: "infra",
        cluster_size: 2,
        member_issue_identifiers: ["ABC-1", "ABC-2"],
        last_alert_size: 2,
        last_transition_sequence: 6,
      },
    ]);
    expect(snapshot.watchdog.open_breakers).toEqual([
      {
        stage_name: "implement",
        signature: "abc1234",
        opened_at: "2026-06-12T10:00:00.000Z",
        opened_for_issue_ids: ["issue-1", "issue-2"],
        last_transition_sequence: 8,
      },
    ]);
  });

  it("passes components and deploy drift through as one document", () => {
    const state = makeState();
    const snapshot = buildRuntimeSnapshot(state, {
      enrichment: {
        components: {
          slack_notifier: {
            enabled: false,
            degraded_reason: "no notification sink configured",
          },
        },
        deployDrift: {
          running_commit: "aaa111",
          origin_main_commit: "bbb222",
          drift: true,
          captured_at: "2026-06-12T10:00:00.000Z",
          note: "captured once at startup",
        },
      },
    });
    expect(snapshot.components.slack_notifier).toEqual({
      enabled: false,
      degraded_reason: "no notification sink configured",
    });
    expect(snapshot.deploy_drift?.drift).toBe(true);
  });
});

describe("buildStateDelta (SYMPH-407)", () => {
  function entryAt(sequence: number): DispatcherRunJournalEntry {
    return {
      sequence,
      idempotencyKey: `entry:${sequence}`,
      timestamp: "2026-06-12T10:00:00.000Z",
      kind: "admission",
      issueId: "issue-1",
      issueIdentifier: "ABC-1",
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: null,
      lease: null,
      summary: `entry ${sequence}`,
      metadata: {},
    };
  }

  it("returns exactly the journal-backed deltas between two cursors", () => {
    const journal = [1, 2, 3, 4, 5].map(entryAt);
    const delta = buildStateDelta(journal, { sinceSeq: 2 });
    expect(delta.since_seq).toBe(2);
    expect(delta.as_of_sequence).toBe(5);
    expect(delta.count).toBe(3);
    expect(delta.truncated).toBe(false);
    expect(delta.entries.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
  });

  it("returns committed entries after the cursor across sparse sequence gaps", () => {
    const journal = [1, 4, 7].map(entryAt);
    const delta = buildStateDelta(journal, { sinceSeq: 2 });
    expect(delta.since_seq).toBe(2);
    expect(delta.as_of_sequence).toBe(7);
    expect(delta.count).toBe(2);
    expect(delta.truncated).toBe(false);
    expect(delta.entries.map((entry) => entry.sequence)).toEqual([4, 7]);
  });

  it("bounds the page and reports truncation", () => {
    const journal = Array.from({ length: 10 }, (_, index) =>
      entryAt(index + 1),
    );
    const delta = buildStateDelta(journal, { sinceSeq: 0, limit: 4 });
    expect(delta.count).toBe(4);
    expect(delta.truncated).toBe(true);
    expect(delta.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("clamps the limit to the maximum page size", () => {
    const journal = Array.from({ length: STATE_DELTA_MAX_LIMIT + 5 }, (_, i) =>
      entryAt(i + 1),
    );
    const delta = buildStateDelta(journal, {
      sinceSeq: 0,
      limit: STATE_DELTA_MAX_LIMIT + 100,
    });
    expect(delta.count).toBe(STATE_DELTA_MAX_LIMIT);
    expect(delta.truncated).toBe(true);
  });

  it("returns an empty page at the head cursor", () => {
    const journal = [1, 2, 3].map(entryAt);
    const delta = buildStateDelta(journal, { sinceSeq: 3 });
    expect(delta.count).toBe(0);
    expect(delta.truncated).toBe(false);
    expect(delta.entries).toEqual([]);
    expect(delta.as_of_sequence).toBe(3);
  });

  it("projects resumed_existing_active pickup evidence for /state deltas", () => {
    const resumeEntry: DispatcherRunJournalEntry = {
      ...entryAt(1),
      kind: "resumed_existing_active",
      stage: "implement",
      summary:
        "Resumed existing active Pipeline work for SYMPH-455 after journal replay.",
      metadata: {
        schema_version: 1,
        status: "completed",
        source: "restart_replay",
        resume_reason: "prior_dispatch_replayed",
        rework_count: 0,
        details: {
          should_not_egress: "private",
        },
      },
    };
    const delta = buildStateDelta([resumeEntry], { sinceSeq: 0 });

    expect(delta.entries).toEqual([
      expect.objectContaining({
        kind: "resumed_existing_active",
        stage: "implement",
        summary:
          "Resumed existing active Pipeline work for SYMPH-455 after journal replay.",
        metadata: {
          status: "completed",
          source: "restart_replay",
          resume_reason: "prior_dispatch_replayed",
          rework_count: 0,
        },
      }),
    ]);
    expect(JSON.stringify(delta)).not.toContain("should_not_egress");
  });

  it("projects entries through the egress whitelist — no raw metadata passthrough", () => {
    const clusterEntry: DispatcherRunJournalEntry = {
      ...entryAt(1),
      kind: "cluster_transition",
      ownerId: "owner-1",
      lease: null,
      metadata: {
        schema_version: 1,
        transition: "grew",
        signature: "sig-abc",
        issueCount: 3,
        stages: ["implement"],
        details: {
          errorClass: "agent_error",
          normalizedText: "SECRET-prompt-injection-payload",
          members: [{ issueId: "issue-9", issueIdentifier: "ABC-9" }],
          lastAlertSize: 2,
        },
      },
    };
    const delta = buildStateDelta([clusterEntry], { sinceSeq: 0 });

    expect(delta.entries).toHaveLength(1);
    const projected = delta.entries[0]!;
    // Whitelisted scalars survive; suppressed egress content does not.
    expect(projected.metadata).toEqual({
      transition: "grew",
      signature: "sig-abc",
    });
    expect(projected).not.toHaveProperty("ownerId");
    expect(projected).not.toHaveProperty("lease");
    expect(projected).not.toHaveProperty("idempotencyKey");
    const serialized = JSON.stringify(delta);
    expect(serialized).not.toContain("normalizedText");
    expect(serialized).not.toContain("SECRET-prompt-injection-payload");
    expect(serialized).not.toContain("members");
    expect(serialized).not.toContain("issue-9");
  });

  it("keeps array-valued review metadata raw-journal-only in /state deltas", () => {
    const reworkEntry: DispatcherRunJournalEntry = {
      ...entryAt(1),
      kind: "review_rework",
      metadata: {
        round: 2,
        routing_mode: "convergence",
        rework_finding_count: 2,
        introduced_in: ["fix_round_2", "SECRET-review-label"],
      },
    };
    const escalationEntry: DispatcherRunJournalEntry = {
      ...entryAt(2),
      kind: "review_escalation",
      metadata: {
        round: 2,
        escalation_reason: "degraded_review_substrate",
        gate_verdict: "error",
        blocking_finding_count: 1,
        degraded_condition_count: 2,
        termination_status: "operator_decision",
        termination_reason: "round_cap_hit",
        termination_action: "operator_decision_required_with_synthesis",
        termination_alert_level: "operator",
        rounds_per_cycle: 3,
        round_warning_threshold: 2,
        round_cap: 3,
        synthesis_count: 1,
        non_blocking_finding_count: 0,
        track_finding_count: 0,
        degraded_conditions: ["artifact_parse_failed", "SECRET-condition"],
        finding_fingerprints: ["fp-private"],
        related_paths: ["src/private.ts"],
        evidence_locations: [{ path: "src/private.ts", line_start: 1 }],
      },
    };

    const delta = buildStateDelta([reworkEntry, escalationEntry], {
      sinceSeq: 0,
    });

    expect(delta.entries[0]).toMatchObject({
      kind: "review_rework",
      metadata: {
        round: 2,
        routing_mode: "convergence",
        rework_finding_count: 2,
      },
    });
    expect(delta.entries[0]!.metadata).not.toHaveProperty("introduced_in");
    expect(delta.entries[1]).toMatchObject({
      kind: "review_escalation",
      metadata: {
        round: 2,
        escalation_reason: "degraded_review_substrate",
        gate_verdict: "error",
        blocking_finding_count: 1,
        degraded_condition_count: 2,
        termination_status: "operator_decision",
        termination_reason: "round_cap_hit",
        termination_action: "operator_decision_required_with_synthesis",
        termination_alert_level: "operator",
        rounds_per_cycle: 3,
        round_warning_threshold: 2,
        round_cap: 3,
        synthesis_count: 1,
        non_blocking_finding_count: 0,
        track_finding_count: 0,
      },
    });
    expect(delta.entries[1]!.metadata).not.toHaveProperty(
      "degraded_conditions",
    );
    expect(delta.entries[1]!.metadata).not.toHaveProperty(
      "finding_fingerprints",
    );

    const serialized = JSON.stringify(delta);
    expect(serialized).not.toContain("SECRET-review-label");
    expect(serialized).not.toContain("SECRET-condition");
    expect(serialized).not.toContain("src/private.ts");
    expect(serialized).not.toContain("fp-private");
  });
});
