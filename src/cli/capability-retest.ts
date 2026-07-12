#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AltitudeReliabilityBar,
  type AltitudeReliabilityCase,
  type AltitudeReliabilityVerdictObservation,
  DEFAULT_ALTITUDE_RELIABILITY_BAR,
  buildAltitudeReliabilityLedgerEntry,
  runAltitudeReliabilityRetest,
} from "../audit/altitude-reliability.js";
import {
  type ClusteringInference,
  MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS,
} from "../audit/clustering-benchmark.js";
import {
  type AltitudeReliabilityCapabilityLedgerRow,
  appendAltitudeReliabilityCapabilityLedgerRowWithLock,
} from "../logging/capability-ledger.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntriesWithLock,
} from "../logging/run-journal.js";
import { runClusteringCapabilityRetest } from "./capability-retest-clustering.js";
import {
  type CapabilityRetestCliOptions,
  parseCapabilityRetestCliArgs,
} from "./capability-retest-options.js";
import { createCrabrunnerVerdictRunner } from "./capability-retest-runner.js";
import { createCapabilityRetestEvaluationWorkspace } from "./capability-retest-workspace.js";

export const CAPABILITY_RETEST_EXIT = {
  ok: 0,
  usage: 1,
  barFailed: 2,
  unavailable: 3,
} as const;

export { parseCapabilityRetestCliArgs } from "./capability-retest-options.js";

interface CapabilityRetestCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CapabilityRetestCliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CapabilityRetestCliIo;
  now?: () => Date;
  runId?: () => string;
  runVerdict?: (
    testCase: AltitudeReliabilityCase,
    context: { model: string; workspace: string; outDir: string },
  ) => Promise<AltitudeReliabilityVerdictObservation>;
  appendJournal?: (
    workspaceRoot: string,
    drafts: readonly DispatcherRunJournalEntryDraft[],
  ) => Promise<unknown>;
  appendCapabilityLedger?: (
    workspaceRoot: string,
    row: AltitudeReliabilityCapabilityLedgerRow,
  ) => Promise<unknown>;
  runClusteringInference?: ClusteringInference;
}

export async function runCapabilityRetestCli(
  argv: readonly string[],
  dependencies: CapabilityRetestCliDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };
  const now = dependencies.now ?? (() => new Date());
  const runId = dependencies.runId ?? randomUUID;

  let options: CapabilityRetestCliOptions;
  try {
    options = parseCapabilityRetestCliArgs(argv, cwd);
  } catch (error) {
    io.stderr(`${formatError(error)}\n${renderUsage()}`);
    return CAPABILITY_RETEST_EXIT.usage;
  }

  if (options.help) {
    io.stdout(renderUsage());
    return CAPABILITY_RETEST_EXIT.ok;
  }
  const model = options.model?.trim() ?? "";
  if (model === "") {
    io.stderr(`--model must be a non-empty model alias.\n${renderUsage()}`);
    return CAPABILITY_RETEST_EXIT.usage;
  }
  if (
    options.benchmark === "clustering" &&
    options.repeats < MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS
  ) {
    io.stderr(
      `Clustering benchmark evidence requires --repeats >= ${MIN_GATE_AUTHORITATIVE_CLUSTERING_REPEATS}.\n${renderUsage()}`,
    );
    return CAPABILITY_RETEST_EXIT.usage;
  }

  const generatedAt = now().toISOString();
  const outDir =
    options.outDir ??
    join(tmpdir(), `symphony-capability-retest-${stamp(generatedAt)}`);

  let evaluationWorkspace: Awaited<
    ReturnType<typeof createCapabilityRetestEvaluationWorkspace>
  > | null = null;
  try {
    await mkdir(outDir, { recursive: true });
    if (options.benchmark === "clustering") {
      if (dependencies.runClusteringInference === undefined) {
        evaluationWorkspace = await createCapabilityRetestEvaluationWorkspace(
          options.workspace,
        );
      }
      const result = await runClusteringCapabilityRetest({
        model,
        reasoningLevel: options.reasoningLevel,
        workspace: options.workspace,
        evaluationWorkspace: evaluationWorkspace?.path ?? options.workspace,
        outDir,
        fixtureDir:
          options.fixtureDir ??
          join(options.workspace, "tests", "fixtures", "clustering-golden-set"),
        repeats: options.repeats,
        generatedAt,
        runId: runId(),
        env: dependencies.env ?? process.env,
        dependencies: {
          ...(dependencies.runClusteringInference === undefined
            ? {}
            : { runInference: dependencies.runClusteringInference }),
        },
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return CAPABILITY_RETEST_EXIT.ok;
    }
    if (dependencies.runVerdict === undefined) {
      evaluationWorkspace = await createCapabilityRetestEvaluationWorkspace(
        options.workspace,
      );
    }
    const runVerdict =
      dependencies.runVerdict ??
      createCrabrunnerVerdictRunner({
        model,
        reasoningLevel: options.reasoningLevel,
        workspace: evaluationWorkspace?.path ?? options.workspace,
        outDir,
        env: dependencies.env ?? process.env,
        generatedAt,
      });
    const result = await runAltitudeReliabilityRetest({
      model,
      generatedAt,
      bar: CAPABILITY_RETEST_BAR,
      runVerdict: (testCase) =>
        runVerdict(testCase, {
          model,
          workspace: options.workspace,
          outDir,
        }),
    });
    const ledger = buildAltitudeReliabilityLedgerEntry(result);
    const invocationId = runId();
    const idempotencyKey = `altitude_reliability_retest:${model}:${generatedAt}:${invocationId}`;
    const draft: DispatcherRunJournalEntryDraft = {
      idempotencyKey,
      timestamp: generatedAt,
      kind: "altitude_reliability_retest",
      issueId: "altitude-reliability-capability-gate",
      issueIdentifier: "SYMPH-948",
      operation: "gate",
      stage: "capability_retest",
      attempt: null,
      ownerId: "symphony-capability-retest",
      lease: null,
      summary: `Altitude reliability re-test for ${model}: capabilityArrived=${result.capabilityArrived}`,
      metadata: {
        ...ledger,
        run_id: invocationId,
        reasoning_level: options.reasoningLevel,
        gate_authority: false,
        evidence_role: "operational_measurement_observation",
        authoritative_evidence_path:
          ".symphony/capability-ledger/altitude-reliability.jsonl",
      },
    };
    const appendJournal =
      dependencies.appendJournal ?? appendDispatcherRunJournalEntriesWithLock;
    // Preserve the journal-first ordering: a later capability-ledger failure
    // may leave this operational observation behind, but its explicit
    // non-authoritative metadata prevents it from arming the Phase-A gate.
    await appendJournal(options.workspace, [draft]);
    const appendCapabilityLedger =
      dependencies.appendCapabilityLedger ??
      appendAltitudeReliabilityCapabilityLedgerRowWithLock;
    await appendCapabilityLedger(options.workspace, {
      schema_version: 1,
      idempotency_key: idempotencyKey,
      run_id: invocationId,
      generated_at: generatedAt,
      model,
      reasoning_level: options.reasoningLevel,
      result: ledger,
    });
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.capabilityArrived
      ? CAPABILITY_RETEST_EXIT.ok
      : CAPABILITY_RETEST_EXIT.barFailed;
  } catch (error) {
    io.stderr(`Capability re-test unavailable: ${formatError(error)}\n`);
    return CAPABILITY_RETEST_EXIT.unavailable;
  } finally {
    await evaluationWorkspace?.cleanup().catch(() => undefined);
  }
}

const CAPABILITY_RETEST_BAR: AltitudeReliabilityBar =
  DEFAULT_ALTITUDE_RELIABILITY_BAR;

export function renderUsage(): string {
  return [
    "Usage: symphony-capability-retest --model <alias> [--benchmark altitude|clustering] [options]",
    "",
    "Run either the fixed altitude-reliability corpus or the frozen clustering",
    "golden set, append the score to a non-compacting capability ledger, then",
    "print the full result as JSON. Clustering runs at a tool-free boundary.",
    "",
    "Required:",
    "  --model <alias>       Planner model alias to score (for example, opus)",
    "",
    "Options:",
    "  --benchmark <name>  altitude (default) or clustering",
    "  --reasoning-level <level>  Pinned model reasoning/thinking level: low, medium, or high (default high). Applied to the claude and codex tool-free clustering paths and the altitude lane, and recorded in every new ledger row.",
    "  --repeats <count>    Clustering repeats; gate-authoritative runs require >=3 (default 3)",
    "  --fixture-dir <path> Frozen clustering fixtures (default tests/fixtures/clustering-golden-set)",
    "  --workspace <path>    Source workspace and durable-ledger root (default current directory)",
    "  --out-dir <path>      Model prompt/artifact directory (default system temp)",
    "  --help                Show this help text",
    "",
    "Exit codes:",
    "  0  Capability bar passed",
    "  1  Usage error",
    "  2  Altitude capability bar failed (the scored ledger entries are still written; parseable model output-contract violations score as wrong cases)",
    "  3  Runner, unrecoverable verdict parsing, journal, or capability-ledger write unavailable",
    "",
  ].join("\n");
}

function stamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await runCapabilityRetestCli(process.argv.slice(2));
}
