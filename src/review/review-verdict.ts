import { isMergeAuthoritative } from "./review-lanes.js";

export type ReviewGateVerdict = "pass" | "fail" | "error";

export type ReviewLaneDegradedReason =
  | "malformed_artifact"
  | "malformed_substrate_json"
  | "substrate_stall"
  | "artifact_persistence_failed"
  | "workspace_integrity_check_failed"
  | "workspace_mutation_detected";

export type RoutingGuaranteeEscalationPredicate =
  | "missing_required_lane"
  | "malformed_required_lane"
  | "degraded_required_lane"
  | "absent_decorrelated_reviewer_artifact";

export interface ReviewVerdictLane {
  verdict: ReviewGateVerdict;
  mergeAuthoritative?: boolean;
}

export interface RoutingGuaranteeLane extends ReviewVerdictLane {
  laneId: string;
  state: string;
  degradedReason: ReviewLaneDegradedReason | string | null;
}

export interface RoutingGuaranteeReviewRouting {
  decorrelationBasis: {
    authorFamilies: readonly string[];
    requiredNonAuthorFamilyReviewer: boolean;
    requiredReviewerLaneIds: readonly string[];
    decorrelatedReviewerArtifacts: readonly { laneId: string }[];
    mergeEligible: boolean;
  };
}

export function aggregateHeadlessVerdict(
  lanes: readonly ReviewVerdictLane[],
): ReviewGateVerdict {
  const authoritativeLanes = mergeAuthoritativeReviewLanes(lanes);
  if (authoritativeLanes.length === 0) {
    return "error";
  }
  if (authoritativeLanes.some((lane) => lane.verdict === "error")) {
    return "error";
  }
  if (authoritativeLanes.some((lane) => lane.verdict === "fail")) {
    return "fail";
  }
  return "pass";
}

export function reviewVerdictWithRoutingGuarantees(input: {
  laneVerdict: ReviewGateVerdict;
  routingGuaranteeConditions: readonly string[];
}): ReviewGateVerdict {
  if (
    input.laneVerdict === "pass" &&
    input.routingGuaranteeConditions.length > 0
  ) {
    return "error";
  }
  return input.laneVerdict;
}

export function collectRoutingGuaranteeDegradedConditions(
  routing: RoutingGuaranteeReviewRouting,
  lanes: readonly RoutingGuaranteeLane[],
): string[] {
  const conditions: string[] = [];
  for (const laneId of routing.decorrelationBasis.requiredReviewerLaneIds) {
    const lane = lanes.find((candidate) => candidate.laneId === laneId);
    if (lane === undefined) {
      conditions.push(`routing_required_lane_missing:${laneId}`);
      continue;
    }
    if (lane.degradedReason === "malformed_artifact") {
      conditions.push(`routing_required_lane_malformed:${laneId}`);
    } else if (
      lane.degradedReason !== null ||
      lane.state !== "complete" ||
      // A reviewer FAIL is a valid code-review outcome, not routing substrate
      // degradation; aggregateHeadlessVerdict and termination assessment handle
      // blocking findings from completed reviewer artifacts.
      lane.verdict === "error"
    ) {
      conditions.push(`routing_required_lane_degraded:${laneId}`);
    }
  }
  if (
    routing.decorrelationBasis.requiredNonAuthorFamilyReviewer &&
    routing.decorrelationBasis.authorFamilies.length === 0
  ) {
    conditions.push("routing_author_provenance_missing");
  }
  if (!routing.decorrelationBasis.mergeEligible) {
    conditions.push("routing_absent_decorrelated_reviewer_artifact");
  }
  const decorrelatedLaneIds = new Set(
    routing.decorrelationBasis.decorrelatedReviewerArtifacts.map(
      (artifact) => artifact.laneId,
    ),
  );
  for (const laneId of routing.decorrelationBasis.requiredReviewerLaneIds) {
    if (!decorrelatedLaneIds.has(laneId)) {
      conditions.push(`routing_required_lane_not_decorrelated:${laneId}`);
    }
  }
  return conditions;
}

export function routingGuaranteeEscalationPredicates(
  conditions: readonly string[],
): RoutingGuaranteeEscalationPredicate[] {
  const predicates: RoutingGuaranteeEscalationPredicate[] = [];
  for (const condition of conditions) {
    const predicate = routingGuaranteeEscalationPredicate(condition);
    if (predicate !== null) {
      predicates.push(predicate);
    }
  }
  return uniqueRoutingEscalationPredicates(predicates);
}

export function hasReviewSubstrateDegradation(input: {
  lanes: readonly RoutingGuaranteeLane[];
  degradedConditions: readonly string[];
}): boolean {
  return (
    input.lanes.some(
      (lane) => lane.verdict === "error" || lane.degradedReason !== null,
    ) || input.degradedConditions.some(isReviewSubstrateDegradedCondition)
  );
}

export function isRoutingOnlyProcedureStop(input: {
  verdict: ReviewGateVerdict;
  lanes: readonly RoutingGuaranteeLane[];
  degradedConditions: readonly string[];
  blockingFindingCount: number;
}): boolean {
  return (
    input.verdict === "error" &&
    input.blockingFindingCount === 0 &&
    input.lanes.length > 0 &&
    input.lanes.every(
      (lane) => lane.verdict === "pass" && lane.degradedReason === null,
    ) &&
    input.degradedConditions.length > 0 &&
    input.degradedConditions.every(isRoutingGuaranteeDegradedCondition)
  );
}

export function isRoutingGuaranteeDegradedCondition(
  condition: string,
): boolean {
  return routingGuaranteeEscalationPredicate(condition) !== null;
}

function mergeAuthoritativeReviewLanes(
  lanes: readonly ReviewVerdictLane[],
): ReviewVerdictLane[] {
  return lanes.filter(isMergeAuthoritative);
}

function routingGuaranteeEscalationPredicate(
  condition: string,
): RoutingGuaranteeEscalationPredicate | null {
  if (condition.startsWith("routing_required_lane_missing:")) {
    return "missing_required_lane";
  }
  if (condition.startsWith("routing_required_lane_malformed:")) {
    return "malformed_required_lane";
  }
  if (condition.startsWith("routing_required_lane_degraded:")) {
    return "degraded_required_lane";
  }
  if (
    condition === "routing_absent_decorrelated_reviewer_artifact" ||
    condition.startsWith("routing_required_lane_not_decorrelated:") ||
    condition === "routing_author_provenance_missing"
  ) {
    return "absent_decorrelated_reviewer_artifact";
  }
  return null;
}

function uniqueRoutingEscalationPredicates(
  predicates: readonly RoutingGuaranteeEscalationPredicate[],
): RoutingGuaranteeEscalationPredicate[] {
  return [...new Set(predicates)];
}

function isReviewSubstrateDegradedCondition(condition: string): boolean {
  if (condition === "codex-lead-disabled") {
    return false;
  }
  if (
    condition === "zero-reviewer-lanes" ||
    condition === "empty-diff" ||
    condition === "review-context-failed" ||
    condition === "cmux-preflight-failed" ||
    /^(duplicate|reserved)-reviewer-lane-id:/.test(condition)
  ) {
    return false;
  }
  if (/^[^:]+:complete:Reviewer verdict was FINDINGS\./.test(condition)) {
    return false;
  }
  return (
    condition.startsWith("malformed_artifact:") ||
    condition.startsWith("malformed_substrate_json:") ||
    condition.startsWith("artifact_persistence_failed:") ||
    condition.startsWith("workspace_integrity_check_failed:") ||
    condition.startsWith("workspace_mutation_detected:") ||
    condition.startsWith("substrate_stall:") ||
    condition.startsWith("review-bundle-footer-append-failed:")
  );
}
