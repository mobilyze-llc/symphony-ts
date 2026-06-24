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

export type AggregateVerdict = "pass" | "fail";

export interface AggregatedReview {
  verdict: AggregateVerdict;
  triage: CouncilTriageResult;
  crossExam: CrossExamSelectResult;
  convergence: ConvergenceDecisionResult | null;
  /** Escalated findings confirmed blocking (judge-confirmed, or all when no judge). */
  blockingFindings: TriageFinding[];
  /** Non-blocking track findings — filed to Linear, never block merge. */
  trackFindings: TriageFinding[];
  /** Escalated findings the judge refuted (kept for audit, non-blocking). */
  refutedFindings: TriageFinding[];
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
   * round. Present only when a judge would have adjudicated the escalate bucket
   * (a judge was supplied AND cross-exam was required); `null` otherwise (no
   * adjudication happened, so there is no judge to decorrelate). When present and
   * `satisfied === false`, the judge was REFUSED — every escalated finding
   * default-blocks fail-closed and the supplied judge never ran. Additive: the
   * verdict already reflects the fail-closed blocking; this field reports WHY for
   * operators and the ledger.
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
                input.rounds.map((round) => ({
                  diff_hash: round.diffHash,
                  blocking: round.blocking.map((b) => ({ fp: b.fp })),
                  ...(round.crossExamined === undefined
                    ? {}
                    : { cross_examined: round.crossExamined }),
                })),
              ),
            });

      const review: AggregatedReview = {
        verdict: blockingFindings.length > 0 ? "fail" : "pass",
        triage,
        crossExam,
        convergence,
        blockingFindings,
        trackFindings: [...triage.track],
        refutedFindings,
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
        laneArtifacts: input.laneArtifacts.map((lane) => ({
          reviewer: lane.reviewer,
          markdown: lane.markdown,
        })),
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
     * SYMPH-925 — the family-decorrelation decision, present ONLY when a judge would
     * have adjudicated (judge supplied AND cross-exam required AND escalations
     * exist); `null` otherwise. A `satisfied:false` decision means the judge was
     * REFUSED and the escalations default-blocked fail-closed.
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
