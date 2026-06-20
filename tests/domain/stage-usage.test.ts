import { describe, expect, it } from "vitest";

import {
  coerceLegacyCounterValue,
  isStageUsageMeasurement,
  mapApiPricedUsageToStageUsage,
  mapClaudeCodeAiSdkUsageToStageUsage,
  mapCodexAppServerUsageToStageUsage,
  mapCrabrunnerUsageToStageUsage,
  mapGeminiAiSdkUsageToStageUsage,
} from "../../src/domain/stage-usage.js";

describe("stage usage measurement contract", () => {
  it("maps Codex app-server usage as true token telemetry without authoritative dollars", () => {
    const usage = mapCodexAppServerUsageToStageUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        inputTokenDetails: { cacheReadTokens: 25 },
      },
    });

    expect(usage).toMatchObject({
      schema: "symphony.stage-usage.v1",
      source: "codex_app_server",
      runnerKind: "codex",
      provider: "openai",
      measurementQuality: "true",
      tokens: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 25,
      },
      cost: {
        amountUsd: null,
        authority: "unavailable",
        source: "not_reported",
      },
    });
    expect(isStageUsageMeasurement(usage)).toBe(true);
  });

  it("maps Codex app-server flat extended token fields into the durable contract", () => {
    const usage = mapCodexAppServerUsageToStageUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 25,
        cacheWriteTokens: 3,
        noCacheTokens: 72,
        reasoningTokens: 9,
      },
    });

    expect(usage.tokens).toMatchObject({
      cacheReadTokens: 25,
      cacheWriteTokens: 3,
      noCacheTokens: 72,
      reasoningTokens: 9,
    });
  });

  it("treats negative provider token counts as unavailable, not durable zero", () => {
    const usage = mapCodexAppServerUsageToStageUsage({
      usage: {
        inputTokens: -1,
        outputTokens: 40,
        totalTokens: 39,
      },
    });

    expect(usage.measurementQuality).toBe("partial");
    expect(usage.tokens).toEqual({
      inputTokens: null,
      outputTokens: 40,
      totalTokens: 39,
    });
    expect(coerceLegacyCounterValue(-1)).toBe(0);
  });

  it("maps Claude Code AI SDK usage with subscription advisory dollars only", () => {
    const usage = mapClaudeCodeAiSdkUsageToStageUsage({
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      advisoryCostUsd: 0.01234567,
    });

    expect(usage.cost).toMatchObject({
      amountUsd: 0.012346,
      source: "subscription_advisory",
      authority: "advisory",
    });
    expect(usage.cost.authority).not.toBe("authoritative");
  });

  it("maps Gemini AI SDK usage and marks missing token fields as partial", () => {
    const usage = mapGeminiAiSdkUsageToStageUsage({
      model: "gemini-2.5-pro",
      usage: { inputTokens: 30, totalTokens: 50 },
    });

    expect(usage.measurementQuality).toBe("partial");
    expect(usage.tokens).toMatchObject({
      inputTokens: 30,
      outputTokens: null,
      totalTokens: 50,
    });
    expect(coerceLegacyCounterValue(usage.tokens.outputTokens)).toBe(0);
  });

  it("keeps crabrunner unavailable usage distinct from zero usage", () => {
    const usage = mapCrabrunnerUsageToStageUsage({
      usage: { status: "unavailable", reason: "usage artifact missing" },
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      profile: "write.crabrunner",
    });

    expect(usage.measurementQuality).toBe("unavailable");
    expect(usage.tokens).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(usage.unavailableReason).toBe("usage artifact missing");
  });

  it("keeps absent crabrunner usage unknown rather than treating it as zero", () => {
    const usage = mapCrabrunnerUsageToStageUsage({
      usage: null,
      runnerKind: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      profile: "write.crabrunner",
    });

    expect(usage.measurementQuality).toBe("unknown");
    expect(usage.tokens).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(usage.cost).toMatchObject({
      amountUsd: null,
      authority: "unavailable",
    });
  });

  it("computes authoritative API-key dollars from an explicit pricing catalog row", () => {
    const usage = mapApiPricedUsageToStageUsage({
      source: "legacy",
      runnerKind: "api-runner",
      provider: "openai",
      model: "test-model",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      pricing: {
        provider: "openai",
        model: "test-model",
        currency: "USD",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        catalogVersion: "test-catalog-2026-06-20",
        sourceDescription: "test pricing catalog row",
      },
    });

    expect(usage.tokens.totalTokens).toBe(1_500_000);
    expect(usage.cost).toEqual({
      amountUsd: 6,
      currency: "USD",
      source: "pricing_catalog",
      authority: "authoritative",
      sourceDescription: "test pricing catalog row",
      catalogVersion: "test-catalog-2026-06-20",
    });
  });

  it("does not compute authoritative zero dollars when pricing catalog token counts are unavailable", () => {
    const usage = mapApiPricedUsageToStageUsage({
      source: "legacy",
      runnerKind: "api-runner",
      provider: "openai",
      model: "test-model",
      usage: {},
      pricing: {
        provider: "openai",
        model: "test-model",
        currency: "USD",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        catalogVersion: "test-catalog-2026-06-20",
        sourceDescription: "test pricing catalog row",
      },
    });

    expect(usage.measurementQuality).toBe("unavailable");
    expect(usage.tokens).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(usage.cost).toMatchObject({
      amountUsd: null,
      source: "not_reported",
      authority: "unavailable",
    });
  });

  it("rejects malformed optional token detail fields at the replay guard", () => {
    const usage = mapCodexAppServerUsageToStageUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    });

    expect(
      isStageUsageMeasurement({
        ...usage,
        tokens: {
          ...usage.tokens,
          cacheReadTokens: "not-a-number",
        },
      }),
    ).toBe(false);
  });
});
