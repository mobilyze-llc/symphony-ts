import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_STALL_TIMEOUT_MS,
} from "../config/defaults.js";
import type {
  StageExecutionPhase,
  StageExecutionRole,
} from "../config/types.js";
import type { CollectedArtifact } from "../stage-execution/collected-artifact.js";
import {
  CRABRUNNER_JOB_SPEC_VERSION,
  type CrabrunnerJobSpec,
  type CrabrunnerSchedulerClient,
  type CrabrunnerTerminalEvidence,
  type CrabrunnerTerminalState,
  validateCrabrunnerLaneEnforcementContract,
} from "../stage-execution/crabrunner-backend.js";
import {
  CrabrunnerCliSchedulerClient,
  type CrabrunnerCliSchedulerClientOptions,
} from "../stage-execution/crabrunner-scheduler-client.js";
import {
  type ClaudeRunnerAttempt,
  type ClaudeRunnerBoundedText,
  type ClaudeRunnerCommandDiagnostics,
  type ClaudeRunnerDiagnostics,
  type ClaudeRunnerInput,
  type ClaudeRunnerResult,
  type ClaudeRunnerSourceVisibility,
  type ClaudeRunnerStatus,
  MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT,
  isSafeClaudeArtifactName,
  validateClaudeArtifact,
} from "./claude-runner-contract.js";
import { isInside, realpathOrSelf } from "./path-utils.js";

/**
 * Adapter-facing crabrunner boundary for Claude one-shot lanes.
 *
 * `input.workspace` is the authoritative target repo checkout for both source
 * visibility preflight and delegated execution. When production
 * `schedulerOptions` are used, `schedulerOptions.targetRepoRoot` must resolve to
 * the same canonical path or the adapter rejects before scheduler submission.
 * Crabrunner execution is intentionally one-shot here: CMUX
 * `retryOnInvalid` repair semantics are not supported, and validation failures
 * return `invalid_artifact`.
 *
 * This consumes the Crucible execution schemas documented in
 * `docs/crabrunner-execution-contract.md`: `crucible.crabrunner.scheduler.*`,
 * `crucible.crabrunner.host-capacity.v1`,
 * `crucible.crabrunner.workspace-sync-artifact.v1`,
 * `crucible.lane-worker.usage.v2`, and the terminal status/failure fields
 * surfaced through `CrabrunnerSchedulerClient`. It intentionally does not read
 * `crucible.session-orchestrator.supervisor-*` or `operator-supervisor`
 * ergonomics.
 */

const DEFAULT_MODEL = "opus";
const DEFAULT_RUNNER_KIND = "claude";
const DEFAULT_RUNNER_PROVIDER = "anthropic";
const DEFAULT_PROFILE = "read-only";
const DEFAULT_TIMEOUT_SECONDS = 1_800;
const DEFAULT_DIAGNOSTIC_BYTE_LIMIT = 16 * 1024;
const DEFAULT_CRABRUNNER_BIN_LABEL = "crabrunner";
const DELEGATED_LANE_HEARTBEAT_INTERVAL_MS = 30_000;
const DELEGATED_LANE_PROGRESS_INTERVAL_MS = 30_000;
const DELEGATED_LANE_USAGE_INTERVAL_MS = 30_000;
const DELEGATED_LANE_KILL_GRACE_MS = 5_000;

export interface ClaudeCrabrunnerIssueIdentity {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
}

export interface ClaudeCrabrunnerRunnerInput extends ClaudeRunnerInput {
  runnerKind?: string;
  runnerProvider?: string | null;
  reasoningEffort?: string | null;
  baseRef?: string | null;
  targetHeadRef?: string | null;
  issue?: Partial<ClaudeCrabrunnerIssueIdentity>;
  crabrunnerBin?: string;
  retryOnInvalid?: never;
}

export interface ClaudeCrabrunnerDependencies {
  schedulerClient?: CrabrunnerSchedulerClient;
  schedulerOptions?: CrabrunnerCliSchedulerClientOptions;
  now?: () => Date;
}

export function createClaudeCrabrunnerSchedulerClient(
  options: CrabrunnerCliSchedulerClientOptions,
): CrabrunnerSchedulerClient {
  return new CrabrunnerCliSchedulerClient(options);
}

export function resolveClaudeCrabrunnerSchedulerOptions(
  input: {
    env?: NodeJS.ProcessEnv;
    targetRepoRoot?: string;
    cwd?: string;
  } = {},
): CrabrunnerCliSchedulerClientOptions {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const crucibleRoot = firstNonEmpty(env.SYMPHONY_CRABRUNNER_ROOT);
  if (crucibleRoot === null) {
    throw new Error(
      "SYMPHONY_CRABRUNNER_ROOT is required to run Claude through crabrunner",
    );
  }
  const targetRepoRoot =
    firstNonEmpty(
      input.targetRepoRoot,
      env.SYMPHONY_CRABRUNNER_TARGET_REPO,
      localRepoUrlPath(env.REPO_URL),
      cwd,
    ) ?? cwd;
  return {
    crucibleRoot,
    targetRepoRoot,
    ...(env.SYMPHONY_CRABRUNNER_HOST === undefined ||
    env.SYMPHONY_CRABRUNNER_HOST.trim() === ""
      ? {}
      : { host: env.SYMPHONY_CRABRUNNER_HOST.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_STATE_ROOT === undefined ||
    env.SYMPHONY_CRABRUNNER_STATE_ROOT.trim() === ""
      ? {}
      : { stateRoot: env.SYMPHONY_CRABRUNNER_STATE_ROOT.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_REMOTE_USER === undefined ||
    env.SYMPHONY_CRABRUNNER_REMOTE_USER.trim() === ""
      ? {}
      : { remoteUser: env.SYMPHONY_CRABRUNNER_REMOTE_USER.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_REMOTE_PORT === undefined ||
    env.SYMPHONY_CRABRUNNER_REMOTE_PORT.trim() === ""
      ? {}
      : { remotePort: env.SYMPHONY_CRABRUNNER_REMOTE_PORT.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT === undefined ||
    env.SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT.trim() === ""
      ? {}
      : { remoteWorkRoot: env.SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT === undefined ||
    env.SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT.trim() === ""
      ? {}
      : { remoteStateRoot: env.SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR === undefined ||
    env.SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR.trim() === ""
      ? {}
      : {
          remoteRunArtifactDir:
            env.SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR.trim(),
        }),
    ...(env.SYMPHONY_CRABRUNNER_CRABBOX_BIN === undefined ||
    env.SYMPHONY_CRABRUNNER_CRABBOX_BIN.trim() === ""
      ? {}
      : { crabboxBin: env.SYMPHONY_CRABRUNNER_CRABBOX_BIN.trim() }),
    ...(env.SYMPHONY_CRABRUNNER_VERSION === undefined ||
    env.SYMPHONY_CRABRUNNER_VERSION.trim() === ""
      ? {}
      : { crabrunnerVersion: env.SYMPHONY_CRABRUNNER_VERSION.trim() }),
  };
}

export async function runClaudeCrabrunner(
  input: ClaudeCrabrunnerRunnerInput,
  dependencies: ClaudeCrabrunnerDependencies = {},
): Promise<ClaudeRunnerResult> {
  if (!isSafeClaudeArtifactName(input.artifactName)) {
    throw new Error(
      "artifactName must be a basename containing only letters, numbers, dots, underscores, and hyphens",
    );
  }
  const diagnosticByteLimit =
    input.diagnosticByteLimit ?? DEFAULT_DIAGNOSTIC_BYTE_LIMIT;
  if (!Number.isInteger(diagnosticByteLimit) || diagnosticByteLimit <= 0) {
    throw new Error("diagnosticByteLimit must be a positive integer");
  }
  if (diagnosticByteLimit > MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT) {
    throw new Error(
      `diagnosticByteLimit must be <= ${MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT}`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(input, "retryOnInvalid")) {
    throw new Error(
      "runClaudeCrabrunner does not support retryOnInvalid; crabrunner lanes are one-shot and return invalid_artifact for validation failures",
    );
  }

  const now = dependencies.now ?? (() => new Date());
  const workspace = resolve(input.workspace);
  await assertSchedulerTargetRepoRootMatchesWorkspace({
    workspace,
    ...(dependencies.schedulerOptions === undefined
      ? {}
      : { schedulerOptions: dependencies.schedulerOptions }),
  });
  const scheduler = resolveSchedulerClient(dependencies);
  const promptFile = resolve(input.promptFile);
  const artifactDir = resolve(input.artifactDir);
  const artifactName = input.artifactName;
  const model = input.model ?? DEFAULT_MODEL;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const phaseLabel = input.phase ?? input.purpose;
  const laneId = input.laneId ?? `claude-${input.purpose}`;
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const resultJsonPath = resolve(artifactDir, `${artifactName}.result.json`);
  const startedAt = now().toISOString();
  const attempts: ClaudeRunnerAttempt[] = [];
  const attemptDiagnostics: ClaudeRunnerCommandDiagnostics[] = [];

  await mkdir(artifactDir, { recursive: true });
  const sourceVisibility = await inspectSourceVisibility({
    workspace,
    promptFile,
    sourcePaths: input.sourcePaths ?? [],
  });
  const promptSha256 = await fileSha256(promptFile);

  if (sourceVisibility.status !== "ok") {
    const result = buildResult({
      input,
      status: "failed",
      model,
      profile,
      workspace,
      promptFile,
      promptSha256,
      artifactDir,
      artifactName,
      artifactPath: null,
      resultJsonPath,
      runnerBin: input.crabrunnerBin ?? DEFAULT_CRABRUNNER_BIN_LABEL,
      laneId,
      phase: phaseLabel,
      startedAt,
      completedAt: now().toISOString(),
      sourceVisibility,
      attempts,
      validationErrors: ["one or more declared source paths are unreadable"],
      diagnostics: {
        diagnosticByteLimit,
        preflight: null,
        attempts: [],
      },
      usage: null,
      message: "source visibility validation failed before Claude invocation",
    });
    await writeJsonFile(resultJsonPath, result);
    return result;
  }

  let admissionJobId: string | null = null;
  let artifactPath: string | null = null;
  let remoteArtifactPath: string | null = null;
  let finalStatus: ClaudeRunnerStatus = "failed";
  let validationErrors: string[] = [];
  let usage: Record<string, unknown> | null = null;
  let message = "";

  try {
    const spec = buildCrabrunnerJobSpec({
      input,
      workspace,
      promptFile,
      artifactDir,
      model,
      profile,
      laneId,
      timeoutSeconds,
      promptSha256,
    });
    const enforcementFailure = validateCrabrunnerLaneEnforcementContract(spec);
    if (enforcementFailure !== null) {
      throw new Error(
        enforcementFailure.message ?? "invalid crabrunner enforcement contract",
      );
    }
    const admission = await scheduler.submit(spec);
    if (admission.status !== "accepted" || admission.jobId === null) {
      message = `crabrunner admission rejected: ${admission.reason ?? "rejected"}`;
      validationErrors = [message];
      const attemptPath = await writeAttemptJson({
        artifactDir,
        artifactName,
        payload: { admission },
      });
      attempts.push({
        attempt: 1,
        artifactName,
        artifactPath: resolve(artifactDir, `${artifactName}.md`),
        cliJsonPath: attemptPath,
        statusPath: attemptPath,
        state: "rejected",
        exitCode: 1,
        validationErrors,
      });
      attemptDiagnostics.push(
        diagnosticsFromPayload({ admission }, diagnosticByteLimit),
      );
    } else {
      admissionJobId = admission.jobId;
      await scheduler.status(admission.jobId);
      const terminal = await scheduler.collect(admission.jobId);
      const attemptPath = await writeAttemptJson({
        artifactDir,
        artifactName,
        payload: { admission, terminal },
      });
      const artifact = await persistCollectedArtifact({
        artifactDir,
        artifactName,
        artifact: terminal.artifact,
      });
      artifactPath = artifact.artifactPath;
      remoteArtifactPath = artifact.remoteArtifactPath;
      usage = normalizeUsage(terminal.usage);
      message =
        terminal.message ??
        (terminal.state === "succeeded"
          ? "crabrunner lane completed"
          : `crabrunner lane ended ${terminal.state}`);
      validationErrors = artifact.validationErrors;
      if (terminal.state === "succeeded" && artifactPath !== null) {
        validationErrors = await validateClaudeArtifact(
          artifact.content ?? "",
          input.validation,
        );
      } else if (terminal.state === "succeeded") {
        validationErrors = [
          "crabrunner terminal evidence did not include a readable Markdown/text artifact",
        ];
      } else {
        validationErrors = [`crabrunner lane ended ${terminal.state}`];
      }
      finalStatus = mapTerminalStateToRunnerStatus(
        terminal.state,
        validationErrors,
      );
      attempts.push({
        attempt: 1,
        artifactName,
        artifactPath:
          artifactPath ?? resolve(artifactDir, `${artifactName}.md`),
        remoteArtifactPath,
        cliJsonPath: attemptPath,
        statusPath: attemptPath,
        state: terminal.state,
        exitCode: terminal.state === "succeeded" ? 0 : 1,
        validationErrors,
      });
      attemptDiagnostics.push(
        diagnosticsFromPayload({ admission, terminal }, diagnosticByteLimit),
      );
    }
  } catch (error) {
    const formatted = formatUnknownError(error);
    message = `crabrunner scheduler failed: ${formatted}`;
    validationErrors = [message];
    const attemptPath = await writeAttemptJson({
      artifactDir,
      artifactName,
      payload: { jobId: admissionJobId, error: formatted },
    });
    attempts.push({
      attempt: 1,
      artifactName,
      artifactPath: resolve(artifactDir, `${artifactName}.md`),
      cliJsonPath: attemptPath,
      statusPath: attemptPath,
      state: "failed",
      exitCode: 1,
      validationErrors,
    });
    attemptDiagnostics.push(
      diagnosticsFromPayload(
        { jobId: admissionJobId, error: formatted },
        diagnosticByteLimit,
      ),
    );
  }

  const result = buildResult({
    input,
    status: finalStatus,
    model,
    profile,
    workspace,
    promptFile,
    promptSha256,
    artifactDir,
    artifactName,
    artifactPath,
    remoteArtifactPath,
    resultJsonPath,
    runnerBin: input.crabrunnerBin ?? DEFAULT_CRABRUNNER_BIN_LABEL,
    laneId,
    phase: phaseLabel,
    startedAt,
    completedAt: now().toISOString(),
    sourceVisibility,
    attempts,
    validationErrors,
    diagnostics: {
      diagnosticByteLimit,
      preflight: null,
      attempts: attemptDiagnostics,
    },
    usage,
    message,
  });
  await writeJsonFile(resultJsonPath, result);
  return result;
}

function resolveSchedulerClient(
  dependencies: ClaudeCrabrunnerDependencies,
): CrabrunnerSchedulerClient {
  if (dependencies.schedulerClient !== undefined) {
    return dependencies.schedulerClient;
  }
  if (dependencies.schedulerOptions !== undefined) {
    return createClaudeCrabrunnerSchedulerClient(dependencies.schedulerOptions);
  }
  throw new Error(
    "runClaudeCrabrunner requires schedulerClient or schedulerOptions",
  );
}

async function assertSchedulerTargetRepoRootMatchesWorkspace(input: {
  workspace: string;
  schedulerOptions?: CrabrunnerCliSchedulerClientOptions;
}): Promise<void> {
  if (input.schedulerOptions === undefined) {
    return;
  }
  const workspace = await realpathOrSelf(resolve(input.workspace));
  const targetRepoRoot = await realpathOrSelf(
    resolve(input.schedulerOptions.targetRepoRoot),
  );
  if (targetRepoRoot !== workspace) {
    throw new Error(
      `runClaudeCrabrunner requires schedulerOptions.targetRepoRoot to match input.workspace; workspace=${workspace} targetRepoRoot=${targetRepoRoot}`,
    );
  }
}

function buildCrabrunnerJobSpec(input: {
  input: ClaudeCrabrunnerRunnerInput;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  model: string;
  profile: string;
  laneId: string;
  timeoutSeconds: number;
  promptSha256: string | null;
}): CrabrunnerJobSpec {
  const issue = normalizeIssueIdentity(input.input);
  const { role, phase } = resolveCrabrunnerRolePhase(
    input.input,
    input.profile,
  );
  const provider = resolveRunnerProvider(input.input, input.model);
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "symphony.claude-crabrunner.identity.v1",
        issue,
        workspace: input.workspace,
        promptFile: input.promptFile,
        promptSha256: input.promptSha256,
        artifactName: input.input.artifactName,
        laneId: input.laneId,
        phase,
        model: input.model,
        provider,
        profile: input.profile,
      }),
    )
    .digest("hex");

  return {
    schema: CRABRUNNER_JOB_SPEC_VERSION,
    backend: "crabrunner",
    mode: "submit",
    identity: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      stageName: input.laneId,
      stageAttempt: 0,
      runGroupId: `claude-crabrunner:${input.laneId}`,
      profileId: input.profile,
      baseRef: input.input.baseRef ?? null,
      targetHeadRef: input.input.targetHeadRef ?? null,
      artifactRoot: input.artifactDir,
      idempotencyKey,
    },
    runner: {
      runnerKind: input.input.runnerKind ?? DEFAULT_RUNNER_KIND,
      model: input.model,
      provider,
      reasoningEffort: input.input.reasoningEffort ?? null,
    },
    enforcement: {
      required: true,
      budget: {
        maxTokens: DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
        maxUsd: DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
        estimatedCostPer1kTokensUsd:
          DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
        cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
        liveBudgetGraceRatio: DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
      },
      timing: {
        timeoutMs: input.timeoutSeconds * 1_000,
        stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
        noProgressTurns: DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
        maxIterations: DEFAULT_HARD_STOP_MAX_ITERATIONS,
      },
      telemetry: {
        heartbeatIntervalMs: DELEGATED_LANE_HEARTBEAT_INTERVAL_MS,
        progressIntervalMs: DELEGATED_LANE_PROGRESS_INTERVAL_MS,
        usageIntervalMs: DELEGATED_LANE_USAGE_INTERVAL_MS,
      },
      cancellation: {
        jobIdRequired: true,
        cooperativeAbort: true,
        processGroupKill: true,
        killGraceMs: DELEGATED_LANE_KILL_GRACE_MS,
      },
    },
    role,
    phase,
    issue,
    promptFile: input.promptFile,
  };
}

function normalizeIssueIdentity(
  input: ClaudeCrabrunnerRunnerInput,
): ClaudeCrabrunnerIssueIdentity {
  const identifier = input.issue?.identifier ?? `CLAUDE-${input.purpose}`;
  return {
    id: input.issue?.id ?? identifier,
    identifier,
    title: input.issue?.title ?? `Claude ${input.purpose} lane`,
    url: input.issue?.url ?? null,
  };
}

function resolveCrabrunnerRolePhase(
  input: ClaudeCrabrunnerRunnerInput,
  profile: string,
): { role: StageExecutionRole; phase: StageExecutionPhase } {
  if (profile === "write") {
    return { role: "implementer", phase: "implement" };
  }
  const raw = input.phase ?? input.purpose;
  switch (raw) {
    case "research":
      return { role: "investigator", phase: "investigate" };
    case "development-agent":
      return { role: "reviewer", phase: "review" };
    default:
      return { role: "reviewer", phase: "review" };
  }
}

function resolveRunnerProvider(
  input: ClaudeCrabrunnerRunnerInput,
  model: string,
): string | null {
  if (input.runnerProvider !== undefined) {
    return input.runnerProvider;
  }
  return model.includes("/") ? null : DEFAULT_RUNNER_PROVIDER;
}

function mapTerminalStateToRunnerStatus(
  state: CrabrunnerTerminalState,
  validationErrors: readonly string[],
): ClaudeRunnerStatus {
  if (state === "timed_out") {
    return "timed_out";
  }
  if (state !== "succeeded") {
    return "failed";
  }
  return validationErrors.length === 0 ? "passed" : "invalid_artifact";
}

async function persistCollectedArtifact(input: {
  artifactDir: string;
  artifactName: string;
  artifact: CollectedArtifact | undefined;
}): Promise<{
  artifactPath: string | null;
  remoteArtifactPath: string | null;
  content: string | null;
  validationErrors: string[];
}> {
  if (input.artifact?.status === "ready") {
    const localPath = resolve(input.artifactDir, `${input.artifactName}.md`);
    await writeFile(localPath, input.artifact.primary.content, "utf8");
    return {
      artifactPath: localPath,
      remoteArtifactPath: input.artifact.primary.name,
      content: input.artifact.primary.content,
      validationErrors: [],
    };
  }
  const reason =
    input.artifact === undefined
      ? "crabrunner terminal evidence did not include a materialized artifact"
      : `crabrunner materialized artifact ${input.artifact.status}: ${input.artifact.reason}`;
  return {
    artifactPath: null,
    remoteArtifactPath: null,
    content: null,
    validationErrors: [reason],
  };
}

async function inspectSourceVisibility(input: {
  workspace: string;
  promptFile: string;
  sourcePaths: readonly string[];
}): Promise<ClaudeRunnerSourceVisibility> {
  const workspacePath = resolve(input.workspace);
  const canonicalWorkspace = await realpathOrSelf(workspacePath);
  const promptSource = await inspectPromptFile(
    input.promptFile,
    canonicalWorkspace,
  );
  const declaredSources = await Promise.all(
    input.sourcePaths.map(async (sourcePath) => {
      const resolvedPath = resolve(workspacePath, sourcePath);
      const canonicalPath = await realpathOrSelf(resolvedPath);
      const insideWorkspace = isInside(canonicalWorkspace, canonicalPath);
      if (!insideWorkspace) {
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: null,
          bytes: null,
          readable: false,
          insideWorkspace,
          error: "source path is outside workspace",
        };
      }
      try {
        const stats = await stat(resolvedPath);
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: await fileSha256(resolvedPath),
          bytes: stats.size,
          readable: true,
          insideWorkspace,
          error: null,
        };
      } catch (error) {
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: null,
          bytes: null,
          readable: false,
          insideWorkspace,
          error: formatUnknownError(error),
        };
      }
    }),
  );
  const sources = [promptSource, ...declaredSources];
  return {
    status:
      promptSource.readable &&
      declaredSources.every(
        (source) => source.readable && source.insideWorkspace,
      )
        ? "ok"
        : "invalid_source_path",
    workspace: input.workspace,
    sources,
  };
}

async function inspectPromptFile(
  promptFile: string,
  canonicalWorkspace: string,
): Promise<ClaudeRunnerSourceVisibility["sources"][number]> {
  const resolvedPath = resolve(promptFile);
  const canonicalPath = await realpathOrSelf(resolvedPath);
  const insideWorkspace = isInside(canonicalWorkspace, canonicalPath);
  try {
    const stats = await stat(resolvedPath);
    return {
      kind: "prompt",
      path: promptFile,
      resolvedPath: canonicalPath,
      sha256: await fileSha256(resolvedPath),
      bytes: stats.size,
      readable: true,
      insideWorkspace,
      error: null,
    };
  } catch (error) {
    return {
      kind: "prompt",
      path: promptFile,
      resolvedPath: canonicalPath,
      sha256: null,
      bytes: null,
      readable: false,
      insideWorkspace,
      error: formatUnknownError(error),
    };
  }
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

function normalizeUsage(
  usage: CrabrunnerTerminalEvidence["usage"] | undefined,
): Record<string, unknown> | null {
  if (usage === undefined || usage === null) {
    return null;
  }
  return { ...usage };
}

async function writeAttemptJson(input: {
  artifactDir: string;
  artifactName: string;
  payload: unknown;
}): Promise<string> {
  const path = resolve(
    input.artifactDir,
    `${input.artifactName}.crabrunner.json`,
  );
  await writeJsonFile(path, input.payload);
  return path;
}

function diagnosticsFromPayload(
  payload: unknown,
  maxBytes: number,
): ClaudeRunnerCommandDiagnostics {
  const stdout = `${JSON.stringify(payload, null, 2)}\n`;
  return {
    stdout: boundedText(stdout, maxBytes),
    stderr: boundedText("", maxBytes),
  };
}

function buildResult(input: {
  input: ClaudeCrabrunnerRunnerInput;
  status: ClaudeRunnerStatus;
  model: string;
  profile: string;
  workspace: string;
  promptFile: string;
  promptSha256: string | null;
  artifactDir: string;
  artifactName: string;
  artifactPath: string | null;
  remoteArtifactPath?: string | null;
  resultJsonPath: string;
  runnerBin: string;
  laneId: string;
  phase: string;
  startedAt: string;
  completedAt: string;
  sourceVisibility: ClaudeRunnerSourceVisibility;
  attempts: ClaudeRunnerAttempt[];
  validationErrors: string[];
  diagnostics: ClaudeRunnerDiagnostics;
  usage: Record<string, unknown> | null;
  message: string;
}): ClaudeRunnerResult {
  return {
    schemaVersion: 2,
    status: input.status,
    purpose: input.input.purpose,
    model: input.model,
    profile: input.profile,
    workspace: input.workspace,
    promptFile: input.promptFile,
    promptSha256: input.promptSha256,
    artifactDir: input.artifactDir,
    artifactName: input.artifactName,
    artifactPath: input.artifactPath,
    remoteArtifactPath: input.remoteArtifactPath ?? null,
    resultJsonPath: input.resultJsonPath,
    runnerBin: input.runnerBin,
    laneId: input.laneId,
    phase: input.phase,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    sourceVisibility: input.sourceVisibility,
    attempts: input.attempts,
    validationErrors: input.validationErrors,
    diagnostics: input.diagnostics,
    usage: input.usage,
    message: input.message,
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function boundedText(text: string, maxBytes: number): ClaudeRunnerBoundedText {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return {
      text,
      originalBytes: bytes.length,
      omittedBytes: 0,
      truncated: false,
      maxBytes,
    };
  }
  const truncated = truncateUtf8ByBytes(text, maxBytes);
  return {
    text: truncated.text,
    originalBytes: bytes.length,
    omittedBytes: bytes.length - truncated.bytes,
    truncated: true,
    maxBytes,
  };
}

function truncateUtf8ByBytes(
  text: string,
  maxBytes: number,
): { text: string; bytes: number } {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return { text: text.slice(0, end), bytes };
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return null;
}

function localRepoUrlPath(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === "") {
    return undefined;
  }
  if (/^(?:https?:\/\/|ssh:\/\/)/iu.test(candidate)) {
    return undefined;
  }
  if (/^(?:[^/@\s]+@)?[^/\\\s]+:[^/\\]/u.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
