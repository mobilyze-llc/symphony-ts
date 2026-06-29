import { readFileSync } from "node:fs";

import defaultPricingCatalog from "./pricing-catalog.js";

export const PRICING_CATALOG_SCHEMA =
  "crucible.usage-ledger.pricing-catalog.v2";

export interface WeightRatios {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export interface PriceRow {
  provider: string;
  model_pattern: string;
  precedence?: number;
  billing_mode?: string;
  retrieval_date?: string | null;
  effective_date?: string | null;
  source?: string;
  source_url?: string;
  source_note?: string;
  input_per_million_usd: number | null;
  output_per_million_usd: number | null;
  cache_read_per_million_usd: number | null;
  cache_write_per_million_usd: number | null;
  reasoning_output_per_million_usd: number | null;
}

export interface PricingCatalog {
  schema?: string;
  retrieval_date?: string;
  freshness_window_days?: number;
  currency?: string;
  weight_ratios?: Record<string, WeightRatios>;
  prices: PriceRow[];
}

export interface UsageTokens {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

let cachedDefault: PricingCatalog | undefined;

function normalizeCatalog(parsed: Partial<PricingCatalog>): PricingCatalog {
  return {
    ...parsed,
    prices: Array.isArray(parsed.prices) ? parsed.prices : [],
  };
}

export function loadPricingCatalog(path?: string): PricingCatalog {
  if (path === undefined) {
    cachedDefault ??= normalizeCatalog(defaultPricingCatalog);
    return cachedDefault;
  }
  return normalizeCatalog(
    JSON.parse(readFileSync(path, "utf8")) as Partial<PricingCatalog>,
  );
}

function modelNameForPricing(model: string): string {
  const trimmed = String(model ?? "unknown").trim();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function precedenceOf(row: PriceRow): number {
  return typeof row.precedence === "number" && Number.isFinite(row.precedence)
    ? row.precedence
    : 1000;
}

function matchRow(
  provider: string,
  model: string,
  catalog: PricingCatalog,
): PriceRow | undefined {
  const prov = String(provider ?? "unknown").toLowerCase();
  const name = modelNameForPricing(model);
  return [...catalog.prices]
    .sort((a, b) => precedenceOf(a) - precedenceOf(b))
    .find((row) => {
      if (String(row.provider ?? "unknown").toLowerCase() !== prov) {
        return false;
      }
      try {
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- model_pattern is sourced from the trusted vendored pricing catalog (not user input); malformed patterns already fall back to exact-string match via the surrounding try/catch
        return new RegExp(row.model_pattern, "i").test(name);
      } catch {
        return row.model_pattern === name;
      }
    });
}

function rateOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rowHasRates(row: PriceRow): boolean {
  return [
    row.input_per_million_usd,
    row.output_per_million_usd,
    row.cache_read_per_million_usd,
    row.cache_write_per_million_usd,
    row.reasoning_output_per_million_usd,
  ].some((rate) => rateOrNull(rate) !== null);
}

function tokensOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function costComponent(
  tokens: unknown,
  ratePerMillion: number | null,
): number | null {
  const tokenCount = tokensOrNull(tokens);
  const rate = rateOrNull(ratePerMillion);
  if (tokenCount === null || rate === null) {
    return null;
  }
  return (tokenCount / 1_000_000) * rate;
}

export function usdCost(usage: UsageTokens, row: PriceRow): number | null {
  const parts = [
    costComponent(usage.input_tokens, row.input_per_million_usd),
    costComponent(usage.output_tokens, row.output_per_million_usd),
    costComponent(usage.cache_read_tokens, row.cache_read_per_million_usd),
    costComponent(usage.cache_write_tokens, row.cache_write_per_million_usd),
    costComponent(
      usage.reasoning_output_tokens,
      row.reasoning_output_per_million_usd,
    ),
  ].filter((value): value is number => value !== null);
  return parts.length === 0
    ? null
    : parts.reduce((sum, value) => sum + value, 0);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function weightedTotal(
  usage: UsageTokens,
  ratios: WeightRatios,
): number {
  return (
    num(usage.output_tokens) * ratios.output +
    num(usage.input_tokens) * ratios.input +
    num(usage.cache_write_tokens) * ratios.cache_write +
    num(usage.cache_read_tokens) * ratios.cache_read
  );
}

function isStale(row: PriceRow, catalog: PricingCatalog, now: Date): boolean {
  const windowDays = catalog.freshness_window_days;
  if (typeof windowDays !== "number" || !Number.isFinite(windowDays)) {
    return false;
  }
  const dateStr = row.retrieval_date ?? catalog.retrieval_date;
  if (typeof dateStr !== "string") {
    return false;
  }
  const retrieved = Date.parse(dateStr);
  if (!Number.isFinite(retrieved)) {
    return false;
  }
  const ageDays = (now.getTime() - retrieved) / 86_400_000;
  return ageDays > windowDays;
}

export interface PricingResolution {
  matched: boolean;
  billing_mode: string | null;
  has_rates: boolean;
  row: PriceRow | null;
}

export function resolvePricing(
  provider: string,
  model: string,
  catalog: PricingCatalog,
): PricingResolution {
  const row = matchRow(provider, model, catalog);
  if (row === undefined) {
    return { matched: false, billing_mode: null, has_rates: false, row: null };
  }
  return {
    matched: true,
    billing_mode: row.billing_mode ?? "api_token",
    has_rates: rowHasRates(row),
    row,
  };
}

export type NoRatesReason =
  | "unknown_model"
  | "stale_catalog"
  | "diagnostic_only"
  | "no_weight_ratios"
  | "unknown_billing_mode";

export type BudgetBasis =
  | {
      kind: "weighted";
      provider: string;
      ratios: WeightRatios;
      billing_mode: string;
    }
  | { kind: "usd"; row: PriceRow; billing_mode: string }
  | { kind: "none"; reason: NoRatesReason; billing_mode: string | null };

export function resolveBudgetBasis(
  provider: string,
  model: string,
  catalog: PricingCatalog,
  now: Date = new Date(),
): BudgetBasis {
  const row = matchRow(provider, model, catalog);
  if (row === undefined) {
    return { kind: "none", reason: "unknown_model", billing_mode: null };
  }
  const billingMode = row.billing_mode ?? "api_token";
  if (isStale(row, catalog, now)) {
    return {
      kind: "none",
      reason: "stale_catalog",
      billing_mode: billingMode,
    };
  }
  if (billingMode === "api_token") {
    return rowHasRates(row)
      ? { kind: "usd", row, billing_mode: billingMode }
      : {
          kind: "none",
          reason: "unknown_billing_mode",
          billing_mode: billingMode,
        };
  }
  if (
    billingMode === "subscription_included" ||
    billingMode === "credit_allowance"
  ) {
    const ratios = catalog.weight_ratios?.[String(provider).toLowerCase()];
    return ratios === undefined
      ? { kind: "none", reason: "no_weight_ratios", billing_mode: billingMode }
      : {
          kind: "weighted",
          provider: String(provider).toLowerCase(),
          ratios,
          billing_mode: billingMode,
        };
  }
  if (billingMode === "diagnostic_only") {
    return {
      kind: "none",
      reason: "diagnostic_only",
      billing_mode: billingMode,
    };
  }
  return {
    kind: "none",
    reason: "unknown_billing_mode",
    billing_mode: billingMode,
  };
}

export interface BudgetVerdict {
  enforced: boolean;
  exceeded: boolean;
  denomination: "weighted_tokens" | "usd" | "none";
  total: number | null;
  budget: number;
  billing_mode: string | null;
  note?: string;
}

export function evaluateBudget(args: {
  usage: UsageTokens;
  budget: number;
  provider: string;
  model: string;
  catalog?: PricingCatalog;
  now?: Date;
}): BudgetVerdict {
  const catalog = args.catalog ?? loadPricingCatalog();
  const basis = resolveBudgetBasis(
    args.provider,
    args.model,
    catalog,
    args.now ?? new Date(),
  );
  if (basis.kind === "weighted") {
    const total = weightedTotal(args.usage, basis.ratios);
    return {
      enforced: true,
      exceeded: total > args.budget,
      denomination: "weighted_tokens",
      total,
      budget: args.budget,
      billing_mode: basis.billing_mode,
    };
  }
  if (basis.kind === "usd") {
    const total = usdCost(args.usage, basis.row) ?? 0;
    return {
      enforced: true,
      exceeded: total > args.budget,
      denomination: "usd",
      total,
      budget: args.budget,
      billing_mode: basis.billing_mode,
    };
  }
  return {
    enforced: false,
    exceeded: false,
    denomination: "none",
    total: null,
    budget: args.budget,
    billing_mode: basis.billing_mode,
    note: `budget_not_enforced:${basis.reason}`,
  };
}
