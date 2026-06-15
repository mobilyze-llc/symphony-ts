import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
        modelFamily: "moonshot-kimi",
        verdict: "fail",
        parseStatus: "malformed",
        blockingFingerprints: [],
        trackFingerprints: [],
        artifactPath: "/tmp/kimi-replay/kimi-k27-shadow.structured.json",
      },
      gateResultPath: "/tmp/kimi-replay/review-result.json",
      markdownReportPath: "/tmp/kimi-replay/kimi-replay-comparison.md",
    });

    expect(report.scoring.artifactContract).toBe("malformed");
  });

  it("scores blocker recall and classifies missing Kimi artifacts", () => {
    const report = buildComparisonReport({
      issueId: "SYMPH-689",
      sourceCouncilDir: "/tmp/source-council",
      replayArtifactDir: "/tmp/kimi-replay",
      sourceLanes: [
        {
          laneId: "opus",
          agent: "claude",
          modelFamily: "anthropic",
          verdict: "fail",
          parseStatus: "parsed",
          blockingFingerprints: ["b", "a"],
          trackFingerprints: ["t"],
          artifactPath: "/tmp/source-council/opus.structured.json",
        },
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
});

describe("runKimiCouncilReplay", () => {
  it("fails with a clear usage error when the source diff is missing", async () => {
    const sourceCouncilDir = await mkdtemp(join(tmpdir(), "source-council-"));
    const replayArtifactDir = await mkdtemp(join(tmpdir(), "kimi-replay-"));

    await expect(
      runKimiCouncilReplay({
        sourceCouncilDir,
        replayArtifactDir,
        workspace: "/repo",
        issueId: "SYMPH-689",
      }),
    ).rejects.toThrow("Source council diff not found");
  });

  it("runs a Kimi replay lane and writes comparison artifacts", async () => {
    const sourceCouncilDir = await mkdtemp(join(tmpdir(), "source-council-"));
    const replayArtifactDir = await mkdtemp(join(tmpdir(), "kimi-replay-"));
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
          modelFamily: "anthropic",
        },
        verdict: "fail",
        parseStatus: "parsed",
        findings: [
          { severity: "P1", fingerprint: "shared-blocker" },
          { severity: "P2", fingerprint: "opus-only" },
          { severity: "Track", fingerprint: "source-track" },
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
              modelFamily: "moonshot-kimi",
            },
            verdict: "fail",
            parseStatus: "parsed",
            findings: [
              { severity: "P1", fingerprint: "shared-blocker" },
              { severity: "P2", fingerprint: "kimi-only" },
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
    expect(report.scoring.kimiOnlyBlockingFingerprints).toEqual(["kimi-only"]);
    await expect(
      readFile(join(replayArtifactDir, "kimi-replay-comparison.json"), "utf-8"),
    ).resolves.toContain('"artifactContract": "complete"');
    await expect(
      readFile(join(replayArtifactDir, "kimi-replay-comparison.md"), "utf-8"),
    ).resolves.toContain("Kimi Council Replay Comparison");
  });

  it("keeps default Kimi CLI config when replay overrides are omitted", async () => {
    const sourceCouncilDir = await mkdtemp(join(tmpdir(), "source-council-"));
    const replayArtifactDir = await mkdtemp(join(tmpdir(), "kimi-replay-"));
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
});
