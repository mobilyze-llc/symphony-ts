#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AltitudeReliabilityBar,
  type AltitudeReliabilityCase,
  type AltitudeReliabilityVerdict,
  DEFAULT_ALTITUDE_RELIABILITY_BAR,
  buildAltitudeReliabilityLedgerEntry,
  runAltitudeReliabilityRetest,
} from "../audit/altitude-reliability.js";
import {
  type AltitudeReliabilityCapabilityLedgerRow,
  appendAltitudeReliabilityCapabilityLedgerRowWithLock,
} from "../logging/capability-ledger.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntriesWithLock,
} from "../logging/run-journal.js";
import { createCrabrunnerVerdictRunner } from "./capability-retest-runner.js";
import { createCapabilityRetestEvaluationWorkspace } from "./capability-retest-workspace.js";

export const CAPABILITY_RETEST_EXIT = {
  ok: 0,
  usage: 1,
  barFailed: 2,
  unavailable: 3,
} as const;

export interface CapabilityRetestCliOptions {
  model: string | null;
  workspace: string;
  outDir: string | null;
  help: boolean;
}

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
  ) => Promise<AltitudeReliabilityVerdict>;
  appendJournal?: (
    workspaceRoot: string,
    drafts: readonly DispatcherRunJournalEntryDraft[],
  ) => Promise<unknown>;
  appendCapabilityLedger?: (
    workspaceRoot: string,
    row: AltitudeReliabilityCapabilityLedgerRow,
  ) => Promise<unknown>;
}

class CapabilityRetestUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityRetestUsageError";
  }
}

export function parseCapabilityRetestCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): CapabilityRetestCliOptions {
  let model: string | null = null;
  let workspace = cwd;
  let outDir: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    const inline = splitInlineValue(token);
    const name = inline?.name ?? token;
    const readValue = (flag: string): string =>
      inline?.value ?? readValueFlag(argv, ++index, flag);
    switch (name) {
      case "--model":
        model = readValue("--model");
        break;
      case "--workspace":
        workspace = resolve(cwd, readValue("--workspace"));
        break;
      case "--out-dir": {
        const value = readValue("--out-dir");
        outDir = isAbsolute(value) ? value : resolve(cwd, value);
        break;
      }
      default:
        throw new CapabilityRetestUsageError(`Unknown option: ${token}`);
    }
  }

  return { model, workspace, outDir, help };
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

  const generatedAt = now().toISOString();
  const outDir =
    options.outDir ??
    join(tmpdir(), `symphony-capability-retest-${stamp(generatedAt)}`);

  let evaluationWorkspace: Awaited<
    ReturnType<typeof createCapabilityRetestEvaluationWorkspace>
  > | null = null;
  try {
    await mkdir(outDir, { recursive: true });
    if (dependencies.runVerdict === undefined) {
      evaluationWorkspace = await createCapabilityRetestEvaluationWorkspace(
        options.workspace,
      );
    }
    const runVerdict =
      dependencies.runVerdict ??
      createCrabrunnerVerdictRunner({
        model,
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
    "Usage: symphony-capability-retest --model <alias> [options]",
    "",
    "Run the fixed altitude-reliability corpus through the planner's crabrunner",
    "model path, append the authoritative score to the non-compacting capability",
    "ledger and a non-authoritative observation to the dispatcher run journal,",
    "then print the full result as JSON.",
    "",
    "Required:",
    "  --model <alias>       Planner model alias to score (for example, opus)",
    "",
    "Options:",
    "  --workspace <path>    Source workspace and durable-ledger root (default current directory)",
    "  --out-dir <path>      Crabrunner prompt/artifact directory (default system temp)",
    "  --help                Show this help text",
    "",
    "Exit codes:",
    "  0  Capability bar passed",
    "  1  Usage error",
    "  2  Capability bar failed (the scored ledger entries are still written)",
    "  3  Runner, verdict parsing, journal, or capability-ledger write unavailable",
    "",
  ].join("\n");
}

function splitInlineValue(
  token: string,
): { name: string; value: string } | null {
  const equals = token.indexOf("=");
  return equals === -1
    ? null
    : { name: token.slice(0, equals), value: token.slice(equals + 1) };
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CapabilityRetestUsageError(`Missing value for ${flag}.`);
  }
  return value;
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
