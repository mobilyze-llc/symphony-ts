import { describe, expect, it } from "vitest";

import {
  type PlanEnvelope,
  computeDependencyWaves,
  computePlanContentHash,
} from "../../src/domain/standing-plan.js";

const ENVELOPE: PlanEnvelope = {
  version: 1,
  concurrencyCeiling: 2,
  allowedRisk: "medium",
  allowedModes: ["parallel-isolated"],
};

describe("computeDependencyWaves (SYMPH-843)", () => {
  it("layers members by dependency depth, preserving input order within a wave", () => {
    const waves = computeDependencyWaves(
      ["A", "B", "C", "D"],
      [
        { issueIdentifier: "B", dependsOn: "A" },
        { issueIdentifier: "C", dependsOn: "B" },
      ],
    );
    // A and D have no prerequisites -> wave 1; B waits on A -> wave 2; C waits on B -> wave 3.
    expect(waves).toEqual([["A", "D"], ["B"], ["C"]]);
  });

  it("puts every member in one wave when there are no edges", () => {
    expect(computeDependencyWaves(["A", "B"], [])).toEqual([["A", "B"]]);
  });

  it("ignores edges whose endpoints are not members", () => {
    const waves = computeDependencyWaves(
      ["A", "B"],
      [{ issueIdentifier: "B", dependsOn: "Z" }],
    );
    expect(waves).toEqual([["A", "B"]]);
  });

  it("terminates defensively on cyclic input (never hangs), preserving all members (council R1)", () => {
    // buildPlanBody guarantees acyclic edges; this only exercises the defensive
    // guard so a corrupted/hand-built cyclic input can't infinite-loop.
    const waves = computeDependencyWaves(
      ["A", "B"],
      [
        { issueIdentifier: "A", dependsOn: "B" },
        { issueIdentifier: "B", dependsOn: "A" },
      ],
    );
    expect([...waves.flat()].sort()).toEqual(["A", "B"]);
  });
});

describe("computePlanContentHash review metadata", () => {
  it("excludes structured premises and review findings from the content hash", () => {
    const base = {
      planId: "plan-1",
      source: "planner" as const,
      envelope: ENVELOPE,
      batches: [
        {
          batchId: "b1",
          mode: "parallel-isolated" as const,
          status: "lookahead" as const,
          members: [{ issueId: "u1", issueIdentifier: "SYMPH-1" }],
          rationale: "r",
          canary: null,
        },
      ],
      dependencyEdges: [],
      options: [],
      rationale: "r",
    };

    const first = {
      ...base,
      premises: [
        {
          decisionAnchor: "SYMPH-1",
          kind: "verifiable" as const,
          statement: "Backlog state.",
        },
      ],
      findings: [
        {
          title: "finding",
          planAnchor: "SYMPH-1",
          severity: "Track" as const,
        },
      ],
    };
    const second = {
      ...base,
      premises: [
        {
          decisionAnchor: "SYMPH-1",
          kind: "judgment" as const,
          statement: "Different premise.",
        },
      ],
      findings: [
        {
          title: "different",
          planAnchor: "b1",
          severity: "P2" as const,
        },
      ],
    };

    expect(computePlanContentHash(first)).toBe(computePlanContentHash(second));
  });
});
