/**
 * Egress hardening for model/worker-authored text (SYMPH-421).
 *
 * Every place the orchestrator interpolates text it did not author —
 * judge rationales, gate feedback, worker failure reasons — into an
 * external surface (Linear comments, Slack notifications) routes through
 * one of these helpers. The threats are concrete:
 *
 * - Injection round-trip: rework prompts re-consume Linear comments, so a
 *   triple-backtick fence in a "rationale" can smuggle instructions back
 *   into a downstream prompt.
 * - Link smuggling: markdown links render as innocuous labels over
 *   attacker-chosen URLs.
 * - Secret exfiltration: a worker with env access can echo tokens into
 *   any free-text field the orchestrator forwards verbatim.
 * - Unbounded payloads: a 100k-char "reason" floods a comment thread or
 *   a Slack channel.
 *
 * Contract: CLEAN TEXT PASSES THROUGH BYTE-IDENTICAL. A normal one- or
 * two-sentence rationale must not be altered — sanitization only rewrites
 * text that exhibits one of the threat shapes above.
 */

export interface SanitizeOptions {
  /** Maximum output length before the truncation marker is appended. */
  maxLen?: number;
}

export const DEFAULT_LINEAR_MAX_LEN = 2000;
export const DEFAULT_SLACK_MAX_LEN = 500;

const TRUNCATION_MARKER = "\n…[truncated by egress cap]";

/**
 * `key=value` / `key: value` pairs whose key looks credential-shaped.
 * The value is replaced, the key survives so the operator can see WHAT
 * leaked without the leak itself.
 */
const SECRET_ASSIGNMENT_REGEX =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*)(\s*[=:]\s*)(["']?)[^\s"'`]+\3/gi;

/**
 * Long unbroken hex runs (32+): SHA digests are also hex, but a digest in
 * a rationale is rare and redaction is the safe default for key material.
 */
const HEX_RUN_REGEX = /\b[0-9a-fA-F]{32,}\b/g;

/**
 * Long base64/base64url-shaped runs (40+ chars with at least one digit —
 * the digit requirement spares long camelCase identifiers and ordinary
 * words, which are the common false positives).
 */
const BASE64_RUN_REGEX = /\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Markdown links: `[label](url)` → `label (url)`. */
const MARKDOWN_LINK_REGEX = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/** Runs of 3+ backticks — the fence round-trip vector. */
const FENCE_REGEX = /`{3,}/g;

function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_REGEX, "$1$2$3[REDACTED]$3")
    .replace(HEX_RUN_REGEX, "[REDACTED:hex]")
    .replace(BASE64_RUN_REGEX, "[REDACTED:token]");
}

function capLength(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}${TRUNCATION_MARKER}`;
}

/**
 * Sanitize model/worker text bound for a Linear comment body.
 *
 * Order matters: redaction first (so a secret split by a later rewrite
 * cannot dodge the patterns), then fence + link neutralization, then the
 * length cap (so neutralization cannot be truncated half-applied).
 */
export function sanitizeForLinear(
  text: string,
  options?: SanitizeOptions,
): string {
  const maxLen = options?.maxLen ?? DEFAULT_LINEAR_MAX_LEN;
  const cleaned = redactSecrets(text)
    // Neutralize triple-backtick fences: same width, no fence semantics.
    .replace(FENCE_REGEX, (run) => "'".repeat(run.length))
    .replace(MARKDOWN_LINK_REGEX, "$1 ($2)");
  return capLength(cleaned, maxLen);
}

/**
 * Sanitize model/worker text bound for Slack (plain text or mrkdwn).
 *
 * Slack mrkdwn treats `<...>` as link/mention syntax (`<url|label>`,
 * `<!channel>`), so angle brackets and ampersands are HTML-escaped per
 * Slack's escaping rules — display is preserved, syntax is inert.
 */
export function sanitizeForSlack(
  text: string,
  options?: SanitizeOptions,
): string {
  const maxLen = options?.maxLen ?? DEFAULT_SLACK_MAX_LEN;
  const cleaned = redactSecrets(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return capLength(cleaned, maxLen);
}
