/**
 * Structured view over the opaque Codex rate-limit snapshot blob.
 *
 * The Codex app-server reports account-level subscription window usage as
 * `rate_limits` / `rateLimits` payloads. Observed production shape (rollout
 * ledger, SYMPH-319 canaries):
 *
 *   {
 *     "limit_id": "codex",
 *     "primary":   { "used_percent": 39.0, "window_minutes": 300,   "resets_at": 1781093929 },
 *     "secondary": { "used_percent": 97.0, "window_minutes": 10080, "resets_at": 1781137743 },
 *     "plan_type": "pro"
 *   }
 *
 * `primary` is the short (5-hour) window, `secondary` the weekly window.
 * Field casing is not guaranteed across protocol surfaces (SYMPH-319 found
 * codex emitting snake_case where Anthropic shapes use camelCase), so both
 * alias forms are accepted per field.
 */

export interface RateLimitWindow {
  /** Share of the window already consumed, clamped to 0-100. */
  usedPercent: number;
  windowMinutes: number | null;
  /** Window reset time in epoch seconds. */
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

/**
 * Running observation of one rate-limit window across a unit of work.
 * `startPercent` re-baselines when the window resets mid-run, so
 * `latestPercent - startPercent` is always the burn within the current
 * window, never a negative artifact of a rollover.
 */
export interface RateLimitWindowObservation {
  startPercent: number;
  latestPercent: number;
  lastResetsAt: number | null;
}

export function parseRateLimitSnapshot(raw: unknown): RateLimitSnapshot | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }

  const primary = parseWindow(record.primary);
  const secondary = parseWindow(record.secondary);
  if (primary === null && secondary === null) {
    return null;
  }

  return { primary, secondary };
}

export function observeRateLimitWindow(
  previous: RateLimitWindowObservation | null,
  window: RateLimitWindow,
): RateLimitWindowObservation {
  if (previous === null) {
    return {
      startPercent: window.usedPercent,
      latestPercent: window.usedPercent,
      lastResetsAt: window.resetsAt,
    };
  }

  // used_percent is monotonic within one window; a drop (or a later
  // resets_at) means the window rolled over and prior burn was freed, so the
  // baseline must follow the new window.
  const windowRolledOver =
    window.usedPercent < previous.latestPercent ||
    (window.resetsAt !== null &&
      previous.lastResetsAt !== null &&
      window.resetsAt > previous.lastResetsAt);

  return {
    startPercent: windowRolledOver ? window.usedPercent : previous.startPercent,
    latestPercent: window.usedPercent,
    lastResetsAt: window.resetsAt ?? previous.lastResetsAt,
  };
}

/** Burn within the currently observed window, in percent points (>= 0). */
export function observedWindowDeltaPercent(
  observation: RateLimitWindowObservation | null,
): number {
  if (observation === null) {
    return 0;
  }
  return Math.max(0, observation.latestPercent - observation.startPercent);
}

export interface RateLimitWindowHeadroom {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  /** True when resets_at has passed: the snapshot no longer binds. */
  expired: boolean;
}

export function evaluateWindowHeadroom(
  window: RateLimitWindow | null,
  nowMs: number,
): RateLimitWindowHeadroom | null {
  if (window === null) {
    return null;
  }

  return {
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    resetsAt: window.resetsAt,
    expired: window.resetsAt !== null && window.resetsAt * 1000 <= nowMs,
  };
}

function parseWindow(raw: unknown): RateLimitWindow | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }

  const usedPercent = readAliasedNumber(record, [
    "used_percent",
    "usedPercent",
  ]);
  if (usedPercent === null) {
    return null;
  }

  const resetsAtRaw = readAliasedNumber(record, ["resets_at", "resetsAt"]);
  return {
    usedPercent: Math.min(Math.max(usedPercent, 0), 100),
    windowMinutes: readAliasedNumber(record, [
      "window_minutes",
      "windowMinutes",
      "windowDurationMins",
    ]),
    // Tolerate epoch milliseconds: anything past ~33658 CE in seconds is
    // unambiguously a milliseconds timestamp.
    resetsAt:
      resetsAtRaw !== null && resetsAtRaw > 1e12
        ? Math.floor(resetsAtRaw / 1000)
        : resetsAtRaw,
  };
}

function readAliasedNumber(
  record: Record<string, unknown>,
  aliases: readonly string[],
): number | null {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
