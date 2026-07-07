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

/**
 * Per-lane tier-2 review telemetry (SYMPH-1068). One entry per decorrelated review
 * lane, carrying the lane's own verdict + finding count (from the aggregator's
 * per-lane triage parse) joined with the lane's token usage (from the lane runner's
 * usage record). This is what makes the SYMPH-1034 report-only exit criterion —
 * decorrelation attribution (which lane caught what) and cost-per-catch —
 * computable from the records without hand-reconciliation. Report-only: nothing
 * here is read by any gate or dispatch decision.
 */
export interface PlanReviewLaneTelemetry {
  /** Lane identity (e.g. "codex-plan-review"); the join key across usage + verdict. */
  reviewer: string;
  /** The lane's own verdict (PASS / CHANGES_REQUESTED / BLOCKED), or null when the
   *  aggregator reported no per-lane verdict for this reviewer. */
  verdict: string | null;
  /** The lane's own finding count, or null when unreported. */
  findingCount: number | null;
  /** Lane input tokens, or null when the runtime reported no usage. */
  inputTokens: number | null;
  /** Lane output tokens, or null when the runtime reported no usage. */
  outputTokens: number | null;
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
  /**
   * Per-lane review telemetry (SYMPH-1068). Set on every freshly produced record
   * (`[]` when no lanes ran — skip/degraded). Optional for back-compat: revisions
   * persisted before SYMPH-1068 have no `perLane`, so read it as `perLane ?? []`.
   */
  perLane?: PlanReviewLaneTelemetry[];
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
