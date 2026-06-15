import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildComparisonReport,
  parseKimiCouncilReplayArgs,
  runKimiCouncilReplay,
} from "../../src/cli/kimi-council-replay.js";

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
});
