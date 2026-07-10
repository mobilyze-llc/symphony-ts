import type { StopSignalDeliveryResponse } from "../observability/stop-signal-delivery-response.js";
import type { StageExecutionBackendRunner } from "../stage-execution/backend.js";
import type {
  CancellableCrabrunnerStageExecutionBackend,
  CrabrunnerCancellationRequest,
  CrabrunnerTerminalEvidence,
} from "../stage-execution/crabrunner-backend.js";
import type { StopRequest, StopSignalDelivery } from "./core.js";
import { isStopSignalDelivery } from "./stop-signal-delivery.js";

const CRABRUNNER_TERMINAL_STATES = new Set([
  "succeeded",
  "timed_out",
  "budget_exceeded",
  "turn_cap_reached",
  "stalled",
  "canceled",
  "kill_failed",
  "enforcement_contract_missing",
  "runner_failed",
  "artifact_parse_failed",
  "artifact_collection_failed",
  "usage_unavailable",
]);

export function isCancellableCrabrunnerBackend(
  backend: StageExecutionBackendRunner,
): backend is CancellableCrabrunnerStageExecutionBackend {
  return (
    backend.backend === "crabrunner" &&
    typeof (backend as Partial<CancellableCrabrunnerStageExecutionBackend>)
      .cancel === "function"
  );
}

export function laneCancellationToStopSignalDelivery(
  laneJobId: string | null,
  input: StopRequest,
  evidence: CrabrunnerTerminalEvidence,
  attemptedAt: Date,
): StopSignalDelivery {
  if (!isValidCrabrunnerTerminalEvidence(evidence)) {
    return invalidLaneCancellationDelivery(
      laneJobId,
      input,
      attemptedAt,
      "Invalid crabrunner cancellation evidence.",
    );
  }
  const cancellation = evidence.cancellation;
  const killed = cancellation?.killed === true && evidence.state === "canceled";
  const alreadyStopped =
    cancellation?.requested === true &&
    !killed &&
    evidence.state !== "kill_failed" &&
    CRABRUNNER_TERMINAL_STATES.has(evidence.state);
  const delivery = {
    status: killed ? "delivered" : alreadyStopped ? "already_exited" : "failed",
    reason: input.reason,
    attemptedAt: attemptedAt.toISOString(),
    workspacePath: evidence.workspacePath ?? null,
    attempts: [],
    laneJobId,
    laneCancellation: {
      state: evidence.state,
      killed: cancellation?.killed === true,
      failure: cancellation?.failure ?? null,
    },
    warning:
      killed || alreadyStopped
        ? null
        : (cancellation?.failure ??
          evidence.message ??
          `crabrunner cancellation ended in ${evidence.state}`),
  } satisfies StopSignalDelivery;
  return isStopSignalDelivery(delivery)
    ? delivery
    : invalidLaneCancellationDelivery(
        laneJobId,
        input,
        attemptedAt,
        "Invalid lane cancellation delivery telemetry.",
      );
}

function invalidLaneCancellationDelivery(
  laneJobId: string | null,
  input: StopRequest,
  attemptedAt: Date,
  warning: string,
): StopSignalDelivery {
  return {
    status: "failed",
    reason: input.reason,
    attemptedAt: attemptedAt.toISOString(),
    workspacePath: null,
    attempts: [],
    laneJobId,
    laneCancellation: {
      state: "kill_failed",
      killed: false,
      failure: warning,
    },
    warning,
  };
}

function isValidCrabrunnerTerminalEvidence(
  value: unknown,
): value is CrabrunnerTerminalEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.state !== "string" ||
    !CRABRUNNER_TERMINAL_STATES.has(evidence.state) ||
    (evidence.workspacePath !== undefined &&
      evidence.workspacePath !== null &&
      typeof evidence.workspacePath !== "string")
  ) {
    return false;
  }
  const cancellation = evidence.cancellation;
  if (cancellation === undefined || cancellation === null) {
    return true;
  }
  if (
    typeof cancellation !== "object" ||
    Array.isArray(cancellation) ||
    cancellation === null
  ) {
    return false;
  }
  const block = cancellation as Record<string, unknown>;
  return (
    typeof block.requested === "boolean" &&
    (block.signal === null || typeof block.signal === "string") &&
    typeof block.processGroup === "boolean" &&
    typeof block.killed === "boolean" &&
    (block.failure === null || typeof block.failure === "string")
  );
}

export function normalizeLaneCancellation(
  cancel: (
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ) => Promise<CrabrunnerTerminalEvidence>,
  jobId: string,
  request: CrabrunnerCancellationRequest,
): Promise<CrabrunnerTerminalEvidence> {
  const failure = (error: unknown): CrabrunnerTerminalEvidence => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "kill_failed",
      message: `crabrunner_cancel_failed: ${message}`,
      cancellation: {
        requested: true,
        signal: request.signal,
        processGroup: request.processGroup,
        killed: false,
        failure: message,
      },
    };
  };
  try {
    return cancel(jobId, request).catch(failure);
  } catch (error) {
    return Promise.resolve(failure(error));
  }
}

export function toStopSignalDeliveryResponse(
  delivery: StopSignalDelivery | null,
): StopSignalDeliveryResponse | null {
  if (delivery === null) {
    return null;
  }
  return {
    status: delivery.status,
    reason: delivery.reason,
    attempted_at: delivery.attemptedAt,
    workspace_path: delivery.workspacePath,
    attempts: delivery.attempts.map((attempt) => ({
      pid: attempt.pid,
      ...(attempt.processGroupId === null
        ? {}
        : { process_group_id: attempt.processGroupId }),
      sigterm: attempt.sigterm,
      sigkill: attempt.sigkill,
    })),
    ...(delivery.laneJobId === undefined
      ? {}
      : { lane_job_id: delivery.laneJobId }),
    ...(delivery.laneCancellation === undefined
      ? {}
      : { lane_cancellation: delivery.laneCancellation }),
    warning: delivery.warning,
  };
}
