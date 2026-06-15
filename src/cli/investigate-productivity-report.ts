#!/usr/bin/env node

import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readDispatcherRunJournal } from "../logging/run-journal.js";
import { buildInvestigateProductivityReport } from "../observability/investigate-productivity.js";

interface ParsedArgs {
  workspace: string;
  output: string | null;
  help: boolean;
}

function usage(): string {
  return [
    "Usage: symphony-investigate-productivity-report --workspace <repo-root> [--output <file>]",
    "",
    "Reads durable dispatcher stage_record telemetry and prints investigate productivity JSON.",
    "",
    "Options:",
    "  --workspace <dir>  Workspace containing .symphony/run-journals/dispatcher.jsonl",
    "  --output <file>    Also write the JSON report to this file",
    "  --help             Show this help",
  ].join("\n");
}

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: readonly string[], cwd = process.cwd()): ParsedArgs {
  const parsed: ParsedArgs = {
    workspace: "",
    output: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      return { ...parsed, help: true };
    }
    if (token === "--workspace") {
      parsed.workspace = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--output") {
      parsed.output = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (parsed.workspace === "") {
    throw new Error("--workspace is required");
  }
  return parsed;
}

export async function runInvestigateProductivityReportCli(
  argv = process.argv.slice(2),
  dependencies: {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    stderr(`${usage()}\n`);
    return 2;
  }

  if (args.help) {
    stdout(`${usage()}\n`);
    return 0;
  }

  const journal = await readDispatcherRunJournal(args.workspace);
  const report = buildInvestigateProductivityReport(journal);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output !== null) {
    writeFileSync(args.output, json);
  }
  stdout(json);
  return 0;
}

export function isDirectRun(
  importMetaUrl: string,
  argvPath: string | undefined,
): boolean {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runInvestigateProductivityReportCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `symphony-investigate-productivity-report failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}
