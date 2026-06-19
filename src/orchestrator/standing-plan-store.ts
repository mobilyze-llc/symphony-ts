import type {
  PlanDecision,
  PlanRevision,
  StandingPlan,
  StandingPlanJournal,
} from "../domain/standing-plan.js";
import {
  appendStandingPlanJournalEntriesWithLock,
  readStandingPlanJournal,
} from "../logging/standing-plan-journal.js";
import {
  type PlanBody,
  type RotateRevisionOptions,
  honoredDecisions,
  rotateRevision,
} from "./standing-plan-supersession.js";

// ---------------------------------------------------------------------------
// Standing-plan store (SYMPH-785)
//
// The store is the Manager's source of truth. The current StandingPlan is a
// *projection* over the append-only journal (read-model-first, mirroring the
// SYMPH-481 substrate). The living control doc (SYMPH-790) renders this
// projection; it never feeds back into the store.
// ---------------------------------------------------------------------------

export interface RecordPlanRevisionResult {
  /** False when the proposed body is byte-identical to the current plan. */
  recorded: boolean;
  plan: StandingPlan;
}

export interface RecordPlanDecisionResult {
  recorded: boolean;
  reason?: "no_plan" | "stale_revision";
}

/** Project the current plan from the journal (latest revision, decisions void on rotate). */
export function projectStandingPlan(
  journal: StandingPlanJournal,
): StandingPlan | null {
  let latest: { revision: PlanRevision; updatedAt: string } | null = null;
  for (const entry of journal) {
    if (entry.kind !== "plan_revision") {
      continue;
    }
    if (
      latest === null ||
      entry.revision.revision >= latest.revision.revision
    ) {
      latest = { revision: entry.revision, updatedAt: entry.timestamp };
    }
  }
  if (latest === null) {
    return null;
  }
  const { revision, updatedAt } = latest;
  return {
    planId: revision.planId,
    revision: revision.revision,
    contentHash: revision.contentHash,
    envelope: revision.envelope,
    batches: revision.batches,
    options: revision.options,
    rationale: revision.rationale,
    createdAt: revision.createdAt,
    updatedAt,
  };
}

export async function loadStandingPlan(
  workspaceRoot: string,
): Promise<StandingPlan | null> {
  return projectStandingPlan(await readStandingPlanJournal(workspaceRoot));
}

/**
 * Record a planner proposal as a new revision. Carries committed batches
 * forward immutably (via rotateRevision) and rotates the revision id. A body
 * identical to the current plan is a no-op (content-hash idempotency) so an
 * unchanged re-plan does not churn the revision history.
 */
export async function recordPlanRevision(
  workspaceRoot: string,
  body: PlanBody,
  options: RotateRevisionOptions,
): Promise<RecordPlanRevisionResult> {
  const journal = await readStandingPlanJournal(workspaceRoot);
  const current = projectStandingPlan(journal);
  const candidate = rotateRevision(current, body, options);

  if (current !== null && candidate.contentHash === current.contentHash) {
    return { recorded: false, plan: current };
  }

  const appendResult = await appendStandingPlanJournalEntriesWithLock(
    workspaceRoot,
    [
      {
        kind: "plan_revision",
        idempotencyKey: `${candidate.planId}:rev:${candidate.revision}`,
        timestamp: options.createdAt,
        planId: candidate.planId,
        revision: candidate,
      },
    ],
  );

  const plan = projectStandingPlan(appendResult.journal);
  if (plan === null) {
    // Unreachable: we just appended a revision. Guard for type-safety.
    throw new Error("standing-plan store: projection empty after append");
  }
  return { recorded: appendResult.appendedEntries.length > 0, plan };
}

/**
 * Record an operator decision. Rejects decisions bound to a non-current
 * revision (a superseded revision's approvals are void, SYMPH-788) and decisions
 * recorded before any plan exists.
 */
export async function recordPlanDecision(
  workspaceRoot: string,
  decision: PlanDecision,
): Promise<RecordPlanDecisionResult> {
  const journal = await readStandingPlanJournal(workspaceRoot);
  const current = projectStandingPlan(journal);
  if (current === null) {
    return { recorded: false, reason: "no_plan" };
  }
  if (decision.revision !== current.revision) {
    return { recorded: false, reason: "stale_revision" };
  }

  await appendStandingPlanJournalEntriesWithLock(workspaceRoot, [
    {
      kind: "plan_decision",
      idempotencyKey: `${decision.planId}:decision:${decision.decisionId}`,
      timestamp: decision.createdAt,
      planId: decision.planId,
      decision,
    },
  ]);
  return { recorded: true };
}

/** Decisions bound to the current revision (the only ones still in force). */
export async function listHonoredDecisions(
  workspaceRoot: string,
): Promise<PlanDecision[]> {
  const journal = await readStandingPlanJournal(workspaceRoot);
  const current = projectStandingPlan(journal);
  if (current === null) {
    return [];
  }
  const decisions = journal
    .filter((entry) => entry.kind === "plan_decision")
    .map((entry) => (entry as { decision: PlanDecision }).decision);
  return honoredDecisions(decisions, current.revision);
}
