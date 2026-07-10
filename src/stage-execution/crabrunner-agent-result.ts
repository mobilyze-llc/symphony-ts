import {
  type RunAttemptPhase,
  createEmptyLiveSession,
  parseHumanBlockSignal,
} from "../domain/model.js";
import {
  coerceLegacyCounterValue,
  mapCrabrunnerUsageToStageUsage,
} from "../domain/stage-usage.js";
import type { HardStopDecision } from "../policy/hard-stops.js";
import type {
  StageExecutionAgentRunResult,
  StageExecutionBackendInput,
} from "./backend.js";
import {
  type CollectedArtifact,
  artifactRefsFromCollectedArtifact,
} from "./collected-artifact.js";
import type { CrabrunnerTerminalEvidence } from "./crabrunner-backend.js";
export type CrabrunnerAgentResult = StageExecutionAgentRunResult;

export function createCrabrunnerAgentResult(input: {
  input: StageExecutionBackendInput;
  status: RunAttemptPhase;
  terminal: CrabrunnerTerminalEvidence | null;
  laneJobId: string | null;
  error?: string;
  now: () => Date;
}): CrabrunnerAgentResult {
  const terminal = input.terminal;
  const agentMessage = resolveCrabrunnerAgentMessage(terminal);
  const humanBlockSignal =
    input.status === "succeeded" && agentMessage !== null
      ? parseHumanBlockSignal(agentMessage)
      : null;
  const artifactRefs =
    terminal?.artifactRefs ??
    artifactRefsFromCollectedArtifact(terminal?.artifact);
  const usageMeasurement = mapCrabrunnerUsageToStageUsage({
    usage: terminal?.usage,
    runnerKind: input.input.job.runner.runnerKind,
    provider: input.input.job.runner.provider,
    model: input.input.job.runner.model,
    profile: input.input.job.identity.profileId,
  });
  const legacyInputTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.inputTokens,
  );
  const legacyOutputTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.outputTokens,
  );
  const legacyTotalTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.totalTokens,
  );
  const legacyCacheReadTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.cacheReadTokens,
  );
  const legacyCacheWriteTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.cacheWriteTokens,
  );
  const legacyNoCacheTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.noCacheTokens,
  );
  const legacyReasoningTokens = coerceLegacyCounterValue(
    usageMeasurement.tokens.reasoningTokens,
  );
  const hardStop: HardStopDecision | null =
    humanBlockSignal === null
      ? null
      : {
          outcome: "BLOCKED-needs-human",
          trigger: "worker_reported_block",
          reason: `Worker reported BLOCKED-needs-human at a delegated lane permission boundary (${humanBlockSignal.operation}).`,
          turnCount: 1,
          totalTokens: legacyTotalTokens,
          billableTokens: legacyTotalTokens,
          estimatedCostUsd: 0,
          humanBlockOperation: humanBlockSignal.operation,
          humanBlockBlockers: humanBlockSignal.blockers,
        };
  return {
    issue: input.input.runnerInput.issue,
    workspace: {
      path: terminal?.workspacePath ?? input.input.job.identity.artifactRoot,
      workspaceKey: input.input.runnerInput.issue.id,
      createdNow: false,
    },
    runAttempt: {
      issueId: input.input.runnerInput.issue.id,
      issueIdentifier: input.input.runnerInput.issue.identifier,
      attempt: input.input.runnerInput.attempt,
      workspacePath:
        terminal?.workspacePath ?? input.input.job.identity.artifactRoot,
      startedAt: input.now().toISOString(),
      status: input.status,
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    liveSession: {
      ...createEmptyLiveSession(),
      lastCodexEvent: "crabrunner_terminal",
      lastCodexTimestamp: input.now().toISOString(),
      lastCodexMessage:
        terminal === null
          ? (input.error ?? null)
          : JSON.stringify({
              terminalState: terminal.state,
              terminalMessage: terminal.message ?? null,
              usageStatus: terminal.usage?.status ?? "unknown",
              artifactRefs,
              progress: terminal.progress ?? null,
              process: terminal.process ?? null,
              cancellation: terminal.cancellation ?? null,
            }),
      codexInputTokens: legacyInputTokens,
      codexOutputTokens: legacyOutputTokens,
      codexTotalTokens: legacyTotalTokens,
      codexCacheReadTokens: legacyCacheReadTokens,
      codexCacheWriteTokens: legacyCacheWriteTokens,
      codexNoCacheTokens: legacyNoCacheTokens,
      codexReasoningTokens: legacyReasoningTokens,
      codexTotalInputTokens: legacyInputTokens,
      codexTotalOutputTokens: legacyOutputTokens,
      totalStageInputTokens: legacyInputTokens,
      totalStageOutputTokens: legacyOutputTokens,
      totalStageTotalTokens: legacyTotalTokens,
      totalStageCacheReadTokens: legacyCacheReadTokens,
      totalStageCacheWriteTokens: legacyCacheWriteTokens,
      usageMeasurement,
      codexSessionLogs: artifactRefs.map((path, index) => ({
        label: `crabrunner-artifact-${index + 1}`,
        path,
        url: null,
      })),
    },
    turnsCompleted: 0,
    lastTurn:
      agentMessage === null
        ? null
        : {
            status: input.status === "succeeded" ? "completed" : "failed",
            threadId: "",
            turnId: "",
            sessionId: "",
            usage: null,
            rateLimits: null,
            message: agentMessage,
          },
    rateLimits: null,
    ...(hardStop === null ? {} : { hardStop }),
    metadata: {
      ...(agentMessage === null ? {} : { agentMessage }),
      ...(input.laneJobId === null ? {} : { laneJobId: input.laneJobId }),
    },
  };
}

function resolveCrabrunnerAgentMessage(
  terminal: CrabrunnerTerminalEvidence | null,
): string | null {
  if (terminal === null) {
    return null;
  }
  const progressSignals = progressSignalMessages(terminal.artifact);
  const finalMessage =
    terminal.artifact?.status === "ready"
      ? terminal.artifact.primary.content.trim()
      : "";
  // Keep progress before the final artifact so the existing signal parsers
  // retain their current precedence: parseHumanBlockSignal walks the complete
  // message and the last matching marker wins. This also preserves a terminal
  // marker emitted before a provider continued to its final message.
  const messages = [
    ...progressSignals,
    ...(finalMessage === "" ? [] : [finalMessage]),
  ];
  return messages.length === 0 ? null : messages.join("\n");
}

function progressSignalMessages(
  artifact: CollectedArtifact | undefined,
): string[] {
  if (artifact === undefined) {
    return [];
  }
  return artifact.entries.flatMap((entry) => {
    if (!entry.name.endsWith(".progress.jsonl") || !("content" in entry)) {
      return [];
    }
    return entry.content.split("\n").flatMap((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return signalFragment(line);
      }
      if (!isRecord(parsed)) {
        return signalFragment(line);
      }
      return [parsed.detail, parsed.message, parsed.text, parsed.content]
        .filter((value): value is string => typeof value === "string")
        .flatMap(signalFragment);
    });
  });
}

function signalFragment(value: string): string[] {
  return value.split("\n").flatMap((line) => {
    const fragment = line.trim();
    const stageFailedPrefix = "[STAGE_FAILED:";
    const stageFailedClose = fragment.indexOf("]");
    const stageFailed =
      fragment.startsWith(stageFailedPrefix) &&
      stageFailedClose > stageFailedPrefix.length &&
      (stageFailedClose === fragment.length - 1 ||
        fragment[stageFailedClose + 1] === " " ||
        fragment[stageFailedClose + 1] === "\t");
    if (fragment === "BLOCKED-needs-human") {
      return [fragment];
    }
    if (
      fragment === "[STAGE_COMPLETE]" ||
      fragment.startsWith("[STAGE_COMPLETE] ") ||
      fragment.startsWith("[STAGE_COMPLETE]\t") ||
      stageFailed ||
      (fragment.startsWith("[BLOCKED_NEEDS_HUMAN:") &&
        fragment.endsWith("]")) ||
      (fragment.startsWith("[BLOCKED_NEEDS_HUMAN_BLOCKERS:") &&
        fragment.endsWith("]"))
    ) {
      return [fragment];
    }
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
