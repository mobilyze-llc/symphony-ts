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
