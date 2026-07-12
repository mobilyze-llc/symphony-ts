export const ALTITUDE_RELIABILITY_VERDICTS = [
  "kill",
  "keep",
  "reframe",
] as const;

export type AltitudeReliabilityVerdict =
  (typeof ALTITUDE_RELIABILITY_VERDICTS)[number];

export const ALTITUDE_RELIABILITY_PROTOCOL = "snapshot-v1" as const;

interface AltitudeReliabilitySnapshot {
  title: string;
  description: string;
  cutoff: string;
  source: string;
  reconstructedAt: string;
  reconstructionNote: string;
  answerIntroducedAt: string;
}

export interface AltitudeReliabilityContractViolation {
  type: "output_contract_violation";
  detail: string;
}

export type AltitudeReliabilityVerdictObservation =
  | AltitudeReliabilityVerdict
  | {
      verdict: AltitudeReliabilityVerdict;
      contractViolation: AltitudeReliabilityContractViolation;
    };

export interface AltitudeReliabilityCase {
  issueIdentifier: string;
  expectedVerdict: AltitudeReliabilityVerdict;
  snapshot: AltitudeReliabilitySnapshot;
}

const RECONSTRUCTION_NOTE =
  "Reconstructed on 2026-07-12 from the current Linear title and description fields through Printing Press Linear. The supported CLI exposes no description revision history; comments, workflow state, and expected verdict were excluded. The fields retain the original issue problem statement, but this is not claimed as a historical export.";

export const ALTITUDE_RELIABILITY_CORPUS: readonly AltitudeReliabilityCase[] = [
  {
    issueIdentifier: "SYMPH-941",
    expectedVerdict: "kill",
    snapshot: {
      cutoff: "2026-06-28T06:30:27.655Z",
      answerIntroducedAt: "2026-06-28T06:30:27.656Z",
      source:
        "Linear issue https://linear.app/mobilyze-llc/issue/SYMPH-941/symph-939-follow-up-hot-file-reader-v1-hardening-crlf-tolerance",
      reconstructedAt: "2026-07-12T14:33:00Z",
      reconstructionNote: RECONSTRUCTION_NOTE,
      title:
        "SYMPH-939 follow-up: hot-file-reader v1 hardening (CRLF tolerance + maxDays test)",
      description: `Non-blocking **Track** findings from the decorrelated council-flow review of #668 (head \`cce7149\`), filed to Triage per the triage-intake policy (out-of-band planner promotes or declines).

**Source:** crabbox-council review of SYMPH-939 PR #668. Reviewers: codex@pro16, deepseek@studio1, ornith@studio2. Scope: \`src/agent/health/hot-file-reader.ts\` (the bounded git-churn reader added in SYMPH-939 v1). Neither finding is reachable on the current macOS/Linux controller; both are defensive hardening.

**Acceptance criteria:**

- [ ] **CRLF tolerance** (ornith P3): the numstat parse regex \`/^(\\d+|-)\\t(\\d+|-)\\t(.+)$/\` anchors \`$\` to end-of-string, so on a platform where \`git log --numstat\` emits \`\\r\\n\`, every row is skipped → \`total === 0\` → a silent \`null\` instead of a valid reading. Tolerate a trailing \`\\r\` (split on \`/\\r?\\n/\`, or \`(.+?)\\r?$\`). Add a fixture test with \`\\r\`-terminated numstat lines.
- [ ] \`maxDays\` **direct test coverage** (deepseek Track): \`tests/agent/health/hot-file-reader.test.ts\` exercises \`maxCommits\` and \`timeoutMs\` but never a non-default \`maxDays\`; the \`--since=N days ago\` codepath runs only through the default. Add a test that sets \`maxDays: 1\` against a repo whose only commits are older than 1 day, asserting \`null\` (zero-commit window).

Both are low-risk, isolated to the reader module + its test.`,
    },
  },
  {
    issueIdentifier: "SYMPH-944",
    expectedVerdict: "kill",
    snapshot: {
      cutoff: "2026-06-28T06:30:32.372Z",
      answerIntroducedAt: "2026-06-28T06:30:32.373Z",
      source:
        "Linear issue https://linear.app/mobilyze-llc/issue/SYMPH-944/guard-5-empty-head-defense-assert-canary-heads-are-non-empty-belt-and",
      reconstructedAt: "2026-07-12T14:33:00Z",
      reconstructionNote: RECONSTRUCTION_NOTE,
      title:
        "Guard #5 empty-head defense: assert canary heads are non-empty (belt-and-suspenders, from PR #669 council)",
      description: `Non-blocking **Track** finding from the decorrelated council recheck of PR #669 (mobilyze-llc/symphony-ts), ornith lane. Surfaced during SYMPH-815 (canary-head-stuck re-plan predicate, guard #5).

## Observation

Guard #5 in \`src/orchestrator/standing-plan-consumer.ts\` (\`evaluateReplanPredicates\`) detects a stuck canary head via \`headIssueIdentifiers.some(id => !merged.has(id) && !candidateIdentifiers.has(id) && !running.has(id))\`. It relies on \`Array.prototype.some([]) === false\` for empty-head safety, plus the upstream invariant in \`isPlanBatch\` (\`src/domain/standing-plan.ts:561\`) that a canary-chain batch always carries a non-empty head. There is no **local** assertion of that invariant at the guard.

## Severity: NOT a bug

ornith, verbatim: "Array.prototype.some([]) returns false; empty head = no stuck member detected = no spurious re-plan." The empty-head case is structurally impossible because \`isPlanBatch\` drops canary-chain rows with empty \`headIssueIdentifiers\` on read (\`standing-plan.ts:561-563\`), so it can never become store truth. The behaviour is correct and safe by construction.

## Possible durable follow-up (planner: promote or decline)

* Add a small defensive assertion or a domain test documenting the "canary head is non-empty" invariant that guard #5 leans on, **or**
* Decline: already enforced upstream by \`isPlanBatch\` and safe-by-construction (\`.some([]) === false\`).

## Acceptance criteria (if promoted)

A test or assertion (in \`tests/orchestrator/standing-plan-consumer.test.ts\` or the standing-plan domain tests) that documents/enforces the canary-head non-empty invariant relied on by guard #5.

## Source refs

* PR #669 (mobilyze-llc/symphony-ts), council recheck — ornith lane \`[Track]\`.
* \`src/orchestrator/standing-plan-consumer.ts\` guard #5; \`src/domain/standing-plan.ts\` \`isPlanBatch\`.
* Relates to SYMPH-815; parent epic SYMPH-784 (Queue Triage v2).`,
    },
  },
  {
    issueIdentifier: "SYMPH-958",
    expectedVerdict: "kill",
    snapshot: {
      cutoff: "2026-06-29T04:15:14.734Z",
      answerIntroducedAt: "2026-06-29T04:15:14.735Z",
      source:
        "Linear issue https://linear.app/mobilyze-llc/issue/SYMPH-958/harden-budget-providermodel-resolution-for-non-canonical-uncatalogued",
      reconstructedAt: "2026-07-12T14:33:00Z",
      reconstructionNote: RECONSTRUCTION_NOTE,
      title:
        "Harden budget provider/model resolution for non-canonical + uncatalogued runner models",
      description: `**Problem (council Track findings on PR #678 / SYMPH-955)**

The weighted hard-stops gate resolves a lane to a catalog row via \`resolveBudgetProvider\`/\`resolveBudgetModel\` (\`src/agent/runner.ts:1515\`). Three latent robustness gaps surfaced in the crabbox-council review. **None affect the active runners** — \`codex\` (→ openai) and \`claude-code\` (models \`opus\`/\`sonnet\`, no slash → RunnerKind switch → anthropic) resolve correctly and are enforced — but they are real foot-guns for non-active/future configs:

1. **Non-canonical slash-prefix providers (ornith P2):** \`resolveBudgetProvider\` extracts the provider from a \`provider/model\` string by slash-prefix (\`runner.ts:1523\`). A model like \`claude/sonnet\` (or any non-canonical prefix) with no explicit \`execution.provider\` yields provider \`claude\`, which matches no catalog row (catalog uses \`anthropic\`) → \`basis: none\` → budget gate skipped. Fix: normalize alias prefixes to canonical catalog providers (claude→anthropic, gpt→openai, deepseek-chat→deepseek, …) before catalog lookup.
2. **Uncatalogued provider runners, e.g. gemini (codex P2):** \`gemini\`→\`gemini-2.5-pro\` has no catalog row and no \`weight_ratios\` for its provider family → not enforced. DESIGN DECISION needed: add a catalog row + weight_ratios for gemini/google, OR a documented conservative fallback (e.g. legacy billable-token ceiling) for uncatalogued runners, OR keep conformant not-enforced (matches crucible) but make it explicit. Consistent with the SYMPH-955 operator decision that only catalog-priced lanes are weighted-enforced.
3. **RunnerKind exhaustiveness (deepseek P2):** \`resolveBudgetProvider\`/\`resolveBudgetModel\` have no \`default\` case; a new \`RunnerKind\` would silently propagate \`undefined\`. Add an exhaustiveness guard.

Also document (council): \`normalizeUsageBreakdown\` fail-closed (unclassified remainder → output at the highest weight) — intended, but document the worst-case inflation vs the re-baselined ceiling.

**Mitigations already in place** (why this is Track, not blocking): the active runners resolve correctly (verified); uncatalogued/unmatched lanes fire the \`recordBudgetNotEnforced\` note (observable, not silent); and the token/dollar budget is one of several hard-stops — iteration cap, no-progress, rate-limit, and stall timeouts still bound any not-enforced lane.

**Acceptance criteria**

* \`resolveBudgetProvider\` maps alias prefixes to canonical catalog providers; a \`claude/sonnet\`-style model with no explicit provider resolves to \`anthropic\` and is enforced (unit test).
* A decision + implementation for gemini/uncatalogued-runner enforcement (catalog row, documented fallback, or explicit conformant not-enforced).
* Exhaustiveness guard on the RunnerKind switches; unit test iterating all RunnerKinds asserting string returns.
* \`evaluateBudgetHardStop\` test coverage for the api_token/USD path (gpt-5.5) end-to-end, and a normalizeUsageBreakdown fail-closed test.

**Source refs**

* \`src/agent/runner.ts:1515-1551\` (resolveBudgetProvider/Model), \`src/policy/hard-stops.ts\` (evaluateBudgetHardStop, normalizeUsageBreakdown).
* crabbox-council review of PR #678 (codex/deepseek/ornith). Parent: SYMPH-955.`,
    },
  },
  {
    issueIdentifier: "SYMPH-956",
    expectedVerdict: "keep",
    snapshot: {
      cutoff: "2026-06-29T04:15:40.769Z",
      answerIntroducedAt: "2026-06-29T04:15:40.770Z",
      source:
        "Linear issue https://linear.app/mobilyze-llc/issue/SYMPH-956/tighten-weighted-hard-stops-budgets-from-observed-spend-post-symph-955",
      reconstructedAt: "2026-07-12T14:33:00Z",
      reconstructionNote: RECONSTRUCTION_NOTE,
      title:
        "Tighten weighted hard-stops budgets from observed spend (post-SYMPH-955 re-baseline)",
      description: `**Problem**

SYMPH-955 flips the hard-stops budget gate to the weighted cost-equivalent unit and re-baselines every \`max_tokens_per_unit\` by a **conservative ×6** (the max output weight, OpenAI), guaranteeing the weighted gate fires no earlier than the old billable gate for any token mix/provider. ×6 is a deliberate upper bound chosen because no weighted-unit spend data existed at flip time (the measure did not exist until SYMPH-955 landed). For non-output-heavy units it loosens the effective ceiling up to ~6×, so it should be tightened once real data exists (measure-before-caps).

**Acceptance criteria**

* Collect a measurement window of weighted-unit spend per stage (subscription/credit weighted_tokens; api_token usd) from production runs after SYMPH-955 deploys.
* Derive per-config \`max_tokens_per_unit\` (and the default) from observed weighted distributions (e.g. p95 of real weighted spend + grace), replacing the flat ×6 bound. Document the observed→new mapping; operator sign-off.
* Consider whether thresholds should become provider-aware (Claude 5× vs OpenAI 6×) instead of a single provider-agnostic number — decide from the data, do not assume.

**Source refs**

* SYMPH-955 (parent): introduced the weighted unit + ×6 conservative re-baseline; mapping in \`docs/DEV_GUIDE.md\`.
* \`src/policy/hard-stops.ts\` (weighted gate), \`src/policy/pricing.ts\` (resolver), crucible \`lane_workers/pricing.ts\` (shared unit).
* Surfaced by the SYMPH-955 session-orchestrator run (decorrelated review + operator decision: direct flip now, tighten later).`,
    },
  },
  {
    issueIdentifier: "SYMPH-957",
    expectedVerdict: "reframe",
    snapshot: {
      cutoff: "2026-06-29T04:15:38.927Z",
      answerIntroducedAt: "2026-06-29T04:15:38.928Z",
      source:
        "Linear issue https://linear.app/mobilyze-llc/issue/SYMPH-957/investigate-live-crucible-spine-conformance-tests-red-cross-lane",
      reconstructedAt: "2026-07-12T14:33:00Z",
      reconstructionNote: RECONSTRUCTION_NOTE,
      title:
        "Investigate: live crucible spine-conformance tests red (cross-lane triage grouping, RQL co-raise)",
      description: `**Problem**

Two symphony review-spine conformance suites fail against the **live crucible spine** on the controller (deterministic, reproduced across runs; NOT introduced by SYMPH-955):

* \`tests/review/crucible-spine-conformance.test.ts > ... > cross-lane triage groups same-location findings by location\` — \`expected length 1 but got 2\` (over-escalation not mitigated).
* \`tests/review/review-quality-ledger-conformance.test.ts > ...\` — co-raised finding capture / precision-recall summary assertions.

These are gated by \`describe.skipIf\` on \`SYMPHONY_REVIEW_SPINE_PATH\` / a live crucible spine path, so they are **skipped in CI** (green there) and only run where a live spine exists. They failed both before and after the SYMPH-955 diff, in unrelated modules.

**Hypotheses to check**

* Crucible spine contract drift (MOB-588/589 or earlier) vs. symphony's expected behavior, OR stale symphony expectations, OR the controller's local crucible checkout being behind origin/main (was 70abb1b while origin/main is b673054 at time of filing) so the live spine under test is an old build.

**Acceptance criteria**

* Reproduce against a crucible checkout pinned to origin/main; determine whether crucible regressed the cross-lane-triage grouping / RQL contract or symphony's conformance expectation is stale.
* Fix the offending side (crucible spine or the symphony test) so the live-spine conformance suites pass, or document why the expectation changed.

**Source refs**

* \`tests/review/crucible-spine-conformance.test.ts:202\`, \`tests/review/review-quality-ledger-conformance.test.ts\`.
* Surfaced during the SYMPH-955 session-orchestrator run (controller-side validation).`,
    },
  },
];

export interface AltitudeReliabilityBar {
  minAccuracy: number;
  minKillPrecision: number;
  maxFalseKills: number;
}

export const DEFAULT_ALTITUDE_RELIABILITY_BAR: AltitudeReliabilityBar = {
  minAccuracy: 0.9,
  minKillPrecision: 1,
  maxFalseKills: 0,
};

export interface AltitudeReliabilityRunInput {
  model: string;
  generatedAt?: string;
  corpus?: readonly AltitudeReliabilityCase[];
  bar?: Partial<AltitudeReliabilityBar>;
  runVerdict: (
    testCase: AltitudeReliabilityCase,
  ) => Promise<AltitudeReliabilityVerdictObservation>;
}

export interface AltitudeReliabilityCaseResult extends AltitudeReliabilityCase {
  actualVerdict: AltitudeReliabilityVerdict;
  contractViolation: AltitudeReliabilityContractViolation | null;
  correct: boolean;
  falseKill: boolean;
}

export interface AltitudeReliabilityRunResult {
  protocol: typeof ALTITUDE_RELIABILITY_PROTOCOL;
  generatedAt: string;
  model: string;
  unattended: true;
  corpusSize: number;
  results: AltitudeReliabilityCaseResult[];
  metrics: {
    accuracy: number;
    killPrecision: number;
    killRecall: number;
    falseKills: number;
  };
  bar: AltitudeReliabilityBar;
  capabilityArrived: boolean;
}

export async function runAltitudeReliabilityRetest(
  input: AltitudeReliabilityRunInput,
): Promise<AltitudeReliabilityRunResult> {
  const corpus = input.corpus ?? ALTITUDE_RELIABILITY_CORPUS;
  if (corpus.length === 0) {
    // An empty corpus scores accuracy/precision as a vacuous 1 and would emit a
    // misleading capabilityArrived=true with nothing measured. Fail loudly
    // rather than report a phantom "capability arrived".
    throw new Error(
      "Altitude reliability corpus must be non-empty; an empty corpus cannot measure capability",
    );
  }
  for (const testCase of corpus) validateSnapshot(testCase);
  const bar = { ...DEFAULT_ALTITUDE_RELIABILITY_BAR, ...input.bar };
  validateReliabilityBar(bar);
  const results: AltitudeReliabilityCaseResult[] = [];
  for (const testCase of corpus) {
    const observation = normalizeVerdictObservation(
      await input.runVerdict(testCase),
    );
    results.push({
      ...testCase,
      actualVerdict: observation.verdict,
      contractViolation: observation.contractViolation,
      correct:
        observation.contractViolation === null &&
        observation.verdict === testCase.expectedVerdict,
      falseKill:
        observation.verdict === "kill" && testCase.expectedVerdict !== "kill",
    });
  }
  const metrics = scoreAltitudeReliability(results);
  return {
    protocol: ALTITUDE_RELIABILITY_PROTOCOL,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    model: input.model,
    unattended: true,
    corpusSize: corpus.length,
    results,
    metrics,
    bar,
    capabilityArrived:
      metrics.accuracy >= bar.minAccuracy &&
      metrics.killPrecision >= bar.minKillPrecision &&
      metrics.falseKills <= bar.maxFalseKills,
  };
}

export function scoreAltitudeReliability(
  results: readonly AltitudeReliabilityCaseResult[],
): AltitudeReliabilityRunResult["metrics"] {
  if (results.length === 0) {
    throw new Error(
      "Altitude reliability results must be non-empty; zero observations cannot measure capability",
    );
  }
  const correct = results.filter((result) => result.correct).length;
  const actualKills = results.filter(
    (result) => result.actualVerdict === "kill",
  ).length;
  const expectedKills = results.filter(
    (result) => result.expectedVerdict === "kill",
  ).length;
  const trueKills = results.filter(
    (result) =>
      result.actualVerdict === "kill" && result.expectedVerdict === "kill",
  ).length;
  const falseKills = results.filter((result) => result.falseKill).length;
  return {
    accuracy: ratio(correct, results.length),
    // A model that makes no kills while the corpus expects kills has zero
    // effective kill precision: the zero-denominator must not be rewarded as 1,
    // or a do-nothing model passes the capability bar (SYMPH-968: kill
    // precision is the load-bearing metric, false-kills are the dangerous
    // direction). Only a corpus with no expected kills is a vacuous 1.
    killPrecision:
      actualKills === 0
        ? expectedKills === 0
          ? 1
          : 0
        : ratio(trueKills, actualKills),
    killRecall: expectedKills === 0 ? 1 : ratio(trueKills, expectedKills),
    falseKills,
  };
}

export function buildAltitudeReliabilityLedgerEntry(
  result: AltitudeReliabilityRunResult,
): Record<string, unknown> {
  return {
    schema_version: 1,
    protocol: result.protocol,
    kind: "altitude_reliability_retest",
    generated_at: result.generatedAt,
    model: result.model,
    unattended: result.unattended,
    corpus_size: result.corpusSize,
    metrics: result.metrics,
    bar: result.bar,
    capability_arrived: result.capabilityArrived,
    cases: result.results.map((entry) => ({
      issue_identifier: entry.issueIdentifier,
      expected_verdict: entry.expectedVerdict,
      actual_verdict: entry.actualVerdict,
      model_contract_violation: entry.contractViolation,
      correct: entry.correct,
      false_kill: entry.falseKill,
    })),
  };
}

function validateSnapshot(testCase: AltitudeReliabilityCase): void {
  const { snapshot } = testCase;
  if (
    [
      snapshot.title,
      snapshot.description,
      snapshot.source,
      snapshot.reconstructedAt,
      snapshot.reconstructionNote,
    ].some((value) => value.trim() === "")
  ) {
    throw new Error(
      `${testCase.issueIdentifier}: frozen snapshot content is incomplete`,
    );
  }
  const cutoff = Date.parse(snapshot.cutoff);
  const answerIntroducedAt = Date.parse(snapshot.answerIntroducedAt);
  const reconstructedAt = Date.parse(snapshot.reconstructedAt);
  if (
    !Number.isFinite(cutoff) ||
    !Number.isFinite(answerIntroducedAt) ||
    !Number.isFinite(reconstructedAt)
  ) {
    throw new Error(
      `${testCase.issueIdentifier}: snapshot provenance timestamps are invalid`,
    );
  }
  if (cutoff >= answerIntroducedAt) {
    throw new Error(
      `${testCase.issueIdentifier}: snapshot cutoff must precede answer-bearing content`,
    );
  }
}

function normalizeVerdictObservation(
  observation: AltitudeReliabilityVerdictObservation,
): {
  verdict: AltitudeReliabilityVerdict;
  contractViolation: AltitudeReliabilityContractViolation | null;
} {
  if (typeof observation === "string") {
    return { verdict: observation, contractViolation: null };
  }
  return {
    verdict: observation.verdict,
    contractViolation: observation.contractViolation,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function validateReliabilityBar(bar: AltitudeReliabilityBar): void {
  assertUnitInterval(bar.minAccuracy, "minAccuracy");
  assertUnitInterval(bar.minKillPrecision, "minKillPrecision");
  if (!Number.isInteger(bar.maxFalseKills) || bar.maxFalseKills < 0) {
    throw new Error("maxFalseKills must be a nonnegative integer");
  }
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
}
