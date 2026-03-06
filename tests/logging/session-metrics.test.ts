import { describe, expect, it } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import {
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import {
  addEndedSessionRuntime,
  applyCodexEventToOrchestratorState,
  getAggregateSecondsRunning,
  summarizeCodexEvent,
} from "../../src/logging/session-metrics.js";

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
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toEqual({
      requestsRemaining: 8,
    });
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
