import type { RunAttemptPhase } from "../domain/model.js";
import type { StageUsageMeasurementQuality } from "../domain/stage-usage.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
} from "./backend.js";
import {
  type CancellableCrabrunnerStageExecutionBackend,
  CrabrunnerCancellationController,
  type CrabrunnerCancellationRequest,
} from "./crabrunner-cancellation.js";
export type {
  CancellableCrabrunnerStageExecutionBackend,
  CrabrunnerCancellationRequest,
} from "./crabrunner-cancellation.js";
import {
  type CollectedArtifact,
  artifactHashesFromCollectedArtifact,
  artifactRefsFromCollectedArtifact,
} from "./collected-artifact.js";
import { createCrabrunnerAgentResult } from "./crabrunner-agent-result.js";

export const CRABRUNNER_JOB_SPEC_VERSION = "symphony.crabrunner.job.v1";

export const CRABRUNNER_TEMP_PROMPT_DIR_PREFIX = "crabrunner-prompt-";

export type CrabrunnerTerminalState =
  | "succeeded"
  | "timed_out"
  | "budget_exceeded"
  | "turn_cap_reached"
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
      measurementQuality?: StageUsageMeasurementQuality;
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
  promptFile?: string;
  /** Hash of the rendered prompt bytes retained after the temp file is removed. */
  promptSha256?: string;
}

export interface CrabrunnerAdmissionResult {
  status: "accepted" | "rejected";
  jobId: string | null;
  reason?: string;
}

export interface CrabrunnerTerminalEvidence {
  state: CrabrunnerTerminalState;
  artifact?: CollectedArtifact;
  workspaceSyncRef?: { path: string; sha256?: string | null };
  artifactRefs?: readonly string[];
  artifactHashes?: readonly string[];
  workspacePath?: string | null;
  usage?: CrabrunnerUsage | null;
  message?: string | null;
  progress?: CrabrunnerProgressEvidence | null;
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

export interface CrabrunnerProgressEvidence {
  heartbeatCount?: number;
  progressEventCount?: number;
  usageEventCount?: number;
  lastHeartbeatAt?: string | null;
  lastProgressAt?: string | null;
  lastUsageAt?: string | null;
}

/**
 * A scheduler status failure carrying the last liveness evidence observed
 * before polling failed. The backend persists this snapshot with runner_failed
 * evidence, so timeout/debugging signals survive in-memory job cleanup.
 */
export class CrabrunnerStatusPollError extends Error {
  readonly progress: CrabrunnerProgressEvidence | null;

  constructor(cause: unknown, progress: CrabrunnerProgressEvidence | null) {
    super(formatUnknownError(cause));
    this.name =
      cause instanceof Error && cause.name === "AbortError"
        ? "AbortError"
        : "CrabrunnerStatusPollError";
    this.progress = progress;
  }
}

export interface CrabrunnerStageExecutionEvidence {
  admission: CrabrunnerAdmissionResult;
  terminal: CrabrunnerTerminalEvidence | null;
  artifact?: CollectedArtifact;
  artifactRefs: readonly string[];
  artifactHashes?: readonly string[];
  usage: CrabrunnerUsage | null;
  promptSha256?: string;
}

export interface CrabrunnerSchedulerClient {
  submit(
    spec: CrabrunnerJobSpec,
    signal?: AbortSignal,
  ): Promise<CrabrunnerAdmissionResult>;
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
  /**
   * Paired cleanup for a prompt path produced by {@link resolvePromptFile}
   * (SYMPH-856, recheck-2 P2-1). Invoked in `execute()`'s `finally` after the
   * job is terminal, with the resolved prompt path. Supplied ONLY by the factory
   * alongside its DEFAULT resolver, which tracks the temp dirs it created and
   * removes only those — so an explicit `resolvePromptFile` override path (which
   * has no paired cleanup) is NEVER deleted, even if it collides with the temp
   * prefix. Must be best-effort: `execute()` swallows any cleanup error so it
   * never masks the job result.
   */
  cleanupPromptFile?: (resolvedPath: string) => Promise<void> | void;
  /** Computes the rendered prompt hash before submit/cleanup. */
  resolvePromptSha256?: (resolvedPath: string) => Promise<string> | string;
  now?: () => Date;
}

export class CrabrunnerStageExecutionBackend
  implements CancellableCrabrunnerStageExecutionBackend
{
  readonly backend = "crabrunner" as const;

  private readonly client: CrabrunnerSchedulerClient;

  private readonly dryRun: boolean;

  private readonly resolvePromptFile:
    | ((
        input: StageExecutionBackendInput,
      ) => Promise<string | null | undefined> | string | null | undefined)
    | undefined;

  private readonly cleanupPromptFile:
    | ((resolvedPath: string) => Promise<void> | void)
    | undefined;

  private readonly resolvePromptSha256:
    | ((resolvedPath: string) => Promise<string> | string)
    | undefined;

  private readonly now: () => Date;

  private readonly cancellationController: CrabrunnerCancellationController;

  constructor(options: CrabrunnerStageExecutionBackendOptions) {
    this.client = options.client;
    this.dryRun = options.dryRun ?? false;
    this.resolvePromptFile = options.resolvePromptFile;
    this.cleanupPromptFile = options.cleanupPromptFile;
    this.resolvePromptSha256 = options.resolvePromptSha256;
    this.now = options.now ?? (() => new Date());
    this.cancellationController = new CrabrunnerCancellationController(
      this.client,
    );
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
    let promptSha256: string | undefined;
    // Hashing and execution share one lifecycle guard so every post-render
    // return path cleans up a factory-owned temp prompt directory.
    try {
      try {
        if (
          promptFile !== undefined &&
          this.resolvePromptSha256 !== undefined
        ) {
          promptSha256 = await this.resolvePromptSha256(promptFile);
        }
      } catch (error) {
        return this.toBackendResult(input, {
          admission: {
            status: "rejected",
            jobId: null,
            reason: `crabrunner_prompt_hash_failed: ${formatUnknownError(error)}`,
          },
          terminal: null,
          artifactRefs: [],
          usage: null,
          status: "failed",
          error: `crabrunner_prompt_hash_failed: ${formatUnknownError(error)}`,
        });
      }

      const spec = createCrabrunnerJobSpec(
        input,
        this.dryRun,
        promptFile,
        promptSha256,
      );
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
          ...(promptSha256 === undefined ? {} : { promptSha256 }),
          status: "failed",
          error: `crabrunner_${enforcementFailure.state}: ${
            enforcementFailure.message ?? enforcementFailure.state
          }`,
        });
      }

      const admission = await this.submit(spec, input.runnerInput.signal);

      if (admission.status === "rejected") {
        return this.toBackendResult(input, {
          admission,
          terminal: null,
          artifactRefs: [],
          usage: null,
          ...(promptSha256 === undefined ? {} : { promptSha256 }),
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
          ...(promptSha256 === undefined ? {} : { promptSha256 }),
          status: "failed",
          error: "crabrunner_admission_accepted_without_job_id",
        });
      }

      input.onLaneJobId?.(admission.jobId);

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
        ...(terminal.artifact === undefined
          ? {}
          : { artifact: terminal.artifact }),
        artifactRefs:
          terminal.artifactRefs ??
          artifactRefsFromCollectedArtifact(terminal.artifact),
        artifactHashes:
          terminal.artifactHashes ??
          artifactHashesFromCollectedArtifact(terminal.artifact),
        usage: terminal.usage ?? null,
        ...(promptSha256 === undefined ? {} : { promptSha256 }),
        status,
        ...(error === undefined ? {} : { error }),
      });
    } finally {
      // The lane has consumed the prompt before execute returns. The paired
      // factory cleanup owns only renderer-created directories; explicit
      // overrides are never removed. Cleanup remains best-effort.
      await this.cleanupResolvedPrompt(promptFile);
    }
  }

  private async cleanupResolvedPrompt(
    promptFile: string | null | undefined,
  ): Promise<void> {
    if (
      promptFile === undefined ||
      promptFile === null ||
      this.cleanupPromptFile === undefined
    ) {
      return;
    }
    try {
      await this.cleanupPromptFile(promptFile);
    } catch {
      // Best-effort: a missing/locked temp dir must not fail the job.
    }
  }

  private async submit(
    spec: CrabrunnerJobSpec,
    signal: AbortSignal | undefined,
  ): Promise<CrabrunnerAdmissionResult> {
    try {
      return await this.client.submit(spec, signal);
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
      const progress =
        error instanceof CrabrunnerStatusPollError ? error.progress : null;
      return {
        state: "runner_failed",
        message: `crabrunner_status_failed: ${formatUnknownError(error)}`,
        ...(progress === null ? {} : { progress }),
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

    return await this.cancel(jobId, request);
  }

  async cancel(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence> {
    return await this.cancellationController.cancel(jobId, request);
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
      laneJobId: mapped.admission.jobId,
      now: this.now,
      ...(mapped.error === undefined ? {} : { error: mapped.error }),
    };

    return {
      job: input.job,
      result: createCrabrunnerAgentResult(resultInput),
      evidence: {
        admission: mapped.admission,
        terminal: mapped.terminal,
        ...(mapped.artifact === undefined ? {} : { artifact: mapped.artifact }),
        artifactRefs: mapped.artifactRefs,
        artifactHashes: mapped.artifactHashes ?? [],
        usage: mapped.usage,
        ...(mapped.promptSha256 === undefined
          ? {}
          : { promptSha256: mapped.promptSha256 }),
      },
    };
  }
}

export function createCrabrunnerJobSpec(
  input: StageExecutionBackendInput,
  dryRun: boolean,
  promptFile?: string | null,
  promptSha256?: string,
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
    ...(promptSha256 === undefined ? {} : { promptSha256 }),
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
    case "turn_cap_reached":
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
