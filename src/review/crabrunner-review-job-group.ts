import type { AgentRunInput } from "../agent/runner.js";
import type {
  StageExecutionBackendResult,
  StageExecutionBackendRunner,
  StageExecutionJobSpec,
} from "../stage-execution/backend.js";
import type { CrabrunnerStageExecutionEvidence } from "../stage-execution/crabrunner-backend.js";
import {
  type StageExecutionLaneDispatch,
  type StageExecutionLaneResult,
  runStageExecutionLanes,
} from "../stage-execution/multi-lane.js";
import {
  COUNCIL_REVIEW_MODES,
  COUNCIL_ROUTING_MODES,
  type HeadlessGateVerdict,
  type HeadlessLaneResult,
  type HeadlessReviewerAgent,
  type LaneDegradedReason,
  type StructuredReviewerArtifact,
} from "./headless-council-gate.js";
import {
  type BrowserQaAssessment,
  type BrowserQaEvidence,
  assessBrowserQaEvidence,
  parseBrowserQaEvidence,
} from "./qa-evidence.js";
import { recordOrNull } from "./record-utils.js";
import {
  type ReviewGateVerdict,
  type RoutingGuaranteeLane,
  aggregateHeadlessVerdict,
  reviewVerdictWithRoutingGuarantees,
} from "./review-verdict.js";

/**
 * SYMPH-810 — run a code-review (and optional browser-QA) stage as a crabrunner
 * JOB GROUP and produce the substrate-neutral review artifact contracts.
 *
 * One run group fans out N reviewer lanes plus an optional browser-QA lane, all
 * sharing a single `runGroupId`. Every lane is dispatched ONLY through the
 * resolved `StageExecutionBackendRunner.execute` (the same seam other delegated
 * stages use — SYMPH-835/850), never a direct crabrunner scheduler client, so
 * the scheduler stays an internal swap and this module is fully testable with a
 * fake backend.
 *
 * Each lane's host-owned crabrunner artifact is collected and mapped onto the
 * existing review contracts — `HeadlessLaneResult` /
 * `StructuredReviewerArtifact` for reviewers, `BrowserQaEvidence` for QA — and
 * the verdict is aggregated with the extracted `review-verdict` module. This
 * module reuses those contracts; it does not duplicate them, and it does NOT
 * touch the merge-readiness contract or the review-result validator (those are
 * owned by the orchestrator / council gate).
 *
 * Fail-closed is the rule, never the exception. Any of the following yields an
 * `error` verdict (a clean PASS is impossible when integrity is unprovable):
 *   - a reviewer lane is unavailable (admission rejected, runner failed),
 *   - admission is ambiguous (accepted without a job id),
 *   - a succeeded lane produced no host-owned artifact refs (cross-host
 *     provenance cannot be established),
 *   - the collected artifact is missing or malformed,
 *   - the artifact targets a stale head (freshness: the rerun must assert the
 *     current PR head),
 *   - routing guarantees fail on an otherwise-passing group,
 *   - the browser-QA failure rule is violated, QA evidence is missing/malformed,
 *     or an assertion failed.
 */

export type ReviewJobGroupLaneKind = "reviewer" | "browser-qa";

export interface CrabrunnerReviewLaneSpec {
  laneId: string;
  kind: ReviewJobGroupLaneKind;
  agent: HeadlessReviewerAgent;
  role: string;
  model: string;
  modelFamily: string;
  reasoningEffort: string | null;
  independentReviewer: boolean;
  mergeAuthoritative: boolean;
}

/**
 * The per-lane crabrunner evidence handed to the artifact collector — the lane
 * spec, its dispatch result, and the host-owned crabrunner artifact refs. The
 * collector resolves a ref into a parsed artifact (or null) the same way
 * production reads a host-owned artifact file.
 */
export interface ReviewJobGroupLaneEvidence {
  laneId: string;
  kind: ReviewJobGroupLaneKind;
  spec: CrabrunnerReviewLaneSpec;
  jobId: string | null;
  artifactRefs: readonly string[];
  backendResult: StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>;
}

/**
 * Explicit cross-host provenance for one lane: which run group / job produced
 * the host-owned artifact refs (and their hashes when present). This is the
 * integrity record that proves a passing verdict came from real, collectible,
 * host-owned artifacts and not a local assumption.
 */
export interface ReviewJobGroupLaneProvenance {
  laneId: string;
  runGroupId: string;
  jobId: string | null;
  artifactRefs: readonly string[];
  artifactHashes: readonly string[];
  backendResult: StageExecutionBackendResult<CrabrunnerStageExecutionEvidence>;
}

export interface ReviewJobGroupProvenance {
  runGroupId: string;
  currentHeadSha: string;
  lanes: ReviewJobGroupLaneProvenance[];
}

export interface ReviewJobGroupQaResult {
  laneId: string;
  evidence: BrowserQaEvidence | null;
  assessment: BrowserQaAssessment;
}

export interface CrabrunnerReviewJobGroupResult {
  verdict: HeadlessGateVerdict;
  runGroupId: string;
  /** Reviewer lanes only, mapped onto the existing HeadlessLaneResult contract. */
  lanes: HeadlessLaneResult[];
  /** Machine-readable conditions that drove a non-pass verdict. */
  degradedConditions: string[];
  provenance: ReviewJobGroupProvenance;
  qa: ReviewJobGroupQaResult | null;
}

export interface RunCrabrunnerReviewJobGroupInput {
  issueId: string;
  runGroupId: string;
  /** The current PR head SHA the rerun must assert (freshness). */
  currentHeadSha: string;
  lanes: readonly CrabrunnerReviewLaneSpec[];
  /** The crabrunner backend — the only dispatch surface (seam insulation). */
  backend: StageExecutionBackendRunner<CrabrunnerStageExecutionEvidence>;
  buildJobSpec: (lane: CrabrunnerReviewLaneSpec) => StageExecutionJobSpec;
  buildRunnerInput: (lane: CrabrunnerReviewLaneSpec) => AgentRunInput;
  /**
   * Resolve a lane's host-owned crabrunner artifact ref into a parsed artifact
   * record (or null when absent). Kept as an injected boundary so this module
   * never reads the filesystem directly and stays deterministic in tests.
   */
  collectArtifact: (
    lane: ReviewJobGroupLaneEvidence,
  ) => Promise<unknown> | unknown;
  /**
   * Routing-guarantee conditions resolved by the caller (e.g. the council
   * routing evidence check). A non-empty set downgrades an otherwise-passing
   * verdict to error, exactly like the in-process gate.
   */
  routingGuaranteeConditions?: readonly string[];
  /** Missing/degraded QA artifact policy. Default: fail closed ("block"). */
  qaMissingPolicy?: "block" | "degrade";
}

/**
 * Per-lane mapping outcome: a reviewer lane contributes a HeadlessLaneResult, a
 * verdict lane, and any degraded conditions; a QA lane contributes a QA result.
 */
interface ReviewerLaneMapping {
  laneResult: HeadlessLaneResult;
  verdictLane: RoutingGuaranteeLane;
  conditions: string[];
}

interface ReviewLaneCollection {
  reviewerMapping: ReviewerLaneMapping | null;
  qaResult: ReviewJobGroupQaResult | null;
  provenance: ReviewJobGroupLaneProvenance | null;
  degradedConditions: readonly string[];
}

export async function runCrabrunnerReviewJobGroup(
  input: RunCrabrunnerReviewJobGroupInput,
): Promise<CrabrunnerReviewJobGroupResult> {
  if (input.backend.backend !== "crabrunner") {
    // Job-group invariant: review/QA lanes run through crabrunner. A non-
    // crabrunner backend is a misconfiguration, not a degraded run — fail loud.
    throw new Error(
      `runCrabrunnerReviewJobGroup requires a crabrunner backend, received "${input.backend.backend}".`,
    );
  }

  // Contract: at most ONE optional browser-QA lane. More than one would let a
  // later passing QA result overwrite an earlier blocking one (only the last
  // qaResult is retained), so a multi-QA-lane group fails closed BEFORE any
  // dispatch rather than risking a masked blocking QA.
  const browserQaLaneCount = input.lanes.filter(
    (lane) => lane.kind === "browser-qa",
  ).length;
  if (browserQaLaneCount > 1) {
    return {
      verdict: "error",
      runGroupId: input.runGroupId,
      lanes: [],
      degradedConditions: ["multiple_browser_qa_lanes"],
      provenance: {
        runGroupId: input.runGroupId,
        currentHeadSha: input.currentHeadSha,
        lanes: [],
      },
      qa: null,
    };
  }

  // SYMPH-855 Track (a): a group with ZERO reviewer lanes has no
  // merge-authoritative verdict to produce — a clean PASS is impossible and a
  // QA-only group would dispatch a QA lane that nothing gates. Fail closed
  // BEFORE any dispatch with an explicit condition rather than relying on the
  // empty-aggregate "error" (which would otherwise be an unexplained verdict
  // with no degraded reason).
  const reviewerLaneCount = input.lanes.filter(
    (lane) => lane.kind === "reviewer",
  ).length;
  if (reviewerLaneCount === 0) {
    return {
      verdict: "error",
      runGroupId: input.runGroupId,
      lanes: [],
      degradedConditions: ["no_reviewer_lanes"],
      provenance: {
        runGroupId: input.runGroupId,
        currentHeadSha: input.currentHeadSha,
        lanes: [],
      },
      qa: null,
    };
  }

  const laneRun = await runStageExecutionLanes<
    CrabrunnerReviewLaneSpec,
    ReviewLaneCollection,
    CrabrunnerReviewJobGroupResult,
    CrabrunnerStageExecutionEvidence
  >({
    lanes: input.lanes,
    dispatchMode: "parallel",
    buildJobSpec: (lane) => input.buildJobSpec(lane),
    buildRunnerInput: (lane) => input.buildRunnerInput(lane),
    resolveBackend: () => input.backend,
    expectedIdentity: {
      issueId: input.issueId,
      runGroupId: input.runGroupId,
    },
    collectArtifact: (laneDispatch) =>
      collectReviewLane({
        laneDispatch,
        runGroupId: input.runGroupId,
        currentHeadSha: input.currentHeadSha,
        collectArtifact: input.collectArtifact,
        qaMissingPolicy: input.qaMissingPolicy ?? "block",
      }),
    aggregate: (lanes) =>
      aggregateReviewLanes({
        lanes,
        runGroupId: input.runGroupId,
        currentHeadSha: input.currentHeadSha,
        routingGuaranteeConditions: input.routingGuaranteeConditions ?? [],
        qaMissingPolicy: input.qaMissingPolicy ?? "block",
      }),
  });

  return laneRun.aggregate;
}

async function collectReviewLane(input: {
  laneDispatch: StageExecutionLaneDispatch<
    CrabrunnerReviewLaneSpec,
    CrabrunnerStageExecutionEvidence
  >;
  runGroupId: string;
  currentHeadSha: string;
  collectArtifact: RunCrabrunnerReviewJobGroupInput["collectArtifact"];
  qaMissingPolicy: "block" | "degrade";
}): Promise<ReviewLaneCollection> {
  const lane = input.laneDispatch.lane;
  const validationCondition = reviewValidationCondition(input.laneDispatch);
  if (validationCondition !== null) {
    return validationFailureCollection({
      lane,
      condition: validationCondition.condition,
      message: validationCondition.message,
      qaMissingPolicy: input.qaMissingPolicy,
    });
  }

  if (
    input.laneDispatch.dispatchStatus !== "completed" ||
    input.laneDispatch.backendResult === null
  ) {
    return unavailableLaneCollection({
      lane,
      qaMissingPolicy: input.qaMissingPolicy,
    });
  }

  const backendResult = input.laneDispatch.backendResult;
  const evidence = backendResult.evidence;
  const jobId = evidence?.admission.jobId ?? null;
  const artifactRefs = evidence?.artifactRefs ?? [];
  const provenance: ReviewJobGroupLaneProvenance = {
    laneId: lane.laneId,
    runGroupId: input.runGroupId,
    jobId,
    artifactRefs,
    artifactHashes: collectArtifactHashes(evidence),
    backendResult,
  };
  const laneEvidence: ReviewJobGroupLaneEvidence = {
    laneId: lane.laneId,
    kind: lane.kind,
    spec: lane,
    jobId,
    artifactRefs,
    backendResult,
  };

  // Substrate-level fail-closed checks shared by all lane kinds.
  const substrateCondition = classifyLaneSubstrate({
    lane,
    evidence,
    jobId,
    artifactRefs,
    runStatus: backendResult.result.runAttempt.status,
  });

  if (lane.kind === "browser-qa") {
    const qaResult = await assessQaLane({
      lane,
      laneEvidence,
      substrateCondition,
      currentHeadSha: input.currentHeadSha,
      collectArtifact: input.collectArtifact,
      qaMissingPolicy: input.qaMissingPolicy,
    });
    return {
      reviewerMapping: null,
      qaResult,
      provenance,
      degradedConditions: qaResult.assessment.reasons,
    };
  }

  const reviewerMapping = await mapReviewerLane({
    lane,
    laneEvidence,
    substrateCondition,
    currentHeadSha: input.currentHeadSha,
    collectArtifact: input.collectArtifact,
  });
  return {
    reviewerMapping,
    qaResult: null,
    provenance,
    degradedConditions: reviewerMapping.conditions,
  };
}

function aggregateReviewLanes(input: {
  lanes: readonly StageExecutionLaneResult<
    CrabrunnerReviewLaneSpec,
    ReviewLaneCollection,
    CrabrunnerStageExecutionEvidence
  >[];
  runGroupId: string;
  currentHeadSha: string;
  routingGuaranteeConditions: readonly string[];
  qaMissingPolicy: "block" | "degrade";
}): CrabrunnerReviewJobGroupResult {
  const reviewerMappings: ReviewerLaneMapping[] = [];
  const provenanceLanes: ReviewJobGroupLaneProvenance[] = [];
  const degradedConditions: string[] = [];
  let qaResult: ReviewJobGroupQaResult | null = null;

  for (const laneResult of input.lanes) {
    const collected =
      laneResult.artifact ??
      unavailableLaneCollection({
        lane: laneResult.lane,
        qaMissingPolicy: input.qaMissingPolicy,
      });
    if (collected.reviewerMapping !== null) {
      reviewerMappings.push(collected.reviewerMapping);
    }
    if (collected.qaResult !== null) {
      qaResult = collected.qaResult;
    }
    if (collected.provenance !== null) {
      provenanceLanes.push(collected.provenance);
    }
    degradedConditions.push(...collected.degradedConditions);
  }

  const verdict = resolveGroupVerdict({
    reviewerMappings,
    routingGuaranteeConditions: input.routingGuaranteeConditions,
    qaResult,
  });

  // Routing-guarantee conditions are machine-readable reasons for a non-pass
  // verdict; surface them in degradedConditions (they feed the verdict but were
  // otherwise invisible there). Appended after lane/QA conditions to preserve
  // ordering, deduped against anything already recorded.
  for (const condition of input.routingGuaranteeConditions) {
    if (!degradedConditions.includes(condition)) {
      degradedConditions.push(condition);
    }
  }

  return {
    verdict,
    runGroupId: input.runGroupId,
    lanes: reviewerMappings.map((mapping) => mapping.laneResult),
    degradedConditions,
    provenance: {
      runGroupId: input.runGroupId,
      currentHeadSha: input.currentHeadSha,
      lanes: provenanceLanes,
    },
    qa: qaResult,
  };
}

function validationFailureCollection(input: {
  lane: CrabrunnerReviewLaneSpec;
  condition: string;
  message: string;
  qaMissingPolicy: "block" | "degrade";
}): ReviewLaneCollection {
  if (input.lane.kind === "browser-qa") {
    const assessment = assessBrowserQaEvidence(null, {
      policy: input.qaMissingPolicy,
    });
    const qaResult: ReviewJobGroupQaResult = {
      laneId: input.lane.laneId,
      evidence: null,
      assessment: {
        ...assessment,
        reasons: [...assessment.reasons, input.condition],
      },
    };
    return {
      reviewerMapping: null,
      qaResult,
      provenance: null,
      degradedConditions: qaResult.assessment.reasons,
    };
  }

  const reviewerMapping = errorReviewerMapping({
    lane: input.lane,
    condition: input.condition,
    degradedReason: "malformed_artifact",
    message: input.message,
  });
  return {
    reviewerMapping,
    qaResult: null,
    provenance: null,
    degradedConditions: reviewerMapping.conditions,
  };
}

function unavailableLaneCollection(input: {
  lane: CrabrunnerReviewLaneSpec;
  qaMissingPolicy: "block" | "degrade";
}): ReviewLaneCollection {
  const condition = `lane_unavailable:${input.lane.laneId}`;
  if (input.lane.kind === "browser-qa") {
    const assessment = assessBrowserQaEvidence(null, {
      policy: input.qaMissingPolicy,
    });
    const qaResult: ReviewJobGroupQaResult = {
      laneId: input.lane.laneId,
      evidence: null,
      assessment: {
        ...assessment,
        reasons: [...assessment.reasons, condition],
      },
    };
    return {
      reviewerMapping: null,
      qaResult,
      provenance: null,
      degradedConditions: qaResult.assessment.reasons,
    };
  }

  const reviewerMapping = errorReviewerMapping({
    lane: input.lane,
    condition,
    degradedReason: null,
    message: condition,
  });
  return {
    reviewerMapping,
    qaResult: null,
    provenance: null,
    degradedConditions: reviewerMapping.conditions,
  };
}

function reviewValidationCondition(
  laneDispatch: StageExecutionLaneDispatch<
    CrabrunnerReviewLaneSpec,
    CrabrunnerStageExecutionEvidence
  >,
): { condition: string; message: string } | null {
  const runGroupMismatch = laneDispatch.validationErrors.find(
    (error) => error.field === "runGroupId",
  );
  if (runGroupMismatch !== undefined) {
    return {
      condition: `run_group_mismatch:${laneDispatch.lane.laneId}`,
      message: [
        `lane job spec runGroupId ${runGroupMismatch.actual}`,
        `does not match group ${runGroupMismatch.expected}`,
      ].join(" "),
    };
  }
  const firstMismatch = laneDispatch.validationErrors[0];
  if (firstMismatch === undefined) {
    return null;
  }
  return {
    condition: `identity_mismatch:${laneDispatch.lane.laneId}`,
    message: firstMismatch.message,
  };
}

type LaneSubstrateCondition =
  | { ok: true }
  | {
      ok: false;
      condition: string;
      degradedReason: LaneDegradedReason | null;
      laneState: "error" | "failed";
    };

/**
 * Substrate-level (transport) fail-closed classification, applied before any
 * artifact parsing. Covers lane unavailability, admission ambiguity, and
 * cross-host artifact provenance.
 */
function classifyLaneSubstrate(input: {
  lane: CrabrunnerReviewLaneSpec;
  evidence: CrabrunnerStageExecutionEvidence | undefined;
  jobId: string | null;
  artifactRefs: readonly string[];
  runStatus: string;
}): LaneSubstrateCondition {
  const { lane, evidence, jobId, artifactRefs, runStatus } = input;

  if (evidence === undefined) {
    return {
      ok: false,
      condition: `lane_unavailable:${lane.laneId}`,
      degradedReason: null,
      laneState: "error",
    };
  }

  if (evidence.admission.status === "rejected") {
    return {
      ok: false,
      condition: `lane_unavailable:${lane.laneId}`,
      degradedReason: null,
      laneState: "error",
    };
  }

  // Accepted but no job id: concurrency/admission ambiguity. We cannot prove the
  // lane was actually scheduled, so it must not become a pass.
  if (
    evidence.admission.status === "accepted" &&
    (jobId === null || jobId.trim() === "")
  ) {
    return {
      ok: false,
      condition: `admission_ambiguous:${lane.laneId}`,
      degradedReason: null,
      laneState: "error",
    };
  }

  const terminalState = evidence.terminal?.state ?? null;
  if (terminalState !== "succeeded" || runStatus !== "succeeded") {
    return {
      ok: false,
      condition: `lane_unavailable:${lane.laneId}`,
      degradedReason: null,
      laneState: "error",
    };
  }

  // Cross-host provenance: a succeeded lane MUST carry host-owned artifact refs.
  // Without them the integrity of the result cannot be established.
  if (artifactRefs.length === 0) {
    return {
      ok: false,
      condition: `artifact_provenance_missing:${lane.laneId}`,
      degradedReason: "artifact_persistence_failed",
      laneState: "error",
    };
  }

  return { ok: true };
}

async function mapReviewerLane(input: {
  lane: CrabrunnerReviewLaneSpec;
  laneEvidence: ReviewJobGroupLaneEvidence;
  substrateCondition: LaneSubstrateCondition;
  currentHeadSha: string;
  collectArtifact: (
    lane: ReviewJobGroupLaneEvidence,
  ) => Promise<unknown> | unknown;
}): Promise<ReviewerLaneMapping> {
  const { lane } = input;

  if (!input.substrateCondition.ok) {
    return errorReviewerMapping({
      lane,
      condition: input.substrateCondition.condition,
      degradedReason: input.substrateCondition.degradedReason,
      message: input.substrateCondition.condition,
    });
  }

  const collected = await input.collectArtifact(input.laneEvidence);
  const artifact = parseReviewerArtifact(collected);
  if (artifact === null) {
    return errorReviewerMapping({
      lane,
      condition: `malformed_artifact:${lane.laneId}`,
      degradedReason: "malformed_artifact",
      message: "reviewer artifact missing or malformed",
    });
  }

  // Anti-spoof: the collected artifact must be bound to THIS lane. An artifact
  // whose self-reported lane identity (laneId/agent/modelFamily) does not match
  // the lane spec it was collected for could be a misattributed artifact from
  // another lane/head and must never be counted in verdict aggregation.
  const artifactLane = artifact.structuredArtifact.lane;
  if (
    artifactLane.laneId !== lane.laneId ||
    artifactLane.agent !== lane.agent ||
    artifactLane.modelFamily !== lane.modelFamily
  ) {
    return errorReviewerMapping({
      lane,
      condition: `artifact_lane_mismatch:${lane.laneId}`,
      degradedReason: "malformed_artifact",
      message: `reviewer artifact lane ${artifactLane.agent}/${artifactLane.modelFamily}#${artifactLane.laneId} does not match expected lane ${lane.agent}/${lane.modelFamily}#${lane.laneId}`,
      structuredArtifact: artifact.structuredArtifact,
    });
  }

  // Freshness: the rerun must assert the current PR head. A reviewer artifact
  // bound to any other head SHA is stale and fails closed.
  if (artifact.headSha !== input.currentHeadSha) {
    return errorReviewerMapping({
      lane,
      condition: `stale_review:${lane.laneId}`,
      degradedReason: null,
      message: `reviewer artifact head ${artifact.headSha} != current head ${input.currentHeadSha}`,
      structuredArtifact: artifact.structuredArtifact,
    });
  }

  const verdict = artifact.structuredArtifact.verdict;
  const laneResult: HeadlessLaneResult = {
    laneId: lane.laneId,
    agent: lane.agent,
    role: lane.role,
    model: lane.model,
    state: "complete",
    verdict,
    artifactPath: input.laneEvidence.artifactRefs[0] ?? null,
    promptPath: null,
    stderrPath: null,
    cliJsonPath: null,
    reasoningEffort: lane.reasoningEffort,
    independentReviewer: lane.independentReviewer,
    mergeAuthoritative: lane.mergeAuthoritative,
    message: null,
    degradedReason: null,
    reviewBundle: null,
    wallTimeMs: null,
    tokenUsage: null,
    structuredArtifactPath: artifact.structuredArtifactPath,
    structuredArtifact: artifact.structuredArtifact,
  };

  return {
    laneResult,
    verdictLane: {
      laneId: lane.laneId,
      verdict,
      mergeAuthoritative: lane.mergeAuthoritative,
      state: "complete",
      degradedReason: null,
    },
    conditions: [],
  };
}

function errorReviewerMapping(input: {
  lane: CrabrunnerReviewLaneSpec;
  condition: string;
  degradedReason: LaneDegradedReason | null;
  message: string;
  structuredArtifact?: StructuredReviewerArtifact;
}): ReviewerLaneMapping {
  const laneResult: HeadlessLaneResult = {
    laneId: input.lane.laneId,
    agent: input.lane.agent,
    role: input.lane.role,
    model: input.lane.model,
    state: "error",
    verdict: "error",
    artifactPath: null,
    promptPath: null,
    stderrPath: null,
    cliJsonPath: null,
    reasoningEffort: input.lane.reasoningEffort,
    independentReviewer: input.lane.independentReviewer,
    mergeAuthoritative: input.lane.mergeAuthoritative,
    message: input.message,
    degradedReason: input.degradedReason,
    reviewBundle: null,
    wallTimeMs: null,
    tokenUsage: null,
    ...(input.structuredArtifact === undefined
      ? {}
      : { structuredArtifact: input.structuredArtifact }),
  };
  return {
    laneResult,
    verdictLane: {
      laneId: input.lane.laneId,
      verdict: "error",
      mergeAuthoritative: input.lane.mergeAuthoritative,
      state: "error",
      degradedReason: input.degradedReason,
    },
    conditions: [input.condition],
  };
}

async function assessQaLane(input: {
  lane: CrabrunnerReviewLaneSpec;
  laneEvidence: ReviewJobGroupLaneEvidence;
  substrateCondition: LaneSubstrateCondition;
  currentHeadSha: string;
  collectArtifact: (
    lane: ReviewJobGroupLaneEvidence,
  ) => Promise<unknown> | unknown;
  qaMissingPolicy: "block" | "degrade";
}): Promise<ReviewJobGroupQaResult> {
  if (!input.substrateCondition.ok) {
    // A QA lane that never produced collectible evidence is treated as missing
    // QA evidence under the configured policy (fail closed by default), and the
    // underlying substrate condition is preserved as a reason.
    const assessment = assessBrowserQaEvidence(null, {
      policy: input.qaMissingPolicy,
    });
    return {
      laneId: input.lane.laneId,
      evidence: null,
      assessment: {
        ...assessment,
        reasons: [...assessment.reasons, input.substrateCondition.condition],
      },
    };
  }

  const collected = await input.collectArtifact(input.laneEvidence);
  const evidence = parseBrowserQaEvidence(collected);
  // Freshness is asserted here too: the QA evidence must target the current PR
  // head, mirroring the reviewer-lane stale-head check.
  const assessment = assessBrowserQaEvidence(evidence, {
    policy: input.qaMissingPolicy,
    currentHeadSha: input.currentHeadSha,
  });
  return { laneId: input.lane.laneId, evidence, assessment };
}

function resolveGroupVerdict(input: {
  reviewerMappings: readonly ReviewerLaneMapping[];
  routingGuaranteeConditions: readonly string[];
  qaResult: ReviewJobGroupQaResult | null;
}): HeadlessGateVerdict {
  const laneVerdict: ReviewGateVerdict = aggregateHeadlessVerdict(
    input.reviewerMappings.map((mapping) => mapping.verdictLane),
  );
  const withRouting = reviewVerdictWithRoutingGuarantees({
    laneVerdict,
    routingGuaranteeConditions: input.routingGuaranteeConditions,
  });

  // A blocking/degraded QA assessment fails the group closed even when the
  // reviewer lanes pass. QA is gating, not advisory.
  if (input.qaResult?.assessment.blocking && withRouting === "pass") {
    return "error";
  }
  return withRouting;
}

interface ParsedReviewerArtifact {
  headSha: string;
  structuredArtifact: StructuredReviewerArtifact;
  structuredArtifactPath: string | null;
}

const REQUIRED_REVIEWER_SECTION_KEYS = [
  "p1",
  "p2",
  "track",
  "dismissedOrTheoretical",
  "triage",
] as const;

/**
 * Parse a collected reviewer artifact record into the existing
 * `StructuredReviewerArtifact` contract plus the head SHA it was bound to.
 * Returns null for any non-object / wrong-kind / wrong-schema input so the lane
 * fails closed as malformed.
 *
 * This validates the FULL structured-artifact envelope — not just the lane
 * identity — so a structurally incomplete artifact (e.g. verdict:"pass" but
 * missing routing/confidence/sections/findings) can never produce a group PASS
 * (P2-A). Deep per-finding/section *content* validation remains owned by the
 * council gate's validator; here we require every top-level field to be present
 * and well-typed.
 */
function parseReviewerArtifact(value: unknown): ParsedReviewerArtifact | null {
  const record = recordOrNull(value);
  if (record === null) {
    return null;
  }
  if (
    record.kind !== "symphony-headless-council-reviewer-artifact" ||
    record.schemaVersion !== 1
  ) {
    return null;
  }
  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "error") {
    return null;
  }
  const headSha = record.headSha;
  if (typeof headSha !== "string" || headSha.trim() === "") {
    return null;
  }
  if (!isWellFormedReviewerLane(record.lane)) {
    return null;
  }
  if (!isWellFormedReviewerRouting(record.routing)) {
    return null;
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence)
  ) {
    return null;
  }
  if (!isWellFormedReviewerSections(record.sections)) {
    return null;
  }
  // Findings must be present (entries may be empty, e.g. a clean PASS). Legacy
  // per-lane familySyntheses were removed at the spine cutover; spine-sourced
  // family synthesis is reported on the aggregate review/termination instead.
  if (!Array.isArray(record.findings)) {
    return null;
  }
  // parseStatus is the artifact's self-report of its own parse. The only
  // well-formed value is "synthesized_from_markdown"; "malformed" (or any other
  // value / absence) is a self-declared bad parse and fails closed regardless of
  // the verdict field.
  if (record.parseStatus !== "synthesized_from_markdown") {
    return null;
  }
  // A non-null malformedReason is a self-declared malformed artifact even if
  // parseStatus somehow says otherwise — belt and suspenders, fail closed.
  if (record.malformedReason !== null) {
    return null;
  }
  // The remaining nullable top-level fields must still be PRESENT and correctly
  // typed (string | null): an omitted field is contract drift, not a valid null.
  if (!isPresentNullableString(record, "rawArtifactPath")) {
    return null;
  }
  // reviewBundle is `ReviewBundleReference | null`; require it present (null or a
  // non-array object). Deep ReviewBundleReference field validation stays owned by
  // the council gate.
  if (!isPresentNullableObject(record, "reviewBundle")) {
    return null;
  }
  return {
    headSha,
    structuredArtifact: record as unknown as StructuredReviewerArtifact,
    structuredArtifactPath:
      typeof record.structuredArtifactPath === "string" &&
      record.structuredArtifactPath.trim() !== ""
        ? record.structuredArtifactPath
        : null,
  };
}

/**
 * True when `key` is an OWN property of `record` and its value is `string` or
 * `null` (a present nullable string). An absent key is contract drift, not a
 * valid null, so it returns false.
 */
function isPresentNullableString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.hasOwn(record, key)) {
    return false;
  }
  const value = record[key];
  return value === null || typeof value === "string";
}

/**
 * True when `key` is an OWN property of `record` and its value is `null` or a
 * non-array object (a present nullable object).
 */
function isPresentNullableObject(
  record: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.hasOwn(record, key)) {
    return false;
  }
  const value = record[key];
  return value === null || recordOrNull(value) !== null;
}

function isWellFormedReviewerLane(value: unknown): boolean {
  const lane = recordOrNull(value);
  return (
    lane !== null &&
    typeof lane.laneId === "string" &&
    typeof lane.agent === "string" &&
    typeof lane.role === "string" &&
    typeof lane.model === "string" &&
    typeof lane.modelFamily === "string" &&
    // reasoningEffort is `string | null` — present, nullable allowed (TR-1).
    isPresentNullableString(lane, "reasoningEffort") &&
    typeof lane.independentReviewer === "boolean" &&
    typeof lane.mergeAuthoritative === "boolean"
  );
}

// Both membership sets derive from the canonical const arrays in
// headless-council-gate (SYMPH-855 council P2-3) so they can never drift from
// the types. `mode` and `routingMode` are intentionally DIFFERENT domains:
// `mode` is the review convergence-loop shape (full|convergence); `routingMode`
// is lane selection (fast|standard|…).
const COUNCIL_REVIEW_MODE_SET: ReadonlySet<string> = new Set(
  COUNCIL_REVIEW_MODES,
);
const COUNCIL_ROUTING_MODE_SET: ReadonlySet<string> = new Set(
  COUNCIL_ROUTING_MODES,
);

/**
 * SYMPH-855 Track (b): validate the routing/guarantee MODE rather than trusting
 * it. SYMPH-810 only checked that `routing.mode` was *a string* and `round` a
 * finite number, so a spoofed/drifted artifact could carry any mode and still
 * be counted. The mode must be a real council review mode, and a present
 * `routingMode` must be a known council routing mode (or null = "no forced
 * mode"). An unknown value is contract drift and fails the artifact closed.
 */
function isWellFormedReviewerRouting(value: unknown): boolean {
  const routing = recordOrNull(value);
  if (
    routing === null ||
    typeof routing.mode !== "string" ||
    !COUNCIL_REVIEW_MODE_SET.has(routing.mode) ||
    typeof routing.round !== "number" ||
    !Number.isFinite(routing.round)
  ) {
    return false;
  }
  // routingMode is `CouncilRoutingMode | null`. null/absent is the legitimate
  // "no forced routing mode"; a present string must be a known routing mode.
  const routingMode = routing.routingMode;
  if (routingMode === null || routingMode === undefined) {
    return true;
  }
  return (
    typeof routingMode === "string" && COUNCIL_ROUTING_MODE_SET.has(routingMode)
  );
}

function isWellFormedReviewerSections(value: unknown): boolean {
  const sections = recordOrNull(value);
  if (sections === null) {
    return false;
  }
  return REQUIRED_REVIEWER_SECTION_KEYS.every(
    (key) => typeof sections[key] === "string",
  );
}

function collectArtifactHashes(
  evidence: CrabrunnerStageExecutionEvidence | undefined,
): readonly string[] {
  if (evidence === undefined) {
    return [];
  }
  if (
    evidence.artifactHashes !== undefined &&
    evidence.artifactHashes.length > 0
  ) {
    return evidence.artifactHashes;
  }
  return evidence.terminal?.artifactHashes ?? [];
}
