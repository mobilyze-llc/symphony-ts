import { z } from "zod";

import type { StageUsageMeasurementQuality } from "../domain/stage-usage.js";
import type { CrabrunnerUsage } from "./crabrunner-backend.js";

const LANE_WORKER_USAGE_SCHEMA = "crucible.lane-worker.usage.v2";

const SUMMABLE_MEASUREMENT_QUALITIES = new Set<string>([
  "true",
  "estimated",
  "partial",
] satisfies readonly StageUsageMeasurementQuality[]);

export const laneWorkerUsageSchema = z
  .object({
    schema: z.string().nullish(),
    measurement_quality: z.string().nullish(),
    measurement_kind: z.string().nullish(),
    available: z.boolean().nullish(),
    reason: z.string().nullish(),
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
    cache_read_tokens: z.number().nullish(),
    cache_write_tokens: z.number().nullish(),
    no_cache_tokens: z.number().nullish(),
    reasoning_output_tokens: z.number().nullish(),
    reasoning_tokens: z.number().nullish(),
    inputTokens: z.number().nullish(),
    outputTokens: z.number().nullish(),
    totalTokens: z.number().nullish(),
    cacheReadTokens: z.number().nullish(),
    cacheWriteTokens: z.number().nullish(),
    noCacheTokens: z.number().nullish(),
    reasoningTokens: z.number().nullish(),
  })
  .passthrough();

type LaneWorkerUsage = z.infer<typeof laneWorkerUsageSchema>;

export function mapLaneWorkerUsage(usage: LaneWorkerUsage): CrabrunnerUsage {
  if (usage.available === false) {
    return {
      status: "unavailable",
      ...(usage.reason === null || usage.reason === undefined
        ? {}
        : { reason: usage.reason }),
    };
  }

  if (usage.schema !== undefined && usage.schema !== null) {
    if (usage.schema !== LANE_WORKER_USAGE_SCHEMA) {
      return {
        status: "unavailable",
        reason: `unexpected usage schema "${usage.schema}"`,
      };
    }
    const quality = measurementQuality(usage) ?? "unknown";
    if (!SUMMABLE_MEASUREMENT_QUALITIES.has(quality)) {
      return {
        status: quality === "unknown" ? "unknown" : "unavailable",
        reason: `usage measurement quality "${quality}" is not a summable token count`,
      };
    }
  } else if (usage.available !== true) {
    const quality = measurementQuality(usage);
    if (quality === null || quality === undefined) {
      return {
        status: "unknown",
        reason:
          "usage artifact had no schema, measurement_quality/measurement_kind, or availability flag",
      };
    }
    if (!SUMMABLE_MEASUREMENT_QUALITIES.has(quality)) {
      return {
        status: "unavailable",
        reason: `usage measurement quality "${quality}" is not a summable token count`,
      };
    }
  }

  const inputTokens = normalizeToken(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = normalizeToken(
    usage.output_tokens ?? usage.outputTokens,
  );
  const totalTokens =
    normalizeToken(usage.total_tokens ?? usage.totalTokens) ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return {
      status: "unavailable",
      reason: "usage artifact carried no numeric token counts",
    };
  }

  const summableQuality = summableMeasurementQuality(measurementQuality(usage));
  return {
    status: "available",
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(summableQuality === undefined
      ? {}
      : { measurementQuality: summableQuality }),
    ...optionalUsageToken(
      "cacheReadTokens",
      usage.cache_read_tokens ?? usage.cacheReadTokens,
    ),
    ...optionalUsageToken(
      "cacheWriteTokens",
      usage.cache_write_tokens ?? usage.cacheWriteTokens,
    ),
    ...optionalUsageToken(
      "noCacheTokens",
      usage.no_cache_tokens ?? usage.noCacheTokens,
    ),
    ...optionalUsageToken(
      "reasoningTokens",
      usage.reasoning_output_tokens ??
        usage.reasoning_tokens ??
        usage.reasoningTokens,
    ),
  };
}

function summableMeasurementQuality(
  value: string | null | undefined,
): StageUsageMeasurementQuality | undefined {
  return value !== undefined &&
    value !== null &&
    value !== "true" &&
    SUMMABLE_MEASUREMENT_QUALITIES.has(value)
    ? (value as StageUsageMeasurementQuality)
    : undefined;
}

function measurementQuality(usage: LaneWorkerUsage): string | null | undefined {
  return usage.measurement_quality ?? usage.measurement_kind;
}

function optionalUsageToken(
  key:
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "noCacheTokens"
    | "reasoningTokens",
  value: number | null | undefined,
): Partial<Record<typeof key, number>> {
  const normalized = normalizeToken(value);
  return normalized === null ? {} : { [key]: normalized };
}

function normalizeToken(value: number | null | undefined): number | null {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return null;
  }
  return Math.floor(value);
}
