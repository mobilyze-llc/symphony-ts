import { createHash } from "node:crypto";

import type {
  StageDefinition,
  StageExecutionProfile,
  WorkflowHardStopsConfig,
} from "../config/types.js";
import type { Issue, ReasoningEffort } from "../domain/model.js";
import { resolveStageRunnerProviderSelector } from "../runners/provider-selection.js";
import type {
  StageExecutionEnforcementContract,
  StageExecutionJobSpec,
} from "./backend.js";

const DELEGATED_LANE_HEARTBEAT_INTERVAL_MS = 30_000;
const DELEGATED_LANE_PROGRESS_INTERVAL_MS = 30_000;
const DELEGATED_LANE_USAGE_INTERVAL_MS = 30_000;
const DELEGATED_LANE_KILL_GRACE_MS = 5_000;

export interface CreateStageExecutionJobSpecInput {
  issue: Issue;
  attempt: number | null;
  stage: StageDefinition | null;
  stageName: string | null;
  execution?: StageExecutionProfile | null;
  runnerKind?: string | null;
  runnerModel?: string | null;
  runnerReasoningEffort?: ReasoningEffort | null;
  stageTimeoutMs?: number | null;
  defaultRunnerKind: string;
  defaultRunnerModel: string | null;
  defaultRunnerProvider?: string | null;
  effectiveHardStops?: WorkflowHardStopsConfig | null;
  defaultTurnTimeoutMs?: number | null;
  defaultStallTimeoutMs?: number | null;
  baseRef: string;
  artifactRoot: string;
}

export function createStageExecutionJobSpec(
  input: CreateStageExecutionJobSpecInput,
): StageExecutionJobSpec {
  const execution =
    input.execution === undefined
      ? (input.stage?.execution ?? null)
      : input.execution;
  const backend = execution?.backend ?? "current-runner";
  const stageRunner = input.runnerKind ?? input.stage?.runner ?? null;
  const runnerKind = stageRunner ?? input.defaultRunnerKind;
  const runnerModel =
    input.runnerModel === undefined
      ? (input.stage?.model ?? input.defaultRunnerModel)
      : input.runnerModel;
  const stageReasoningEffort =
    input.runnerReasoningEffort === undefined
      ? (input.stage?.reasoningEffort ?? null)
      : input.runnerReasoningEffort;
  const runnerProvider = resolveStageRunnerProviderSelector({
    runnerKind,
    defaultRunnerKind: input.defaultRunnerKind,
    stageRunner,
    executionProvider: execution?.provider ?? null,
    defaultRunnerProvider: input.defaultRunnerProvider ?? null,
  });
  const stageKey = input.stageName ?? "worker";
  const stageAttempt = input.attempt ?? 0;
  const runGroupId =
    execution?.runGroup?.id ??
    execution?.runGroup?.key ??
    `${input.issue.id}:${stageKey}`;
  const profileId = execution?.profile ?? null;
  const targetHeadRef = input.issue.branchName ?? null;
  const enforcement = createStageExecutionEnforcementContract({
    backend,
    execution,
    stage: input.stage,
    effectiveHardStops: input.effectiveHardStops ?? null,
    defaultTurnTimeoutMs: input.defaultTurnTimeoutMs ?? null,
    defaultStallTimeoutMs: input.defaultStallTimeoutMs ?? null,
    stageTimeoutMs:
      input.stageTimeoutMs === undefined
        ? (input.stage?.timeoutMs ?? null)
        : input.stageTimeoutMs,
  });
  const runner = {
    runnerKind,
    model: runnerModel,
    provider: runnerProvider,
    reasoningEffort: execution?.reasoningEffort ?? stageReasoningEffort,
  };

  return {
    backend,
    role: execution?.role ?? null,
    phase: execution?.phase ?? null,
    identity: {
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      stageName: input.stageName,
      stageAttempt,
      runGroupId,
      profileId,
      baseRef: input.baseRef,
      targetHeadRef,
      artifactRoot: input.artifactRoot,
      idempotencyKey: createStageExecutionIdempotencyKey({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        stageKey,
        stageAttempt,
        backend,
        runGroupId,
        profileId,
        baseRef: input.baseRef,
        targetHeadRef,
        enforcement,
        runner,
      }),
    },
    runner,
    enforcement,
  };
}

function createStageExecutionEnforcementContract(input: {
  backend: string;
  execution: StageExecutionProfile | null;
  stage: StageDefinition | null;
  effectiveHardStops: WorkflowHardStopsConfig | null;
  defaultTurnTimeoutMs: number | null;
  defaultStallTimeoutMs: number | null;
  stageTimeoutMs: number | null;
}): StageExecutionEnforcementContract {
  const required = input.backend === "crabrunner";
  const hardStops = input.effectiveHardStops;
  return {
    required,
    budget: {
      maxTokens:
        input.execution?.budget.maxTokens ??
        hardStops?.maxTokensPerUnit ??
        null,
      maxUsd:
        input.execution?.budget.maxUsd ?? hardStops?.maxDollarBudgetUsd ?? null,
      estimatedCostPer1kTokensUsd:
        hardStops?.estimatedCostPer1kTokensUsd ?? null,
      cachedTokenCostRatio: hardStops?.cachedTokenCostRatio ?? null,
      liveBudgetGraceRatio: hardStops?.liveBudgetGraceRatio ?? null,
    },
    timing: {
      timeoutMs:
        input.execution?.timeoutMs ??
        input.stageTimeoutMs ??
        input.defaultTurnTimeoutMs,
      stallTimeoutMs: input.defaultStallTimeoutMs,
      noProgressTurns: hardStops?.noProgressTurns ?? null,
      maxIterations: hardStops?.maxIterations ?? null,
    },
    telemetry: {
      heartbeatIntervalMs: required
        ? DELEGATED_LANE_HEARTBEAT_INTERVAL_MS
        : null,
      progressIntervalMs: required ? DELEGATED_LANE_PROGRESS_INTERVAL_MS : null,
      usageIntervalMs: required ? DELEGATED_LANE_USAGE_INTERVAL_MS : null,
    },
    cancellation: {
      jobIdRequired: required,
      cooperativeAbort: required,
      processGroupKill: required,
      killGraceMs: required ? DELEGATED_LANE_KILL_GRACE_MS : null,
    },
  };
}

export function createStageExecutionIdempotencyKey(input: {
  issueId: string;
  issueIdentifier: string;
  stageKey: string;
  stageAttempt: number;
  backend: string;
  runGroupId: string;
  profileId: string | null;
  baseRef: string | null;
  targetHeadRef: string | null;
  enforcement: StageExecutionEnforcementContract | null;
  runner: {
    runnerKind: string;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
  };
}): string {
  if (input.backend === "current-runner") {
    return [
      input.issueId,
      input.stageKey,
      String(input.stageAttempt),
      input.backend,
      input.runGroupId,
      input.targetHeadRef ?? "no-target-head",
    ].join(":");
  }

  const payload = {
    schema: "symphony.stage-execution.identity.v1",
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    stageKey: input.stageKey,
    stageAttempt: input.stageAttempt,
    backend: input.backend,
    runGroupId: input.runGroupId,
    profileId: input.profileId,
    baseRef: input.baseRef,
    targetHeadRef: input.targetHeadRef,
    enforcement: input.enforcement ?? null,
    runner: input.runner,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 20);
  return [
    "stage-execution",
    safeKeySegment(input.issueIdentifier),
    safeKeySegment(input.stageKey),
    String(input.stageAttempt),
    safeKeySegment(input.backend),
    digest,
  ].join(":");
}

function safeKeySegment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unknown";
  let segment = "";
  let lastWasDash = false;
  for (const char of trimmed) {
    if (isSafeKeySegmentChar(char)) {
      segment += char;
      lastWasDash = char === "-";
      continue;
    }
    if (!lastWasDash) {
      segment += "-";
      lastWasDash = true;
    }
  }
  const bounded = trimDashes(segment).slice(0, 64);
  return trimDashes(bounded) || "unknown";
}

function isSafeKeySegmentChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "." ||
    char === "_" ||
    char === "-"
  );
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start++;
  while (end > start && value[end - 1] === "-") end--;
  return value.slice(start, end);
}
