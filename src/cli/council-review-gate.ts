#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runHeadlessCouncilGate } from "../review/headless-council-gate.js";

interface ParsedArgs {
  issueId: string;
  workspace: string;
  artifactDir: string;
  repo?: string;
  prNumber?: number;
  baseRef?: string;
  headRef?: string;
  diffPath?: string;
  cmuxSpawnBin?: string;
  timeoutSeconds?: number;
  codexLead?: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCouncilReviewGateArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  const parsed: Partial<ParsedArgs> = {
    workspace: cwd,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      throw new UsageError(renderUsage());
    }

    if (token === "--issue-id") {
      parsed.issueId = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--artifact-dir") {
      parsed.artifactDir = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--repo") {
      parsed.repo = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--pr") {
      parsed.prNumber = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--base") {
      parsed.baseRef = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--head") {
      parsed.headRef = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--diff") {
      parsed.diffPath = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--cmux-spawn-bin") {
      parsed.cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--timeout-seconds") {
      parsed.timeoutSeconds = readPositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--no-codex-lead") {
      parsed.codexLead = false;
      continue;
    }

    throw new UsageError(`Unknown argument: ${token}`);
  }

  if (parsed.issueId === undefined || parsed.issueId.trim() === "") {
    throw new UsageError("--issue-id is required.");
  }
  if (parsed.artifactDir === undefined || parsed.artifactDir.trim() === "") {
    throw new UsageError("--artifact-dir is required.");
  }
  if (parsed.repo !== undefined && !isValidRepoSlug(parsed.repo)) {
    throw new UsageError("--repo must use OWNER/REPO format.");
  }
  if (parsed.prNumber !== undefined && parsed.repo === undefined) {
    throw new UsageError("--repo is required when --pr is provided.");
  }

  return parsed as ParsedArgs;
}

export async function runCouncilReviewGateCli(
  argv: readonly string[],
  io = {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCouncilReviewGateArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      io.stdout(message);
      return 0;
    }
    io.stderr(`${message}\n\n${renderUsage()}`);
    return 2;
  }

  const result = await runHeadlessCouncilGate(parsed);
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.verdict === "pass" ? 0 : 1;
}

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new UsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function isValidRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function renderUsage(): string {
  return [
    "Usage: symphony-council-review-gate --issue-id ISSUE --artifact-dir DIR [options]",
    "",
    "Options:",
    "  --issue-id ISSUE              Required Linear/source issue identifier",
    "  --artifact-dir DIR            Required directory for review artifacts",
    "  --repo OWNER/REPO              GitHub repository for PR review",
    "  --pr NUMBER                   GitHub PR number; requires --repo",
    "  --workspace DIR               Workspace path (default: current directory)",
    "  --base REF                    Base ref for local diff mode",
    "  --head REF                    Head ref for local diff mode",
    "  --diff PATH                   Review an explicit diff file",
    "  --cmux-spawn-bin PATH         cmux-spawn executable path",
    "  --timeout-seconds N           Per-lane timeout in seconds",
    "  --no-codex-lead               Skip Codex lead triage and mark degraded",
    "",
  ].join("\n");
}

export function isDirectRun(
  importMetaUrl: string,
  argvPath: string | undefined,
) {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCouncilReviewGateCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `symphony-council-review-gate failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
