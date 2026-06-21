import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRunInput } from "../agent/runner.js";
import { SPEC_DEFAULTS } from "../config/defaults.js";
import type {
  StageDefinition,
  WorkflowHardStopsConfig,
} from "../config/types.js";
import type { Issue, ReasoningEffort } from "../domain/model.js";
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

const REVIEW_STAGE_NAME = "review";
const REVIEW_LANE_HEARTBEAT_INTERVAL_MS = 30_000;
const REVIEW_LANE_PROGRESS_INTERVAL_MS = 30_000;
const REVIEW_LANE_USAGE_INTERVAL_MS = 30_000;
const REVIEW_LANE_KILL_GRACE_MS = 5_000;

export interface CreateCrabrunnerReviewStageDispatcherOptions {
  env?: NodeJS.ProcessEnv;
  hardStops?: WorkflowHardStopsConfig;
  defaultRunnerKind: string;
  defaultRunnerModel: string | null;
  defaultRunnerProvider?: string | null;
  defaultTurnTimeoutMs?: number | null;
  defaultStallTimeoutMs?: number | null;
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
      lanes,
      backend: context.backend,
      buildJobSpec: (lane) =>
        buildReviewLaneJobSpec({
          context,
          lane,
          laneConfig: requireLaneConfig(laneConfigs, lane.laneId),
          runGroupId,
          prompt: promptFor(lane.laneId),
          options,
        }),
      buildRunnerInput: (lane) =>
        buildReviewLaneRunnerInput({
          context,
          lane,
          laneConfig: requireLaneConfig(laneConfigs, lane.laneId),
          runGroupId,
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
  prompt: string;
  options: CreateCrabrunnerReviewStageDispatcherOptions;
}): StageExecutionJobSpec {
  const stage = reviewLaneStage(input);
  return createStageExecutionJobSpec({
    issue: input.context.issue,
    attempt: input.context.attempt,
    stage,
    stageName: input.lane.laneId,
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
  laneConfig: HeadlessReviewerLaneConfig;
  runGroupId: string;
  prompt: string;
}): AgentRunInput {
  return {
    issue: input.context.issue,
    attempt: input.context.attempt,
    signal: input.context.signal,
    stage: reviewLaneStage(input),
    stageName: input.lane.laneId,
    reasoningEffort: input.lane.reasoningEffort as ReasoningEffort | null,
  };
}

function reviewLaneStage(input: {
  context: CrabrunnerReviewStageDispatchContext;
  lane: CrabrunnerReviewLaneSpec;
  laneConfig: HeadlessReviewerLaneConfig;
  runGroupId: string;
  prompt: string;
}): StageDefinition {
  const timeoutMs =
    input.laneConfig.timeoutSeconds === undefined
      ? (input.context.stage?.timeoutMs ?? null)
      : input.laneConfig.timeoutSeconds * 1000;
  return {
    ...baseReviewStage(input.context.issue, input.context.stage),
    runner: runnerKindForLane(input.laneConfig),
    model: input.lane.model,
    reasoningEffort: input.lane.reasoningEffort as ReasoningEffort | null,
    prompt: input.prompt,
    timeoutMs,
    execution: {
      role: "reviewer",
      phase: "review",
      backend: "crabrunner",
      controlNeeding: false,
      provider: providerForLane(input.laneConfig),
      model: input.lane.model,
      reasoningEffort: input.lane.reasoningEffort as ReasoningEffort | null,
      profile: `crabrunner-review.${input.lane.laneId}`,
      artifacts: {
        requires: [],
        produces: [`${input.lane.laneId}.structured.json`],
      },
      timeoutMs,
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
    },
  };
}

function baseReviewStage(
  issue: Issue,
  stage: StageDefinition | null,
): StageDefinition {
  return (
    stage ?? {
      type: "agent",
      runner: "codex",
      model: null,
      prompt: null,
      maxTurns: null,
      timeoutMs: null,
      concurrency: null,
      gateType: null,
      maxRework: null,
      reviewers: [],
      transitions: {
        onComplete: null,
        onApprove: null,
        onRework: null,
      },
      linearState: issue.state,
      execution: null,
    }
  );
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
      continue;
    }
    const parsed = parseJsonObject(artifact);
    if (parsed !== null) {
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
