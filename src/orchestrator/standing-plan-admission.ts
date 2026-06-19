import type {
  PlanDecision,
  StandingPlan,
  StandingPlanJournal,
} from "../domain/standing-plan.js";
import {
  projectHonoredDecisions,
  projectStandingPlan,
} from "./standing-plan-store.js";

// ---------------------------------------------------------------------------
// No ambient control surfaces — admission guardrail (SYMPH-794).
//
// Encodes the invariant that pipeline entry must bind an EXPLICIT, journaled,
// revocable, operator-gated signal — never a bare, overloaded `project` field.
// These are PURE helpers on the dispatch hot path (zero model calls): they map
// the standing plan's honored `approve` decisions to the set of issue
// identifiers that an operator has explicitly admitted, and partition the
// comparator-eligible frontier into (admit, held).
//
// The approve decisions are already operator-gated at recording time (the
// dashboard path requires actor.kind === "operator"; the doc-comment path
// requires the author email ∈ operatorAllowlist) and revision-bound (callers
// pass `honoredApprovals` from listHonoredDecisions, which filters to the
// current revision — a superseded plan voids every prior approval). So an
// admitted identifier here carries {operator actor + explicit release intent +
// current revision + batch scope} by construction.
// ---------------------------------------------------------------------------

/**
 * The issue identifiers an operator has explicitly admitted: the members of
 * every current-revision batch that carries an honored `approve` decision.
 * Returns an empty set when no plan exists, so admission can never fall back to
 * bare project membership.
 */
export function approvedAdmittedIdentifiers(input: {
  plan: StandingPlan | null;
  honoredApprovals: readonly PlanDecision[];
}): Set<string> {
  const admitted = new Set<string>();
  if (input.plan === null) {
    return admitted;
  }
  const batchById = new Map(
    input.plan.batches.map((batch) => [batch.batchId, batch]),
  );
  // The admit signal must be REVOCABLE within a revision: a `hold` or `reject`
  // on a batch revokes any `approve` for it, so an operator who approves then
  // changes their mind un-admits the batch (council R1, Codex P1). This is the
  // safe direction (a revocation always wins) and mirrors the consumer's
  // hold-is-sticky behavior on the plan-driven path.
  const revoked = new Set<string>();
  for (const decision of input.honoredApprovals) {
    if (
      (decision.kind === "hold" || decision.kind === "reject") &&
      decision.batchId !== null
    ) {
      revoked.add(decision.batchId);
    }
  }
  for (const decision of input.honoredApprovals) {
    // Admission is batch-scoped: only an approve bound to a batch that exists in
    // the current plan admits, and only that batch's members.
    if (decision.kind !== "approve" || decision.batchId === null) {
      continue;
    }
    if (revoked.has(decision.batchId)) {
      continue; // a hold/reject for this batch revokes the approve
    }
    const batch = batchById.get(decision.batchId);
    if (batch === undefined) {
      continue; // stale/unknown batch id — admits nothing
    }
    for (const member of admittedMembersFor(batch)) {
      admitted.add(member.issueIdentifier);
    }
  }
  return admitted;
}

/**
 * Which members of an approved batch the guardrail admits. For a canary-chain
 * batch, admit ONLY the head — the contingent tail is released by the plan-driven
 * consumer after the head merges, never tail-before-head on the degrade/comparator
 * path the guardrail governs (council R2, Codex P1). A canary-chain batch with no
 * canary structure admits nothing (the planner downgrades these; defensive).
 */
function admittedMembersFor(batch: StandingPlan["batches"][number]) {
  if (batch.mode !== "canary-chain") {
    return batch.members;
  }
  if (batch.canary === null) {
    return [];
  }
  const head = new Set(batch.canary.headIssueIdentifiers);
  return batch.members.filter((member) => head.has(member.issueIdentifier));
}

/**
 * Split the candidate frontier into the issues that may dispatch (their
 * identifier is in `admitted`) and those held for lack of an explicit admit
 * signal. Order is preserved within each partition. An empty `admitted` set
 * holds everything — the fail-closed posture the guardrail depends on.
 */
export function partitionByAdmission<T extends { identifier: string }>(
  candidates: readonly T[],
  admitted: ReadonlySet<string>,
): { admit: T[]; held: T[] } {
  const admit: T[] = [];
  const held: T[] = [];
  for (const candidate of candidates) {
    if (admitted.has(candidate.identifier)) {
      admit.push(candidate);
    } else {
      held.push(candidate);
    }
  }
  return { admit, held };
}

/**
 * The admitted identifiers projected from a SINGLE journal snapshot (SYMPH-823):
 * the plan and the honored decisions are projected from the SAME in-memory
 * entries, so the gate can never pair plan revision N with decisions honored
 * against N+1. Empty when the journal has no plan — admission never falls back to
 * bare project membership.
 */
export function admittedIdentifiersFromJournal(
  journal: StandingPlanJournal,
): Set<string> {
  return approvedAdmittedIdentifiers({
    plan: projectStandingPlan(journal),
    honoredApprovals: projectHonoredDecisions(journal),
  });
}

/**
 * Resolve the per-tick admitted set for the dispatch gate, deciding first
 * WHETHER the gate enforces at all.
 *
 * The gate is mandatory whenever the candidate source is **team-scoped**
 * (SYMPH-794 / SYMPH-819): the eligible team backlog must never dispatch raw, so
 * a bare team-scoped candidate is held until an explicit operator go — the
 * `project` field is removed as the dispatch trigger, not bolted over. The gate
 * is ALSO active when an operator explicitly opts the guardrail on for a still
 * project-scoped pool. When neither holds, the gate is inert (returns `null`) so
 * legacy project-scoped workflows keep their zero-diff dispatch.
 *
 * When active, admission derives ONLY from the standing plan's honored `approve`
 * decisions (operator-gated + revision-bound at recording time); any store-read
 * failure fails CLOSED to the empty set (admit nothing this tick) rather than
 * fall open to bare backlog/project dispatch. Projects plan + decisions from ONE
 * injected journal read so the coupling + fail-closed posture (and the atomic
 * single-projection of SYMPH-823) is unit-testable without a host.
 */
export async function resolveAdmittedIdentifiersForTick(input: {
  teamScoped: boolean;
  admissionGuardrailEnabled: boolean;
  readJournal: () => Promise<StandingPlanJournal>;
  onError?: (error: unknown) => void | Promise<void>;
}): Promise<ReadonlySet<string> | null> {
  if (!input.teamScoped && !input.admissionGuardrailEnabled) {
    return null; // inert: legacy project-scoped dispatch (zero-diff)
  }
  try {
    // ONE journal read; the plan and the honored decisions are projected from the
    // SAME snapshot, so a re-plan landing mid-tick can never pair plan revision N
    // with decisions honored against N+1 (SYMPH-823).
    return admittedIdentifiersFromJournal(await input.readJournal());
  } catch (error) {
    // Fail closed: admit nothing this tick. The diagnostic must never change
    // that outcome — a throwing or rejecting `onError` observer is swallowed so
    // it can't reopen the gate (council Pi P1). Awaited so a host can flush the
    // log before the empty-set return (restores the pre-refactor ordering;
    // council Pi P2).
    try {
      await input.onError?.(error);
    } catch {
      // a logging failure cannot reopen the gate
    }
    return new Set<string>();
  }
}
