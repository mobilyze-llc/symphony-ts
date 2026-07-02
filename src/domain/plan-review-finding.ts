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
  source?: "tier-1" | "tier-2";
  tags?: string[];
  structuredFingerprint?: string;
}

export interface PlanReviewCoverageEvidence {
  issueId: string;
  issueIdentifier: string;
  status: "grounded" | "ungrounded";
  renderedHash: string;
  renderedChars: number;
  claimIds: string[];
  unitIds: string[];
  warnings: string[];
}

export interface PlanReviewPostHocEntry {
  kind: "coverage_gap";
  issueIdentifier: string;
  note: string;
  createdAt: string;
}

export interface PlanReviewRecord {
  tier: "tier-2";
  status: "reviewed" | "skipped" | "degraded";
  diffHash: string;
  gateReason: "no_baseline" | "content_hash_changed" | "content_hash_unchanged";
  aggregateVerdict: "pass" | "fail" | "degraded" | null;
  note: string | null;
  reviewedGroundingEvidence: PlanReviewCoverageEvidence[];
  findingFingerprints: string[];
  postHocEntries: PlanReviewPostHocEntry[];
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
