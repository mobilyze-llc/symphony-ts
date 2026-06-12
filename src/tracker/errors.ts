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

const TRACKER_ERROR_TRUNCATION_MARKER = "…[truncated]";

/**
 * Serialize an unknown error-details payload into a bounded, readable string
 * for journal events. Plain `String(object)` yields "[object Object]"
 * (SYMPH-413) — this JSON-stringifies objects, substitutes an explicit
 * placeholder for circular structures (never `String()`, which is the
 * "[object Object]" failure mode this fixes), and truncates with an ellipsis
 * marker when over the bound. The returned string never exceeds `maxLength`
 * (marker included), is trimmed so leading whitespace can't consume the budget
 * and hide the useful error text, and never ends on a split UTF-16 surrogate.
 * Returns null when there is nothing useful to record.
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
      serialized = "[unserializable tracker error details]";
    }
  }

  serialized = serialized.trim();
  if (serialized.length === 0) {
    return null;
  }

  if (serialized.length <= maxLength) {
    return serialized;
  }

  // Reserve room for the marker so the total output stays within maxLength,
  // and step back off a lone high surrogate so truncation never emits a
  // split UTF-16 surrogate pair.
  let cut = Math.max(maxLength - TRACKER_ERROR_TRUNCATION_MARKER.length, 0);
  const lastCode = cut > 0 ? serialized.charCodeAt(cut - 1) : 0;
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut -= 1;
  }
  return `${serialized.slice(0, cut)}${TRACKER_ERROR_TRUNCATION_MARKER}`;
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
