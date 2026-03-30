import { spawn } from "node:child_process";

import { ERROR_CODES } from "../errors/codes.js";

const DEFAULT_OUTPUT_LIMIT = 4_000;

export const WORKSPACE_HOOK_NAMES = [
  "afterCreate",
  "beforeRun",
  "afterRun",
  "beforeRemove",
] as const;

export type WorkspaceHookName = (typeof WORKSPACE_HOOK_NAMES)[number];

export interface HookCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface WorkspaceHookLogEntry {
  level: "info" | "warn" | "error";
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out";
  hook: WorkspaceHookName;
  workspacePath: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  stdout?: string;
  stderr?: string;
}

export type WorkspaceHookLogger = (entry: WorkspaceHookLogEntry) => void;

export interface WorkspaceHookRunnerConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export type HookCommandExecutor = (
  script: string,
  options: {
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string> | undefined;
  },
) => Promise<HookCommandResult>;

export interface RunWorkspaceHookOptions {
  name: WorkspaceHookName;
  workspacePath: string;
  env?: Record<string, string> | undefined;
}

export class WorkspaceHookError extends Error {
  readonly code: string;
  readonly hook: WorkspaceHookName;
  readonly workspacePath: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    code: string;
    message: string;
    hook: WorkspaceHookName;
    workspacePath: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "WorkspaceHookError";
    this.code = input.code;
    this.hook = input.hook;
    this.workspacePath = input.workspacePath;
    this.exitCode = input.exitCode ?? null;
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
  }
}

export class WorkspaceHookRunner {
  readonly #config: WorkspaceHookRunnerConfig;
  readonly #execute: HookCommandExecutor;
  readonly #log: WorkspaceHookLogger;
  readonly #outputLimit: number;

  constructor(input: {
    config: WorkspaceHookRunnerConfig;
    execute?: HookCommandExecutor;
    log?: WorkspaceHookLogger;
    outputLimit?: number;
  }) {
    this.#config = input.config;
    this.#execute = input.execute ?? executeShellHook;
    this.#log = input.log ?? (() => {});
    this.#outputLimit = input.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  }

  async run(options: RunWorkspaceHookOptions): Promise<boolean> {
    const script = this.#config[options.name];
    if (!script) {
      return false;
    }

    const startedAt = Date.now();
    this.#log({
      level: "info",
      event: "workspace_hook_started",
      hook: options.name,
      workspacePath: options.workspacePath,
    });

    try {
      const result = await this.#execute(script, {
        cwd: options.workspacePath,
        timeoutMs: this.#config.timeoutMs,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      const durationMs = Date.now() - startedAt;

      if (result.exitCode !== 0) {
        const error = new WorkspaceHookError({
          code: ERROR_CODES.hookFailed,
          message: `Workspace hook '${options.name}' failed with exit code ${result.exitCode ?? "unknown"}.`,
          hook: options.name,
          workspacePath: options.workspacePath,
          exitCode: result.exitCode,
          stdout: truncateOutput(result.stdout, this.#outputLimit),
          stderr: truncateOutput(result.stderr, this.#outputLimit),
        });
        this.#log({
          level: "error",
          event: "workspace_hook_failed",
          hook: options.name,
          workspacePath: options.workspacePath,
          durationMs,
          exitCode: error.exitCode,
          errorCode: error.code,
          stdout: error.stdout,
          stderr: error.stderr,
        });
        throw error;
      }

      this.#log({
        level: "info",
        event: "workspace_hook_completed",
        hook: options.name,
        workspacePath: options.workspacePath,
        durationMs,
        exitCode: result.exitCode,
        stdout: truncateOutput(result.stdout, this.#outputLimit),
        stderr: truncateOutput(result.stderr, this.#outputLimit),
      });
      return true;
    } catch (error) {
      if (error instanceof WorkspaceHookError) {
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      const hookError = new WorkspaceHookError({
        code: ERROR_CODES.hookTimedOut,
        message: `Workspace hook '${options.name}' timed out after ${this.#config.timeoutMs} ms.`,
        hook: options.name,
        workspacePath: options.workspacePath,
        cause: error,
      });
      this.#log({
        level: "error",
        event: "workspace_hook_timed_out",
        hook: options.name,
        workspacePath: options.workspacePath,
        durationMs,
        errorCode: hookError.code,
      });
      throw hookError;
    }
  }

  async runBestEffort(options: RunWorkspaceHookOptions): Promise<boolean> {
    try {
      return await this.run(options);
    } catch {
      return false;
    }
  }
}

export async function executeShellHook(
  script: string,
  options: {
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string> | undefined;
  },
): Promise<HookCommandResult> {
  return await new Promise<HookCommandResult>((resolve, reject) => {
    const child = spawn("sh", ["-lc", script], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(`Workspace hook timed out after ${options.timeoutMs} ms.`),
      );
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function truncateOutput(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[truncated]`;
}
