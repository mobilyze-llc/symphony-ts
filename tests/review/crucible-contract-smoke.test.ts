import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  type HeadlessReviewerLaneConfig,
  type ReviewContext,
  synthesizeStructuredReviewerArtifactRecord,
} from "../../src/review/headless-council-gate.js";

const FIXTURE_DIR = "tests/fixtures/review-crucible-contract";
const execFileAsync = promisify(execFile);

describe("crucible review contract smoke corpus v0", () => {
  it.each([
    ["pass.md", "pass", 0],
    ["changes-requested-p1.md", "fail", 1],
    ["blocked.md", "fail", 1],
    ["track-only.md", "pass", 1],
    ["preamble-prefixed.md", "fail", 1],
  ] as const)(
    "synthesizes %s without malformed artifact degradation",
    async (fixtureName, verdict, findingCount) => {
      const artifact = await readFixture(fixtureName);
      const artifactDir = await mkdtemp(join(tmpdir(), "crucible-contract-"));
      const structured = await synthesizeStructuredReviewerArtifactRecord({
        context: reviewContext(),
        lane: lane(),
        artifactPath: join(artifactDir, fixtureName),
        artifact,
        structuredArtifactPath: join(artifactDir, `${fixtureName}.json`),
        reviewBundle: null,
        mode: "full",
        routingMode: "legacy",
        round: 1,
      });

      expect(structured.verdict).toBe(verdict);
      expect(structured.parseStatus).toBe("synthesized_from_markdown");
      expect(structured.malformedReason).toBeNull();
      expect(structured.findings).toHaveLength(findingCount);
    },
  );

  it("documents that wording differences produce distinct local fingerprints", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "crucible-fp-"));
    const first = await synthesizeFixture(
      "wording-sensitive-a.md",
      artifactDir,
    );
    const second = await synthesizeFixture(
      "wording-sensitive-b.md",
      artifactDir,
    );

    expect(first.findings[0]?.evidence[0]).toMatchObject({
      path: "src/parser.ts",
      lineStart: 42,
    });
    expect(second.findings[0]?.evidence[0]).toMatchObject({
      path: "src/parser.ts",
      lineStart: 42,
    });
    expect(first.findings[0]?.fingerprint).not.toBe(
      second.findings[0]?.fingerprint,
    );
  });

  it.skipIf(process.env.CRUCIBLE_SPINE === undefined)(
    "runs the configured live crucible council-triage spine over corpus fixtures",
    async () => {
      const spine = process.env.CRUCIBLE_SPINE!;
      const { stdout } = await execFileAsync(process.execPath, [
        spine,
        "council-triage",
        "--review-file",
        join(FIXTURE_DIR, "changes-requested-p1.md"),
        "--reviewer",
        "codex",
        "--review-file",
        join(FIXTURE_DIR, "track-only.md"),
        "--reviewer",
        "deepseek",
      ]);
      const triage = JSON.parse(stdout) as {
        schema?: string;
        escalate?: unknown[];
        track?: unknown[];
      };

      expect(triage.schema).toBe(
        "crucible.session-orchestrator.council-triage.v1",
      );
      expect(triage.escalate?.length).toBeGreaterThan(0);
      expect(triage.track?.length).toBeGreaterThan(0);
    },
  );
});

async function synthesizeFixture(fixtureName: string, artifactDir: string) {
  return synthesizeStructuredReviewerArtifactRecord({
    context: reviewContext(),
    lane: lane(),
    artifactPath: join(artifactDir, fixtureName),
    artifact: await readFixture(fixtureName),
    structuredArtifactPath: join(artifactDir, `${fixtureName}.json`),
    reviewBundle: null,
    mode: "full",
    routingMode: "legacy",
    round: 1,
  });
}

async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), "utf8");
}

function lane(): HeadlessReviewerLaneConfig {
  return {
    laneId: "codex",
    agent: "codex",
    role: "codex-reviewer",
    model: "gpt-5.5",
    reasoningEffort: "high",
  };
}

function reviewContext(): ReviewContext {
  return {
    issueId: "SYMPH-915",
    repo: "symphony-ts",
    prNumber: null,
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    diff: "diff --git a/file.ts b/file.ts\n+changed\n",
  };
}
