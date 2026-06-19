import { describe, expect, it } from "vitest";

import type {
  PlanEnvelope,
  StandingPlan,
} from "../../src/domain/standing-plan.js";
import {
  STANDING_PLAN_DOC_TITLE,
  renderStandingPlanControlDoc,
} from "../../src/orchestrator/standing-plan-doc-render.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 3,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

function plan(): StandingPlan {
  return {
    planId: "plan-1",
    revision: 4,
    contentHash: "abc",
    envelope: ENVELOPE,
    batches: [
      {
        batchId: "b-aaa",
        mode: "parallel-isolated",
        status: "lookahead",
        members: [
          { issueId: "u1", issueIdentifier: "SYMPH-1" },
          { issueId: "u2", issueIdentifier: "SYMPH-2" },
        ],
        rationale: "highest-priority independent work",
        canary: null,
      },
    ],
    options: [
      {
        marker: "[opt-1]",
        label: "Release b-aaa (parallel-isolated): SYMPH-1, SYMPH-2",
        intent: { verb: "release_batch", batchId: "b-aaa" },
      },
    ],
    rationale: "Ship the independent frontier first.",
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:05:00.000Z",
  };
}

describe("renderStandingPlanControlDoc", () => {
  it("renders the branded title, revision stamp, and all sections", () => {
    const md = renderStandingPlanControlDoc({
      plan: plan(),
      recentlyShipped: [{ issueIdentifier: "SYMPH-8", title: "Prior fix" }],
      inFlight: [{ issueIdentifier: "SYMPH-7", stage: "implement" }],
      changelog: [
        {
          revision: 4,
          createdAt: "2026-06-18T00:05:00.000Z",
          rationale: "re-plan after merge",
        },
        {
          revision: 3,
          createdAt: "2026-06-18T00:00:00.000Z",
          rationale: "initial",
        },
      ],
    });
    expect(md).toContain(STANDING_PLAN_DOC_TITLE);
    expect(md).toContain("Revision 4");
    expect(md).toContain("Recently shipped");
    expect(md).toContain("SYMPH-8");
    expect(md).toContain("In flight");
    expect(md).toContain("SYMPH-7");
    expect(md).toContain("Proposed next batch");
    expect(md).toContain("parallel-isolated");
    expect(md).toContain("highest-priority independent work");
    // options block: unique [opt-N] markers + the revision binding
    expect(md).toContain("[opt-1]");
    expect(md).toMatch(/Options[\s\S]*\[opt-1\]/);
    // in-body revision changelog
    expect(md).toContain("re-plan after merge");
  });

  it("renders empty-state sections gracefully", () => {
    const empty: StandingPlan = { ...plan(), batches: [], options: [] };
    const md = renderStandingPlanControlDoc({
      plan: empty,
      recentlyShipped: [],
      inFlight: [],
      changelog: [],
    });
    expect(md).toContain(STANDING_PLAN_DOC_TITLE);
    expect(md).toContain("(none)");
  });

  it("renders canary structure for a canary-chain batch", () => {
    const p = plan();
    p.batches = [
      {
        batchId: "b-canary",
        mode: "canary-chain",
        status: "lookahead",
        members: [
          { issueId: "u1", issueIdentifier: "SYMPH-1" },
          { issueId: "u2", issueIdentifier: "SYMPH-2" },
        ],
        rationale: "validate head first",
        canary: {
          headIssueIdentifiers: ["SYMPH-1"],
          contingentIssueIdentifiers: ["SYMPH-2"],
        },
      },
    ];
    const md = renderStandingPlanControlDoc({
      plan: p,
      recentlyShipped: [],
      inFlight: [],
      changelog: [],
    });
    expect(md).toContain("canary-chain");
    expect(md.toLowerCase()).toContain("head");
    expect(md).toContain("SYMPH-1");
  });
});
