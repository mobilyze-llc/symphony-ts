import { describe, expect, it } from "vitest";

import { computeDependencyWaves } from "../../src/domain/standing-plan.js";

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
});
