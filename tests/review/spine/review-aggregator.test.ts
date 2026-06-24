import { describe, expect, it } from "vitest";

import {
  CrabboxSpineClient,
  type SpineCommandResult,
  type SpineCommandRunner,
} from "../../../src/review/spine/crabbox-spine-client.js";
import {
  type EscalateJudge,
  ReviewAggregator,
} from "../../../src/review/spine/review-aggregator.js";
import {
  ReviewQualityLedgerClient,
  type RqlRecordInput,
  RqlUnavailableError,
} from "../../../src/review/spine/review-quality-ledger-client.js";

function finding(over: Record<string, unknown> = {}) {
  return {
    severity: "P1",
    location: "src/x.ts:1",
    summary: "boom",
    evidence: "e",
    failure: "reachable",
    test: "missing",
    fp: "src/x.ts::abc",
    reviewer: "opus",
    ...over,
  };
}

function triage(over: Record<string, unknown> = {}) {
  return {
    schema: "crucible.session-orchestrator.council-triage.v1",
    lanes: [
      {
        reviewer: "opus",
        file: "a.md",
        verdict: "CHANGES_REQUESTED",
        parse_quality: "clean",
        finding_count: 1,
        none: false,
        fail_open: false,
      },
    ],
    summary: {
      lanes: 1,
      track: 0,
      escalate: 0,
      unparseable_lanes: 0,
      blocked_lanes: 0,
      partial_lanes: 0,
    },
    track: [],
    escalate: [],
    next_action: "no_blocking_findings_this_round",
    ...over,
  };
}

function crossExam(over: Record<string, unknown> = {}) {
  return {
    schema: "crucible.session-orchestrator.cross-exam-select.v1",
    cross_exam_required: false,
    reason: "none",
    fix_diff_changed: false,
    fix_size_lines: null,
    fix_trivial: null,
    parseable_lanes: 1,
    target_count: 0,
    targets: [],
    ...over,
  };
}

const CONVERGED = {
  schema: "crucible.session-orchestrator.convergence-decision.v1",
  input_rounds: 2,
  state: "converged",
  reason: "2 clean rounds",
  rounds: 2,
};

function aggregatorWith(outputs: {
  triage: unknown;
  crossExam: unknown;
  convergence?: unknown;
}): ReviewAggregator {
  const runner: SpineCommandRunner = async (
    argv,
  ): Promise<SpineCommandResult> => {
    const sub = argv[1];
    const pick =
      sub === "council-triage"
        ? outputs.triage
        : sub === "cross-exam-select"
          ? outputs.crossExam
          : outputs.convergence;
    return { stdout: JSON.stringify(pick), stderr: "", exitCode: 0 };
  };
  return new ReviewAggregator(new CrabboxSpineClient({ runCommand: runner }));
}

const lanes = [
  { reviewer: "opus", markdown: "## Verdict\nPASS\n\n## Findings\nNone" },
];

describe("ReviewAggregator", () => {
  it("passes a clean round and surfaces track findings without blocking", async () => {
    const agg = aggregatorWith({
      triage: triage({
        track: [finding({ severity: "Track" })],
        summary: { ...triage().summary, track: 1 },
      }),
      crossExam: crossExam(),
    });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
    });
    expect(result.verdict).toBe("pass");
    expect(result.trackFindings).toHaveLength(1);
    expect(result.blockingFindings).toHaveLength(0);
    expect(result.judgedTargetCount).toBe(0);
  });

  it("fails when the scoped judge confirms an escalated finding", async () => {
    const judge: EscalateJudge = async (targets) =>
      targets.map((t) => ({ fp: t.fp, real: true }));
    const agg = aggregatorWith({
      triage: triage({
        escalate: [finding()],
        summary: { ...triage().summary, escalate: 1 },
      }),
      crossExam: crossExam({
        cross_exam_required: true,
        target_count: 1,
        targets: [
          {
            fp: "src/x.ts::abc",
            severity: "P1",
            location: "src/x.ts:1",
            summary: "boom",
            reviewers: ["opus"],
            lane_count: 1,
            agreement: "single_lane",
          },
        ],
      }),
    });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge,
    });
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.judgedTargetCount).toBe(1);
  });

  it("passes when the scoped judge refutes the escalated finding", async () => {
    const judge: EscalateJudge = async (targets) =>
      targets.map((t) => ({ fp: t.fp, real: false }));
    const agg = aggregatorWith({
      triage: triage({
        escalate: [finding()],
        summary: { ...triage().summary, escalate: 1 },
      }),
      crossExam: crossExam({
        cross_exam_required: true,
        target_count: 1,
        targets: [
          {
            fp: "src/x.ts::abc",
            severity: "P1",
            location: "src/x.ts:1",
            summary: "boom",
            reviewers: ["opus"],
            lane_count: 1,
            agreement: "single_lane",
          },
        ],
      }),
    });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge,
    });
    expect(result.verdict).toBe("pass");
    expect(result.blockingFindings).toHaveLength(0);
    expect(result.refutedFindings).toHaveLength(1);
  });

  it("fails closed when escalations exist and no judge is supplied", async () => {
    const agg = aggregatorWith({
      triage: triage({
        escalate: [finding()],
        summary: { ...triage().summary, escalate: 1 },
      }),
      crossExam: crossExam({ cross_exam_required: true }),
    });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
    });
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.judgedTargetCount).toBe(0);
  });

  it("returns a convergence decision when round history is supplied", async () => {
    const agg = aggregatorWith({
      triage: triage(),
      crossExam: crossExam(),
      convergence: CONVERGED,
    });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "b",
      rounds: [
        { diffHash: "b", blocking: [], crossExamined: true },
        { diffHash: "b", blocking: [], crossExamined: true },
      ],
    });
    expect(result.convergence?.state).toBe("converged");
  });

  it("omits convergence when no round history is supplied", async () => {
    const agg = aggregatorWith({ triage: triage(), crossExam: crossExam() });
    const result = await agg.aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
    });
    expect(result.convergence).toBeNull();
  });
});

/**
 * SYMPH-924 — the ledger is DATA CAPTURE ONLY. These tests pin the crucible
 * determinism-boundary invariant: enabling, succeeding, or FAILING the ledger
 * capture must NEVER change the aggregator's verdict / convergence outcome. The
 * capture is a side-effect that the decision path never reads.
 */
describe("ReviewAggregator review-quality ledger capture (SYMPH-924)", () => {
  /** A ledger client whose injected runner records the record() calls it sees. */
  function recordingLedger(over: { fail?: boolean } = {}): {
    client: ReviewQualityLedgerClient;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      ledgerFile: "/tmp/ledger.jsonl",
      runCommand: async (argv) => {
        calls.push([...argv]);
        if (over.fail) {
          return { stdout: "", stderr: "ledger broke", exitCode: 1 };
        }
        return {
          stdout: JSON.stringify({
            schema: "crucible.review-quality-ledger.record-result.v1",
            ledger_file: "/tmp/ledger.jsonl",
            ledger_source: "explicit",
            dry_run: false,
            finding_count: 1,
            appended: 1,
            deduped: 0,
            classification_counts: { P1: 1 },
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    return { client, calls };
  }

  const escalatedTriage = triage({
    escalate: [finding()],
    summary: { ...triage().summary, escalate: 1 },
  });
  const escalatedCrossExam = crossExam({ cross_exam_required: true });

  it("does not change the verdict whether the ledger is enabled or disabled", async () => {
    const inputs = {
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    };

    const withoutLedger = await aggregatorWith(inputs).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
    });

    const { client } = recordingLedger();
    const withLedger = await aggregatorWith(inputs).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      ledger: { client, pr: "owner/repo#1", round: 1 },
    });

    // The ledger write is a side-effect; the decision is byte-for-byte identical.
    expect(withLedger.verdict).toBe(withoutLedger.verdict);
    expect(withLedger.verdict).toBe("fail");
    expect(withLedger.blockingFindings).toEqual(withoutLedger.blockingFindings);
    expect(withLedger.refutedFindings).toEqual(withoutLedger.refutedFindings);
    expect(withLedger.convergence).toEqual(withoutLedger.convergence);
  });

  it("does not change the verdict or throw when the ledger capture FAILS", async () => {
    const withoutLedger = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({ laneArtifacts: lanes, currentDiffHash: "head" });

    const errors: unknown[] = [];
    const { client } = recordingLedger({ fail: true });
    const withFailingLedger = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      ledger: {
        client,
        pr: "owner/repo#1",
        onError: (e) => errors.push(e),
      },
    });

    // Capture failed (swallowed) but the verdict is unchanged — never a thrown error.
    expect(withFailingLedger.verdict).toBe(withoutLedger.verdict);
    expect(withFailingLedger.verdict).toBe("fail");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RqlUnavailableError);
  });

  it("does not propagate a THROWING onError into the review decision", async () => {
    const baseline = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({ laneArtifacts: lanes, currentDiffHash: "head" });

    // A failing capture fires onError; this onError records then THROWS. The throw
    // must be swallowed so it can never re-enter and abort aggregate().
    let onErrorCalled = false;
    const { client } = recordingLedger({ fail: true });
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      ledger: {
        client,
        pr: "owner/repo#1",
        onError: () => {
          onErrorCalled = true;
          throw new Error("observability hook blew up");
        },
      },
    });

    // The throwing onError WAS invoked, yet aggregate() returned normally with the
    // verdict / blocking findings unchanged from the no-ledger baseline.
    expect(onErrorCalled).toBe(true);
    expect(result.verdict).toBe(baseline.verdict);
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings).toEqual(baseline.blockingFindings);
  });

  it("records the round with the triage, blocking fps, and PRE-dedup lane artifacts", async () => {
    const { client, calls } = recordingLedger();
    await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      ledger: { client, pr: "owner/repo#1", round: 1 },
    });

    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv[1]).toBe("record");
    // The per-lane artifact (its reviewer name) is threaded for raised_by recovery.
    expect(argv).toContain("--reviewer");
    expect(argv[argv.indexOf("--reviewer") + 1]).toBe("opus");
    // The default-blocked escalated finding's fp is recorded as confirmed-blocking.
    expect(argv).toContain("--blocking-fps");
    expect(argv[argv.indexOf("--blocking-fps") + 1]).toBe("src/x.ts::abc");
    expect(argv[argv.indexOf("--pr") + 1]).toBe("owner/repo#1");
    expect(argv[argv.indexOf("--round") + 1]).toBe("1");
  });

  it("captures CONFIRM/REFUTE cross-exam verdicts when a judge ran", async () => {
    const judge: EscalateJudge = async (targets) =>
      targets.map((t) => ({ fp: t.fp, real: t.fp.endsWith("real") }));
    const escalateTwo = triage({
      escalate: [
        finding({ fp: "src/a.ts::real" }),
        finding({ fp: "src/b.ts::fake" }),
      ],
      summary: { ...triage().summary, escalate: 2 },
    });
    const crossExamTwo = crossExam({
      cross_exam_required: true,
      target_count: 2,
      targets: [
        {
          fp: "src/a.ts::real",
          severity: "P1",
          location: "src/a.ts:1",
          summary: "boom",
          reviewers: ["opus"],
          lane_count: 1,
          agreement: "single_lane",
        },
        {
          fp: "src/b.ts::fake",
          severity: "P1",
          location: "src/b.ts:1",
          summary: "boom",
          reviewers: ["opus"],
          lane_count: 1,
          agreement: "single_lane",
        },
      ],
    });

    let captured: RqlRecordInput | undefined;
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: async () => ({
        stdout: JSON.stringify({
          schema: "crucible.review-quality-ledger.record-result.v1",
          ledger_file: "/tmp/ledger.jsonl",
          ledger_source: "explicit",
          dry_run: false,
          finding_count: 2,
          appended: 2,
          deduped: 0,
          classification_counts: { P1: 1, Dismissed: 1 },
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const originalRecord = client.record.bind(client);
    client.record = (input: RqlRecordInput) => {
      captured = input;
      return originalRecord(input);
    };

    const result = await aggregatorWith({
      triage: escalateTwo,
      crossExam: crossExamTwo,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge,
      ledger: { client },
    });

    expect(result.blockingFindings.map((f) => f.fp)).toEqual([
      "src/a.ts::real",
    ]);
    expect(result.refutedFindings.map((f) => f.fp)).toEqual(["src/b.ts::fake"]);
    expect(captured?.crossExamVerdicts).toEqual([
      { fp: "src/a.ts::real", verdict: "CONFIRM" },
      { fp: "src/b.ts::fake", verdict: "REFUTE" },
    ]);
    expect(captured?.blockingFps).toEqual(["src/a.ts::real"]);
  });

  it("records CONFIRM only for explicitly judge-confirmed fps; a judge-silent default-block gets none (not CONFIRM) yet still blocks", async () => {
    // A: explicitly confirmed (real:true). B: explicitly refuted (real:false).
    // C: judge is SILENT (returns no verdict) → default-blocks fail-closed but was
    // NEVER affirmatively confirmed, so it must record cross_exam_verdict "none".
    const judge: EscalateJudge = async (targets) =>
      targets
        .filter((t) => t.fp !== "src/c.ts::silent")
        .map((t) => ({ fp: t.fp, real: t.fp === "src/a.ts::real" }));
    const escalateThree = triage({
      escalate: [
        finding({ fp: "src/a.ts::real" }),
        finding({ fp: "src/b.ts::fake" }),
        finding({ fp: "src/c.ts::silent" }),
      ],
      summary: { ...triage().summary, escalate: 3 },
    });
    const target = (fp: string, location: string) => ({
      fp,
      severity: "P1",
      location,
      summary: "boom",
      reviewers: ["opus"],
      lane_count: 1,
      agreement: "single_lane",
    });
    const crossExamThree = crossExam({
      cross_exam_required: true,
      target_count: 3,
      targets: [
        target("src/a.ts::real", "src/a.ts:1"),
        target("src/b.ts::fake", "src/b.ts:1"),
        target("src/c.ts::silent", "src/c.ts:1"),
      ],
    });

    let captured: RqlRecordInput | undefined;
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: async () => ({
        stdout: JSON.stringify({
          schema: "crucible.review-quality-ledger.record-result.v1",
          ledger_file: "/tmp/ledger.jsonl",
          ledger_source: "explicit",
          dry_run: false,
          finding_count: 3,
          appended: 3,
          deduped: 0,
          classification_counts: { P1: 2, Dismissed: 1 },
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const originalRecord = client.record.bind(client);
    client.record = (input: RqlRecordInput) => {
      captured = input;
      return originalRecord(input);
    };

    const result = await aggregatorWith({
      triage: escalateThree,
      crossExam: crossExamThree,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge,
      ledger: { client },
    });

    // The merge decision is unchanged: A and the judge-silent C both block.
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings.map((f) => f.fp)).toEqual([
      "src/a.ts::real",
      "src/c.ts::silent",
    ]);
    expect(result.refutedFindings.map((f) => f.fp)).toEqual(["src/b.ts::fake"]);
    // Only the explicitly-confirmed fp is recorded CONFIRM; the silent default-block
    // (C) is OMITTED → the ledger records it as "none", never a fabricated CONFIRM.
    expect(result.judgeConfirmedFps).toEqual(["src/a.ts::real"]);
    expect(captured?.crossExamVerdicts).toEqual([
      { fp: "src/a.ts::real", verdict: "CONFIRM" },
      { fp: "src/b.ts::fake", verdict: "REFUTE" },
    ]);
    // C blocks (fail-closed) but carries no fabricated CONFIRM verdict.
    expect(captured?.blockingFps).toEqual([
      "src/a.ts::real",
      "src/c.ts::silent",
    ]);
    expect(
      captured?.crossExamVerdicts?.some((v) => v.fp === "src/c.ts::silent"),
    ).toBe(false);
  });
});
