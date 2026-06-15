import { describe, expect, it } from "vitest";

import type { DispatcherRunJournalEntry } from "../../src/domain/model.js";
import {
  buildInvestigateProductivityReport,
  collectInvestigateProductivityUnits,
  isInvestigateStage,
} from "../../src/observability/investigate-productivity.js";

function stageEntry(
  sequence: number,
  overrides: Partial<DispatcherRunJournalEntry> & {
    metadata?: Record<string, unknown>;
  } = {},
): DispatcherRunJournalEntry {
  const { metadata: metadataOverrides, ...entryOverrides } = overrides;
  return {
    sequence,
    idempotencyKey: `stage-record-${sequence}`,
    timestamp: `2026-06-15T19:0${sequence}:00.000Z`,
    kind: "stage_record",
    issueId: "issue-1",
    issueIdentifier: "SYMPH-700",
    operation: "dispatcher",
    stage: "investigate",
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: "stage record",
    metadata: {
      schema_version: 1,
      status: "completed",
      stageName: "investigate",
      durationMs: 60_000,
      totalTokens: 100_000,
      inputTokens: 70_000,
      outputTokens: 30_000,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 5_000,
      compactions: 0,
      rateLimitWindows: { primary: null, secondary: null },
      usageEventCadence: {
        observedCount: 2,
        retainedCount: 2,
        truncated: false,
        maxTotalTokensDelta: 80_000,
      },
      turns: 2,
      outcome: "normal",
      ...metadataOverrides,
    },
    ...entryOverrides,
  };
}

function legacyStageEntry(sequence: number): DispatcherRunJournalEntry {
  return {
    sequence,
    idempotencyKey: `legacy-stage-record-${sequence}`,
    timestamp: `2026-06-15T19:0${sequence}:00.000Z`,
    kind: "stage_record",
    issueId: "issue-2",
    issueIdentifier: "SYMPH-701",
    operation: "dispatcher",
    stage: "investigate",
    attempt: null,
    ownerId: "test",
    lease: null,
    summary: "legacy stage record",
    metadata: {
      status: "completed",
      stageName: "investigate",
      durationMs: 30_000,
      totalTokens: 50_000,
      turns: 1,
      outcome: "normal",
    },
  };
}

describe("investigate productivity report", () => {
  it("selects investigate stage names by prefix for SYMPH-661 compatibility", () => {
    expect(isInvestigateStage("investigate")).toBe(true);
    expect(isInvestigateStage("investigate_scope")).toBe(true);
    expect(isInvestigateStage("investigate_deep")).toBe(true);
    expect(isInvestigateStage("implement")).toBe(false);
  });

  it("reports current durable StageRecord units with cache-aware cost", () => {
    const units = collectInvestigateProductivityUnits([
      stageEntry(1),
      stageEntry(2, {
        metadata: {
          stageName: "implement",
          totalTokens: 999_999,
        },
      }),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      issueIdentifier: "SYMPH-700",
      totalTokens: 100_000,
      billableTokens: 64_000,
      estimatedCostUsd: 3.2,
      turns: 2,
      cacheReadTokens: 40_000,
      legacy: false,
      legacyReasons: [],
    });
  });

  it("marks legacy records and falls back to total tokens without cache credit", () => {
    const report = buildInvestigateProductivityReport([
      stageEntry(1),
      legacyStageEntry(2),
      stageEntry(3, {
        metadata: {
          stageName: "investigate_deep",
          totalTokens: 20_000,
          cacheReadTokens: 10_000,
          turns: 1,
          outcome: "error",
        },
      }),
    ]);

    expect(report.source).toBe("dispatcher_run_journal");
    expect(report.costConfig).toEqual({
      estimatedCostPer1kTokensUsd: 0.05,
      cachedTokenCostRatio: 0.1,
    });
    expect(report.totalUnits).toBe(3);
    expect(report.legacyUnits).toBe(1);
    expect(report.completedWorkpads).toBe(2);
    expect(report.medianCompletedWorkpadCostUsd).toBe(2.85);
    expect(report.p90CompletedWorkpadCostUsd).toBe(3.2);
    expect(report.retryAfterWorkpad).toEqual({
      count: 1,
      totalTokens: 20_000,
      billableTokens: 11_000,
      estimatedCostUsd: 0.55,
    });

    const legacyUnit = report.units.find(
      (unit) => unit.issueIdentifier === "SYMPH-701",
    );
    expect(legacyUnit).toMatchObject({
      totalTokens: 50_000,
      billableTokens: 50_000,
      estimatedCostUsd: 2.5,
      cacheReadTokens: null,
      legacy: true,
    });
    expect(legacyUnit?.legacyReasons).toContain("missing_cacheReadTokens");
    expect(legacyUnit?.legacyReasons).toContain("missing_usageEventCadence");

    const firstIssue = report.issues.find(
      (issue) => issue.issueIdentifier === "SYMPH-700",
    );
    expect(firstIssue).toMatchObject({
      completedUnits: 1,
      failedUnits: 1,
      retryAfterWorkpadCount: 1,
    });
  });

  it("returns empty rollups for empty or non-investigate journals", () => {
    expect(buildInvestigateProductivityReport([])).toMatchObject({
      totalUnits: 0,
      medianCompletedWorkpadCostUsd: null,
      p90CompletedWorkpadCostUsd: null,
      retryAfterWorkpad: {
        count: 0,
        totalTokens: 0,
        billableTokens: 0,
        estimatedCostUsd: 0,
      },
    });

    expect(
      buildInvestigateProductivityReport([
        stageEntry(1, { metadata: { stageName: "implement" } }),
      ]),
    ).toMatchObject({
      totalUnits: 0,
      completedWorkpads: 0,
    });
  });

  it("supports custom cost config and stage predicates", () => {
    const units = collectInvestigateProductivityUnits(
      [stageEntry(1, { metadata: { stageName: "plan" } })],
      {
        stagePredicates: ["plan"],
        costConfig: {
          estimatedCostPer1kTokensUsd: 0.01,
          cachedTokenCostRatio: 0,
        },
      },
    );

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      stageName: "plan",
      billableTokens: 60_000,
      estimatedCostUsd: 0.6,
    });
  });
});
