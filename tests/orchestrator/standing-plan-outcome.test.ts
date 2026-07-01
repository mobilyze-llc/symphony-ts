import { describe, expect, it } from "vitest";

import type { StandingPlan } from "../../src/domain/standing-plan.js";
import { resolveBatchOutcome } from "../../src/orchestrator/standing-plan-outcome.js";

function plan(): StandingPlan {
  return {
    planId: "plan-1",
    revision: 5,
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
    ],
    dependencyEdges: [],
    options: [],
    rationale: "r",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:05:00.000Z",
  };
}

describe("resolveBatchOutcome (SYMPH-803)", () => {
  it("maps a planned issue's terminal result to a batch outcome record", () => {
    const outcome = resolveBatchOutcome({
      plan: plan(),
      issueIdentifier: "SYMPH-2",
      result: "merged",
      createdAt: "2026-06-19T01:00:00.000Z",
    });
    expect(outcome).toEqual({
      planId: "plan-1",
      revision: 5,
      batchId: "b-app",
      result: "merged",
      issueIdentifiers: ["SYMPH-2"],
      outcomeId: "b-app:SYMPH-2:merged",
      createdAt: "2026-06-19T01:00:00.000Z",
    });
  });

  it("returns null when no plan exists (nothing to attribute the outcome to)", () => {
    expect(
      resolveBatchOutcome({
        plan: null,
        issueIdentifier: "SYMPH-1",
        result: "failed",
        createdAt: "2026-06-19T01:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("returns null when the issue is not a member of any batch (bare/comparator issue)", () => {
    expect(
      resolveBatchOutcome({
        plan: plan(),
        issueIdentifier: "SYMPH-999",
        result: "merged",
        createdAt: "2026-06-19T01:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("carries the result label through (parked/failed) and derives a result-scoped outcomeId", () => {
    const parked = resolveBatchOutcome({
      plan: plan(),
      issueIdentifier: "SYMPH-1",
      result: "parked",
      createdAt: "2026-06-19T02:00:00.000Z",
    });
    expect(parked?.result).toBe("parked");
    expect(parked?.outcomeId).toBe("b-app:SYMPH-1:parked");

    const failed = resolveBatchOutcome({
      plan: plan(),
      issueIdentifier: "SYMPH-1",
      result: "failed",
      createdAt: "2026-06-19T02:00:00.000Z",
    });
    expect(failed?.result).toBe("failed");
    expect(failed?.outcomeId).toBe("b-app:SYMPH-1:failed");
  });
});
