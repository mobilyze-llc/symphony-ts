import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrabboxSpineClient } from "./crabbox-spine-client.js";
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

      const { blockingFindings, refutedFindings, judgedTargetCount } =
        await this.adjudicate(triage, crossExam, input.judge);

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

      return {
        verdict: blockingFindings.length > 0 ? "fail" : "pass",
        triage,
        crossExam,
        convergence,
        blockingFindings,
        trackFindings: [...triage.track],
        refutedFindings,
        judgedTargetCount,
      };
    } finally {
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async adjudicate(
    triage: CouncilTriageResult,
    crossExam: CrossExamSelectResult,
    judge: EscalateJudge | undefined,
  ): Promise<{
    blockingFindings: TriageFinding[];
    refutedFindings: TriageFinding[];
    judgedTargetCount: number;
  }> {
    const escalate = triage.escalate;
    if (escalate.length === 0) {
      return {
        blockingFindings: [],
        refutedFindings: [],
        judgedTargetCount: 0,
      };
    }
    // Fail-closed: escalated findings block unless a judge is supplied AND
    // cross-exam was deemed unnecessary, or the judge explicitly refutes them.
    if (judge === undefined || !crossExam.cross_exam_required) {
      return {
        blockingFindings: [...escalate],
        refutedFindings: [],
        judgedTargetCount: 0,
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
