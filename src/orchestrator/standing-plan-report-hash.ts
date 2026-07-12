import { createHash } from "node:crypto";

import type { PlanAttribution } from "../domain/plan-attribution.js";
import type {
  PlanPremiseRecord,
  PlanRevision,
} from "../domain/standing-plan.js";
import type { PlanReviewFinding } from "../domain/standing-plan.js";

export function planReportHash(
  input: PlanAttribution & {
    premises?: readonly PlanPremiseRecord[];
    structuralAdvisories?: PlanRevision["structuralAdvisories"];
    findings?: readonly PlanReviewFinding[];
    reviewRecords?: NonNullable<PlanRevision["reviewRecords"]>;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        premises: input.premises ?? [],
        structuralAdvisories: input.structuralAdvisories ?? [],
        findings: input.findings ?? [],
        reviewRecords: input.reviewRecords ?? [],
        plannerModel: input.plannerModel ?? null,
        plannerEffort: input.plannerEffort ?? null,
      }),
    )
    .digest("hex");
}
