import type { WorkflowQueueTriageConfig } from "../config/types.js";
import type {
  PlanDecision,
  PlanEnvelope,
  StandingPlan,
} from "../domain/standing-plan.js";

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

    // canary-chain dispatches only the head; the contingent tail stays held
    // until the head validates (a future signal) or an operator releases it.
    const members =
      batch.mode === "canary-chain" && batch.canary !== null
        ? batch.members.filter((member) =>
            batch.canary?.headIssueIdentifiers.includes(member.issueIdentifier),
          )
        : batch.members;
    for (const member of members) {
      if (!input.runningIssueIdentifiers.has(member.issueIdentifier)) {
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

/**
 * Cheap deterministic guards that decide WHETHER to request a re-plan — they
 * never call the model (zero-LLM-on-dispatch). The re-plan itself runs on the
 * off-hot-path heartbeat. v2 implements the highest-value guards; the broader
 * set (new-work-outranks-by-priority-band, merge-moved-the-world) is tracked as
 * a follow-up.
 */
export function evaluateReplanPredicates(input: {
  plan: StandingPlan;
  currentEnvelope: PlanEnvelope;
  candidateIdentifiers: ReadonlySet<string>;
}): ReplanPredicateResult {
  const reasons: string[] = [];

  // Guard #4: the envelope changed (Governor clamp / widen) since the plan.
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

  return { forceReplan: reasons.length > 0, reasons };
}

export interface PlanDispatchDecisionInput {
  config: WorkflowQueueTriageConfig;
  plan: StandingPlan | null;
  honoredApprovals: readonly PlanDecision[];
  candidateIdentifiers: ReadonlySet<string>;
  runningIssueIdentifiers: ReadonlySet<string>;
  nowMs: number;
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
  });
  if (predicates.forceReplan) {
    // A misaligned plan: dispatch via the comparator this tick, re-plan next.
    return degrade(true);
  }
  const selection = selectDispatchableBatchMembers({
    plan: input.plan,
    honoredApprovals: input.honoredApprovals,
    runningIssueIdentifiers: input.runningIssueIdentifiers,
    autoReleaseFrontier: cfg.autoReleaseFrontier,
    envelope: cfg.envelope,
  });
  return {
    action: "plan",
    forceReplan: false,
    orderedIssueIdentifiers: selection.dispatchIssueIdentifiers,
  };
}
