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
      // SYMPH-925: a decorrelated judge (codex author, anthropic judge) is required
      // before adjudication; without it the precondition fails closed and the judge
      // never runs. This test exercises the judge-CONFIRMS path, so key it.
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
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
      // SYMPH-925: decorrelated judge (codex author, anthropic judge) → runs and
      // refutes; this test exercises the judge-REFUTES path.
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
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
      // SYMPH-925: the judge must be proven decorrelated before it adjudicates.
      // Author is codex, judge anthropic → decorrelated, so the judge runs.
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
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
      // SYMPH-925: decorrelated judge (codex author, anthropic judge) → runs.
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
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

/**
 * SYMPH-925 — judge-family decorrelation is a DETERMINISTIC merge precondition.
 * The escalate-bucket judge is the blocking AUTHORITY, so it must be proven to sit
 * OUTSIDE the author/executor model family BEFORE it adjudicates (crucible MOB-386:
 * decorrelate the JUDGE, not the finder). Fail-closed when the family can't be
 * keyed or the judge is the author's family — the supplied judge never runs and the
 * escalations default-block, mirroring the `routing_author_provenance_missing`
 * fail-closed pattern. These tests pin that precondition is ADDITIVE: it can only
 * make a judged round MORE conservative (refuse the judge), never less.
 */
describe("ReviewAggregator judge-family decorrelation (SYMPH-925)", () => {
  const escalatedTriage = triage({
    escalate: [finding()],
    summary: { ...triage().summary, escalate: 1 },
  });
  const escalatedCrossExam = crossExam({
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
  });

  // A judge that would REFUTE the escalation if it were allowed to run. The
  // decorrelation precondition must REFUSE it (and thus block) when same-family —
  // proving the refusal happens BEFORE the judge, not after.
  const refutingJudge: EscalateJudge = async (targets) =>
    targets.map((t) => ({ fp: t.fp, real: false }));

  it("lets a decorrelated judge (different family) adjudicate normally", async () => {
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      // Author is codex, judge is anthropic → decorrelated.
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic/opus",
      },
    });
    expect(result.judgeDecorrelation?.satisfied).toBe(true);
    expect(result.judgeDecorrelationDegradedReason).toBeNull();
    // The judge ran and refuted → pass.
    expect(result.verdict).toBe("pass");
    expect(result.refutedFindings).toHaveLength(1);
    expect(result.judgedTargetCount).toBe(1);
  });

  it("REFUSES a same-family judge and blocks fail-closed (judge never runs)", async () => {
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      // This judge would refute (→ pass) IF it ran; it must be refused instead.
      judge: refutingJudge,
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        // Judge is also the codex (author) family → conflict of interest.
        judgeFamily: "codex",
      },
    });
    expect(result.judgeDecorrelation?.satisfied).toBe(false);
    expect(result.judgeDecorrelationDegradedReason).toBe(
      "judge_same_family_as_author",
    );
    // Fail-closed: the escalation blocks despite the would-be refutation.
    expect(result.verdict).toBe("fail");
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.refutedFindings).toHaveLength(0);
    // The refused judge never adjudicated any target.
    expect(result.judgedTargetCount).toBe(0);
    expect(result.judgeConfirmedFps).toEqual([]);
  });

  it("fails closed when the author/executor family is unkeyable", async () => {
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      judgeDecorrelation: { authorFamily: null, judgeFamily: "anthropic" },
    });
    expect(result.judgeDecorrelationDegradedReason).toBe(
      "judge_author_family_missing",
    );
    expect(result.verdict).toBe("fail");
    expect(result.judgedTargetCount).toBe(0);
  });

  it("fails closed when the judge's own family is unkeyable", async () => {
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      judgeDecorrelation: { authorFamily: "openai-codex", judgeFamily: "" },
    });
    expect(result.judgeDecorrelationDegradedReason).toBe(
      "judge_family_missing",
    );
    expect(result.verdict).toBe("fail");
    expect(result.judgedTargetCount).toBe(0);
  });

  it("fails closed when a judge is supplied but NO decorrelation metadata is passed", async () => {
    // Omitting judgeDecorrelation entirely is unkeyable → refuse the judge. The
    // precondition is fail-closed-by-default, never an implicit trusted pass.
    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
    });
    expect(result.judgeDecorrelation?.satisfied).toBe(false);
    expect(result.judgeDecorrelationDegradedReason).toBe(
      "judge_author_family_missing",
    );
    expect(result.verdict).toBe("fail");
  });

  it("does not surface a decorrelation decision when no judge adjudicates", async () => {
    // No escalations → no judge to decorrelate, even with metadata supplied.
    const clean = await aggregatorWith({
      triage: triage(),
      crossExam: crossExam(),
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
    });
    expect(clean.judgeDecorrelation).toBeNull();
    expect(clean.judgeDecorrelationDegradedReason).toBeNull();
    expect(clean.verdict).toBe("pass");

    // Escalations exist but cross-exam was not required → no judge adjudicates.
    const noCrossExam = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: crossExam({ cross_exam_required: false }),
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "anthropic",
      },
    });
    expect(noCrossExam.judgeDecorrelation).toBeNull();
    // Still fail-closed for the escalation (the existing no-cross-exam path).
    expect(noCrossExam.verdict).toBe("fail");
  });

  it("keeps the FINDER set signal-first: an author-family finder is retained while the JUDGE excludes the author family (MOB-386 regression)", async () => {
    // Crucible's MOB-379→386 lesson: the finder set is signal-first and KEEPS the
    // author's own model family ("Codex always finds"); only the JUDGE excludes it.
    // Here the author is codex. The finder lanes that produced the artifacts INCLUDE
    // a codex (author-family) finder — and it is NOT dropped: it co-raised the
    // escalated finding (its fp survives into the escalate bucket and blocks). The
    // JUDGE, however, is anthropic — provably outside the codex author family — so
    // adjudication is decorrelated even though finding is not.
    const finderLanes = [
      {
        reviewer: "codex",
        markdown: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- boom",
      },
      {
        reviewer: "opus",
        markdown: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- boom",
      },
    ];
    // The codex (author-family) finder is present in the triage lanes — proof the
    // finder set was NOT decorrelated away from the author family.
    const triageWithCodexFinder = triage({
      lanes: [
        {
          reviewer: "codex",
          file: "codex.md",
          verdict: "CHANGES_REQUESTED",
          parse_quality: "clean",
          finding_count: 1,
          none: false,
          fail_open: false,
        },
        {
          reviewer: "opus",
          file: "opus.md",
          verdict: "CHANGES_REQUESTED",
          parse_quality: "clean",
          finding_count: 1,
          none: false,
          fail_open: false,
        },
      ],
      // The escalated finding was co-raised by the codex (author-family) finder.
      escalate: [finding({ reviewer: "codex" })],
      summary: { ...triage().summary, lanes: 2, escalate: 1 },
    });

    const confirmingJudge: EscalateJudge = async (targets) =>
      targets.map((t) => ({ fp: t.fp, real: true }));

    const result = await aggregatorWith({
      triage: triageWithCodexFinder,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: finderLanes,
      currentDiffHash: "head",
      judge: confirmingJudge,
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        // Judge is anthropic — OUTSIDE the codex author family.
        judgeFamily: "anthropic/opus",
      },
    });

    // FINDER signal-first — assert AGGREGATOR BEHAVIOR, not just the input fixture:
    // the codex (author-family) finder's finding FLOWS THROUGH the aggregator into
    // `blockingFindings` carrying its `reviewer: "codex"` raiser, and it drives the
    // verdict. The aggregator did NOT drop the author-family finder's signal.
    expect(result.blockingFindings.map((f) => f.fp)).toEqual([finding().fp]);
    expect(result.blockingFindings.map((f) => f.reviewer)).toEqual(["codex"]);
    expect(result.refutedFindings).toHaveLength(0);
    // JUDGE excluded the author family AND actually adjudicated: anthropic ≠ codex
    // author family → satisfied, and the judge ran over the escalate target(s).
    expect(result.judgeDecorrelation?.satisfied).toBe(true);
    expect(result.judgeDecorrelation?.judgeFamily).toBe("anthropic");
    expect(result.judgeDecorrelation?.authorFamily).toBe("openai-codex");
    expect(result.judgedTargetCount).toBeGreaterThan(0);
    // The decorrelated judge confirmed the author-finder's finding → it blocks.
    expect(result.verdict).toBe("fail");
    expect(result.judgeConfirmedFps).toEqual([finding().fp]);
  });

  it("ledger capture is unaffected by a refused judge (records default-block as 'none')", async () => {
    // The fail-closed refused-judge path is, to the SYMPH-924 ledger, identical to
    // the no-judge path: escalations block, but confirmedFps is empty so the row
    // records cross_exam_verdict 'none', never a fabricated CONFIRM.
    let captured: RqlRecordInput | undefined;
    const client = new ReviewQualityLedgerClient({
      ledgerScriptPath: "/fake/rql.mjs",
      runCommand: async () => ({
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
      }),
    });
    const originalRecord = client.record.bind(client);
    client.record = (input: RqlRecordInput) => {
      captured = input;
      return originalRecord(input);
    };

    const result = await aggregatorWith({
      triage: escalatedTriage,
      crossExam: escalatedCrossExam,
    }).aggregate({
      laneArtifacts: lanes,
      currentDiffHash: "head",
      judge: refutingJudge,
      judgeDecorrelation: {
        authorFamily: "openai-codex",
        judgeFamily: "codex",
      },
      ledger: { client, pr: "owner/repo#1", round: 1 },
    });

    expect(result.verdict).toBe("fail");
    expect(result.judgeDecorrelationDegradedReason).toBe(
      "judge_same_family_as_author",
    );
    // The default-blocked fp is recorded blocking but carries NO CONFIRM verdict.
    expect(captured?.blockingFps).toEqual(["src/x.ts::abc"]);
    expect(captured?.crossExamVerdicts).toBeUndefined();
  });
});
