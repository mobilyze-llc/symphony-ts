#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const GATE_GUIDANCE =
  "Set SYMPHONY_COUNCIL_REVIEW_GATE to the Symphony gate executable, install symphony-council-review-gate on PATH, or run from a built symphony-ts checkout.";
const CMUX_GUIDANCE =
  "Set CMUX_SPAWN_BIN to an executable cmux-spawn path or put cmux-spawn on PATH.";

interface ParsedArgs {
  workspace: string;
  envFile: string | null;
  allowSymphonyWorkspace: boolean;
  skipCmuxPreflight: boolean;
  json: boolean;
  help: boolean;
}

interface ExecutableResolution {
  status: "passed" | "failed";
  name: string;
  source: "env" | "path";
  path: string | null;
  message: string;
}

interface PreflightCheck {
  status: "passed" | "failed";
  name: string;
  message: string;
  source?: "env" | "path";
  path?: string;
  command?: string[];
}

interface PreflightResult {
  status: "passed" | "failed";
  workspace: string;
  envFile: string | null;
  checks: PreflightCheck[];
}

interface ReviewRuntimePreflightDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  execFile?: ExecFileAsync;
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseReviewRuntimePreflightArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): ParsedArgs {
  const parsed: ParsedArgs = {
    workspace: cwd,
    envFile: null,
    allowSymphonyWorkspace: false,
    skipCmuxPreflight: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--workspace") {
      parsed.workspace = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--env-file") {
      parsed.envFile = resolve(cwd, readValue(argv, ++index, token));
      continue;
    }
    if (token === "--allow-symphony-workspace") {
      parsed.allowSymphonyWorkspace = true;
      continue;
    }
    if (token === "--skip-cmux-preflight") {
      parsed.skipCmuxPreflight = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }

    throw new UsageError(`Unknown argument: ${token}`);
  }

  return parsed;
}

export async function runReviewRuntimePreflight(
  args: ParsedArgs,
  dependencies: ReviewRuntimePreflightDependencies = {},
): Promise<PreflightResult> {
  const env = {
    ...(dependencies.env ?? process.env),
    ...(await readEnvFile(args.envFile)),
  };
  const workspace = resolve(dependencies.cwd ?? process.cwd(), args.workspace);
  const checks: PreflightCheck[] = [];

  if (!args.allowSymphonyWorkspace) {
    const workspaceCheck = await checkProductWorkspace(workspace);
    checks.push(workspaceCheck);
    if (workspaceCheck.status === "failed") {
      return {
        status: "failed",
        workspace,
        envFile: args.envFile,
        checks,
      };
    }
  }

  const gate = await resolveExecutable({
    name: "symphony-council-review-gate",
    envName: "SYMPHONY_COUNCIL_REVIEW_GATE",
    commandName: "symphony-council-review-gate",
    env,
    relativeBase: workspace,
    failureGuidance: GATE_GUIDANCE,
  });
  checks.push(resolutionToCheck(gate));

  const cmux = await resolveExecutable({
    name: "cmux-spawn",
    envName: "CMUX_SPAWN_BIN",
    commandName: "cmux-spawn",
    env,
    relativeBase: workspace,
    failureGuidance: CMUX_GUIDANCE,
  });
  checks.push(resolutionToCheck(cmux));

  const exec = dependencies.execFile ?? execFile;
  if (gate.status === "passed" && gate.path !== null) {
    checks.push(
      await runExecutableCheck({
        name: "symphony-council-review-gate --help",
        command: gate.path,
        args: ["--help"],
        cwd: workspace,
        env,
        exec,
      }),
    );
  }

  if (
    !args.skipCmuxPreflight &&
    cmux.status === "passed" &&
    cmux.path !== null
  ) {
    checks.push(
      await runExecutableCheck({
        name: "cmux-spawn preflight",
        command: cmux.path,
        args: ["preflight", "--caffeinate", "--json"],
        cwd: workspace,
        env,
        exec,
      }),
    );
  }

  return {
    status: checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    workspace,
    envFile: args.envFile,
    checks,
  };
}

export async function runReviewRuntimePreflightCli(
  argv: readonly string[],
  dependencies: ReviewRuntimePreflightDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ?? ((message) => process.stdout.write(message));
  const stderr =
    dependencies.stderr ?? ((message) => process.stderr.write(message));

  let parsed: ParsedArgs;
  try {
    parsed = parseReviewRuntimePreflightArgs(
      argv,
      dependencies.cwd ?? process.cwd(),
    );
  } catch (error) {
    stderr(`${formatError(error)}\n\n${usage()}\n`);
    return 2;
  }

  if (parsed.help) {
    stdout(`${usage()}\n`);
    return 0;
  }

  const result = await runReviewRuntimePreflight(parsed, dependencies);
  if (parsed.json) {
    stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, result.status === "passed" ? stdout : stderr);
  }
  return result.status === "passed" ? 0 : 1;
}

function usage(): string {
  return [
    "Usage: symphony-review-runtime-preflight [options]",
    "",
    "Verifies deployed product-review runtime wiring from a non-Symphony workspace.",
    "",
    "Options:",
    "  --workspace DIR              Product workspace to run from (default: cwd)",
    "  --env-file PATH              Dotenv file to overlay onto the process env",
    "  --allow-symphony-workspace   Allow running from a symphony-ts checkout",
    "  --skip-cmux-preflight        Resolve cmux-spawn but skip `preflight --caffeinate --json`",
    "  --json                       Print machine-readable JSON",
    "  --help                       Show this help",
  ].join("\n");
}

async function readEnvFile(
  envFile: string | null,
): Promise<Record<string, string>> {
  if (envFile === null) {
    return {};
  }
  return parseDotenv(await readFile(envFile, "utf8"));
}

export function parseDotenv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const line = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = parseDotenvValue(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function parseDotenvValue(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue.replace(/[ \t]+#.*$/, "");
}

async function checkProductWorkspace(
  workspace: string,
): Promise<PreflightCheck> {
  const packageJsonPath = join(workspace, "package.json");
  const localGatePath = join(workspace, "dist/src/cli/council-review-gate.js");

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    if (packageJson.name === "symphony-ts") {
      return {
        name: "non-symphony workspace",
        status: "failed",
        message:
          "Review-runtime smoke must run from a product workspace, not the symphony-ts checkout.",
      };
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        name: "non-symphony workspace",
        status: "failed",
        message: `Could not inspect workspace package.json: ${formatError(error)}`,
      };
    }
  }

  try {
    await access(localGatePath, constants.F_OK);
    return {
      name: "no repo-local council gate fallback",
      status: "failed",
      message:
        "Review-runtime smoke refuses a workspace with dist/src/cli/council-review-gate.js; this check must not pass by using the repo-local dist fallback.",
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        name: "no repo-local council gate fallback",
        status: "failed",
        message: `Could not inspect local dist fallback: ${formatError(error)}`,
      };
    }
  }

  return {
    name: "non-symphony workspace",
    status: "passed",
    message:
      "Workspace is not a symphony-ts checkout and has no repo-local council gate fallback.",
  };
}

async function resolveExecutable(input: {
  name: string;
  envName: string;
  commandName: string;
  env: NodeJS.ProcessEnv;
  relativeBase: string;
  failureGuidance: string;
}): Promise<ExecutableResolution> {
  const envValue = input.env[input.envName]?.trim();
  if (envValue !== undefined && envValue !== "") {
    const envPath = await resolveExecutableValue(
      envValue,
      input.env,
      input.relativeBase,
    );
    if (envPath !== null) {
      return {
        name: input.name,
        status: "passed",
        source: "env",
        path: envPath,
        message: `${input.envName} resolves to executable ${envPath}.`,
      };
    }
    return {
      name: input.name,
      status: "failed",
      source: "env",
      path: null,
      message: `${input.envName} is set to ${envValue}, but it is not executable. ${input.failureGuidance}`,
    };
  }

  const pathValue = await findOnPath(input.commandName, input.env);
  if (pathValue !== null) {
    return {
      name: input.name,
      status: "passed",
      source: "path",
      path: pathValue,
      message: `${input.commandName} resolves on PATH at ${pathValue}.`,
    };
  }

  return {
    name: input.name,
    status: "failed",
    source: "path",
    path: null,
    message: input.failureGuidance,
  };
}

async function resolveExecutableValue(
  value: string,
  env: NodeJS.ProcessEnv,
  relativeBase: string,
): Promise<string | null> {
  if (value.includes("/") || isAbsolute(value)) {
    const absolute = isAbsolute(value) ? value : resolve(relativeBase, value);
    return (await isExecutable(absolute)) ? absolute : null;
  }
  return findOnPath(value, env);
}

async function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry.trim() === "") {
      continue;
    }
    const candidate = join(entry, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolutionToCheck(resolution: ExecutableResolution): PreflightCheck {
  const check: PreflightCheck = {
    name: resolution.name,
    status: resolution.status,
    source: resolution.source,
    message: resolution.message,
  };
  if (resolution.path !== null) {
    check.path = resolution.path;
  }
  return check;
}

async function runExecutableCheck(input: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  exec: ExecFileAsync;
}): Promise<PreflightCheck> {
  try {
    await input.exec(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      name: input.name,
      status: "passed",
      path: input.command,
      command: [input.command, ...input.args],
      message: `${input.name} succeeded from ${input.cwd}.`,
    };
  } catch (error) {
    return {
      name: input.name,
      status: "failed",
      path: input.command,
      command: [input.command, ...input.args],
      message: `${input.name} failed from ${input.cwd}: ${formatError(error)}`,
    };
  }
}

function writeHumanResult(
  result: PreflightResult,
  write: (message: string) => void,
) {
  write(`Review runtime preflight: ${result.status}\n`);
  write(`workspace: ${result.workspace}\n`);
  if (result.envFile !== null) {
    write(`env file: ${result.envFile}\n`);
  }
  for (const check of result.checks) {
    const marker = check.status === "passed" ? "PASS" : "FAIL";
    const pathSuffix = check.path === undefined ? "" : ` (${check.path})`;
    write(`[${marker}] ${check.name}${pathSuffix}: ${check.message}\n`);
  }
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

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectRun(
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

if (isDirectRun(import.meta.url, process.argv[1])) {
  runReviewRuntimePreflightCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `symphony-review-runtime-preflight failed: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
}
