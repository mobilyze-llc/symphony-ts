import { spawn } from "node:child_process";

import type {
  ContinuousFeedbackEvent,
  ContinuousFeedbackLane,
  Issue,
} from "../domain/model.js";
import type {
  ContinuousFeedbackFindingInput,
  ContinuousFeedbackReviewResult,
} from "./continuous-feedback.js";
import { getDiff } from "./gate-handler.js";

const DEFAULT_FEEDBACK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DIFF_CHARS = 12_000;

export interface ContinuousFeedbackProviderInput {
  issue: Issue;
  event: ContinuousFeedbackEvent;
  stageName: string | null;
  workerLane: ContinuousFeedbackLane;
  reviewerLane: ContinuousFeedbackLane;
}

export interface ContinuousFeedbackCommandInput {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
}

export interface ContinuousFeedbackCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ContinuousFeedbackCommandExecutor = (
  input: ContinuousFeedbackCommandInput,
) => Promise<ContinuousFeedbackCommandResult>;

export interface ContinuousFeedbackProviderOptions {
  resolveWorkspacePath: (issueId: string) => string;
  readDiff?: (workspacePath: string, maxChars?: number) => string;
  runCommand?: ContinuousFeedbackCommandExecutor;
  timeoutMs?: number;
}

export function createContinuousFeedbackProvider(
  options: ContinuousFeedbackProviderOptions,
) {
  const readDiff = options.readDiff ?? getDiff;
  const runCommand = options.runCommand ?? runContinuousFeedbackCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FEEDBACK_TIMEOUT_MS;

  return async (
    input: ContinuousFeedbackProviderInput,
  ): Promise<ContinuousFeedbackReviewResult> => {
    const workspacePath = options.resolveWorkspacePath(input.issue.id);
    const diff = readDiff(workspacePath, DEFAULT_MAX_DIFF_CHARS);
    const prompt = buildContinuousFeedbackPrompt({ ...input, diff });
    const command = input.reviewerLane.runner;
    const args = buildContinuousFeedbackCommandArgs(input.reviewerLane, prompt);
    const result = await runCommand({
      command,
      args,
      cwd: workspacePath,
      prompt,
      timeoutMs,
    });

    if (result.exitCode !== 0) {
      return {
        summary: summarizeProviderFailure(result),
        findings: [],
      };
    }

    return parseContinuousFeedbackOutput(result.stdout);
  };
}

export async function runContinuousFeedbackCommand(
  input: ContinuousFeedbackCommandInput,
): Promise<ContinuousFeedbackCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      settled = true;
      resolve({
        stdout,
        stderr:
          stderr.trim() === ""
            ? `Continuous feedback command timed out after ${input.timeoutMs}ms.`
            : stderr,
        exitCode: null,
      });
    }, input.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      settled = true;
      resolve({
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      settled = true;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function buildContinuousFeedbackCommandArgs(
  lane: ContinuousFeedbackLane,
  prompt: string,
): string[] {
  const baseArgs = ["--no-session", "--print", "--no-tools"];
  const modelArgs = lane.model === null ? [] : ["--model", lane.model];
  return [...baseArgs, ...modelArgs, prompt];
}

function buildContinuousFeedbackPrompt(
  input: ContinuousFeedbackProviderInput & { diff: string },
): string {
  const lines = [
    "You are running a cheap continuous feedback lane for Symphony.",
    "This lane is non-authoritative: surface inner-loop rework advice only; do not decide whether the issue can merge.",
    "",
    "## Issue",
    `- Identifier: ${input.issue.identifier}`,
    `- Title: ${input.issue.title}`,
    `- Event: ${input.event}`,
    `- Stage: ${input.stageName ?? "unscoped"}`,
    `- Worker lane: ${formatLane(input.workerLane)}`,
    `- Reviewer lane: ${formatLane(input.reviewerLane)}`,
    ...(input.issue.description === null
      ? []
      : [`- Description: ${input.issue.description}`]),
    "",
    "## Code Changes",
    input.diff.trim() === "" ? "No diff was available." : "```diff",
    ...(input.diff.trim() === "" ? [] : [input.diff, "```"]),
    "",
    "## Finding policy (SYMPH-378)",
    "Report a finding ONLY when it carries signal the worker has not already ACTED on:",
    "- a confirmed blocker: something demonstrably broken in the diff, cited with file (and line when possible);",
    "- a concrete correction: what to change and where, grounded in the diff;",
    '- a scope stop: the diff implements the wrong item or mutates files outside its task (use severity "blocking");',
    "- a previously reported finding that is STILL unaddressed — re-report it with the same signature (this is not restatement; it keeps the finding alive).",
    "Never restate the task or its requirements. Never add speculative requirements. Never raise the proof bar mid-flight — proof requirements come from the frozen acceptance criteria only. For cross-cutting findings, cite the most representative file. An EMPTY findings array means the checkpoint is genuinely clean: previously reported findings are considered resolved. Ungrounded advisory findings are suppressed by the harness and waste the checkpoint.",
    "",
    "## Output",
    "Return a single JSON object and nothing else:",
    '{"summary":"short assessment","findings":[{"signature":"stable-id","title":"short title","detail":"actionable detail","severity":"warning","file":"src/file.ts","line":12}]}',
    "Use an empty findings array when the checkpoint is clean.",
    'Allowed severities: "info", "warning", "blocking".',
  ];
  return lines.join("\n");
}

function parseContinuousFeedbackOutput(
  raw: string,
): ContinuousFeedbackReviewResult {
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return {
      summary: "Continuous feedback output was not parseable.",
      findings: [],
    };
  }
  const summary =
    typeof parsed.summary === "string" ? parsed.summary.trim() : null;
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  return {
    summary:
      summary === null || summary === ""
        ? "Continuous feedback completed."
        : summary,
    findings: rawFindings.flatMap((finding) =>
      normalizeContinuousFeedbackFinding(finding),
    ),
  };
}

function normalizeContinuousFeedbackFinding(
  value: unknown,
): ContinuousFeedbackFindingInput[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.title !== "string" || record.title.trim() === "") {
    return [];
  }
  const severity =
    record.severity === "info" ||
    record.severity === "warning" ||
    record.severity === "blocking"
      ? record.severity
      : "warning";
  return [
    {
      signature: typeof record.signature === "string" ? record.signature : null,
      title: record.title,
      detail: typeof record.detail === "string" ? record.detail : null,
      severity,
      // Empty/whitespace file is no file — it must not count as grounding
      // for the injection-hygiene policy (SYMPH-378).
      file:
        typeof record.file === "string" && record.file.trim() !== ""
          ? record.file
          : null,
      line: typeof record.line === "number" ? record.line : null,
    },
  ];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, raw]) {
    if (candidate === undefined) {
      continue;
    }
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end < start) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

function summarizeProviderFailure(
  result: ContinuousFeedbackCommandResult,
): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const code =
    result.exitCode === null
      ? "without an exit code"
      : `with ${result.exitCode}`;
  return detail === ""
    ? `Continuous feedback provider exited ${code}.`
    : `Continuous feedback provider exited ${code}: ${detail}`;
}

function formatLane(lane: ContinuousFeedbackLane): string {
  return `${lane.runner}${lane.model === null ? "" : `/${lane.model}`} (${lane.role})`;
}
