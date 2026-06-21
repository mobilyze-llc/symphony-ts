import { resolve } from "node:path";

import type { AgentRunInput } from "../agent/runner.js";
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
import type {
  CouncilDecorrelatedReviewerArtifact,
  CouncilReviewMetadata,
  CouncilReviewMode,
  CouncilReviewRouting,
  CouncilRoutingMode,
  HeadlessCouncilGateResult,
} from "./headless-council-gate.js";

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
  lanes: readonly CrabrunnerReviewLaneSpec[];
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
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
  issueId: string;
  issueIdentifier: string;
  stageName: string | null;
  /** Run-group artifact root the review-result.json is written under. */
  artifactRoot: string;
  baseRef: string | null;
  signal: AbortSignal;
  /** The resolved crabrunner backend (the only dispatch surface). */
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
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
  const completedAt = now().toISOString();

  const mergeEligible = jobGroup.verdict === "pass";
  const reviewRouting = buildReviewRouting({
    mode: input.routingMode ?? "standard",
    mergeEligible,
    lanes: jobGroup.lanes,
  });

  const reviewMetadata: CouncilReviewMetadata = {
    reviewed_head_sha: input.currentHeadSha,
    previous_reviewed_head_sha: null,
    base_sha: input.baseSha,
    round: input.round,
    mode: input.mode,
    ...(input.routingMode === undefined || input.routingMode === null
      ? {}
      : { routing_mode: input.routingMode }),
    verdict: jobGroup.verdict,
  };

  const result: HeadlessCouncilGateResult = {
    schemaVersion: 1,
    issueId: input.issueIdentifier,
    verdict: jobGroup.verdict,
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
    review_bundle: null,
    targeted_convergence: null,
    lanes: jobGroup.lanes,
    degradedConditions: jobGroup.degradedConditions,
    artifactPaths: {
      artifactDir,
      diff: null,
      reviewBundle: null,
      structuredArtifacts: jobGroup.lanes
        .map((lane) => lane.structuredArtifactPath ?? null)
        .filter((path): path is string => path !== null),
      resultJson: reviewResultPath,
      councilReport: `${artifactDir}/council-report.md`,
    },
    summary: buildSummary(jobGroup),
  };

  await input.mkdir(artifactDir);
  await input.writeFile(
    reviewResultPath,
    `${JSON.stringify(result, null, 2)}\n`,
  );

  return {
    result,
    reviewResultPath,
    markerMessage: `${REVIEW_GATE_RESULT_MARKER_PREFIX} ${reviewResultPath}${REVIEW_GATE_RESULT_MARKER_SUFFIX}`,
    jobGroup,
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

function buildSummary(jobGroup: CrabrunnerReviewJobGroupResult): string {
  const laneCount = jobGroup.lanes.length;
  const degraded =
    jobGroup.degradedConditions.length > 0
      ? ` (${jobGroup.degradedConditions.join(", ")})`
      : "";
  return `Crabrunner review job group ${jobGroup.verdict} over ${laneCount} reviewer lane(s)${degraded}.`;
}
