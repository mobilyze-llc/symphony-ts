import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type PlannerRunResult,
  buildPlannerPrompt,
  parsePlannerOutput,
} from "../agent/triage-planner.js";
import { createToolFreeClusteringPlannerRunner } from "../cli/clustering-tool-free-runner.js";
import type { StructuralAdvisory } from "../domain/structural-advisory.js";
import {
  type ClusteringGoldenSetFixture,
  buildClusteringBenchmarkPlannerContext,
  parseClusteringGoldenSetFixture,
} from "./clustering-benchmark-fixture.js";
import {
  type ClusteringScore,
  scoreStructuralAdvisories,
  validateStructuralAdvisoryMembers,
} from "./clustering-benchmark-score.js";

export const MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS = 3;

interface ClusteringBenchmarkRepeat {
  repeat: number;
  fixtures: Array<{
    fixtureId: string;
    fixtureKind: ClusteringGoldenSetFixture["fixture_kind"];
    score: ClusteringScore;
    advisories: StructuralAdvisory[];
  }>;
}

interface MetricSummary {
  mean: number | null;
  min: number | null;
  max: number | null;
  spread: number | null;
}

export interface ClusteringBenchmarkResult {
  kind: "clustering_golden_set_benchmark";
  model: string;
  generatedAt: string;
  repeats: number;
  fixtureSources: Array<{
    fixtureId: string;
    fixtureKind: ClusteringGoldenSetFixture["fixture_kind"];
    cutoff: string;
    commit: string;
  }>;
  fixtureContentHashes: Array<{
    fixtureId: string;
    sha256: string;
  }>;
  perRepeat: ClusteringBenchmarkRepeat[];
  summary: {
    pairwisePrecision: MetricSummary;
    pairwiseRecall: MetricSummary;
    rootIdentificationAccuracy: MetricSummary;
    negativeFalseClusterRate: MetricSummary;
    invalidAdvisoryCount: number;
    invalidMemberCount: number;
    totalAttemptedMemberCount: number;
    invalidMemberRate: number;
  };
}

export type ClusteringInference = (input: {
  prompt: string;
  fixture: ClusteringGoldenSetFixture;
  repeat: number;
}) => Promise<StructuralAdvisory[]>;

export async function runClusteringBenchmark(input: {
  fixturePaths: readonly string[];
  repeats: number;
  model: string;
  generatedAt: string;
  runInference: ClusteringInference;
}): Promise<ClusteringBenchmarkResult> {
  if (!Number.isInteger(input.repeats) || input.repeats < 1) {
    throw new Error("Clustering benchmark repeats must be a positive integer");
  }
  const fixtureSnapshots = await Promise.all(
    input.fixturePaths.map(loadClusteringGoldenSetFixtureSnapshot),
  );
  const fixtures = fixtureSnapshots.map((snapshot) => snapshot.fixture);
  const fixtureContentHashes = fixtureSnapshots.map((snapshot) => ({
    fixtureId: snapshot.fixture.fixture_id,
    sha256: snapshot.sha256,
  }));
  assertFixtureKinds(fixtures);
  const perRepeat: ClusteringBenchmarkRepeat[] = [];
  for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
    const scored: ClusteringBenchmarkRepeat["fixtures"] = [];
    for (const fixture of fixtures) {
      const prompt = buildPlannerPrompt(
        buildClusteringBenchmarkPlannerContext(fixture),
      );
      const advisories = await input.runInference({ prompt, fixture, repeat });
      const validated = validateStructuralAdvisoryMembers(fixture, advisories);
      scored.push({
        fixtureId: fixture.fixture_id,
        fixtureKind: fixture.fixture_kind,
        score: scoreStructuralAdvisories(fixture, advisories),
        advisories: validated.accepted,
      });
    }
    perRepeat.push({ repeat, fixtures: scored });
  }
  return {
    kind: "clustering_golden_set_benchmark",
    model: input.model,
    generatedAt: input.generatedAt,
    repeats: input.repeats,
    fixtureSources: fixtures.map((fixture) => ({
      fixtureId: fixture.fixture_id,
      fixtureKind: fixture.fixture_kind,
      cutoff: fixture.snapshot_cutoff,
      commit: fixture.source.commit,
    })),
    fixtureContentHashes,
    perRepeat,
    summary: summarize(perRepeat),
  };
}

async function loadClusteringGoldenSetFixtureSnapshot(path: string): Promise<{
  fixture: ClusteringGoldenSetFixture;
  sha256: string;
}> {
  const content = await readFile(path);
  return {
    fixture: parseClusteringGoldenSetFixture(content.toString("utf8")),
    sha256: sha256Bytes(content),
  };
}

export function createProductionClusteringInference(input: {
  model: string;
  reasoningLevel: string;
  workspace: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  generatedAt: string;
}): ClusteringInference {
  return async ({ prompt, fixture, repeat }) => {
    const runner = createToolFreeClusteringPlannerRunner({
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      workspace: input.workspace,
      artifactDir: join(input.outDir, fixture.fixture_id, `repeat-${repeat}`),
      artifactName: `clustering-${stamp(input.generatedAt)}-${repeat}`,
      env: input.env,
    });
    return parseProductionPlannerResponse(
      await runner(prompt),
      fixture.fixture_id,
    );
  };
}

function parseProductionPlannerResponse(
  response: PlannerRunResult,
  fixtureId: string,
): StructuralAdvisory[] {
  if (response.status !== "ok") {
    throw new Error(`${fixtureId}: ${response.detail}`);
  }
  const parsed = parsePlannerOutput(response.markdown);
  if (!parsed.ok) {
    throw new Error(`${fixtureId}: ${parsed.reason}`);
  }
  return parsed.value.structural_advisories ?? [];
}

function assertFixtureKinds(
  fixtures: readonly ClusteringGoldenSetFixture[],
): void {
  const kinds = new Set(fixtures.map((fixture) => fixture.fixture_kind));
  if (!kinds.has("positive") || !kinds.has("negative_control")) {
    throw new Error(
      "Benchmark requires positive and negative_control fixtures",
    );
  }
}

function summarize(
  repeats: readonly ClusteringBenchmarkRepeat[],
): ClusteringBenchmarkResult["summary"] {
  const scores = repeats.flatMap((repeat) => repeat.fixtures);
  const positive = scores.filter((entry) => entry.fixtureKind === "positive");
  const negative = scores.filter(
    (entry) => entry.fixtureKind === "negative_control",
  );
  return {
    pairwisePrecision: summarizeMetric(
      positive.map((entry) => entry.score.pairwisePrecision),
    ),
    pairwiseRecall: summarizeMetric(
      positive.map((entry) => entry.score.pairwiseRecall),
    ),
    rootIdentificationAccuracy: summarizeMetric(
      positive.map((entry) => entry.score.rootIdentificationAccuracy),
    ),
    negativeFalseClusterRate: summarizeMetric(
      negative.map((entry) => entry.score.falseClusterRate),
    ),
    invalidAdvisoryCount: scores.reduce(
      (total, entry) => total + entry.score.invalidAdvisoryCount,
      0,
    ),
    invalidMemberCount: scores.reduce(
      (total, entry) => total + entry.score.invalidMemberCount,
      0,
    ),
    totalAttemptedMemberCount: scores.reduce(
      (total, entry) => total + entry.score.totalAttemptedMemberCount,
      0,
    ),
    invalidMemberRate: aggregateInvalidMemberRate(scores),
  };
}

function aggregateInvalidMemberRate(
  scores: readonly ClusteringBenchmarkRepeat["fixtures"][number][],
): number {
  const invalid = scores.reduce(
    (total, entry) => total + entry.score.invalidMemberCount,
    0,
  );
  const attempted = scores.reduce(
    (total, entry) => total + entry.score.totalAttemptedMemberCount,
    0,
  );
  return attempted === 0 ? 0 : invalid / attempted;
}

function summarizeMetric(values: readonly (number | null)[]): MetricSummary {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0)
    return { mean: null, min: null, max: null, spread: null };
  const min = Math.min(...defined);
  const max = Math.max(...defined);
  return {
    mean: defined.reduce((total, value) => total + value, 0) / defined.length,
    min,
    max,
    spread: max - min,
  };
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function sha256Bytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
