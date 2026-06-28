import type { WorkflowQueueTriageConfig } from "../config/types.js";
import type {
  PlanDecision,
  PlanEnvelope,
  StandingPlan,
  StandingPlanJournal,
} from "../domain/standing-plan.js";
import {
  projectHonoredDecisions,
  projectStandingPlan,
} from "./standing-plan-store.js";

// ---------------------------------------------------------------------------
// Deterministic consumer (SYMPH-787) + posture-B auto-release frontier
// (SYMPH-789).
//
// These are PURE functions on the dispatch hot path. They make ZERO model
// calls — the frontier model only runs on the (off-hot-path) re-plan. The
// consumer picks which planned batch members to dispatch now and which to hold,
// decides whether to degrade to the deterministic comparator, and evaluates the
// cheap re-plan trigger predicates.
// ---------------------------------------------------------------------------

const EMPTY_IDENTIFIER_SET: ReadonlySet<string> = new Set<string>();

export interface ConsumerInput {
  plan: StandingPlan;
  /** Decisions bound to the current revision (from listHonoredDecisions). */
  honoredApprovals: readonly PlanDecision[];
  /** Issue identifiers already dispatched/running. */
  runningIssueIdentifiers: ReadonlySet<string>;
  /**
   * How many lookahead batches may auto-dispatch unattended (posture-B). The
   * rest are held until an operator approval releases them. Tunable.
   */
  autoReleaseFrontier: number;
  envelope: PlanEnvelope;
  /**
   * Issue identifiers with a recorded `merged` outcome (SYMPH-800). Drives
   * canary-chain contingent-release (release the tail once every head member has
   * merged) and prevents re-dispatching an already-merged member.
   */
  mergedIssueIdentifiers?: ReadonlySet<string>;
}

export interface ConsumerSelection {
  /** Ordered issue identifiers to dispatch now (capped by the envelope). */
  dispatchIssueIdentifiers: string[];
  releasedBatchIds: string[];
  heldBatchIds: string[];
}

/**
 * Select which planned batch members to dispatch this tick. Auto-releases the
 * canary head(s) of up to `autoReleaseFrontier` lookahead batches within the
 * envelope, plus any batch an operator has explicitly approved (revision-bound,
 * filtered upstream by listHonoredDecisions). Everything else is held.
 */
export function selectDispatchableBatchMembers(
  input: ConsumerInput,
): ConsumerSelection {
  const allowedModes = new Set(input.envelope.allowedModes);
  const approvedBatchIds = new Set(
    input.honoredApprovals
      .filter((decision) => decision.kind === "approve" && decision.batchId)
      .map((decision) => decision.batchId as string),
  );
  // A `hold` OR a `reject` holds the batch (a reject revokes an approve and
  // blocks auto-release). Treating only `hold` as sticky let a rejected batch
  // dispatch on the plan path — the admission guardrail skips the plan path
  // precisely because release is supposed to be the admit authority, so the
  // consumer's revocation must be complete (council R2, Codex P1). Parity with
  // approvedAdmittedIdentifiers, which revokes on hold/reject.
  const heldByOperator = new Set(
    input.honoredApprovals
      .filter(
        (decision) =>
          (decision.kind === "hold" || decision.kind === "reject") &&
          decision.batchId,
      )
      .map((decision) => decision.batchId as string),
  );

  const dispatchIssueIdentifiers: string[] = [];
  const releasedBatchIds: string[] = [];
  const heldBatchIds: string[] = [];

  let autoReleaseRemaining = input.autoReleaseFrontier;
  for (const batch of input.plan.batches) {
    if (batch.status !== "lookahead") {
      continue; // committed/in-flight/superseded are not dispatch candidates
    }
    // An operator hold, or a mode outside the envelope, always holds the batch.
    if (heldByOperator.has(batch.batchId) || !allowedModes.has(batch.mode)) {
      heldBatchIds.push(batch.batchId);
      continue;
    }
    // A canary-chain batch with no canary structure can't honor contingent-
    // release — HOLD it rather than fall through and dispatch the whole batch
    // (which would bypass the head/tail gate). Defense-in-depth: buildPlanBody
    // downgrades these to parallel-isolated at the source (council R1, Codex P1).
    if (batch.mode === "canary-chain" && batch.canary === null) {
      heldBatchIds.push(batch.batchId);
      continue;
    }
    const approved = approvedBatchIds.has(batch.batchId);
    const autoReleasable = autoReleaseRemaining > 0;
    if (!approved && !autoReleasable) {
      heldBatchIds.push(batch.batchId);
      continue;
    }
    if (!approved) {
      autoReleaseRemaining -= 1; // a frontier slot is consumed only by auto-release
    }
    releasedBatchIds.push(batch.batchId);

    // canary-chain dispatches only the head until EVERY head member has merged
    // (SYMPH-800 contingent-release); then the contingent tail releases. The
    // head/tail validation reads recorded `merged` outcomes (SYMPH-803). NOTE:
    // a head that fails/parks holds the tail; guard #5 (SYMPH-815) re-plans.
    const merged = input.mergedIssueIdentifiers ?? EMPTY_IDENTIFIER_SET;
    let members = batch.members;
    if (batch.mode === "canary-chain" && batch.canary !== null) {
      const canary = batch.canary;
      const headValidated =
        canary.headIssueIdentifiers.length > 0 &&
        canary.headIssueIdentifiers.every((identifier) =>
          merged.has(identifier),
        );
      members = batch.members.filter((member) =>
        (headValidated
          ? canary.contingentIssueIdentifiers
          : canary.headIssueIdentifiers
        ).includes(member.issueIdentifier),
      );
    }
    for (const member of members) {
      // Never re-dispatch a running OR already-merged member.
      if (
        !input.runningIssueIdentifiers.has(member.issueIdentifier) &&
        !merged.has(member.issueIdentifier)
      ) {
        dispatchIssueIdentifiers.push(member.issueIdentifier);
      }
    }
  }

  // Respect the envelope concurrency ceiling (the dispatch loop also caps by
  // the global max-concurrent slots; the effective cap is the tighter of the two).
  const capacity = Math.max(
    0,
    input.envelope.concurrencyCeiling - input.runningIssueIdentifiers.size,
  );
  return {
    dispatchIssueIdentifiers: dispatchIssueIdentifiers.slice(0, capacity),
    releasedBatchIds,
    heldBatchIds,
  };
}

/**
 * Graceful degradation (SYMPH-787): with no plan, or a plan stale enough that
 * the Manager is presumed unavailable, dispatch falls back to the deterministic
 * comparator. Safety never depends on the frontier model.
 */
export function shouldDegradeToComparator(input: {
  plan: StandingPlan | null;
  nowMs: number;
  heartbeatMs: number;
  /** Multiple of the heartbeat after which a plan is considered stale. */
  stalenessFactor?: number;
}): boolean {
  if (input.plan === null) {
    return true;
  }
  const updatedMs = Date.parse(input.plan.updatedAt);
  if (Number.isNaN(updatedMs)) {
    return true;
  }
  const factor = input.stalenessFactor ?? 2;
  return input.nowMs - updatedMs >= input.heartbeatMs * factor;
}

export interface ReplanPredicateResult {
  forceReplan: boolean;
  reasons: string[];
}

/** Merges since the plan at/above which the base is presumed to have shifted. */
export const DEFAULT_MERGE_WORLD_SHIFT_THRESHOLD = 3;

/**
 * Cheap deterministic guards that decide WHETHER to request a re-plan — they
 * never call the model (zero-LLM-on-dispatch). The re-plan itself runs on the
 * off-hot-path heartbeat. Guards (SYMPH-787 + SYMPH-801 + SYMPH-815):
 *  #1 envelope changed · #2 no planned member still a candidate ·
 *  #3 new-work-outranks-by-priority-band · #4 merge-moved-the-world ·
 *  #5 canary-head-stuck.
 * The richer inputs (priority bands, merges-since, running/merged sets) are
 * OPTIONAL so callers that cannot supply them keep the original guards.
 */
export function evaluateReplanPredicates(input: {
  plan: StandingPlan;
  currentEnvelope: PlanEnvelope;
  candidateIdentifiers: ReadonlySet<string>;
  /** identifier → priority band (lower = more urgent); SYMPH-801 guard #3. */
  candidatePriorityBands?: ReadonlyMap<string, number>;
  /** merged outcomes recorded since the plan was computed; SYMPH-801 guard #4. */
  mergedSincePlanCount?: number;
  /** Issue identifiers already dispatched/running; SYMPH-815 guard #5. */
  runningIssueIdentifiers?: ReadonlySet<string>;
  /** Issue identifiers with a recorded merged outcome; SYMPH-815 guard #5. */
  mergedIssueIdentifiers?: ReadonlySet<string>;
  mergeWorldShiftThreshold?: number;
}): ReplanPredicateResult {
  const reasons: string[] = [];

  // Guard #1: the envelope changed (Governor clamp / widen) since the plan.
  if (input.plan.envelope.version !== input.currentEnvelope.version) {
    reasons.push(
      `envelope version changed (${input.plan.envelope.version} → ${input.currentEnvelope.version})`,
    );
  }

  // Guard #2: the planned lookahead no longer maps to any eligible candidate —
  // the world moved out from under the plan, so re-plan rather than stall.
  const lookahead = input.plan.batches.filter(
    (batch) => batch.status === "lookahead",
  );
  if (lookahead.length > 0) {
    const anyMemberStillCandidate = lookahead.some((batch) =>
      batch.members.some((member) =>
        input.candidateIdentifiers.has(member.issueIdentifier),
      ),
    );
    if (!anyMemberStillCandidate) {
      reasons.push("no lookahead batch member is still an eligible candidate");
    }
  }

  // Guard #3 (SYMPH-801): new work outranks the plan by a priority band. If an
  // eligible candidate the plan did NOT include is strictly more urgent than the
  // best planned lookahead member, re-plan so the Manager can reconsider.
  if (input.candidatePriorityBands !== undefined && lookahead.length > 0) {
    const plannedIdentifiers = new Set(
      lookahead.flatMap((batch) =>
        batch.members.map((member) => member.issueIdentifier),
      ),
    );
    const bestBand = (identifiers: Iterable<string>): number | null => {
      let best: number | null = null;
      for (const identifier of identifiers) {
        const band = input.candidatePriorityBands?.get(identifier);
        if (band !== undefined && (best === null || band < best)) {
          best = band;
        }
      }
      return best;
    };
    const bestPlanned = bestBand(plannedIdentifiers);
    const bestUnplanned = bestBand(
      [...input.candidateIdentifiers].filter(
        (identifier) => !plannedIdentifiers.has(identifier),
      ),
    );
    if (
      bestUnplanned !== null &&
      bestPlanned !== null &&
      bestUnplanned < bestPlanned
    ) {
      reasons.push(
        `new work outranks the plan by a priority band (${bestUnplanned} < ${bestPlanned})`,
      );
    }
  }

  // Guard #4 (SYMPH-801): merge moved the world. Enough merges since the plan
  // means the base/dependency landscape shifted — re-rank against the new base.
  const threshold =
    input.mergeWorldShiftThreshold ?? DEFAULT_MERGE_WORLD_SHIFT_THRESHOLD;
  if (
    input.mergedSincePlanCount !== undefined &&
    input.mergedSincePlanCount >= threshold
  ) {
    reasons.push(
      `${input.mergedSincePlanCount} merges landed since the plan (≥ ${threshold}); the base moved`,
    );
  }

  // Guard #5 (SYMPH-815): a canary head is stuck and cannot progress. A
  // lookahead canary-chain batch dispatches only its head until EVERY head
  // member merges (SYMPH-800 contingent-release); if NO head member is a
  // candidate, running, OR merged, the head can neither advance nor validate —
  // the contingent tail is held with nothing left to release it, and guard #2
  // stays quiet because the still-candidate tail (or another batch) keeps a
  // lookahead member eligible. Re-plan so the Manager can drop/re-rank the stuck
  // canary instead of stalling the tail indefinitely.
  if (
    input.runningIssueIdentifiers !== undefined &&
    input.mergedIssueIdentifiers !== undefined
  ) {
    const running = input.runningIssueIdentifiers;
    const merged = input.mergedIssueIdentifiers;
    for (const batch of lookahead) {
      if (batch.mode !== "canary-chain" || batch.canary === null) {
        continue;
      }
      const head = batch.canary.headIssueIdentifiers;
      const headCanProgress = head.some(
        (identifier) =>
          input.candidateIdentifiers.has(identifier) ||
          running.has(identifier) ||
          merged.has(identifier),
      );
      if (head.length > 0 && !headCanProgress) {
        reasons.push(
          `canary-chain batch ${batch.batchId} head is stuck (no head member is a candidate, running, or merged)`,
        );
      }
    }
  }

  return { forceReplan: reasons.length > 0, reasons };
}

export interface PlanDispatchDecisionInput {
  config: WorkflowQueueTriageConfig;
  plan: StandingPlan | null;
  honoredApprovals: readonly PlanDecision[];
  candidateIdentifiers: ReadonlySet<string>;
  runningIssueIdentifiers: ReadonlySet<string>;
  nowMs: number;
  /** identifier → priority band (lower = more urgent); SYMPH-801 guard #3. */
  candidatePriorityBands?: ReadonlyMap<string, number>;
  /** merged outcomes since the plan was computed; SYMPH-801 guard #4. */
  mergedSincePlanCount?: number;
  /** issue identifiers with a recorded merged outcome; SYMPH-800 canary tail. */
  mergedIssueIdentifiers?: ReadonlySet<string>;
  /**
   * Team-scoped candidate source (SYMPH-794). The plan-driven path is the only
   * dispatch path that skips the admission guardrail, so when the source is the
   * team backlog, "released" must mean "operator-approved": posture-B
   * auto-release is forced OFF (effective frontier 0) so a bare team-scoped
   * candidate never dispatches without an explicit go. Defaults to false
   * (project-scoped posture-B unchanged).
   */
  teamScoped?: boolean;
}

export interface PlanDispatchDecision {
  /** "plan" → the plan drives this tick; "degrade" → use the comparator. */
  action: "degrade" | "plan";
  /** Request an off-hot-path re-plan on the next heartbeat. */
  forceReplan: boolean;
  /** Releasable issue identifiers when action === "plan". */
  orderedIssueIdentifiers: string[];
}

/**
 * The full dispatch-hot-path decision (SYMPH-787/789), as a single PURE
 * function so the composition is testable end to end. Degrades unless the
 * feature is enabled, NOT in shadow mode, and a fresh, aligned plan exists; a
 * tripped predicate degrades this tick and asks for a re-plan. ZERO model calls.
 */
export function decidePlanDrivenDispatch(
  input: PlanDispatchDecisionInput,
): PlanDispatchDecision {
  const cfg = input.config;
  const degrade = (forceReplan: boolean): PlanDispatchDecision => ({
    action: "degrade",
    forceReplan,
    orderedIssueIdentifiers: [],
  });

  if (!cfg.enabled || cfg.shadowMode) {
    return degrade(false);
  }
  if (
    input.plan === null ||
    shouldDegradeToComparator({
      plan: input.plan,
      nowMs: input.nowMs,
      heartbeatMs: cfg.heartbeatMs,
    })
  ) {
    return degrade(false);
  }
  const predicates = evaluateReplanPredicates({
    plan: input.plan,
    currentEnvelope: cfg.envelope,
    candidateIdentifiers: input.candidateIdentifiers,
    runningIssueIdentifiers: input.runningIssueIdentifiers,
    ...(input.candidatePriorityBands === undefined
      ? {}
      : { candidatePriorityBands: input.candidatePriorityBands }),
    ...(input.mergedSincePlanCount === undefined
      ? {}
      : { mergedSincePlanCount: input.mergedSincePlanCount }),
    ...(input.mergedIssueIdentifiers === undefined
      ? {}
      : { mergedIssueIdentifiers: input.mergedIssueIdentifiers }),
  });
  if (predicates.forceReplan) {
    // A misaligned plan: dispatch via the comparator this tick, re-plan next.
    return degrade(true);
  }
  const selection = selectDispatchableBatchMembers({
    plan: input.plan,
    honoredApprovals: input.honoredApprovals,
    runningIssueIdentifiers: input.runningIssueIdentifiers,
    // Team-scoped ⇒ no auto-release: only an explicit operator approval releases
    // a batch (SYMPH-794). Project-scoped posture-B keeps its configured frontier.
    autoReleaseFrontier: input.teamScoped ? 0 : cfg.autoReleaseFrontier,
    envelope: cfg.envelope,
    ...(input.mergedIssueIdentifiers === undefined
      ? {}
      : { mergedIssueIdentifiers: input.mergedIssueIdentifiers }),
  });
  return {
    action: "plan",
    forceReplan: false,
    orderedIssueIdentifiers: selection.dispatchIssueIdentifiers,
  };
}

// ---------------------------------------------------------------------------
// Single-snapshot tick resolver (SYMPH-830)
//
// The dispatch-hot-path entry point for the plan-driven release path. It reads
// the standing-plan journal ONCE (via the injected readJournal) and projects the
// plan, the honored decisions, AND the merged outcomes from that SAME snapshot,
// then runs the pure decidePlanDrivenDispatch over them. Mirrors the admission
// gate's resolveAdmittedIdentifiersForTick (SYMPH-823): three independent journal
// reads (loadStandingPlan + listHonoredDecisions + collectMergedOutcomes)
// previously let a re-plan landing mid-tick pair plan revision N with decisions
// honored against N+1. The read is injected so the single-read coupling is
// unit-testable without a host. ZERO model calls.
// ---------------------------------------------------------------------------

/**
 * Merged-outcome facts for the consumer decision, projected from an already-read
 * journal snapshot (one pass): how many issues merged strictly after `sinceIso`
 * (the merge-moved-the-world re-plan predicate, SYMPH-801) and the set of ALL
 * merged issue identifiers regardless of time (canary contingent-release +
 * merged-exclusion, SYMPH-800).
 */
export function collectMergedOutcomesFromJournal(
  journal: StandingPlanJournal,
  sinceIso: string,
): { sinceCount: number; identifiers: Set<string> } {
  const sinceMs = Date.parse(sinceIso);
  let sinceCount = 0;
  const identifiers = new Set<string>();
  for (const entry of journal) {
    if (entry.kind !== "plan_outcome" || entry.outcome.result !== "merged") {
      continue;
    }
    for (const identifier of entry.outcome.issueIdentifiers) {
      identifiers.add(identifier);
    }
    const outcomeMs = Date.parse(entry.outcome.createdAt);
    if (
      !Number.isNaN(sinceMs) &&
      !Number.isNaN(outcomeMs) &&
      outcomeMs > sinceMs
    ) {
      sinceCount += 1;
    }
  }
  return { sinceCount, identifiers };
}

export interface PlanDrivenDispatchTickInput {
  config: WorkflowQueueTriageConfig;
  /**
   * The single journal read for this tick. Injected (rather than reading the
   * store directly) so the single-read coupling is unit-testable without a host,
   * and so a host can supply `() => readStandingPlanJournal(root)`.
   */
  readJournal: () => Promise<StandingPlanJournal>;
  /** The eligible candidate frontier (identifier + Linear priority). */
  candidates: readonly { identifier: string; priority: number | null }[];
  runningIssueIdentifiers: ReadonlySet<string>;
  nowMs: number;
  /**
   * Team-scoped candidate source (SYMPH-794): forces posture-B auto-release OFF
   * so only operator-approved batches release on the plan path.
   */
  teamScoped: boolean;
}

/**
 * Resolve the full plan-driven dispatch decision for one tick from a SINGLE
 * journal snapshot (SYMPH-830). The plan, the honored decisions, and the merged
 * outcomes are all derived from the same read, so a re-plan landing mid-tick can
 * never pair plan revision N with decisions honored against N+1. Delegates the
 * actual decision to the pure decidePlanDrivenDispatch. ZERO model calls.
 */
export async function resolvePlanDrivenDispatchForTick(
  input: PlanDrivenDispatchTickInput,
): Promise<PlanDispatchDecision> {
  // ONE read; plan + decisions + merged outcomes all derive from this snapshot.
  const journal = await input.readJournal();
  const plan = projectStandingPlan(journal);
  const honoredApprovals =
    plan === null ? [] : projectHonoredDecisions(journal);
  // Assembled only when a plan exists — with no plan the decision degrades
  // immediately and never reads these (parity with the pre-SYMPH-830 host).
  const candidatePriorityBands =
    plan === null
      ? new Map<string, number>()
      : new Map<string, number>(
          input.candidates.map((candidate) => [
            candidate.identifier,
            // Linear: 1=urgent…4=low; 0/none → least urgent (band 5).
            candidate.priority === null || candidate.priority === 0
              ? 5
              : candidate.priority,
          ]),
        );
  const mergedOutcomes =
    plan === null
      ? { sinceCount: 0, identifiers: new Set<string>() }
      : collectMergedOutcomesFromJournal(journal, plan.createdAt);
  return decidePlanDrivenDispatch({
    config: input.config,
    plan,
    honoredApprovals,
    candidateIdentifiers: new Set(
      input.candidates.map((candidate) => candidate.identifier),
    ),
    runningIssueIdentifiers: input.runningIssueIdentifiers,
    nowMs: input.nowMs,
    teamScoped: input.teamScoped,
    candidatePriorityBands,
    mergedSincePlanCount: mergedOutcomes.sinceCount,
    mergedIssueIdentifiers: mergedOutcomes.identifiers,
  });
}
