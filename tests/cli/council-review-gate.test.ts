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
import { readDispatcherRunJournal } from "../../src/logging/run-journal.js";
import type { HeadlessCouncilGateResult } from "../../src/review/headless-council-gate.js";

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
      riskContractArtifactPaths: [],
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
          "0123456789abcdef0123456789abcdef01234567",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "MOB-88",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      mode: "convergence",
      round: 2,
      previousReviewedHeadSha: "0123456789abcdef0123456789abcdef01234567",
      riskContractArtifactPaths: [],
      allowedChangePatterns: [],
    });
  });

  it("parses repeatable risk contract artifact paths", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "SYMPH-470",
          "--artifact-dir",
          "/tmp/review",
          "--risk-contract-artifact",
          ".symphony/workpads/SYMPH-470-risk-contract.md",
          "--risk-contract-artifact",
          ".symphony/workpads/SYMPH-470-risk-contract.json",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "SYMPH-470",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      riskContractArtifactPaths: [
        ".symphony/workpads/SYMPH-470-risk-contract.md",
        ".symphony/workpads/SYMPH-470-risk-contract.json",
      ],
      allowedChangePatterns: [],
    });
  });

  it("parses Codex excavation lane controls", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "SYMPH-444",
          "--artifact-dir",
          "/tmp/review",
          "--no-codex-excavation",
          "--codex-excavation-sweep",
          "high-risk",
          "--codex-excavation-timeout-seconds",
          "3600",
          "--codex-excavation-tool-output-token-limit",
          "4000",
          "--codex-excavation-model-auto-compact-token-limit",
          "80000",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "SYMPH-444",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      codexExcavation: false,
      codexExcavationSweep: "high-risk",
      codexExcavationTimeoutSeconds: 3600,
      codexExcavationToolOutputTokenLimit: 4000,
      codexExcavationModelAutoCompactTokenLimit: 80000,
      riskContractArtifactPaths: [],
      allowedChangePatterns: [],
    });
  });

  it("parses journal append metadata", () => {
    expect(
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "issue-symph-450",
          "--artifact-dir",
          "/tmp/review",
          "--journal-workspace-root",
          "/workspace",
          "--journal-source",
          "interactive",
          "--journal-stage",
          "review",
          "--journal-attempt",
          "2",
          "--journal-owner-id",
          "worker-1",
          "--journal-issue-identifier",
          "SYMPH-450",
        ],
        "/cwd",
      ),
    ).toEqual({
      issueId: "issue-symph-450",
      artifactDir: "/tmp/review",
      workspace: "/cwd",
      allowedChangePatterns: [],
      journalWorkspaceRoot: "/workspace",
      journalSource: "interactive",
      journalStage: "review",
      journalAttempt: 2,
      journalOwnerId: "worker-1",
      journalIssueIdentifier: "SYMPH-450",
      riskContractArtifactPaths: [],
    });
  });

  it("rejects malformed previous reviewed head metadata", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--previous-reviewed-head",
          "not-a-sha",
        ],
        "/cwd",
      ),
    ).toThrow("--previous-reviewed-head must be a 7-40 character git SHA");
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
      riskContractArtifactPaths: [],
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

  it("rejects unknown Codex excavation sweeps", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "SYMPH-444",
          "--artifact-dir",
          "/tmp/review",
          "--codex-excavation-sweep",
          "all-night",
        ],
        "/cwd",
      ),
    ).toThrow('--codex-excavation-sweep must be "standard" or "high-risk"');
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

  it("rejects risk contract artifacts in freshness assertion mode", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--assert-fresh-review",
          "/tmp/review-result.json",
          "--risk-contract-artifact",
          ".symphony/risk-contract.md",
        ],
        "/cwd",
      ),
    ).toThrow("--risk-contract-artifact is only valid");
  });

  it("rejects Codex lane flags in freshness assertion mode", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--assert-fresh-review",
          "/tmp/review-result.json",
          "--codex-excavation-sweep",
          "high-risk",
        ],
        "/cwd",
      ),
    ).toThrow("Codex lane flags are only valid");
  });

  it("rejects journal metadata without journal append root", () => {
    expect(() =>
      parseCouncilReviewGateArgs(
        [
          "--issue-id",
          "MOB-88",
          "--artifact-dir",
          "/tmp/review",
          "--journal-source",
          "interactive",
        ],
        "/cwd",
      ),
    ).toThrow("--journal-source");
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

  it("appends sanitized journal events when the journal root flag is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-council-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runCouncilReviewGateCli(
      [
        "--issue-id",
        "issue-symph-450",
        "--artifact-dir",
        join(root, "artifacts"),
        "--workspace",
        root,
        "--journal-workspace-root",
        root,
        "--journal-source",
        "pipeline",
        "--journal-stage",
        "review",
        "--journal-attempt",
        "1",
        "--journal-owner-id",
        "worker-1",
        "--journal-issue-identifier",
        "SYMPH-450",
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
      {
        runHeadlessCouncilGate: async () => cliReviewResult(),
      },
    );
    const journal = await readDispatcherRunJournal(root);

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      issueId: "issue-symph-450",
      verdict: "pass",
    });
    expect(journal.map((entry) => entry.kind)).toEqual([
      "review_round",
      "review_gate_result",
    ]);
    expect(journal[0]).toMatchObject({
      sequence: 1,
      issueId: "issue-symph-450",
      issueIdentifier: "SYMPH-450",
      operation: "gate",
      stage: "review",
      attempt: 1,
      ownerId: "worker-1",
      metadata: {
        schema_version: 1,
        source: "pipeline",
        actor_kind: "pipeline-worker",
        actor_id: "worker-1",
        contract_version: "markdown_v0",
      },
    });
  });

  it.each(["pipeline", "interactive"] as const)(
    "fails closed when %s review result journaling fails",
    async (journalSource) => {
      const root = await mkdtemp(join(tmpdir(), "symphony-council-cli-"));
      const stdout: string[] = [];
      const stderr: string[] = [];

      const code = await runCouncilReviewGateCli(
        [
          "--issue-id",
          "issue-symph-478",
          "--artifact-dir",
          join(root, "artifacts"),
          "--workspace",
          root,
          "--journal-workspace-root",
          root,
          "--journal-source",
          journalSource,
          "--journal-stage",
          "review",
          "--journal-attempt",
          "1",
          "--journal-owner-id",
          "worker-1",
          "--journal-issue-identifier",
          "SYMPH-478",
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
        {
          runHeadlessCouncilGate: async () => ({
            ...cliReviewResult(),
            issueId: "issue-symph-478",
          }),
          appendReviewJournalEventsToDispatcherJournal: async () => {
            throw new Error(
              "EACCES: permission denied, append dispatcher.jsonl",
            );
          },
        },
      );

      const errorOutput = stderr.join("");

      expect(code).toBe(1);
      expect(stdout).toEqual([]);
      expect(errorOutput).toContain(
        "Failed to append council review result to the dispatcher journal",
      );
      expect(errorOutput).toContain(
        join(root, ".symphony", "run-journals", "dispatcher.jsonl"),
      );
      expect(errorOutput).toContain(`Source: ${journalSource}`);
      expect(errorOutput).toContain(
        "SPEC.mobilyze.md's Dispatcher Resume Contract",
      );
      expect(errorOutput).toContain("source of truth for gate replay");
      expect(errorOutput).toContain("Pipeline expectation:");
      expect(errorOutput).toContain("Interactive expectation:");
    },
  );

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
    expect(() => parseCouncilReviewGateArgs(["--help"], "/cwd")).toThrow(
      /--journal-workspace-root DIR[\s\S]*fail closed on append errors/,
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

function cliReviewResult(): HeadlessCouncilGateResult {
  return {
    schemaVersion: 1,
    issueId: "issue-symph-450",
    verdict: "pass",
    startedAt: "2026-06-12T10:00:00.000Z",
    completedAt: "2026-06-12T10:01:00.000Z",
    pr: {
      repo: "mobilyze-llc/symphony-ts",
      number: 450,
      baseRef: "main",
      headRef: "codex/SYMPH-450-review-journal-events",
    },
    review_metadata: {
      reviewed_head_sha: "head-sha",
      previous_reviewed_head_sha: null,
      base_sha: "base-sha",
      round: 1,
      mode: "full",
      verdict: "pass",
    },
    review_bundle: null,
    targeted_convergence: null,
    lanes: [],
    degradedConditions: [],
    artifactPaths: {
      artifactDir: "/tmp/review",
      diff: null,
      reviewBundle: null,
      structuredArtifacts: [],
      resultJson: "/tmp/review/review-result.json",
      councilReport: "/tmp/review/council-report.md",
    },
    summary: "Headless council review passed with 0 lanes.",
  };
}
