import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlannerRunResult } from "../agent/triage-planner.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const EXTERNAL_TOOL_CREDENTIAL_PREFIXES = [
  "LINEAR_",
  "SYMPHONY_LINEAR_",
  "GH_",
  "GITHUB_",
  "SLACK_",
  "SYMPHONY_SLACK_",
] as const;
const CREDENTIAL_MARKER =
  /(?:^|_)(?:TOKEN|PAT|API_KEY|SECRET|PRIVATE_KEY|CLIENT_SECRET|WEBHOOK(?:_URL)?)(?:_|$)/;

interface ToolFreePlannerProcessInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}

type ToolFreePlannerProcessResult =
  | {
      status: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | { status: "timed_out"; stdout: string; stderr: string };

type ToolFreePlannerProcess = (
  input: ToolFreePlannerProcessInput,
) => Promise<ToolFreePlannerProcessResult>;

export function createToolFreeClusteringPlannerRunner(input: {
  model: string;
  /**
   * Explicit reasoning/thinking level for this run (SYMPH-1128). Threaded to the
   * spawned CLI so the clustering score is not confounded by an inherited CLI
   * default: `--thinking <level>` on the claude boundary, a
   * `model_reasoning_effort` override on the codex boundary.
   */
  reasoningLevel: string;
  workspace: string;
  artifactDir: string;
  artifactName: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runProcess?: ToolFreePlannerProcess;
}): (prompt: string) => Promise<PlannerRunResult> {
  const invocation = resolveToolFreeInvocation(
    input.model,
    input.reasoningLevel,
  );
  return async (prompt) => {
    await mkdir(input.artifactDir, { recursive: true });
    await writeFile(
      join(input.artifactDir, `${input.artifactName}.prompt.md`),
      prompt,
      "utf8",
    );
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let result: ToolFreePlannerProcessResult;
    try {
      result = await (input.runProcess ?? runToolFreePlannerProcess)({
        command: invocation.command,
        args: invocation.args,
        cwd: input.workspace,
        env: withoutExternalToolCredentials(input.env),
        stdin: prompt,
        timeoutMs,
      });
    } catch (error) {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.label} process failed: ${bounded(errorDetail(error))}`,
      };
    }
    if (result.status === "timed_out") {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.label} timed out after ${timeoutMs}ms`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.label} exited ${result.exitCode}: ${bounded(result.stderr)}`,
      };
    }
    const markdown = result.stdout.trim();
    if (markdown === "") {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.label} returned empty output`,
      };
    }
    await writeFile(
      join(input.artifactDir, `${input.artifactName}.md`),
      `${markdown}\n`,
      "utf8",
    );
    return { status: "ok", markdown };
  };
}

interface ToolFreeInvocation {
  command: string;
  args: string[];
  label: string;
}

const CODEX_PROVIDER_PREFIXES = new Set([
  "codex",
  "codex-cli",
  "codex-app-server",
  "openai",
  "openai-codex",
]);

/**
 * Pick the tool-free CLI for the model alias and pin its reasoning level.
 * Anthropic aliases spawn `claude --print`; openai/codex aliases (for example
 * `openai/gpt-5.6-sol`) spawn `codex exec`. Both paths receive the explicit
 * level so clustering scores are controlled rather than inheriting a CLI default.
 */
export function resolveToolFreeInvocation(
  model: string,
  reasoningLevel: string,
): ToolFreeInvocation {
  if (isCodexModel(model)) {
    return {
      command: "codex",
      args: toolFreeCodexArgs(codexModelId(model), reasoningLevel),
      label: "Codex",
    };
  }
  return {
    command: "claude",
    args: toolFreeClaudeArgs(model, reasoningLevel),
    label: "Claude",
  };
}

function isCodexModel(model: string): boolean {
  const slash = model.indexOf("/");
  if (slash < 0) {
    return CODEX_PROVIDER_PREFIXES.has(model.trim().toLowerCase());
  }
  return CODEX_PROVIDER_PREFIXES.has(
    model.slice(0, slash).trim().toLowerCase(),
  );
}

function codexModelId(model: string): string {
  const slash = model.indexOf("/");
  return slash < 0 ? model : model.slice(slash + 1);
}

function toolFreeClaudeArgs(model: string, reasoningLevel: string): string[] {
  return [
    "--print",
    "--output-format",
    "text",
    "--model",
    model,
    "--thinking",
    reasoningLevel,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--setting-sources",
    "",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
  ];
}

function toolFreeCodexArgs(modelId: string, reasoningLevel: string): string[] {
  return [
    "exec",
    "--ignore-user-config",
    "--config",
    `model_reasoning_effort="${reasoningLevel}"`,
    "--model",
    modelId,
  ];
}

function withoutExternalToolCredentials(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isExternalToolCredentialName(name)),
  );
}

function isExternalToolCredentialName(name: string): boolean {
  const prefix = EXTERNAL_TOOL_CREDENTIAL_PREFIXES.find((candidate) =>
    name.startsWith(candidate),
  );
  return (
    prefix !== undefined && CREDENTIAL_MARKER.test(name.slice(prefix.length))
  );
}

async function runToolFreePlannerProcess(
  input: ToolFreePlannerProcessInput,
): Promise<ToolFreePlannerProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGKILL");
      reject(error);
    };
    const resolveOnce = (result: ToolFreePlannerProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once("error", rejectOnce);
    child.stdin.once("error", (error) => {
      if (timedOut) return;
      rejectOnce(error);
    });
    child.once("close", (code) => {
      if (timedOut) {
        resolveOnce({
          status: "timed_out",
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        return;
      }
      resolveOnce({
        status: "completed",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    try {
      child.stdin.end(input.stdin);
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 2_000)}…`;
}
