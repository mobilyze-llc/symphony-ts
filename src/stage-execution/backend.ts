import type { AgentRunInput, AgentRunResult } from "../agent/runner.js";
import type {
  StageExecutionBackend as StageExecutionBackendKind,
  StageExecutionPhase,
  StageExecutionRole,
} from "../config/types.js";

export interface StageExecutionIdentity {
  issueId: string;
  issueIdentifier: string;
  stageName: string | null;
  stageAttempt: number;
  runGroupId: string;
  profileId: string | null;
  baseRef: string | null;
  targetHeadRef: string | null;
  artifactRoot: string;
  idempotencyKey: string;
}

export interface StageExecutionRunnerProfile {
  runnerKind: string;
  model: string | null;
  provider: string | null;
  reasoningEffort: string | null;
}

export interface StageExecutionJobSpec {
  backend: StageExecutionBackendKind;
  role: StageExecutionRole | null;
  phase: StageExecutionPhase | null;
  identity: StageExecutionIdentity;
  runner: StageExecutionRunnerProfile;
}

export interface StageExecutionBackendInput {
  job: StageExecutionJobSpec;
  runnerInput: AgentRunInput;
}

export interface StageExecutionBackendResult {
  job: StageExecutionJobSpec;
  result: AgentRunResult;
}

export interface StageExecutionBackendRunner {
  readonly backend: StageExecutionBackendKind;
  execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult>;
}

export interface CurrentRunnerStageExecutionRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export class CurrentRunnerStageExecutionBackend
  implements StageExecutionBackendRunner
{
  readonly backend = "current-runner" as const;

  constructor(private readonly runner: CurrentRunnerStageExecutionRunner) {}

  async execute(
    input: StageExecutionBackendInput,
  ): Promise<StageExecutionBackendResult> {
    return {
      job: input.job,
      result: await this.runner.run(input.runnerInput),
    };
  }
}

export class UnsupportedStageExecutionBackendError extends Error {
  readonly backend: StageExecutionBackendKind;
  readonly job: StageExecutionJobSpec;

  constructor(job: StageExecutionJobSpec) {
    super(
      `Stage execution backend "${job.backend}" is not registered for ${job.identity.issueIdentifier}.`,
    );
    this.name = "UnsupportedStageExecutionBackendError";
    this.backend = job.backend;
    this.job = job;
  }
}
