import { describe, expect, it } from "vitest";

import type {
  PlanDecision,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import {
  approvedAdmittedIdentifiers,
  partitionByAdmission,
} from "../../src/orchestrator/standing-plan-admission.js";

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
