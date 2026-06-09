import { describe, expect, it } from "vitest";

import { parseCouncilReviewGateArgs } from "../../src/cli/council-review-gate.js";

describe("parseCouncilReviewGateArgs", () => {
  it("parses required inputs and PR context", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--workspace",
          "/repo",
          "--repo",
          "mobilyze-llc/symphony-ts",
          "--pr",
          "282",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "MOB-88",
      artifactDir: "/tmp/review",
      workspace: "/repo",
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 282,
    });
  });

  it("requires a repo when PR mode is used", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        ["--issue-id", "MOB-88", "--artifact-dir", "/tmp/review", "--pr", "1"],
        "/cwd",
      ),
    ).toThrow("--repo is required");
  });

  it("rejects invalid numeric flags", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--timeout-seconds",
          "0",
        ],
        "/cwd",
      ),
    ).toThrow("--timeout-seconds must be a positive integer");
  });
});
