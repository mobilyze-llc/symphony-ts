import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRunInput } from "../agent/runner.js";
import { SPEC_DEFAULTS } from "../config/defaults.js";
import type {
  StageExecutionProfile,
  WorkflowHardStopsConfig,
  WorkflowPreReviewVerifyConfig,
} from "../config/types.js";
import type { ReasoningEffort } from "../domain/model.js";
import type { StageExecutionJobSpec } from "../stage-execution/backend.js";
import {
  type CreateStageExecutionJobSpecInput,
  createStageExecutionJobSpec,
} from "../stage-execution/job-spec.js";
import type {
  CrabrunnerReviewLaneSpec,
  ReviewJobGroupLaneEvidence,
} from "./crabrunner-review-job-group.js";
import {
  type CrabrunnerReviewStageDispatchContext,
  type CrabrunnerReviewStageDispatcher,
  runCrabrunnerReviewStage,
} from "./crabrunner-review-stage.js";
import {
  type CommandRunner,
  type HeadlessReviewerLaneConfig,
  type ReviewBundleProvenanceEntry,
  buildHeadlessReviewerPrompt,
  headlessReviewerLaneIdentity,
  prepareHeadlessCouncilReviewForDispatch,
  synthesizeStructuredReviewerArtifactRecord,
} from "./headless-council-gate.js";
import {
  type PreReviewVerifyGateOutcome,
  runPreReviewVerifyGate,
} from "./pre-review-verify-gate.js";

const REVIEW_STAGE_NAME = "review";

export interface CreateCrabrunnerReviewStageDispatcherOptions {
  env?: NodeJS.ProcessEnv;
  hardStops?: WorkflowHardStopsConfig;
  defaultRunnerKind: string;
  defaultRunnerModel: string | null;
  defaultRunnerProvider?: string | null;
  defaultTurnTimeoutMs?: number | null;
  defaultStallTimeoutMs?: number | null;
  preReviewVerify?: WorkflowPreReviewVerifyConfig;
  runCommand?: CommandRunner;
}

export function createCrabrunnerReviewStageDispatcher(
  options: CreateCrabrunnerReviewStageDispatcherOptions,
): CrabrunnerReviewStageDispatcher {
  return async (context) => {
    const env = options.env ?? process.env;
    const plan = await prepareHeadlessCouncilReviewForDispatch(
      {
        issueId: context.issueIdentifier,
        workspace: context.workspaceRoot,
        artifactDir: context.artifactRoot,
        headRef: context.issue.branchName ?? "HEAD",
        codexLead: false,
        provenance: authorProvenance(env),
        env,
        ...(context.baseRef === null ? {} : { baseRef: context.baseRef }),
        ...(context.previousReviewedHeadSha === undefined ||
        context.previousReviewedHeadSha === null
          ? {}
          : { previousReviewedHeadSha: context.previousReviewedHeadSha }),
        ...(context.priorStructuredArtifacts === undefined ||
        context.priorStructuredArtifacts.length === 0
          ? {}
          : { priorStructuredArtifacts: context.priorStructuredArtifacts }),
      },
      options.runCommand === undefined
        ? {}
        : { runCommand: options.runCommand },
    );

    if (plan.context.headSha === null || plan.context.headSha.trim() === "") {
      throw new Error(
        "crabrunner review dispatch requires a resolved head SHA",
      );
    }
    if (plan.context.diff.trim() === "") {
      throw new Error("crabrunner review dispatch requires a non-empty diff");
    }

    const runGroupId = reviewRunGroupId(context);
    const preReviewVerify = await maybeRunPreReviewVerifyGate({
      context,
      plan,
      runGroupId,
      options,
    });
    const lanes = plan.reviewerLanes.map(reviewLaneSpec);
    const laneConfigs = new Map(
      plan.reviewerLanes.map((lane) => [lane.laneId, lane] as const),
    );
    const lanePrompts = new Map<string, string>();
    const promptFor = (laneId: string): string => {
      const existing = lanePrompts.get(laneId);
      if (existing !== undefined) {
        return existing;
      }
      const prompt = buildHeadlessReviewerPrompt({
        context: plan.context,
        lane: requireLaneConfig(laneConfigs, laneId),
        reviewBundle: plan.reviewBundle,
        targetedConvergence: plan.targetedConvergence,
        priorStructuredArtifacts: context.priorStructuredArtifacts ?? [],
      });
      lanePrompts.set(laneId, prompt);
      return prompt;
    };

    return await runCrabrunnerReviewStage({
      issueId: context.issueId,
      issueIdentifier: context.issueIdentifier,
      runGroupId,
      currentHeadSha: plan.context.headSha,
      artifactDir: plan.artifactDir,
      pr: {
        repo: plan.context.repo,
        number: plan.context.prNumber,
        baseRef: plan.context.baseRef,
        headRef: plan.context.headRef,
      },
      baseSha: plan.context.baseSha,
      round: plan.round,
      mode: plan.mode,
      routingMode: plan.reviewRouting.mode,
      reviewRouting: plan.reviewRouting,
      reviewBundle: plan.reviewBundle,
      targetedConvergence: plan.targetedConvergence,
      diffPath: plan.diffPath,
      preReviewVerify,
      previousReviewedHeadSha: context.previousReviewedHeadSha ?? null,
      lanes,
      backend: context.backend,
      buildJobSpec: (lane) =>
        buildReviewLaneJobSpec({
          context,
          lane,
          laneConfig: requireLaneConfig(laneConfigs, lane.laneId),
          runGroupId,
          options,
        }),
      buildRunnerInput: (lane) =>
        buildReviewLaneRunnerInput({
          context,
          lane,
          prompt: promptFor(lane.laneId),
        }),
      collectArtifact: (laneEvidence) =>
        collectReviewerArtifact({
          plan,
          laneEvidence,
          laneConfig: requireLaneConfig(laneConfigs, laneEvidence.laneId),
        }),
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      writeFile: async (path, contents) => {
        await writeFile(path, contents, "utf8");
      },
    });
  };
}

async function maybeRunPreReviewVerifyGate(input: {
  context: CrabrunnerReviewStageDispatchContext;
  plan: Awaited<ReturnType<typeof prepareHeadlessCouncilReviewForDispatch>>;
  runGroupId: string;
  options: CreateCrabrunnerReviewStageDispatcherOptions;
}): Promise<PreReviewVerifyGateOutcome | null> {
  const config = input.options.preReviewVerify;
  if (config === undefined || config.enabled !== true) {
    return null;
  }
  return runPreReviewVerifyGate({
    config,
    issue: input.context.issue,
    attempt: input.context.attempt,
    stage: input.context.stage,
    workspaceRoot: input.context.workspaceRoot,
    artifactRoot: input.context.artifactRoot,
    baseRef: input.context.baseRef ?? "origin/main",
    runGroupId: input.runGroupId,
    headSha: input.plan.context.headSha ?? "",
    backend: input.context.backend,
    signal: input.context.signal,
    defaultRunnerKind: input.options.defaultRunnerKind,
    defaultRunnerModel: input.options.defaultRunnerModel,
    defaultRunnerProvider: input.options.defaultRunnerProvider ?? null,
    hardStops: input.options.hardStops ?? SPEC_DEFAULTS.hardStops,
    defaultTurnTimeoutMs: input.options.defaultTurnTimeoutMs ?? null,
    defaultStallTimeoutMs: input.options.defaultStallTimeoutMs ?? null,
    ...(input.options.runCommand === undefined
      ? {}
      : { runCommand: input.options.runCommand }),
  });
}

function reviewLaneSpec(
  lane: HeadlessReviewerLaneConfig,
): CrabrunnerReviewLaneSpec {
  return {
    kind: "reviewer",
    ...headlessReviewerLaneIdentity(lane),
  };
}

function buildReviewLaneJobSpec(input: {
  context: CrabrunnerReviewStageDispatchContext;
  lane: CrabrunnerReviewLaneSpec;
  laneConfig: HeadlessReviewerLaneConfig;
  runGroupId: string;
  options: CreateCrabrunnerReviewStageDispatcherOptions;
}): StageExecutionJobSpec {
  const timeoutMs = reviewLaneTimeoutMs(input);
  const reasoningEffort = reviewLaneReasoningEffort(input.lane);
  return createStageExecutionJobSpec({
    issue: input.context.issue,
    attempt: input.context.attempt,
    stage: input.context.stage,
    stageName: input.lane.laneId,
    execution: reviewLaneExecutionProfile({
      lane: input.lane,
      runGroupId: input.runGroupId,
      timeoutMs,
      reasoningEffort,
      laneConfig: input.laneConfig,
    }),
    runnerKind: runnerKindForLane(input.laneConfig),
    runnerModel: input.lane.model,
    runnerReasoningEffort: reasoningEffort,
    stageTimeoutMs: timeoutMs,
    defaultRunnerKind: input.options.defaultRunnerKind,
    defaultRunnerModel: input.options.defaultRunnerModel,
    defaultRunnerProvider: input.options.defaultRunnerProvider ?? null,
    effectiveHardStops: input.options.hardStops ?? SPEC_DEFAULTS.hardStops,
    defaultTurnTimeoutMs: input.options.defaultTurnTimeoutMs ?? null,
    defaultStallTimeoutMs: input.options.defaultStallTimeoutMs ?? null,
    baseRef: input.context.baseRef ?? "origin/main",
    artifactRoot: input.context.artifactRoot,
  } satisfies CreateStageExecutionJobSpecInput);
}

function buildReviewLaneRunnerInput(input: {
  context: CrabrunnerReviewStageDispatchContext;
  lane: CrabrunnerReviewLaneSpec;
  prompt: string;
}): AgentRunInput {
  const reasoningEffort = reviewLaneReasoningEffort(input.lane);
  return {
    issue: input.context.issue,
    attempt: input.context.attempt,
    signal: input.context.signal,
    stageName: input.lane.laneId,
    promptTemplate: input.prompt,
    reasoningEffort,
  };
}

function reviewLaneTimeoutMs(input: {
  context: CrabrunnerReviewStageDispatchContext;
  laneConfig: HeadlessReviewerLaneConfig;
}): number | null {
  return input.laneConfig.timeoutSeconds === undefined
    ? (input.context.stage?.timeoutMs ?? null)
    : input.laneConfig.timeoutSeconds * 1000;
}

function reviewLaneExecutionProfile(input: {
  lane: CrabrunnerReviewLaneSpec;
  laneConfig: HeadlessReviewerLaneConfig;
  runGroupId: string;
  timeoutMs: number | null;
  reasoningEffort: ReasoningEffort | null;
}): StageExecutionProfile {
  return {
    role: "reviewer",
    phase: "review",
    backend: "crabrunner",
    controlNeeding: false,
    provider: providerForLane(input.laneConfig),
    model: input.lane.model,
    reasoningEffort: input.reasoningEffort,
    profile: `crabrunner-review.${input.lane.laneId}`,
    artifacts: {
      requires: [],
      produces: [`${input.lane.laneId}.structured.json`],
    },
    timeoutMs: input.timeoutMs,
    budget: {
      maxTokens: null,
      maxUsd: null,
    },
    dependencies: {
      stages: [],
      capsules: [],
      missingCapsule: "fail",
    },
    runGroup: {
      id: input.runGroupId,
      key: null,
    },
    capsules: {
      consume: [],
      produce: [],
    },
    subStages: [],
  };
}

async function collectReviewerArtifact(input: {
  plan: Awaited<ReturnType<typeof prepareHeadlessCouncilReviewForDispatch>>;
  laneEvidence: ReviewJobGroupLaneEvidence;
  laneConfig: HeadlessReviewerLaneConfig;
}): Promise<unknown> {
  let firstMarkdownArtifact: { artifactRef: string; artifact: string } | null =
    null;
  for (const artifactRef of input.laneEvidence.artifactRefs) {
    const artifact = await readArtifactRef(artifactRef);
    if (artifact === null) {
      // Unreadable refs are skipped; if no readable reviewer artifact remains,
      // the job-group validator records `malformed_artifact:<laneId>`.
      continue;
    }
    const parsed = parseJsonObject(artifact);
    if (parsed !== null) {
      // JSON refs are intentionally returned to the validator even when they are
      // not reviewer artifacts, so lane-aware anti-spoof diagnostics name the
      // rejected lane instead of hiding the bad ref during collection.
      return withStructuredArtifactPath(parsed, artifactRef);
    }
    firstMarkdownArtifact ??= { artifactRef, artifact };
  }

  if (firstMarkdownArtifact !== null) {
    return await synthesizeStructuredReviewerArtifactRecord({
      context: input.plan.context,
      lane: input.laneConfig,
      artifactPath: firstMarkdownArtifact.artifactRef,
      artifact: firstMarkdownArtifact.artifact,
      structuredArtifactPath: structuredArtifactPath(
        input.plan.artifactDir,
        input.laneEvidence.laneId,
      ),
      reviewBundle: input.plan.reviewBundle,
      mode: input.plan.mode,
      routingMode: input.plan.reviewRouting.mode,
      round: input.plan.round,
    });
  }
  return null;
}

async function readArtifactRef(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(contents) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function withStructuredArtifactPath(
  artifact: Record<string, unknown>,
  artifactRef: string,
): Record<string, unknown> {
  return {
    ...artifact,
    structuredArtifactPath: nonBlankString(artifact.structuredArtifactPath)
      ? artifact.structuredArtifactPath
      : artifactRef,
  };
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function requireLaneConfig(
  laneConfigs: ReadonlyMap<string, HeadlessReviewerLaneConfig>,
  laneId: string,
): HeadlessReviewerLaneConfig {
  const lane = laneConfigs.get(laneId);
  if (lane === undefined) {
    throw new Error(`review lane ${laneId} is missing its lane config`);
  }
  return lane;
}

function reviewRunGroupId(
  context: CrabrunnerReviewStageDispatchContext,
): string {
  return `${context.issueId}:${REVIEW_STAGE_NAME}:${context.attempt ?? 0}`;
}

function structuredArtifactPath(artifactDir: string, laneId: string): string {
  return join(artifactDir, `${laneId}.structured.json`);
}

function runnerKindForLane(lane: HeadlessReviewerLaneConfig): string {
  if (lane.agent === "pi") {
    return "pi";
  }
  return lane.agent;
}

function providerForLane(lane: HeadlessReviewerLaneConfig): string | null {
  if (lane.agent === "pi") {
    return lane.provider ?? "deepseek";
  }
  if (lane.agent === "codex") {
    return "openai";
  }
  return null;
}

export function reviewLaneReasoningEffort(
  lane: CrabrunnerReviewLaneSpec,
): ReasoningEffort | null {
  if (lane.reasoningEffort == null) {
    return null;
  }
  if (
    lane.reasoningEffort === "low" ||
    lane.reasoningEffort === "medium" ||
    lane.reasoningEffort === "high"
  ) {
    return lane.reasoningEffort;
  }
  throw new Error(
    `review lane ${lane.laneId} has unsupported reasoningEffort "${lane.reasoningEffort}"`,
  );
}

function authorProvenance(
  env: NodeJS.ProcessEnv,
): ReviewBundleProvenanceEntry[] {
  return [
    authorFamilyProvenance(env.SYMPHONY_COUNCIL_AUTHOR_FAMILY ?? "codex"),
  ];
}

function authorFamilyProvenance(family: string): ReviewBundleProvenanceEntry {
  const normalized = family.trim();
  if (normalized === "") {
    throw new Error("SYMPHONY_COUNCIL_AUTHOR_FAMILY must be non-empty");
  }
  return {
    role: "implementer",
    agent: null,
    modelFamily: normalized,
    model: null,
    reasoningEffort: null,
    sourceStage: "implement",
    commitRange: null,
  };
}
