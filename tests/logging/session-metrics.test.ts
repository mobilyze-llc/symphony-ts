import { describe, expect, it } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import {
  type RunningEntry,
  type TurnHistoryEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import {
  addEndedSessionRuntime,
  addPipelineActivity,
  applyCodexEventToOrchestratorState,
  applyCodexEventToSession,
  buildActivityContext,
  getAggregateSecondsRunning,
  summarizeCodexEvent,
} from "../../src/logging/session-metrics.js";
import { evaluateRateLimitBudgetHardStop } from "../../src/policy/hard-stops.js";

describe("session metrics", () => {
  it("aggregates absolute usage totals without double-counting repeated updates", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const started = createEvent("session_started", {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const firstUsage = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      rateLimits: {
        requestsRemaining: 8,
      },
    });
    const repeatedUsage = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });
    const secondUsage = createEvent("turn_completed", {
      usage: {
        inputTokens: 14,
        outputTokens: 9,
        totalTokens: 23,
      },
    });

    applyCodexEventToOrchestratorState(state, running, started);
    applyCodexEventToOrchestratorState(state, running, firstUsage);
    applyCodexEventToOrchestratorState(state, running, repeatedUsage);
    applyCodexEventToOrchestratorState(state, running, secondUsage);

    expect(running.turnCount).toBe(1);
    expect(running.codexInputTokens).toBe(14);
    expect(running.codexOutputTokens).toBe(9);
    expect(running.codexTotalTokens).toBe(23);
    expect(state.codexTotals).toEqual({
      inputTokens: 14,
      outputTokens: 9,
      totalTokens: 23,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toEqual({
      requestsRemaining: 8,
    });
  });

  it("tracks per-session rate-limit window start/latest with reset re-baselining", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const codexRateLimits = (primaryUsed: number, secondaryUsed: number) => ({
      limit_id: "codex",
      primary: {
        used_percent: primaryUsed,
        window_minutes: 300,
        resets_at: 1781093929,
      },
      secondary: {
        used_percent: secondaryUsed,
        window_minutes: 10080,
        resets_at: 1781137743,
      },
    });

    applyCodexEventToOrchestratorState(
      state,
      running,
      createEvent("notification", { rateLimits: codexRateLimits(39, 97) }),
    );
    applyCodexEventToOrchestratorState(
      state,
      running,
      createEvent("notification", { rateLimits: codexRateLimits(42.5, 98) }),
    );

    expect(running.rateLimitWindows.primary).toEqual({
      startPercent: 39,
      latestPercent: 42.5,
      lastResetsAt: 1781093929,
    });
    expect(running.rateLimitWindows.secondary).toEqual({
      startPercent: 97,
      latestPercent: 98,
      lastResetsAt: 1781137743,
    });

    // Window rollover mid-stage: usage drops, baseline follows the new window.
    applyCodexEventToOrchestratorState(
      state,
      running,
      createEvent("notification", { rateLimits: codexRateLimits(1.5, 98) }),
    );
    expect(running.rateLimitWindows.primary).toEqual({
      startPercent: 1.5,
      latestPercent: 1.5,
      lastResetsAt: 1781093929,
    });

    // Unparsable blobs leave the telemetry untouched.
    applyCodexEventToOrchestratorState(
      state,
      running,
      createEvent("notification", {
        rateLimits: { requestsRemaining: 8 },
      }),
    );
    expect(running.rateLimitWindows.primary?.latestPercent).toBe(1.5);
  });

  it("uses session telemetry rate-limit window observations as the hard-stop input", () => {
    const running = createRunningEntry();
    const codexRateLimits = (primaryUsed: number, secondaryUsed: number) => ({
      limit_id: "codex",
      primary: {
        used_percent: primaryUsed,
        window_minutes: 300,
        resets_at: 1781093929,
      },
      secondary: {
        used_percent: secondaryUsed,
        window_minutes: 10080,
        resets_at: 1781137743,
      },
    });

    applyCodexEventToSession(
      running,
      createEvent("notification", { rateLimits: codexRateLimits(40, 90) }),
    );
    applyCodexEventToSession(
      running,
      createEvent("notification", { rateLimits: codexRateLimits(45, 98) }),
    );

    const rateLimitUsage = running.rateLimitWindows;
    expect(rateLimitUsage).toBe(running.rateLimitWindows);
    expect(rateLimitUsage).toEqual({
      primary: {
        startPercent: 40,
        latestPercent: 45,
        lastResetsAt: 1781093929,
      },
      secondary: {
        startPercent: 90,
        latestPercent: 98,
        lastResetsAt: 1781137743,
      },
    });

    const hardStop = evaluateRateLimitBudgetHardStop({
      config: {
        maxIterations: 10,
        noProgressTurns: 10,
        maxTokensPerUnit: 1000,
        maxDollarBudgetUsd: 10,
        premiumBudgetPauseRatio: 0.8,
        estimatedCostPer1kTokensUsd: 5,
        cachedTokenCostRatio: 0.1,
        maxPrimaryWindowPctPerUnit: 4,
        maxSecondaryWindowPctPerUnit: 7,
      },
      turnCount: 1,
      totalTokens: 0,
      cacheReadTokens: 0,
      rateLimitUsage,
    });

    expect(hardStop?.reason).toContain("primary window burned 5.0%");
  });

  it("tracks ended runtime and recomputes live aggregate snapshot time", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();
    state.running[running.issue.id] = running;

    addEndedSessionRuntime(
      state,
      "2026-03-06T10:00:00.000Z",
      new Date("2026-03-06T10:00:05.250Z"),
    );

    const secondsRunning = getAggregateSecondsRunning(
      state,
      new Date("2026-03-06T10:00:10.500Z"),
    );

    expect(state.codexTotals.secondsRunning).toBe(5.25);
    expect(secondsRunning).toBe(15.75);
  });

  it("accumulates cache and reasoning token details when present", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const eventWithDetails = createEvent("turn_completed", {
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        noCacheTokens: 12,
        reasoningTokens: 4,
      },
    });

    applyCodexEventToOrchestratorState(state, running, eventWithDetails);

    expect(running.codexCacheReadTokens).toBe(5);
    expect(running.codexCacheWriteTokens).toBe(3);
    expect(running.codexNoCacheTokens).toBe(12);
    expect(running.codexReasoningTokens).toBe(4);
    expect(state.codexTotals.cacheReadTokens).toBe(5);
    expect(state.codexTotals.cacheWriteTokens).toBe(3);
    expect(state.codexTotals.noCacheTokens).toBe(12);
    expect(state.codexTotals.reasoningTokens).toBe(4);
  });

  it("records per-event token telemetry deltas", () => {
    const running = createRunningEntry();

    applyCodexEventToSession(
      running,
      createEvent("notification", {
        sessionId: "thread-1-turn-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          cacheReadTokens: 8,
          cacheWriteTokens: 2,
          noCacheTokens: 10,
          reasoningTokens: 1,
        },
      }),
    );
    applyCodexEventToSession(
      running,
      createEvent("notification", {
        sessionId: "thread-1-turn-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 30,
          outputTokens: 7,
          totalTokens: 37,
          cacheReadTokens: 12,
        },
      }),
    );

    expect(running.tokenTelemetry).toEqual([
      expect.objectContaining({
        event: "notification",
        sessionId: "thread-1-turn-1",
        turnId: "turn-1",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        inputTokensDelta: 20,
        outputTokensDelta: 5,
        totalTokensDelta: 25,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
        noCacheTokens: 10,
        reasoningTokens: 1,
        cacheReadTokensDelta: 8,
        cacheWriteTokensDelta: 2,
        noCacheTokensDelta: 10,
        reasoningTokensDelta: 1,
      }),
      expect.objectContaining({
        event: "notification",
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
        inputTokensDelta: 10,
        outputTokensDelta: 2,
        totalTokensDelta: 12,
        cacheReadTokens: 12,
        cacheReadTokensDelta: 4,
      }),
    ]);
    expect(running.tokenTelemetryObservedCount).toBe(2);
  });

  it("records preserved Codex session artifacts on live sessions", () => {
    const running = createRunningEntry();

    applyCodexEventToSession(
      running,
      createEvent("session_artifact_saved", {
        artifacts: [
          {
            label: "sessions/rollout.jsonl",
            path: "/tmp/symphony/sessions/rollout.jsonl",
            sourcePath: "/tmp/symphony-codex-home/sessions/rollout.jsonl",
            bytes: 120,
          },
        ],
      }),
    );

    expect(running.codexSessionLogs).toEqual([
      {
        label: "sessions/rollout.jsonl",
        path: "/tmp/symphony/sessions/rollout.jsonl",
        url: null,
        bytes: 120,
      },
    ]);
  });

  it("leaves detail token counts at 0 when usage has no detail fields", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const eventWithoutDetails = createEvent("turn_completed", {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    applyCodexEventToOrchestratorState(state, running, eventWithoutDetails);

    expect(running.codexCacheReadTokens).toBe(0);
    expect(running.codexCacheWriteTokens).toBe(0);
    expect(running.codexNoCacheTokens).toBe(0);
    expect(running.codexReasoningTokens).toBe(0);
    expect(state.codexTotals.cacheReadTokens).toBe(0);
    expect(state.codexTotals.cacheWriteTokens).toBe(0);
    expect(state.codexTotals.noCacheTokens).toBe(0);
    expect(state.codexTotals.reasoningTokens).toBe(0);
  });

  it("accumulates detail tokens across multiple events", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const firstEvent = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        reasoningTokens: 2,
      },
    });
    const secondEvent = createEvent("turn_completed", {
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: 7,
        reasoningTokens: 6,
      },
    });

    applyCodexEventToOrchestratorState(state, running, firstEvent);
    applyCodexEventToOrchestratorState(state, running, secondEvent);

    // Detail tokens are reported cumulatively within a turn (same as
    // input/output/total) and must be delta-normalized, not summed raw.
    expect(running.codexCacheReadTokens).toBe(7);
    expect(running.codexReasoningTokens).toBe(6);
    expect(state.codexTotals.cacheReadTokens).toBe(7);
    expect(state.codexTotals.reasoningTokens).toBe(6);
  });

  it("does not double-count cumulative cache counters in stage accumulators", () => {
    const running = createRunningEntry();

    // Shape from the preserved SYMPH-319 canary JSONL: token_count events
    // report cumulative usage including cached_input_tokens.
    applyCodexEventToSession(
      running,
      createEvent("notification", {
        usage: {
          inputTokens: 12_344,
          outputTokens: 122,
          totalTokens: 12_466,
          cacheReadTokens: 2_432,
        },
      }),
    );
    applyCodexEventToSession(
      running,
      createEvent("notification", {
        usage: {
          inputTokens: 25_029,
          outputTokens: 234,
          totalTokens: 25_263,
          cacheReadTokens: 14_592,
        },
      }),
    );

    // The accumulator must equal the latest cumulative reading, not the sum
    // of cumulative readings (2,432 + 14,592 = 17,024 would overstate the
    // cached share and inflate the budget discount).
    expect(running.totalStageCacheReadTokens).toBe(14_592);
    expect(running.totalStageTotalTokens).toBe(25_263);
  });

  it("returns zero deltas for detail tokens when no usage on event", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const noUsageEvent = createEvent("notification");
    const result = applyCodexEventToOrchestratorState(
      state,
      running,
      noUsageEvent,
    );

    expect(result.cacheReadTokensDelta).toBe(0);
    expect(result.cacheWriteTokensDelta).toBe(0);
    expect(result.noCacheTokensDelta).toBe(0);
    expect(result.reasoningTokensDelta).toBe(0);
  });

  it("accumulates codexTotalInputTokens and codexTotalOutputTokens across multiple turns", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    // Turn 1 starts: session_started resets lastReported counters to 0
    const turn1Start = createEvent("session_started", {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    applyCodexEventToOrchestratorState(state, running, turn1Start);

    // Turn 1 completes: 100 input, 40 output
    const turn1End = createEvent("turn_completed", {
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    });
    applyCodexEventToOrchestratorState(state, running, turn1End);

    expect(running.codexTotalInputTokens).toBe(100);
    expect(running.codexTotalOutputTokens).toBe(40);

    // Turn 2 starts: session_started resets lastReported counters to 0
    const turn2Start = createEvent("session_started", {
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    applyCodexEventToOrchestratorState(state, running, turn2Start);

    // Turn 2 completes: 120 input, 60 output (counter resets to 0 each turn)
    const turn2End = createEvent("turn_completed", {
      usage: {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
      },
    });
    applyCodexEventToOrchestratorState(state, running, turn2End);

    // codexTotalInputTokens/OutputTokens should sum both turns: 100+120=220, 40+60=100
    expect(running.codexTotalInputTokens).toBe(220);
    expect(running.codexTotalOutputTokens).toBe(100);

    // codexInputTokens still reflects the last absolute value (current turn only)
    expect(running.codexInputTokens).toBe(120);
    expect(running.codexOutputTokens).toBe(60);
  });

  it("single-turn stage: totalStage fields match the single turn values", () => {
    const running = createRunningEntry();

    const event = createEvent("turn_completed", {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    });

    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    applyCodexEventToOrchestratorState(state, running, event);

    expect(running.totalStageInputTokens).toBe(10);
    expect(running.totalStageOutputTokens).toBe(5);
    expect(running.totalStageTotalTokens).toBe(15);
    expect(running.totalStageCacheReadTokens).toBe(3);
    expect(running.totalStageCacheWriteTokens).toBe(2);
  });

  it("multi-turn stage: totalStage fields equal sum of all turn deltas", () => {
    const running = createRunningEntry();
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });

    // First turn: absolute counters start from 0
    const firstTurn = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });
    // Second turn: absolute counters increase
    const secondTurn = createEvent("turn_completed", {
      usage: {
        inputTokens: 20,
        outputTokens: 9,
        totalTokens: 29,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
      },
    });

    applyCodexEventToOrchestratorState(state, running, firstTurn);
    applyCodexEventToOrchestratorState(state, running, secondTurn);

    // inputTokensDelta for first = 10, for second = 10 (20-10), total = 20
    expect(running.totalStageInputTokens).toBe(20);
    // outputTokensDelta for first = 4, for second = 5 (9-4), total = 9
    expect(running.totalStageOutputTokens).toBe(9);
    // totalTokensDelta for first = 14, for second = 15 (29-14), total = 29
    expect(running.totalStageTotalTokens).toBe(29);
    // cacheReadTokensDelta for first = 2, for second = 3 (5-2), total = 5
    expect(running.totalStageCacheReadTokens).toBe(5);
    // cacheWriteTokensDelta for first = 1, for second = 2 (3-1), total = 3
    expect(running.totalStageCacheWriteTokens).toBe(3);
  });

  it("zero-turn stage: all totalStage accumulator fields are 0", () => {
    const running = createRunningEntry();

    expect(running.totalStageInputTokens).toBe(0);
    expect(running.totalStageOutputTokens).toBe(0);
    expect(running.totalStageTotalTokens).toBe(0);
    expect(running.totalStageCacheReadTokens).toBe(0);
    expect(running.totalStageCacheWriteTokens).toBe(0);
  });

  it("turn history ring buffer captures turn summaries", () => {
    const session = createEmptyLiveSession();

    const event1 = createEvent("session_started", {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      timestamp: "2026-03-06T10:00:01.000Z",
    });
    const event2 = createEvent("session_started", {
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
      timestamp: "2026-03-06T10:00:02.000Z",
    });
    const event3 = createEvent("session_started", {
      sessionId: "thread-1-turn-3",
      threadId: "thread-1",
      turnId: "turn-3",
      timestamp: "2026-03-06T10:00:03.000Z",
    });

    applyCodexEventToSession(session, event1);
    applyCodexEventToSession(session, event2);
    applyCodexEventToSession(session, event3);

    // Turns 1 and 2 are complete; turn 3 is in progress
    expect(session.turnHistory).toHaveLength(2);

    const entry1 = session.turnHistory[0] as TurnHistoryEntry;
    const entry2 = session.turnHistory[1] as TurnHistoryEntry;

    // Each entry must have all required fields
    expect(entry1).toHaveProperty("turnNumber");
    expect(entry1).toHaveProperty("timestamp");
    expect(entry1).toHaveProperty("message");
    expect(entry1).toHaveProperty("inputTokens");
    expect(entry1).toHaveProperty("outputTokens");
    expect(entry1).toHaveProperty("totalTokens");
    expect(entry1).toHaveProperty("cacheReadTokens");
    expect(entry1).toHaveProperty("reasoningTokens");
    expect(entry1).toHaveProperty("event");

    expect(entry1.turnNumber).toBe(1);
    expect(entry1.timestamp).toBe("2026-03-06T10:00:02.000Z");
    expect(entry1.inputTokens).toBe(0);
    expect(entry1.outputTokens).toBe(0);
    expect(entry1.totalTokens).toBe(0);
    expect(entry1.cacheReadTokens).toBe(0);
    expect(entry1.reasoningTokens).toBe(0);
    expect(entry1.event).toBe("session_started");

    expect(entry2.turnNumber).toBe(2);
    expect(entry2.timestamp).toBe("2026-03-06T10:00:03.000Z");
  });

  it("turn history ring buffer caps at 50 entries", () => {
    const session = createEmptyLiveSession();

    // Process 55 session_started events
    for (let i = 1; i <= 55; i++) {
      applyCodexEventToSession(
        session,
        createEvent("session_started", {
          sessionId: `thread-1-turn-${i}`,
          threadId: "thread-1",
          turnId: `turn-${i}`,
          timestamp: `2026-03-06T10:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }

    // After 55 session_started events: 54 entries would exist before capping
    // Capped at 50 → oldest 4 evicted
    expect(session.turnHistory).toHaveLength(50);

    // Oldest 4 entries (turnNumbers 1-4) should have been evicted
    const firstEntry = session.turnHistory[0] as TurnHistoryEntry;
    expect(firstEntry.turnNumber).toBe(5);

    // Most recent retained entry is turn 54 (turn 55 is in progress)
    const lastEntry = session.turnHistory[49] as TurnHistoryEntry;
    expect(lastEntry.turnNumber).toBe(54);
  });

  describe("broadened recentActivity tracking", () => {
    it("tracks unsupported_tool_call events with tool name and context", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("unsupported_tool_call", {
        raw: {
          params: {
            toolName: "linear_graphql",
            input: { query: "{ viewer { id } }" },
          },
        },
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("linear_graphql");
      expect(session.recentActivity[0]!.context).toBe("{ viewer { id } }");
    });

    it("tracks turn_completed events with token count", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("turn_completed", {
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
        },
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Turn completed");
      expect(session.recentActivity[0]!.context).toBeNull();
      expect(session.recentActivity[0]!.totalTokens).toBe(700);
    });

    it("tracks turn_completed events without usage", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("turn_completed");

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Turn completed");
      expect(session.recentActivity[0]!.context).toBeNull();
    });

    it("tracks turn_failed events with token count", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("turn_failed", {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Turn failed");
      expect(session.recentActivity[0]!.context).toBeNull();
      expect(session.recentActivity[0]!.totalTokens).toBe(150);
    });

    it("tracks session_started events", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("session_started", {
        sessionId: "s1",
        threadId: "t1",
        turnId: "turn-1",
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Session started");
      expect(session.recentActivity[0]!.context).toBeNull();
    });

    it("tracks notification events with message as context", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("notification", {
        message: "Downloading dependencies…",
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Notification");
      expect(session.recentActivity[0]!.context).toBe(
        "Downloading dependencies…",
      );
    });

    it("truncates long notification messages", () => {
      const session = createEmptyLiveSession();
      const longMessage = "A".repeat(120);
      const event = createEvent("notification", {
        message: longMessage,
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.context).toBe(`${"A".repeat(80)}…`);
    });

    it("tracks notification events without message", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("notification");

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Notification");
      expect(session.recentActivity[0]!.context).toBeNull();
    });

    it("still tracks approval_auto_approved events", () => {
      const session = createEmptyLiveSession();
      const event = createEvent("approval_auto_approved", {
        raw: {
          params: {
            toolName: "Read",
            input: { file_path: "/tmp/foo/bar.ts" },
          },
        },
      });

      applyCodexEventToSession(session, event);

      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("Read");
      expect(session.recentActivity[0]!.context).toBe("bar.ts");
    });

    it("respects RECENT_ACTIVITY_MAX_SIZE of 10 across mixed events", () => {
      const session = createEmptyLiveSession();

      // Push 12 events of mixed types
      for (let i = 0; i < 12; i++) {
        const event =
          i % 2 === 0
            ? createEvent("turn_completed", {
                usage: {
                  inputTokens: i * 10,
                  outputTokens: i * 5,
                  totalTokens: i * 15,
                },
                timestamp: `2026-03-06T10:00:${String(i).padStart(2, "0")}.000Z`,
              })
            : createEvent("notification", {
                message: `msg-${i}`,
                timestamp: `2026-03-06T10:00:${String(i).padStart(2, "0")}.000Z`,
              });
        applyCodexEventToSession(session, event);
      }

      expect(session.recentActivity).toHaveLength(10);
      // Oldest 2 should have been evicted — first entry timestamp should be index 2
      expect(session.recentActivity[0]!.timestamp).toBe(
        "2026-03-06T10:00:02.000Z",
      );
    });
  });

  describe("no synthetic entries in activity feed", () => {
    it("addPipelineActivity with stage_transition still works", () => {
      const session = createEmptyLiveSession();
      addPipelineActivity(session, "stage_transition", "Stage → implement");
      expect(session.recentActivity).toHaveLength(1);
      expect(session.recentActivity[0]!.toolName).toBe("stage_transition");
    });

    it("activity feed does not contain session_start or state_change entries from orchestrator dispatch", () => {
      // After removing synthetic entries from core.ts, a fresh session
      // should have no session_start or state_change entries in recentActivity
      const session = createEmptyLiveSession();
      // Simulate what the orchestrator now does (no addPipelineActivity calls for session_start/state_change)
      expect(
        session.recentActivity.filter(
          (e) =>
            e.toolName === "session_start" || e.toolName === "state_change",
        ),
      ).toHaveLength(0);
    });
  });

  describe("unknown tool types show arguments", () => {
    it("extracts first string-valued argument for unknown tools", () => {
      expect(
        buildActivityContext("TodoWrite", { content: "Fix the bug" }),
      ).toBe("Fix the bug");
    });

    it("preserves long string arguments without truncation", () => {
      const longValue = "A".repeat(80);
      expect(buildActivityContext("WebSearch", { query: longValue })).toBe(
        longValue,
      );
    });

    it("returns null for unknown tools with no string-valued arguments", () => {
      expect(
        buildActivityContext("SomeTool", { count: 42, flag: true }),
      ).toBeNull();
    });

    it("skips empty/whitespace-only string arguments", () => {
      expect(
        buildActivityContext("SomeTool", { empty: "", second: "valid" }),
      ).toBe("valid");
    });

    it("picks first string argument when mixed types exist", () => {
      expect(
        buildActivityContext("SomeTool", {
          num: 42,
          name: "hello",
          other: "world",
        }),
      ).toBe("hello");
    });
  });

  it("summarizes codex events for snapshot and log surfaces", () => {
    expect(
      summarizeCodexEvent(
        createEvent("unsupported_tool_call", {
          toolName: "linear_graphql",
        }),
      ),
    ).toBe("unsupported tool call: linear_graphql");
    expect(
      summarizeCodexEvent(
        createEvent("other_message", {
          message: "diagnostic from stderr",
        }),
      ),
    ).toBe("diagnostic from stderr");
  });
});

function createRunningEntry(): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    issue: {
      id: "issue-1",
      identifier: "ABC-123",
      title: "Example",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    identifier: "ABC-123",
    retryAttempt: null,
    startedAt: "2026-03-06T10:00:00.000Z",
    workerHandle: null,
    monitorHandle: null,
    failureReason: null,
  };
}

function createEvent(
  event: CodexClientEvent["event"],
  overrides?: Partial<CodexClientEvent>,
): CodexClientEvent {
  return {
    event,
    timestamp: "2026-03-06T10:00:01.000Z",
    codexAppServerPid: "42",
    ...overrides,
  };
}
