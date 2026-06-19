import { isMergeAuthoritative } from "./review-lanes.js";
import type { ReviewGateVerdict } from "./review-verdict.js";

export interface CouncilRoutingEvidenceResult {
  review_routing: unknown;
  review_metadata: { routing_mode?: unknown };
  lanes: readonly CouncilRoutingEvidenceLane[];
}

interface CouncilRoutingEvidenceLane {
  laneId: string;
  agent: string;
  state: string;
  verdict: ReviewGateVerdict;
  degradedReason: string | null;
  independentReviewer: boolean;
  mergeAuthoritative: boolean;
  structuredArtifact?: CouncilRoutingEvidenceArtifact | null;
}

interface CouncilRoutingEvidenceArtifact {
  lane: {
    laneId: string;
    agent: string;
    modelFamily: string;
    independentReviewer: boolean;
    mergeAuthoritative?: boolean;
  };
  verdict: ReviewGateVerdict;
}

interface CouncilDecorrelatedReviewerArtifactEvidence {
  laneId: string;
  agent: string;
  modelFamily: string;
}

interface CouncilDecorrelationBasisEvidence {
  authorFamilies: string[];
  requiredNonAuthorFamilyReviewer: boolean;
  requiredReviewerLaneIds: string[];
  decorrelatedReviewerArtifacts: CouncilDecorrelatedReviewerArtifactEvidence[];
  mergeEligible: boolean;
}

export function councilRoutingEvidenceError(
  result: CouncilRoutingEvidenceResult,
): string | null {
  const routing = result.review_routing;
  const metadataRoutingMode = result.review_metadata.routing_mode;
  if (routing == null) {
    return "Council review artifact is missing Council v2 review_routing evidence.";
  }
  const routingRecord = recordOrNull(routing);
  const decorrelationBasisRecord = recordOrNull(
    routingRecord?.decorrelationBasis,
  );
  if (
    routingRecord === null ||
    decorrelationBasisRecord === null ||
    typeof routingRecord.mode !== "string" ||
    !Array.isArray(decorrelationBasisRecord.authorFamilies) ||
    !decorrelationBasisRecord.authorFamilies.every(isStringValue) ||
    typeof decorrelationBasisRecord.requiredNonAuthorFamilyReviewer !==
      "boolean" ||
    !Array.isArray(decorrelationBasisRecord.requiredReviewerLaneIds) ||
    !decorrelationBasisRecord.requiredReviewerLaneIds.every(isStringValue) ||
    !Array.isArray(decorrelationBasisRecord.decorrelatedReviewerArtifacts) ||
    !decorrelationBasisRecord.decorrelatedReviewerArtifacts.every(
      isDecorrelatedReviewerArtifactRecord,
    ) ||
    typeof decorrelationBasisRecord.mergeEligible !== "boolean"
  ) {
    return "Council review artifact has malformed Council v2 review_routing evidence.";
  }
  if (
    typeof metadataRoutingMode !== "string" ||
    metadataRoutingMode !== routingRecord.mode
  ) {
    return "Council review artifact routing metadata is missing or inconsistent with review_routing.mode.";
  }

  const decorrelationBasis: CouncilDecorrelationBasisEvidence = {
    authorFamilies: decorrelationBasisRecord.authorFamilies as string[],
    requiredNonAuthorFamilyReviewer:
      decorrelationBasisRecord.requiredNonAuthorFamilyReviewer as boolean,
    requiredReviewerLaneIds:
      decorrelationBasisRecord.requiredReviewerLaneIds as string[],
    decorrelatedReviewerArtifacts:
      decorrelationBasisRecord.decorrelatedReviewerArtifacts as CouncilDecorrelatedReviewerArtifactEvidence[],
    mergeEligible: decorrelationBasisRecord.mergeEligible as boolean,
  };

  if (!decorrelationBasis.requiredNonAuthorFamilyReviewer) {
    return "Council review artifact does not require its non-author-family reviewer guarantee.";
  }
  if (
    decorrelationBasis.requiredNonAuthorFamilyReviewer &&
    decorrelationBasis.authorFamilies.length === 0
  ) {
    return "Council review artifact lacks author model family provenance for its required non-author-family reviewer guarantee.";
  }
  if (
    decorrelationBasis.requiredNonAuthorFamilyReviewer &&
    decorrelationBasis.requiredReviewerLaneIds.length === 0
  ) {
    return "Council review artifact lacks required reviewer lane evidence for its non-author-family reviewer guarantee.";
  }
  const decorrelatedLaneIds = new Set(
    decorrelationBasis.decorrelatedReviewerArtifacts.map(
      (artifact) => artifact.laneId,
    ),
  );
  const missingRequiredDecorrelated =
    decorrelationBasis.requiredReviewerLaneIds.filter(
      (laneId) => !decorrelatedLaneIds.has(laneId),
    );
  if (missingRequiredDecorrelated.length > 0) {
    return `Council review artifact lacks non-author-family decorrelated artifacts for required reviewer lane(s): ${missingRequiredDecorrelated.join(", ")}.`;
  }
  for (const laneId of decorrelationBasis.requiredReviewerLaneIds) {
    const lane = result.lanes.find((candidate) => candidate.laneId === laneId);
    if (lane === undefined) {
      return `Council review artifact lacks lane evidence for required reviewer lane: ${laneId}.`;
    }
    if (
      lane.state !== "complete" ||
      lane.verdict !== "pass" ||
      lane.degradedReason !== null ||
      !lane.independentReviewer
    ) {
      return `Council review artifact required reviewer lane ${laneId} is not a clean completed independent PASS.`;
    }
    if (lane.mergeAuthoritative === false) {
      return `Council review artifact required reviewer lane ${laneId} is not merge-authoritative.`;
    }
    const artifact = lane.structuredArtifact;
    if (artifact === undefined || artifact === null) {
      return `Council review artifact required reviewer lane ${laneId} lacks a structured reviewer artifact.`;
    }
    if (
      artifact.lane.laneId !== laneId ||
      artifact.lane.agent !== lane.agent ||
      artifact.verdict !== "pass" ||
      !artifact.lane.independentReviewer
    ) {
      return `Council review artifact required reviewer lane ${laneId} has inconsistent structured artifact evidence.`;
    }
    if (!isMergeAuthoritativeArtifact(artifact)) {
      return `Council review artifact required reviewer lane ${laneId} has non-merge-authoritative structured artifact evidence.`;
    }
    if (decorrelationBasis.authorFamilies.includes(artifact.lane.modelFamily)) {
      return `Council review artifact required reviewer lane ${laneId} is same-family with the recorded author provenance.`;
    }
    const routingArtifact =
      decorrelationBasis.decorrelatedReviewerArtifacts.find(
        (candidate) => candidate.laneId === laneId,
      );
    if (
      routingArtifact === undefined ||
      routingArtifact.agent !== lane.agent ||
      routingArtifact.modelFamily !== artifact.lane.modelFamily
    ) {
      return `Council review artifact required reviewer lane ${laneId} has inconsistent routing artifact evidence.`;
    }
  }
  if (
    decorrelationBasis.requiredNonAuthorFamilyReviewer &&
    !decorrelationBasis.mergeEligible
  ) {
    return "Council review artifact is not merge-eligible under its recorded decorrelation basis.";
  }
  return null;
}

function isStringValue(value: unknown): value is string {
  return typeof value === "string";
}

function isDecorrelatedReviewerArtifactRecord(
  value: unknown,
): value is CouncilDecorrelatedReviewerArtifactEvidence {
  const record = recordOrNull(value);
  return (
    record !== null &&
    typeof record.laneId === "string" &&
    typeof record.agent === "string" &&
    typeof record.modelFamily === "string"
  );
}

function isMergeAuthoritativeArtifact(
  artifact: CouncilRoutingEvidenceArtifact,
): boolean {
  return isMergeAuthoritative(artifact.lane);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
