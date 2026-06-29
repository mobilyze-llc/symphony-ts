export const ALTITUDE_RELIABILITY_VERDICTS = [
  "kill",
  "keep",
  "reframe",
] as const;

export type AltitudeReliabilityVerdict =
  (typeof ALTITUDE_RELIABILITY_VERDICTS)[number];

export interface AltitudeReliabilityCase {
  issueIdentifier: string;
  expectedVerdict: AltitudeReliabilityVerdict;
  source: string;
}

export const ALTITUDE_RELIABILITY_CORPUS: readonly AltitudeReliabilityCase[] = [
  {
    issueIdentifier: "SYMPH-941",
    expectedVerdict: "kill",
    source: "2026-06-29 disproof session",
  },
  {
    issueIdentifier: "SYMPH-944",
    expectedVerdict: "kill",
    source: "2026-06-29 disproof session",
  },
  {
    issueIdentifier: "SYMPH-958",
    expectedVerdict: "kill",
    source: "2026-06-29 disproof session",
  },
  {
    issueIdentifier: "SYMPH-956",
    expectedVerdict: "keep",
    source: "2026-06-29 disproof session",
  },
  {
    issueIdentifier: "SYMPH-957",
    expectedVerdict: "reframe",
    source: "2026-06-29 disproof session",
  },
];

export interface AltitudeReliabilityBar {
  minAccuracy: number;
  minKillPrecision: number;
  maxFalseKills: number;
}

export const DEFAULT_ALTITUDE_RELIABILITY_BAR: AltitudeReliabilityBar = {
  minAccuracy: 0.9,
  minKillPrecision: 1,
  maxFalseKills: 0,
};

export interface AltitudeReliabilityRunInput {
  model: string;
  generatedAt?: string;
  corpus?: readonly AltitudeReliabilityCase[];
  bar?: Partial<AltitudeReliabilityBar>;
  runVerdict: (
    testCase: AltitudeReliabilityCase,
  ) => Promise<AltitudeReliabilityVerdict>;
}

export interface AltitudeReliabilityCaseResult extends AltitudeReliabilityCase {
  actualVerdict: AltitudeReliabilityVerdict;
  correct: boolean;
  falseKill: boolean;
}

export interface AltitudeReliabilityRunResult {
  generatedAt: string;
  model: string;
  unattended: true;
  corpusSize: number;
  results: AltitudeReliabilityCaseResult[];
  metrics: {
    accuracy: number;
    killPrecision: number;
    killRecall: number;
    falseKills: number;
  };
  bar: AltitudeReliabilityBar;
  capabilityArrived: boolean;
}

export async function runAltitudeReliabilityRetest(
  input: AltitudeReliabilityRunInput,
): Promise<AltitudeReliabilityRunResult> {
  const corpus = input.corpus ?? ALTITUDE_RELIABILITY_CORPUS;
  const bar = { ...DEFAULT_ALTITUDE_RELIABILITY_BAR, ...input.bar };
  validateReliabilityBar(bar);
  const results: AltitudeReliabilityCaseResult[] = [];
  for (const testCase of corpus) {
    const actualVerdict = await input.runVerdict(testCase);
    results.push({
      ...testCase,
      actualVerdict,
      correct: actualVerdict === testCase.expectedVerdict,
      falseKill:
        actualVerdict === "kill" && testCase.expectedVerdict !== "kill",
    });
  }
  const metrics = scoreAltitudeReliability(results);
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    model: input.model,
    unattended: true,
    corpusSize: corpus.length,
    results,
    metrics,
    bar,
    capabilityArrived:
      metrics.accuracy >= bar.minAccuracy &&
      metrics.killPrecision >= bar.minKillPrecision &&
      metrics.falseKills <= bar.maxFalseKills,
  };
}

export function scoreAltitudeReliability(
  results: readonly AltitudeReliabilityCaseResult[],
): AltitudeReliabilityRunResult["metrics"] {
  const correct = results.filter((result) => result.correct).length;
  const actualKills = results.filter(
    (result) => result.actualVerdict === "kill",
  ).length;
  const expectedKills = results.filter(
    (result) => result.expectedVerdict === "kill",
  ).length;
  const trueKills = results.filter(
    (result) =>
      result.actualVerdict === "kill" && result.expectedVerdict === "kill",
  ).length;
  const falseKills = results.filter((result) => result.falseKill).length;
  return {
    accuracy: ratio(correct, results.length),
    killPrecision: actualKills === 0 ? 1 : ratio(trueKills, actualKills),
    killRecall: expectedKills === 0 ? 1 : ratio(trueKills, expectedKills),
    falseKills,
  };
}

export function buildAltitudeReliabilityLedgerEntry(
  result: AltitudeReliabilityRunResult,
): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: "altitude_reliability_retest",
    generated_at: result.generatedAt,
    model: result.model,
    unattended: result.unattended,
    corpus_size: result.corpusSize,
    metrics: result.metrics,
    bar: result.bar,
    capability_arrived: result.capabilityArrived,
    cases: result.results.map((entry) => ({
      issue_identifier: entry.issueIdentifier,
      expected_verdict: entry.expectedVerdict,
      actual_verdict: entry.actualVerdict,
      correct: entry.correct,
      false_kill: entry.falseKill,
    })),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function validateReliabilityBar(bar: AltitudeReliabilityBar): void {
  assertUnitInterval(bar.minAccuracy, "minAccuracy");
  assertUnitInterval(bar.minKillPrecision, "minKillPrecision");
  if (!Number.isInteger(bar.maxFalseKills) || bar.maxFalseKills < 0) {
    throw new Error("maxFalseKills must be a nonnegative integer");
  }
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
}
