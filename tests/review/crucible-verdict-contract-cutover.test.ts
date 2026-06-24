import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type HeadlessReviewerLaneConfig,
  type ReviewContext,
  synthesizeStructuredReviewerArtifactRecord,
} from "../../src/review/headless-council-gate.js";
import { CrabboxSpineClient } from "../../src/review/spine/crabbox-spine-client.js";

/**
 * SYMPH-908 — verdict-contract cutover gate.
 *
 * Crucible's MOB-348 reviewer-artifact contract is the single binding source, and
 * crucible's council-triage is the parser of record. Two invariants must hold after
 * the cutover:
 *
 *  1. A Symphony-prompted reviewer artifact (already emitting crucible's
 *     {PASS, CHANGES_REQUESTED, BLOCKED} vocabulary) parses `clean` — NOT `partial`
 *     — through the live spine's `council-triage`.
 *  2. A legacy `FINDINGS` artifact is normalized to `CHANGES_REQUESTED` by Symphony
 *     BEFORE it reaches council-triage, so the spine never downgrades it to
 *     `parse_quality: partial` / `fail_open` (the operator-misleading defect). It is
 *     never silently degraded.
 *
 * The live-spine portion is gated on the crucible checkout existing, like
 * `crucible-spine-conformance.test.ts`; the normalization assertions run everywhere.
 */

const FIXTURE_DIR = "tests/fixtures/review-crucible-contract";
const LIVE_SPINE_PATH =
  process.env.SYMPHONY_REVIEW_SPINE_PATH ??
  join(
    homedir(),
    "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
  );

function fixture(name: string): string {
  return join(FIXTURE_DIR, name);
}

async function readFixture(name: string): Promise<string> {
  return readFile(fixture(name), "utf8");
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
    issueId: "SYMPH-908",
    repo: "symphony-ts",
    prNumber: null,
    baseRef: "main",
    headRef: "HEAD",
    baseSha: "base-sha",
    headSha: "head-sha",
    diff: "diff --git a/file.ts b/file.ts\n+changed\n",
  };
}

/**
 * Synthesize a structured record from a fixture and return both the record and the
 * persisted on-disk markdown artifact (which is exactly what council-triage reads).
 */
async function synthesizeFixture(fixtureName: string): Promise<{
  verdict: string;
  persistedMarkdown: string;
  markdownPath: string;
}> {
  const artifactDir = await mkdtemp(join(tmpdir(), "symph-908-cutover-"));
  const markdownPath = join(artifactDir, fixtureName);
  const artifact = await readFixture(fixtureName);
  // The reviewer lane's markdown is already on disk at `artifactPath` (cmux wrote
  // it) before the gate synthesizes the structured record; mirror that so the
  // persisted-on-disk artifact reflects either an in-place rewrite or the unchanged
  // original (the no-change path does not re-write the file).
  await writeFile(markdownPath, artifact, "utf8");
  const record = await synthesizeStructuredReviewerArtifactRecord({
    context: reviewContext(),
    lane: lane(),
    artifactPath: markdownPath,
    artifact,
    structuredArtifactPath: join(artifactDir, `${fixtureName}.json`),
    reviewBundle: null,
    mode: "full",
    routingMode: "legacy",
    round: 1,
  });
  return {
    verdict: record.verdict,
    persistedMarkdown: await readFile(markdownPath, "utf8"),
    markdownPath,
  };
}

describe("SYMPH-908 verdict-contract cutover (normalization, spine-independent)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a legacy FINDINGS artifact to CHANGES_REQUESTED on disk before council-triage (never silently degraded)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { verdict, persistedMarkdown } =
      await synthesizeFixture("legacy-findings.md");

    // The legacy FINDINGS + P1 finding is a real blocking review outcome — a FAIL,
    // not a silent pass and not a degraded substrate condition.
    expect(verdict).toBe("fail");
    // The persisted artifact (what the spine reads) carries crucible's contract token.
    expect(persistedMarkdown).toContain("## Verdict\nCHANGES_REQUESTED");
    // The verdict LINE no longer carries the legacy token (the finding prose may).
    expect(persistedMarkdown).not.toContain("## Verdict\nFINDINGS");
    // The deprecation-window warning fires so operators see the legacy emission.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("legacy reviewer verdict token `FINDINGS`"),
    );
  });

  it("leaves a Symphony-prompted CHANGES_REQUESTED artifact unchanged (no spurious normalization)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { verdict, persistedMarkdown } = await synthesizeFixture(
      "changes-requested-p1.md",
    );

    expect(verdict).toBe("fail");
    expect(persistedMarkdown).toContain("## Verdict\nCHANGES_REQUESTED");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe.skipIf(!existsSync(LIVE_SPINE_PATH))(
  "SYMPH-908 verdict-contract cutover (live crucible spine)",
  () => {
    const client = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
    const dirs: string[] = [];

    afterEach(async () => {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir !== undefined) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    });

    it("a Symphony-prompted reviewer artifact parses clean (not partial) through council-triage", async () => {
      const triage = await client.councilTriage({
        reviews: [
          { file: fixture("changes-requested-p1.md"), reviewer: "codex" },
        ],
      });

      expect(triage.lanes[0]?.parse_quality).toBe("clean");
      expect(triage.lanes[0]?.verdict).toBe("CHANGES_REQUESTED");
      expect(triage.lanes[0]?.fail_open).toBe(false);
      expect(triage.summary.partial_lanes).toBe(0);
      expect(triage.escalate).toHaveLength(1);
    });

    it("a raw legacy FINDINGS artifact degrades to partial/fail_open in the spine — proving why Symphony must normalize", async () => {
      // This pins crucible's documented behavior: an unrecognized verdict token is a
      // partial parse the spine fails open on. It is the exact defect SYMPH-908's
      // normalization prevents (next test).
      const triage = await client.councilTriage({
        reviews: [{ file: fixture("legacy-findings.md"), reviewer: "codex" }],
      });

      expect(triage.lanes[0]?.parse_quality).toBe("partial");
      expect(triage.lanes[0]?.fail_open).toBe(true);
    });

    it("the Symphony-normalized legacy artifact parses clean as CHANGES_REQUESTED through council-triage", async () => {
      const { persistedMarkdown, markdownPath } =
        await synthesizeFixture("legacy-findings.md");
      // The persisted artifact lives in the synthesize temp dir; track its dir for
      // cleanup and feed the spine the normalized file directly.
      dirs.push(dirname(markdownPath));
      expect(persistedMarkdown).toContain("## Verdict\nCHANGES_REQUESTED");

      const triage = await client.councilTriage({
        reviews: [{ file: markdownPath, reviewer: "codex" }],
      });

      expect(triage.lanes[0]?.parse_quality).toBe("clean");
      expect(triage.lanes[0]?.verdict).toBe("CHANGES_REQUESTED");
      expect(triage.lanes[0]?.fail_open).toBe(false);
      expect(triage.summary.partial_lanes).toBe(0);
      expect(triage.escalate).toHaveLength(1);
    });
  },
);
