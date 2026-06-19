import type { AgentRunResult } from "../agent/runner.js";
import {
  type RunAttemptPhase,
  createEmptyLiveSession,
} from "../domain/model.js";
import type {
  StageExecutionBackendInput,
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
} from "./backend.js";

export const CRABRUNNER_JOB_SPEC_VERSION = "symphony.crabrunner.job.v1";

export type CrabrunnerTerminalState =
  | "succeeded"
  | "timed_out"
  | "canceled"
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
  role: StageExecutionBackendInput["job"]["role"];
  phase: StageExecutionBackendInput["job"]["phase"];
  issue: {
    id: string;
    identifier: string;
    title: string;
    url: string | null;
  };
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
   * closed before collection.
   */
  status(jobId: string): Promise<void>;
  collect(jobId: string): Promise<CrabrunnerTerminalEvidence>;
}

export interface CrabrunnerStageExecutionBackendOptions {
  client: CrabrunnerSchedulerClient;
  /**
   * Marks job specs as dry-run. The scheduler client owns dry-run semantics;
   * the backend still exercises submit/status/collect so the contract is testable.
   */
  dryRun?: boolean;
  now?: () => Date;
}

export class CrabrunnerStageExecutionBackend
  implements StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>
{
  readonly backend = "crabrunner" as const;

  private readonly client: CrabrunnerSchedulerClient;

  private readonly dryRun: boolean;

  private readonly now: () => Date;

  constructor(options: CrabrunnerStageExecutionBackendOptions) {
    this.client = options.client;
    this.dryRun = options.dryRun ?? false;
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>> {
    const spec = createCrabrunnerJobSpec(input, this.dryRun);
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

    const terminal = await this.collectTerminalEvidence(admission.jobId);
    const status = mapCrabrunnerTerminalStateToRunAttemptPhase(terminal.state);
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
  ): Promise<CrabrunnerTerminalEvidence> {
    try {
      // Status is a cheap fail-closed scheduler/readiness check. The collected
      // artifact remains the terminal source of truth for Symphony.
      await this.client.status(jobId);
    } catch (error) {
      return {
        state: "runner_failed",
        message: `crabrunner_status_failed: ${formatUnknownError(error)}`,
      };
    }

    try {
      return await this.client.collect(jobId);
    } catch (error) {
      return {
        state: "artifact_collection_failed",
        message: `crabrunner_artifact_collection_failed: ${formatUnknownError(error)}`,
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
): CrabrunnerJobSpec {
  return {
    schema: CRABRUNNER_JOB_SPEC_VERSION,
    backend: "crabrunner",
    mode: dryRun ? "dry-run" : "submit",
    identity: input.job.identity,
    runner: input.job.runner,
    role: input.job.role,
    phase: input.job.phase,
    issue: {
      id: input.runnerInput.issue.id,
      identifier: input.runnerInput.issue.identifier,
      title: input.runnerInput.issue.title,
      url: input.runnerInput.issue.url,
    },
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
    case "canceled":
      return "canceled_by_reconciliation";
    case "usage_unavailable":
      return "succeeded";
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
  const usage =
    terminalUsage?.status === "available" ? terminalUsage : undefined;
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
            }),
      codexInputTokens: usage?.inputTokens ?? 0,
      codexOutputTokens: usage?.outputTokens ?? 0,
      codexTotalTokens: usage?.totalTokens ?? 0,
      codexCacheReadTokens: usage?.cacheReadTokens ?? 0,
      codexCacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      codexNoCacheTokens: usage?.noCacheTokens ?? 0,
      codexReasoningTokens: usage?.reasoningTokens ?? 0,
      codexTotalInputTokens: usage?.inputTokens ?? 0,
      codexTotalOutputTokens: usage?.outputTokens ?? 0,
      totalStageInputTokens: usage?.inputTokens ?? 0,
      totalStageOutputTokens: usage?.outputTokens ?? 0,
      totalStageTotalTokens: usage?.totalTokens ?? 0,
      totalStageCacheReadTokens: usage?.cacheReadTokens ?? 0,
      totalStageCacheWriteTokens: usage?.cacheWriteTokens ?? 0,
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
