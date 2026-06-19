export const CODEX_LEAD_LANE_ID = "codex-high-lead";

export interface MergeAuthoritativeReviewEntity {
  mergeAuthoritative?: boolean;
}

export function isMergeAuthoritative(
  entity: MergeAuthoritativeReviewEntity,
): boolean {
  return entity.mergeAuthoritative !== false;
}
