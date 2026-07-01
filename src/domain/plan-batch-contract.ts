/**
 * Shared plan-batch contract primitives.
 *
 * Kept separate from standing-plan.ts so the canonical PlanBatchSchema can be
 * consumed by the standing-plan read edge without creating an ESM import cycle.
 */

export const PLAN_BATCH_MODES = [
  // N independent tickets -> N worktrees / N PRs (today's max_concurrent_agents).
  "parallel-isolated",
  // M same-surface tickets -> one branch / one PR (token + wall-clock win).
  "shared-surface",
  // Ordered + contingent: run the head; if it validates, release the tail.
  "canary-chain",
] as const;

export type PlanBatchMode = (typeof PLAN_BATCH_MODES)[number];

export const PLAN_BATCH_STATUSES = [
  "lookahead", // undispatched, speculative - a re-plan may rewrite/drop it
  "released", // operator-approved for dispatch (posture-B frontier, SYMPH-789)
  "in_flight", // dispatched / committed - immutable to a re-plan
  "completed", // terminal
  "superseded", // dropped by a re-plan (journaled)
] as const;

export type PlanBatchStatus = (typeof PLAN_BATCH_STATUSES)[number];

/** A batch member is a reference to a tracker issue. */
export interface PlanBatchMember {
  issueId: string;
  issueIdentifier: string;
}

/**
 * Canary-chain structure: the head member(s) gate the contingent tail. The
 * consumer (SYMPH-787) only releases the contingent members once the head
 * validates.
 */
export interface PlanCanaryStructure {
  headIssueIdentifiers: string[];
  contingentIssueIdentifiers: string[];
}

export interface PlanBatch {
  /** Stable id within a plan (carried across revisions for committed batches). */
  batchId: string;
  mode: PlanBatchMode;
  status: PlanBatchStatus;
  members: PlanBatchMember[];
  rationale: string;
  canary: PlanCanaryStructure | null;
}
