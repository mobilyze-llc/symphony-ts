import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateBudget,
  loadPricingCatalog,
  resolveBudgetBasis,
  resolvePricing,
  usdCost,
  weightedTotal,
} from "../../src/policy/pricing.js";

interface FixtureCase {
  name: string;
  provider: string;
  model: string;
  usage: Record<string, number>;
  billing_mode: string;
  denomination: "weighted_tokens" | "usd" | "none";
  enforced: boolean;
  weighted_total: number | null;
  usd_cost: number | null;
}

interface Fixture {
  cases: FixtureCase[];
}

const NOW = new Date("2026-06-28T00:00:00Z");

function loadFixture(): Fixture {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "tests/fixtures/pricing-conformance.fixture.json"),
      "utf8",
    ),
  ) as Fixture;
}

describe("pricing conformance", () => {
  it("matches the shared crucible pricing fixture", () => {
    const catalog = loadPricingCatalog();
    const fixture = loadFixture();

    for (const testCase of fixture.cases) {
      const pricing = resolvePricing(
        testCase.provider,
        testCase.model,
        catalog,
      );
      expect(pricing.billing_mode, testCase.name).toBe(testCase.billing_mode);

      const actualUsd =
        pricing.row === null ? null : usdCost(testCase.usage, pricing.row);
      if (testCase.usd_cost === null) {
        expect(actualUsd, testCase.name).toBeNull();
      } else {
        expect(actualUsd, testCase.name).toBeCloseTo(testCase.usd_cost, 9);
      }

      const basis = resolveBudgetBasis(
        testCase.provider,
        testCase.model,
        catalog,
        NOW,
      );
      const denomination =
        basis.kind === "weighted"
          ? "weighted_tokens"
          : basis.kind === "usd"
            ? "usd"
            : "none";
      expect(denomination, testCase.name).toBe(testCase.denomination);
      expect(basis.kind !== "none", testCase.name).toBe(testCase.enforced);
      const budgetVerdict = evaluateBudget({
        usage: testCase.usage,
        budget: 1,
        provider: testCase.provider,
        model: testCase.model,
        catalog,
        now: NOW,
      });
      expect(budgetVerdict.enforced, testCase.name).toBe(testCase.enforced);
      if (!testCase.enforced) {
        expect(budgetVerdict.note, testCase.name).toMatch(
          /^budget_not_enforced:/,
        );
      }

      if (basis.kind === "weighted") {
        expect(weightedTotal(testCase.usage, basis.ratios), testCase.name).toBe(
          testCase.weighted_total,
        );
      } else {
        expect(testCase.weighted_total, testCase.name).toBeNull();
      }
    }
  });

  it("exercises every catalog billing mode used by the shared fixture", () => {
    const modes = new Set(
      loadFixture().cases.map((testCase) => testCase.billing_mode),
    );

    expect(modes).toEqual(
      new Set([
        "api_token",
        "credit_allowance",
        "diagnostic_only",
        "subscription_included",
      ]),
    );
  });
});
