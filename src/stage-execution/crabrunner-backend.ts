import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

import type { AgentRunResult } from "../agent/runner.js";
import {
  type RunAttemptPhase,
  createEmptyLiveSession,
} from "../domain/model.js";
import {
  coerceLegacyCounterValue,
  mapCrabrunnerUsageToStageUsage,
} from "../domain/stage-usage.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
} from "./backend.js";

export const CRABRUNNER_JOB_SPEC_VERSION = "symphony.crabrunner.job.v1";

/**
 * Prefix for the OS-temp directories the factory's default prompt resolver
 * creates (SYMPH-856). `execute()` cleans up only directories under
 * `tmpdir()` whose name carries this prefix, so an explicit `resolvePromptFile`
 * override pointing elsewhere is never deleted. The factory imports this
 * constant so the create-side and clean-side stay in lockstep.
 */
export const CRABRUNNER_TEMP_PROMPT_DIR_PREFIX = "crabrunner-prompt-";

export type CrabrunnerTerminalState =
  | "succeeded"
  | "timed_out"
  | "budget_exceeded"
  | "stalled"
  | "canceled"
  | "kill_failed"
  | "enforcement_contract_missing"
  | "runner_failed"
  | "artifact_parse_failed"
  | "artifact_collection_failed"
  | "usage_unavailable";

export type CrabrunnerUsage =
  | {
      status: "available";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
      reasoningTokens?: number;
    }
  | {
      status: "unavailable" | "unknown";
      reason?: string;
    };

export interface CrabrunnerJobSpec {
  schema: typeof CRABRUNNER_JOB_SPEC_VERSION;
  backend: "crabrunner";
  mode: "submit" | "dry-run";
  identity: StageExecutionBackendInput["job"]["identity"];
  runner: StageExecutionBackendInput["job"]["runner"];
  enforcement: StageExecutionBackendInput["job"]["enforcement"];
  role: StageExecutionBackendInput["job"]["role"];
  phase: StageExecutionBackendInput["job"]["phase"];
  issue: {
    id: string;
    identifier: string;
    title: string;
    url: string | null;
  };
  /**
   * Path to the rendered stage prompt for the lane worker (SYMPH-856). When
   * present, the scheduler client maps it to manifest `prompt_file` and uses the
   * lane-worker.v1 protocol; when absent (and no worker_argv), the client fails
   * closed at submit rather than emitting an unrunnable manifest. The factory's
   * default resolver renders the stage prompt and populates this at dispatch
   * (see `crabrunner-backend-factory.ts`).
   */
  promptFile?: string;
}

export interface CrabrunnerAdmissionResult {
  status: "accepted" | "rejected";
  jobId: string | null;
  reason?: string;
}

export interface CrabrunnerTerminalEvidence {
  state: CrabrunnerTerminalState;
  artifactRefs?: readonly string[];
  workspacePath?: string | null;
  usage?: CrabrunnerUsage | null;
  message?: string | null;
  progress?: {
    heartbeatCount?: number;
    progressEventCount?: number;
    usageEventCount?: number;
    lastHeartbeatAt?: string | null;
    lastProgressAt?: string | null;
    lastUsageAt?: string | null;
  } | null;
  process?: {
    pid?: number | null;
    processGroupId?: number | null;
  } | null;
  cancellation?: {
    requested: boolean;
    signal: string | null;
    processGroup: boolean;
    killed: boolean;
    failure: string | null;
  } | null;
}

export interface CrabrunnerStageExecutionEvidence {
  admission: CrabrunnerAdmissionResult;
  terminal: CrabrunnerTerminalEvidence | null;
  artifactRefs: readonly string[];
  usage: CrabrunnerUsage | null;
}

export interface CrabrunnerSchedulerClient {
  submit(spec: CrabrunnerJobSpec): Promise<CrabrunnerAdmissionResult>;
  /**
   * Resolves only after the job is terminal and collectible. Throw to fail
   * closed before collection. The optional signal lets a polling client abort
   * its loop promptly instead of orphaning a long poll (SYMPH-853, DeepSeek P1-1).
   */
  status(jobId: string, signal?: AbortSignal): Promise<void>;
  collect(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<CrabrunnerTerminalEvidence>;
  cancel?(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence>;
}

export interface CrabrunnerCancellationRequest {
  reason: "abort_signal";
  signal: "SIGTERM";
  processGroup: true;
  killGraceMs: number;
}

export interface CrabrunnerStageExecutionBackendOptions {
  client: CrabrunnerSchedulerClient;
  /**
   * Marks job specs as dry-run. The scheduler client owns dry-run semantics;
   * the backend still exercises submit/status/collect so the contract is testable.
   */
  dryRun?: boolean;
  /**
   * Resolves the rendered stage prompt path for the job (SYMPH-856). Default
   * (undefined) leaves `spec.promptFile` absent, so the scheduler client fails
   * closed at submit rather than emitting an unrunnable manifest. Live dispatch
   * supplies this once it renders the stage prompt.
   *
   * Async because the production resolver (the factory's default) renders the
   * LiquidJS stage prompt and writes it to a temp file. A render failure (e.g. a
   * strictVariables miss, or a present template that renders to empty) must
   * REJECT, not resolve: `execute()` catches the rejection and surfaces it as a
   * failed result rather than emitting an empty prompt.
   *
   * Error-code contract (DeepSeek P2-3): when this throws, `execute()` labels the
   * failure `crabrunner_prompt_render_failed`. The factory's DEFAULT resolver
   * throws ONLY LiquidJS render / template-resolution failures, so that code is
   * accurate for it. A CUSTOM override that can fail for unrelated reasons
   * (network, permission) either surfaces its own classification upstream or
   * accepts this code — the backend does not attempt to distinguish causes.
   */
  resolvePromptFile?: (
    input: StageExecutionBackendInput,
  ) => Promise<string | null | undefined> | string | null | undefined;
  now?: () => Date;
}

export class CrabrunnerStageExecutionBackend
  implements StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>
{
  readonly backend = "crabrunner" as const;

  private readonly client: CrabrunnerSchedulerClient;

  private readonly dryRun: boolean;

  private readonly resolvePromptFile:
    | ((
        input: StageExecutionBackendInput,
      ) => Promise<string | null | undefined> | string | null | undefined)
    | undefined;

  private readonly now: () => Date;

  constructor(options: CrabrunnerStageExecutionBackendOptions) {
    this.client = options.client;
    this.dryRun = options.dryRun ?? false;
    this.resolvePromptFile = options.resolvePromptFile;
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>> {
    // SYMPH-856: resolve (render) the stage prompt before building the job spec.
    // A render failure must FAIL CLOSED with the real error surfaced, never an
    // empty/placeholder prompt — so we return a failed result rather than
    // letting an unrendered job reach submit.
    let promptFile: string | null | undefined;
    try {
      promptFile = (await this.resolvePromptFile?.(input)) ?? undefined;
    } catch (error) {
      return this.toBackendResult(input, {
        admission: {
          status: "rejected",
          jobId: null,
          reason: `crabrunner_prompt_render_failed: ${formatUnknownError(error)}`,
        },
        terminal: null,
        artifactRefs: [],
        usage: null,
        status: "failed",
        error: `crabrunner_prompt_render_failed: ${formatUnknownError(error)}`,
      });
    }
    // P2-2: clean up the temp prompt dir WE own after the job is terminal. The
    // lane worker consumes the file before the job becomes terminal, and this
    // method only returns after collect() (terminal), so cleanup-after-execute
    // is safe for the local-host path. (For future REMOTE hosts, materialization
    // copies the prompt first; cleanup-after-terminal still holds.) An explicit
    // resolvePromptFile override pointing outside the owned prefix is left
    // untouched.
    try {
      const spec = createCrabrunnerJobSpec(input, this.dryRun, promptFile);
      const enforcementFailure =
        validateCrabrunnerLaneEnforcementContract(spec);
      if (enforcementFailure !== null) {
        return this.toBackendResult(input, {
          admission: {
            status: "rejected",
            jobId: null,
            reason:
              enforcementFailure.message ?? "enforcement_contract_missing",
          },
          terminal: enforcementFailure,
          artifactRefs: [],
          usage: null,
          status: "failed",
          error: `crabrunner_${enforcementFailure.state}: ${
            enforcementFailure.message ?? enforcementFailure.state
          }`,
        });
      }

      const admission = await this.submit(spec);

      if (admission.status === "rejected") {
        return this.toBackendResult(input, {
          admission,
          terminal: null,
          artifactRefs: [],
          usage: null,
          status: "failed",
          error: `crabrunner_admission_rejected: ${admission.reason ?? "rejected"}`,
        });
      }

      if (admission.jobId === null || admission.jobId.trim().length === 0) {
        return this.toBackendResult(input, {
          admission,
          terminal: null,
          artifactRefs: [],
          usage: null,
          status: "failed",
          error: "crabrunner_admission_accepted_without_job_id",
        });
      }

      const terminal = await this.collectTerminalEvidence(
        admission.jobId,
        input.runnerInput.signal,
        spec,
      );
      const status = mapCrabrunnerTerminalStateToRunAttemptPhase(
        terminal.state,
      );
      const error =
        status === "succeeded"
          ? undefined
          : `crabrunner_${terminal.state}: ${terminal.message ?? terminal.state}`;

      return this.toBackendResult(input, {
        admission,
        terminal,
        artifactRefs: terminal.artifactRefs ?? [],
        usage: terminal.usage ?? null,
        status,
        ...(error === undefined ? {} : { error }),
      });
    } finally {
      await cleanupOwnedTempPromptDir(promptFile);
    }
  }

  private async submit(
    spec: CrabrunnerJobSpec,
  ): Promise<CrabrunnerAdmissionResult> {
    try {
      return await this.client.submit(spec);
    } catch (error) {
      return {
        status: "rejected",
        jobId: null,
        reason: `crabrunner_unavailable: ${formatUnknownError(error)}`,
      };
    }
  }

  private async collectTerminalEvidence(
    jobId: string,
    signal: AbortSignal | undefined,
    spec: CrabrunnerJobSpec,
  ): Promise<CrabrunnerTerminalEvidence> {
    if (signal?.aborted) {
      return await this.cancelJob(jobId, spec);
    }

    // The signal is threaded into status/collect; the poll loop fails fast on
    // abort (its own throwIfAborted + abortable sleep), and both catch blocks
    // route an aborted in-flight call to cancelJob. So a single deterministic
    // path yields cancellation evidence — no Promise.race needed (a fast-failing
    // status/collect catch could otherwise beat the slow cancel subprocess and
    // mislabel an aborted job as runner_failed/artifact_collection_failed).
    return await this.collectTerminalEvidenceWithoutCancellation(
      jobId,
      signal,
      spec,
    );
  }

  private async collectTerminalEvidenceWithoutCancellation(
    jobId: string,
    signal: AbortSignal | undefined,
    spec: CrabrunnerJobSpec,
  ): Promise<CrabrunnerTerminalEvidence> {
    try {
      // Status is a cheap fail-closed scheduler/readiness check. The collected
      // artifact remains the terminal source of truth for Symphony.
      await this.client.status(jobId, signal);
    } catch (error) {
      // An abort while status was in flight must yield cancellation evidence,
      // not a generic runner_failed (recheck-2 P2). cancelJob runs at most once
      // per abort because this branch returns immediately.
      if (signal?.aborted) {
        return await this.cancelJob(jobId, spec);
      }
      return {
        state: "runner_failed",
        message: `crabrunner_status_failed: ${formatUnknownError(error)}`,
      };
    }

    try {
      return await this.client.collect(jobId, signal);
    } catch (error) {
      // Same routing for an abort during collect: prefer cancellation evidence
      // over artifact_collection_failed (recheck-2 P2).
      if (signal?.aborted) {
        return await this.cancelJob(jobId, spec);
      }
      return {
        state: "artifact_collection_failed",
        message: `crabrunner_artifact_collection_failed: ${formatUnknownError(error)}`,
      };
    }
  }

  private async cancelJob(
    jobId: string,
    spec: CrabrunnerJobSpec,
  ): Promise<CrabrunnerTerminalEvidence> {
    const request: CrabrunnerCancellationRequest = {
      reason: "abort_signal",
      signal: "SIGTERM",
      processGroup: true,
      killGraceMs: spec.enforcement.cancellation.killGraceMs ?? 0,
    };

    if (this.client.cancel === undefined) {
      return {
        state: "kill_failed",
        message: "crabrunner_cancel_unavailable",
        cancellation: {
          requested: true,
          signal: request.signal,
          processGroup: request.processGroup,
          killed: false,
          failure: "cancel_not_supported",
        },
      };
    }

    try {
      return await this.client.cancel(jobId, request);
    } catch (error) {
      return {
        state: "kill_failed",
        message: `crabrunner_cancel_failed: ${formatUnknownError(error)}`,
        cancellation: {
          requested: true,
          signal: request.signal,
          processGroup: request.processGroup,
          killed: false,
          failure: formatUnknownError(error),
        },
      };
    }
  }

  private toBackendResult(
    input: StageExecutionBackendInput,
    mapped: CrabrunnerStageExecutionEvidence & {
      status: RunAttemptPhase;
      error?: string;
    },
  ): StageExecutionBackendResult<CrabrunnerStageExecutionEvidence> {
    const resultInput = {
      input,
      status: mapped.status,
      terminal: mapped.terminal,
      now: this.now,
      ...(mapped.error === undefined ? {} : { error: mapped.error }),
    };

    return {
      job: input.job,
      result: createCrabrunnerAgentResult(resultInput),
      evidence: {
        admission: mapped.admission,
        terminal: mapped.terminal,
        artifactRefs: mapped.artifactRefs,
        usage: mapped.usage,
      },
    };
  }
}

export function createCrabrunnerJobSpec(
  input: StageExecutionBackendInput,
  dryRun: boolean,
  promptFile?: string | null,
): CrabrunnerJobSpec {
  return {
    schema: CRABRUNNER_JOB_SPEC_VERSION,
    backend: "crabrunner",
    mode: dryRun ? "dry-run" : "submit",
    identity: input.job.identity,
    runner: input.job.runner,
    enforcement: input.job.enforcement,
    role: input.job.role,
    phase: input.job.phase,
    issue: {
      id: input.runnerInput.issue.id,
      identifier: input.runnerInput.issue.identifier,
      title: input.runnerInput.issue.title,
      url: input.runnerInput.issue.url,
    },
    // SYMPH-856: the factory's default resolver renders the stage prompt and
    // passes its path here; absent (no resolver/render) makes the scheduler
    // client fail closed at submit.
    ...(promptFile === undefined || promptFile === null ? {} : { promptFile }),
  };
}

export function validateCrabrunnerLaneEnforcementContract(
  spec: CrabrunnerJobSpec,
): CrabrunnerTerminalEvidence | null {
  if (!spec.enforcement.required) {
    return null;
  }

  const invalid: string[] = [];
  if (
    spec.enforcement.budget.maxTokens === null ||
    spec.enforcement.budget.maxTokens <= 0
  ) {
    invalid.push("enforcement.budget.maxTokens");
  }
  if (
    spec.enforcement.budget.maxUsd === null ||
    spec.enforcement.budget.maxUsd <= 0
  ) {
    invalid.push("enforcement.budget.maxUsd");
  }
  if (
    spec.enforcement.budget.estimatedCostPer1kTokensUsd === null ||
    spec.enforcement.budget.estimatedCostPer1kTokensUsd <= 0
  ) {
    invalid.push("enforcement.budget.estimatedCostPer1kTokensUsd");
  }
  if (
    spec.enforcement.budget.cachedTokenCostRatio === null ||
    spec.enforcement.budget.cachedTokenCostRatio < 0 ||
    spec.enforcement.budget.cachedTokenCostRatio > 1
  ) {
    invalid.push("enforcement.budget.cachedTokenCostRatio");
  }
  if (
    spec.enforcement.budget.liveBudgetGraceRatio === null ||
    spec.enforcement.budget.liveBudgetGraceRatio < 0 ||
    spec.enforcement.budget.liveBudgetGraceRatio > 1
  ) {
    invalid.push("enforcement.budget.liveBudgetGraceRatio");
  }
  if (
    spec.enforcement.timing.timeoutMs === null ||
    spec.enforcement.timing.timeoutMs <= 0
  ) {
    invalid.push("enforcement.timing.timeoutMs");
  }
  if (
    spec.enforcement.timing.stallTimeoutMs === null ||
    spec.enforcement.timing.stallTimeoutMs <= 0
  ) {
    invalid.push("enforcement.timing.stallTimeoutMs");
  }
  if (
    spec.enforcement.timing.noProgressTurns === null ||
    spec.enforcement.timing.noProgressTurns <= 0
  ) {
    invalid.push("enforcement.timing.noProgressTurns");
  }
  if (
    spec.enforcement.timing.maxIterations === null ||
    spec.enforcement.timing.maxIterations <= 0
  ) {
    invalid.push("enforcement.timing.maxIterations");
  }
  if (
    spec.enforcement.telemetry.heartbeatIntervalMs === null ||
    spec.enforcement.telemetry.heartbeatIntervalMs <= 0 ||
    spec.enforcement.telemetry.progressIntervalMs === null ||
    spec.enforcement.telemetry.progressIntervalMs <= 0 ||
    spec.enforcement.telemetry.usageIntervalMs === null ||
    spec.enforcement.telemetry.usageIntervalMs <= 0
  ) {
    invalid.push("enforcement.telemetry.*IntervalMs");
  }
  if (
    !spec.enforcement.cancellation.jobIdRequired ||
    !spec.enforcement.cancellation.cooperativeAbort ||
    !spec.enforcement.cancellation.processGroupKill ||
    spec.enforcement.cancellation.killGraceMs === null ||
    spec.enforcement.cancellation.killGraceMs < 0
  ) {
    invalid.push("enforcement.cancellation");
  }

  if (invalid.length === 0) {
    return null;
  }

  return {
    state: "enforcement_contract_missing",
    message: `missing or invalid delegated lane enforcement metadata: ${invalid.join(", ")}`,
  };
}

function mapCrabrunnerTerminalStateToRunAttemptPhase(
  state: CrabrunnerTerminalState,
): RunAttemptPhase {
  switch (state) {
    case "succeeded":
      return "succeeded";
    case "timed_out":
      return "timed_out";
    case "stalled":
      return "stalled";
    case "canceled":
      return "canceled_by_reconciliation";
    case "usage_unavailable":
      return "succeeded";
    case "budget_exceeded":
    case "kill_failed":
    case "enforcement_contract_missing":
    case "runner_failed":
    case "artifact_parse_failed":
    case "artifact_collection_failed":
      return "failed";
  }
  const exhaustive: never = state;
  return exhaustive;
}

function createCrabrunnerAgentResult(input: {
  input: StageExecutionBackendInput;
  status: RunAttemptPhase;
  terminal: CrabrunnerTerminalEvidence | null;
  error?: string;
  now: () => Date;
}): AgentRunResult {
  const terminal = input.terminal;
  const artifactRefs = terminal?.artifactRefs ?? [];
  const terminalUsage = terminal?.usage;
  const usageMeasurement = mapCrabrunnerUsageToStageUsage({
    usage: terminalUsage,
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
    lastTurn: null,
    rateLimits: null,
  };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove the temp prompt directory the factory's default resolver created
 * (SYMPH-856, P2-2). Acts ONLY on a path whose parent directory lives directly
 * under the OS temp dir and carries {@link CRABRUNNER_TEMP_PROMPT_DIR_PREFIX},
 * so an explicit `resolvePromptFile` override pointing elsewhere is never
 * touched. Never throws — cleanup is best-effort.
 */
async function cleanupOwnedTempPromptDir(
  promptFile: string | null | undefined,
): Promise<void> {
  if (promptFile === undefined || promptFile === null) {
    return;
  }
  const dir = dirname(resolve(promptFile));
  const tempRoot = resolve(tmpdir());
  // Owned dir is `<tmpdir>/<prefix><random>`: its parent must be exactly the
  // temp root (no nesting), and its name must carry the owned prefix.
  if (dirname(dir) !== tempRoot) {
    return;
  }
  if (
    !dir
      .slice(tempRoot.length + sep.length)
      .startsWith(CRABRUNNER_TEMP_PROMPT_DIR_PREFIX)
  ) {
    return;
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a missing/locked temp dir must not fail the job.
  }
}
