import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildComparisonReport,
  parseKimiCouncilReplayArgs,
  runKimiCouncilReplay,
  runKimiCouncilReplayCli,
} from "../../src/cli/kimi-council-replay.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function sourceLane(
  overrides: Partial<
    NonNullable<
      Parameters<typeof buildComparisonReport>[0]["sourceLanes"][number]
    >
  > = {},
): Parameters<typeof buildComparisonReport>[0]["sourceLanes"][number] {
  return {
    laneId: "opus",
    agent: "claude",
    role: "legacy-reviewer",
    modelFamily: "anthropic",
    verdict: "fail",
    parseStatus: "synthesized_from_markdown",
    sourceRecallEligible: true,
    sourceRecallExclusionReason: null,
    blockingFingerprints: ["source-blocker"],
    trackFingerprints: [],
    artifactPath: "/tmp/source-council/opus.structured.json",
    reviewBundleCanonicalHash: null,
    ...overrides,
  };
}

describe("parseKimiCouncilReplayArgs", () => {
  it("parses source council replay inputs and Kimi overrides", () => {
    expect(
      parseKimiCouncilReplayArgs(
        [
          "--source-council-dir",
          "/tmp/source-council",
          "--artifact-dir",
          "/tmp/kimi-replay",
          "--issue-id",
          "SYMPH-689",
          "--workspace",
          "/repo",
          "--repo",
          "mobilyze-llc/symphony-ts",
          "--pr",
          "683",
          "--base",
          "main",
          "--head",
          "feature",
          "--kimi-bin",
          "/opt/kimi/bin/kimi",
          "--kimi-model",
          "kimi-test",
        ],
        "/cwd",
      ),
    ).toEqual({
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      issueId: "SYMPH-689",
      workspace: "/repo",
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 683,
      baseRef: "main",
      headRef: "feature",
      kimiBin: "/opt/kimi/bin/kimi",
      kimiModel: "kimi-test",
    });
  });

  it("reports usage errors for invalid replay arguments", () => {
    expect(() => parseKimiCouncilReplayArgs(["--help"])).toThrow("Usage:");
    expect(() => parseKimiCouncilReplayArgs(["--unknown"])).toThrow(
      "Unknown argument: --unknown",
    );
    expect(() =>
      parseKimiCouncilReplayArgs(["--cmux-spawn-bin", "/opt/cmux-spawn"]),
    ).toThrow("Unknown argument: --cmux-spawn-bin");
    expect(() =>
      parseKimiCouncilReplayArgs([
        "--source-council-dir",
        "/tmp/source-council",
        "--artifact-dir",
        "/tmp/kimi-replay",
      ]),
    ).toThrow("--issue-id is required.");
    expect(() =>
      parseKimiCouncilReplayArgs([
        "--source-council-dir",
        "/tmp/source-council",
        "--artifact-dir",
        "/tmp/kimi-replay",
        "--issue-id",
        "SYMPH-689",
        "--pr",
        "0",
      ]),
    ).toThrow("--pr must be a positive integer.");
  });
});

describe("buildComparisonReport", () => {
  it("classifies malformed Kimi structured artifacts as malformed", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [],
      kimiLane: {
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        verdict: "fail",
        parseStatus: "malformed",
        sourceRecallEligible: false,
        sourceRecallExclusionReason: "prior_shadow_artifact",
        blockingFingerprints: [],
        trackFingerprints: [],
        artifactPath: "/tmp/kimi-replay/kimi-k27-shadow.structured.json",
        reviewBundleCanonicalHash: null,
      },
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.artifactContract).toBe("malformed");
    expect(report.scoring.artifactContractReason).toContain("malformed");
  });

  it("classifies malformed Kimi parse status as malformed", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        parseStatus: "malformed",
        artifactPath: "/tmp/kimi-replay/kimi-k27-shadow.structured.json",
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.artifactContract).toBe("malformed");
    expect(report.scoring.artifactContractReason).toContain("malformed");
  });

  it("scores blocker recall and classifies missing Kimi artifacts", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        sourceLane({
          parseStatus: "synthesized_from_markdown",
          blockingFingerprints: ["b", "a"],
          trackFingerprints: ["t"],
        }),
      ],
      kimiLane: null,
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.artifactContract).toBe("missing");
    expect(report.scoring.blockerRecallAgainstUnion).toBe(0);
    expect(report.scoring.sourceBlockingFingerprints).toEqual(["a", "b"]);
    expect(report.scoring.missingSourceBlockingFingerprints).toEqual([
      "a",
      "b",
    ]);
  });

  it("excludes lead, prior shadow, malformed, and disposition-closed source blockers from recall", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        sourceLane({ blockingFingerprints: ["eligible"] }),
        sourceLane({
          laneId: "codex-high-lead",
          role: "codex-lead-triage",
          sourceRecallEligible: false,
          sourceRecallExclusionReason: "lead_artifact",
          blockingFingerprints: ["lead-only"],
        }),
        sourceLane({
          laneId: "kimi-k27-shadow",
          agent: "kimi",
          role: "kimi-k27-shadow-reviewer",
          modelFamily: "moonshot-kimi",
          sourceRecallEligible: false,
          sourceRecallExclusionReason: "prior_shadow_artifact",
          blockingFingerprints: ["prior-shadow-only"],
        }),
        sourceLane({
          parseStatus: "malformed",
          sourceRecallEligible: false,
          sourceRecallExclusionReason: "non_ok_parse_status",
          blockingFingerprints: ["malformed-only"],
        }),
      ],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        blockingFingerprints: ["eligible"],
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.sourceBlockingFingerprints).toEqual(["eligible"]);
    expect(report.scoring.blockerRecallAgainstUnion).toBe(1);
  });

  it("reports whether the Kimi replay bundle hash matches the source bundle hash", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [sourceLane({ reviewBundleCanonicalHash: "a".repeat(64) })],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        reviewBundleCanonicalHash: "a".repeat(64),
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: "a".repeat(64),
      sourceHashStatus: "consistent",
      sourceHashes: ["a".repeat(64)],
      kimiReplayBundleHash: "a".repeat(64),
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: true,
      usedByKimiReplay: true,
    });
  });

  it("reports when a fresh Kimi replay produced a different bundle hash", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [sourceLane({ reviewBundleCanonicalHash: "a".repeat(64) })],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        reviewBundleCanonicalHash: "b".repeat(64),
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: "a".repeat(64),
      sourceHashStatus: "consistent",
      sourceHashes: ["a".repeat(64)],
      kimiReplayBundleHash: "b".repeat(64),
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: false,
      usedByKimiReplay: false,
    });
  });

  it("reports divergent source frozen review bundle hashes distinctly", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        sourceLane({ reviewBundleCanonicalHash: "b".repeat(64) }),
        sourceLane({ reviewBundleCanonicalHash: "a".repeat(64) }),
      ],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        reviewBundleCanonicalHash: "a".repeat(64),
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: null,
      sourceHashStatus: "divergent",
      sourceHashes: ["a".repeat(64), "b".repeat(64)],
      kimiReplayBundleHash: "a".repeat(64),
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: null,
      usedByKimiReplay: false,
    });
  });

  it("reports unavailable source bundle hashes separately from divergence", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        sourceLane({ reviewBundleCanonicalHash: null }),
        sourceLane({ reviewBundleCanonicalHash: null }),
      ],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        reviewBundleCanonicalHash: "a".repeat(64),
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: null,
      sourceHashStatus: "absent",
      sourceHashes: [],
      kimiReplayBundleHash: "a".repeat(64),
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: null,
      usedByKimiReplay: false,
    });
  });

  it("reports partial source bundle hashes separately from consistency", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        sourceLane({ reviewBundleCanonicalHash: "a".repeat(64) }),
        sourceLane({ reviewBundleCanonicalHash: null }),
      ],
      kimiLane: sourceLane({
        laneId: "kimi-k27-shadow",
        agent: "kimi",
        role: "kimi-k27-shadow-reviewer",
        modelFamily: "moonshot-kimi",
        reviewBundleCanonicalHash: "a".repeat(64),
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: null,
      sourceHashStatus: "partial",
      sourceHashes: ["a".repeat(64)],
      kimiReplayBundleHash: "a".repeat(64),
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: null,
      usedByKimiReplay: false,
    });
  });

  it("does not mark the bundle as used when Kimi produced no structured artifact", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [sourceLane({ reviewBundleCanonicalHash: "a".repeat(64) })],
      kimiLane: null,
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: "a".repeat(64),
      sourceHashStatus: "consistent",
      sourceHashes: ["a".repeat(64)],
      kimiReplayBundleHash: null,
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: null,
      usedByKimiReplay: false,
    });
  });
});

describe("runKimiCouncilReplay", () => {
  it("fails with a clear retired-tool error", async () => {
    await expect(
      runKimiCouncilReplay({
        sourceCouncilDir: "/tmp/source-council",
        replayArtifactDir: "/tmp/kimi-replay",
        workspace: "/repo",
        issueId: "SYMPH-689",
      }),
    ).rejects.toThrow("symphony-kimi-council-replay has been retired");
  });
});

describe("runKimiCouncilReplayCli", () => {
  async function writeReplaySource(): Promise<{
    sourceCouncilDir: string;
    replayArtifactDir: string;
  }> {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    return { sourceCouncilDir, replayArtifactDir };
  }

  it("returns usage status without running replay for help or invalid args", async () => {
    const writes: string[] = [];
    await expect(
      runKimiCouncilReplayCli(["--help"], {
        stdout: (message) => {
          writes.push(message);
          return true;
        },
        stderr: (message) => {
          writes.push(message);
          return true;
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runKimiCouncilReplayCli(["--unknown"], {
        stdout: (message) => {
          writes.push(message);
          return true;
        },
        stderr: (message) => {
          writes.push(message);
          return true;
        },
      }),
    ).resolves.toBe(2);
    expect(writes.join("\n")).toContain("Usage:");
  });

  it("returns 1 with a retired-tool message for fresh replay execution", async () => {
    const { sourceCouncilDir, replayArtifactDir } = await writeReplaySource();
    const writes: string[] = [];
    await expect(
      runKimiCouncilReplayCli(
        [
          "--source-council-dir",
          sourceCouncilDir,
          "--artifact-dir",
          replayArtifactDir,
          "--issue-id",
          "SYMPH-689",
        ],
        {
          stdout: (message) => {
            writes.push(message);
            return true;
          },
          stderr: (message) => {
            writes.push(message);
            return true;
          },
        },
      ),
    ).resolves.toBe(1);
    expect(writes.join("\n")).toContain(
      "symphony-kimi-council-replay has been retired",
    );
  });
});
