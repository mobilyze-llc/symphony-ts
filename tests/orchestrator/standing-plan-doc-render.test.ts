import { describe, expect, it } from "vitest";

import type {
  PlanEnvelope,
  StandingPlan,
  StandingPlanJournal,
} from "../../src/domain/standing-plan.js";
import {
  STANDING_PLAN_DOC_TITLE,
  computeRecentlyShipped,
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
    dependencyEdges: [],
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
    // options block: revision-stamped [opt-N:rREV] markers (revision binding)
    expect(md).toContain("[opt-1:r4]");
    expect(md).toMatch(/Options[\s\S]*\[opt-1:r4\]/);
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

  it("renders execution waves from persisted dependency edges", () => {
    const p = plan();
    p.dependencyEdges = [{ issueIdentifier: "SYMPH-2", dependsOn: "SYMPH-1" }];
    const md = renderStandingPlanControlDoc({
      plan: p,
      recentlyShipped: [],
      inFlight: [],
      changelog: [],
    });

    expect(md).toContain("Execution waves");
    expect(md).toContain("Wave 1: SYMPH-1");
    expect(md).toContain("Wave 2: SYMPH-2 (waits on SYMPH-1)");
  });
});

describe("computeRecentlyShipped (SYMPH-803)", () => {
  function outcomeEntry(
    sequence: number,
    result: string,
    issueIdentifiers: string[],
  ): StandingPlanJournal[number] {
    return {
      sequence,
      idempotencyKey: `o${sequence}`,
      timestamp: "2026-06-19T00:00:00.000Z",
      kind: "plan_outcome",
      planId: "plan-1",
      outcome: {
        outcomeId: `o${sequence}`,
        planId: "plan-1",
        revision: 1,
        batchId: "b1",
        result,
        issueIdentifiers,
        createdAt: "2026-06-19T00:00:00.000Z",
      },
    };
  }

  it("lists merged issues newest-first, ignoring parked/failed", () => {
    const journal: StandingPlanJournal = [
      outcomeEntry(1, "merged", ["SYMPH-1"]),
      outcomeEntry(2, "failed", ["SYMPH-2"]),
      outcomeEntry(3, "merged", ["SYMPH-3"]),
      outcomeEntry(4, "parked", ["SYMPH-4"]),
    ];
    expect(computeRecentlyShipped(journal, 10)).toEqual([
      { issueIdentifier: "SYMPH-3" },
      { issueIdentifier: "SYMPH-1" },
    ]);
  });

  it("de-dupes a re-merged identifier to its latest occurrence and caps at the limit", () => {
    const journal: StandingPlanJournal = [
      outcomeEntry(1, "merged", ["SYMPH-1"]),
      outcomeEntry(2, "merged", ["SYMPH-2"]),
      outcomeEntry(3, "merged", ["SYMPH-1"]), // re-merge of SYMPH-1
      outcomeEntry(4, "merged", ["SYMPH-3"]),
    ];
    expect(computeRecentlyShipped(journal, 2)).toEqual([
      { issueIdentifier: "SYMPH-3" },
      { issueIdentifier: "SYMPH-1" },
    ]);
  });

  it("returns an empty list when nothing has merged", () => {
    expect(
      computeRecentlyShipped([outcomeEntry(1, "failed", ["SYMPH-1"])], 10),
    ).toEqual([]);
  });
});

describe("renderStandingPlanControlDoc — recently shipped (SYMPH-803)", () => {
  it("renders shipped identifiers without a title when none is present", () => {
    const md = renderStandingPlanControlDoc({
      plan: {
        planId: "plan-1",
        revision: 1,
        contentHash: "h",
        envelope: ENVELOPE,
        batches: [],
        dependencyEdges: [],
        options: [],
        rationale: "r",
        createdAt: "2026-06-19T00:00:00.000Z",
        updatedAt: "2026-06-19T00:00:00.000Z",
      },
      recentlyShipped: [{ issueIdentifier: "SYMPH-7" }],
      inFlight: [],
      changelog: [],
    });
    expect(md).toContain("## Recently shipped");
    expect(md).toContain("- SYMPH-7");
    expect(md).not.toContain("SYMPH-7 — "); // no dangling em-dash without a title
  });
});
