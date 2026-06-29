import { describe, expect, it } from "vitest";

import {
  type PricingCatalog,
  resolveBudgetBasis,
  usdCost,
  weightedTotal,
} from "../../src/policy/pricing.js";

const BASE_ROW = {
  provider: "test",
  model_pattern: "^model$",
  precedence: 10,
  billing_mode: "api_token",
  retrieval_date: "2026-06-28",
  effective_date: "2026-06-28",
  input_per_million_usd: null,
  output_per_million_usd: null,
  cache_read_per_million_usd: null,
  cache_write_per_million_usd: null,
  reasoning_output_per_million_usd: null,
};

describe("pricing policy", () => {
  it("computes weighted totals from disjoint token families", () => {
    expect(
      weightedTotal(
        {
          input_tokens: 100,
          output_tokens: 10,
          cache_write_tokens: 20,
          cache_read_tokens: 30,
        },
        { input: 1, output: 6, cache_write: 1.25, cache_read: 0.1 },
      ),
    ).toBe(188);
  });

  it("ignores null USD rates and returns null when no priced component exists", () => {
    expect(
      usdCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
        },
        {
          ...BASE_ROW,
          input_per_million_usd: 2,
          output_per_million_usd: null,
          cache_read_per_million_usd: 0.2,
        },
      ),
    ).toBeCloseTo(2.2, 9);

    expect(
      usdCost({ input_tokens: 1_000_000 }, { ...BASE_ROW }),
    ).toBeNull();
  });

  it("uses catalog order as the tie-breaker for equal precedence matches", () => {
    const catalog: PricingCatalog = {
      prices: [
        {
          ...BASE_ROW,
          model_pattern: "^model",
          precedence: 10,
          billing_mode: "diagnostic_only",
        },
        {
          ...BASE_ROW,
          model_pattern: "^model$",
          precedence: 10,
          billing_mode: "api_token",
          input_per_million_usd: 1,
        },
      ],
    };

    expect(
      resolveBudgetBasis("test", "model", catalog).billing_mode,
    ).toBe("diagnostic_only");
  });

  it("treats the freshness boundary as valid and stales only after it", () => {
    const catalog: PricingCatalog = {
      freshness_window_days: 1,
      prices: [
        {
          ...BASE_ROW,
          input_per_million_usd: 1,
          retrieval_date: "2026-06-28T00:00:00.000Z",
        },
      ],
    };

    expect(
      resolveBudgetBasis(
        "test",
        "model",
        catalog,
        new Date("2026-06-29T00:00:00.000Z"),
      ).kind,
    ).toBe("usd");
    expect(
      resolveBudgetBasis(
        "test",
        "model",
        catalog,
        new Date("2026-06-29T00:00:00.001Z"),
      ),
    ).toMatchObject({
      kind: "none",
      reason: "stale_catalog",
    });
  });

  it("strips provider prefixes from model names before matching", () => {
    const catalog: PricingCatalog = {
      weight_ratios: {
        openai: { input: 1, output: 6, cache_write: 1.25, cache_read: 0.1 },
      },
      prices: [
        {
          ...BASE_ROW,
          provider: "openai",
          model_pattern: "^codex$",
          billing_mode: "credit_allowance",
        },
      ],
    };

    expect(resolveBudgetBasis("openai", "openai/codex", catalog)).toMatchObject(
      {
        kind: "weighted",
        billing_mode: "credit_allowance",
      },
    );
  });

  it("reports no_weight_ratios for allowance rows without provider ratios", () => {
    const catalog: PricingCatalog = {
      prices: [
        {
          ...BASE_ROW,
          billing_mode: "subscription_included",
        },
      ],
    };

    expect(resolveBudgetBasis("test", "model", catalog)).toMatchObject({
      kind: "none",
      reason: "no_weight_ratios",
      billing_mode: "subscription_included",
    });
  });
});
