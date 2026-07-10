import type { AgentRunResult } from "../agent/runner.js";
import type { StageExecutionResultMetadata } from "./backend.js";

type ResultWithMetadata = AgentRunResult & {
  metadata?: StageExecutionResultMetadata;
};

function readStageExecutionMetadata(
  result: AgentRunResult | null | undefined,
): StageExecutionResultMetadata | null {
  const metadata = (result as ResultWithMetadata | null | undefined)?.metadata;
  return metadata === undefined ? null : metadata;
}

export function readStageExecutionLaneJobId(
  result: AgentRunResult | null | undefined,
): string | null {
  const metadataJobId = readStageExecutionMetadata(result)?.laneJobId;
  return typeof metadataJobId === "string" && metadataJobId.trim() !== ""
    ? metadataJobId
    : null;
}

export function resolveStageExecutionFinalization(
  backend: string,
  result: AgentRunResult,
): { outcome: "normal" | "abnormal"; reason?: string } {
  const abnormal =
    backend === "crabrunner" && result.runAttempt.status !== "succeeded";
  return abnormal
    ? {
        outcome: "abnormal",
        reason:
          result.runAttempt.error ??
          `crabrunner_run_attempt_${result.runAttempt.status}`,
      }
    : { outcome: "normal" };
}

export function readStageExecutionAgentMessage(
  result: AgentRunResult | null | undefined,
): string | undefined {
  const metadataMessage = readStageExecutionMetadata(result)?.agentMessage;
  if (metadataMessage !== undefined && metadataMessage !== "") {
    return metadataMessage;
  }
  const lastTurnMessage = result?.lastTurn?.message;
  if (typeof lastTurnMessage === "string" && lastTurnMessage !== "") {
    return lastTurnMessage;
  }
  const fallbackMessage = result?.liveSession?.lastCodexMessage;
  return typeof fallbackMessage === "string" && fallbackMessage !== ""
    ? fallbackMessage
    : undefined;
}
