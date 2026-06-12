import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isDirectRun,
  parseCouncilReviewGateArgs,
  runCouncilReviewGateCli,
} from "../../src/cli/council-review-gate.js";

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
      allowedChangePatterns: [],
    });
  });

  it("parses council loop metadata", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--mode",
          "convergence",
          "--round",
          "2",
          "--previous-reviewed-head",
          "old-head-sha",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "MOB-88",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      mode: "convergence",
      round: 2,
      previousReviewedHeadSha: "old-head-sha",
      allowedChangePatterns: [],
    });
  });

  it("parses freshness assertion inputs", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--assert-fresh-review",
          "/tmp/old/review-result.json",
          "--allow-stale-path",
          ".symphony/reports/**",
          "--allow-stale-path",
          "docs/reports/*.html",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "MOB-88",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      assertFreshReview: "/tmp/old/review-result.json",
      allowedChangePatterns: [".symphony/reports/**", "docs/reports/*.html"],
    });
  });

  it("rejects unknown council modes", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--mode",
          "maybe",
        ],
        "/cwd",
      ),
    ).toThrow('--mode must be "full" or "convergence"');
  });

  it("rejects review loop flags in freshness assertion mode", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--assert-fresh-review",
          "/tmp/review-result.json",
          "--mode",
          "convergence",
        ],
        "/cwd",
      ),
    ).toThrow("--mode, --round, and --previous-reviewed-head are only valid");
  });

  it("returns exit code 2 for invalid freshness artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-council-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCouncilReviewGateCli(
      [
        "--issue-id",
        "MOB-88",
        "--artifact-dir",
        join(root, "artifacts"),
        "--workspace",
        root,
        "--assert-fresh-review",
        join(root, "missing-review-result.json"),
      ],
      {
        stdout: (message) => {
          stdout.push(message);
          return true;
        },
        stderr: (message) => {
          stderr.push(message);
          return true;
        },
      },
    );

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      verdict: "error",
      code: "invalid_review_artifact",
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

  it("rejects malformed repo slugs before shelling out to gh", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--repo",
          "mobilyze-llc/symphony-ts/extra",
          "--pr",
          "282",
        ],
        "/cwd",
      ),
    ).toThrow("--repo must use OWNER/REPO format");
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

  it("shows required flags in help", () => {
    expect(() => parseCouncilReviewGateArgs(["--help"], "/cwd")).toThrow(
      /--issue-id ISSUE[\s\S]*--artifact-dir DIR/,
    );
    expect(() => parseCouncilReviewGateArgs(["--help"], "/cwd")).toThrow(
      /\*\* crosses \/[\s\S]*\* and \? do not/,
    );
  });

  it("recognizes direct bin execution through symlink paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-council-cli-"));
    const realBin = join(root, "real bin.js");
    const linkedBin = join(root, "linked-bin.js");
    await writeFile(realBin, "");
    await symlink(realBin, linkedBin);

    expect(
      isDirectRun(pathToFileURL(await realpath(realBin)).href, linkedBin),
    ).toBe(true);
  });
});
