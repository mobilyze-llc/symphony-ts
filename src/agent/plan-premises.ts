import type { PlanBatch, PlanPremiseRecord } from "../domain/standing-plan.js";

export function normalizePlanPremises(
  rawPremises: readonly PlanPremiseRecord[] | undefined,
  rationale: string,
  batches: readonly PlanBatch[],
): PlanPremiseRecord[] {
  const cleaned =
    rawPremises
      ?.map((premise) => ({
        decisionAnchor: premise.decisionAnchor.trim(),
        kind: premise.kind,
        statement: premise.statement.trim(),
      }))
      .filter(
        (premise) =>
          premise.decisionAnchor.length > 0 && premise.statement.length > 0,
      ) ?? [];
  if (cleaned.length > 0) {
    return cleaned;
  }
  const fallback: PlanPremiseRecord[] = [];
  const planRationale = rationale.trim();
  if (planRationale.length > 0) {
    fallback.push({
      decisionAnchor: "plan",
      kind: "judgment",
      statement: planRationale,
    });
  }
  for (const batch of batches) {
    const statement = batch.rationale.trim();
    if (statement.length === 0) {
      continue;
    }
    fallback.push({
      decisionAnchor: batch.batchId,
      kind: "judgment",
      statement,
    });
  }
  return fallback;
}
