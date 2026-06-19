import type { StandingPlan } from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// Batch-outcome attribution (SYMPH-803).
//
// Pure mapping from a planned issue's terminal pipeline result (merged / parked
// / failed) to the batch-outcome record the calibration digest (SYMPH-792) joins
// against decisions. The runtime-host calls this when a worker exits terminally
// and persists the result via recordBatchOutcome — so the recommendation →
// decision → outcome loop closes. Returns null when there is no plan, or when
// the issue belongs to no batch (a bare/comparator issue the Manager never
// planned) — nothing to attribute.
// ---------------------------------------------------------------------------

export type TerminalOutcomeResult = "merged" | "parked" | "failed";

export interface BatchOutcomeRecord {
  planId: string;
  revision: number;
  batchId: string;
  result: TerminalOutcomeResult;
  issueIdentifiers: string[];
  outcomeId: string;
  createdAt: string;
}

export function resolveBatchOutcome(input: {
  plan: StandingPlan | null;
  issueIdentifier: string;
  result: TerminalOutcomeResult;
  createdAt: string;
}): BatchOutcomeRecord | null {
  if (input.plan === null) {
    return null;
  }
  const batch = input.plan.batches.find((candidate) =>
    candidate.members.some(
      (member) => member.issueIdentifier === input.issueIdentifier,
    ),
  );
  if (batch === undefined) {
    return null;
  }
  return {
    planId: input.plan.planId,
    revision: input.plan.revision,
    batchId: batch.batchId,
    result: input.result,
    issueIdentifiers: [input.issueIdentifier],
    // Result-scoped so a re-run that changes the verdict (failed → later merged)
    // records a distinct outcome; the digest keeps the latest by sequence.
    outcomeId: `${batch.batchId}:${input.issueIdentifier}:${input.result}`,
    createdAt: input.createdAt,
  };
}
