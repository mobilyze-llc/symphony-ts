import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLAUDE_RUNNER_PURPOSES = [
  "review",
  "research",
  "spec-review",
  "spec-partner",
  "development-agent",
  "critique",
  "custom",
] as const;

export type ClaudeRunnerPurpose = (typeof CLAUDE_RUNNER_PURPOSES)[number];

export type ClaudeRunnerStatus =
  | "passed"
  | "failed"
  | "invalid_artifact"
  | "timed_out"
  | "degraded";

export interface ClaudeRunnerValidationConfig {
  minBytes?: number;
  requiredHeadings?: string[];
  requireFirstHeading?: string;
  verdictEnums?: string[];
  requireSourceReadStatus?: boolean;
}

export interface ClaudeCmuxRunnerInput {
  purpose: ClaudeRunnerPurpose;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  artifactName: string;
  model?: string;
  profile?: "auto" | "lean-review" | "legacy" | string;
  laneId?: string;
  phase?: string;
  timeoutSeconds?: number;
  cmuxSpawnBin?: string;
  sourcePaths?: string[];
  validation?: ClaudeRunnerValidationConfig;
  retryOnInvalid?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeRunnerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ClaudeRunnerCommand = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<ClaudeRunnerCommandResult>;

export interface ClaudeRunnerDependencies {
  runCommand?: ClaudeRunnerCommand;
  now?: () => Date;
}

export interface ClaudeRunnerSourceVisibility {
  status: "ok" | "invalid_source_path";
  workspace: string;
  sources: Array<{
    kind: "prompt" | "source";
    path: string;
    resolvedPath: string;
    sha256: string | null;
    bytes: number | null;
    readable: boolean;
    insideWorkspace: boolean;
    error: string | null;
  }>;
}

export interface ClaudeRunnerAttempt {
  attempt: number;
  artifactName: string;
  artifactPath: string;
  cliJsonPath: string;
  statusPath: string;
  state: string | null;
  exitCode: number;
  validationErrors: string[];
}

export interface ClaudeRunnerResult {
  schemaVersion: 1;
  status: ClaudeRunnerStatus;
  purpose: ClaudeRunnerPurpose;
  model: string;
  profile: string;
  workspace: string;
  promptFile: string;
  promptSha256: string | null;
  artifactDir: string;
  artifactName: string;
  artifactPath: string | null;
  resultJsonPath: string;
  cmuxSpawnBin: string;
  laneId: string;
  phase: string;
  startedAt: string;
  completedAt: string;
  sourceVisibility: ClaudeRunnerSourceVisibility;
  attempts: ClaudeRunnerAttempt[];
  validationErrors: string[];
  usage: Record<string, unknown> | null;
  message: string;
}

interface CmuxRunStdout {
  state?: string;
  artifact_path?: string;
  status_path?: string;
  usage?: Record<string, unknown>;
  message?: string;
}

const DEFAULT_CMUX_SPAWN_BIN = "cmux-spawn";
const DEFAULT_MODEL = "opus";
const DEFAULT_PROFILE = "legacy";
const DEFAULT_TIMEOUT_SECONDS = 1_800;
const DEFAULT_MIN_ARTIFACT_BYTES = 200;

export function isSafeClaudeArtifactName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export async function runClaudeCmux(
  input: ClaudeCmuxRunnerInput,
  dependencies: ClaudeRunnerDependencies = {},
): Promise<ClaudeRunnerResult> {
  if (!isSafeClaudeArtifactName(input.artifactName)) {
    throw new Error(
      "artifactName must be a basename containing only letters, numbers, dots, underscores, and hyphens",
    );
  }
  const now = dependencies.now ?? (() => new Date());
  const env = input.env ?? process.env;
  const runCommand = dependencies.runCommand ?? execFileClaudeRunnerCommand;
  const cmuxSpawnBin =
    input.cmuxSpawnBin ?? env.CMUX_SPAWN_BIN ?? DEFAULT_CMUX_SPAWN_BIN;
  const model = input.model ?? DEFAULT_MODEL;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const phase = input.phase ?? input.purpose;
  const laneId = input.laneId ?? `claude-${input.purpose}`;
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const workspace = resolve(input.workspace);
  const promptFile = resolve(input.promptFile);
  const artifactDir = resolve(input.artifactDir);
  const artifactName = input.artifactName;
  const startedAt = now().toISOString();

  await mkdir(artifactDir, { recursive: true });
  const sourceVisibility = await inspectSourceVisibility({
    workspace,
    promptFile,
    sourcePaths: input.sourcePaths ?? [],
  });
  const promptSha256 = await fileSha256(promptFile);
  const attempts: ClaudeRunnerAttempt[] = [];
  const resultJsonPath = resolve(artifactDir, `${artifactName}.result.json`);

  if (sourceVisibility.status !== "ok") {
    const result: ClaudeRunnerResult = {
      schemaVersion: 1,
      status: "failed",
      purpose: input.purpose,
      model,
      profile,
      workspace,
      promptFile,
      promptSha256,
      artifactDir,
      artifactName,
      artifactPath: null,
      resultJsonPath,
      cmuxSpawnBin,
      laneId,
      phase,
      startedAt,
      completedAt: now().toISOString(),
      sourceVisibility,
      attempts,
      validationErrors: ["one or more declared source paths are unreadable"],
      usage: null,
      message: "source visibility validation failed before Claude invocation",
    };
    await writeJsonFile(resultJsonPath, result);
    return result;
  }

  const preflight = await runCommand(
    cmuxSpawnBin,
    ["preflight", "--caffeinate", "--json"],
    {
      cwd: workspace,
      env: { ...env },
      timeoutMs: 30_000,
    },
  );
  if (preflight.exitCode !== 0) {
    const result: ClaudeRunnerResult = {
      schemaVersion: 1,
      status: "failed",
      purpose: input.purpose,
      model,
      profile,
      workspace,
      promptFile,
      promptSha256,
      artifactDir,
      artifactName,
      artifactPath: null,
      resultJsonPath,
      cmuxSpawnBin,
      laneId,
      phase,
      startedAt,
      completedAt: now().toISOString(),
      sourceVisibility,
      attempts,
      validationErrors: ["cmux-spawn preflight failed"],
      usage: null,
      message:
        preflight.stderr.trim() !== ""
          ? preflight.stderr.trim()
          : preflight.stdout.trim(),
    };
    await writeJsonFile(resultJsonPath, result);
    return result;
  }

  let currentPromptFile = promptFile;
  let currentArtifactName = artifactName;
  let finalStatus: ClaudeRunnerStatus = "failed";
  let artifactPath: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let message = "";
  let validationErrors: string[] = [];
  const maxAttempts = input.retryOnInvalid === true ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = await invokeCmuxRun({
      cmuxSpawnBin,
      workspace,
      promptFile: currentPromptFile,
      artifactDir,
      artifactName: currentArtifactName,
      model,
      profile,
      laneId: attempt === 1 ? laneId : `${laneId}-repair-${attempt}`,
      phase,
      timeoutSeconds,
      env,
      runCommand,
    });
    const cmux = parseCmuxStdout(run.stdout);
    const rawArtifactPath =
      typeof cmux.artifact_path === "string"
        ? cmux.artifact_path
        : resolve(artifactDir, `${currentArtifactName}.md`);
    const artifactPathValidation = await validateArtifactPathWithinDir(
      artifactDir,
      rawArtifactPath,
    );
    const currentArtifactPath = artifactPathValidation.artifactPath;
    const currentStatusPath =
      typeof cmux.status_path === "string"
        ? cmux.status_path
        : resolve(artifactDir, `${currentArtifactName}.status.json`);
    const currentCliJsonPath = resolve(
      artifactDir,
      `${currentArtifactName}.cli.json`,
    );
    await writeFile(
      currentCliJsonPath,
      run.stdout.trim() === "" ? "{}\n" : `${run.stdout.trim()}\n`,
      "utf8",
    );

    usage = cmux.usage ?? null;
    artifactPath = currentArtifactPath;
    message = cmux.message ?? run.stderr;
    const laneState =
      cmux.state ?? (run.exitCode === 0 ? "complete" : "failed");
    validationErrors =
      artifactPathValidation.validationErrors.length > 0
        ? artifactPathValidation.validationErrors
        : run.exitCode === 0 && laneState === "complete"
          ? await validateClaudeArtifact(currentArtifactPath, input.validation)
          : [`cmux-spawn lane ended ${laneState}`];

    attempts.push({
      attempt,
      artifactName: currentArtifactName,
      artifactPath: currentArtifactPath,
      cliJsonPath: currentCliJsonPath,
      statusPath: currentStatusPath,
      state: laneState,
      exitCode: run.exitCode,
      validationErrors,
    });

    if (run.exitCode !== 0 || laneState !== "complete") {
      finalStatus = laneState === "timed_out" ? "timed_out" : "failed";
      break;
    }
    if (validationErrors.length === 0) {
      finalStatus = "passed";
      break;
    }
    finalStatus = "invalid_artifact";
    if (artifactPathValidation.validationErrors.length > 0) {
      break;
    }
    if (attempt < maxAttempts) {
      currentArtifactName = `${artifactName}-repair-${attempt + 1}`;
      currentPromptFile = resolve(
        artifactDir,
        `${currentArtifactName}.prompt.md`,
      );
      await writeFile(
        currentPromptFile,
        await buildRepairPrompt(
          promptFile,
          currentArtifactPath,
          validationErrors,
        ),
        "utf8",
      );
    }
  }

  const result: ClaudeRunnerResult = {
    schemaVersion: 1,
    status: finalStatus,
    purpose: input.purpose,
    model,
    profile,
    workspace,
    promptFile,
    promptSha256,
    artifactDir,
    artifactName,
    artifactPath,
    resultJsonPath,
    cmuxSpawnBin,
    laneId,
    phase,
    startedAt,
    completedAt: now().toISOString(),
    sourceVisibility,
    attempts,
    validationErrors,
    usage,
    message,
  };
  await writeJsonFile(resultJsonPath, result);
  return result;
}

export async function validateClaudeArtifact(
  artifactPath: string,
  validation: ClaudeRunnerValidationConfig = {},
): Promise<string[]> {
  const errors: string[] = [];
  let text: string;
  let bytes = 0;
  try {
    const stats = await stat(artifactPath);
    bytes = stats.size;
    text = await readFile(artifactPath, "utf8");
  } catch (error) {
    return [
      `artifact is not readable at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const minBytes = validation.minBytes ?? DEFAULT_MIN_ARTIFACT_BYTES;
  if (bytes < minBytes) {
    errors.push(`artifact is too small (${bytes} bytes < ${minBytes} bytes)`);
  }

  const firstHeading = validation.requireFirstHeading;
  if (firstHeading !== undefined) {
    const firstNonEmpty = text
      .split(/\r?\n/)
      .find((line) => line.trim() !== "");
    if (
      firstNonEmpty === undefined ||
      !headingLineMatches(firstNonEmpty, firstHeading)
    ) {
      errors.push(`artifact first heading must be "${firstHeading}"`);
    }
  }

  for (const heading of validation.requiredHeadings ?? []) {
    if (!containsMarkdownHeading(text, heading)) {
      errors.push(`artifact is missing required heading "${heading}"`);
    }
  }

  if (
    validation.requireSourceReadStatus === true &&
    !/source[_ -]?read[_ -]?status/i.test(text)
  ) {
    errors.push("artifact is missing SOURCE_READ_STATUS evidence");
  }

  const verdictEnums = validation.verdictEnums ?? [];
  if (verdictEnums.length > 0) {
    const verdict = extractVerdictEnum(text);
    if (verdict === null) {
      errors.push("artifact is missing a verdict enum");
    } else if (!verdictEnums.includes(verdict)) {
      errors.push(
        `artifact verdict "${verdict}" is not one of ${verdictEnums.join(", ")}`,
      );
    }
  }

  return errors;
}

export function extractVerdictEnum(text: string): string | null {
  const match = /verdict(?:\s+enum)?\s*[:：]\s*`?([a-z][a-z0-9_-]+)`?/i.exec(
    text,
  );
  return match?.[1] === undefined ? null : match[1].trim().toLowerCase();
}

async function inspectSourceVisibility(input: {
  workspace: string;
  promptFile: string;
  sourcePaths: readonly string[];
}): Promise<ClaudeRunnerSourceVisibility> {
  const workspacePath = resolve(input.workspace);
  const canonicalWorkspace = await realpathOrSelf(workspacePath);
  const promptSource = await inspectPromptFile(
    input.promptFile,
    canonicalWorkspace,
  );
  const declaredSources = await Promise.all(
    input.sourcePaths.map(async (sourcePath) => {
      const resolvedPath = resolve(workspacePath, sourcePath);
      const canonicalPath = await realpathOrSelf(resolvedPath);
      const insideWorkspace = isInside(canonicalWorkspace, canonicalPath);
      if (!insideWorkspace) {
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: null,
          bytes: null,
          readable: false,
          insideWorkspace,
          error: "source path is outside workspace",
        };
      }
      try {
        const stats = await stat(resolvedPath);
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: await fileSha256(resolvedPath),
          bytes: stats.size,
          readable: true,
          insideWorkspace,
          error: null,
        };
      } catch (error) {
        return {
          kind: "source" as const,
          path: sourcePath,
          resolvedPath: canonicalPath,
          sha256: null,
          bytes: null,
          readable: false,
          insideWorkspace,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const sources = [promptSource, ...declaredSources];
  return {
    status:
      promptSource.readable &&
      declaredSources.every(
        (source) => source.readable && source.insideWorkspace,
      )
        ? "ok"
        : "invalid_source_path",
    workspace: input.workspace,
    sources,
  };
}

async function inspectPromptFile(
  promptFile: string,
  canonicalWorkspace: string,
): Promise<{
  kind: "prompt";
  path: string;
  resolvedPath: string;
  sha256: string | null;
  bytes: number | null;
  readable: boolean;
  insideWorkspace: boolean;
  error: string | null;
}> {
  const resolvedPath = resolve(promptFile);
  const canonicalPath = await realpathOrSelf(resolvedPath);
  const insideWorkspace = isInside(canonicalWorkspace, canonicalPath);
  try {
    const stats = await stat(resolvedPath);
    return {
      kind: "prompt",
      path: promptFile,
      resolvedPath: canonicalPath,
      sha256: await fileSha256(resolvedPath),
      bytes: stats.size,
      readable: true,
      insideWorkspace,
      error: null,
    };
  } catch (error) {
    return {
      kind: "prompt",
      path: promptFile,
      resolvedPath: canonicalPath,
      sha256: null,
      bytes: null,
      readable: false,
      insideWorkspace,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function validateArtifactPathWithinDir(
  artifactDir: string,
  candidatePath: string,
): Promise<{ artifactPath: string; validationErrors: string[] }> {
  const resolvedArtifactDir = resolve(artifactDir);
  const artifactPath = resolve(resolvedArtifactDir, candidatePath);
  const canonicalArtifactDir = await realpathOrSelf(resolvedArtifactDir);
  const canonicalArtifactPath = await realpathOrSelf(artifactPath);
  if (!isInside(canonicalArtifactDir, canonicalArtifactPath)) {
    return {
      artifactPath,
      validationErrors: [
        `artifact_path resolves outside artifact dir: ${candidatePath}`,
      ],
    };
  }
  return { artifactPath, validationErrors: [] };
}

async function invokeCmuxRun(input: {
  cmuxSpawnBin: string;
  workspace: string;
  promptFile: string;
  artifactDir: string;
  artifactName: string;
  model: string;
  profile: string;
  laneId: string;
  phase: string;
  timeoutSeconds: number;
  env: NodeJS.ProcessEnv;
  runCommand: ClaudeRunnerCommand;
}): Promise<ClaudeRunnerCommandResult> {
  return input.runCommand(
    input.cmuxSpawnBin,
    [
      "run",
      "--agent",
      "claude",
      "--model",
      input.model,
      "--profile",
      input.profile,
      "--workspace",
      input.workspace,
      "--prompt-file",
      input.promptFile,
      "--artifact-dir",
      input.artifactDir,
      "--artifact-name",
      input.artifactName,
      "--lane-id",
      input.laneId,
      "--phase",
      input.phase,
      "--timeout-seconds",
      String(input.timeoutSeconds),
    ],
    {
      cwd: input.workspace,
      env: { ...input.env },
      timeoutMs: (input.timeoutSeconds + 60) * 1_000,
    },
  );
}

export async function execFileClaudeRunnerCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<ClaudeRunnerCommandResult> {
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : (err.message ?? String(error)),
    };
  }
}

function parseCmuxStdout(stdout: string): CmuxRunStdout {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    return isRecord(parsed) ? (parsed as CmuxRunStdout) : {};
  } catch {
    return {};
  }
}

async function buildRepairPrompt(
  originalPromptFile: string,
  artifactPath: string,
  validationErrors: readonly string[],
): Promise<string> {
  const original = await readFile(originalPromptFile, "utf8");
  let artifact = "";
  try {
    artifact = await readFile(artifactPath, "utf8");
  } catch {
    artifact = "";
  }
  const artifactFence = markdownFenceFor(artifact);
  return [
    original,
    "",
    "## Artifact Repair Required",
    "",
    "Your previous artifact failed validation. Return a complete replacement artifact that fixes every validation error.",
    "",
    "Validation errors:",
    ...validationErrors.map((error) => `- ${error}`),
    "",
    "Previous artifact:",
    "",
    `${artifactFence}markdown`,
    artifact,
    artifactFence,
    "",
  ].join("\n");
}

function markdownFenceFor(content: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function containsMarkdownHeading(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => headingLineMatches(line, heading));
}

function headingLineMatches(line: string, heading: string): boolean {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
  if (match?.[2] === undefined) {
    return false;
  }
  return normalizeHeading(match[2]) === normalizeHeading(heading);
}

function normalizeHeading(value: string): string {
  return value
    .replaceAll(/[`*_]/g, "")
    .replace(/[:.!?–—-]\s*$/u, "")
    .trim()
    .toLowerCase();
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
