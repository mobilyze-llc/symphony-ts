#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_RUNNER_PURPOSES,
  type ClaudeRunnerPurpose,
  type ClaudeRunnerResult,
  MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT,
  isSafeClaudeArtifactName,
} from "../claude-runner/cmux-claude-runner.js";
import {
  type ClaudeCrabrunnerRunnerInput,
  resolveClaudeCrabrunnerSchedulerOptions,
  runClaudeCrabrunner,
} from "../claude-runner/crabrunner-claude-runner.js";

interface ParsedArgs {
  purpose: ClaudeRunnerPurpose;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  artifactName: string;
  model: string | null;
  profile: string | null;
  cmuxSpawnBin: string | null;
  timeoutSeconds: number | null;
  sourcePaths: string[];
  requiredHeadings: string[];
  requireFirstHeading: string | null;
  verdictEnums: string[];
  minBytes: number | null;
  requiredJsonSections: string[];
  diagnosticByteLimit: number | null;
  retryOnInvalid: boolean;
  help: boolean;
}

export interface ClaudeRunnerCliDependencies {
  runClaude?: (
    input: ClaudeCrabrunnerRunnerInput,
  ) => Promise<ClaudeRunnerResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usage(): string {
  return [
    "Usage: claude-runner --purpose <purpose> --workspace <dir> --prompt-file <file> --artifact-dir <dir> --artifact-name <name> [options]",
    "",
    "Calls Claude through crabrunner and validates the direct artifact before reporting success.",
    "",
    "Options:",
    "  --purpose <name>             review|research|spec-review|spec-partner|development-agent|critique|custom",
    "  --workspace <dir>            Readable workspace root for Claude",
    "  --prompt-file <file>         Prompt file inside the workspace",
    "  --artifact-dir <dir>         Directory for prompt/output/status/result files",
    "  --artifact-name <name>       Basename for the Claude artifact",
    "  --model <name>               Claude model alias (default: opus)",
    "  --profile <name>             Crabrunner Claude profile (default: read-only)",
    "  --cmux-spawn-bin <path>      Legacy compatibility flag; ignored by crabrunner execution",
    "  --timeout-seconds <n>        Lane timeout (default: 1800)",
    "  --source <file>              Extra source file that must be readable inside workspace (repeatable)",
    "  --required-heading <text>    Markdown heading required in artifact (repeatable)",
    "  --require-first-heading <h>  First non-empty line must be this heading",
    "  --verdict-enum <value>       Allowed verdict/status enum (repeatable)",
    "  --required-json-section <h>  Heading whose section must contain one fenced JSON object (repeatable)",
    "  --min-bytes <n>              Minimum artifact byte size",
    `  --diagnostic-byte-limit <n>  Max stdout/stderr bytes retained in result diagnostics (default: 16384, max: ${MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT})`,
    "  --retry-on-invalid           Retry once with validation errors when artifact is malformed",
    "  --help                       Show this help",
  ].join("\n");
}

export function parseClaudeRunnerArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  const parsed: ParsedArgs = {
    purpose: "custom",
    workspace: "",
    promptFile: "",
    artifactDir: "",
    artifactName: "",
    model: null,
    profile: null,
    cmuxSpawnBin: null,
    timeoutSeconds: null,
    sourcePaths: [],
    requiredHeadings: [],
    requireFirstHeading: null,
    verdictEnums: [],
    minBytes: null,
    requiredJsonSections: [],
    diagnosticByteLimit: null,
    retryOnInvalid: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { ...parsed, help: true };
    }
    if (token === "--retry-on-invalid") {
      parsed.retryOnInvalid = true;
      continue;
    }
    if (token === "--purpose") {
      parsed.purpose = parsePurpose(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--prompt-file") {
      parsed.promptFile = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--artifact-dir") {
      parsed.artifactDir = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--artifact-name") {
      parsed.artifactName = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--model") {
      parsed.model = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--profile") {
      parsed.profile = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--cmux-spawn-bin") {
      parsed.cmuxSpawnBin = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--timeout-seconds") {
      parsed.timeoutSeconds = parsePositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--source") {
      parsed.sourcePaths.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--required-heading") {
      parsed.requiredHeadings.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--require-first-heading") {
      parsed.requireFirstHeading = readValue(argv, ++index, token);
      continue;
    }
    if (token === "--verdict-enum") {
      parsed.verdictEnums.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--required-json-section") {
      parsed.requiredJsonSections.push(readValue(argv, ++index, token));
      continue;
    }
    if (token === "--min-bytes") {
      parsed.minBytes = parsePositiveInteger(
        readValue(argv, ++index, token),
        token,
      );
      continue;
    }
    if (token === "--diagnostic-byte-limit") {
      parsed.diagnosticByteLimit = parseBoundedPositiveInteger(
        readValue(argv, ++index, token),
        token,
        MAX_CLAUDE_RUNNER_DIAGNOSTIC_BYTE_LIMIT,
      );
      continue;
    }
    throw new UsageError(`Unknown option: ${token}\n\n${usage()}`);
  }

  for (const [name, value] of [
    ["--purpose", parsed.purpose],
    ["--workspace", parsed.workspace],
    ["--prompt-file", parsed.promptFile],
    ["--artifact-dir", parsed.artifactDir],
    ["--artifact-name", parsed.artifactName],
  ] as const) {
    if (value.trim() === "") {
      throw new UsageError(`${name} is required\n\n${usage()}`);
    }
  }
  if (!isSafeClaudeArtifactName(parsed.artifactName)) {
    throw new UsageError(
      "--artifact-name must be a basename containing only letters, numbers, dots, underscores, and hyphens",
    );
  }
  return parsed;
}

export async function runClaudeRunnerCli(
  argv: readonly string[],
  dependencies: ClaudeRunnerCliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr =
    dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const runClaude =
    dependencies.runClaude ??
    ((input) =>
      runClaudeCrabrunner(input, {
        schedulerOptions: resolveClaudeCrabrunnerSchedulerOptions({
          targetRepoRoot: input.workspace,
        }),
      }));
  let parsed: ParsedArgs;
  try {
    parsed = parseClaudeRunnerArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (parsed.help) {
    stdout(`${usage()}\n`);
    return 0;
  }
  if (parsed.retryOnInvalid) {
    stderr(
      "--retry-on-invalid is not supported by crabrunner execution; crabrunner lanes are one-shot and return invalid_artifact for malformed artifacts\n",
    );
    return 2;
  }

  const result = await runClaude({
    purpose: parsed.purpose,
    workspace: parsed.workspace,
    promptFile: parsed.promptFile,
    artifactDir: parsed.artifactDir,
    artifactName: parsed.artifactName,
    ...(parsed.model === null ? {} : { model: parsed.model }),
    ...(parsed.profile === null ? {} : { profile: parsed.profile }),
    ...(parsed.timeoutSeconds === null
      ? {}
      : { timeoutSeconds: parsed.timeoutSeconds }),
    sourcePaths: parsed.sourcePaths,
    ...(parsed.diagnosticByteLimit === null
      ? {}
      : { diagnosticByteLimit: parsed.diagnosticByteLimit }),
    validation: {
      ...(parsed.minBytes === null ? {} : { minBytes: parsed.minBytes }),
      requiredHeadings: parsed.requiredHeadings,
      ...(parsed.requireFirstHeading === null
        ? {}
        : { requireFirstHeading: parsed.requireFirstHeading }),
      verdictEnums: parsed.verdictEnums,
      requiredJsonSections: parsed.requiredJsonSections,
    },
  });

  stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "passed" ? 0 : 1;
}

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedPositiveInteger(
  value: string,
  flag: string,
  max: number,
): number {
  const parsed = parsePositiveInteger(value, flag);
  if (parsed > max) {
    throw new UsageError(`${flag} must be <= ${max}`);
  }
  return parsed;
}

function parsePurpose(value: string): ClaudeRunnerPurpose {
  if ((CLAUDE_RUNNER_PURPOSES as readonly string[]).includes(value)) {
    return value as ClaudeRunnerPurpose;
  }
  throw new UsageError(
    `--purpose must be one of ${CLAUDE_RUNNER_PURPOSES.join(", ")}`,
  );
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
  runClaudeRunnerCli(process.argv.slice(2))
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
