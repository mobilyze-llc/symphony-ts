import type { BacklogAuditCullFinding } from "../audit/backlog-audit.js";
import {
  normalizeCullRootIssueIdentifier,
  stableCullMarker,
} from "../audit/backlog-audit.js";
import type { BacklogHygieneProposal } from "./backlog-hygiene.js";

export type ConservativeCullOperatorDecision = "none" | "agreed" | "disagreed";

export interface ConservativeCullApplicationPlan {
  proposalId: string;
  classification: BacklogAuditCullFinding["classification"] | null;
  requiresOperatorAgree: boolean;
  cancelIssue: boolean;
  markerLabels: string[];
  blockedBy: Array<{ issueIdentifier: string; rootIssueIdentifier: string }>;
}

export type BacklogHygieneMutationAuthority =
  | "advisory_only"
  | "operator_agree_required"
  | "calibration_label_only";

export function resolveBacklogHygieneMutationAuthority(
  cull: BacklogAuditCullFinding | null,
): BacklogHygieneMutationAuthority {
  if (cull?.advisoryOnly === true) {
    return "advisory_only";
  }
  return cull?.classification === "kill"
    ? "operator_agree_required"
    : "calibration_label_only";
}

export function buildConservativeCullApplicationPlan(input: {
  proposal: BacklogHygieneProposal;
  decision: ConservativeCullOperatorDecision;
}): ConservativeCullApplicationPlan {
  const cull = input.proposal.cull;
  // Hygiene metadata is planner context, not a cull application candidate.
  if (cull === null || cull.advisoryOnly === true) {
    return {
      proposalId: input.proposal.proposalId,
      classification: null,
      requiresOperatorAgree: false,
      cancelIssue: false,
      markerLabels: [],
      blockedBy: [],
    };
  }
  const agreed = input.decision === "agreed";
  // Derive the marker from authoritative fields, never model-supplied text.
  const canonicalMarker = stableCullMarker({
    classification: cull.classification,
    killReason: cull.killReason,
  });
  const rootIssueIdentifier = normalizeCullRootIssueIdentifier(
    cull.rootIssueIdentifier,
  );
  const killWithValidMarker =
    cull.classification === "kill" && canonicalMarker !== null;
  return {
    proposalId: input.proposal.proposalId,
    classification: cull.classification,
    requiresOperatorAgree: killWithValidMarker,
    cancelIssue: killWithValidMarker && agreed,
    markerLabels: agreed && canonicalMarker !== null ? [canonicalMarker] : [],
    blockedBy:
      cull.classification === "symptomatic_of_root" &&
      agreed &&
      rootIssueIdentifier !== null
        ? input.proposal.issueIdentifiers
            .filter(
              (issueIdentifier) => issueIdentifier !== rootIssueIdentifier,
            )
            .map((issueIdentifier) => ({
              issueIdentifier,
              rootIssueIdentifier,
            }))
        : [],
  };
}
