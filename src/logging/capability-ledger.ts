import { promises as fs } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { withDispatcherRunJournalWriteLock } from "./run-journal.js";

const CAPABILITY_LEDGER_DIR = join(".symphony", "capability-ledger");
const ALTITUDE_RELIABILITY_LEDGER_FILENAME = "altitude-reliability.jsonl";
const CLUSTERING_BENCHMARK_LEDGER_FILENAME = "clustering-benchmark.jsonl";

const AltitudeReliabilityCapabilityLedgerRowSchema = z
  .object({
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    run_id: z.string().min(1),
    generated_at: z.string().min(1),
    model: z.string().min(1),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AltitudeReliabilityCapabilityLedgerRow = z.infer<
  typeof AltitudeReliabilityCapabilityLedgerRowSchema
>;

const ClusteringBenchmarkCapabilityLedgerRowSchema = z
  .object({
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    run_id: z.string().min(1),
    generated_at: z.string().min(1),
    model: z.string().min(1),
    result: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ClusteringBenchmarkCapabilityLedgerRow = z.infer<
  typeof ClusteringBenchmarkCapabilityLedgerRowSchema
>;

export function getAltitudeReliabilityCapabilityLedgerPath(
  workspaceRoot: string,
): string {
  return join(
    workspaceRoot,
    CAPABILITY_LEDGER_DIR,
    ALTITUDE_RELIABILITY_LEDGER_FILENAME,
  );
}

function getClusteringBenchmarkCapabilityLedgerPath(
  workspaceRoot: string,
): string {
  return join(
    workspaceRoot,
    CAPABILITY_LEDGER_DIR,
    CLUSTERING_BENCHMARK_LEDGER_FILENAME,
  );
}

/**
 * Append a capability score to a non-compacting ledger.
 *
 * The dispatcher journal still receives the operational event, but this file
 * is the durable score history: dispatcher checkpoint compaction never reads
 * or rewrites it. The shared write lock serializes standalone CLI invocations
 * and makes duplicate run IDs idempotent.
 */
export async function appendAltitudeReliabilityCapabilityLedgerRowWithLock(
  workspaceRoot: string,
  candidate: AltitudeReliabilityCapabilityLedgerRow,
): Promise<{ appended: boolean; row: AltitudeReliabilityCapabilityLedgerRow }> {
  const row = AltitudeReliabilityCapabilityLedgerRowSchema.parse(candidate);
  return withDispatcherRunJournalWriteLock(workspaceRoot, async () => {
    const path = getAltitudeReliabilityCapabilityLedgerPath(workspaceRoot);
    const existing =
      await readAltitudeReliabilityCapabilityLedger(workspaceRoot);
    const duplicate = existing.find(
      (entry) => entry.idempotency_key === row.idempotency_key,
    );
    if (duplicate !== undefined) {
      return { appended: false, row: duplicate };
    }

    await fs.mkdir(join(workspaceRoot, CAPABILITY_LEDGER_DIR), {
      recursive: true,
    });
    await fs.appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    return { appended: true, row };
  });
}

export async function readAltitudeReliabilityCapabilityLedger(
  workspaceRoot: string,
): Promise<AltitudeReliabilityCapabilityLedgerRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(
      getAltitudeReliabilityCapabilityLedgerPath(workspaceRoot),
      "utf8",
    );
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const rows: AltitudeReliabilityCapabilityLedgerRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = AltitudeReliabilityCapabilityLedgerRowSchema.safeParse(
        JSON.parse(trimmed),
      );
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // Preserve the remaining durable score history if a process crash leaves
      // one truncated JSONL row. A later locked append must remain possible.
    }
  }
  return rows;
}

export async function appendClusteringBenchmarkCapabilityLedgerRowWithLock(
  workspaceRoot: string,
  candidate: ClusteringBenchmarkCapabilityLedgerRow,
): Promise<{ appended: boolean; row: ClusteringBenchmarkCapabilityLedgerRow }> {
  const row = ClusteringBenchmarkCapabilityLedgerRowSchema.parse(candidate);
  return withDispatcherRunJournalWriteLock(workspaceRoot, async () => {
    const existing =
      await readClusteringBenchmarkCapabilityLedger(workspaceRoot);
    const duplicate = existing.find(
      (entry) => entry.idempotency_key === row.idempotency_key,
    );
    if (duplicate !== undefined) return { appended: false, row: duplicate };
    await fs.mkdir(join(workspaceRoot, CAPABILITY_LEDGER_DIR), {
      recursive: true,
    });
    await fs.appendFile(
      getClusteringBenchmarkCapabilityLedgerPath(workspaceRoot),
      `${JSON.stringify(row)}\n`,
      "utf8",
    );
    return { appended: true, row };
  });
}

export async function readClusteringBenchmarkCapabilityLedger(
  workspaceRoot: string,
): Promise<ClusteringBenchmarkCapabilityLedgerRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(
      getClusteringBenchmarkCapabilityLedgerPath(workspaceRoot),
      "utf8",
    );
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  return parseJsonlRows(raw, ClusteringBenchmarkCapabilityLedgerRowSchema);
}

function parseJsonlRows<T>(raw: string, schema: z.ZodType<T>): T[] {
  const rows: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = schema.safeParse(JSON.parse(trimmed));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // Preserve later complete rows when a crash leaves one truncated row.
    }
  }
  return rows;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
