import { describe, expect, it } from "vitest";

import { selectBudgetInputTokensForHardStop } from "../../src/agent/runner.js";
import { evaluateBudgetHardStop } from "../../src/policy/hard-stops.js";

const CONFIG = {
  maxIterations: 3,
  noProgressTurns: 2,
  maxTokensPerUnit: 189,
  maxDollarBudgetUsd: 1_000_000,
  premiumBudgetPauseRatio: 0.8,
  liveBudgetGraceRatio: 0.1,
  estimatedCostPer1kTokensUsd: 5,
  cachedTokenCostRatio: 0.1,
  maxPrimaryWindowPctPerUnit: null,
  maxSecondaryWindowPctPerUnit: null,
};

describe("agent runner budget input selection", () => {
  it("feeds net non-cache Codex input to the weighted budget gate", () => {
    const inputTokens = selectBudgetInputTokensForHardStop({
      codexNoCacheTokens: 100,
      totalStageInputTokens: 1000,
      totalStageCacheReadTokens: 900,
      totalStageCacheWriteTokens: 0,
    });

    expect(inputTokens).toBe(100);
    expect(
      evaluateBudgetHardStop({
        config: CONFIG,
        turnCount: 1,
        totalTokens: 1000,
        provider: "openai",
        model: "codex",
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
      }),
    ).toMatchObject({
      trigger: "token_budget",
      budgetTotal: 190,
    });
  });

  it("falls back closed when Codex no-cache input is unavailable", () => {
    expect(
      selectBudgetInputTokensForHardStop({
        codexNoCacheTokens: 0,
        totalStageInputTokens: 1000,
        totalStageCacheReadTokens: 900,
        totalStageCacheWriteTokens: 25,
      }),
    ).toBe(75);
  });
});
