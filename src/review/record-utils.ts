/**
 * SYMPH-855 Track (c) — shared record/value coercion helpers for the crabrunner
 * review job group and its browser-QA evidence module.
 *
 * SYMPH-810 introduced identical `recordOrNull` / `readString` helpers in both
 * `crabrunner-review-job-group.ts` and `qa-evidence.ts`. The council flagged the
 * duplication as carry-forward work; these are the single canonical copies both
 * modules import so the parsing behaviour cannot drift between them.
 */

/**
 * Narrow an unknown value to a plain object record, or null. Arrays and
 * non-objects (including `null`) return null so callers can fail closed on a
 * value that is not a parseable record.
 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a string value, coercing any non-string (including absence) to "". */
export function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
