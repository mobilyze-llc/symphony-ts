import { describe, expect, it } from "vitest";

import type { PlannerContext } from "../../src/agent/triage-planner.js";
import type { PlanBody } from "../../src/orchestrator/standing-plan-supersession.js";
import {
  appendPlanReviewCoverageGapEntry,
  runPlanTier2Review,
} from "../../src/review/plan-review.js";
import {
  CrabboxSpineClient,
  type SpineCommandResult,
  type SpineCommandRunner,
} from "../../src/review/spine/crabbox-spine-client.js";
import { ReviewAggregator } from "../../src/review/spine/review-aggregator.js";

const body: PlanBody = {
  batches: [
    {
      batchId: "b1",
      mode: "parallel-isolated",
      status: "lookahead",
      members: [{ issueId: "u1", issueIdentifier: "MOB-1" }],
      rationale: "r",
      canary: null,
    },
  ],
  options: [],
  envelope: {
    version: 1,
    concurrencyCeiling: 3,
    allowedRisk: "medium",
    allowedModes: ["parallel-isolated"],
  },
  rationale: "rationale",
  premises: [
    {
      decisionAnchor: "MOB-1",
      kind: "verifiable",
      statement: "MOB-1 is ready.",
    },
  ],
  source: "planner",
  dependencyEdges: [],
};

function context(grounded: boolean): PlannerContext {
  return {
    backlog: [
      {
        issueId: "u1",
        issueIdentifier: "MOB-1",
        title: "Title",
        priority: 1,
        state: "Backlog",
        blockedBy: [],
        ...(grounded
          ? {
              groundingEvidence: {
                status: "grounded" as const,
                reason: null,
                digest: {
                  text: "Superseding design note exists.",
                  status: "unverified" as const,
                  truncated: false,
                },
                claims: [
                  {
                    id: "claim-1",
                    kind: "behavioral" as const,
                    text: "superseded",
                    summary: "Superseded by a newer design note",
                    status: "verified" as const,
                    citations: [],
                    missing: [],
                  },
                ],
                units: [],
                warnings: [],
                extractorCallCount: 1,
                wallClockMs: 1,
              },
            }
          : {}),
      },
    ],
    openPrs: [],
    recentlyMerged: [],
    inFlight: [],
    envelope: body.envelope,
  };
}

function aggregator(): ReviewAggregator {
  const runner: SpineCommandRunner = async (
    argv,
  ): Promise<SpineCommandResult> => {
    const subcommand = argv[1];
    if (subcommand === "council-triage") {
      return {
        stdout: JSON.stringify({
          schema: "crucible.session-orchestrator.council-triage.v1",
          lanes: [
            {
              reviewer: "codex-plan-review",
              file: "lane.md",
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
            escalate: 1,
            unparseable_lanes: 0,
            blocked_lanes: 0,
            partial_lanes: 0,
          },
          track: [],
          escalate: [
            {
              severity: "P2",
              location: "plan:issue/MOB-1",
              summary: "Scheduled superseded candidate",
              evidence: "The grounded digest contains the superseding note.",
              failure: "Planner misread evidence.",
              test: "Review coverage ledger includes claim-1.",
              fp: "plan:issue/MOB-1::superseded",
              reviewer: "codex-plan-review",
            },
          ],
          next_action: "blocking_findings",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        schema: "crucible.session-orchestrator.cross-exam-select.v1",
        cross_exam_required: false,
        reason: "single round",
        fix_diff_changed: false,
        fix_size_lines: null,
        fix_trivial: null,
        parseable_lanes: 1,
        target_count: 0,
        targets: [],
      }),
      stderr: "",
      exitCode: 0,
    };
  };
  return new ReviewAggregator(new CrabboxSpineClient({ runCommand: runner }));
}

describe("plan tier-2 review", () => {
  it("records no-grounded-evidence skip without running lanes", async () => {
    const result = await runPlanTier2Review(
      {
        context: context(false),
        body,
        planId: "plan-1",
        artifactDir: "/tmp/unused",
        workspace: "/tmp/unused",
        plannerGroundingEnabled: false,
      },
      {
        runLane: async () => {
          throw new Error("lane should not run");
        },
      },
    );

    expect(result.findings).toEqual([]);
    expect(result.record.status).toBe("skipped");
    expect(result.record.note).toBe("no grounded evidence");
    expect(result.record.aggregateVerdict).toBeNull();
  });

  it("aggregates lane artifacts, adapts anchors to plan paths, and tags findings", async () => {
    const result = await runPlanTier2Review(
      {
        context: context(true),
        body,
        planId: "plan-1",
        artifactDir: "/tmp/unused",
        workspace: "/tmp/unused",
        plannerGroundingEnabled: true,
      },
      {
        aggregator: aggregator(),
        runLane: async () =>
          "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- [P2] plan:issue/MOB-1 - Scheduled superseded candidate",
      },
    );

    expect(result.record.status).toBe("reviewed");
    expect(result.record.aggregateVerdict).toBe("fail");
    expect(result.record.reviewedGroundingEvidence[0]).toMatchObject({
      issueIdentifier: "MOB-1",
      status: "grounded",
      claimIds: ["claim-1"],
    });
    expect(result.structuredFindings[0]?.evidence).toEqual([
      {
        path: "plan:issue/MOB-1",
        lineStart: null,
        lineEnd: null,
        changedPath: true,
      },
    ]);
    expect(result.findings[0]).toMatchObject({
      planAnchor: "plan:issue/MOB-1",
      severity: "P2",
      source: "tier-2",
      tags: ["misinterpretation"],
    });
  });

  it("logs coverage-gap escapes as post-hoc entries instead of findings", async () => {
    const result = await runPlanTier2Review(
      {
        context: context(false),
        body,
        planId: "plan-1",
        artifactDir: "/tmp/unused",
        workspace: "/tmp/unused",
        plannerGroundingEnabled: false,
      },
      { runLane: async () => "unused" },
    );

    const updated = appendPlanReviewCoverageGapEntry(result.record, {
      issueIdentifier: "MOB-1",
      note: "Superseding doc was absent from reviewed grounding evidence.",
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(result.findings).toEqual([]);
    expect(updated.postHocEntries).toEqual([
      {
        kind: "coverage_gap",
        issueIdentifier: "MOB-1",
        note: "Superseding doc was absent from reviewed grounding evidence.",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ]);
  });
});
