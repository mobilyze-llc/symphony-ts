import { describe, expect, it } from "vitest";

import type { HotFileGrowth } from "../../src/agent/triage-planner.js";
import type { Issue } from "../../src/domain/model.js";
import {
  buildQueueHealth,
  computeResidualShare,
  computeTriageIntake,
} from "../../src/orchestrator/standing-plan-queue-health.js";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "h1",
    identifier: "SYMPH-100",
    title: "Title SYMPH-100",
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  };
}

describe("SYMPH-939 health signals", () => {
  const now = new Date("2026-06-27T00:00:00.000Z");
  const nowMs = now.getTime();
  const recent = "2026-06-26T00:00:00.000Z";
  const stale = "2026-05-28T00:00:00.000Z";
  const future = new Date(nowMs + 60_000).toISOString();

  describe("computeTriageIntake", () => {
    it("reports depth and counts only recent createdAt as inflow", () => {
      const issues = [
        issue({ id: "a", createdAt: recent }),
        issue({ id: "b", createdAt: recent }),
        issue({ id: "c", createdAt: stale }),
        issue({ id: "d", createdAt: stale }),
        issue({ id: "e", createdAt: stale }),
      ];
      expect(computeTriageIntake(issues, nowMs)).toEqual({
        depth: 5,
        inflowRate: 2,
      });
    });

    it("skips null and unparseable createdAt", () => {
      const issues = [
        issue({ id: "a", createdAt: recent }),
        issue({ id: "b", createdAt: null }),
        issue({ id: "c", createdAt: "not-a-date" }),
      ];
      expect(computeTriageIntake(issues, nowMs)).toEqual({
        depth: 3,
        inflowRate: 1,
      });
    });

    it("reads empty Triage as depth 0, inflowRate 0", () => {
      expect(computeTriageIntake([], nowMs)).toEqual({
        depth: 0,
        inflowRate: 0,
      });
    });

    it("counts future-dated createdAt in depth but not inflow", () => {
      const issues = [
        issue({ id: "a", createdAt: recent }),
        issue({ id: "b", createdAt: future }),
      ];
      expect(computeTriageIntake(issues, nowMs)).toEqual({
        depth: 2,
        inflowRate: 1,
      });
    });
  });

  describe("computeResidualShare", () => {
    it("is the fraction of titles carrying the residual marker", () => {
      const issues = [
        issue({ id: "a", title: "[track:abc] residual follow-up" }),
        issue({ id: "b", title: "Plain ticket" }),
        issue({ id: "c", title: "Another plain ticket" }),
        issue({ id: "d", title: "Yet another" }),
      ];
      expect(computeResidualShare(issues)).toBe(0.25);
    });

    it("reads an empty population as a valid zero residual reading", () => {
      expect(computeResidualShare([])).toBe(0);
    });

    it("reflects the supplied residual population, not candidate backlog assumptions", () => {
      const candidateBacklog = [
        issue({ id: "c1", title: "active work, no marker" }),
        issue({ id: "c2", title: "more active work" }),
      ];
      const residualPopulation = [
        issue({ id: "r1", title: "[track:def] residual" }),
        issue({ id: "r2", title: "plain backlog item" }),
      ];
      expect(computeResidualShare(candidateBacklog)).toBe(0);
      expect(computeResidualShare(residualPopulation)).toBe(0.5);
    });
  });

  describe("buildQueueHealth", () => {
    const hot: HotFileGrowth = {
      topFileChurnFraction: 0.7,
      godFileConcentration: "high",
    };

    it("returns QueueHealth when the three core signals are non-null", () => {
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: 0.25,
          hotFileGrowth: hot,
          reviewRoundDepth: 3,
        }),
      ).toEqual({
        triageIntake: { depth: 5, inflowRate: 2 },
        residualShare: 0.25,
        hotFileGrowth: hot,
        reviewRoundDepth: 3,
      });
    });

    it("carries reviewRoundDepth null as a legitimate reading", () => {
      const health = buildQueueHealth({
        triageIntake: { depth: 0, inflowRate: 0 },
        residualShare: 0,
        hotFileGrowth: hot,
        reviewRoundDepth: null,
      });
      expect(health).toBeDefined();
      expect(health?.reviewRoundDepth).toBeNull();
    });

    it("returns undefined when any core signal is null", () => {
      expect(
        buildQueueHealth({
          triageIntake: null,
          residualShare: 0.25,
          hotFileGrowth: hot,
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: null,
          hotFileGrowth: hot,
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: 0.25,
          hotFileGrowth: null,
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
    });

    it("returns undefined when a rendered numeric is non-finite", () => {
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: Number.NaN,
          hotFileGrowth: hot,
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
      expect(
        buildQueueHealth({
          triageIntake: { depth: Number.POSITIVE_INFINITY, inflowRate: 2 },
          residualShare: 0.25,
          hotFileGrowth: hot,
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: 0.25,
          hotFileGrowth: {
            topFileChurnFraction: Number.NaN,
            godFileConcentration: "high",
          },
          reviewRoundDepth: 3,
        }),
      ).toBeUndefined();
      expect(
        buildQueueHealth({
          triageIntake: { depth: 5, inflowRate: 2 },
          residualShare: 0.25,
          hotFileGrowth: hot,
          reviewRoundDepth: Number.POSITIVE_INFINITY,
        }),
      ).toBeUndefined();
    });

    it("preserves valid zero core readings", () => {
      expect(
        buildQueueHealth({
          triageIntake: { depth: 0, inflowRate: 0 },
          residualShare: 0,
          hotFileGrowth: hot,
          reviewRoundDepth: null,
        }),
      ).toEqual({
        triageIntake: { depth: 0, inflowRate: 0 },
        residualShare: 0,
        hotFileGrowth: hot,
        reviewRoundDepth: null,
      });
    });
  });
});
