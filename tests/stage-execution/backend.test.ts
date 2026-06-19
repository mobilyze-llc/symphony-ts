import { describe, expect, it, vi } from "vitest";

import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.js";
import {
  CurrentRunnerStageExecutionBackend,
  type StageExecutionJobSpec,
} from "../../src/stage-execution/backend.js";

describe("CurrentRunnerStageExecutionBackend", () => {
  it("returns the current runner result as backend data", async () => {
    const result = createResult();
    const runner = {
      run: vi.fn(async () => result),
    };
    const backend = new CurrentRunnerStageExecutionBackend(runner);
    const runnerInput = createRunnerInput();

    await expect(
      backend.execute({
        job: createJob(),
        runnerInput,
      }),
    ).resolves.toEqual({
      job: createJob(),
      result,
    });
    expect(runner.run).toHaveBeenCalledWith(runnerInput);
  });

  it("preserves current runner failures for orchestrator-owned classification", async () => {
    const error = new Error("turn failed");
    const backend = new CurrentRunnerStageExecutionBackend({
      run: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(
      backend.execute({
        job: createJob(),
        runnerInput: createRunnerInput(),
      }),
    ).rejects.toBe(error);
  });
});

function createJob(): StageExecutionJobSpec {
  return {
    backend: "current-runner",
    role: "implementer",
    phase: "implement",
    identity: {
      issueId: "issue-1",
      issueIdentifier: "ISSUE-1",
      stageName: "implement",
      stageAttempt: 0,
      runGroupId: "rg-1",
      profileId: "write.local",
      baseRef: null,
      targetHeadRef: "codex/ISSUE-1",
      artifactRoot: "/tmp/artifacts/issue-1",
      idempotencyKey: "issue-1:implement:0:current-runner:rg-1:codex/ISSUE-1",
    },
    runner: {
      runnerKind: "codex",
      model: null,
      provider: "openai",
      reasoningEffort: null,
    },
  };
}

function createRunnerInput(): AgentRunInput {
  return {
    issue: {
      id: "issue-1",
      identifier: "ISSUE-1",
      title: "Issue 1",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: "codex/ISSUE-1",
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    attempt: null,
    stageName: "implement",
  };
}

function createResult(): AgentRunResult {
  return {
    issue: createRunnerInput().issue,
    workspace: {
      path: "/tmp/workspaces/issue-1",
      workspaceKey: "issue-1",
      createdNow: true,
    },
    runAttempt: {
      issueId: "issue-1",
      issueIdentifier: "ISSUE-1",
      attempt: null,
      workspacePath: "/tmp/workspaces/issue-1",
      startedAt: "2026-06-19T10:00:00-04:00",
      status: "succeeded",
    },
    liveSession: {
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
      turnHistory: [],
      recentActivity: [],
      tokenTelemetry: [],
      tokenTelemetryObservedCount: 0,
      codexSessionLogs: [],
      rateLimitWindows: {
        primary: null,
        secondary: null,
      },
    },
    turnsCompleted: 0,
    lastTurn: null,
    rateLimits: null,
  };
}
