#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  importManagerRunLedger,
  parseManagerRunImportLedger,
  renderManagerRunJournalJsonl,
} from "../logging/manager-run-import.js";

export interface ManagerRunImportCliOptions {
  inputPath: string | null;
  outputPath: string | null;
  help: boolean;
}

export interface ManagerRunImportCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface ManagerRunImportCliDependencies {
  cwd?: string;
  io?: ManagerRunImportCliIo;
}

export class ManagerRunImportCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerRunImportCliUsageError";
  }
}

export function parseManagerRunImportCliArgs(
  argv: readonly string[],
): ManagerRunImportCliOptions {
  let inputPath: string | null = null;
  let outputPath: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--input") {
      inputPath = readValueFlag(argv, ++index, "--input");
      continue;
    }

    if (token.startsWith("--input=")) {
      inputPath = token.slice("--input=".length);
      ensureFlagValue(inputPath, "--input");
      continue;
    }

    if (token === "--output") {
      outputPath = readValueFlag(argv, ++index, "--output");
      continue;
    }

    if (token.startsWith("--output=")) {
      outputPath = token.slice("--output=".length);
      ensureFlagValue(outputPath, "--output");
      continue;
    }

    throw new ManagerRunImportCliUsageError(`Unknown CLI argument: ${token}`);
  }

  return {
    inputPath,
    outputPath,
    help,
  };
}

export async function runManagerRunImportCli(
  argv: readonly string[],
  dependencies: ManagerRunImportCliDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };

  let options: ManagerRunImportCliOptions;
  try {
    options = parseManagerRunImportCliArgs(argv);
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n${renderUsage()}`);
    return 1;
  }

  if (options.help) {
    io.stdout(renderUsage());
    return 0;
  }

  if (options.inputPath === null) {
    io.stderr(`Missing required --input flag.\n${renderUsage()}`);
    return 1;
  }

  try {
    const inputPath = resolve(cwd, options.inputPath);
    const raw = await readFile(inputPath, "utf8");
    const ledger = parseManagerRunImportLedger(raw);
    const journal = importManagerRunLedger(ledger);
    const jsonl = renderManagerRunJournalJsonl(journal);

    if (options.outputPath === null || options.outputPath === "-") {
      io.stdout(jsonl);
      return 0;
    }

    const outputPath = resolve(cwd, options.outputPath);
    await writeFile(outputPath, jsonl, "utf8");
    io.stdout(`Wrote ${journal.length} manager-run entries to ${outputPath}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n`);
    return 1;
  }
}

export function renderUsage(): string {
  return [
    "Usage: symphony-manager-run-import --input <ledger.json> [--output <manager-runs.jsonl>]",
    "",
    "Import a curated historical manager lane ledger into Symphony manager-run JSONL entries.",
    "When --output is omitted or set to -, JSONL is written to stdout.",
    "",
    "Example:",
    "  symphony-manager-run-import --input tests/fixtures/manager-run-ledgers/019ea74a-0df6-7983-bbff-60c7df539e80.json --output /tmp/manager-runs.jsonl",
    "",
  ].join("\n");
}

export function shouldRunAsCli(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) {
    return false;
  }

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  ensureFlagValue(value, flag);
  return value;
}

function ensureFlagValue(
  value: string | undefined,
  flag: string,
): asserts value is string {
  if (value === undefined || value.length === 0) {
    throw new ManagerRunImportCliUsageError(
      `${flag} requires a non-empty value.`,
    );
  }
}

function formatCliError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  const exitCode = await runManagerRunImportCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
