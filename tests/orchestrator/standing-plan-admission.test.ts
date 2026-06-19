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
