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
 * Contract: on the LINEAR surfaces, CLEAN TEXT PASSES THROUGH
 * BYTE-IDENTICAL — a normal rationale must not be altered, and diagnostic
 * identifiers (full git SHAs, sha256 digests, long symbol names) must
 * survive because rework prompts re-consume these comments. The Slack
 * surface is NOT byte-identical: it always HTML-escapes `&`, `<`, `>` per
 * Slack mrkdwn rules (display is preserved, link/mention syntax is inert).
 */

export interface SanitizeOptions {
  /** Maximum output length before the truncation marker is appended. */
  maxLen?: number;
}

export const DEFAULT_LINEAR_MAX_LEN = 2000;
export const DEFAULT_SLACK_MAX_LEN = 500;
export const DEFAULT_REWORK_CHANNEL_MAX_LEN = 20000;

const TRUNCATION_MARKER = "\n…[truncated by egress cap]";

/**
 * JWT/JOSE tokens: three dot-separated base64url segments anchored on the
 * standard JOSE header prefix (`eyJ` — base64url of `{"`). High precision:
 * the anchor plus the dotted three-segment shape never matches git SHAs,
 * version strings, or hostnames, so a bare token quoted from an
 * Authorization header redacts even when its segments are pure
 * alphanumeric (which BASE64_RUN_REGEX deliberately ignores).
 */
const JWT_REGEX =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Long base64/base64url-shaped runs (40+ chars). Requires BOTH a digit
 * AND at least one non-alphanumeric token character (`+ / = _ -`):
 * pure-alphanumeric runs — full git SHAs, sha256 digests, long camelCase
 * identifiers, hashed path segments — are routine diagnostic content in a
 * coding orchestrator and are never auto-redacted. This rule is
 * best-effort defense-in-depth only (dotted shapes are handled by the
 * dedicated JWT_REGEX above); redactSecretAssignments is the primary
 * secret control.
 */
const BASE64_RUN_REGEX =
  /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Markdown links: `[label](url)` → `label (url)`. */
const MARKDOWN_LINK_REGEX = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/** Runs of 3+ backticks — the fence round-trip vector. */
const FENCE_REGEX = /`{3,}/g;

function redactSecrets(text: string): string {
  return redactSecretAssignments(text)
    .replace(JWT_REGEX, "[REDACTED:token]")
    .replace(BASE64_RUN_REGEX, "[REDACTED:token]");
}

/**
 * `key=value` / `key: value` pairs whose key looks credential-shaped.
 * The value is replaced, the key survives so the operator can see WHAT
 * leaked without the leak itself.
 */
function redactSecretAssignments(text: string): string {
  let output = "";
  let cursor = 0;
  let index = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (
      !isAssignmentKeyChar(code) ||
      (index > 0 && isAssignmentKeyChar(text.charCodeAt(index - 1)))
    ) {
      index += 1;
      continue;
    }

    const keyStart = index;
    let keyEnd = index + 1;
    while (
      keyEnd < text.length &&
      isAssignmentKeyChar(text.charCodeAt(keyEnd))
    ) {
      keyEnd += 1;
    }

    const key = text.slice(keyStart, keyEnd);
    if (!isSecretAssignmentKey(key)) {
      index = keyEnd;
      continue;
    }

    let valueStart = keyEnd;
    while (
      valueStart < text.length &&
      isAssignmentWhitespace(text.charCodeAt(valueStart))
    ) {
      valueStart += 1;
    }
    const separator = text[valueStart];
    if (separator !== "=" && separator !== ":") {
      index = keyEnd;
      continue;
    }
    valueStart += 1;
    while (
      valueStart < text.length &&
      isAssignmentWhitespace(text.charCodeAt(valueStart))
    ) {
      valueStart += 1;
    }

    const quote =
      text[valueStart] === '"' || text[valueStart] === "'"
        ? text[valueStart]
        : "";
    if (quote !== "") {
      valueStart += 1;
    }

    let valueEnd = valueStart;
    let hasClosingQuote = false;
    if (quote === "") {
      while (
        valueEnd < text.length &&
        !isUnquotedAssignmentValueTerminator(text.charCodeAt(valueEnd))
      ) {
        valueEnd += 1;
      }
    } else {
      while (valueEnd < text.length) {
        const valueChar = text[valueEnd];
        if (valueChar === quote) {
          hasClosingQuote = true;
          break;
        }
        if (valueChar === "`") {
          break;
        }
        valueEnd += 1;
      }
    }

    if (valueEnd === valueStart) {
      index = keyEnd;
      continue;
    }

    const replacementEnd = hasClosingQuote ? valueEnd + 1 : valueEnd;
    output += text.slice(cursor, keyStart);
    output += key;
    output += text.slice(keyEnd, valueStart);
    output += "[REDACTED]";
    if (hasClosingQuote) {
      output += quote;
    }
    cursor = replacementEnd;
    index = replacementEnd;
  }

  if (cursor === 0) {
    return text;
  }
  return `${output}${text.slice(cursor)}`;
}

function isAssignmentKeyChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  );
}

function isAssignmentWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32
  );
}

function isUnquotedAssignmentValueTerminator(code: number): boolean {
  return (
    isAssignmentWhitespace(code) || code === 34 || code === 39 || code === 96
  );
}

function isSecretAssignmentKey(key: string): boolean {
  const lower = key.toLowerCase();
  const compact = lower.split("_").join("").split("-").join("");
  return (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    compact.includes("apikey")
  );
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
 * Full-fidelity variant for rework-channel comments: review findings,
 * rebase diagnostics, and ensemble gate feedback that downstream rework
 * prompts explicitly re-consume. Applies the same neutralization as
 * sanitizeForLinear — fences, links, credential redaction — but with a
 * large cap so multi-file findings survive intact.
 */
export function sanitizeForReworkChannel(text: string): string {
  return sanitizeForLinear(text, { maxLen: DEFAULT_REWORK_CHANNEL_MAX_LEN });
}

/**
 * Escape the three Slack mrkdwn control characters (`& < >`) so display text
 * is preserved but link/mention syntax (`<url|label>`, `<!channel>`) is inert.
 * Shared by sanitizeForSlack and by callers that build a structured link from
 * fields that must NOT pass through secret redaction (e.g. a trusted URL whose
 * long path would otherwise be shredded by BASE64_RUN_REGEX).
 */
export function escapeSlackControlChars(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const cleaned = escapeSlackControlChars(redactSecrets(text));
  return capLength(cleaned, maxLen);
}
