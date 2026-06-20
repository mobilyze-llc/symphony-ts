import { createHash } from "node:crypto";

import type { StageDefinition } from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { StageExecutionJobSpec } from "./backend.js";

export interface CreateStageExecutionJobSpecInput {
  issue: Issue;
  attempt: number | null;
  stage: StageDefinition | null;
  stageName: string | null;
  defaultRunnerKind: string;
  defaultRunnerModel: string | null;
  defaultRunnerProvider?: string | null;
  baseRef: string;
  artifactRoot: string;
}

export function createStageExecutionJobSpec(
  input: CreateStageExecutionJobSpecInput,
): StageExecutionJobSpec {
  const execution = input.stage?.execution ?? null;
  const backend = execution?.backend ?? "current-runner";
  const runnerKind = input.stage?.runner ?? input.defaultRunnerKind;
  const runnerModel = input.stage?.model ?? input.defaultRunnerModel;
  const runnerProvider = resolveStageRunnerProvider({
    runnerKind,
    defaultRunnerKind: input.defaultRunnerKind,
    stageRunner: input.stage?.runner ?? null,
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
  const runner = {
    runnerKind,
    model: runnerModel,
    provider: runnerProvider,
    reasoningEffort:
      execution?.reasoningEffort ?? input.stage?.reasoningEffort ?? null,
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
        runner,
      }),
    },
    runner,
  };
}

function resolveStageRunnerProvider(input: {
  runnerKind: string;
  defaultRunnerKind: string;
  stageRunner: string | null;
  executionProvider: string | null;
  defaultRunnerProvider: string | null;
}): string | null {
  const stageOverridesRunner =
    input.stageRunner !== null && input.stageRunner !== input.defaultRunnerKind;
  const providerSelector =
    input.executionProvider ??
    (stageOverridesRunner ? null : input.defaultRunnerProvider);
  return providerSelector ?? input.runnerKind;
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
