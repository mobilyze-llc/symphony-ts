import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runHeadlessCouncilGateMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/review/headless-council-gate.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/review/headless-council-gate.js")
    >();
  return {
    ...actual,
    runHeadlessCouncilGate: runHeadlessCouncilGateMock,
  };
});

import {
  buildComparisonReport,
  parseKimiCouncilReplayArgs,
  runKimiCouncilReplay,
  runKimiCouncilReplayCli,
} from "../../src/cli/kimi-council-replay.js";

beforeEach(() => {
  runHeadlessCouncilGateMock.mockReset();
});

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
          "--cmux-spawn-bin",
          "/opt/cmux-spawn",
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
      cmuxSpawnBin: "/opt/cmux-spawn",
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
  it("fails with a clear usage error when the source diff is missing", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");

    await expect(
      runKimiCouncilReplay({
        sourceCouncilDir,
        replayArtifactDir,
        workspace: "/repo",
        issueId: "SYMPH-689",
      }),
    ).rejects.toThrow("Source council diff not found");
  });

  it("names an invalid source council dir path", async () => {
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    const sourceCouncilDir = join(replayArtifactDir, "missing-source");

    await expect(
      runKimiCouncilReplay({
        sourceCouncilDir,
        replayArtifactDir,
        workspace: "/repo",
        issueId: "SYMPH-689",
      }),
    ).rejects.toThrow(sourceCouncilDir);
  });

  it("names malformed source structured JSON paths", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    const malformedPath = join(sourceCouncilDir, "opus.structured.json");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    await writeFile(malformedPath, "{not json");

    await expect(
      runKimiCouncilReplay({
        sourceCouncilDir,
        replayArtifactDir,
        workspace: "/repo",
        issueId: "SYMPH-689",
      }),
    ).rejects.toThrow(malformedPath);
  });

  it("runs a Kimi replay lane and writes comparison artifacts", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    await writeFile(
      join(sourceCouncilDir, "opus.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "opus",
          agent: "claude",
          role: "legacy-reviewer",
          modelFamily: "anthropic",
          mergeAuthoritative: true,
        },
        verdict: "fail",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: {
          path: join(sourceCouncilDir, "review-bundle.json"),
          hash: "b".repeat(64),
          bundleHash: "a".repeat(64),
          hashAlgorithm: "sha256",
        },
        findings: [
          {
            severity: "P1",
            fingerprint: "shared-blocker",
            leadDisposition: "open",
          },
          { severity: "P2", fingerprint: "opus-only", leadDisposition: "open" },
          {
            severity: "P1",
            fingerprint: "closed-source",
            leadDisposition: "refuted",
          },
          {
            severity: "P1",
            fingerprint: "dismissed-source",
            leadDisposition: "dismissed",
          },
          {
            severity: "P2",
            fingerprint: "track-disposition-source",
            leadDisposition: "track",
          },
          { severity: "Track", fingerprint: "source-track" },
        ],
      }),
    );
    await writeFile(
      join(sourceCouncilDir, "codex-high-lead.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "codex-high-lead",
          agent: "codex",
          role: "codex-lead-triage",
          modelFamily: "openai",
          mergeAuthoritative: true,
        },
        verdict: "fail",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: {
          path: join(sourceCouncilDir, "review-bundle.json"),
          hash: "b".repeat(64),
          bundleHash: "a".repeat(64),
          hashAlgorithm: "sha256",
        },
        findings: [
          {
            severity: "P1",
            fingerprint: "lead-only",
            leadDisposition: "open",
          },
        ],
      }),
    );
    await writeFile(
      join(sourceCouncilDir, "kimi-prior-shadow.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "kimi-k27-shadow",
          agent: "kimi",
          role: "kimi-k27-shadow-reviewer",
          modelFamily: "moonshot-kimi",
          mergeAuthoritative: false,
        },
        verdict: "fail",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: {
          path: join(sourceCouncilDir, "review-bundle.json"),
          hash: "b".repeat(64),
          bundleHash: "a".repeat(64),
          hashAlgorithm: "sha256",
        },
        findings: [
          {
            severity: "P2",
            fingerprint: "prior-shadow-only",
            leadDisposition: "open",
          },
        ],
      }),
    );
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [
        {
          agent: "kimi",
          structuredArtifactPath: join(
            replayArtifactDir,
            "kimi-k27-shadow.structured.json",
          ),
          structuredArtifact: {
            lane: {
              laneId: "kimi-k27-shadow",
              agent: "kimi",
              role: "kimi-k27-shadow-reviewer",
              modelFamily: "moonshot-kimi",
              mergeAuthoritative: false,
            },
            verdict: "fail",
            parseStatus: "synthesized_from_markdown",
            reviewBundle: {
              path: join(replayArtifactDir, "review-bundle.json"),
              hash: "b".repeat(64),
              bundleHash: "a".repeat(64),
              hashAlgorithm: "sha256",
            },
            findings: [
              {
                severity: "P1",
                fingerprint: "shared-blocker",
                leadDisposition: "open",
              },
              {
                severity: "P2",
                fingerprint: "kimi-only",
                leadDisposition: "open",
              },
              { severity: "Track", fingerprint: "kimi-track" },
            ],
          },
        },
      ],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

    const report = await runKimiCouncilReplay({
      sourceCouncilDir,
      replayArtifactDir,
      workspace: "/repo",
      issueId: "SYMPH-689",
      repo: "mobilyze-llc/symphony-ts",
      prNumber: 541,
      baseRef: "main",
      headRef: "feature",
      cmuxSpawnBin: "/opt/cmux-spawn",
      kimiBin: "/opt/kimi/bin/kimi",
      kimiModel: "kimi-test",
    });

    expect(runHeadlessCouncilGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "SYMPH-689",
        workspace: "/repo",
        artifactDir: replayArtifactDir,
        diffPath: join(sourceCouncilDir, "diff.patch"),
        codexLead: false,
        repo: "mobilyze-llc/symphony-ts",
        prNumber: 541,
        baseRef: "main",
        headRef: "feature",
        cmuxSpawnBin: "/opt/cmux-spawn",
        reviewerLanes: [
          {
            laneId: "kimi-k27-shadow",
            agent: "kimi",
            role: "kimi-k27-shadow-reviewer",
            model: "kimi-test",
            binary: "/opt/kimi/bin/kimi",
            independentReviewer: false,
            mergeAuthoritative: false,
          },
        ],
      }),
    );
    expect(report.scoring.artifactContract).toBe("complete");
    expect(report.scoring.blockerRecallAgainstUnion).toBe(0.5);
    expect(report.scoring.matchedBlockingFingerprints).toEqual([
      "shared-blocker",
    ]);
    expect(report.scoring.sourceBlockingFingerprints).toEqual([
      "opus-only",
      "shared-blocker",
    ]);
    expect(report.scoring.kimiOnlyBlockingFingerprints).toEqual(["kimi-only"]);
    expect(report.scoring.sourceBlockingFingerprints).not.toContain(
      "lead-only",
    );
    expect(report.scoring.sourceBlockingFingerprints).not.toContain(
      "prior-shadow-only",
    );
    expect(report.scoring.sourceBlockingFingerprints).not.toContain(
      "closed-source",
    );
    expect(report.scoring.sourceBlockingFingerprints).not.toContain(
      "dismissed-source",
    );
    expect(report.scoring.sourceBlockingFingerprints).not.toContain(
      "track-disposition-source",
    );
    expect(
      report.sourceLanes.find((lane) => lane.laneId === "codex-high-lead")
        ?.sourceRecallExclusionReason,
    ).toBe("lead_artifact");
    expect(
      report.sourceLanes.find((lane) => lane.laneId === "kimi-k27-shadow")
        ?.sourceRecallExclusionReason,
    ).toBe("prior_shadow_artifact");
    await expect(
      readFile(join(replayArtifactDir, "kimi-replay-comparison.json"), "utf-8"),
    ).resolves.toContain('"artifactContract": "complete"');
    await expect(
      readFile(join(replayArtifactDir, "kimi-replay-comparison.md"), "utf-8"),
    ).resolves.toContain("Kimi replay bundle hash match: yes");
  });

  it("reports non-default source bundle hash mismatches as unpinned fresh replay comparisons", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    const sourceRoundTwoBundleHash = "a".repeat(64);
    const freshReplayBundleHash = "b".repeat(64);
    const sourceReviewBundlePath = join(sourceCouncilDir, "review-bundle.json");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    await writeFile(
      sourceReviewBundlePath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "symphony-headless-council-review-bundle",
        hashAlgorithm: "sha256",
        target: {
          issueId: "SYMPH-718",
          repo: "mobilyze-llc/symphony-ts",
          prNumber: 718,
          mode: "standard",
          routingMode: "targeted-convergence",
          round: 2,
        },
        refs: {
          baseRef: "main",
          headRef: "feature",
          baseSha: "0".repeat(40),
          headSha: "1".repeat(40),
          reviewedHeadSha: "1".repeat(40),
          previousReviewedHeadSha: "2".repeat(40),
        },
        scope: {
          changedPaths: ["x"],
        },
        targetedConvergence: null,
        diff: {
          path: join(sourceCouncilDir, "diff.patch"),
          sha256: "3".repeat(64),
          bytes: Buffer.byteLength("diff --git a/x b/x\n", "utf-8"),
        },
        gitStatus: "",
        provenance: [],
        optionalInputs: {
          promptPaths: [],
          evidenceDatasetPaths: [],
          riskContractArtifactPaths: [],
        },
        bundleHash: sourceRoundTwoBundleHash,
      }),
    );
    await writeFile(
      join(sourceCouncilDir, "opus.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "opus",
          agent: "claude",
          role: "legacy-reviewer",
          modelFamily: "anthropic",
          mergeAuthoritative: true,
        },
        verdict: "pass",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: {
          path: sourceReviewBundlePath,
          hash: "c".repeat(64),
          bundleHash: sourceRoundTwoBundleHash,
          hashAlgorithm: "sha256",
        },
        findings: [],
      }),
    );
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [
        {
          agent: "kimi",
          structuredArtifactPath: join(
            replayArtifactDir,
            "kimi-k27-shadow.structured.json",
          ),
          structuredArtifact: {
            lane: {
              laneId: "kimi-k27-shadow",
              agent: "kimi",
              role: "kimi-k27-shadow-reviewer",
              modelFamily: "moonshot-kimi",
              mergeAuthoritative: false,
            },
            verdict: "pass",
            parseStatus: "synthesized_from_markdown",
            reviewBundle: {
              path: join(replayArtifactDir, "review-bundle.json"),
              hash: "d".repeat(64),
              bundleHash: freshReplayBundleHash,
              hashAlgorithm: "sha256",
            },
            findings: [],
          },
        },
      ],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

    const report = await runKimiCouncilReplay({
      sourceCouncilDir,
      replayArtifactDir,
      workspace: "/repo",
      issueId: "SYMPH-718",
    });

    const sourceReviewBundle = JSON.parse(
      await readFile(sourceReviewBundlePath, "utf-8"),
    ) as {
      target: { round: number; routingMode: string | null };
      refs: { previousReviewedHeadSha: string | null };
    };
    expect(sourceReviewBundle.target.round).toBe(2);
    expect(sourceReviewBundle.target.routingMode).toBe("targeted-convergence");
    expect(sourceReviewBundle.refs.previousReviewedHeadSha).toBe(
      "2".repeat(40),
    );
    expect(runHeadlessCouncilGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diffPath: join(sourceCouncilDir, "diff.patch"),
      }),
    );
    expect(report.scoring.artifactContract).toBe("complete");
    expect(report.frozenReviewBundle).toEqual({
      canonicalHash: sourceRoundTwoBundleHash,
      sourceHashStatus: "consistent",
      sourceHashes: [sourceRoundTwoBundleHash],
      kimiReplayBundleHash: freshReplayBundleHash,
      sourceInputsPinnedByKimiReplay: false,
      kimiReplayBundleHashMatchesSource: false,
      usedByKimiReplay: false,
    });

    const jsonReport = JSON.parse(
      await readFile(
        join(replayArtifactDir, "kimi-replay-comparison.json"),
        "utf-8",
      ),
    ) as ReturnType<typeof buildComparisonReport>;
    expect(jsonReport.frozenReviewBundle.sourceInputsPinnedByKimiReplay).toBe(
      false,
    );
    expect(
      jsonReport.frozenReviewBundle.kimiReplayBundleHashMatchesSource,
    ).toBe(false);
    const markdownReport = await readFile(
      join(replayArtifactDir, "kimi-replay-comparison.md"),
      "utf-8",
    );
    expect(markdownReport).toContain("Kimi replay bundle hash match: no");
    expect(markdownReport).toContain("source bundle inputs not pinned");
    expect(markdownReport).not.toContain(
      "Canonical frozen review bundle hash used",
    );
  });

  it("writes partial source bundle hash status to markdown", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    await writeFile(
      join(sourceCouncilDir, "opus.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "opus",
          agent: "claude",
          role: "legacy-reviewer",
          modelFamily: "anthropic",
          mergeAuthoritative: true,
        },
        verdict: "pass",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: {
          path: join(sourceCouncilDir, "review-bundle.json"),
          hash: "b".repeat(64),
          bundleHash: "a".repeat(64),
          hashAlgorithm: "sha256",
        },
        findings: [],
      }),
    );
    await writeFile(
      join(sourceCouncilDir, "gemini.structured.json"),
      JSON.stringify({
        lane: {
          laneId: "gemini",
          agent: "gemini",
          role: "legacy-reviewer",
          modelFamily: "google",
          mergeAuthoritative: true,
        },
        verdict: "pass",
        parseStatus: "synthesized_from_markdown",
        reviewBundle: null,
        findings: [],
      }),
    );
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [
        {
          agent: "kimi",
          structuredArtifact: {
            lane: {
              laneId: "kimi-k27-shadow",
              agent: "kimi",
              role: "kimi-k27-shadow-reviewer",
              modelFamily: "moonshot-kimi",
              mergeAuthoritative: false,
            },
            verdict: "pass",
            parseStatus: "synthesized_from_markdown",
            reviewBundle: {
              path: join(replayArtifactDir, "review-bundle.json"),
              hash: "b".repeat(64),
              bundleHash: "a".repeat(64),
              hashAlgorithm: "sha256",
            },
            findings: [],
          },
        },
      ],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

    const report = await runKimiCouncilReplay({
      sourceCouncilDir,
      replayArtifactDir,
      workspace: "/repo",
      issueId: "SYMPH-689",
    });

    expect(report.frozenReviewBundle.sourceHashStatus).toBe("partial");
    await expect(
      readFile(join(replayArtifactDir, "kimi-replay-comparison.md"), "utf-8"),
    ).resolves.toContain("source bundle hashes incomplete");
  });

  it("keeps default Kimi CLI config when replay overrides are omitted", async () => {
    const sourceCouncilDir = await makeTempDir("source-council-");
    const replayArtifactDir = await makeTempDir("kimi-replay-");
    await writeFile(
      join(sourceCouncilDir, "diff.patch"),
      "diff --git a/x b/x\n",
    );
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [{ agent: "kimi", structuredArtifact: null }],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

    const report = await runKimiCouncilReplay({
      sourceCouncilDir,
      replayArtifactDir,
      workspace: "/repo",
      issueId: "SYMPH-689",
    });

    expect(runHeadlessCouncilGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewerLanes: [
          {
            laneId: "kimi-k27-shadow",
            agent: "kimi",
            role: "kimi-k27-shadow-reviewer",
            independentReviewer: false,
            mergeAuthoritative: false,
          },
        ],
      }),
    );
    expect(report.scoring.artifactContract).toBe("missing");
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
    expect(runHeadlessCouncilGateMock).not.toHaveBeenCalled();
  });

  it("returns 0 when the Kimi artifact contract is complete", async () => {
    const { sourceCouncilDir, replayArtifactDir } = await writeReplaySource();
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [
        {
          agent: "kimi",
          structuredArtifactPath: join(
            replayArtifactDir,
            "kimi-k27-shadow.structured.json",
          ),
          structuredArtifact: {
            lane: {
              laneId: "kimi-k27-shadow",
              agent: "kimi",
              role: "kimi-k27-shadow-reviewer",
              modelFamily: "moonshot-kimi",
              mergeAuthoritative: false,
            },
            verdict: "pass",
            parseStatus: "synthesized_from_markdown",
            findings: [],
          },
        },
      ],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

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
          stdout: () => true,
          stderr: () => true,
        },
      ),
    ).resolves.toBe(0);
  });

  it("returns 1 when the Kimi artifact contract is missing", async () => {
    const { sourceCouncilDir, replayArtifactDir } = await writeReplaySource();
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [{ agent: "kimi", structuredArtifact: null }],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

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
          stdout: () => true,
          stderr: () => true,
        },
      ),
    ).resolves.toBe(1);
  });

  it("returns 1 when the Kimi artifact contract is malformed", async () => {
    const { sourceCouncilDir, replayArtifactDir } = await writeReplaySource();
    runHeadlessCouncilGateMock.mockResolvedValue({
      lanes: [
        {
          agent: "kimi",
          structuredArtifactPath: join(
            replayArtifactDir,
            "kimi-k27-shadow.structured.json",
          ),
          structuredArtifact: {
            lane: {
              laneId: "kimi-k27-shadow",
              agent: "kimi",
              role: "kimi-k27-shadow-reviewer",
              modelFamily: "moonshot-kimi",
              mergeAuthoritative: false,
            },
            verdict: "error",
            parseStatus: "malformed",
            findings: [],
          },
        },
      ],
      artifactPaths: {
        resultJson: join(replayArtifactDir, "review-result.json"),
      },
    });

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
          stdout: () => true,
          stderr: () => true,
        },
      ),
    ).resolves.toBe(1);
  });
});
