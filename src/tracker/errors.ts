import { ERROR_CODES, type ErrorCode } from "../errors/codes.js";

export interface TrackerErrorOptions {
  cause?: unknown;
  details?: unknown;
  status?: number;
}

export class TrackerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly status: number | null;

  constructor(
    code: ErrorCode,
    message: string,
    options: TrackerErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TrackerError";
    this.code = code;
    this.details = options.details ?? null;
    this.status = options.status ?? null;
  }
}

/** Default bound for serialized tracker error details in journal events. */
export const TRACKER_ERROR_DETAILS_MAX_LENGTH = 2_000;

/**
 * Serialize an unknown error-details payload into a bounded, readable string
 * for journal events. Plain `String(object)` yields "[object Object]"
 * (SYMPH-413) — this JSON-stringifies objects, falls back to String() for
 * circular structures, and truncates with an ellipsis marker when over the
 * bound. Returns null when there is nothing useful to record.
 */
export function serializeTrackerErrorDetails(
  details: unknown,
  maxLength: number = TRACKER_ERROR_DETAILS_MAX_LENGTH,
): string | null {
  if (details === undefined || details === null) {
    return null;
  }

  let serialized: string;
  if (typeof details === "string") {
    serialized = details;
  } else {
    try {
      serialized =
        JSON.stringify(details) ?? "[unserializable tracker error details]";
    } catch {
      // Circular or otherwise non-JSON-serializable — never fall back to
      // String(), which is the "[object Object]" failure mode this fixes.
      serialized = "[unserializable tracker error details]";
    }
  }

  if (serialized.trim().length === 0) {
    return null;
  }

  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}…[truncated]`
    : serialized;
}

export function toTrackerRequestError(error: unknown): TrackerError {
  if (error instanceof TrackerError) {
    return error;
  }

  return new TrackerError(
    ERROR_CODES.linearApiRequest,
    "Linear request failed before a valid response was received.",
    { cause: error },
  );
}
