import type { StandingPlan } from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// 6b — Doc-comment → typed-intent resolution (SYMPH-791), pure core.
//
// Resolves an operator comment on the living control doc to a typed plan-control
// intent. Honors "no ambient control surfaces": author-gated (operator
// allowlist; the agent identity is not on it → cannot self-approve) and
// revision-bound (a comment predating the current revision is stale, never
// executed — re-present instead). Marker resolution tolerates Linear stripping
// backticks/formatting from quotedText.
// ---------------------------------------------------------------------------

export interface DocCommentInput {
  body: string;
  quotedText: string | null;
  authorEmail: string | null;
  createdAt: string;
}

export type DocCommentResolution =
  | {
      kind: "intent";
      optionMarker: string;
      verb: string;
      batchId: string | null;
    }
  | { kind: "ignored"; reason: "non_operator" }
  | { kind: "stale"; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "free_text"; text: string };

export function resolveDocComment(input: {
  comment: DocCommentInput;
  plan: StandingPlan;
  operatorAllowlist: ReadonlySet<string>;
}): DocCommentResolution {
  // Author gate: only operator-allowlisted authors can drive control actions.
  const email = input.comment.authorEmail?.trim().toLowerCase() ?? null;
  if (email === null || !input.operatorAllowlist.has(email)) {
    return { kind: "ignored", reason: "non_operator" };
  }

  // Revision binding: a comment created before the current revision's options
  // were rendered cannot resolve against them (the [opt-N] markers reset each
  // revision). Re-present, never execute.
  const commentMs = Date.parse(input.comment.createdAt);
  const revisionMs = Date.parse(input.plan.updatedAt);
  if (
    Number.isNaN(commentMs) ||
    (!Number.isNaN(revisionMs) && commentMs < revisionMs)
  ) {
    return { kind: "stale", reason: "comment predates the current revision" };
  }

  // Marker match across quotedText + body, tolerant of backtick/format stripping.
  const haystack = normalize(
    `${input.comment.quotedText ?? ""}\n${input.comment.body}`,
  );
  const matched = input.plan.options.filter((option) =>
    markerMatches(option.marker, haystack),
  );
  if (matched.length > 1) {
    return { kind: "ambiguous", reason: "multiple option markers matched" };
  }
  if (matched.length === 1) {
    const option = matched[0];
    if (option?.intent) {
      return {
        kind: "intent",
        optionMarker: option.marker,
        verb: option.intent.verb,
        batchId: option.intent.batchId,
      };
    }
    // An option with no typed intent → treat as free text (guarded confirm).
    return { kind: "free_text", text: input.comment.body };
  }

  // No marker → free text → interpret-then-confirm upstream.
  return { kind: "free_text", text: input.comment.body };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/`/g, "");
}

/** Match a marker like "[opt-1]" by its core token ("opt-1"), bracket-agnostic. */
function markerMatches(marker: string, normalizedHaystack: string): boolean {
  const core = marker.toLowerCase().replace(/[[\]]/g, "");
  if (core.length === 0) {
    return false;
  }
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Boundaries that are not word chars or hyphens, so "opt-1" ≠ "opt-10".
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(normalizedHaystack);
}
