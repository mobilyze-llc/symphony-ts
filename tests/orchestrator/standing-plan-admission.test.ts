import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PlanBatch,
  PlanDecision,
  PlanEnvelope,
  PlanRevision,
  StandingPlan,
  StandingPlanJournal,
  StandingPlanJournalEntry,
} from "../../src/domain/standing-plan.js";
import { readStandingPlanJournal } from "../../src/logging/standing-plan-journal.js";
import {
  admittedIdentifiersFromJournal,
  approvedAdmittedIdentifiers,
  partitionByAdmission,
  resolveAdmittedIdentifiersForTick,
} from "../../src/orchestrator/standing-plan-admission.js";
import {
  recordPlanControlDecision,
  recordPlanRevision,
} from "../../src/orchestrator/standing-plan-store.js";
import type { PlanBody } from "../../src/orchestrator/standing-plan-supersession.js";

function plan(): StandingPlan {
  return {
    planId: "plan-1",
    revision: 3,
    contentHash: "h",
    envelope: {
      version: 1,
      concurrencyCeiling: 3,
      allowedRisk: "medium",
      allowedModes: ["parallel-isolated"],
    },
    batches: [
      {
        batchId: "b-app",
        mode: "parallel-isolated",
        status: "lookahead",
        members: [
          { issueId: "1", issueIdentifier: "SYMPH-1" },
          { issueId: "2", issueIdentifier: "SYMPH-2" },
        ],
        rationale: "r",
        canary: null,
      },
      {
        batchId: "b-other",
        mode: "parallel-isolated",
        status: "lookahead",
        members: [{ issueId: "3", issueIdentifier: "SYMPH-3" }],
        rationale: "r",
        canary: null,
      },
    ],
    options: [],
    rationale: "r",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:05:00.000Z",
  };
}

function approve(batchId: string | null): PlanDecision {
  return {
    decisionId: `d-${batchId ?? "none"}`,
    planId: "plan-1",
    revision: 3,
    batchId,
    kind: "approve",
    actor: "operator@pro14",
    optionMarker: null,
    createdAt: "2026-06-19T00:06:00.000Z",
    note: null,
  };
}

/**
 * Build a journal that projects to `p` plus `decisions` — the in-memory snapshot
 * the atomic gate reads ONCE (SYMPH-823). A single plan_revision entry carries the
 * plan; the decisions follow as plan_decision entries.
 */
function journalOf(
  p: StandingPlan,
  decisions: readonly PlanDecision[],
): StandingPlanJournal {
  const revision: PlanRevision = {
    revision: p.revision,
    planId: p.planId,
    contentHash: p.contentHash,
    supersedes: null,
    createdAt: p.createdAt,
    envelope: p.envelope,
    batches: p.batches,
    options: p.options,
    rationale: p.rationale,
    source: "planner",
  };
  const entries: StandingPlanJournalEntry[] = [
    {
      sequence: 1,
      idempotencyKey: `${p.planId}:rev:${p.revision}`,
      timestamp: p.updatedAt,
      kind: "plan_revision",
      planId: p.planId,
      revision,
    },
  ];
  decisions.forEach((decision, index) => {
    entries.push({
      sequence: index + 2,
      idempotencyKey: `${decision.planId}:decision:${decision.decisionId}`,
      timestamp: decision.createdAt,
      kind: "plan_decision",
      planId: decision.planId,
      decision,
    });
  });
  return entries;
}

describe("approvedAdmittedIdentifiers (SYMPH-794)", () => {
  it("returns the members of every batch with an honored approve decision", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app")],
    });
    expect([...admitted].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("admits members of multiple approved batches and no others", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app"), approve("b-other")],
    });
    expect([...admitted].sort()).toEqual(["SYMPH-1", "SYMPH-2", "SYMPH-3"]);
  });

  it("admits NOTHING when there are no approve decisions (bare project ≠ admit)", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [],
    });
    expect(admitted.size).toBe(0);
  });

  it("admits nothing when there is no plan", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: null,
      honoredApprovals: [approve("b-app")],
    });
    expect(admitted.size).toBe(0);
  });

  it("ignores a hold/modify/reject decision (only approve admits)", () => {
    const hold: PlanDecision = { ...approve("b-app"), kind: "hold" };
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [hold],
    });
    expect(admitted.size).toBe(0);
  });

  it("ignores an approve for a batch that is not in the plan (stale batch id)", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-ghost")],
    });
    expect(admitted.size).toBe(0);
  });

  it("ignores a batch-less (plan-level) approve — admission is batch-scoped", () => {
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve(null)],
    });
    expect(admitted.size).toBe(0);
  });

  it("revokes admission when a later hold targets an approved batch (council R1, Codex P1)", () => {
    const hold: PlanDecision = { ...approve("b-app"), kind: "hold" };
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app"), hold],
    });
    expect(admitted.size).toBe(0); // approve + hold for the same batch ⇒ held
  });

  it("revokes admission when a reject targets an approved batch (council R1, Codex P1)", () => {
    const reject: PlanDecision = { ...approve("b-app"), kind: "reject" };
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app"), reject],
    });
    expect(admitted.size).toBe(0);
  });

  it("a hold on one batch does not revoke a different approved batch", () => {
    const holdOther: PlanDecision = { ...approve("b-other"), kind: "hold" };
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app"), holdOther],
    });
    expect([...admitted].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("admits only the canary HEAD of an approved canary-chain batch, not the tail (council R2, Codex P1)", () => {
    const canaryPlan: StandingPlan = {
      ...plan(),
      batches: [
        {
          batchId: "b-canary",
          mode: "canary-chain",
          status: "lookahead",
          members: [
            { issueId: "1", issueIdentifier: "SYMPH-1" },
            { issueId: "2", issueIdentifier: "SYMPH-2" },
          ],
          rationale: "r",
          canary: {
            headIssueIdentifiers: ["SYMPH-1"],
            contingentIssueIdentifiers: ["SYMPH-2"],
          },
        },
      ],
    };
    const admitted = approvedAdmittedIdentifiers({
      plan: canaryPlan,
      honoredApprovals: [approve("b-canary")],
    });
    // head admitted via the guardrail; the contingent tail is released by the
    // plan-driven consumer after the head merges — never tail-before-head here.
    expect([...admitted]).toEqual(["SYMPH-1"]);
  });

  it("a modify on an approved batch does NOT revoke it (only hold/reject revoke)", () => {
    // modify is a re-plan signal, not a go/no-go — it must not un-admit an
    // operator-approved batch (council R3, Pi P3 regression guard).
    const modify: PlanDecision = { ...approve("b-app"), kind: "modify" };
    const admitted = approvedAdmittedIdentifiers({
      plan: plan(),
      honoredApprovals: [approve("b-app"), modify],
    });
    expect([...admitted].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });
});

describe("partitionByAdmission (SYMPH-794)", () => {
  const candidates = [
    { id: "1", identifier: "SYMPH-1" },
    { id: "2", identifier: "SYMPH-2" },
    { id: "3", identifier: "SYMPH-3" },
  ];

  it("admits only candidates in the admitted set; holds the rest in order", () => {
    const { admit, held } = partitionByAdmission(
      candidates,
      new Set(["SYMPH-2"]),
    );
    expect(admit.map((c) => c.identifier)).toEqual(["SYMPH-2"]);
    expect(held.map((c) => c.identifier)).toEqual(["SYMPH-1", "SYMPH-3"]);
  });

  it("holds everything when the admitted set is empty (fail-closed posture)", () => {
    const { admit, held } = partitionByAdmission(candidates, new Set());
    expect(admit).toHaveLength(0);
    expect(held).toHaveLength(3);
  });

  it("admits everything when all candidates are admitted", () => {
    const { admit, held } = partitionByAdmission(
      candidates,
      new Set(["SYMPH-1", "SYMPH-2", "SYMPH-3"]),
    );
    expect(admit).toHaveLength(3);
    expect(held).toHaveLength(0);
  });
});

// Shared real-store helpers (the atomic cross-revision suite and the integration
// suite both build journals through the real store).
const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};
const lookaheadBatch = (id: string, identifier: string): PlanBatch => ({
  batchId: id,
  mode: "parallel-isolated",
  status: "lookahead",
  members: [{ issueId: id, issueIdentifier: identifier }],
  rationale: "r",
  canary: null,
});
const bodyOf = (batches: PlanBatch[]): PlanBody => ({
  batches,
  options: [{ marker: "[opt-1]", label: "Release", intent: null }],
  envelope: ENVELOPE,
  rationale: "rationale",
  source: "planner",
});

describe("admittedIdentifiersFromJournal (SYMPH-823 single projection)", () => {
  it("admits the approved batch members projected from one journal snapshot", () => {
    const admitted = admittedIdentifiersFromJournal(
      journalOf(plan(), [approve("b-app")]),
    );
    expect([...admitted].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("admits nothing for an empty journal (no plan ⇒ the bare backlog never dispatches)", () => {
    expect(admittedIdentifiersFromJournal([]).size).toBe(0);
  });

  it("projects plan AND decisions from the SAME revision — a rotation can't cross-pair (SYMPH-823)", async () => {
    // A journal that has rotated rev 1 → rev 2: b1 was approved under rev 1, b2
    // under rev 2. The pre-fix two-read path could pair rev 1's plan with rev 2's
    // honored decisions (or vice-versa). Projecting both from the same entries
    // admits ONLY the current revision's approved batch (b2 → SYMPH-2); the voided
    // rev-1 approval never pairs with the rev-2 plan.
    const root = mkdtempSync(join(tmpdir(), "symph-admission-atomic-"));
    try {
      await recordPlanRevision(
        root,
        bodyOf([lookaheadBatch("b1", "SYMPH-1")]),
        {
          planId: "plan-1",
          createdAt: "2026-06-19T00:00:00.000Z",
        },
      );
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: null,
        decisionId: "approve:b1:rev1",
        createdAt: "2026-06-19T00:00:30.000Z",
      });
      // A re-plan rotates to revision 2; the operator approves a revision-2 batch.
      await recordPlanRevision(
        root,
        bodyOf([lookaheadBatch("b2", "SYMPH-2")]),
        {
          createdAt: "2026-06-19T00:01:00.000Z",
        },
      );
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 2,
        batchId: "b2",
        actor: "operator@pro14",
        note: null,
        decisionId: "approve:b2:rev2",
        createdAt: "2026-06-19T00:01:30.000Z",
      });

      const admitted = admittedIdentifiersFromJournal(
        await readStandingPlanJournal(root),
      );
      expect([...admitted]).toEqual(["SYMPH-2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveAdmittedIdentifiersForTick (SYMPH-794 coupling, SYMPH-823 atomic)", () => {
  it("is inert (returns null) when neither team-scoped nor guardrail-enabled — legacy zero-diff; no journal read", async () => {
    let reads = 0;
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: false,
      admissionGuardrailEnabled: false,
      readJournal: async () => {
        reads += 1;
        return journalOf(plan(), [approve("b-app")]);
      },
    });
    expect(result).toBeNull();
    // The journal is never read on the inert path (no unneeded I/O).
    expect(reads).toBe(0);
  });

  it("forces the gate when team-scoped even with the guardrail flag OFF (the coupling)", async () => {
    // A team-scoped candidate source must NEVER dispatch the raw backlog: the
    // gate is mandatory regardless of the admission_guardrail flag. Only the
    // operator-approved batch members are admitted; the rest are held downstream.
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: true,
      admissionGuardrailEnabled: false,
      readJournal: async () => journalOf(plan(), [approve("b-app")]),
    });
    expect(result).not.toBeNull();
    expect([...(result ?? [])].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("activates the gate when the guardrail is explicitly enabled (project-scoped opt-in)", async () => {
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: false,
      admissionGuardrailEnabled: true,
      readJournal: async () => journalOf(plan(), [approve("b-other")]),
    });
    expect([...(result ?? [])]).toEqual(["SYMPH-3"]);
  });

  it("admits NOTHING when team-scoped with no plan — the bare backlog never dispatches (one read)", async () => {
    let reads = 0;
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: true,
      admissionGuardrailEnabled: false,
      readJournal: async () => {
        reads += 1;
        return []; // empty journal ⇒ no plan
      },
    });
    expect(result).not.toBeNull();
    expect([...(result ?? [])]).toEqual([]);
    expect(reads).toBe(1);
  });

  it("reads the journal ONCE and projects plan+decisions from that snapshot — a re-plan can't cross-pair (SYMPH-823)", async () => {
    // A readJournal that would return DIFFERENT snapshots on successive calls
    // models a re-plan landing mid-tick. The pre-fix gate read the journal twice
    // (loadPlan then listHonoredDecisions), opening a window to pair revision N's
    // plan with revision N+1's decisions. The atomic gate reads ONCE, so the
    // result reflects exactly one self-consistent revision.
    let calls = 0;
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: true,
      admissionGuardrailEnabled: false,
      readJournal: async () => {
        calls += 1;
        return calls === 1
          ? journalOf(plan(), [approve("b-app")])
          : journalOf({ ...plan(), revision: 99 }, []);
      },
    });
    expect(calls).toBe(1);
    expect([...(result ?? [])].sort()).toEqual(["SYMPH-1", "SYMPH-2"]);
  });

  it("fails closed (empty set) and reports when the journal read throws", async () => {
    let reported: unknown = null;
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: true,
      admissionGuardrailEnabled: false,
      readJournal: async () => {
        throw new Error("journal read failed");
      },
      onError: (error) => {
        reported = error;
      },
    });
    expect(result).not.toBeNull();
    expect([...(result ?? [])]).toEqual([]);
    expect((reported as Error).message).toBe("journal read failed");
  });

  it("stays fail-closed even when the onError observer itself throws (council Pi P1)", async () => {
    // The fail-closed guarantee must not depend on the diagnostic succeeding: a
    // throwing logger callback cannot turn "admit nothing" into a thrown error.
    const result = await resolveAdmittedIdentifiersForTick({
      teamScoped: true,
      admissionGuardrailEnabled: false,
      readJournal: async () => {
        throw new Error("journal read failed");
      },
      onError: () => {
        throw new Error("logger down");
      },
    });
    expect(result).not.toBeNull();
    expect([...(result ?? [])]).toEqual([]);
  });
});

// Integration: the helper over the REAL standing-plan store (not mocks), closing
// the team-scoped-config → gate → admitted-set seam the unit tests stubbed
// (council finding E). Proves a bare team backlog is held until an operator
// approval is journaled, then only that batch's members are admitted.
describe("resolveAdmittedIdentifiersForTick — real store integration (SYMPH-794, council E)", () => {
  it("holds the bare team backlog until an operator approval is journaled, then admits only that batch", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-admission-int-"));
    try {
      await recordPlanRevision(
        root,
        bodyOf([
          lookaheadBatch("b1", "SYMPH-1"),
          lookaheadBatch("b2", "SYMPH-2"),
        ]),
        { planId: "plan-1", createdAt: "2026-06-19T00:00:00.000Z" },
      );
      const loaders = {
        teamScoped: true,
        admissionGuardrailEnabled: false,
        readJournal: () => readStandingPlanJournal(root),
      };

      // No approval yet: a plan exists but the bare backlog is held (fail-closed).
      const before = await resolveAdmittedIdentifiersForTick(loaders);
      expect([...(before ?? [])]).toEqual([]);

      // Operator approves b1 via the control surface (revision-bound, journaled).
      await recordPlanControlDecision(root, {
        kind: "approve",
        revision: 1,
        batchId: "b1",
        actor: "operator@pro14",
        note: null,
        decisionId: "release_batch:b1:rev1:operator@pro14",
        createdAt: "2026-06-19T00:00:30.000Z",
      });

      const after = await resolveAdmittedIdentifiersForTick(loaders);
      expect([...(after ?? [])]).toEqual(["SYMPH-1"]); // only the approved batch
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
