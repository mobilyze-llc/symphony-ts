import { describe, expect, it } from "vitest";

import { isValidPlanBatch } from "../../src/domain/plan-batch.js";
import { runDeterministicPlanReviewChecks } from "../../src/domain/plan-review-checks.js";
import type {
  PlanBatch,
  PlanEnvelope,
} from "../../src/domain/standing-plan.js";
import type { PlanBody } from "../../src/orchestrator/standing-plan-supersession.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 1,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function batch(over: Partial<PlanBatch> = {}): PlanBatch {
  return {
    batchId: "b1",
    mode: "parallel-isolated",
    status: "lookahead",
    members: [{ issueId: "u1", issueIdentifier: "SYMPH-1" }],
    rationale: "r",
    canary: null,
    ...over,
  };
}

function body(batches: PlanBatch[]): PlanBody {
  return {
    batches,
    options: [],
    envelope: ENVELOPE,
    rationale: "r",
    source: "planner",
    dependencyEdges: [],
  };
}

describe("deterministic plan-review checks", () => {
  it("flags scheduled candidates in cancelled, duplicate, or ineligible tracker states", () => {
    const findings = runDeterministicPlanReviewChecks({
      body: body([batch()]),
      candidates: [{ issueIdentifier: "SYMPH-1", state: "Cancelled" }],
    });

    expect(findings).toEqual([
      {
        title: "Scheduled ineligible candidate SYMPH-1 (Cancelled)",
        planAnchor: "b1:SYMPH-1",
        severity: "P2",
      },
    ]);
  });

  it("flags envelope overruns without rechecking canary/member integrity", () => {
    const findings = runDeterministicPlanReviewChecks({
      body: body([
        batch({
          members: [
            { issueId: "u1", issueIdentifier: "SYMPH-1" },
            { issueId: "u2", issueIdentifier: "SYMPH-2" },
          ],
        }),
      ]),
      candidates: [
        { issueIdentifier: "SYMPH-1", state: "Backlog" },
        { issueIdentifier: "SYMPH-2", state: "Backlog" },
      ],
    });

    expect(findings.map((finding) => finding.title)).toEqual([
      "Batch b1 schedules 2 members over concurrency ceiling 1",
    ]);

    const malformedCanary = batch({
      mode: "canary-chain",
      canary: {
        headIssueIdentifiers: ["SYMPH-MISSING"],
        contingentIssueIdentifiers: [],
      },
    });
    expect(isValidPlanBatch(malformedCanary)).toBe(false);
    expect(
      runDeterministicPlanReviewChecks({
        body: {
          ...body([malformedCanary]),
          envelope: {
            ...ENVELOPE,
            allowedModes: ["parallel-isolated", "canary-chain"],
          },
        },
        candidates: [{ issueIdentifier: "SYMPH-1", state: "Backlog" }],
      }),
    ).toEqual([]);
  });
});
