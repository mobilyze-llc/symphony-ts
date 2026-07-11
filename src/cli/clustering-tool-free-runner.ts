import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  workspace: string;
  artifactDir: string;
  artifactName: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runProcess?: ToolFreePlannerProcess;
}): (prompt: string) => Promise<PlannerRunResult> {
  return async (prompt) => {
    await mkdir(input.artifactDir, { recursive: true });
    await writeFile(
      join(input.artifactDir, `${input.artifactName}.prompt.md`),
      prompt,
      "utf8",
    );
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const invocation = resolveToolFreeInvocation(input);
    let result: ToolFreePlannerProcessResult;
    try {
      result = await (input.runProcess ?? runToolFreePlannerProcess)({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: withoutExternalToolCredentials(input.env),
        stdin: prompt,
        timeoutMs,
      });
    } catch (error) {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.command} process failed: ${bounded(errorDetail(error))}`,
      };
    }
    if (result.status === "timed_out") {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.command} timed out after ${timeoutMs}ms`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.command} exited ${result.exitCode}: ${bounded(result.stderr)}`,
      };
    }
    const markdown = (await invocation.readOutput(result)).trim();
    if (markdown === "") {
      return {
        status: "unavailable",
        detail: `tool-free ${invocation.command} returned empty output`,
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

export type ToolFreeIsolationTier = "tool_free" | "reduced_sandbox";

/**
 * Claude runs truly tool-free (`--tools ""`); codex has no disable-all-tools
 * flag, so `openai/*` models run under a read-only sandbox that still permits
 * model-generated shell reads. Rows produced at `reduced_sandbox` are for
 * cross-model comparison only and are not gate-authoritative.
 */
export function resolveToolFreeIsolationTier(
  model: string,
): ToolFreeIsolationTier {
  return model.startsWith("openai/") ? "reduced_sandbox" : "tool_free";
}

interface ToolFreeInvocation {
  command: string;
  args: string[];
  cwd: string;
  readOutput: (
    result: Extract<ToolFreePlannerProcessResult, { status: "completed" }>,
  ) => Promise<string>;
}

function resolveToolFreeInvocation(input: {
  model: string;
  workspace: string;
  artifactDir: string;
  artifactName: string;
}): ToolFreeInvocation {
  const openaiModel = input.model.startsWith("openai/")
    ? input.model.slice("openai/".length)
    : null;
  if (openaiModel === null) {
    return {
      command: "claude",
      args: toolFreeClaudeArgs(input.model),
      cwd: input.workspace,
      readOutput: async (result) => result.stdout,
    };
  }
  // OpenAI models run through `codex exec`. This is a reduced-isolation
  // approximation of the claude tool-free boundary: codex has no
  // disable-all-tools flag, so isolation comes from the read-only sandbox, a
  // neutral cwd (the artifact dir, which holds only this run's prompt and
  // output), an ephemeral session, and ignored user config/rules. The final
  // message is read from --output-last-message rather than stdout, which
  // carries progress logs.
  const lastMessagePath = join(
    input.artifactDir,
    `${input.artifactName}.codex-last-message.md`,
  );
  return {
    command: "codex",
    args: [
      "exec",
      "-m",
      openaiModel,
      "-s",
      "read-only",
      "-C",
      input.artifactDir,
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--output-last-message",
      lastMessagePath,
    ],
    cwd: input.artifactDir,
    readOutput: async (result) => {
      try {
        return await readFile(lastMessagePath, "utf8");
      } catch {
        return result.stdout;
      }
    },
  };
}

function toolFreeClaudeArgs(model: string): string[] {
  return [
    "--print",
    "--output-format",
    "text",
    "--model",
    model,
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: "timed_out",
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
        return;
      }
      resolve({
        status: "completed",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input.stdin);
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
