import type { PlannerCandidate } from "../agent/triage-planner.js";
import type { PlanBody } from "../orchestrator/standing-plan-supersession.js";
import type { PlanBatchMode } from "./plan-batch-contract.js";
import type { PlanReviewFinding } from "./plan-review-finding.js";
import type { PlanEnvelope } from "./standing-plan.js";

const INELIGIBLE_TRACKER_STATES = new Set([
  "cancelled",
  "canceled",
  "duplicate",
  "ineligible",
]);

export function runDeterministicPlanReviewChecks(input: {
  body: PlanBody;
  candidates: readonly Pick<PlannerCandidate, "issueIdentifier" | "state">[];
}): PlanReviewFinding[] {
  return [
    ...findScheduledIneligibleCandidates(input.body, input.candidates),
    ...findEnvelopeOverruns(input.body, input.body.envelope),
  ];
}

export function findScheduledIneligibleCandidates(
  body: PlanBody,
  candidates: readonly Pick<PlannerCandidate, "issueIdentifier" | "state">[],
): PlanReviewFinding[] {
  const candidateByIdentifier = new Map(
    candidates.map((candidate) => [candidate.issueIdentifier, candidate]),
  );
  const findings: PlanReviewFinding[] = [];
  for (const batch of body.batches) {
    for (const member of batch.members) {
      const candidate = candidateByIdentifier.get(member.issueIdentifier);
      if (candidate === undefined) {
        continue;
      }
      const state = candidate.state.trim().toLowerCase();
      if (!INELIGIBLE_TRACKER_STATES.has(state)) {
        continue;
      }
      findings.push({
        title: `Scheduled ineligible candidate ${member.issueIdentifier} (${candidate.state})`,
        planAnchor: `${batch.batchId}:${member.issueIdentifier}`,
        severity: "P2",
      });
    }
  }
  return findings;
}

export function findEnvelopeOverruns(
  body: PlanBody,
  envelope: PlanEnvelope,
): PlanReviewFinding[] {
  const findings: PlanReviewFinding[] = [];
  const allowedModes = new Set<PlanBatchMode>(envelope.allowedModes);
  for (const batch of body.batches) {
    if (!allowedModes.has(batch.mode)) {
      findings.push({
        title: `Batch ${batch.batchId} uses mode ${batch.mode} outside the envelope`,
        planAnchor: batch.batchId,
        severity: "P2",
      });
    }
    if (batch.members.length > envelope.concurrencyCeiling) {
      findings.push({
        title: `Batch ${batch.batchId} schedules ${batch.members.length} members over concurrency ceiling ${envelope.concurrencyCeiling}`,
        planAnchor: batch.batchId,
        severity: "P2",
      });
    }
  }
  return findings;
}
