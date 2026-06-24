import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentRunInput } from "../agent/runner.js";
import type {
  PreReviewVerifyCategory,
  PreReviewVerifyCommands,
  StageDefinition,
  WorkflowPreReviewVerifyConfig,
} from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type { StageExecutionBackendRunner } from "../stage-execution/backend.js";
import type { CrabrunnerStageExecutionEvidence } from "../stage-execution/crabrunner-backend.js";
import {
  type CreateStageExecutionJobSpecInput,
  createStageExecutionJobSpec,
} from "../stage-execution/job-spec.js";
import type { CommandResult, CommandRunner } from "./headless-council-gate.js";

const execFileAsync = promisify(execFile);
const VERIFY_COMMAND_TIMEOUT_MS = 600_000;
const REPAIR_LANE_TIMEOUT_MS = 1_800_000;
const VERIFY_CATEGORIES: readonly PreReviewVerifyCategory[] = [
  "typecheck",
  "lint",
  "build",
  "unit",
  "smoke",
];

export interface PreReviewVerifyGateMetrics {
  gateCaughtCount: number;
  fixAttempts: number;
  fixedPreCouncil: boolean;
  councilRoundsAvoided: number;
  tokensSavedEstimate: number;
}

export interface PreReviewVerifyCommandResult {
  category: PreReviewVerifyCategory;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PreReviewVerifyGateStatus = "green" | "red" | "degraded";

export interface PreReviewVerifyGateOutcome {
  status: PreReviewVerifyGateStatus;
  headSha: string;
  attempts: number;
  commandResults: PreReviewVerifyCommandResult[];
  failingResults: PreReviewVerifyCommandResult[];
  metrics: PreReviewVerifyGateMetrics;
  degradedReason: string | null;
}

export interface RunPreReviewVerifyGateInput {
  config: WorkflowPreReviewVerifyConfig;
  issue: Issue;
  attempt: number | null;
  stage: StageDefinition | null;
  workspaceRoot: string;
  artifactRoot: string;
  baseRef: string;
  runGroupId: string;
  headSha: string;
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  signal: AbortSignal;
  defaultRunnerKind: string;
  defaultRunnerModel: string | null;
  defaultRunnerProvider?: string | null;
  hardStops: CreateStageExecutionJobSpecInput["effectiveHardStops"];
  defaultTurnTimeoutMs: number | null;
  defaultStallTimeoutMs: number | null;
  runCommand?: CommandRunner;
}

export class PreReviewVerifyGateError extends Error {
  readonly outcome: PreReviewVerifyGateOutcome;

  constructor(message: string, outcome: PreReviewVerifyGateOutcome) {
    super(message);
    this.name = "PreReviewVerifyGateError";
    this.outcome = outcome;
  }
}

export async function runPreReviewVerifyGate(
  input: RunPreReviewVerifyGateInput,
): Promise<PreReviewVerifyGateOutcome> {
  const commandRunner = input.runCommand ?? execFileCommand;
  const commands = resolveVerifyCommands(input.config.commands);
  if (commands.length === 0) {
    const outcome = buildOutcome({
      status: "degraded",
      headSha: input.headSha,
      attempts: 0,
      commandResults: [],
      degradedReason: "pre_review_verify_commands_missing",
    });
    throw new PreReviewVerifyGateError(
      "pre-review verify gate failed closed: no verify commands configured",
      outcome,
    );
  }

  let commandResults = await runVerifyCommands({
    commands,
    workspaceRoot: input.workspaceRoot,
    env: process.env,
    signal: input.signal,
    runCommand: commandRunner,
  });
  let failingResults = commandResults.filter((result) => result.exitCode !== 0);
  if (failingResults.length === 0) {
    return buildOutcome({
      status: "green",
      headSha: input.headSha,
      attempts: 0,
      commandResults,
      degradedReason: null,
    });
  }

  for (let attempt = 1; attempt <= input.config.maxFixAttempts; attempt += 1) {
    await dispatchRepairLane({
      ...input,
      failingResults,
      repairAttempt: attempt,
    });
    commandResults = await runVerifyCommands({
      commands,
      workspaceRoot: input.workspaceRoot,
      env: process.env,
      signal: input.signal,
      runCommand: commandRunner,
    });
    failingResults = commandResults.filter((result) => result.exitCode !== 0);
    if (failingResults.length === 0) {
      return buildOutcome({
        status: "green",
        headSha: input.headSha,
        attempts: attempt,
        commandResults,
        degradedReason: null,
      });
    }
  }

  const outcome = buildOutcome({
    status: "red",
    headSha: input.headSha,
    attempts: input.config.maxFixAttempts,
    commandResults,
    degradedReason: "pre_review_verify_red_after_fix_loop",
  });
  throw new PreReviewVerifyGateError(
    `pre-review verify gate failed closed: ${formatFailingCategories(
      failingResults,
    )}`,
    outcome,
  );
}

function resolveVerifyCommands(
  commands: PreReviewVerifyCommands,
): { category: PreReviewVerifyCategory; command: string }[] {
  const resolved: { category: PreReviewVerifyCategory; command: string }[] = [];
  for (const category of VERIFY_CATEGORIES) {
    const command = commands[category]?.trim();
    if (command !== undefined && command !== null && command !== "") {
      resolved.push({ category, command });
    }
  }
  return resolved;
}

async function runVerifyCommands(input: {
  commands: readonly { category: PreReviewVerifyCategory; command: string }[];
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runCommand: CommandRunner;
}): Promise<PreReviewVerifyCommandResult[]> {
  const results: PreReviewVerifyCommandResult[] = [];
  for (const command of input.commands) {
    let result: CommandResult;
    try {
      result = await input.runCommand("sh", ["-lc", command.command], {
        cwd: input.workspaceRoot,
        env: input.env,
        timeoutMs: VERIFY_COMMAND_TIMEOUT_MS,
        signal: input.signal,
      });
    } catch (error) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    results.push({ ...command, ...result });
  }
  return results;
}

async function dispatchRepairLane(
  input: RunPreReviewVerifyGateInput & {
    failingResults: readonly PreReviewVerifyCommandResult[];
    repairAttempt: number;
  },
): Promise<void> {
  const stage = repairStage(input);
  const stageName = `review/pre-review-repair-${input.repairAttempt}`;
  const job = createStageExecutionJobSpec({
    issue: input.issue,
    attempt: input.attempt,
    stage,
    stageName,
    defaultRunnerKind: input.defaultRunnerKind,
    defaultRunnerModel: input.defaultRunnerModel,
    defaultRunnerProvider: input.defaultRunnerProvider ?? null,
    effectiveHardStops: input.hardStops ?? null,
    defaultTurnTimeoutMs: input.defaultTurnTimeoutMs,
    defaultStallTimeoutMs: input.defaultStallTimeoutMs,
    baseRef: input.baseRef,
    artifactRoot: input.artifactRoot,
  });
  await input.backend.execute({
    job,
    runnerInput: repairRunnerInput({
      ...input,
      stage,
      stageName,
    }),
  });
}

function repairStage(input: {
  issue: Issue;
  runGroupId: string;
  failingResults: readonly PreReviewVerifyCommandResult[];
}): StageDefinition {
  return {
    type: "agent",
    runner: "codex",
    model: null,
    reasoningEffort: "low",
    prompt: buildRepairPrompt(input),
    maxTurns: 4,
    timeoutMs: REPAIR_LANE_TIMEOUT_MS,
    concurrency: null,
    gateType: null,
    maxRework: null,
    reviewers: [],
    transitions: {
      onComplete: null,
      onApprove: null,
      onRework: null,
    },
    linearState: input.issue.state,
    execution: {
      role: "implementer",
      phase: "verify",
      backend: "crabrunner",
      controlNeeding: false,
      provider: "openai",
      model: null,
      reasoningEffort: "low",
      profile: "pre-review.verify-repair",
      artifacts: { requires: [], produces: [] },
      timeoutMs: REPAIR_LANE_TIMEOUT_MS,
      budget: { maxTokens: null, maxUsd: null },
      dependencies: { stages: [], capsules: [], missingCapsule: "fail" },
      runGroup: { id: input.runGroupId, key: null },
      capsules: { consume: [], produce: [] },
      subStages: [],
    },
  };
}

function repairRunnerInput(input: {
  issue: Issue;
  attempt: number | null;
  signal: AbortSignal;
  stage: StageDefinition;
  stageName: string;
}): AgentRunInput {
  return {
    issue: input.issue,
    attempt: input.attempt,
    signal: input.signal,
    stage: input.stage,
    stageName: input.stageName,
    reasoningEffort: "low",
  };
}

function buildRepairPrompt(input: {
  failingResults: readonly PreReviewVerifyCommandResult[];
}): string {
  return [
    "You are the pre-review repair lane.",
    "Fix only the deterministic verification failures below. Keep the patch scoped, then stop.",
    "",
    ...input.failingResults.map(formatCommandFailure),
  ].join("\n");
}

function formatCommandFailure(result: PreReviewVerifyCommandResult): string {
  return [
    `## ${result.category}: ${result.command}`,
    `exit_code: ${result.exitCode}`,
    "stdout:",
    truncate(result.stdout),
    "stderr:",
    truncate(result.stderr),
    "",
  ].join("\n");
}

function buildOutcome(input: {
  status: PreReviewVerifyGateStatus;
  headSha: string;
  attempts: number;
  commandResults: readonly PreReviewVerifyCommandResult[];
  degradedReason: string | null;
}): PreReviewVerifyGateOutcome {
  const failingResults = input.commandResults.filter(
    (result) => result.exitCode !== 0,
  );
  const red = input.status !== "green";
  return {
    status: input.status,
    headSha: input.headSha,
    attempts: input.attempts,
    commandResults: [...input.commandResults],
    failingResults,
    degradedReason: input.degradedReason,
    metrics: {
      gateCaughtCount: red || input.attempts > 0 ? 1 : 0,
      fixAttempts: input.attempts,
      fixedPreCouncil: input.status === "green" && input.attempts > 0,
      councilRoundsAvoided: red ? 1 : 0,
      tokensSavedEstimate: red ? 2 : 0,
    },
  };
}

function formatFailingCategories(
  failingResults: readonly PreReviewVerifyCommandResult[],
): string {
  if (failingResults.length === 0) {
    return "unknown verify failure";
  }
  return failingResults
    .map((result) => `${result.category} exited ${result.exitCode}`)
    .join(", ");
}

function truncate(value: string): string {
  return value.length <= 12_000
    ? value
    : `${value.slice(0, 12_000)}\n[truncated]`;
}

async function execFileCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      signal: options.signal,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const record = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    return {
      exitCode: typeof record.code === "number" ? record.code : 1,
      stdout:
        typeof record.stdout === "string"
          ? record.stdout
          : record.stdout === undefined
            ? ""
            : String(record.stdout),
      stderr:
        typeof record.stderr === "string"
          ? record.stderr
          : record.stderr === undefined
            ? typeof record.message === "string"
              ? record.message
              : String(error)
            : String(record.stderr),
    };
  }
}
