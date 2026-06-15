import {
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
} from "../config/defaults.js";
import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  StageRecord,
} from "../domain/model.js";
import {
  computeBillableTokens,
  estimateCostUsd,
} from "../policy/hard-stops.js";

export interface InvestigateProductivityCostConfig {
  estimatedCostPer1kTokensUsd: number;
  cachedTokenCostRatio: number;
}

export interface InvestigateProductivityUnit {
  sequence: number;
  timestamp: string;
  issueId: string;
  issueIdentifier: string;
  stageName: string;
  attempt: number | null;
  outcome: string;
  totalTokens: number;
  billableTokens: number;
  estimatedCostUsd: number;
  turns: number;
  cacheReadTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  retryAfterWorkpad: boolean;
  legacy: boolean;
  legacyReasons: string[];
}

export interface InvestigateIssueProductivity {
  issueId: string;
  issueIdentifier: string;
  unitCount: number;
  completedUnits: number;
  failedUnits: number;
  retryAfterWorkpadCount: number;
  totalTokens: number;
  billableTokens: number;
  estimatedCostUsd: number;
  firstCompletedAt: string | null;
}

export interface InvestigateProductivityReport {
  schemaVersion: 1;
  generatedAt: string;
  source: "dispatcher_run_journal";
  costConfig: InvestigateProductivityCostConfig;
  stagePredicates: string[];
  totalUnits: number;
  legacyUnits: number;
  completedWorkpads: number;
  medianCompletedWorkpadCostUsd: number | null;
  p90CompletedWorkpadCostUsd: number | null;
  retryAfterWorkpad: {
    count: number;
    totalTokens: number;
    billableTokens: number;
    estimatedCostUsd: number;
  };
  issues: InvestigateIssueProductivity[];
  units: InvestigateProductivityUnit[];
}

export const DEFAULT_INVESTIGATE_STAGE_PREFIXES = ["investigate"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], percentileRank: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)] ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? null);
}

export function isInvestigateStage(
  stageName: string,
  prefixes: readonly string[] = DEFAULT_INVESTIGATE_STAGE_PREFIXES,
): boolean {
  return prefixes.some(
    (prefix) => stageName === prefix || stageName.startsWith(`${prefix}_`),
  );
}

function legacyReasonsForMetadata(metadata: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  for (const field of [
    "cacheReadTokens",
    "cacheWriteTokens",
    "rateLimitWindows",
    "usageEventCadence",
  ]) {
    if (!Object.hasOwn(metadata, field)) {
      reasons.push(`missing_${field}`);
    }
  }
  return reasons;
}

function stageRecordFromEntry(
  entry: DispatcherRunJournalEntry,
): (StageRecord & { legacyReasons: string[] }) | null {
  const metadata = entry.metadata;
  if (
    entry.kind !== "stage_record" ||
    readString(metadata.status) !== "completed"
  ) {
    return null;
  }

  const stageName = readString(metadata.stageName);
  const totalTokens = readNumber(metadata.totalTokens);
  const turns = readNumber(metadata.turns);
  const outcome = readString(metadata.outcome);
  const durationMs = readNumber(metadata.durationMs);
  if (
    stageName === null ||
    totalTokens === null ||
    turns === null ||
    outcome === null ||
    durationMs === null
  ) {
    return null;
  }

  const rateLimitWindows = isRecord(metadata.rateLimitWindows)
    ? (metadata.rateLimitWindows as unknown as StageRecord["rateLimitWindows"])
    : undefined;
  const usageEventCadence = isRecord(metadata.usageEventCadence)
    ? (metadata.usageEventCadence as unknown as StageRecord["usageEventCadence"])
    : undefined;

  return {
    stageName,
    durationMs,
    totalTokens,
    ...(readNumber(metadata.inputTokens) === null
      ? {}
      : { inputTokens: readNumber(metadata.inputTokens) ?? 0 }),
    ...(readNumber(metadata.outputTokens) === null
      ? {}
      : { outputTokens: readNumber(metadata.outputTokens) ?? 0 }),
    ...(readNumber(metadata.cacheReadTokens) === null
      ? {}
      : { cacheReadTokens: readNumber(metadata.cacheReadTokens) ?? 0 }),
    ...(readNumber(metadata.cacheWriteTokens) === null
      ? {}
      : { cacheWriteTokens: readNumber(metadata.cacheWriteTokens) ?? 0 }),
    ...(readNumber(metadata.compactions) === null
      ? {}
      : { compactions: readNumber(metadata.compactions) ?? 0 }),
    ...(rateLimitWindows === undefined ? {} : { rateLimitWindows }),
    ...(usageEventCadence === undefined ? {} : { usageEventCadence }),
    turns,
    outcome,
    legacyReasons: legacyReasonsForMetadata(metadata),
  };
}

export function collectInvestigateProductivityUnits(
  journal: DispatcherRunJournal,
  options: {
    costConfig?: Partial<InvestigateProductivityCostConfig>;
    stagePredicates?: readonly string[];
  } = {},
): InvestigateProductivityUnit[] {
  const costConfig = {
    estimatedCostPer1kTokensUsd:
      options.costConfig?.estimatedCostPer1kTokensUsd ??
      DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
    cachedTokenCostRatio:
      options.costConfig?.cachedTokenCostRatio ??
      DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  };
  const stagePredicates =
    options.stagePredicates ?? DEFAULT_INVESTIGATE_STAGE_PREFIXES;

  const rows: Array<{
    entry: DispatcherRunJournalEntry;
    stageRecord: StageRecord & { legacyReasons: string[] };
  }> = [];
  for (const entry of journal) {
    const stageRecord = stageRecordFromEntry(entry);
    if (
      stageRecord === null ||
      !isInvestigateStage(stageRecord.stageName, stagePredicates)
    ) {
      continue;
    }
    rows.push({ entry, stageRecord });
  }

  rows.sort((left, right) => {
    const leftTime = Date.parse(left.entry.timestamp);
    const rightTime = Date.parse(right.entry.timestamp);
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.entry.sequence - right.entry.sequence;
  });

  const firstCompletedSequenceByIssue = new Map<string, number>();
  for (const { entry, stageRecord } of rows) {
    if (
      stageRecord.outcome === "completed" &&
      !firstCompletedSequenceByIssue.has(entry.issueId)
    ) {
      firstCompletedSequenceByIssue.set(entry.issueId, entry.sequence);
    }
  }

  return rows.map(({ entry, stageRecord }) => {
    const legacy = stageRecord.legacyReasons.length > 0;
    const cacheReadTokens = legacy ? 0 : (stageRecord.cacheReadTokens ?? 0);
    const billableTokens = legacy
      ? stageRecord.totalTokens
      : computeBillableTokens({
          totalTokens: stageRecord.totalTokens,
          cacheReadTokens,
          config: costConfig,
        });
    const estimatedCost = legacy
      ? (billableTokens / 1000) * costConfig.estimatedCostPer1kTokensUsd
      : estimateCostUsd({
          totalTokens: stageRecord.totalTokens,
          cacheReadTokens,
          config: costConfig,
        });
    const firstCompletedSequence = firstCompletedSequenceByIssue.get(
      entry.issueId,
    );
    return {
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      issueId: entry.issueId,
      issueIdentifier: entry.issueIdentifier,
      stageName: stageRecord.stageName,
      attempt: entry.attempt,
      outcome: stageRecord.outcome,
      totalTokens: stageRecord.totalTokens,
      billableTokens,
      estimatedCostUsd: round(estimatedCost),
      turns: stageRecord.turns,
      cacheReadTokens: legacy ? null : (stageRecord.cacheReadTokens ?? 0),
      inputTokens: stageRecord.inputTokens ?? null,
      outputTokens: stageRecord.outputTokens ?? null,
      retryAfterWorkpad:
        firstCompletedSequence !== undefined &&
        entry.sequence > firstCompletedSequence,
      legacy,
      legacyReasons: stageRecord.legacyReasons,
    };
  });
}

function summarizeIssues(
  units: readonly InvestigateProductivityUnit[],
): InvestigateIssueProductivity[] {
  const byIssue = new Map<string, InvestigateIssueProductivity>();
  for (const unit of units) {
    const existing = byIssue.get(unit.issueId) ?? {
      issueId: unit.issueId,
      issueIdentifier: unit.issueIdentifier,
      unitCount: 0,
      completedUnits: 0,
      failedUnits: 0,
      retryAfterWorkpadCount: 0,
      totalTokens: 0,
      billableTokens: 0,
      estimatedCostUsd: 0,
      firstCompletedAt: null,
    };
    existing.unitCount += 1;
    existing.totalTokens += unit.totalTokens;
    existing.billableTokens += unit.billableTokens;
    existing.estimatedCostUsd += unit.estimatedCostUsd;
    if (unit.outcome === "completed") {
      existing.completedUnits += 1;
      existing.firstCompletedAt ??= unit.timestamp;
    }
    if (unit.outcome === "failed") {
      existing.failedUnits += 1;
    }
    if (unit.retryAfterWorkpad) {
      existing.retryAfterWorkpadCount += 1;
    }
    byIssue.set(unit.issueId, existing);
  }

  return [...byIssue.values()]
    .map((issue) => ({
      ...issue,
      estimatedCostUsd: round(issue.estimatedCostUsd),
    }))
    .sort(
      (left, right) =>
        right.estimatedCostUsd - left.estimatedCostUsd ||
        left.issueIdentifier.localeCompare(right.issueIdentifier),
    );
}

export function buildInvestigateProductivityReport(
  journal: DispatcherRunJournal,
  options: {
    generatedAt?: string;
    costConfig?: Partial<InvestigateProductivityCostConfig>;
    stagePredicates?: readonly string[];
  } = {},
): InvestigateProductivityReport {
  const costConfig = {
    estimatedCostPer1kTokensUsd:
      options.costConfig?.estimatedCostPer1kTokensUsd ??
      DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
    cachedTokenCostRatio:
      options.costConfig?.cachedTokenCostRatio ??
      DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  };
  const stagePredicates = [
    ...(options.stagePredicates ?? DEFAULT_INVESTIGATE_STAGE_PREFIXES),
  ];
  const units = collectInvestigateProductivityUnits(journal, {
    costConfig,
    stagePredicates,
  });
  const firstCompletedByIssue = new Map<string, InvestigateProductivityUnit>();
  for (const unit of units) {
    if (
      unit.outcome !== "completed" ||
      firstCompletedByIssue.has(unit.issueId)
    ) {
      continue;
    }
    firstCompletedByIssue.set(unit.issueId, unit);
  }
  const completedWorkpadCosts = [...firstCompletedByIssue.values()].map(
    (unit) => unit.estimatedCostUsd,
  );
  const retryUnits = units.filter((unit) => unit.retryAfterWorkpad);

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: "dispatcher_run_journal",
    costConfig,
    stagePredicates,
    totalUnits: units.length,
    legacyUnits: units.filter((unit) => unit.legacy).length,
    completedWorkpads: completedWorkpadCosts.length,
    medianCompletedWorkpadCostUsd:
      median(completedWorkpadCosts) === null
        ? null
        : round(median(completedWorkpadCosts) ?? 0),
    p90CompletedWorkpadCostUsd:
      percentile(completedWorkpadCosts, 90) === null
        ? null
        : round(percentile(completedWorkpadCosts, 90) ?? 0),
    retryAfterWorkpad: {
      count: retryUnits.length,
      totalTokens: retryUnits.reduce((sum, unit) => sum + unit.totalTokens, 0),
      billableTokens: retryUnits.reduce(
        (sum, unit) => sum + unit.billableTokens,
        0,
      ),
      estimatedCostUsd: round(
        retryUnits.reduce((sum, unit) => sum + unit.estimatedCostUsd, 0),
      ),
    },
    issues: summarizeIssues(units),
    units,
  };
}
