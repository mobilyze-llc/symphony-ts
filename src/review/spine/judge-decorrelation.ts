/**
 * SYMPH-925 — deterministic judge-family decorrelation precondition.
 *
 * Crucible's load-bearing invariant (MOB-379 → MOB-386): decorrelation is a
 * property of the JUDGE that decides what blocks, NOT of the finder that only
 * raises signal. The finder set stays signal-first (it keeps the author's own
 * model family — "Codex always finds"); only the escalate-bucket JUDGE/cross-
 * examiner must exclude the executor/author family, keyed on the executor
 * (code-writing) family, and FAIL CLOSED when that family cannot be keyed.
 *
 * Symphony already enforces decorrelation at the FINDER layer (the routing
 * guarantee in `review-verdict.ts` keyed on `SYMPHONY_COUNCIL_AUTHOR_FAMILY`),
 * which gives decorrelated COVERAGE. This module adds the missing decorrelated
 * ADJUDICATION precondition: it is what the standalone aggregator checks before
 * it lets a judge adjudicate the escalate bucket.
 *
 * NATIVE-vs-SEAM decision (AC2): this is enforced NATIVELY in TypeScript rather
 * than by threading executor/caller model context over the spine seam into
 * crucible's `resolveCouncilLanes()`. Symphony never calls `resolveCouncilLanes`
 * — it only shells the three pure spine subcommands (`council-triage`,
 * `cross-exam-select`, `convergence-decision`) — so there is no seam over which
 * to thread the executor model, and doing so would inherit crucible's caller-
 * model env-leak hazard. The fail-closed reasons here intentionally mirror
 * crucible's `COUNCIL_DECORRELATION_UNSATISFIED` reason vocabulary
 * (`decorrelation_unkeyed`, `no_non_author_finder`/`insufficient_decorrelated_
 * authority`) AND Symphony's own finder-layer `routing_author_provenance_missing`
 * degraded-condition style, so this seam stays legible to both canons.
 *
 * ENV-LEAK HAZARD (MOB-399/392): crucible derives the caller model from process
 * env (`CLAUDECODE`, `CODEX_HOME`), and under Claude Code that env can LEAK and
 * flip decorrelation results. Symphony deliberately keys the author/executor
 * family from EXPLICIT review provenance (`SYMPHONY_COUNCIL_AUTHOR_FAMILY` /
 * `inferAuthorFamilies`), never from ambient process env — so threading a
 * judge/author family in here MUST stay explicit-input-only. Do not add a
 * `process.env`-derived fallback to this module; that would re-import the
 * MOB-399/392 hazard the native seam exists to avoid.
 */

/**
 * The deterministic family-exclusion reasons. The precondition is UNSATISFIED
 * (fail-closed) whenever any of these holds; `null` means the judge is proven
 * decorrelated and may adjudicate.
 *
 * - `judge_author_family_missing` — the author/executor family is unknown or
 *   unkeyable (mirrors crucible `decorrelation_unkeyed` and Symphony's
 *   `routing_author_provenance_missing`). Cannot prove exclusion → fail closed.
 * - `judge_family_missing` — the judge's own model family is unknown or
 *   unkeyable. Cannot prove the judge differs → fail closed.
 * - `judge_same_family_as_author` — the judge's family equals the author/
 *   executor family (mirrors crucible `insufficient_decorrelated_authority` /
 *   `no_non_author_finder`). A same-family judge is a conflict of interest →
 *   fail closed.
 */
export type JudgeDecorrelationUnsatisfiedReason =
  | "judge_author_family_missing"
  | "judge_family_missing"
  | "judge_same_family_as_author";

export interface JudgeDecorrelationInput {
  /**
   * The author/executor (code-writing) model family. Resolved from EXPLICIT
   * review provenance only (`SYMPHONY_COUNCIL_AUTHOR_FAMILY` /
   * `inferAuthorFamilies`), never from ambient process env (MOB-399/392).
   */
  authorFamily?: string | null;
  /** The escalate-bucket judge's own model family (or a raw model spec). */
  judgeFamily?: string | null;
}

export interface JudgeDecorrelationDecision {
  /**
   * `true` only when the author family is keyed, the judge family is keyed, and
   * the two differ — i.e. the judge is provably outside the author/executor
   * family. `false` is always fail-closed (a degraded outcome, never a silent
   * pass).
   */
  satisfied: boolean;
  /** The fail-closed reason when `satisfied` is false; `null` when satisfied. */
  reason: JudgeDecorrelationUnsatisfiedReason | null;
  /** The normalized author/executor family (or `null` when unkeyable). */
  authorFamily: string | null;
  /** The normalized judge family (or `null` when unkeyable). */
  judgeFamily: string | null;
}

/**
 * Normalize a raw model/family spec into Symphony's canonical model-family
 * vocabulary — the SAME hyphenated family identities the finder-layer routing
 * guarantee already uses (`provenanceModelFamily` / `modelFamilyForLane` in
 * `headless-council-gate.ts`): `openai-codex`, `anthropic`, `pi`,
 * `moonshot-kimi`. This keeps the judge precondition keyed on the exact family
 * identity that `SYMPHONY_COUNCIL_AUTHOR_FAMILY` and the finder decorrelation
 * basis are keyed on, so a judge cannot be "decorrelated" under one normalizer
 * and same-family under another.
 *
 * Deliberately NOT crucible's colon/tier form (`anthropic:opus`,
 * `openai:codex`): the author family entering this seam is Symphony's
 * provenance family, so both sides must normalize to Symphony's vocabulary.
 *
 * FAIL CLOSED on BOTH unrecognized AND ambiguous specs (SYMPH-925, council P2):
 * - UNRECOGNIZED — a spec matching ZERO recognized families is `null`. An
 *   unrecognized string is never trusted as a distinct identity (else two
 *   same-provider specs like `mistral-large` / `mistral/small` would read as
 *   different families and let an undecorrelated judge run).
 * - AMBIGUOUS — a spec matching tokens from MORE THAN ONE recognized family
 *   (e.g. `moonshot-codex` matches both `codex`→openai and `moonshot`→moonshot)
 *   is `null`, NOT the first matcher to fire. Order-dependent first-match would
 *   let a substring hijack the family (`moonshot-codex`→`openai-codex`) and
 *   again mis-read same-provider specs as different. If we cannot prove a SINGLE
 *   family, we cannot prove decorrelation → fail closed.
 *
 * Both make `decideJudgeDecorrelation` fail closed. A new model family must be
 * added to `FAMILY_MATCHERS` EXPLICITLY to stay provable.
 */

/**
 * The recognized model-family matchers, evaluated as an UNORDERED set (not a
 * first-match cascade) so a multi-family spec is detected as ambiguous rather
 * than silently keyed by whichever pattern happens to be listed first.
 */
const FAMILY_MATCHERS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  {
    family: "openai-codex",
    pattern: /(?:^|[^a-z0-9])(?:codex|openai|gpt)(?=$|[^a-z0-9])/,
  },
  {
    family: "anthropic",
    pattern:
      /(?:^|[^a-z0-9])(?:anthropic|claude|opus|sonnet|haiku|fable)(?=$|[^a-z0-9])/,
  },
  {
    family: "moonshot-kimi",
    pattern: /(?:^|[^a-z0-9])(?:moonshot|kimi)(?=$|[^a-z0-9])/,
  },
  { family: "pi", pattern: /(?:^|[^a-z0-9])(?:deepseek|pi)(?=$|[^a-z0-9])/ },
];

export function normalizeJudgeFamily(
  spec: string | null | undefined,
): string | null {
  if (spec === null || spec === undefined) {
    return null;
  }
  const raw = spec.trim().toLowerCase();
  if (raw === "") {
    return null;
  }
  // Already-normalized canonical families pass through unchanged. (These are the
  // exact `FAMILY_MATCHERS` family ids; e.g. canonical "pi" must not be read as
  // ambiguous just because some other token also matches.)
  if (
    raw === "openai-codex" ||
    raw === "anthropic" ||
    raw === "pi" ||
    raw === "moonshot-kimi"
  ) {
    return raw;
  }
  // Evaluate ALL matchers and collect the DISTINCT families matched. Return the
  // family iff EXACTLY ONE matched: zero → unrecognized → null; two-or-more →
  // ambiguous → null. Both fail closed in `decideJudgeDecorrelation`.
  const matched = new Set<string>();
  for (const matcher of FAMILY_MATCHERS) {
    if (matcher.pattern.test(raw)) {
      matched.add(matcher.family);
    }
  }
  if (matched.size !== 1) {
    return null;
  }
  // Exactly one family matched.
  return [...matched][0] ?? null;
}

/**
 * Decide whether the escalate-bucket judge is provably decorrelated from the
 * author/executor family. FAIL-CLOSED: returns `satisfied: false` (with a
 * reason) whenever the author family is unkeyable (unrecognized OR ambiguous),
 * the judge family is unkeyable (unrecognized OR ambiguous), or the two are the
 * same family. Only an explicitly-keyed, single-family, different-family judge is
 * `satisfied: true`.
 */
export function decideJudgeDecorrelation(
  input: JudgeDecorrelationInput,
): JudgeDecorrelationDecision {
  const authorFamily = normalizeJudgeFamily(input.authorFamily);
  const judgeFamily = normalizeJudgeFamily(input.judgeFamily);
  if (authorFamily === null) {
    return {
      satisfied: false,
      reason: "judge_author_family_missing",
      authorFamily,
      judgeFamily,
    };
  }
  if (judgeFamily === null) {
    return {
      satisfied: false,
      reason: "judge_family_missing",
      authorFamily,
      judgeFamily,
    };
  }
  if (judgeFamily === authorFamily) {
    return {
      satisfied: false,
      reason: "judge_same_family_as_author",
      authorFamily,
      judgeFamily,
    };
  }
  return { satisfied: true, reason: null, authorFamily, judgeFamily };
}
