import type { AgentRunInput } from "../agent/runner.js";
import type {
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionIdentity,
  StageExecutionJobSpec,
} from "./backend.js";

export type StageExecutionLaneDispatchMode = "parallel" | "sequential";

export interface StageExecutionLaneIdentityExpectation {
  issueId?: string;
  issueIdentifier?: string;
  stageName?: string | null;
  stageAttempt?: number;
  runGroupId?: string;
  profileId?: string | null;
  baseRef?: string | null;
  targetHeadRef?: string | null;
  artifactRoot?: string;
}

export interface StageExecutionLaneValidationError {
  field: keyof StageExecutionIdentity | "backend";
  expected: string | number | null;
  actual: string | number | null;
  message: string;
}

export interface StageExecutionLaneDispatch<TLane, TEvidence = unknown> {
  lane: TLane;
  index: number;
  job: StageExecutionJobSpec;
  backend: StageExecutionBackendRunner<TEvidence> | null;
  dispatchStatus: "skipped" | "completed" | "failed";
  validationErrors: readonly StageExecutionLaneValidationError[];
  backendResult: StageExecutionBackendResult<TEvidence> | null;
  error: unknown;
}

export interface StageExecutionLaneResult<TLane, TArtifact, TEvidence = unknown>
  extends StageExecutionLaneDispatch<TLane, TEvidence> {
  artifact: TArtifact | null;
  collectError: unknown;
}

export interface RunStageExecutionMultiLaneInput<
  TLane,
  TArtifact,
  TAggregate,
  TEvidence = unknown,
> {
  lanes: readonly TLane[];
  dispatchMode?: StageExecutionLaneDispatchMode;
  buildJobSpec: (lane: TLane, index: number) => StageExecutionJobSpec;
  buildRunnerInput: (
    lane: TLane,
    index: number,
    job: StageExecutionJobSpec,
  ) => AgentRunInput;
  resolveBackend: (
    job: StageExecutionJobSpec,
    lane: TLane,
    index: number,
  ) => StageExecutionBackendRunner<TEvidence>;
  /** Called as soon as any delegated lane is admitted by its backend. */
  onLaneJobId?: ((jobId: string) => void) | undefined;
  expectedIdentity?:
    | StageExecutionLaneIdentityExpectation
    | ((
        input: StageExecutionLaneIdentityInput<TLane>,
      ) => StageExecutionLaneIdentityExpectation | null | undefined);
  validateJobSpec?: (
    input: StageExecutionLaneIdentityInput<TLane>,
  ) =>
    | StageExecutionLaneValidationError
    | readonly StageExecutionLaneValidationError[]
    | null
    | undefined;
  collectArtifact: (
    lane: StageExecutionLaneDispatch<TLane, TEvidence>,
  ) => Promise<TArtifact> | TArtifact;
  aggregate: (
    lanes: readonly StageExecutionLaneResult<TLane, TArtifact, TEvidence>[],
  ) => Promise<TAggregate> | TAggregate;
}

export interface RunStageExecutionMultiLaneResult<
  TLane,
  TArtifact,
  TAggregate,
  TEvidence = unknown,
> {
  lanes: readonly StageExecutionLaneResult<TLane, TArtifact, TEvidence>[];
  aggregate: TAggregate;
}

export interface StageExecutionLaneIdentityInput<TLane> {
  lane: TLane;
  index: number;
  job: StageExecutionJobSpec;
}

export async function runStageExecutionLanes<
  TLane,
  TArtifact,
  TAggregate,
  TEvidence = unknown,
>(
  input: RunStageExecutionMultiLaneInput<
    TLane,
    TArtifact,
    TAggregate,
    TEvidence
  >,
): Promise<
  RunStageExecutionMultiLaneResult<TLane, TArtifact, TAggregate, TEvidence>
> {
  const dispatchMode = input.dispatchMode ?? "parallel";
  const laneEntries = input.lanes.map((lane, index) => ({ lane, index }));
  const runLane = (entry: {
    lane: TLane;
    index: number;
  }): Promise<StageExecutionLaneResult<TLane, TArtifact, TEvidence>> =>
    runOneLane(input, entry.lane, entry.index);

  const lanes =
    dispatchMode === "sequential"
      ? await runSequentially(laneEntries, runLane)
      : await Promise.all(laneEntries.map(runLane));
  return {
    lanes,
    aggregate: await input.aggregate(lanes),
  };
}

async function runSequentially<TLane, TArtifact, TEvidence>(
  lanes: readonly { lane: TLane; index: number }[],
  runLane: (entry: {
    lane: TLane;
    index: number;
  }) => Promise<StageExecutionLaneResult<TLane, TArtifact, TEvidence>>,
): Promise<StageExecutionLaneResult<TLane, TArtifact, TEvidence>[]> {
  const results: StageExecutionLaneResult<TLane, TArtifact, TEvidence>[] = [];
  for (const lane of lanes) {
    results.push(await runLane(lane));
  }
  return results;
}

async function runOneLane<TLane, TArtifact, TAggregate, TEvidence>(
  input: RunStageExecutionMultiLaneInput<
    TLane,
    TArtifact,
    TAggregate,
    TEvidence
  >,
  lane: TLane,
  index: number,
): Promise<StageExecutionLaneResult<TLane, TArtifact, TEvidence>> {
  const job = input.buildJobSpec(lane, index);
  const identityInput = { lane, index, job };
  const validationErrors = [
    ...validateExpectedIdentity(
      job,
      resolveExpectedIdentity(input, identityInput),
    ),
    ...normalizeValidationErrors(input.validateJobSpec?.(identityInput)),
  ];

  if (validationErrors.length > 0) {
    return collectLane(input, {
      lane,
      index,
      job,
      backend: null,
      dispatchStatus: "skipped",
      validationErrors,
      backendResult: null,
      error: null,
    });
  }

  const backend = input.resolveBackend(job, lane, index);
  if (backend.backend !== job.backend) {
    return collectLane(input, {
      lane,
      index,
      job,
      backend,
      dispatchStatus: "skipped",
      validationErrors: [
        {
          field: "backend",
          expected: job.backend,
          actual: backend.backend,
          message: [
            `lane job backend ${job.backend}`,
            `does not match resolved backend ${backend.backend}`,
          ].join(" "),
        },
      ],
      backendResult: null,
      error: null,
    });
  }

  try {
    const backendResult = await backend.execute({
      job,
      runnerInput: input.buildRunnerInput(lane, index, job),
      ...(input.onLaneJobId === undefined
        ? {}
        : { onLaneJobId: input.onLaneJobId }),
    });
    return collectLane(input, {
      lane,
      index,
      job,
      backend,
      dispatchStatus: "completed",
      validationErrors: [],
      backendResult,
      error: null,
    });
  } catch (error) {
    return collectLane(input, {
      lane,
      index,
      job,
      backend,
      dispatchStatus: "failed",
      validationErrors: [],
      backendResult: null,
      error,
    });
  }
}

async function collectLane<TLane, TArtifact, TAggregate, TEvidence>(
  input: RunStageExecutionMultiLaneInput<
    TLane,
    TArtifact,
    TAggregate,
    TEvidence
  >,
  lane: StageExecutionLaneDispatch<TLane, TEvidence>,
): Promise<StageExecutionLaneResult<TLane, TArtifact, TEvidence>> {
  try {
    return {
      ...lane,
      artifact: await input.collectArtifact(lane),
      collectError: null,
    };
  } catch (error) {
    return {
      ...lane,
      artifact: null,
      collectError: error,
    };
  }
}

function resolveExpectedIdentity<TLane, TArtifact, TAggregate, TEvidence>(
  input: RunStageExecutionMultiLaneInput<
    TLane,
    TArtifact,
    TAggregate,
    TEvidence
  >,
  lane: StageExecutionLaneIdentityInput<TLane>,
): StageExecutionLaneIdentityExpectation | null {
  if (input.expectedIdentity === undefined) {
    return null;
  }
  if (typeof input.expectedIdentity === "function") {
    return input.expectedIdentity(lane) ?? null;
  }
  return input.expectedIdentity;
}

function validateExpectedIdentity(
  job: StageExecutionJobSpec,
  expected: StageExecutionLaneIdentityExpectation | null,
): StageExecutionLaneValidationError[] {
  if (expected === null) {
    return [];
  }
  return [
    compareIdentityField("issueId", job.identity.issueId, expected.issueId),
    compareIdentityField(
      "issueIdentifier",
      job.identity.issueIdentifier,
      expected.issueIdentifier,
    ),
    compareIdentityField(
      "stageName",
      job.identity.stageName,
      expected.stageName,
    ),
    compareIdentityField(
      "stageAttempt",
      job.identity.stageAttempt,
      expected.stageAttempt,
    ),
    compareIdentityField(
      "runGroupId",
      job.identity.runGroupId,
      expected.runGroupId,
    ),
    compareIdentityField(
      "profileId",
      job.identity.profileId,
      expected.profileId,
    ),
    compareIdentityField("baseRef", job.identity.baseRef, expected.baseRef),
    compareIdentityField(
      "targetHeadRef",
      job.identity.targetHeadRef,
      expected.targetHeadRef,
    ),
    compareIdentityField(
      "artifactRoot",
      job.identity.artifactRoot,
      expected.artifactRoot,
    ),
  ].filter(
    (error): error is StageExecutionLaneValidationError => error !== null,
  );
}

function compareIdentityField(
  field: keyof StageExecutionIdentity,
  actual: string | number | null,
  expected: string | number | null | undefined,
): StageExecutionLaneValidationError | null {
  if (expected === undefined || actual === expected) {
    return null;
  }
  return {
    field,
    expected,
    actual,
    message: [
      `lane job identity ${field} ${String(actual)}`,
      `does not match expected ${String(expected)}`,
    ].join(" "),
  };
}

function normalizeValidationErrors(
  value:
    | StageExecutionLaneValidationError
    | readonly StageExecutionLaneValidationError[]
    | null
    | undefined,
): StageExecutionLaneValidationError[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (isValidationErrorArray(value)) {
    return [...value];
  }
  return [value];
}

function isValidationErrorArray(
  value:
    | StageExecutionLaneValidationError
    | readonly StageExecutionLaneValidationError[],
): value is readonly StageExecutionLaneValidationError[] {
  return Array.isArray(value);
}
