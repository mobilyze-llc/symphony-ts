import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CrabboxSpineClient } from "../../src/review/spine/crabbox-spine-client.js";
import { ReviewAggregator } from "../../src/review/spine/review-aggregator.js";
import { ReviewQualityLedgerClient } from "../../src/review/spine/review-quality-ledger-client.js";

/**
 * SYMPH-924 — live conformance for the review-quality ledger against crucible's REAL
 * `review-quality-ledger.mjs` (and the real council spine). Proves the consume-the-
 * seam decision end to end:
 *
 *   1. The aggregator's capture side-effect records a row joining raised_by →
 *      disposition → cross-exam verdict, keyed on the spine fp.
 *   2. raised_by is recovered PRE-DEDUP: two lanes raising the SAME file:line are
 *      collapsed by `council-triage` to a single `reviewer` tag, yet the ledger row's
 *      `raised_by` contains BOTH reviewers (recovered from the per-lane artifacts).
 *   3. `summary` yields per-lane precision and unique-recall over the corpus.
 *
 * Skipped automatically when the crucible checkout is absent (e.g. CI); runs green on
 * the controller / local dev where the scripts are present. Override the paths with
 * SYMPHONY_REVIEW_SPINE_PATH / SYMPHONY_REVIEW_QUALITY_LEDGER_PATH. Each run writes to
 * an isolated temp ledger (never crucible's shared corpus).
 */

const LIVE_SPINE_PATH =
  process.env.SYMPHONY_REVIEW_SPINE_PATH ??
  join(
    homedir(),
    "projects/crucible/skills/session-orchestrator/scripts/production-rollout.mjs",
  );
const LIVE_RQL_PATH =
  process.env.SYMPHONY_REVIEW_QUALITY_LEDGER_PATH ??
  join(
    homedir(),
    "projects/crucible/skills/session-orchestrator/scripts/review-quality-ledger.mjs",
  );

const BOTH_PRESENT = existsSync(LIVE_SPINE_PATH) && existsSync(LIVE_RQL_PATH);

// Two lanes raising the SAME file:line with DIFFERENT wording — council-triage
// collapses them to one escalate entry with a single `reviewer`, so this is the case
// that proves the pre-dedup raiser recovery.
const CODEX_LANE =
  "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- [P1] src/auth.ts:42 — missing null check on token";
const DEEPSEEK_LANE =
  "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- [P1] src/auth.ts:42 — token can be undefined here";

describe.skipIf(!BOTH_PRESENT)(
  "review-quality ledger conformance (live crucible RQL + spine)",
  () => {
    let dir: string;
    let ledgerFile: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "rql-conformance-"));
      ledgerFile = join(dir, "ledger.jsonl");
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it("captures a co-raised finding with BOTH reviewers in raised_by, then summarizes precision/unique-recall", async () => {
      const spine = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
      const ledger = new ReviewQualityLedgerClient({
        ledgerScriptPath: LIVE_RQL_PATH,
        ledgerFile,
      });
      const aggregator = new ReviewAggregator(spine);

      const errors: unknown[] = [];
      const review = await aggregator.aggregate({
        laneArtifacts: [
          { reviewer: "codex", markdown: CODEX_LANE },
          { reviewer: "deepseek", markdown: DEEPSEEK_LANE },
        ],
        currentDiffHash: "deadbeefcafe0001",
        ledger: {
          client: ledger,
          pr: "owner/repo#924",
          runId: "rql-conformance",
          round: 1,
          onError: (e) => errors.push(e),
        },
      });

      // No judge supplied → the escalated finding fails closed (blocking).
      expect(errors).toHaveLength(0);
      expect(review.verdict).toBe("fail");
      expect(review.blockingFindings).toHaveLength(1);

      const summary = await ledger.summary({ pr: ["owner/repo#924"] });

      // raised_by recovered PRE-dedup: both reviewers appear even though triage
      // collapsed the co-raised finding to a single reviewer tag.
      const models = summary.per_model.map((m) => m.model).sort();
      expect(models).toEqual(["codex", "deepseek"]);
      // Both raised the (single) confirmed P1, so each has precision 1 and — because
      // the finding was co-raised, not unique — unique-recall 0.
      for (const model of summary.per_model) {
        expect(model.raised).toBe(1);
        expect(model.confirmed).toBe(1);
        expect(model.precision).toBe(1);
        expect(model.unique_recall).toBe(0);
      }
      expect(summary.totals.confirmed_findings).toBe(1);
    });

    it("re-recording the same round is idempotent (no double-count)", async () => {
      const spine = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
      const ledger = new ReviewQualityLedgerClient({
        ledgerScriptPath: LIVE_RQL_PATH,
        ledgerFile,
      });
      const aggregator = new ReviewAggregator(spine);

      // Identical round to the first test — the ledger's row identity dedups it.
      await aggregator.aggregate({
        laneArtifacts: [
          { reviewer: "codex", markdown: CODEX_LANE },
          { reviewer: "deepseek", markdown: DEEPSEEK_LANE },
        ],
        currentDiffHash: "deadbeefcafe0001",
        ledger: {
          client: ledger,
          pr: "owner/repo#924",
          runId: "rql-conformance",
          round: 1,
        },
      });

      const summary = await ledger.summary({ pr: ["owner/repo#924"] });
      // Still exactly one distinct finding — the re-record was a no-op.
      expect(summary.totals.distinct_findings).toBe(1);
    });
  },
);
