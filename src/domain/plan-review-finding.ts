export const PLAN_REVIEW_FINDING_SEVERITIES = [
  "P1",
  "P2",
  "Track",
  "Dismissed",
] as const;

export type PlanReviewFindingSeverity =
  (typeof PLAN_REVIEW_FINDING_SEVERITIES)[number];

/**
 * Neutral standing-plan review finding shared by tier-1 deterministic/self-review
 * and the later tier-2 review fence.
 */
export interface PlanReviewFinding {
  title: string;
  planAnchor: string;
  severity: PlanReviewFindingSeverity;
}

export function isPlanReviewFinding(
  value: unknown,
): value is PlanReviewFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<PlanReviewFinding>;
  return (
    typeof record.title === "string" &&
    record.title.trim().length > 0 &&
    typeof record.planAnchor === "string" &&
    record.planAnchor.trim().length > 0 &&
    PLAN_REVIEW_FINDING_SEVERITIES.includes(
      record.severity as PlanReviewFindingSeverity,
    )
  );
}
