export interface PlanReviewGateInput {
  currentContentHash: string;
  lastReviewedContentHash: string | null;
}

export type PlanReviewGateDecision =
  | {
      action: "run";
      reason: "no_baseline" | "content_hash_changed";
      currentContentHash: string;
      lastReviewedContentHash: string | null;
    }
  | {
      action: "skip";
      reason: "content_hash_unchanged";
      currentContentHash: string;
      lastReviewedContentHash: string;
    };

/**
 * Tier-2 diff gate over the structural standing-plan content hash.
 *
 * The `manager-plan` CLI currently uses a per-invocation artifact store, so it
 * normally has no durable reviewed baseline and this returns `run` with
 * `no_baseline`. The gate becomes load-bearing once a durable shadow-tick
 * journal supplies `lastReviewedContentHash`.
 */
export function decidePlanReviewGate(
  input: PlanReviewGateInput,
): PlanReviewGateDecision {
  if (input.lastReviewedContentHash === null) {
    return {
      action: "run",
      reason: "no_baseline",
      currentContentHash: input.currentContentHash,
      lastReviewedContentHash: null,
    };
  }
  if (input.currentContentHash !== input.lastReviewedContentHash) {
    return {
      action: "run",
      reason: "content_hash_changed",
      currentContentHash: input.currentContentHash,
      lastReviewedContentHash: input.lastReviewedContentHash,
    };
  }
  return {
    action: "skip",
    reason: "content_hash_unchanged",
    currentContentHash: input.currentContentHash,
    lastReviewedContentHash: input.lastReviewedContentHash,
  };
}
