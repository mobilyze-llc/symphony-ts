import { describe, expect, it } from "vitest";

import { computeStandingPlanCalibration } from "../../src/calibration/standing-plan-digest.js";
import type {
  PlanDecision,
  PlanOutcome,
  PlanRevision,
  StandingPlanJournal,
} from "../../src/domain/standing-plan.js";

let seq = 0;
function revisionEntry(revision: PlanRevision) {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: `r${revision.revision}`,
    timestamp: revision.createdAt,
    kind: "plan_revision" as const,
    planId: revision.planId,
    revision,
  };
}
function decisionEntry(decision: PlanDecision) {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: `d${decision.decisionId}`,
    timestamp: decision.createdAt,
    kind: "plan_decision" as const,
    planId: decision.planId,
    decision,
  };
}
function outcomeEntry(outcome: PlanOutcome) {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: `o${outcome.outcomeId}`,
    timestamp: outcome.createdAt,
    kind: "plan_outcome" as const,
    planId: outcome.planId,
    outcome,
  };
}

function revision(
  batchId: string,
  mode: PlanRevision["batches"][number]["mode"],
): PlanRevision {
  return {
    revision: 1,
    planId: "plan-1",
    contentHash: "h",
    supersedes: null,
    createdAt: "2026-06-18T00:00:00.000Z",
    envelope: {
      version: 1,
      concurrencyCeiling: 3,
      allowedRisk: "medium",
      allowedModes: ["parallel-isolated"],
    },
    batches: [
      {
        batchId,
        mode,
        status: "lookahead",
        members: [{ issueId: "u", issueIdentifier: "SYMPH-1" }],
        rationale: "r",
        canary: null,
      },
    ],
    dependencyEdges: [],
    options: [],
    rationale: "r",
    source: "planner",
  };
}
function decision(
  batchId: string,
  kind: PlanDecision["kind"],
  id: string,
): PlanDecision {
  return {
    decisionId: id,
    planId: "plan-1",
    revision: 1,
    batchId,
    kind,
    actor: "operator@pro14",
    optionMarker: null,
    createdAt: "2026-06-18T00:01:00.000Z",
    note: null,
  };
}
function outcome(batchId: string, result: string, id: string): PlanOutcome {
  return {
    outcomeId: id,
    planId: "plan-1",
    revision: 1,
    batchId,
    result,
    issueIdentifiers: ["SYMPH-1"],
    createdAt: "2026-06-18T01:00:00.000Z",
  };
}

describe("computeStandingPlanCalibration (SYMPH-792)", () => {
  it("joins each decision to its eventual batch outcome and the batch mode", () => {
    seq = 0;
    const journal: StandingPlanJournal = [
      revisionEntry(revision("b1", "parallel-isolated")),
      decisionEntry(decision("b1", "approve", "d1")),
      outcomeEntry(outcome("b1", "merged", "o1")),
    ];
    const report = computeStandingPlanCalibration(journal);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      batchId: "b1",
      decisionKind: "approve",
      mode: "parallel-isolated",
      outcome: "merged",
    });
  });

  it("marks a decision with no subsequent outcome as pending", () => {
    seq = 0;
    const journal: StandingPlanJournal = [
      revisionEntry(revision("b1", "parallel-isolated")),
      decisionEntry(decision("b1", "approve", "d1")),
    ];
    const report = computeStandingPlanCalibration(journal);
    expect(report.rows[0]?.outcome).toBe("pending");
  });

  it("rolls up approve→merged rate by batch mode (no auto-authority, just counts)", () => {
    seq = 0;
    const journal: StandingPlanJournal = [
      revisionEntry(revision("b1", "parallel-isolated")),
      decisionEntry(decision("b1", "approve", "d1")),
      outcomeEntry(outcome("b1", "merged", "o1")),
      revisionEntry(revision("b2", "parallel-isolated")),
      decisionEntry(decision("b2", "approve", "d2")),
      outcomeEntry(outcome("b2", "parked", "o2")),
    ];
    const report = computeStandingPlanCalibration(journal);
    const row = report.approveByMode.find(
      (r) => r.mode === "parallel-isolated",
    );
    expect(row?.approved).toBe(2);
    expect(row?.merged).toBe(1);
    expect(row?.approveMergeRate).toBeCloseTo(0.5);
  });

  it("does not cross-join: a reused batchId in another plan keeps outcomes separate", () => {
    seq = 0;
    // plan-A decides b1 (no outcome). plan-B reuses b1 and merges it.
    const planADecision: PlanDecision = {
      ...decision("b1", "approve", "dA"),
      planId: "plan-A",
    };
    const planBDecision: PlanDecision = {
      ...decision("b1", "approve", "dB"),
      planId: "plan-B",
    };
    const planBOutcome: PlanOutcome = {
      ...outcome("b1", "merged", "oB"),
      planId: "plan-B",
    };
    const journal: StandingPlanJournal = [
      revisionEntry({
        ...revision("b1", "parallel-isolated"),
        planId: "plan-A",
      }),
      decisionEntry(planADecision),
      revisionEntry({
        ...revision("b1", "parallel-isolated"),
        planId: "plan-B",
      }),
      decisionEntry(planBDecision),
      outcomeEntry(planBOutcome),
    ];
    const report = computeStandingPlanCalibration(journal);
    const aRow = report.rows.find((r) => r.planId === "plan-A");
    const bRow = report.rows.find((r) => r.planId === "plan-B");
    expect(aRow?.outcome).toBe("pending"); // plan-A's b1 has no outcome
    expect(bRow?.outcome).toBe("merged");
  });

  it("uses the latest outcome for a batch when several exist", () => {
    seq = 0;
    const journal: StandingPlanJournal = [
      revisionEntry(revision("b1", "parallel-isolated")),
      decisionEntry(decision("b1", "approve", "d1")),
      outcomeEntry(outcome("b1", "failed", "o1")),
      outcomeEntry(outcome("b1", "merged", "o2")),
    ];
    const report = computeStandingPlanCalibration(journal);
    expect(report.rows[0]?.outcome).toBe("merged");
  });
});
