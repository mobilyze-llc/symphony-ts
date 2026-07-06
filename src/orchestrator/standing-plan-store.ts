import { createHash } from "node:crypto";

import type {
  PlanDecision,
  PlanDecisionKind,
  PlanPremiseRecord,
  PlanRevision,
  PlanRevisionJournalEntry,
  StandingPlan,
  StandingPlanJournal,
} from "../domain/standing-plan.js";
import type { PlanReviewFinding } from "../domain/standing-plan.js";
import {
  appendStandingPlanJournalEntriesWithLock,
  appendStandingPlanJournalEntry,
  appendStandingPlanJournalEntryToDisk,
  readStandingPlanJournal,
  withStandingPlanJournalWriteLock,
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
  reason?: "no_plan" | "stale_revision" | "batch_not_found";
}

/** Project the current plan from the journal (latest revision, decisions void on rotate). */
export function projectStandingPlan(
  journal: StandingPlanJournal,
): StandingPlan | null {
  // Pick the most recently WRITTEN revision (highest journal sequence), not the
  // numerically-largest revision id. The journal is the truth and "current"
  // means last-written — defense-in-depth against out-of-order or manually
  // edited rows (council R1, Pi P2).
  const latest = latestPlanRevisionEntry(journal);
  if (latest === null) {
    return null;
  }
  const { revision } = latest;
  return {
    planId: revision.planId,
    revision: revision.revision,
    contentHash: revision.contentHash,
    envelope: revision.envelope,
    batches: revision.batches,
    dependencyEdges: revision.dependencyEdges ?? [],
    options: revision.options,
    rationale: revision.rationale,
    premises: revision.premises ?? [],
    findings: revision.findings ?? [],
    reviewRecords: revision.reviewRecords ?? [],
    createdAt: revision.createdAt,
    updatedAt: latest.timestamp,
  };
}

export async function loadStandingPlan(
  workspaceRoot: string,
): Promise<StandingPlan | null> {
  return projectStandingPlan(await readStandingPlanJournal(workspaceRoot));
}

export function projectLastReviewedContentHash(
  journal: StandingPlanJournal,
): string | null {
  let baseline: { sequence: number; contentHash: string } | null = null;
  for (const entry of journal) {
    if (entry.kind !== "plan_revision") {
      continue;
    }
    if (
      !entry.revision.reviewRecords?.some(
        (record) =>
          record.tier === "tier-2" &&
          record.status === "reviewed" &&
          record.diffHash === entry.revision.contentHash,
      )
    ) {
      continue;
    }
    // Only reviewed tier-2 records for this exact persisted content hash are
    // trusted baselines. Skipped/degraded records and stale reviewed records can
    // be useful telemetry but must not advance the diff-gate hash.
    if (baseline === null || entry.sequence >= baseline.sequence) {
      baseline = {
        sequence: entry.sequence,
        contentHash: entry.revision.contentHash,
      };
    }
  }
  return baseline?.contentHash ?? null;
}

export async function loadLastReviewedContentHash(
  workspaceRoot: string,
): Promise<string | null> {
  return projectLastReviewedContentHash(
    await readStandingPlanJournal(workspaceRoot),
  );
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
  // Read → rotate → append ALL inside the single-writer lock. Allocating the
  // revision before the lock lets two concurrent re-plans compute the same
  // revision id; the second's distinct body would be silently dropped on the
  // idempotency key (council R1, Codex+Pi P1). Inside the lock, the second
  // re-plan re-reads the freshly-committed first and rotates onto it.
  return withStandingPlanJournalWriteLock(workspaceRoot, async () => {
    const journal = await readStandingPlanJournal(workspaceRoot);
    const current = projectStandingPlan(journal);
    const candidate = rotateRevision(current, body, options);

    if (current !== null && candidate.contentHash === current.contentHash) {
      const reportUpdate = refreshedReportRevision(journal, body, options);
      if (reportUpdate !== null) {
        const appended = appendStandingPlanJournalEntry(journal, {
          kind: "plan_revision",
          idempotencyKey: reportRefreshIdempotencyKey(
            reportUpdate,
            latestPlanRevisionEntry(journal),
          ),
          timestamp: options.createdAt,
          planId: reportUpdate.planId,
          revision: reportUpdate,
        });
        if (appended.appended) {
          await appendStandingPlanJournalEntryToDisk(
            workspaceRoot,
            appended.entry,
          );
        }
        const plan = projectStandingPlan(appended.journal);
        if (plan === null) {
          throw new Error(
            "standing-plan store: projection empty after report update",
          );
        }
        return { recorded: appended.appended, plan };
      }
      return { recorded: false, plan: current };
    }

    const appended = appendStandingPlanJournalEntry(journal, {
      kind: "plan_revision",
      idempotencyKey: `${candidate.planId}:rev:${candidate.revision}`,
      timestamp: options.createdAt,
      planId: candidate.planId,
      revision: candidate,
    });
    if (appended.appended) {
      await appendStandingPlanJournalEntryToDisk(workspaceRoot, appended.entry);
    }

    const plan = projectStandingPlan(appended.journal);
    if (plan === null) {
      // Unreachable: we just appended a revision. Guard for type-safety.
      throw new Error("standing-plan store: projection empty after append");
    }
    return { recorded: appended.appended, plan };
  });
}

function latestPlanRevisionEntry(
  journal: StandingPlanJournal,
): PlanRevisionJournalEntry | null {
  let latest: PlanRevisionJournalEntry | null = null;
  for (const entry of journal) {
    if (entry.kind !== "plan_revision") {
      continue;
    }
    if (latest === null || entry.sequence >= latest.sequence) {
      latest = entry;
    }
  }
  return latest;
}

function refreshedReportRevision(
  journal: StandingPlanJournal,
  body: PlanBody,
  options: RotateRevisionOptions,
): PlanRevision | null {
  const latest = latestPlanRevisionEntry(journal);
  if (latest === null) {
    return null;
  }
  const premises = body.premises ?? [];
  const reviewRecords = options.reviewRecords ?? [];
  const findings = mergeReportRefreshFindings({
    prior: latest.revision.findings ?? [],
    next: options.findings ?? [],
    persistedContentHash: latest.revision.contentHash,
    reviewRecords,
  });
  if (
    planReportHash(latest.revision) ===
    planReportHash({ ...latest.revision, premises, findings, reviewRecords })
  ) {
    return null;
  }
  return {
    ...latest.revision,
    premises,
    findings,
    reviewRecords,
  };
}

function mergeReportRefreshFindings(input: {
  prior: readonly PlanReviewFinding[];
  next: readonly PlanReviewFinding[];
  persistedContentHash: string;
  reviewRecords: NonNullable<PlanRevision["reviewRecords"]>;
}): PlanReviewFinding[] {
  if (
    !input.reviewRecords.some(
      (record) =>
        record.tier === "tier-2" &&
        record.status === "skipped" &&
        record.gateReason === "content_hash_unchanged" &&
        record.diffHash === input.persistedContentHash,
    )
  ) {
    return [...input.next];
  }
  const seen = new Set(input.next.map(planFindingKey));
  const carriedTier2 = input.prior.filter(
    (finding) =>
      finding.source === "tier-2" && !seen.has(planFindingKey(finding)),
  );
  return [...input.next, ...carriedTier2];
}

function planFindingKey(finding: PlanReviewFinding): string {
  return JSON.stringify({
    source: finding.source ?? null,
    fingerprint: finding.structuredFingerprint ?? null,
    title: finding.title,
    planAnchor: finding.planAnchor,
    severity: finding.severity,
  });
}

function planReportHash(input: {
  premises?: readonly PlanPremiseRecord[];
  findings?: readonly PlanReviewFinding[];
  reviewRecords?: NonNullable<PlanRevision["reviewRecords"]>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        premises: input.premises ?? [],
        findings: input.findings ?? [],
        reviewRecords: input.reviewRecords ?? [],
      }),
    )
    .digest("hex");
}

function reportRefreshIdempotencyKey(
  revision: PlanRevision,
  latest: PlanRevisionJournalEntry | null,
): string {
  return `${revision.planId}:rev:${revision.revision}:report:${latest?.sequence ?? 0}:${planReportHash(revision)}`;
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
  // Validate the revision binding and append inside the SAME lock, so a re-plan
  // cannot supersede the revision between the check and the write (council R1,
  // Codex P2 + Pi P1). `recorded` reflects the actual append (idempotent).
  return withStandingPlanJournalWriteLock(workspaceRoot, async () => {
    const journal = await readStandingPlanJournal(workspaceRoot);
    const current = projectStandingPlan(journal);
    if (current === null) {
      return { recorded: false, reason: "no_plan" };
    }
    if (decision.revision !== current.revision) {
      return { recorded: false, reason: "stale_revision" };
    }

    const appended = appendStandingPlanJournalEntry(journal, {
      kind: "plan_decision",
      idempotencyKey: `${decision.planId}:decision:${decision.decisionId}`,
      timestamp: decision.createdAt,
      planId: decision.planId,
      decision,
    });
    if (appended.appended) {
      await appendStandingPlanJournalEntryToDisk(workspaceRoot, appended.entry);
    }
    return { recorded: appended.appended };
  });
}

/**
 * Record an operator plan-control decision (release_batch / hold / modify_plan
 * → approve / hold / modify) from an intent. Resolves the planId from the
 * current plan, then delegates to recordPlanDecision (which validates the
 * revision binding under the single-writer lock). Returns no_plan when nothing
 * has been planned yet.
 */
export async function recordPlanControlDecision(
  workspaceRoot: string,
  input: {
    kind: PlanDecisionKind;
    revision: number;
    batchId: string | null;
    actor: string;
    note: string | null;
    decisionId: string;
    createdAt: string;
  },
): Promise<RecordPlanDecisionResult> {
  const current = await loadStandingPlan(workspaceRoot);
  if (current === null) {
    return { recorded: false, reason: "no_plan" };
  }
  // A batch-scoped decision against the CURRENT revision must target a batch
  // that exists in it; otherwise it would record false-positive control state
  // the consumer can never honor (council R1, Codex P3). Revision binding takes
  // precedence: a stale revision falls through to recordPlanDecision, which
  // returns stale_revision regardless of the (old) batch id.
  if (
    input.batchId !== null &&
    input.revision === current.revision &&
    !current.batches.some((batch) => batch.batchId === input.batchId)
  ) {
    return { recorded: false, reason: "batch_not_found" };
  }
  return recordPlanDecision(workspaceRoot, {
    decisionId: input.decisionId,
    planId: current.planId,
    revision: input.revision,
    batchId: input.batchId,
    kind: input.kind,
    actor: input.actor,
    optionMarker: null,
    createdAt: input.createdAt,
    note: input.note,
  });
}

/**
 * Record a batch outcome (merged / parked / failed) — the calibration substrate
 * (SYMPH-792). Outcomes are facts, not revision-bound: they append regardless of
 * the current revision so the digest can join decision → eventual outcome.
 */
export async function recordBatchOutcome(
  workspaceRoot: string,
  outcome: {
    planId: string;
    revision: number;
    batchId: string;
    result: string;
    issueIdentifiers: string[];
    outcomeId: string;
    createdAt: string;
  },
): Promise<{ recorded: boolean }> {
  const appended = await appendStandingPlanJournalEntriesWithLock(
    workspaceRoot,
    [
      {
        kind: "plan_outcome",
        idempotencyKey: `${outcome.planId}:outcome:${outcome.outcomeId}`,
        timestamp: outcome.createdAt,
        planId: outcome.planId,
        outcome: {
          outcomeId: outcome.outcomeId,
          planId: outcome.planId,
          revision: outcome.revision,
          batchId: outcome.batchId,
          result: outcome.result,
          issueIdentifiers: outcome.issueIdentifiers,
          createdAt: outcome.createdAt,
        },
      },
    ],
  );
  return { recorded: appended.appendedEntries.length > 0 };
}

/**
 * Decisions bound to the journal's current revision, projected PURELY from
 * already-read entries (no disk read). The in-memory sibling of
 * projectStandingPlan: the admission gate projects the plan AND the honored
 * decisions from ONE journal snapshot via these two helpers, so a re-plan landing
 * mid-tick can never pair plan revision N with decisions honored against N+1
 * (SYMPH-823).
 */
export function projectHonoredDecisions(
  journal: StandingPlanJournal,
): PlanDecision[] {
  const current = projectStandingPlan(journal);
  if (current === null) {
    return [];
  }
  const decisions = journal
    .filter((entry) => entry.kind === "plan_decision")
    .map((entry) => (entry as { decision: PlanDecision }).decision);
  return honoredDecisions(decisions, current.revision);
}

/** Decisions bound to the current revision (the only ones still in force). */
export async function listHonoredDecisions(
  workspaceRoot: string,
): Promise<PlanDecision[]> {
  return projectHonoredDecisions(await readStandingPlanJournal(workspaceRoot));
}
