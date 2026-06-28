import { describe, expect, it, vi } from "vitest";

import {
  CrabboxSpineClient,
  type SpineCommandResult,
  type SpineCommandRunner,
} from "../../../src/review/spine/crabbox-spine-client.js";
import { createGateAggregatorCapture } from "../../../src/review/spine/gate-aggregator-capture.js";
import { ReviewAggregator } from "../../../src/review/spine/review-aggregator.js";
import {
  ReviewQualityLedgerClient,
  type RqlRecordInput,
} from "../../../src/review/spine/review-quality-ledger-client.js";

/**
 * SYMPH-927 — unit tests for the gate-side ReviewAggregator capture builder. The
 * capture runs the aggregator + ledger as the gate's authoritative spine path by
 * default (a ledger failure / spine absence never alters or blocks the decision).
 */

const LANES = [
  {
    reviewer: "claude-opus",
    markdown: "## Verdict\nPASS\n\n## Findings\nNone",
  },
];

function triage(over: Record<string, unknown> = {}) {
  return {
    schema: "crucible.session-orchestrator.council-triage.v1",
    lanes: [
      {
        reviewer: "claude-opus",
        file: "a.md",
        verdict: "PASS",
        parse_quality: "clean",
        finding_count: 0,
        none: true,
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

const CLEAN_CROSS_EXAM = {
  schema: "crucible.session-orchestrator.cross-exam-select.v1",
  cross_exam_required: false,
  reason: "none",
  fix_diff_changed: false,
  fix_size_lines: null,
  fix_trivial: null,
  parseable_lanes: 1,
  target_count: 0,
  targets: [],
};

/** A ReviewAggregator backed by a fake spine runner returning fixed JSON. */
function fakeAggregator(triageOut: unknown): ReviewAggregator {
  const runner: SpineCommandRunner = async (
    argv,
  ): Promise<SpineCommandResult> => {
    const sub = argv[1];
    const pick = sub === "council-triage" ? triageOut : CLEAN_CROSS_EXAM;
    return { stdout: JSON.stringify(pick), stderr: "", exitCode: 0 };
  };
  return new ReviewAggregator(new CrabboxSpineClient({ runCommand: runner }));
}

/** A ledger client whose injected runner records the record() argv it saw. */
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
          finding_count: 0,
          appended: 0,
          deduped: 0,
          classification_counts: {},
        }),
        stderr: "",
        exitCode: 0,
      };
    },
  });
  return { client, calls };
}

describe("createGateAggregatorCapture (SYMPH-927)", () => {
  it("is a no-op (returns null) when no lane artifacts are supplied", async () => {
    const capture = createGateAggregatorCapture({
      aggregator: fakeAggregator(triage()),
    });
    const result = await capture({
      laneArtifacts: [],
      currentDiffHash: "head",
      authorFamily: "openai-codex",
    });
    expect(result).toBeNull();
  });

  it("is a no-op when the spine is absent (existsSync gate)", async () => {
    // No injected aggregator → it would build a real client; the spine-presence
    // gate must short-circuit to null before any shelling.
    const capture = createGateAggregatorCapture({
      spinePath: "/nonexistent/spine.mjs",
      spineExists: () => false,
    });
    const result = await capture({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
    });
    expect(result).toBeNull();
  });

  it("runs the aggregator and passes the ledger client + judge-decorrelation through", async () => {
    const { client, calls } = recordingLedger();
    const capture = createGateAggregatorCapture({
      aggregator: fakeAggregator(
        triage({
          escalate: [
            {
              severity: "P1",
              location: "src/x.ts:1",
              summary: "boom",
              evidence: "e",
              failure: "reachable",
              test: "missing",
              fp: "src/x.ts::abc",
              reviewer: "claude-opus",
            },
          ],
          summary: { ...triage().summary, escalate: 1 },
        }),
      ),
      ledgerClient: client,
    });
    const result = await capture({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
      judgeFamily: "anthropic",
      pr: "owner/repo#1",
      round: 1,
    });

    // The ledger record() was invoked (report-only side-effect).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("record");
    expect(calls[0]).toContain("--pr");
    // No judge supplied to the gate path → the escalation default-blocks fail-closed.
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected successful aggregator capture");
    }
    expect(result.review.verdict).toBe("fail");
    expect(result.review.blockingFindings).toHaveLength(1);
  });

  it("routes a swallowed ledger failure to onLedgerError without altering the verdict", async () => {
    const errors: unknown[] = [];
    const { client } = recordingLedger({ fail: true });
    const capture = createGateAggregatorCapture({
      aggregator: fakeAggregator(
        triage({
          escalate: [
            {
              severity: "P1",
              location: "src/x.ts:1",
              summary: "boom",
              evidence: "e",
              failure: "reachable",
              test: "missing",
              fp: "src/x.ts::abc",
              reviewer: "claude-opus",
            },
          ],
          summary: { ...triage().summary, escalate: 1 },
        }),
      ),
      ledgerClient: client,
      onLedgerError: (e) => errors.push(e),
    });
    const result = await capture({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
    });
    // The capture still returned a review; the ledger failure was swallowed + logged.
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected successful aggregator capture");
    }
    expect(result.review.verdict).toBe("fail");
    expect(errors).toHaveLength(1);
  });

  it("is authoritative by default and keeps an explicit report-only escape hatch", async () => {
    // A degraded (all-unparseable) round: non-pass aggregator verdict.
    const degradedTriage = triage({
      lanes: [
        {
          reviewer: "claude-opus",
          file: "a.md",
          verdict: "UNKNOWN",
          parse_quality: "unparseable",
          finding_count: 0,
          none: false,
          fail_open: true,
        },
      ],
      summary: { ...triage().summary, unparseable_lanes: 1 },
    });
    const { client } = recordingLedger();

    const defaultAuthoritative = await createGateAggregatorCapture({
      aggregator: fakeAggregator(degradedTriage),
      ledgerClient: client,
    })({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
    });
    expect(defaultAuthoritative?.status).toBe("ok");
    if (defaultAuthoritative?.status !== "ok") {
      throw new Error("expected successful default-authoritative capture");
    }
    expect(defaultAuthoritative.review.verdict).toBe("degraded");
    expect(defaultAuthoritative.shouldEscalateToNonPass).toBe(true);

    const reportOnly = await createGateAggregatorCapture({
      aggregator: fakeAggregator(degradedTriage),
      ledgerClient: client,
    })({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
      authoritative: false,
    });
    expect(reportOnly?.status).toBe("ok");
    if (reportOnly?.status !== "ok") {
      throw new Error("expected successful report-only capture");
    }
    expect(reportOnly.review.verdict).toBe("degraded");
    expect(reportOnly.shouldEscalateToNonPass).toBe(false);
  });

  it("returns an attempted-failure result when the aggregator itself fails", async () => {
    const errors: unknown[] = [];
    // An aggregator whose spine runner always errors → aggregate() rejects.
    const throwingAggregator = new ReviewAggregator(
      new CrabboxSpineClient({
        runCommand: async () => ({
          stdout: "not json",
          stderr: "boom",
          exitCode: 1,
        }),
      }),
    );
    const capture = createGateAggregatorCapture({
      aggregator: throwingAggregator,
      ledgerClient: recordingLedger().client,
      onLedgerError: (e) => errors.push(e),
    });
    const result = await capture({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
    });
    expect(result).toEqual({
      status: "failed",
      degradedCondition: "review_aggregator_capture_failed",
      shouldEscalateToNonPass: true,
    });
    expect(errors).toHaveLength(1);
  });

  it("keeps attempted aggregator failure report-only when authoritative is false", async () => {
    const throwingAggregator = new ReviewAggregator(
      new CrabboxSpineClient({
        runCommand: async () => ({
          stdout: "not json",
          stderr: "boom",
          exitCode: 1,
        }),
      }),
    );
    const capture = createGateAggregatorCapture({
      aggregator: throwingAggregator,
      ledgerClient: recordingLedger().client,
    });
    const result = await capture({
      laneArtifacts: LANES,
      currentDiffHash: "head",
      authorFamily: "openai-codex",
      authoritative: false,
    });
    expect(result).toMatchObject({
      status: "failed",
      degradedCondition: "review_aggregator_capture_failed",
      shouldEscalateToNonPass: false,
    });
  });

  it("resolves attempted failure when the aggregator fails AND onLedgerError itself throws (council P2)", async () => {
    // The observer hook is untrusted: if it THROWS in the outer catch, an unguarded
    // call would reject the capture and break the documented "never throws"
    // contract. The nested guard must swallow it so the capture still resolves.
    let onErrorCalled = false;
    const throwingAggregator = new ReviewAggregator(
      new CrabboxSpineClient({
        runCommand: async () => ({
          stdout: "not json",
          stderr: "boom",
          exitCode: 1,
        }),
      }),
    );
    const capture = createGateAggregatorCapture({
      aggregator: throwingAggregator,
      ledgerClient: recordingLedger().client,
      onLedgerError: () => {
        onErrorCalled = true;
        throw new Error("observability hook blew up");
      },
    });

    await expect(
      capture({
        laneArtifacts: LANES,
        currentDiffHash: "head",
        authorFamily: "openai-codex",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      degradedCondition: "review_aggregator_capture_failed",
      shouldEscalateToNonPass: true,
    });
    expect(onErrorCalled).toBe(true);
  });

  it("constructs a default ledger client with env-overridable paths", () => {
    // Smoke: the builder accepts env (threaded, not ambient) and does not throw at
    // construction time. The real client paths come from the env overrides.
    const spy = vi.fn();
    const capture = createGateAggregatorCapture({
      env: {
        SYMPHONY_REVIEW_QUALITY_LEDGER_PATH: "/custom/rql.mjs",
        SYMPHONY_REVIEW_QUALITY_LEDGER: "/custom/ledger.jsonl",
        SYMPHONY_REVIEW_SPINE_PATH: "/custom/spine.mjs",
      },
      spineExists: () => false,
      onLedgerError: spy,
    });
    expect(typeof capture).toBe("function");
  });
});

// Touch the RqlRecordInput type so its import is exercised (raised_by recovery
// shape is what the gate ledger row carries); keeps the import meaningful.
const _recordInputShape: Pick<RqlRecordInput, "blockingFps"> = {
  blockingFps: [],
};
void _recordInputShape;
