#!/usr/bin/env node
/**
 * Calibration digest CLI (SYMPH-411).
 *
 * Reads the dispatcher run journal (.symphony/run-journals/dispatcher.jsonl)
 * under a workspace root and writes the markdown calibration digest to stdout
 * or a file.
 *
 * Deliberately NOT wired to Slack or Linear: the SYMPH-411 operator review
 * gate requires the first real digest to be reviewed by an operator before
 * the job is scheduled recurring, so delivery wiring (Slack digest tier,
 * linear-docs publish, scheduling) is deferred until after that review.
 */

import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { computeCalibrationReport, renderCalibrationDigest } from "./digest.js";
import {
  getCalibrationJournalPath,
  readCalibrationJournal,
} from "./journal-reader.js";

interface ParsedArgs {
  workspaceRoot: string;
  outPath: string | null;
  help: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function renderUsage(): string {
  return [
    "Usage: symphony-calibration-digest [workspace-root] [--out <file>]",
    "",
    "Joins dispatcher run-journal verdict events against terminal outcomes",
    "and writes a markdown calibration digest (SYMPH-411).",
    "",
    "Arguments:",
    "  workspace-root   Directory containing .symphony/run-journals/",
    "                   (default: current working directory)",
    "  --out <file>     Write the digest to a file instead of stdout",
  ].join("\n");
}

export function parseCalibrationDigestArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  let workspaceRoot: string | null = null;
  let outPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { workspaceRoot: cwd, outPath: null, help: true };
    }
    if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError("--out requires a file path");
      }
      outPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}\n\n${renderUsage()}`);
    }
    if (workspaceRoot !== null) {
      throw new UsageError(`Unexpected argument: ${token}\n\n${renderUsage()}`);
    }
    workspaceRoot = resolve(cwd, token);
  }

  return { workspaceRoot: workspaceRoot ?? cwd, outPath, help: false };
}

export async function runCalibrationDigestCli(
  argv: readonly string[],
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCalibrationDigestArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  if (parsed.help) {
    console.log(renderUsage());
    return 0;
  }

  const journal = await readCalibrationJournal(parsed.workspaceRoot);
  const report = computeCalibrationReport(journal);
  const digest = renderCalibrationDigest(report, {
    generatedAt: new Date().toISOString(),
    journalLabel: getCalibrationJournalPath(parsed.workspaceRoot),
  });

  if (parsed.outPath === null) {
    process.stdout.write(`${digest}\n`);
  } else {
    await fs.writeFile(parsed.outPath, `${digest}\n`, "utf8");
    console.error(`Calibration digest written to ${parsed.outPath}`);
  }
  return 0;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  runCalibrationDigestCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = 1;
    });
}
