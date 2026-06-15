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

  it("classifies every non-OK Kimi parse status as malformed", () => {
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
        parseStatus: "unexpected_status",
        artifactPath: "/tmp/kimi-replay/kimi-k27-shadow.structured.json",
      }),
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.artifactContract).toBe("malformed");
    expect(report.scoring.artifactContractReason).toContain(
      "unexpected_status",
    );
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

  it("reports whether the canonical frozen review bundle hash was used", () => {
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
      usedByKimiReplay: true,
    });
  });

  it("reports when Kimi used a different frozen review bundle hash", () => {
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
    ).resolves.toContain("Canonical frozen review bundle hash used: yes");
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
