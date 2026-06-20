import { describe, expect, it } from "vitest";

import type {
  CodexClientEvent,
  CodexUsage,
} from "../../src/codex/app-server-client.js";
import {
  containsStageCompleteSignal,
  createEmptyLiveSession,
  parseFailureSignal,
  parseHumanBlockSignal,
} from "../../src/domain/model.js";
import { mapCodexAppServerUsageToStageUsage } from "../../src/domain/stage-usage.js";
import { applyCodexEventToSession } from "../../src/logging/session-metrics.js";
import { resolveRunnerProviderCapability } from "../../src/runners/provider-capabilities.js";

describe("provider control-semantics parity", () => {
  it("selects Codex app-server as the only provider with current front-half control semantics", () => {
    const appServer = resolveRunnerProviderCapability({
      backend: "current-runner",
      runnerKind: "codex",
      provider: "openai",
    });
    const cli = resolveRunnerProviderCapability({
      backend: "current-runner",
      runnerKind: "codex",
      provider: "codex-cli",
    });

    expect(appServer?.id).toBe("codex-app-server");
    expect(appServer?.current.fullControlSemantics).toBe(true);
    expect(appServer?.current.budgetTelemetry).toBe("current");
    expect(appServer?.current.stallReset).toBe("current");
    expect(appServer?.current.stageSignalParsing).toBe("current");
    expect(cli?.id).toBe("codex-cli");
    expect(cli?.current.fullControlSemantics).toBe(false);
    expect(cli?.current.budgetTelemetry).toBe("not-supported");
    expect(cli?.current.stallReset).toBe("not-supported");
  });

  it("keeps live usage telemetry available before terminal turn completion", () => {
    const session = createEmptyLiveSession();
    applyCodexEventToSession(session, sessionStartedEvent());

    const liveUpdate = applyCodexEventToSession(
      session,
      notificationUsageEvent({
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 40,
        stageUsage: mapCodexAppServerUsageToStageUsage({
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            cacheReadTokens: 40,
          },
          model: "gpt-5.3-codex",
        }),
      }),
    );

    expect(liveUpdate.totalTokensDelta).toBe(150);
    expect(liveUpdate.cacheReadTokensDelta).toBe(40);
    expect(session.totalStageTotalTokens).toBe(150);
    expect(session.totalStageCacheReadTokens).toBe(40);
    expect(session.usageMeasurement).toMatchObject({
      source: "codex_app_server",
      runnerKind: "codex",
      measurementQuality: "true",
      tokens: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 40,
      },
    });
  });

  it("parses the stage signals consumed after provider execution", () => {
    expect(containsStageCompleteSignal("done\n[STAGE_COMPLETE]")).toBe(true);
    expect(parseFailureSignal("Tests failed\n[STAGE_FAILED: verify]")).toEqual({
      failureClass: "verify",
    });
    expect(
      parseHumanBlockSignal(
        "Needs approval\n[BLOCKED_NEEDS_HUMAN: auto_merge]",
      ),
    ).toEqual({
      operation: "auto_merge",
      blockers: null,
    });
  });

  it("matches the golden usage/event fixture fields consumed by StageRecord", () => {
    const preFacade = createEmptyLiveSession();
    const selectedProvider = createEmptyLiveSession();
    const events = [
      sessionStartedEvent(),
      notificationUsageEvent({
        inputTokens: 24,
        outputTokens: 6,
        totalTokens: 30,
        stageUsage: mapCodexAppServerUsageToStageUsage({
          usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
          model: "gpt-5.3-codex",
        }),
      }),
      turnCompletedEvent({
        inputTokens: 36,
        outputTokens: 9,
        totalTokens: 45,
        stageUsage: mapCodexAppServerUsageToStageUsage({
          usage: { inputTokens: 36, outputTokens: 9, totalTokens: 45 },
          model: "gpt-5.3-codex",
        }),
      }),
    ];

    for (const event of events) {
      applyCodexEventToSession(preFacade, event);
      applyCodexEventToSession(selectedProvider, event);
    }

    const stageRecordFields = {
      totalTokens: selectedProvider.totalStageTotalTokens,
      inputTokens: selectedProvider.totalStageInputTokens,
      outputTokens: selectedProvider.totalStageOutputTokens,
      turns: selectedProvider.turnCount,
      lastCodexEvent: selectedProvider.lastCodexEvent,
      usageMeasurement: selectedProvider.usageMeasurement,
    };

    expect(stageRecordFields).toEqual({
      totalTokens: preFacade.totalStageTotalTokens,
      inputTokens: preFacade.totalStageInputTokens,
      outputTokens: preFacade.totalStageOutputTokens,
      turns: preFacade.turnCount,
      lastCodexEvent: preFacade.lastCodexEvent,
      usageMeasurement: preFacade.usageMeasurement,
    });
    expect(stageRecordFields).toMatchObject({
      totalTokens: 45,
      inputTokens: 36,
      outputTokens: 9,
      turns: 1,
      lastCodexEvent: "turn_completed",
      usageMeasurement: {
        source: "codex_app_server",
        model: "gpt-5.3-codex",
      },
    });
  });
});

function sessionStartedEvent(): CodexClientEvent {
  return {
    event: "session_started",
    timestamp: "2026-06-20T12:00:00.000Z",
    codexAppServerPid: "1234",
    sessionId: "thread-1-turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
  };
}

function notificationUsageEvent(usage: CodexUsage): CodexClientEvent {
  return {
    event: "notification",
    timestamp: "2026-06-20T12:00:01.000Z",
    codexAppServerPid: "1234",
    sessionId: "thread-1-turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    message: "live usage update",
    usage,
  };
}

function turnCompletedEvent(usage: CodexUsage): CodexClientEvent {
  return {
    event: "turn_completed",
    timestamp: "2026-06-20T12:00:02.000Z",
    codexAppServerPid: "1234",
    sessionId: "thread-1-turn-1",
    threadId: "thread-1",
    turnId: "turn-1",
    message: "done\n[STAGE_COMPLETE]",
    usage,
  };
}
