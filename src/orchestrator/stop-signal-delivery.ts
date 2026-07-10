export type StopReason =
  | "terminal_state"
  | "inactive_state"
  | "stall_timeout"
  | "manual_stop"
  | "emergency_stop";

export type StopSignalDeliveryStatus =
  | "not_attempted"
  | "already_exited"
  | "delivered"
  | "partial"
  | "failed";

export type StopSignalStatus =
  | "delivered"
  | "already_exited"
  | "failed"
  | "not_attempted";

export function isStopReason(value: unknown): value is StopReason {
  return (
    value === "terminal_state" ||
    value === "inactive_state" ||
    value === "stall_timeout" ||
    value === "manual_stop" ||
    value === "emergency_stop"
  );
}

export interface StopSignalDeliveryAttempt {
  pid: number;
  processGroupId: number | null;
  sigterm: Exclude<StopSignalStatus, "not_attempted">;
  sigkill: StopSignalStatus;
}

export interface StopSignalDelivery {
  /**
   * Aggregate proof status. "delivered" means every target reached a terminal
   * non-failed state; it can include a failed SIGTERM followed by delivered
   * SIGKILL, so operator displays must keep per-signal attempts visible.
   */
  status: StopSignalDeliveryStatus;
  reason: StopReason;
  attemptedAt: string;
  workspacePath: string | null;
  attempts: StopSignalDeliveryAttempt[];
  warning: string | null;
  laneJobId?: string | null;
  laneCancellation?: {
    state: string;
    killed: boolean;
    failure: string | null;
  };
}

export function laneJobMetadata(
  laneJobId: string | null | undefined,
): Record<string, string> {
  return laneJobId === undefined || laneJobId === null ? {} : { laneJobId };
}

export function isStopSignalDelivery(
  value: unknown,
): value is StopSignalDelivery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StopSignalDelivery>;
  return (
    isStopSignalDeliveryStatus(candidate.status) &&
    isStopReason(candidate.reason) &&
    isValidTimestamp(candidate.attemptedAt) &&
    (typeof candidate.workspacePath === "string" ||
      candidate.workspacePath === null) &&
    Array.isArray(candidate.attempts) &&
    candidate.attempts.every(isStopSignalDeliveryAttempt) &&
    isStopSignalDeliveryStatusConsistent(
      candidate.status,
      candidate.attempts,
      candidate.warning,
      candidate.laneCancellation,
    ) &&
    (typeof candidate.warning === "string" || candidate.warning === null) &&
    (candidate.laneJobId === undefined ||
      candidate.laneJobId === null ||
      (typeof candidate.laneJobId === "string" &&
        candidate.laneJobId.trim().length > 0)) &&
    (candidate.laneCancellation === undefined ||
      (typeof candidate.laneCancellation === "object" &&
        candidate.laneCancellation !== null &&
        typeof candidate.laneCancellation.state === "string" &&
        typeof candidate.laneCancellation.killed === "boolean" &&
        (candidate.laneCancellation.failure === null ||
          typeof candidate.laneCancellation.failure === "string")))
  );
}

export function isEmergencyStopTerminationConfirmed(value: unknown): boolean {
  if (!isStopSignalDelivery(value)) {
    return false;
  }
  if (value.laneCancellation?.killed === true && value.status === "delivered") {
    return true;
  }
  return (
    (value.status === "delivered" &&
      value.attempts.length > 0 &&
      value.attempts.every(
        (attempt) =>
          attempt.sigkill !== "failed" &&
          (attempt.sigterm === "delivered" || attempt.sigkill === "delivered"),
      )) ||
    (value.status === "already_exited" &&
      value.attempts.length > 0 &&
      value.attempts.every(
        (attempt) =>
          attempt.sigterm === "already_exited" ||
          attempt.sigkill === "already_exited",
      ))
  );
}

function isStopSignalDeliveryStatus(
  value: unknown,
): value is StopSignalDeliveryStatus {
  return (
    value === "not_attempted" ||
    value === "already_exited" ||
    value === "delivered" ||
    value === "partial" ||
    value === "failed"
  );
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStopSignalDeliveryAttempt(
  value: unknown,
): value is StopSignalDeliveryAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StopSignalDeliveryAttempt>;
  if (
    !isSignalTargetId(candidate.pid) ||
    !(
      candidate.processGroupId === null ||
      isSignalTargetId(candidate.processGroupId)
    ) ||
    !isAttemptedStopSignalStatus(candidate.sigterm) ||
    !isStopSignalStatus(candidate.sigkill)
  ) {
    return false;
  }
  return candidate.sigterm === "delivered" ||
    candidate.sigterm === "already_exited"
    ? true
    : candidate.sigkill !== "not_attempted";
}

function isSignalTargetId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 1;
}

function isAttemptedStopSignalStatus(
  value: unknown,
): value is Exclude<StopSignalStatus, "not_attempted"> {
  return (
    value === "delivered" || value === "already_exited" || value === "failed"
  );
}

function isStopSignalStatus(value: unknown): value is StopSignalStatus {
  return (
    value === "delivered" ||
    value === "already_exited" ||
    value === "failed" ||
    value === "not_attempted"
  );
}

function isStopSignalDeliveryStatusConsistent(
  status: StopSignalDeliveryStatus,
  attempts: StopSignalDeliveryAttempt[],
  warning: StopSignalDelivery["warning"] | undefined,
  laneCancellation: StopSignalDelivery["laneCancellation"] | undefined,
): boolean {
  if (attempts.length === 0) {
    if (laneCancellation !== undefined) {
      return (
        status === "delivered" ||
        status === "already_exited" ||
        (status === "failed" && typeof warning === "string")
      );
    }
    return (
      status === "not_attempted" ||
      (status === "failed" && typeof warning === "string")
    );
  }
  return status === deriveAttemptedStopSignalDeliveryStatus(attempts);
}

export function deriveAttemptedStopSignalDeliveryStatus(
  attempts: readonly StopSignalDeliveryAttempt[],
): Exclude<StopSignalDeliveryStatus, "not_attempted"> | null {
  if (attempts.length === 0) {
    return null;
  }
  const failedAttempts = getFailedStopSignalDeliveryAttempts(attempts);
  if (failedAttempts.length === 0) {
    return attempts.some(
      (attempt) =>
        attempt.sigterm === "delivered" || attempt.sigkill === "delivered",
    )
      ? "delivered"
      : "already_exited";
  }
  return failedAttempts.length === attempts.length ? "failed" : "partial";
}

export function getFailedStopSignalDeliveryAttempts(
  attempts: readonly StopSignalDeliveryAttempt[],
): StopSignalDeliveryAttempt[] {
  return attempts.filter((attempt) => attempt.sigkill === "failed");
}
