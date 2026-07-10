export const STAGE_USAGE_MEASUREMENT_QUALITIES = [
  "true",
  // Reserved for future mappers that derive usage from pricing catalogs,
  // provider proxies, or explicit unsupported-provider responses.
  "estimated",
  "proxy",
  "unsupported",
  "partial",
  "unavailable",
  "unknown",
] as const;

export type StageUsageMeasurementQuality =
  (typeof STAGE_USAGE_MEASUREMENT_QUALITIES)[number];

export const STAGE_USAGE_COST_AUTHORITIES = [
  "authoritative",
  "advisory",
  "unavailable",
  "unknown",
] as const;

export type StageUsageCostAuthority =
  (typeof STAGE_USAGE_COST_AUTHORITIES)[number];

export const STAGE_USAGE_COST_SOURCES = [
  "provider_billing",
  "pricing_catalog",
  "subscription_advisory",
  "not_reported",
] as const;

export type StageUsageCostSource = (typeof STAGE_USAGE_COST_SOURCES)[number];

export interface StageUsageTokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  noCacheTokens?: number | null;
  reasoningTokens?: number | null;
}

export interface StageUsageCostMeasurement {
  amountUsd: number | null;
  currency: "USD";
  source: StageUsageCostSource;
  authority: StageUsageCostAuthority;
  sourceDescription: string;
  catalogVersion?: string;
}

export interface StageUsageMeasurement {
  schema: "symphony.stage-usage.v1";
  source:
    | "codex_app_server"
    | "claude_code_ai_sdk"
    | "gemini_ai_sdk"
    | "crabrunner"
    | "legacy";
  runnerKind: string;
  provider: string | null;
  model: string | null;
  profile: string | null;
  measurementQuality: StageUsageMeasurementQuality;
  tokens: StageUsageTokenCounts;
  cost: StageUsageCostMeasurement;
  unavailableReason?: string;
}

export interface AiSdkUsageLike {
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
  totalTokens?: number | null | undefined;
  cacheReadTokens?: number | null | undefined;
  cacheWriteTokens?: number | null | undefined;
  noCacheTokens?: number | null | undefined;
  reasoningTokens?: number | null | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | null | undefined;
    cacheWriteTokens?: number | null | undefined;
    noCacheTokens?: number | null | undefined;
  } | null;
  outputTokenDetails?: {
    reasoningTokens?: number | null | undefined;
  } | null;
}

export interface StageUsagePricingCatalogRow {
  provider: string;
  model: string;
  currency: "USD";
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  catalogVersion: string;
  sourceDescription: string;
}

export function mapCodexAppServerUsageToStageUsage(input: {
  usage: AiSdkUsageLike;
  model?: string | null;
  profile?: string | null;
}): StageUsageMeasurement {
  return createStageUsageMeasurement({
    source: "codex_app_server",
    runnerKind: "codex",
    provider: "openai",
    model: input.model ?? null,
    profile: input.profile ?? null,
    usage: input.usage,
    cost: costUnavailable(
      "Codex app-server exposes live token telemetry, not authoritative billing spend.",
    ),
  });
}

export function mapClaudeCodeAiSdkUsageToStageUsage(input: {
  usage: AiSdkUsageLike;
  model: string | null;
  profile?: string | null;
  advisoryCostUsd?: number | null;
}): StageUsageMeasurement {
  return createStageUsageMeasurement({
    source: "claude_code_ai_sdk",
    runnerKind: "claude-code",
    provider: "anthropic",
    model: input.model,
    profile: input.profile ?? null,
    usage: input.usage,
    cost:
      input.advisoryCostUsd === undefined || input.advisoryCostUsd === null
        ? costUnavailable(
            "Claude Code OAuth/subscription telemetry does not expose authoritative per-stage billing spend.",
          )
        : subscriptionAdvisoryCost(
            input.advisoryCostUsd,
            "Claude Code subscription/list-price equivalent; advisory only.",
          ),
  });
}

export function mapGeminiAiSdkUsageToStageUsage(input: {
  usage: AiSdkUsageLike;
  model: string | null;
  profile?: string | null;
}): StageUsageMeasurement {
  return createStageUsageMeasurement({
    source: "gemini_ai_sdk",
    runnerKind: "gemini",
    provider: "google",
    model: input.model,
    profile: input.profile ?? null,
    usage: input.usage,
    cost: costUnavailable(
      "Gemini CLI provider usage is token telemetry unless an API billing row is supplied.",
    ),
  });
}

export function mapCrabrunnerUsageToStageUsage(input: {
  usage:
    | (AiSdkUsageLike & {
        status?: "available";
        measurementQuality?: StageUsageMeasurementQuality;
      })
    | { status: "unavailable" | "unknown"; reason?: string }
    | null
    | undefined;
  runnerKind: string;
  provider: string | null;
  model: string | null;
  profile: string | null;
}): StageUsageMeasurement {
  const usage = input.usage;
  if (
    usage === null ||
    usage === undefined ||
    isCrabrunnerUnavailableUsage(usage)
  ) {
    const status = isCrabrunnerUnavailableUsage(usage)
      ? usage.status
      : "unknown";
    const reason = isCrabrunnerUnavailableUsage(usage)
      ? usage.reason
      : undefined;
    return {
      schema: "symphony.stage-usage.v1",
      source: "crabrunner",
      runnerKind: input.runnerKind,
      provider: input.provider,
      model: input.model,
      profile: input.profile,
      measurementQuality: status,
      tokens: emptyTokenCounts(),
      cost: costUnavailable(
        reason ??
          "Crabrunner terminal evidence did not include available usage.",
      ),
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    };
  }

  return createStageUsageMeasurement({
    source: "crabrunner",
    runnerKind: input.runnerKind,
    provider: input.provider,
    model: input.model,
    profile: input.profile,
    usage,
    ...(usage.measurementQuality === undefined
      ? {}
      : { measurementQuality: usage.measurementQuality }),
    cost: costUnavailable(
      "Crabrunner usage artifact did not include authoritative billing spend.",
    ),
  });
}

export function mapApiPricedUsageToStageUsage(input: {
  source: StageUsageMeasurement["source"];
  runnerKind: string;
  provider: string;
  model: string;
  profile?: string | null;
  usage: AiSdkUsageLike;
  pricing: StageUsagePricingCatalogRow;
}): StageUsageMeasurement {
  const tokens = normalizeTokenCounts(input.usage);
  const inputTokens = tokens.inputTokens;
  const outputTokens = tokens.outputTokens;
  const amountUsd =
    inputTokens !== null && outputTokens !== null
      ? (inputTokens / 1_000_000) * input.pricing.inputUsdPerMillionTokens +
        (outputTokens / 1_000_000) * input.pricing.outputUsdPerMillionTokens
      : null;

  return {
    schema: "symphony.stage-usage.v1",
    source: input.source,
    runnerKind: input.runnerKind,
    provider: input.provider,
    model: input.model,
    profile: input.profile ?? null,
    measurementQuality: classifyTokenQuality(tokens),
    tokens,
    cost:
      amountUsd === null
        ? costUnavailable(
            "Pricing catalog cost requires reported input and output token counts.",
          )
        : {
            amountUsd: roundUsd(amountUsd),
            currency: input.pricing.currency,
            source: "pricing_catalog",
            authority: "authoritative",
            sourceDescription: input.pricing.sourceDescription,
            catalogVersion: input.pricing.catalogVersion,
          },
  };
}

export function isStageUsageMeasurement(
  value: unknown,
): value is StageUsageMeasurement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === "symphony.stage-usage.v1" &&
    typeof record.source === "string" &&
    typeof record.runnerKind === "string" &&
    isNullableString(record.provider) &&
    isNullableString(record.model) &&
    isNullableString(record.profile) &&
    isStageUsageMeasurementQuality(record.measurementQuality) &&
    isStageUsageTokenCounts(record.tokens) &&
    isStageUsageCostMeasurement(record.cost)
  );
}

export function coerceLegacyCounterValue(
  value: number | null | undefined,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function createStageUsageMeasurement(input: {
  source: StageUsageMeasurement["source"];
  runnerKind: string;
  provider: string | null;
  model: string | null;
  profile: string | null;
  usage: AiSdkUsageLike;
  measurementQuality?: StageUsageMeasurementQuality;
  cost: StageUsageCostMeasurement;
}): StageUsageMeasurement {
  const tokens = normalizeTokenCounts(input.usage);
  return {
    schema: "symphony.stage-usage.v1",
    source: input.source,
    runnerKind: input.runnerKind,
    provider: input.provider,
    model: input.model,
    profile: input.profile,
    measurementQuality:
      input.measurementQuality ?? classifyTokenQuality(tokens),
    tokens,
    cost: input.cost,
  };
}

function normalizeTokenCounts(usage: AiSdkUsageLike): StageUsageTokenCounts {
  const inputTokens = normalizeNullableCounter(usage.inputTokens);
  const outputTokens = normalizeNullableCounter(usage.outputTokens);
  const explicitTotalTokens = normalizeNullableCounter(usage.totalTokens);
  const totalTokens =
    explicitTotalTokens ??
    (inputTokens === null || outputTokens === null
      ? null
      : inputTokens + outputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...optionalToken(
      "cacheReadTokens",
      usage.inputTokenDetails?.cacheReadTokens ?? usage.cacheReadTokens,
    ),
    ...optionalToken(
      "cacheWriteTokens",
      usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens,
    ),
    ...optionalToken(
      "noCacheTokens",
      usage.inputTokenDetails?.noCacheTokens ?? usage.noCacheTokens,
    ),
    ...optionalToken(
      "reasoningTokens",
      usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
    ),
  };
}

function classifyTokenQuality(
  tokens: StageUsageTokenCounts,
): StageUsageMeasurementQuality {
  if (
    tokens.inputTokens === null &&
    tokens.outputTokens === null &&
    tokens.totalTokens === null
  ) {
    return "unavailable";
  }
  if (
    tokens.inputTokens === null ||
    tokens.outputTokens === null ||
    tokens.totalTokens === null
  ) {
    return "partial";
  }
  return "true";
}

function emptyTokenCounts(): StageUsageTokenCounts {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
}

function optionalToken(
  key: keyof StageUsageTokenCounts,
  value: number | null | undefined,
): Partial<StageUsageTokenCounts> {
  const normalized = normalizeNullableCounter(value);
  return normalized === null ? {} : { [key]: normalized };
}

function normalizeNullableCounter(
  value: number | null | undefined,
): number | null {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function costUnavailable(sourceDescription: string): StageUsageCostMeasurement {
  return {
    amountUsd: null,
    currency: "USD",
    source: "not_reported",
    authority: "unavailable",
    sourceDescription,
  };
}

function subscriptionAdvisoryCost(
  amountUsd: number,
  sourceDescription: string,
): StageUsageCostMeasurement {
  return {
    amountUsd: roundUsd(amountUsd),
    currency: "USD",
    source: "subscription_advisory",
    authority: "advisory",
    sourceDescription,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCrabrunnerUnavailableUsage(
  value: unknown,
): value is { status: "unavailable" | "unknown"; reason?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = (value as Record<string, unknown>).status;
  return status === "unavailable" || status === "unknown";
}

function isStageUsageMeasurementQuality(
  value: unknown,
): value is StageUsageMeasurementQuality {
  return (
    typeof value === "string" &&
    STAGE_USAGE_MEASUREMENT_QUALITIES.includes(
      value as StageUsageMeasurementQuality,
    )
  );
}

function isStageUsageTokenCounts(
  value: unknown,
): value is StageUsageTokenCounts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNullableNumber(record.inputTokens) &&
    isNullableNumber(record.outputTokens) &&
    isNullableNumber(record.totalTokens) &&
    isOptionalNullableNumber(record.cacheReadTokens) &&
    isOptionalNullableNumber(record.cacheWriteTokens) &&
    isOptionalNullableNumber(record.noCacheTokens) &&
    isOptionalNullableNumber(record.reasoningTokens)
  );
}

function isStageUsageCostMeasurement(
  value: unknown,
): value is StageUsageCostMeasurement {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNullableNumber(record.amountUsd) &&
    record.currency === "USD" &&
    typeof record.source === "string" &&
    STAGE_USAGE_COST_SOURCES.includes(record.source as StageUsageCostSource) &&
    typeof record.authority === "string" &&
    STAGE_USAGE_COST_AUTHORITIES.includes(
      record.authority as StageUsageCostAuthority,
    ) &&
    typeof record.sourceDescription === "string"
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function isOptionalNullableNumber(
  value: unknown,
): value is number | null | undefined {
  return value === undefined || isNullableNumber(value);
}
