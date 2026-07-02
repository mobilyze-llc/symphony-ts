import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrabboxSpineClient } from "./crabbox-spine-client.js";
import {
  type JudgeDecorrelationDecision,
  type JudgeDecorrelationUnsatisfiedReason,
  decideJudgeDecorrelation,
} from "./judge-decorrelation.js";
import type {
  ReviewQualityLedgerClient,
  RqlCrossExamVerdict,
} from "./review-quality-ledger-client.js";
import type {
  ConvergenceDecisionResult,
  CouncilTriageResult,
  CrossExamSelectResult,
  TriageFinding,
} from "./schemas.js";

/**
 * Deterministic review aggregator (SYMPH-908 U3-5). Orchestrates crucible's spine
 * subcommands over reviewer-lane artifacts to produce a review outcome WITHOUT a
 * per-round LLM triage call: `council-triage` and `cross-exam-select` are pure code,
 * and an LLM judge runs only over the (small) escalate bucket when cross-exam is
 * required — replacing Symphony's unconditional Codex-lead lane (the token win).
 *
 * This module is standalone (its own `{verdict, findings, convergence}` shape) so it
 * is the clean seam the substrate migration (SYMPH-912) relocates, and so the
 * headless-council-gate cutover (which adapts this into Symphony's StructuredReview
 * findings and removes the lead lane) is a thin wiring change rather than a rewrite.
 */

export interface ReviewLaneArtifact {
  reviewer: string;
  /** The reviewer's `## Verdict` / `## Findings` markdown artifact. */
  markdown: string;
}

export interface ReviewRoundRecord {
  diffHash: string;
  blocking: ReadonlyArray<{ fp: string }>;
  crossExamined?: boolean;
}

export interface JudgeTarget {
  fp: string;
  severity: string;
  location: string;
  summary: string;
  reviewers: readonly string[];
}

export interface JudgeVerdict {
  fp: string;
  /** True if the escalated finding is a real blocker; false refutes it. */
  real: boolean;
  reason?: string;
}

/**
 * Scoped LLM judge over the escalate bucket. Receives only the deduped escalate
 * targets (never the full diff-review prompt) and returns a verdict per fingerprint.
 */
export type EscalateJudge = (
  targets: readonly JudgeTarget[],
) => Promise<readonly JudgeVerdict[]>;

/**
 * SYMPH-926 — the aggregator's review outcome.
 *
 * - `pass` — clean: no real blockers AND the round was fully reviewable.
 * - `fail` — at least one real blocker (a confirmed/default-blocked escalation).
 *   A real blocker is STRONGER than degradation, so it always wins precedence.
 * - `degraded` — NOT a real blocker, but the round could NOT be trusted as a
 *   clean pass: a lane was unparseable/blocked or failed open (every consumer
 *   treats this as NON-PASS, exactly like `fail`, so an all-unparseable round can
 *   never silently pass — closing the SYMPH-926 fail-open hole). Distinct from
 *   `fail` only so the gate / operator can tell "real blocker" from "couldn't
 *   review".
 */
export type AggregateVerdict = "pass" | "fail" | "degraded";

/**
 * SYMPH-926/SYMPH-934 — one degraded reviewer lane (unparseable, blocked, or
 * fail-open), or a synthesized round-summary entry when only aggregate summary
 * counts report degradation. Surfaced whenever the round could not be trusted as
 * a clean pass so the gate and operators can see why the round was degraded, even
 * when the verdict is `fail` (a real blocker co-occurring with degradation still
 * records this).
 */
export interface DegradedLane {
  /** The reviewer/lane label from the triage lane, or `round-summary`. */
  reviewer: string;
  /** The spine's lane `parse_quality`, or the summary count source(s). */
  parse_quality: string;
  /** Why the lane is degraded (the dominant signal that flagged it). */
  reason: "unparseable" | "blocked" | "fail_open" | "summary_count";
}

export interface ReviewFamilySynthesis {
  /** Stable report identity: spine `family` when supplied, otherwise `fp`. */
  key: string;
  /** Operator-facing family name: spine `family` when supplied, otherwise `fp`. */
  name: string;
  safetyClaim: string | null;
  nextRoundQuestion: string | null;
  fixedSymptoms: string[];
  remainingSymptoms: string[];
  findingFingerprints: string[];
}

export interface AggregatedReview {
  verdict: AggregateVerdict;
  /**
   * SYMPH-926 — the lanes that could not be trusted as a clean review this round
   * (unparseable / blocked / fail-open). Non-empty iff the round was degraded;
   * empty on a clean pass or a fail driven purely by real blockers without any
   * degradation. Populated EVEN when `verdict === "fail"` (a real blocker takes
   * verdict precedence over degradation, but the degradation is still surfaced).
   */
  degradedLanes: DegradedLane[];
  /** SYMPH-926 — count of `degradedLanes` (convenience for callers/observability). */
  degradedLaneCount: number;
  triage: CouncilTriageResult;
  crossExam: CrossExamSelectResult;
  convergence: ConvergenceDecisionResult | null;
  /** Escalated findings confirmed blocking (judge-confirmed, or all when no judge). */
  blockingFindings: TriageFinding[];
  /** Non-blocking track findings — filed to Linear, never block merge. */
  trackFindings: TriageFinding[];
  /** Escalated findings the judge refuted (kept for audit, non-blocking). */
  refutedFindings: TriageFinding[];
  /**
   * SYMPH-923 — operator-facing family synthesis sourced from the spine triage
   * contract, after adjudication. Refuted/absent families are not reported; a
   * family that persists as blocking or Track remains visible with its current
   * fixed/remaining symptom trailer.
   */
  familySyntheses: ReviewFamilySynthesis[];
  familySynthesisCount: number;
  synthesisFamilyNames: string[];
  judgedTargetCount: number;
  /**
   * SYMPH-924 — fps the judge EXPLICITLY confirmed real (`real === true`). A strict
   * subset of `blockingFindings`: it excludes fail-closed default-blocks (findings
   * the judge was silent on, which still block but were never affirmatively
   * confirmed). Empty when no judge ran. Additive/observability only — never read by
   * the verdict; the ledger uses it to record CONFIRM vs `none` honestly.
   */
  judgeConfirmedFps: string[];
  /**
   * SYMPH-925 — the deterministic judge-family decorrelation decision for THIS
   * round.
   *
   * NON-NULL whenever the adjudication PATH was entered — i.e. a judge was
   * supplied AND cross-exam was required AND the escalate bucket was non-empty —
   * REGARDLESS of whether the judge then ran (`satisfied: true`) or was REFUSED
   * (`satisfied: false`). A refused judge is reported, not erased: a `satisfied:
   * false` decision means every escalated finding default-blocks fail-closed and
   * the supplied judge never ran (the reason says why).
   *
   * `null` ONLY when the adjudication path was NOT entered: no judge supplied, OR
   * cross-exam not required, OR no escalations. So a caller MUST NOT read
   * `judgeDecorrelation === null` as "the judge passed" — `null` means "no judge
   * adjudicated this round", while a refused judge is a NON-NULL `satisfied:
   * false`. Additive: the verdict already reflects the fail-closed blocking; this
   * field reports WHY for operators and the ledger.
   */
  judgeDecorrelation: JudgeDecorrelationDecision | null;
  /**
   * SYMPH-925 — the fail-closed degraded reason when an otherwise-eligible judge
   * was refused for failing the family-exclusion precondition (`null` when the
   * judge was proven decorrelated, or when no judge adjudicated this round). This
   * is the merge-precondition signal: a non-null value means adjudication was
   * NOT decorrelated and the round's escalations blocked without a trusted judge.
   */
  judgeDecorrelationDegradedReason: JudgeDecorrelationUnsatisfiedReason | null;
}

/**
 * SYMPH-924 — review-quality ledger capture configuration. When supplied, the
 * aggregator records one durable per-finding row per round (raised_by → disposition
 * → cross-exam verdict) as a PURE SIDE-EFFECT after the verdict is already decided.
 * The ledger is DATA CAPTURE ONLY: nothing here is ever read by the convergence /
 * merge decision, and a capture failure is swallowed (never thrown into the
 * decision path). Omit to disable capture entirely.
 */
export interface ReviewLedgerCapture {
  client: ReviewQualityLedgerClient;
  runId?: string;
  /** PR identifier for the ledger row, e.g. "owner/repo#123". */
  pr?: string;
  headSha?: string;
  /** Review round number (1-based) — part of the row identity for round survival. */
  round?: number;
  reviewTier?: string;
  /**
   * Optional sink invoked with a swallowed capture error, for structured logging.
   * The error is NEVER rethrown; this hook is observability only.
   */
  onError?: (error: unknown) => void;
}

export interface AggregateReviewInput {
  laneArtifacts: readonly ReviewLaneArtifact[];
  currentDiffHash: string;
  priorDiffHash?: string;
  fixSizeLines?: number;
  /** Per-round history for convergence; omit to skip the convergence decision. */
  rounds?: readonly ReviewRoundRecord[];
  /**
   * Scoped judge over the escalate bucket. When omitted, every escalated finding is
   * treated as blocking — fail-closed, never a silent pass.
   */
  judge?: EscalateJudge;
  /**
   * SYMPH-925 — judge-family decorrelation metadata. The escalate-bucket judge is
   * the blocking AUTHORITY, so it must be proven to sit OUTSIDE the author/executor
   * model family before it may adjudicate (crucible MOB-386: decorrelate the judge,
   * not the finder). Supply BOTH the author/executor family and the judge's own
   * family. When a judge would adjudicate (judge supplied AND cross-exam required)
   * but this precondition is unsatisfied — either family unkeyable, or the judge is
   * the author's family — the judge is REFUSED and every escalation default-blocks
   * fail-closed (mirrors the `routing_author_provenance_missing` fail-closed
   * pattern). Omit when no judge is supplied; the existing fail-closed default-block
   * already covers the no-judge path.
   *
   * Resolve `authorFamily` from EXPLICIT review provenance only
   * (`SYMPHONY_COUNCIL_AUTHOR_FAMILY` / `inferAuthorFamilies`), never ambient
   * process env — see the MOB-399/392 env-leak note in `judge-decorrelation.ts`.
   */
  judgeDecorrelation?: {
    authorFamily?: string | null;
    judgeFamily?: string | null;
  };
  /**
   * Optional review-quality ledger capture (SYMPH-924). A pure, fail-closed
   * side-effect: it cannot change the returned `AggregatedReview` or the verdict.
   */
  ledger?: ReviewLedgerCapture;
}

export class ReviewAggregator {
  constructor(private readonly client: CrabboxSpineClient) {}

  async aggregate(input: AggregateReviewInput): Promise<AggregatedReview> {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "symphony-review-aggregate-"));
      const reviews = await this.writeLaneArtifacts(dir, input.laneArtifacts);
      const triage = await this.client.councilTriage({ reviews });

      const crossExam = await this.client.crossExamSelect({
        triageFile: await this.writeJson(dir, "triage.json", triage),
        currentDiffHash: input.currentDiffHash,
        ...(input.priorDiffHash === undefined
          ? {}
          : { priorDiffHash: input.priorDiffHash }),
        ...(input.fixSizeLines === undefined
          ? {}
          : { fixSizeLines: input.fixSizeLines }),
      });

      const {
        blockingFindings,
        refutedFindings,
        judgedTargetCount,
        confirmedFps,
        judgeDecorrelation,
      } = await this.adjudicate(
        triage,
        crossExam,
        input.judge,
        input.judgeDecorrelation,
      );

      const convergence =
        input.rounds === undefined
          ? null
          : await this.client.convergenceDecision({
              roundsFile: await this.writeJson(
                dir,
                "rounds.json",
                withCurrentSpineRound({
                  rounds: input.rounds,
                  currentDiffHash: input.currentDiffHash,
                  blockingFindings,
                  crossExamined: crossExam.cross_exam_required,
                }).map((round) => ({
                  diff_hash: round.diffHash,
                  blocking: round.blocking.map((b) => ({ fp: b.fp })),
                  ...(round.crossExamined === undefined
                    ? {}
                    : { cross_examined: round.crossExamined }),
                })),
              ),
            });

      // SYMPH-926 — close the fail-open hole. The verdict previously derived ONLY
      // from `blockingFindings` (escalate/track), so an all-unparseable / blocked
      // round with zero escalations silently returned "pass". Read the degradation
      // signals the spine already emits (per-lane `fail_open` / `parse_quality`,
      // and the `summary.unparseable_lanes` / `summary.blocked_lanes` counts) and:
      //   - a real blocker → "fail" (a real blocker is stronger than "couldn't
      //     review", so it takes precedence even if degradation co-occurs);
      //   - else any degradation → "degraded" (NON-PASS, blocks merge — never a
      //     silent pass);
      //   - else → "pass".
      // `degradedLanes` is surfaced whenever degradation exists, EVEN under a
      // `fail` verdict, so the gate/operator can always see which lanes, or which
      // summary signal, made the round not fully reviewable.
      const degradedLanes = collectDegradedLanes(triage);
      const verdict: AggregateVerdict =
        blockingFindings.length > 0
          ? "fail"
          : degradedLanes.length > 0
            ? "degraded"
            : "pass";
      const familySyntheses = buildReviewFamilySyntheses([
        ...blockingFindings,
        ...triage.track,
      ]);

      const review: AggregatedReview = {
        verdict,
        degradedLanes,
        degradedLaneCount: degradedLanes.length,
        triage,
        crossExam,
        convergence,
        blockingFindings,
        trackFindings: [...triage.track],
        refutedFindings,
        familySyntheses,
        familySynthesisCount: familySyntheses.length,
        synthesisFamilyNames: familySyntheses.map(
          (synthesis) => synthesis.name,
        ),
        judgedTargetCount,
        judgeConfirmedFps: confirmedFps,
        judgeDecorrelation,
        judgeDecorrelationDegradedReason:
          judgeDecorrelation !== null && !judgeDecorrelation.satisfied
            ? judgeDecorrelation.reason
            : null,
      };

      // SYMPH-924: pure, fail-closed side-effect — capture the review-quality
      // ledger row(s) AFTER `review` is fully decided, using it as INPUT only.
      // It is never read back into the verdict; capture failures are swallowed so
      // a missing/broken ledger can never block or alter a merge decision.
      await this.captureLedger(input, review);

      return review;
    } finally {
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * SYMPH-924 — capture one durable ledger row per finding for this round. Pure
   * side-effect: takes the already-decided `review` as input, records via the
   * crucible RQL seam, and SWALLOWS every failure (the ledger must never block or
   * alter a merge decision). Returns nothing the decision path consumes.
   *
   * raised_by is recovered PRE-DEDUP inside the ledger itself: it re-reads the
   * per-lane `laneArtifacts` (the same artifacts `council-triage` consumed before
   * its dedup) so a co-raised finding's full raiser set is restored, even though the
   * triage output collapsed it to a single `reviewer` tag.
   */
  private async captureLedger(
    input: AggregateReviewInput,
    review: AggregatedReview,
  ): Promise<void> {
    const capture = input.ledger;
    if (capture === undefined) {
      return;
    }
    try {
      const blockingFps = review.blockingFindings.map((f) => f.fp);
      // Cross-exam verdicts captured for audit: ONLY fps the judge EXPLICITLY
      // confirmed (`judgeConfirmedFps`) → CONFIRM; judge-refuted findings → REFUTE. A
      // fail-closed default-block (blocking but never affirmatively confirmed —
      // judge-silent, or no judge ran) is OMITTED here, so the ledger records it as
      // "none" rather than a fabricated CONFIRM. This keeps per-lane precision
      // (confirmed/raised) honest — the exact ground truth the ledger exists to
      // measure. The merge decision is unaffected: a default-block still blocks via
      // `blockingFps`; only its recorded cross_exam_verdict changes.
      const confirmedFpSet = new Set(review.judgeConfirmedFps);
      const crossExamVerdicts: RqlCrossExamVerdict[] = [
        ...review.blockingFindings
          .filter((f) => confirmedFpSet.has(f.fp))
          .map((f): RqlCrossExamVerdict => ({ fp: f.fp, verdict: "CONFIRM" })),
        ...review.refutedFindings.map(
          (f): RqlCrossExamVerdict => ({ fp: f.fp, verdict: "REFUTE" }),
        ),
      ];
      await capture.client.record({
        triage: review.triage,
        laneArtifacts: ledgerLaneArtifactsForReview(
          input.laneArtifacts,
          review,
        ),
        blockingFps,
        ...(crossExamVerdicts.length > 0 ? { crossExamVerdicts } : {}),
        ...(capture.runId === undefined ? {} : { runId: capture.runId }),
        ...(capture.pr === undefined ? {} : { pr: capture.pr }),
        ...(capture.headSha === undefined ? {} : { headSha: capture.headSha }),
        ...(capture.round === undefined ? {} : { round: capture.round }),
        ...(capture.reviewTier === undefined
          ? {}
          : { reviewTier: capture.reviewTier }),
      });
    } catch (error) {
      // Fail-closed: capture must NEVER propagate into the review decision.
      // SYMPH-924: onError is observability-only — a throwing onError must not
      // re-enter and abort the review decision, so swallow anything it throws.
      try {
        capture.onError?.(error);
      } catch {
        // intentionally ignored — the observability hook cannot alter the verdict.
      }
    }
  }

  private async adjudicate(
    triage: CouncilTriageResult,
    crossExam: CrossExamSelectResult,
    judge: EscalateJudge | undefined,
    judgeDecorrelationInput:
      | { authorFamily?: string | null; judgeFamily?: string | null }
      | undefined,
  ): Promise<{
    blockingFindings: TriageFinding[];
    refutedFindings: TriageFinding[];
    judgedTargetCount: number;
    /**
     * SYMPH-924 — fps the judge EXPLICITLY confirmed (`real === true`). Empty when
     * no judge ran (no explicit confirmation exists, so default-blocks must NOT be
     * recorded as judge-confirmed).
     */
    confirmedFps: string[];
    /**
     * SYMPH-925 — the family-decorrelation decision. NON-NULL whenever the
     * adjudication path was entered (judge supplied AND cross-exam required AND
     * escalations exist), REGARDLESS of whether the judge then ran
     * (`satisfied:true`) or was REFUSED (`satisfied:false`). `null` ONLY when that
     * path was not entered (no judge / no cross-exam / no escalations). A
     * `satisfied:false` decision means the judge was REFUSED and the escalations
     * default-blocked fail-closed.
     */
    judgeDecorrelation: JudgeDecorrelationDecision | null;
  }> {
    const escalate = triage.escalate;
    if (escalate.length === 0) {
      return {
        blockingFindings: [],
        refutedFindings: [],
        judgedTargetCount: 0,
        confirmedFps: [],
        judgeDecorrelation: null,
      };
    }
    // Fail-closed: escalated findings block unless a judge is supplied AND
    // cross-exam was deemed unnecessary, or the judge explicitly refutes them.
    if (judge === undefined || !crossExam.cross_exam_required) {
      return {
        blockingFindings: [...escalate],
        refutedFindings: [],
        judgedTargetCount: 0,
        // No judge ran → nothing was explicitly confirmed. These block fail-closed
        // but must be recorded as cross_exam_verdict "none", not CONFIRM.
        confirmedFps: [],
        // No judge adjudicated → no judge to decorrelate this round.
        judgeDecorrelation: null,
      };
    }
    // SYMPH-925 — judge-family decorrelation is a DETERMINISTIC merge precondition,
    // proven BEFORE the judge adjudicates. The escalate-bucket judge is the blocking
    // AUTHORITY, so it must sit OUTSIDE the author/executor model family (crucible
    // MOB-386: decorrelate the judge, not the finder). FAIL-CLOSED: if the author or
    // judge family is unkeyable, or the judge IS the author's family, the supplied
    // judge is REFUSED — every escalation default-blocks (never a silent pass) and
    // the degraded reason is surfaced. This mirrors the finder-layer
    // `routing_author_provenance_missing` fail-closed pattern and crucible's
    // `COUNCIL_DECORRELATION_UNSATISFIED` reasons; the merge decision is unchanged in
    // shape (escalations block), only the JUDGE never runs.
    const judgeDecorrelation = decideJudgeDecorrelation({
      authorFamily: judgeDecorrelationInput?.authorFamily ?? null,
      judgeFamily: judgeDecorrelationInput?.judgeFamily ?? null,
    });
    if (!judgeDecorrelation.satisfied) {
      return {
        blockingFindings: [...escalate],
        refutedFindings: [],
        judgedTargetCount: 0,
        // The judge was refused before running → nothing was confirmed.
        confirmedFps: [],
        judgeDecorrelation,
      };
    }
    const verdicts = await judge(
      crossExam.targets.map((target) => ({
        fp: target.fp,
        severity: target.severity,
        location: target.location,
        summary: target.summary,
        reviewers: target.reviewers,
      })),
    );
    const refutedFps = new Set(
      verdicts.filter((v) => v.real === false).map((v) => v.fp),
    );
    // Only fps the judge AFFIRMATIVELY confirmed real. A judge-silent fp is NOT
    // here — it default-blocks (below) but was never confirmed, so the ledger records
    // it as "none", never a fabricated CONFIRM.
    const confirmedFps = verdicts
      .filter((v) => v.real === true)
      .map((v) => v.fp);
    const blockingFindings: TriageFinding[] = [];
    const refutedFindings: TriageFinding[] = [];
    for (const finding of escalate) {
      if (refutedFps.has(finding.fp)) {
        refutedFindings.push(finding);
      } else {
        // Default to blocking when the judge did not explicitly refute the fp.
        blockingFindings.push(finding);
      }
    }
    return {
      blockingFindings,
      refutedFindings,
      judgedTargetCount: crossExam.targets.length,
      confirmedFps,
      // The judge ran because it was proven decorrelated; surface that proof.
      judgeDecorrelation,
    };
  }

  private async writeLaneArtifacts(
    dir: string,
    laneArtifacts: readonly ReviewLaneArtifact[],
  ): Promise<Array<{ file: string; reviewer: string }>> {
    const reviews: Array<{ file: string; reviewer: string }> = [];
    let index = 0;
    for (const lane of laneArtifacts) {
      const file = join(dir, `lane-${index}-${sanitize(lane.reviewer)}.md`);
      await writeFile(file, lane.markdown, "utf8");
      reviews.push({ file, reviewer: lane.reviewer });
      index += 1;
    }
    return reviews;
  }

  private async writeJson(
    dir: string,
    name: string,
    value: unknown,
  ): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, JSON.stringify(value), "utf8");
    return file;
  }
}

function sanitize(reviewer: string): string {
  return reviewer.replace(/[^a-zA-Z0-9_-]/g, "_") || "lane";
}

/**
 * SYMPH-926 — collect the reviewer lanes that could not be trusted as a clean
 * review this round. A lane is degraded when it is `fail_open` (the spine could
 * not derive a real verdict and defaulted open), OR its `parse_quality` is
 * `unparseable` / `blocked`. The summary counts (`unparseable_lanes` /
 * `blocked_lanes`) are the round-level corroboration the ticket calls out. We
 * derive the list from the lanes themselves when possible so the gate gets WHICH
 * lanes degraded, then synthesize a round-summary entry if counts indicate
 * degradation but no lane carries the matching signal. This keeps the invariant
 * that a degraded verdict is observable via at least one `degradedLanes` row.
 * A lane is listed at most once, with `fail_open` taking precedence over
 * `parse_quality` for the recorded `reason` (fail-open is the load-bearing
 * fail-OPEN signal).
 */
function collectDegradedLanes(triage: CouncilTriageResult): DegradedLane[] {
  const degraded: DegradedLane[] = [];
  for (const lane of triage.lanes) {
    const parseQuality = lane.parse_quality;
    const reason: DegradedLane["reason"] | null = lane.fail_open
      ? "fail_open"
      : parseQuality === "unparseable"
        ? "unparseable"
        : parseQuality === "blocked"
          ? "blocked"
          : null;
    if (reason === null) {
      continue;
    }
    degraded.push({
      reviewer: lane.reviewer,
      parse_quality: parseQuality,
      reason,
    });
  }
  if (
    degraded.length === 0 &&
    (triage.summary.unparseable_lanes > 0 || triage.summary.blocked_lanes > 0)
  ) {
    const summarySignals = [
      triage.summary.unparseable_lanes > 0 ? "unparseable_lanes" : null,
      triage.summary.blocked_lanes > 0 ? "blocked_lanes" : null,
    ].filter((signal): signal is string => signal !== null);
    degraded.push({
      reviewer: "round-summary",
      parse_quality: summarySignals.join("+"),
      reason: "summary_count",
    });
  }
  return degraded;
}

function buildReviewFamilySyntheses(
  findings: readonly TriageFinding[],
): ReviewFamilySynthesis[] {
  const groups = new Map<string, ReviewFamilySynthesis>();
  for (const finding of findings) {
    const name = normalizeOptionalLabel(finding.family) ?? finding.fp;
    const key = normalizeFamilyKey(name);
    const existing =
      groups.get(key) ??
      ({
        key,
        name,
        safetyClaim: null,
        nextRoundQuestion: null,
        fixedSymptoms: [],
        remainingSymptoms: [],
        findingFingerprints: [],
      } satisfies ReviewFamilySynthesis);
    existing.safetyClaim ??= normalizeOptionalLabel(finding.safety_claim);
    existing.nextRoundQuestion ??= normalizeOptionalLabel(
      finding.next_round_question,
    );
    existing.fixedSymptoms = uniqueInEncounterOrder([
      ...existing.fixedSymptoms,
      ...(finding.fixed_symptoms ?? []).map(normalizeSymptom),
    ]);
    existing.remainingSymptoms = uniqueInEncounterOrder([
      ...existing.remainingSymptoms,
      ...(finding.remaining_symptoms ?? []).map(normalizeSymptom),
    ]);
    existing.findingFingerprints = uniqueInEncounterOrder([
      ...existing.findingFingerprints,
      finding.fp,
    ]);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
}

function normalizeOptionalLabel(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized === "" ? null : normalized;
}

function normalizeFamilyKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSymptom(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueInEncounterOrder(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}

function ledgerLaneArtifactsForReview(
  laneArtifacts: readonly ReviewLaneArtifact[],
  review: AggregatedReview,
): ReviewLaneArtifact[] {
  const base = laneArtifacts.map((lane) => ({
    reviewer: lane.reviewer,
    markdown: lane.markdown,
  }));
  const synthetic = [...review.triage.escalate, ...review.triage.track].flatMap(
    (finding) => syntheticCoalescedLaneArtifacts(finding),
  );
  return synthetic.length === 0 ? base : [...base, ...synthetic];
}

function syntheticCoalescedLaneArtifacts(
  finding: TriageFinding,
): ReviewLaneArtifact[] {
  const reviewers = compatReviewers(finding);
  if (reviewers.length <= 1) {
    return [];
  }
  // MOB-681: Crucible RQL currently recovers lane raisers by fp only. Replay the
  // coalesced finding once per reviewer so wording-only duplicates retain raised_by.
  return reviewers.map((reviewer) => ({
    reviewer,
    markdown: [
      "## Verdict",
      finding.severity.toLowerCase() === "track" ? "PASS" : "CHANGES_REQUESTED",
      "",
      "## Findings",
      `- [${finding.severity}] ${finding.location} - ${finding.summary}`,
    ].join("\n"),
  }));
}

function compatReviewers(finding: TriageFinding): string[] {
  const value = (finding as TriageFinding & { reviewers?: unknown }).reviewers;
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter(
        (reviewer): reviewer is string =>
          typeof reviewer === "string" && reviewer.trim() !== "",
      ),
    ),
  ];
}

function withCurrentSpineRound(input: {
  rounds: readonly ReviewRoundRecord[];
  currentDiffHash: string;
  blockingFindings: readonly TriageFinding[];
  crossExamined: boolean;
}): ReviewRoundRecord[] {
  const current: ReviewRoundRecord = {
    diffHash: input.currentDiffHash,
    blocking: input.blockingFindings.map((finding) => ({ fp: finding.fp })),
    crossExamined: input.crossExamined,
  };
  const rounds = [...input.rounds];
  const last = rounds.at(-1);
  if (last?.diffHash === input.currentDiffHash) {
    return [...rounds.slice(0, -1), current];
  }
  return [...rounds, current];
}
