import { randomUUID } from "node:crypto";

import {
  type PlanBatch,
  type PlanDecision,
  type PlanDependencyEdge,
  type PlanEnvelope,
  type PlanOptionLine,
  type PlanRevision,
  type PlanRevisionSource,
  type StandingPlan,
  computePlanContentHash,
  isCommittedBatchStatus,
} from "../domain/standing-plan.js";

// ---------------------------------------------------------------------------
// Plan supersession (SYMPH-788)
//
// "We speculatively *plan*, never speculatively *execute*." On a re-plan, the
// undispatched lookahead tail is freely rewritten/reordered/dropped (journaled
// as superseded); committed/in-flight batches are carried forward UNCHANGED.
// Approvals bind to a revision — a superseded revision's approvals are void.
// ---------------------------------------------------------------------------

/** The planner's proposal: a fresh lookahead + the envelope it planned within. */
export interface PlanBody {
  batches: PlanBatch[];
  options: PlanOptionLine[];
  envelope: PlanEnvelope;
  rationale: string;
  source: PlanRevisionSource;
  /**
   * Resolved execution-dependency edges (SYMPH-843): soft (model) + recorded
   * blockedBy + canary, restricted to planned members and acyclic. The render
   * topo-sorts these into ordered waves.
   */
  dependencyEdges: PlanDependencyEdge[];
}

export interface RotateRevisionOptions {
  /** Required ISO timestamp (callers pass it; the module performs no clock I/O). */
  createdAt: string;
  /** Stable plan identity for the first revision; ignored once a prior exists. */
  planId?: string;
}

/**
 * Build the next plan revision from a prior plan (or null for the first).
 *
 * Committed (in-flight / released / completed) batches are taken verbatim from
 * the prior plan — the proposal cannot mutate them, which structurally enforces
 * the "immutable in-flight" invariant. Only the lookahead tail comes from the
 * proposal, and any proposal batch whose id collides with a committed batch is
 * dropped (committed wins).
 */
export function rotateRevision(
  prior: StandingPlan | null,
  body: PlanBody,
  options: RotateRevisionOptions,
): PlanRevision {
  const committed = (prior?.batches ?? []).filter((batch) =>
    isCommittedBatchStatus(batch.status),
  );
  const committedIds = new Set(committed.map((batch) => batch.batchId));
  const lookahead = body.batches.filter(
    (batch) =>
      !isCommittedBatchStatus(batch.status) && !committedIds.has(batch.batchId),
  );
  const batches = [...committed, ...lookahead];

  // Keep only options that target a surviving lookahead batch (or carry no
  // batch-scoped intent). Dropping a proposed batch that collided with a
  // committed one must NOT leave behind a "release" option pointing at the
  // already-in-flight batch (council R1, Codex P1).
  const lookaheadIds = new Set(lookahead.map((batch) => batch.batchId));
  const optionsForLookahead = body.options.filter(
    (option) =>
      option.intent === null ||
      option.intent.batchId === null ||
      lookaheadIds.has(option.intent.batchId),
  );

  const planId = prior?.planId ?? options.planId ?? randomUUID();
  const revision = (prior?.revision ?? 0) + 1;
  const supersedes = prior === null ? null : prior.revision;
  const contentHash = computePlanContentHash({
    planId,
    batches,
    options: optionsForLookahead,
    envelope: body.envelope,
    rationale: body.rationale,
    source: body.source,
  });

  return {
    revision,
    planId,
    contentHash,
    supersedes,
    createdAt: options.createdAt,
    envelope: body.envelope,
    batches,
    options: optionsForLookahead,
    rationale: body.rationale,
    source: body.source,
  };
}

/**
 * Approval-revision binding: only decisions made against the current revision
 * are honored. A re-plan rotates the revision, voiding outstanding approvals
 * bound to the prior one (SYMPH-788 / SYMPH-794 "no ambient control surfaces").
 */
export function honoredDecisions(
  decisions: readonly PlanDecision[],
  currentRevision: number,
): PlanDecision[] {
  return decisions.filter((decision) => decision.revision === currentRevision);
}
