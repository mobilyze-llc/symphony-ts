import { createHash } from "node:crypto";

/**
 * Classification of a normalized error signature.
 *
 * permanent — the same deterministic failure will recur on every retry
 *   (EPERM/EACCES on fixed paths, unknown flag, auth errors). Retrying without
 *   novel input is futile.
 *
 * transient — the failure may resolve on retry (timeout, 5xx, ECONNRESET, rate
 *   limit). Normal backoff/escalation applies.
 *
 * unknown — cannot classify. Treated conservatively: existing retry logic runs.
 */
export type ErrorSignatureClass = "permanent" | "transient" | "unknown";

export interface NormalizedErrorSignature {
  /** 7-char SHA-1 prefix of the normalized error text. */
  signature: string;
  /** Normalized (human-readable) version of the error text. */
  normalizedText: string;
  class: ErrorSignatureClass;
}

// ---------------------------------------------------------------------------
// Normalization patterns — applied in order before hashing
// ---------------------------------------------------------------------------

/** Absolute paths: /foo/bar/baz or C:\foo\bar */
const RE_ABSOLUTE_PATH = /(?:[A-Za-z]:)?\/(?:[^\s/]+\/)*[^\s/]*/g;

/** UUID v4 */
const RE_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Hex ids: 0x… or bare 8–40 hex chars */
const RE_HEX = /0x[0-9a-f]+|\b[0-9a-f]{8,40}\b/gi;

/** ISO8601 / common timestamp formats */
const RE_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

/** Numbers longer than 1 digit (preserves single-digit context like "1 file") */
const RE_LONG_NUMBER = /\b\d{2,}\b/g;

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

interface ClassificationRule {
  pattern: RegExp;
  class: ErrorSignatureClass;
}

/**
 * Rules are checked in order; the first match wins.
 * Patterns are tested against the raw (un-normalized, lower-cased) text so
 * that numeric patterns (e.g. HTTP 5xx) are not obscured by number-stripping.
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  // Permanent — permission / access denied
  { pattern: /\beperm\b/, class: "permanent" },
  { pattern: /\beacces\b/, class: "permanent" },
  { pattern: /\bpermission denied\b/, class: "permanent" },
  // Transient — rate limits (must precede catch-all auth permanents so that
  // messages like "Forbidden: too many requests" classify as transient)
  { pattern: /\brate.?limit\b/, class: "transient" },
  { pattern: /\btoo many requests\b/, class: "transient" },
  { pattern: /\bquota exceeded\b/, class: "transient" },
  { pattern: /\bthrottle\b/, class: "transient" },
  // Permanent — access / auth (after rate-limit rules)
  { pattern: /\baccess denied\b/, class: "permanent" },
  // Permanent — file not found on a deterministic path
  { pattern: /\benoent\b/, class: "permanent" },
  // Permanent — command/flag errors
  { pattern: /\bcommand not found\b/, class: "permanent" },
  { pattern: /\bunknown flag\b/, class: "permanent" },
  { pattern: /\bunrecognized flag\b/, class: "permanent" },
  { pattern: /\binvalid argument\b/, class: "permanent" },
  { pattern: /\billegal option\b/, class: "permanent" },
  { pattern: /\bno such file or directory\b/, class: "permanent" },
  // Permanent — auth / credentials (after rate-limit rules)
  { pattern: /\bauthentication failed\b/, class: "permanent" },
  { pattern: /\bcredential\b/, class: "permanent" },
  {
    // "unauthorized" but NOT when it's a 429/rate-limit context
    pattern: /\bunauthorized\b(?!.*(?:too many|rate.?limit|429))/,
    class: "permanent",
  },
  {
    // "forbidden" but NOT when it's a too-many-requests context
    pattern: /\bforbidden\b(?!.*(?:too many|rate.?limit|429))/,
    class: "permanent",
  },
  { pattern: /\binvalid token\b/, class: "permanent" },
  // Transient — network / timeout
  { pattern: /\btimeout\b/, class: "transient" },
  { pattern: /\btimedout\b/, class: "transient" },
  { pattern: /\beconnreset\b/, class: "transient" },
  { pattern: /\beconnrefused\b/, class: "transient" },
  { pattern: /\bconnection refused\b/, class: "transient" },
  { pattern: /\bconnection reset\b/, class: "transient" },
  { pattern: /\bsocket hang up\b/, class: "transient" },
  // Transient — HTTP 5xx (scoped to HTTP/status context so bare 5xx PIDs or
  // exit-codes like "process 503 exited" do not get a transient exemption).
  // Covers: "status 503", "status code 503", "http 503",
  //   "Request failed with status code 503" (axios canonical shape).
  {
    pattern: /\b(?:status(?:\s+code)?|http)\s*5\d\d\b/,
    class: "transient",
  },
  { pattern: /\binternal server error\b/, class: "transient" },
  { pattern: /\bservice unavailable\b/, class: "transient" },
  { pattern: /\bbad gateway\b/, class: "transient" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw error message and compute a stable signature.
 *
 * The signature is stable across retries that produce the same *kind* of
 * failure even when the absolute path, UUID, or PID differ — e.g. the SYMPH-332
 * EPERM where `/var/folders/<random>/<random>/…` varied across attempts but the
 * error kind was identical.
 */
export function normalizeErrorSignature(raw: string): NormalizedErrorSignature {
  let text = raw;

  // 1. Strip absolute paths (keep the basename so the error remains readable)
  text = text.replace(RE_ABSOLUTE_PATH, (match) => {
    const raw = match.split(/[\\/]/).filter(Boolean).pop() ?? match;
    // Trim trailing non-path punctuation (quotes, colons) so basenames are clean
    const trimmed = raw.replace(/['"`:,;]+$/, "");
    // Normalize single-digit lock/sock slot numbers so claude.0.lock ≡ claude.1.lock
    const normalized = trimmed.replace(/(\.\d+)\.(lock|sock)$/i, ".<n>.$2");
    return `<path:${normalized}>`;
  });

  // 2. Strip UUIDs
  text = text.replace(RE_UUID, "<uuid>");

  // 3. Strip hex ids (after UUID so we don't double-strip)
  text = text.replace(RE_HEX, "<hex>");

  // 4. Strip timestamps
  text = text.replace(RE_TIMESTAMP, "<ts>");

  // 5. Strip long numbers
  text = text.replace(RE_LONG_NUMBER, "<n>");

  // 6. Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  const normalizedText = text;
  const hash = createHash("sha1").update(normalizedText).digest("hex");
  const signature = hash.slice(0, 7);
  // Classify against the *raw* text so that patterns relying on numbers
  // (e.g. HTTP 5xx status codes) are not obscured by number-stripping.
  const errorClass = classifyRaw(raw);

  return { signature, normalizedText, class: errorClass };
}

function classifyRaw(rawText: string): ErrorSignatureClass {
  const lower = rawText.toLowerCase();
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(lower)) {
      return rule.class;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Review-failure signatures (SYMPH-402)
// ---------------------------------------------------------------------------

/**
 * Signature of a review-stage failure, criterion-aware when possible.
 *
 * When the review worker's failure message quotes EXACTLY ONE frozen
 * acceptance criterion (the pre-gate refusal contract names the missing
 * evidence), the signature hashes that criterion — stable across reworded
 * refusals of the same criterion. When zero or two-or-more criteria match,
 * the refused criterion is not isolatable, so it falls back to the
 * normalized whole-message signature.
 */
export interface ReviewFailureSignature {
  /** 7-char SHA-1 prefix, criterion-set hash or whole-message fallback. */
  signature: string;
  /** Cleaned criterion lines matched in the message (empty on fallback). */
  matchedCriteria: string[];
  /** "permanent" when criterion-matched; fallback uses message classification. */
  class: ErrorSignatureClass;
}

/** Strip list markers, checkboxes, backticks; lowercase; collapse whitespace. */
function cleanCriterionLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replaceAll("`", "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const CRITERION_TAG_REGEX = /\b(?:test|check|judge):/i;

/**
 * Normalize a review-stage failure into a criterion-aware signature
 * (SYMPH-402). Used by the orchestrator to detect an issue looping on the
 * SAME failed pre-gate criterion across rework rounds: a rework cycle
 * (review → implement → review) does not pass through the retry path, so
 * the SYMPH-396 retry-without-novelty short-circuit never sees it.
 */
export function normalizeReviewFailureSignature(
  message: string | null | undefined,
  acSnapshot: string | null,
): ReviewFailureSignature {
  const text =
    message === null || message === undefined || message.trim() === ""
      ? "agent reported failure: review"
      : message;
  if (acSnapshot !== null) {
    const criteria = acSnapshot
      .split("\n")
      .filter((line) => CRITERION_TAG_REGEX.test(line))
      .map(cleanCriterionLine)
      .filter((line) => line.length > 0);
    const cleanedMessage = text
      .replaceAll("`", "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const matched = [
      ...new Set(criteria.filter((c) => cleanedMessage.includes(c))),
    ].sort();
    // Only a SINGLE isolatable criterion is authoritative (SYMPH-402). When a
    // refusal message echoes the whole frozen AC block — or otherwise names
    // two or more criteria — every round matches the same SET regardless of
    // which criterion actually failed, so a set-hash would falsely group
    // rounds that failed on DIFFERENT criteria into one streak and park an
    // issue that is still making progress. Fall back to the whole-message
    // signature in that case; it varies with the actual failure content.
    if (matched.length === 1) {
      const signature = createHash("sha1")
        .update(matched.join("\n"))
        .digest("hex")
        .slice(0, 7);
      return { signature, matchedCriteria: matched, class: "permanent" };
    }
  }
  const fallback = normalizeErrorSignature(text);
  return {
    signature: fallback.signature,
    matchedCriteria: [],
    class: fallback.class,
  };
}
