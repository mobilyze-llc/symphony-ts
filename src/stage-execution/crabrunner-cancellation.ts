import type { StageExecutionBackendRunner } from "./backend.js";
import type {
  CrabrunnerStageExecutionEvidence,
  CrabrunnerTerminalEvidence,
} from "./crabrunner-backend.js";

interface CancellationClient {
  cancel?(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence>;
}

export interface CancellableCrabrunnerStageExecutionBackend
  extends StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence> {
  cancel(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence>;
}

export interface CrabrunnerCancellationRequest {
  reason: "abort_signal" | "operator_stop";
  signal: "SIGTERM";
  processGroup: true;
  killGraceMs: number;
}

async function cancelCrabrunnerJob(
  client: CancellationClient,
  jobId: string,
  request: CrabrunnerCancellationRequest,
): Promise<CrabrunnerTerminalEvidence> {
  if (client.cancel === undefined) {
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
    return await client.cancel(jobId, request);
  } catch (error) {
    const message = formatUnknownError(error);
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
  }
}

export class CrabrunnerCancellationController {
  private readonly cancellationsInFlight = new Map<
    string,
    Promise<CrabrunnerTerminalEvidence>
  >();

  constructor(private readonly client: CancellationClient) {}

  async cancel(
    jobId: string,
    request: CrabrunnerCancellationRequest,
  ): Promise<CrabrunnerTerminalEvidence> {
    const existing = this.cancellationsInFlight.get(jobId);
    if (existing !== undefined) {
      return await existing;
    }
    const cancellation = cancelCrabrunnerJob(this.client, jobId, request);
    this.cancellationsInFlight.set(jobId, cancellation);
    try {
      return await cancellation;
    } finally {
      this.cancellationsInFlight.delete(jobId);
    }
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
