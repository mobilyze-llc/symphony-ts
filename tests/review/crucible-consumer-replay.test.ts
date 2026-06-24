import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type ReviewTrackFinding,
  type ReviewTrackFindingFiler,
  computeTrackFiling,
  resolveTrackFindingFilings,
} from "../../src/review/review-track-findings.js";
import {
  CrabboxSpineClient,
  SpineUnavailableError,
} from "../../src/review/spine/crabbox-spine-client.js";
import { ReviewAggregator } from "../../src/review/spine/review-aggregator.js";
import type { TriageFinding } from "../../src/review/spine/schemas.js";

/**
 * SYMPH-915 Phase B — consumer-replay runner (the cutover gate).
 *
 * Feeds the corpus v0 fixtures through Symphony's spine client + deterministic
 * `ReviewAggregator` (SYMPH-908 PR-1/PR-2) with ZERO model calls, and asserts the
 * consumer maps verdicts and buckets severities correctly — the green gate that must
 * pass before any real ticket runs through the pipeline. No judge is supplied, so the
 * aggregator is exercised in its fail-closed default (every escalation blocks).
 *
 * Live-spine gated like the Phase A conformance runner; the fail-closed-on-missing-
 * spine case runs everywhere (it needs no spine).
 */

const FIXTURE_DIR = "tests/fixtures/review-crucible-contract";
const LIVE_SPINE_PATH =
  process.env.SYMPHONY_REVIEW_SPINE_PATH ??
  join(
    homedir(),
    "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
  );

async function lane(
  fixtureName: string,
  reviewer: string,
): Promise<{ reviewer: string; markdown: string }> {
  return {
    reviewer,
    markdown: await readFile(join(FIXTURE_DIR, fixtureName), "utf8"),
  };
}

/** Map an aggregator Track finding into the council's Track-filing shape. */
function asTrackFinding(finding: TriageFinding): ReviewTrackFinding {
  return {
    fingerprint: finding.fp,
    severity: "Track",
    title: finding.summary,
    leadDisposition: "track",
  };
}

describe.skipIf(!existsSync(LIVE_SPINE_PATH))(
  "crucible consumer replay (live spine) — cutover gate",
  () => {
    const aggregator = new ReviewAggregator(
      new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH }),
    );

    it("maps CHANGES_REQUESTED to a failing verdict with the P1 escalated, not malformed", async () => {
      const result = await aggregator.aggregate({
        laneArtifacts: [await lane("changes-requested-p1.md", "codex")],
        currentDiffHash: "head-cr-0001",
      });

      expect(result.verdict).toBe("fail");
      expect(result.blockingFindings).toHaveLength(1);
      expect(result.blockingFindings[0]?.severity).toBe("P1");
      expect(result.blockingFindings[0]?.location).toBe(
        "src/review/headless-council-gate.ts:5631",
      );
      // Preserved spine fingerprint shape `<location>::<hex>`, never a malformed_artifact.
      expect(result.blockingFindings[0]?.fp).toMatch(
        /^src\/review\/headless-council-gate\.ts::[0-9a-f]+$/,
      );
      expect(result.trackFindings).toHaveLength(0);
    });

    it("maps BLOCKED to a failing verdict (never a silent pass)", async () => {
      const result = await aggregator.aggregate({
        laneArtifacts: [await lane("blocked.md", "codex")],
        currentDiffHash: "head-blocked-0001",
      });

      expect(result.verdict).toBe("fail");
      expect(result.blockingFindings).toHaveLength(1);
    });

    it("a short preamble before ## Verdict still fails closed, never a silent pass", async () => {
      const result = await aggregator.aggregate({
        laneArtifacts: [await lane("preamble-prefixed.md", "deepseek")],
        currentDiffHash: "head-preamble-0001",
      });

      expect(result.verdict).toBe("fail");
      expect(result.blockingFindings).toHaveLength(1);
      expect(result.blockingFindings[0]?.severity).toBe("P1");
    });

    it("passes a clean PASS lane with no blocking and no track findings", async () => {
      const result = await aggregator.aggregate({
        laneArtifacts: [await lane("pass.md", "codex")],
        currentDiffHash: "head-pass-0001",
      });

      expect(result.verdict).toBe("pass");
      expect(result.blockingFindings).toHaveLength(0);
      expect(result.trackFindings).toHaveLength(0);
    });

    it("surfaces a track-only finding without blocking and files it through the Track->Linear filer", async () => {
      const result = await aggregator.aggregate({
        laneArtifacts: [await lane("track-only.md", "deepseek")],
        currentDiffHash: "head-track-0001",
      });

      expect(result.verdict).toBe("pass");
      expect(result.blockingFindings).toHaveLength(0);
      expect(result.trackFindings).toHaveLength(1);

      // The aggregator only surfaces Track findings; filing them to Linear is a
      // downstream concern. Exercise the real filing-record path with a mocked filer
      // (no Linear): the filer must be invoked with the surviving Track finding, and
      // its durable ref must reduce to a "filed" record.
      const trackFindings = result.trackFindings.map(asTrackFinding);
      const filer = vi.fn<ReviewTrackFindingFiler<ReviewTrackFinding>>(
        async (findings) =>
          findings.map((f) => ({
            fingerprint: f.fingerprint,
            issueId: "SYMPH-TRACK-1",
            url: "https://linear.app/mobilyze-llc/issue/SYMPH-TRACK-1",
          })),
      );

      const resolved = await resolveTrackFindingFilings(trackFindings, filer);
      const filing = computeTrackFiling(trackFindings, resolved);

      expect(filer).toHaveBeenCalledTimes(1);
      expect(filer.mock.calls[0]?.[0]?.[0]?.fingerprint).toBe(
        result.trackFindings[0]?.fp,
      );
      expect(filing.status).toBe("filed");
      expect(filing.required).toBe(1);
      expect(filing.filed).toBe(1);
    });

    it("buckets severities and preserves spine fingerprints end to end across lanes", async () => {
      const client = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
      const laneArtifacts = [
        await lane("changes-requested-p1.md", "codex"),
        await lane("track-only.md", "deepseek"),
      ];

      // Canonical fps straight from the spine, to prove the aggregator preserves them.
      const triage = await client.councilTriage({
        reviews: laneArtifacts.map((l, i) => ({
          file: join(
            FIXTURE_DIR,
            i === 0 ? "changes-requested-p1.md" : "track-only.md",
          ),
          reviewer: l.reviewer,
        })),
      });
      const escalateFp = triage.escalate[0]?.fp;
      const trackFp = triage.track[0]?.fp;

      const result = await new ReviewAggregator(client).aggregate({
        laneArtifacts,
        currentDiffHash: "head-bucketing-0001",
      });

      expect(result.verdict).toBe("fail");
      expect(result.blockingFindings).toHaveLength(1);
      expect(result.blockingFindings[0]?.severity).toBe("P1");
      expect(result.blockingFindings[0]?.fp).toBe(escalateFp);
      expect(result.trackFindings).toHaveLength(1);
      expect(result.trackFindings[0]?.fp).toBe(trackFp);
    });

    it("closes the unparseable-lane fail-open: an all-unparseable round is degraded, never a silent pass (SYMPH-926)", async () => {
      // A truly-unparseable artifact (no `## Verdict`) is NOT silently dropped by the
      // spine: the lane is marked `fail_open: true` and counted in
      // `summary.unparseable_lanes`, with no escalate/track findings. The standalone
      // ReviewAggregator USED to derive its verdict from escalate/track ONLY, so an
      // all-unparseable round yielded verdict "pass" — a fail-OPEN hole. SYMPH-926
      // closed it: the aggregator now reads the degradation signals and returns a
      // NON-PASS "degraded" verdict with `degradedLanes` populated. This test runs
      // the all-unparseable artifact through `aggregate()` end to end and asserts the
      // CLOSED behavior (the gap is now closed, not merely documented).
      const dir = await mkdtemp(join(tmpdir(), "crucible-replay-malformed-"));
      try {
        const file = join(dir, "malformed.md");
        await writeFile(
          file,
          "free-form prose with no verdict header\n",
          "utf8",
        );
        const client = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });

        // The raw degradation signal still exists (this is what the aggregator now
        // honors): the lane is unparseable + fail-open, producing no findings.
        const triage = await client.councilTriage({
          reviews: [{ file, reviewer: "deepseek" }],
        });
        expect(triage.lanes[0]?.parse_quality).toBe("unparseable");
        expect(triage.lanes[0]?.fail_open).toBe(true);
        expect(triage.summary.unparseable_lanes).toBe(1);
        expect(triage.escalate).toHaveLength(0);
        expect(triage.track).toHaveLength(0);

        // CLOSED behavior: the same all-unparseable round through the aggregator is
        // NON-PASS ("degraded"), never a silent "pass", with the degraded lane
        // surfaced for the gate/operator. No real blocker exists, so it is
        // "degraded" (couldn't review), not "fail" (real blocker).
        const result = await aggregator.aggregate({
          laneArtifacts: [
            { reviewer: "deepseek", markdown: await readFile(file, "utf8") },
          ],
          currentDiffHash: "head-unparseable-0001",
        });
        expect(result.verdict).toBe("degraded");
        expect(result.verdict).not.toBe("pass");
        expect(result.blockingFindings).toHaveLength(0);
        expect(result.degradedLaneCount).toBe(1);
        expect(result.degradedLanes).toHaveLength(1);
        expect(result.degradedLanes[0]?.reviewer).toBe("deepseek");
        expect(result.degradedLanes[0]?.parse_quality).toBe("unparseable");
        expect(result.degradedLanes[0]?.reason).toBe("fail_open");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  },
);

describe("crucible consumer replay — fail-closed substrate", () => {
  it("propagates SpineUnavailableError when the spine is missing (degraded, never a silent pass)", async () => {
    const aggregator = new ReviewAggregator(
      new CrabboxSpineClient({
        spinePath: "/nonexistent/symphony-spine-does-not-exist.mjs",
        timeoutMs: 10_000,
      }),
    );

    await expect(
      aggregator.aggregate({
        laneArtifacts: [
          {
            reviewer: "codex",
            markdown: "## Verdict\nPASS\n\n## Findings\nNone\n",
          },
        ],
        currentDiffHash: "head-missing-0001",
      }),
    ).rejects.toBeInstanceOf(SpineUnavailableError);
  });
});
