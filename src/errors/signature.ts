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
  // Transient — Codex app-server session closed mid-turn (SYMPH-412). The
  // session/process dies under accumulated thread context; the retry runs in a
  // FRESH session, so the repeat of this signature must never be treated as a
  // futile permanent failure by the novelty short-circuit. The stage circuit
  // breaker (SYMPH-398) still bounds systemic recurrence across issues.
  { pattern: /\bcodex_session_closed_mid_turn\b/, class: "transient" },
  {
    pattern: /\bsession closed while a turn was running\b/,
    class: "transient",
  },
  {
    pattern: /\bapp-server exited\b.*\bwhile a turn was running\b/,
    class: "transient",
  },
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
