import type { StopSignalDeliveryResponse } from "../observability/stop-signal-delivery-response.js";
import type { StageExecutionBackendRunner } from "../stage-execution/backend.js";
import type {
  CancellableCrabrunnerStageExecutionBackend,
  CrabrunnerCancellationRequest,
  CrabrunnerTerminalEvidence,
} from "../stage-execution/crabrunner-backend.js";
import type { StopRequest, StopSignalDelivery } from "./core.js";

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
  const cancellation = evidence.cancellation;
  const killed = cancellation?.killed === true && evidence.state === "canceled";
  const alreadyStopped =
    evidence.state === "canceled" &&
    cancellation?.requested === true &&
    !killed;
  return {
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
  };
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
