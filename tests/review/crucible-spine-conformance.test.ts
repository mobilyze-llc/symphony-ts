import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CrabboxSpineClient } from "../../src/review/spine/crabbox-spine-client.js";
import {
  CONVERGENCE_DECISION_SCHEMA,
  COUNCIL_TRIAGE_SCHEMA,
  CROSS_EXAM_SELECT_SCHEMA,
} from "../../src/review/spine/schemas.js";

/**
 * SYMPH-915 Phase A — deterministic spine-conformance runner over corpus v0.
 *
 * Pipes the canned crucible-contract reviewer fixtures through the REAL crucible
 * spine subcommands (`council-triage`, `cross-exam-select`, `convergence-decision`)
 * via the SYMPH-908 `CrabboxSpineClient`, with ZERO model calls. Because the client
 * validates each subcommand's output against Symphony's pinned zod schemas, a green
 * run proves the live spine still conforms to the contract Symphony consumes — this
 * is the cheap drift detector that runs before any real ticket touches the pipeline.
 *
 * Skipped automatically when the crucible checkout is absent (e.g. CI); runs green on
 * the controller / local dev where the spine is present. Override the path with
 * SYMPHONY_REVIEW_SPINE_PATH.
 *
 * argv contract (verified live 2026-06-23): the spine rejects the literal string
 * "null". Unknown optionals (`--prior-diff-hash`, `--fix-size-lines`) are OMITTED,
 * never passed as null — the client enforces this and the cross-exam case below
 * exercises the omit path.
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

describe.skipIf(!existsSync(LIVE_SPINE_PATH))(
  "crucible spine conformance (live spine) — corpus v0",
  () => {
    const client = new CrabboxSpineClient({ spinePath: LIVE_SPINE_PATH });
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "crucible-spine-conformance-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it("council-triage emits schema v1 and buckets a P1 to escalate and a non-blocking finding to track", async () => {
      const triage = await client.councilTriage({
        reviews: [
          { file: fixture("changes-requested-p1.md"), reviewer: "codex" },
          { file: fixture("track-only.md"), reviewer: "deepseek" },
        ],
      });

      expect(triage.schema).toBe(COUNCIL_TRIAGE_SCHEMA);
      expect(triage.escalate).toHaveLength(1);
      expect(triage.escalate[0]?.severity).toBe("P1");
      expect(triage.escalate[0]?.reviewer).toBe("codex");
      expect(triage.track).toHaveLength(1);
      expect(triage.track[0]?.reviewer).toBe("deepseek");
      // The explicitly non-blocking finding must never appear in escalate.
      expect(triage.escalate.some((f) => f.reviewer === "deepseek")).toBe(
        false,
      );
    });

    it("BLOCKED escalates its finding and counts a blocked lane", async () => {
      const triage = await client.councilTriage({
        reviews: [{ file: fixture("blocked.md"), reviewer: "codex" }],
      });

      expect(triage.lanes[0]?.verdict).toBe("BLOCKED");
      expect(triage.summary.blocked_lanes).toBe(1);
      // A BLOCKED lane fails closed: its finding lands in escalate, not track.
      expect(triage.escalate).toHaveLength(1);
      expect(triage.track).toHaveLength(0);
    });

    it("clean PASS produces neither escalate nor track findings", async () => {
      const triage = await client.councilTriage({
        reviews: [{ file: fixture("pass.md"), reviewer: "codex" }],
      });

      expect(triage.lanes[0]?.verdict).toBe("PASS");
      expect(triage.escalate).toHaveLength(0);
      expect(triage.track).toHaveLength(0);
    });

    it("a short reviewer preamble before ## Verdict still parses cleanly", async () => {
      const triage = await client.councilTriage({
        reviews: [
          { file: fixture("preamble-prefixed.md"), reviewer: "deepseek" },
        ],
      });

      // The DeepSeek-tendency preamble must NOT degrade to an unparseable lane.
      expect(triage.lanes[0]?.parse_quality).toBe("clean");
      expect(triage.lanes[0]?.verdict).toBe("CHANGES_REQUESTED");
      expect(triage.summary.unparseable_lanes).toBe(0);
      expect(triage.escalate).toHaveLength(1);
    });

    it("cross-exam-select emits schema v1 and selects the escalated P1 (omit-not-null argv)", async () => {
      const triage = await client.councilTriage({
        reviews: [
          { file: fixture("changes-requested-p1.md"), reviewer: "codex" },
        ],
      });
      const triageFile = join(dir, "triage.json");
      await writeFile(triageFile, JSON.stringify(triage), "utf8");

      // priorDiffHash + fixSizeLines intentionally OMITTED — the spine rejects "null".
      const crossExam = await client.crossExamSelect({
        triageFile,
        currentDiffHash: "deadbeefcafe0001",
      });

      expect(crossExam.schema).toBe(CROSS_EXAM_SELECT_SCHEMA);
      expect(crossExam.cross_exam_required).toBe(true);
      expect(crossExam.target_count).toBe(1);
      expect(crossExam.targets[0]?.fp).toBe(triage.escalate[0]?.fp);
    });

    it("convergence-decision converges over two clean, cross-examined, frozen rounds", async () => {
      const roundsFile = join(dir, "rounds-converged.json");
      await writeFile(
        roundsFile,
        JSON.stringify([
          { diff_hash: "frozenhash", blocking: [], cross_examined: true },
          { diff_hash: "frozenhash", blocking: [], cross_examined: true },
        ]),
        "utf8",
      );

      const decision = await client.convergenceDecision({ roundsFile });

      expect(decision.schema).toBe(CONVERGENCE_DECISION_SCHEMA);
      expect(decision.state).toBe("converged");
    });

    it("convergence-decision escalates a fingerprint that survives K=3 fix attempts", async () => {
      const roundsFile = join(dir, "rounds-escalate.json");
      await writeFile(
        roundsFile,
        JSON.stringify([
          { diff_hash: "h1", blocking: [{ fp: "src/x.ts::deadbeef" }] },
          { diff_hash: "h2", blocking: [{ fp: "src/x.ts::deadbeef" }] },
          { diff_hash: "h3", blocking: [{ fp: "src/x.ts::deadbeef" }] },
        ]),
        "utf8",
      );

      const decision = await client.convergenceDecision({ roundsFile });

      expect(decision.state).toBe("escalate");
      expect(decision.fingerprints).toContain("src/x.ts::deadbeef");
    });

    it("documents fingerprint wording-sensitivity: same file:line, different summary -> distinct fp", async () => {
      const a = await client.councilTriage({
        reviews: [
          { file: fixture("wording-sensitive-a.md"), reviewer: "codex" },
        ],
      });
      const b = await client.councilTriage({
        reviews: [
          { file: fixture("wording-sensitive-b.md"), reviewer: "codex" },
        ],
      });

      expect(a.escalate[0]?.location).toBe("src/parser.ts:42");
      expect(b.escalate[0]?.location).toBe("src/parser.ts:42");
      // Identical location, different summary wording -> different fp. Across rounds
      // this is the over-escalation hazard the integration agent must expect.
      expect(a.escalate[0]?.fp).not.toBe(b.escalate[0]?.fp);
    });

    it("cross-lane triage groups same-location findings by location, mitigating single-round over-escalation", async () => {
      const triage = await client.councilTriage({
        reviews: [
          { file: fixture("wording-sensitive-a.md"), reviewer: "codex" },
          { file: fixture("wording-sensitive-b.md"), reviewer: "deepseek" },
        ],
      });

      // Despite distinct per-finding fps, the two lanes' same-location findings
      // collapse to ONE escalate target — cross-lane grouping is location-keyed, so
      // a single triage round does not over-escalate wording-divergent duplicates.
      expect(triage.escalate).toHaveLength(1);
      expect(triage.escalate[0]?.location).toBe("src/parser.ts:42");
    });
  },
);
