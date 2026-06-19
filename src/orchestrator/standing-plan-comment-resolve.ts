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

  const quoted = normalize(input.comment.quotedText ?? "");
  const body = normalize(input.comment.body);

  // Revision-stamped markers are the strong binding. The doc renders each option
  // as "[opt-N:rREV]" (see standing-plan-doc-render), so a comment quoting a
  // SUPERSEDED revision's line carries the old REV and cannot resolve against
  // the current revision's reused [opt-N] — closing the record→publish race
  // (council R1, Codex P1).
  const stamped = [
    ...extractStampedMarkers(quoted),
    ...extractStampedMarkers(body),
  ];
  if (stamped.length > 0) {
    const current = stamped.filter((m) => m.revision === input.plan.revision);
    if (current.length === 0) {
      return {
        kind: "stale",
        reason: "comment references a superseded revision's options",
      };
    }
    const cores = new Set(current.map((m) => m.optionCore));
    if (cores.size > 1) {
      return {
        kind: "ambiguous",
        reason: "multiple current-revision markers matched",
      };
    }
    return resolveByCore([...cores][0] ?? "", input.plan, input.comment.body);
  }

  // No revision stamp → a bare "opt-N" the operator typed. Prefer the quoted
  // line (the specific option replied to) over the body (council R1, Pi P2).
  const quotedMatches = matchOptionCores(input.plan.options, quoted);
  const bodyMatches = matchOptionCores(input.plan.options, body);
  const matched = quotedMatches.length > 0 ? quotedMatches : bodyMatches;
  if (matched.length > 1) {
    return { kind: "ambiguous", reason: "multiple option markers matched" };
  }
  if (matched.length === 1) {
    return resolveByCore(matched[0] ?? "", input.plan, input.comment.body);
  }
  return { kind: "free_text", text: input.comment.body };
}

function resolveByCore(
  core: string,
  plan: StandingPlan,
  body: string,
): DocCommentResolution {
  const option = plan.options.find((o) => markerCore(o.marker) === core);
  if (option?.intent) {
    return {
      kind: "intent",
      optionMarker: option.marker,
      verb: option.intent.verb,
      batchId: option.intent.batchId,
    };
  }
  // An option with no typed intent → treat as free text (guarded confirm).
  return { kind: "free_text", text: body };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/`/g, "");
}

/** The bracket-free core of a marker, e.g. "[opt-1]" → "opt-1". */
function markerCore(marker: string): string {
  return marker.toLowerCase().replace(/[[\]]/g, "");
}

/** Revision-stamped markers ("opt-1:r4") in normalized text. */
function extractStampedMarkers(
  normalizedText: string,
): Array<{ optionCore: string; revision: number }> {
  const out: Array<{ optionCore: string; revision: number }> = [];
  const regex = /(opt-\d+):r(\d+)/g;
  let match: RegExpExecArray | null = regex.exec(normalizedText);
  while (match !== null) {
    out.push({ optionCore: match[1] ?? "", revision: Number(match[2]) });
    match = regex.exec(normalizedText);
  }
  return out;
}

function matchOptionCores(
  options: StandingPlan["options"],
  normalizedText: string,
): string[] {
  return options
    .filter((option) => markerMatches(option.marker, normalizedText))
    .map((option) => markerCore(option.marker));
}

/** Match a bare marker core ("opt-1") with boundaries so "opt-1" ≠ "opt-10". */
function markerMatches(marker: string, normalizedHaystack: string): boolean {
  const core = markerCore(marker);
  if (core.length === 0) {
    return false;
  }
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(normalizedHaystack);
}
