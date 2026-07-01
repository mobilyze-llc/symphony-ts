import { describe, expect, it } from "vitest";

import {
  buildGroundingClaimsForPlannerCandidate,
  extractExplicitGroundingClaims,
} from "../../src/orchestrator/grounding-claims.js";

describe("grounding claims", () => {
  it("extracts explicit paths from candidate body text", () => {
    const result = buildGroundingClaimsForPlannerCandidate({
      id: "issue-1",
      identifier: "SYMPH-1",
      title: "Touch planner",
      body: "Update `src/agent/triage-planner.ts` for rendering.",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.findingId).toBe("planner:SYMPH-1");
    expect(result.claims[0]?.evidence).toContain(
      "`src/agent/triage-planner.ts`",
    );
    expect(result.mappings).toEqual([
      {
        findingId: "planner:SYMPH-1",
        candidateId: "issue-1",
        candidateIdentifier: "SYMPH-1",
      },
    ]);
  });

  it("extracts backticked symbol citations", () => {
    expect(
      extractExplicitGroundingClaims("Use `runManagedCodeGrounding` here."),
    ).toContain("runManagedCodeGrounding");
  });

  it("includes comment-only citations as first-class claim sources", () => {
    const result = buildGroundingClaimsForPlannerCandidate({
      id: "issue-2",
      identifier: "SYMPH-2",
      title: "No body citation",
      body: "No files here.",
      comments: [
        {
          id: "comment-1",
          authorClass: "operator",
          createdAt: "2026-07-01T00:00:00.000Z",
          body: "The overlap is in `src/orchestrator/backlog-hygiene.ts`.",
        },
      ],
    });

    expect(result.claims[0]?.evidence).toContain("comment comment-1");
    expect(result.claims[0]?.evidence).toContain(
      "`src/orchestrator/backlog-hygiene.ts`",
    );
  });

  it("returns an empty claim set when no explicit citations exist", () => {
    const result = buildGroundingClaimsForPlannerCandidate({
      id: "issue-3",
      identifier: "SYMPH-3",
      title: "Needs design",
      body: "Discuss this later.",
    });

    expect(result.claims).toEqual([]);
    expect(result.mappings).toEqual([]);
  });

  it("dedupes repeated path and symbol citations", () => {
    const claims = extractExplicitGroundingClaims(
      "`src/foo.ts` and src/foo.ts plus `doThing` and `doThing`.",
    );

    expect(claims.filter((claim) => claim === "src/foo.ts")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "doThing")).toHaveLength(1);
  });
});
