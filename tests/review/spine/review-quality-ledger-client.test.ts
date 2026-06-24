import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ReviewQualityLedgerClient,
  type RqlCommandResult,
  type RqlCommandRunner,
  RqlUnavailableError,
} from "../../../src/review/spine/review-quality-ledger-client.js";
import {
  RQL_RECORD_RESULT_SCHEMA,
  RQL_SUMMARY_SCHEMA,
} from "../../../src/review/spine/review-quality-ledger-schemas.js";

/**
 * SYMPH-924 — unit tests for the fail-closed review-quality-ledger client. Uses an
 * injected runner so no crucible checkout is required; the live-conformance test
 * (review-quality-ledger-conformance.test.ts) exercises the real script when present.
 */

function recordResult(over: Record<string, unknown> = {}) {
  return {
    schema: RQL_RECORD_RESULT_SCHEMA,
    ledger_file: "/tmp/ledger.jsonl",
    ledger_source: "explicit",
    dry_run: false,
    finding_count: 1,
    appended: 1,
    deduped: 0,
    classification_counts: { P1: 1 },
    ...over,
  };
}

function summaryResult(over: Record<string, unknown> = {}) {
  return {
    schema: RQL_SUMMARY_SCHEMA,
    generated_at: "2026-06-24T00:00:00.000Z",
    totals: {
      rows: 2,
      distinct_findings: 1,
      confirmed_findings: 1,
      by_classification: { P1: 1 },
      by_source: { model: 1 },
    },
    per_model: [
      {
        model: "codex",
        raised: 1,
        confirmed: 1,
        track: 0,
        dismissed: 0,
        p1: 1,
        p2: 0,
        unique_confirmed: 0,
        unique_raised: 0,
        precision: 1,
        unique_recall: 0,
      },
    ],
    ledger_file: "/tmp/ledger.jsonl",
    ledger_source: "explicit",
    ...over,
  };
}

/**
 * Capture the last argv the runner received so we can assert the seam contract. The
 * runner ALSO snapshots every `--review-file` content while the temp files still
 * exist (the client cleans its temp dir up after the call returns).
 */
function capturingRunner(output: unknown): {
  runner: RqlCommandRunner;
  calls: string[][];
  reviewFileContents: string[];
} {
  const calls: string[][] = [];
  const reviewFileContents: string[] = [];
  const runner: RqlCommandRunner = async (argv): Promise<RqlCommandResult> => {
    const list = [...argv];
    calls.push(list);
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === "--review-file") {
        const file = list[i + 1];
        if (file !== undefined) {
          reviewFileContents.push(readFileSync(file, "utf8"));
        }
      }
    }
    return { stdout: JSON.stringify(output), stderr: "", exitCode: 0 };
  };
  return { runner, calls, reviewFileContents };
}

const lanes = [
  {
    reviewer: "codex",
    markdown:
      "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- [P1] src/auth.ts:42 — missing null check",
  },
  {
    reviewer: "deepseek",
    markdown:
      "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- [P1] src/auth.ts:42 — token can be undefined",
  },
];

const triage = {
  schema: "crucible.session-orchestrator.council-triage.v1",
  escalate: [{ fp: "src/auth.ts::abc", reviewer: "codex" }],
  track: [],
};

describe("ReviewQualityLedgerClient.record", () => {
  it("builds the record argv with per-lane review-file/reviewer pairs and the triage file", async () => {
    const { runner, calls, reviewFileContents } = capturingRunner(
      recordResult(),
    );
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      ledgerFile: "/tmp/ledger.jsonl",
      runCommand: runner,
    });

    const result = await client.record({
      triage,
      laneArtifacts: lanes,
      blockingFps: ["src/auth.ts::abc"],
      crossExamVerdicts: [{ fp: "src/auth.ts::abc", verdict: "CONFIRM" }],
      runId: "run1",
      pr: "owner/repo#1",
      headSha: "deadbeef",
      round: 2,
    });

    expect(result.schema).toBe(RQL_RECORD_RESULT_SCHEMA);
    expect(result.appended).toBe(1);

    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv[0]).toBe("/fake/rql.mjs");
    expect(argv[1]).toBe("record");

    // Both reviewer lanes are threaded so the ledger can recover raised_by PRE-dedup.
    const reviewerFlags = argv.filter((a) => a === "--reviewer");
    expect(reviewerFlags).toHaveLength(2);
    const reviewerNames = argv
      .map((a, i) => (a === "--reviewer" ? argv[i + 1] : undefined))
      .filter((a): a is string => a !== undefined);
    expect(reviewerNames).toEqual(["codex", "deepseek"]);

    // Each --review-file points at a real temp file containing that lane's markdown
    // (snapshotted by the runner before the client cleaned up its temp dir).
    expect(reviewFileContents).toHaveLength(2);
    expect(reviewFileContents[0]).toContain("missing null check");
    expect(reviewFileContents[1]).toContain("token can be undefined");

    expect(argv).toContain("--blocking-fps");
    expect(argv[argv.indexOf("--blocking-fps") + 1]).toBe("src/auth.ts::abc");
    expect(argv).toContain("--cross-exam-file");
    expect(argv).toContain("--ledger");
    expect(argv[argv.indexOf("--ledger") + 1]).toBe("/tmp/ledger.jsonl");
    expect(argv[argv.indexOf("--run-id") + 1]).toBe("run1");
    expect(argv[argv.indexOf("--pr") + 1]).toBe("owner/repo#1");
    expect(argv[argv.indexOf("--head-sha") + 1]).toBe("deadbeef");
    expect(argv[argv.indexOf("--round") + 1]).toBe("2");
  });

  it("omits --blocking-fps when nothing blocked this round", async () => {
    const { runner, calls } = capturingRunner(
      recordResult({ classification_counts: { Track: 1 } }),
    );
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: runner,
    });

    await client.record({
      triage,
      laneArtifacts: lanes,
      blockingFps: [],
    });

    const argv = calls[0] ?? [];
    expect(argv).not.toContain("--blocking-fps");
    expect(argv).not.toContain("--cross-exam-file");
  });

  it("prefers config env overrides for the script and ledger paths", async () => {
    const { runner, calls } = capturingRunner(recordResult());
    const client = new ReviewQualityLedgerClient({
      env: {
        SYMPHONY_REVIEW_QUALITY_LEDGER_PATH: "/env/rql.mjs",
        SYMPHONY_REVIEW_QUALITY_LEDGER: "/env/ledger.jsonl",
      } as NodeJS.ProcessEnv,
      runCommand: runner,
    });

    await client.record({ triage, laneArtifacts: lanes, blockingFps: [] });

    const argv = calls[0] ?? [];
    expect(argv[0]).toBe("/env/rql.mjs");
    expect(argv[argv.indexOf("--ledger") + 1]).toBe("/env/ledger.jsonl");
  });

  it("throws RqlUnavailableError on a non-zero exit", async () => {
    const runner: RqlCommandRunner = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: runner,
    });

    await expect(
      client.record({ triage, laneArtifacts: lanes, blockingFps: [] }),
    ).rejects.toBeInstanceOf(RqlUnavailableError);
  });

  it("throws RqlUnavailableError on a schema mismatch (contract drift)", async () => {
    const runner: RqlCommandRunner = async () => ({
      stdout: JSON.stringify({ schema: "wrong.schema.v1" }),
      stderr: "",
      exitCode: 0,
    });
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: runner,
    });

    await expect(
      client.record({ triage, laneArtifacts: lanes, blockingFps: [] }),
    ).rejects.toBeInstanceOf(RqlUnavailableError);
  });

  it("throws RqlUnavailableError when the spawn itself fails", async () => {
    const runner: RqlCommandRunner = async () => {
      throw new Error("ENOENT");
    };
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: runner,
    });

    await expect(
      client.record({ triage, laneArtifacts: lanes, blockingFps: [] }),
    ).rejects.toBeInstanceOf(RqlUnavailableError);
  });
});

describe("ReviewQualityLedgerClient.summary", () => {
  it("queries per-lane precision and unique-recall over the corpus", async () => {
    const { runner, calls } = capturingRunner(summaryResult());
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      ledgerFile: "/tmp/ledger.jsonl",
      runCommand: runner,
    });

    const summary = await client.summary({
      since: "30d",
      pr: ["owner/repo#1"],
    });

    expect(summary.schema).toBe(RQL_SUMMARY_SCHEMA);
    expect(summary.per_model[0]?.model).toBe("codex");
    expect(summary.per_model[0]?.precision).toBe(1);
    expect(summary.per_model[0]?.unique_recall).toBe(0);

    const argv = calls[0] ?? [];
    expect(argv[1]).toBe("summary");
    expect(argv).toContain("--format");
    expect(argv[argv.indexOf("--format") + 1]).toBe("json");
    expect(argv[argv.indexOf("--since") + 1]).toBe("30d");
    expect(argv[argv.indexOf("--pr") + 1]).toBe("owner/repo#1");
  });
});
