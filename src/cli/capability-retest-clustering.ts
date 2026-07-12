import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  type ClusteringInference,
  MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS,
  createProductionClusteringInference,
  runClusteringBenchmark,
} from "../audit/clustering-benchmark.js";
import {
  type ClusteringBenchmarkCapabilityLedgerRow,
  appendClusteringBenchmarkCapabilityLedgerRowWithLock,
} from "../logging/capability-ledger.js";

export interface ClusteringCapabilityRetestDependencies {
  runInference?: ClusteringInference;
  appendCapabilityLedger?: (
    workspaceRoot: string,
    row: ClusteringBenchmarkCapabilityLedgerRow,
  ) => Promise<unknown>;
}

export async function runClusteringCapabilityRetest(input: {
  model: string;
  reasoningLevel: string;
  workspace: string;
  evaluationWorkspace: string;
  outDir: string;
  fixtureDir: string;
  repeats: number;
  generatedAt: string;
  runId: string;
  env: NodeJS.ProcessEnv;
  dependencies?: ClusteringCapabilityRetestDependencies;
}): Promise<Awaited<ReturnType<typeof runClusteringBenchmark>>> {
  if (input.repeats < MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS) {
    throw new Error(
      `Clustering benchmark evidence requires at least ${MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS} repeats`,
    );
  }
  await mkdir(input.outDir, { recursive: true });
  const runInference =
    input.dependencies?.runInference ??
    createProductionClusteringInference({
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      workspace: input.evaluationWorkspace,
      outDir: input.outDir,
      env: input.env,
      generatedAt: input.generatedAt,
    });
  const result = await runClusteringBenchmark({
    fixturePaths: [
      join(input.fixtureDir, "positive-crucible-strategy.json"),
      join(input.fixtureDir, "negative-symphony-t0.json"),
    ],
    repeats: input.repeats,
    model: input.model,
    generatedAt: input.generatedAt,
    runInference,
  });
  const idempotencyKey = `clustering_golden_set_benchmark:${input.model}:${input.generatedAt}:${input.runId}`;
  const append =
    input.dependencies?.appendCapabilityLedger ??
    appendClusteringBenchmarkCapabilityLedgerRowWithLock;
  await append(input.workspace, {
    schema_version: 1,
    idempotency_key: idempotencyKey,
    run_id: input.runId,
    generated_at: input.generatedAt,
    model: input.model,
    reasoning_level: input.reasoningLevel,
    result: result as unknown as Record<string, unknown>,
  });
  return result;
}
