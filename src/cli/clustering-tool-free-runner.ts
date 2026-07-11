import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlannerRunResult } from "../agent/triage-planner.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const SENSITIVE_TOOL_CREDENTIAL_PATTERNS = [
  /^LINEAR_(?:API_KEY|TOKEN|SECRET)$/,
  /^SYMPHONY_LINEAR_.*(?:TOKEN|SECRET|KEY)$/,
  /^GH_(?:TOKEN|ENTERPRISE_TOKEN)$/,
  /^GITHUB_.*(?:TOKEN|SECRET|PRIVATE_KEY|CLIENT_SECRET)$/,
  /^SLACK_.*(?:TOKEN|SECRET|WEBHOOK(?:_URL)?)$/,
  /^SYMPHONY_SLACK_.*(?:TOKEN|SECRET|WEBHOOK(?:_URL)?)$/,
] as const;

interface ToolFreePlannerProcessInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}

interface ToolFreePlannerProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
    const result = await (input.runProcess ?? runToolFreePlannerProcess)({
      command: "claude",
      args: toolFreeClaudeArgs(input.model),
      cwd: input.workspace,
      env: withoutExternalToolCredentials(input.env),
      stdin: prompt,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        detail: `tool-free Claude exited ${result.exitCode}: ${bounded(result.stderr)}`,
      };
    }
    const markdown = result.stdout.trim();
    if (markdown === "") {
      return {
        status: "unavailable",
        detail: "tool-free Claude returned empty output",
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
    Object.entries(env).filter(
      ([name]) =>
        !SENSITIVE_TOOL_CREDENTIAL_PATTERNS.some((pattern) =>
          pattern.test(name),
        ),
    ),
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
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input.stdin);
  });
}

function bounded(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 2_000)}…`;
}
