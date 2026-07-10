import { resolve } from "node:path";

import type { AgentRunInput } from "../agent/runner.js";
import type { StageDefinition } from "../config/types.js";
import type { Issue } from "../domain/model.js";
import type {
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../stage-execution/backend.js";
import type { CrabrunnerStageExecutionEvidence } from "../stage-execution/crabrunner-backend.js";
import {
  type CrabrunnerReviewJobGroupResult,
  type CrabrunnerReviewLaneSpec,
  type ReviewJobGroupLaneEvidence,
  runCrabrunnerReviewJobGroup,
} from "./crabrunner-review-job-group.js";
import { finalizeHeadlessCouncilRouting } from "./headless-council-gate.js";
import type {
  CouncilDecorrelatedReviewerArtifact,
  CouncilReviewMetadata,
  CouncilReviewMode,
  CouncilReviewRouting,
  CouncilRoutingMode,
  HeadlessCouncilGateResult,
  ReviewBundleReference,
  StructuredReviewerArtifact,
  TargetedConvergenceHypothesis,
} from "./headless-council-gate.js";
import type { PreReviewVerifyGateOutcome } from "./pre-review-verify-gate.js";
import {
  collectRoutingGuaranteeDegradedConditions,
  reviewVerdictWithRoutingGuarantees,
} from "./review-verdict.js";

/**
 * SYMPH-855 — adapt the crabrunner review job group (SYMPH-810) into the EXACT
 * artifact contract the live review stage already produces, so the orchestrator
 * finalization consumes it unchanged.
 *
 * The legacy review path runs a workspace agent that invokes the council gate
 * CLI, which writes `<artifactDir>/review-result.json` (a serialized
 * {@link HeadlessCouncilGateResult}) and prints a
 * `[REVIEW_GATE_RESULT_PATH: <path>]` marker in its final message. The
 * orchestrator extracts that marker, validates the file (issue/verdict/pr/
 * review_metadata + path-equality anti-spoof), and reduces it to the canonical
 * `review_gate_result` + `merge_candidate` journal rows that drive rework /
 * merge-readiness.
 *
 * This module produces the SAME two outputs from a crabrunner job-group result:
 * it maps the job-group verdict + lanes onto a `HeadlessCouncilGateResult`, sets
 * `artifactPaths.{resultJson,artifactDir}` so the anti-spoof path equality
 * holds, writes the JSON to disk, and returns the marker the orchestrator
 * expects. Review intelligence (verdict aggregation, fail-closed rules, routing
 * guarantees) stays entirely in the review layer; nothing here changes the
 * orchestrator's validator, marker contract, or merge-readiness invariants.
 */

export interface RunCrabrunnerReviewStageInput {
  issueId: string;
  /** The Linear/source identifier; written into the artifact `issueId`. */
  issueIdentifier: string;
  runGroupId: string;
  /** The current PR head SHA the rerun must assert (freshness). */
  currentHeadSha: string;
  /** Directory the review-result.json is written to (the artifact dir). */
  artifactDir: string;
  pr: {
    repo: string | null;
    number: number | null;
    baseRef: string | null;
    headRef: string | null;
  };
  /** Base SHA recorded in review_metadata (load-bearing for merge candidacy). */
  baseSha: string | null;
  round: number;
  mode: CouncilReviewMode;
  routingMode?: CouncilRoutingMode | null;
  reviewRouting?: CouncilReviewRouting;
  reviewBundle?: ReviewBundleReference | null;
  targetedConvergence?: TargetedConvergenceHypothesis | null;
  diffPath?: string | null;
  preReviewVerify?: PreReviewVerifyGateOutcome | null;
  previousReviewedHeadSha?: string | null;
  lanes: readonly CrabrunnerReviewLaneSpec[];
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  /** Called as soon as any reviewer lane is admitted by crabrunner. */
  onLaneJobId?: (jobId: string) => void;
  buildJobSpec: (lane: CrabrunnerReviewLaneSpec) => StageExecutionJobSpec;
  buildRunnerInput: (lane: CrabrunnerReviewLaneSpec) => AgentRunInput;
  collectArtifact: (
    lane: ReviewJobGroupLaneEvidence,
  ) => Promise<unknown> | unknown;
  routingGuaranteeConditions?: readonly string[];
  qaMissingPolicy?: "block" | "degrade";
  /** Injected fs.mkdir (recursive). Defaults supplied by the caller/runtime. */
  mkdir: (path: string) => Promise<void>;
  /** Injected fs.writeFile. Kept as a boundary so this module is deterministic. */
  writeFile: (path: string, contents: string) => Promise<void>;
  now?: () => Date;
}

export interface CrabrunnerReviewStageResult {
  /** The aggregate review result, in the exact orchestrator-consumed shape. */
  result: HeadlessCouncilGateResult;
  /** Resolved path the review-result.json was written to (== marker payload). */
  reviewResultPath: string;
  /** `[REVIEW_GATE_RESULT_PATH: <path>]` — the dispatcher marker. */
  markerMessage: string;
  /** The underlying job-group result (provenance/QA), for observability. */
  jobGroup: CrabrunnerReviewJobGroupResult;
  /** Report-only pre-council deterministic verification metrics. */
  preReviewVerify: PreReviewVerifyGateOutcome | null;
}

/**
 * The minimal context the orchestrator hands a {@link CrabrunnerReviewStageDispatcher}
 * when it routes a review stage to the crabrunner job group. Everything the
 * dispatcher needs to build lane specs, resolve the head, and persist the
 * artifact comes from here; the dispatcher owns the review-layer specifics
 * (lane construction, host-owned artifact reads) so the orchestrator branch
 * stays thin and review intelligence never leaks into the orchestrator.
 */
export interface CrabrunnerReviewStageDispatchContext {
  issue: Issue;
  issueId: string;
  issueIdentifier: string;
  workspaceRoot: string;
  stage: StageDefinition | null;
  stageName: string | null;
  /**
   * The stage attempt index. Threaded through so a rework (re-review) attempt is
   * correlated/journaled as its own attempt and not collapsed into the initial
   * one (SYMPH-855 council P2-1). null on a first dispatch with no attempt.
   */
  attempt: number | null;
  /** Run-group artifact root the review-result.json is written under. */
  artifactRoot: string;
  baseRef: string | null;
  /** Previous reviewed head from the latest prior review-result/journal row. */
  previousReviewedHeadSha?: string | null;
  /** Structured artifacts from prior review rounds for targeted convergence. */
  priorStructuredArtifacts?: readonly StructuredReviewerArtifact[];
  signal: AbortSignal;
  /** The resolved crabrunner backend (the only dispatch surface). */
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  /** Called as soon as any reviewer lane is admitted by crabrunner. */
  onLaneJobId?: (jobId: string) => void;
}

/**
 * Seam (SYMPH-855) that maps a review stage onto a crabrunner job-group run and
 * returns the aggregate review artifact + marker. Injected into the runtime host
 * so the gated branch is a thin selector and is deterministically testable with
 * a fake dispatcher (no subprocess, no model tokens). The PRODUCTION
 * implementation — real WORKFLOW-derived lane specs and a host-owned
 * `collectArtifact` reader — is wired separately (the analog of SYMPH-853's
 * production scheduler client for the implement path).
 */
export type CrabrunnerReviewStageDispatcher = (
  context: CrabrunnerReviewStageDispatchContext,
) => Promise<CrabrunnerReviewStageResult>;

const REVIEW_GATE_RESULT_MARKER_PREFIX = "[REVIEW_GATE_RESULT_PATH:";
const REVIEW_GATE_RESULT_MARKER_SUFFIX = "]";

export async function runCrabrunnerReviewStage(
  input: RunCrabrunnerReviewStageInput,
): Promise<CrabrunnerReviewStageResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const jobGroupInput: Parameters<typeof runCrabrunnerReviewJobGroup>[0] = {
    issueId: input.issueId,
    runGroupId: input.runGroupId,
    currentHeadSha: input.currentHeadSha,
    lanes: input.lanes,
    backend: input.backend,
    ...(input.onLaneJobId === undefined
      ? {}
      : { onLaneJobId: input.onLaneJobId }),
    buildJobSpec: input.buildJobSpec,
    buildRunnerInput: input.buildRunnerInput,
    collectArtifact: input.collectArtifact,
    routingGuaranteeConditions: input.routingGuaranteeConditions ?? [],
    ...(input.qaMissingPolicy === undefined
      ? {}
      : { qaMissingPolicy: input.qaMissingPolicy }),
  };
  const jobGroup = await runCrabrunnerReviewJobGroup(jobGroupInput);

  const artifactDir = resolve(input.artifactDir);
  const reviewResultPath = `${artifactDir}/review-result.json`;
  const councilReportPath = `${artifactDir}/council-report.md`;
  const completedAt = now().toISOString();

  const reviewRouting =
    input.reviewRouting === undefined
      ? buildReviewRouting({
          mode: input.routingMode ?? "standard",
          mergeEligible: jobGroup.verdict === "pass",
          lanes: jobGroup.lanes,
        })
      : finalizeHeadlessCouncilRouting(input.reviewRouting, jobGroup.lanes);
  const finalRoutingGuaranteeConditions =
    input.reviewRouting === undefined
      ? []
      : collectRoutingGuaranteeDegradedConditions(
          reviewRouting,
          jobGroup.lanes,
        );
  const degradedConditions = uniqueStrings([
    ...jobGroup.degradedConditions,
    ...finalRoutingGuaranteeConditions,
  ]);
  const verdict = reviewVerdictWithRoutingGuarantees({
    laneVerdict: jobGroup.verdict,
    routingGuaranteeConditions: finalRoutingGuaranteeConditions,
  });

  const reviewMetadata: CouncilReviewMetadata = {
    reviewed_head_sha: input.currentHeadSha,
    previous_reviewed_head_sha: input.previousReviewedHeadSha ?? null,
    base_sha: input.baseSha,
    round: input.round,
    mode: input.mode,
    ...(input.reviewRouting === undefined &&
    (input.routingMode === undefined || input.routingMode === null)
      ? {}
      : { routing_mode: reviewRouting.mode }),
    verdict,
  };

  const result: HeadlessCouncilGateResult = {
    schemaVersion: 1,
    issueId: input.issueIdentifier,
    verdict,
    startedAt,
    completedAt,
    pr: {
      repo: input.pr.repo,
      number: input.pr.number,
      baseRef: input.pr.baseRef,
      headRef: input.pr.headRef,
    },
    review_metadata: reviewMetadata,
    review_routing: reviewRouting,
    review_bundle: input.reviewBundle ?? null,
    targeted_convergence: input.targetedConvergence ?? null,
    lanes: jobGroup.lanes,
    degradedConditions,
    artifactPaths: {
      artifactDir,
      diff: input.diffPath ?? null,
      reviewBundle: input.reviewBundle?.path ?? null,
      structuredArtifacts: jobGroup.lanes
        .map((lane) => lane.structuredArtifactPath ?? null)
        .filter((path): path is string => path !== null),
      resultJson: reviewResultPath,
      councilReport: councilReportPath,
    },
    summary: buildSummary(jobGroup, verdict, degradedConditions),
  };

  await input.mkdir(artifactDir);
  // SYMPH-855 council Track: write BOTH artifacts the result references — the
  // legacy council gate's writeResult writes review-result.json AND
  // council-report.md, so `artifactPaths.councilReport` must point at a file
  // that actually exists, not a dangling reference.
  await input.writeFile(councilReportPath, buildCouncilReport(result));
  await input.writeFile(
    reviewResultPath,
    `${JSON.stringify(result, null, 2)}\n`,
  );

  return {
    result,
    reviewResultPath,
    markerMessage: `${REVIEW_GATE_RESULT_MARKER_PREFIX} ${reviewResultPath}${REVIEW_GATE_RESULT_MARKER_SUFFIX}`,
    jobGroup,
    preReviewVerify: input.preReviewVerify ?? null,
  };
}

/**
 * Build the council routing record from the job-group lanes. The only
 * load-bearing field downstream is `decorrelationBasis.mergeEligible`, which is
 * the verdict-derived merge gate (`buildReviewJournalEntries` emits a
 * merge_candidate row only when it is true on a passing verdict). The
 * decorrelated reviewer set is the completed reviewer lanes, mirroring how the
 * in-process gate records its decorrelation evidence.
 */
function buildReviewRouting(input: {
  mode: CouncilRoutingMode;
  mergeEligible: boolean;
  lanes: HeadlessCouncilGateResult["lanes"];
}): CouncilReviewRouting {
  const decorrelatedReviewerArtifacts: CouncilDecorrelatedReviewerArtifact[] =
    input.lanes
      .filter(
        (lane) =>
          lane.state === "complete" &&
          lane.structuredArtifact !== undefined &&
          lane.structuredArtifact !== null,
      )
      .map((lane) => ({
        laneId: lane.laneId,
        agent: lane.agent,
        modelFamily: lane.structuredArtifact?.lane.modelFamily ?? "",
      }));

  return {
    schemaVersion: 1,
    mode: input.mode,
    selectedLanes: input.lanes.map((lane) => ({
      laneId: lane.laneId,
      agent: lane.agent,
      role: lane.role,
      required: lane.mergeAuthoritative,
      decorrelatedSignal: lane.independentReviewer,
      reason: "crabrunner_review_job_group",
    })),
    skippedLanes: [],
    decorrelationBasis: {
      authorFamilies: [],
      requiredNonAuthorFamilyReviewer: true,
      requiredReviewerLaneIds: input.lanes
        .filter((lane) => lane.mergeAuthoritative)
        .map((lane) => lane.laneId),
      directSignalLaneIds: [],
      decorrelatedReviewerArtifacts,
      mergeEligible: input.mergeEligible,
      summary: input.mergeEligible
        ? "Crabrunner review job group produced a passing decorrelated reviewer set."
        : "Crabrunner review job group did not produce a merge-eligible passing verdict.",
    },
    escalationPredicates: [],
    operatorOverrideReason: null,
    highRiskPredicate: {
      triggerHits: [],
      matchedPaths: [],
      matches: [],
    },
    leadConfidenceThreshold: 0,
  };
}

function buildSummary(
  jobGroup: CrabrunnerReviewJobGroupResult,
  verdict = jobGroup.verdict,
  degradedConditions = jobGroup.degradedConditions,
): string {
  const laneCount = jobGroup.lanes.length;
  const degraded =
    degradedConditions.length > 0 ? ` (${degradedConditions.join(", ")})` : "";
  return `Crabrunner review job group ${verdict} over ${laneCount} reviewer lane(s)${degraded}.`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * A minimal human-readable council report written alongside review-result.json,
 * so `artifactPaths.councilReport` references a real file (parity with the
 * legacy council gate, which writes both). Deep per-finding rendering stays the
 * gate's concern; this is a faithful summary of the job-group outcome.
 */
function buildCouncilReport(result: HeadlessCouncilGateResult): string {
  const lines = [
    `# Crabrunner review — ${result.issueId}`,
    "",
    `- Verdict: ${result.verdict}`,
    `- Reviewed head: ${result.review_metadata.reviewed_head_sha ?? "unknown"}`,
    `- Round: ${result.review_metadata.round}`,
    `- Lanes: ${result.lanes.map((lane) => `${lane.laneId}:${lane.verdict}`).join(", ") || "none"}`,
    `- Degraded conditions: ${result.degradedConditions.join(", ") || "none"}`,
    "",
    result.summary,
    "",
  ];
  return lines.join("\n");
}
