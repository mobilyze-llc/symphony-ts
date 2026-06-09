import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_CMUX_SPAWN_BIN =
  "/Users/ericlitman/projects/crucible/bin/cmux-spawn";
const DEFAULT_TIMEOUT_SECONDS = 1_800;

export type HeadlessGateVerdict = "pass" | "fail" | "error";
export type HeadlessLaneState =
  | "complete"
  | "failed"
  | "timed_out"
  | "stopped"
  | "error";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface HeadlessReviewerLaneConfig {
  laneId: string;
  agent: "claude" | "pi";
  role: string;
  model: string;
  provider?: string;
  thinking?: "low" | "medium" | "high";
  tools?: string;
  allowedTools?: string;
}

export interface HeadlessCouncilGateInput {
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
  reviewerLanes?: readonly HeadlessReviewerLaneConfig[];
  codexLead?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ReviewContext {
  issueId: string;
  repo: string | null;
  prNumber: number | null;
  baseRef: string;
  headRef: string;
  diff: string;
}

export interface HeadlessLaneResult {
  laneId: string;
  agent: "claude" | "pi" | "codex";
  role: string;
  model: string;
  state: HeadlessLaneState;
  verdict: HeadlessGateVerdict;
  artifactPath: string | null;
  promptPath: string | null;
  stderrPath: string | null;
  cliJsonPath: string | null;
  independentReviewer: boolean;
  message: string | null;
}

export interface HeadlessCouncilGateResult {
  schemaVersion: 1;
  issueId: string;
  verdict: HeadlessGateVerdict;
  startedAt: string;
  completedAt: string;
  pr: {
    repo: string | null;
    number: number | null;
    baseRef: string | null;
    headRef: string | null;
  };
  lanes: HeadlessLaneResult[];
  degradedConditions: string[];
  artifactPaths: {
    artifactDir: string;
    diff: string | null;
    resultJson: string;
    councilReport: string;
  };
  summary: string;
}

interface HeadlessCouncilGateDependencies {
  runCommand?: CommandRunner;
  now?: () => Date;
}

interface CmuxRunJson {
  state?: string;
  artifact_path?: string;
  message?: string;
}

interface ParsedArtifactVerdict {
  verdict: HeadlessGateVerdict;
  message: string | null;
}

export async function runHeadlessCouncilGate(
  input: HeadlessCouncilGateInput,
  dependencies: HeadlessCouncilGateDependencies = {},
): Promise<HeadlessCouncilGateResult> {
  const now = dependencies.now ?? (() => new Date());
  const runCommand = dependencies.runCommand ?? execFileCommand;
  const env = input.env ?? process.env;
  const artifactDir = resolve(input.artifactDir);
  const workspace = resolve(input.workspace);
  const cmuxSpawnBin =
    input.cmuxSpawnBin ?? env.CMUX_SPAWN_BIN ?? DEFAULT_CMUX_SPAWN_BIN;
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const startedAt = now().toISOString();

  await mkdir(artifactDir, { recursive: true });

  const resultPaths = {
    resultJson: `${artifactDir}/review-result.json`,
    councilReport: `${artifactDir}/council-report.md`,
  };

  const fail = async (
    verdict: HeadlessGateVerdict,
    context: Partial<ReviewContext>,
    lanes: HeadlessLaneResult[],
    degradedConditions: string[],
    summary: string,
    diffPath: string | null = null,
  ) =>
    await writeResult({
      schemaVersion: 1,
      issueId: input.issueId,
      verdict,
      startedAt,
      completedAt: now().toISOString(),
      pr: {
        repo: context.repo ?? input.repo ?? null,
        number: context.prNumber ?? input.prNumber ?? null,
        baseRef: context.baseRef ?? input.baseRef ?? null,
        headRef: context.headRef ?? input.headRef ?? null,
      },
      lanes,
      degradedConditions,
      artifactPaths: {
        artifactDir,
        diff: diffPath,
        ...resultPaths,
      },
      summary,
    });

  const reviewerLanes =
    input.reviewerLanes === undefined
      ? defaultReviewerLanes()
      : [...input.reviewerLanes];

  if (reviewerLanes.length === 0) {
    return await fail(
      "error",
      {},
      [],
      ["zero-reviewer-lanes"],
      "No reviewer lanes were configured; review gate failed closed.",
    );
  }

  const preflight = await runCommand(
    cmuxSpawnBin,
    ["preflight", "--caffeinate", "--json"],
    { cwd: workspace, env },
  );
  await writeFile(`${artifactDir}/cmux-preflight.stdout`, preflight.stdout);
  await writeFile(`${artifactDir}/cmux-preflight.stderr`, preflight.stderr);
  if (preflight.exitCode !== 0) {
    return await fail(
      "error",
      {},
      [],
      ["cmux-preflight-failed"],
      "cmux-spawn preflight failed; review gate failed closed.",
    );
  }

  try {
    const context = await loadReviewContext(input, {
      runCommand,
      workspace,
      env,
    });
    const diffPath = `${artifactDir}/diff.patch`;
    await writeFile(diffPath, context.diff);
    if (context.diff.trim() === "") {
      return await fail(
        "error",
        context,
        [],
        ["empty-diff"],
        "Review diff was empty; review gate failed closed.",
        diffPath,
      );
    }

    const lanes = await Promise.all(
      reviewerLanes.map((lane) =>
        runReviewerLane({
          lane,
          context,
          artifactDir,
          workspace,
          cmuxSpawnBin,
          timeoutSeconds,
          runCommand,
          env,
        }),
      ),
    );

    const codexLeadEnabled = input.codexLead !== false;
    const allLanes = [...lanes];
    if (codexLeadEnabled) {
      allLanes.push(
        await runCodexLeadLane({
          context,
          reviewerResults: lanes,
          artifactDir,
          workspace,
          cmuxSpawnBin,
          timeoutSeconds,
          runCommand,
          env,
        }),
      );
    }

    const degradedConditions = collectDegradedConditions(allLanes);
    if (!codexLeadEnabled) {
      degradedConditions.push("codex-lead-disabled");
    }

    const verdict = aggregateHeadlessVerdict(allLanes);
    const summary = summarizeVerdict(verdict, allLanes, degradedConditions);

    return await writeResult({
      schemaVersion: 1,
      issueId: input.issueId,
      verdict,
      startedAt,
      completedAt: now().toISOString(),
      pr: {
        repo: context.repo,
        number: context.prNumber,
        baseRef: context.baseRef,
        headRef: context.headRef,
      },
      lanes: allLanes,
      degradedConditions,
      artifactPaths: {
        artifactDir,
        diff: diffPath,
        ...resultPaths,
      },
      summary,
    });
  } catch (error) {
    return await fail(
      "error",
      {},
      [],
      ["review-context-failed"],
      `Review context setup failed: ${formatError(error)}`,
    );
  }
}

export function defaultReviewerLanes(): HeadlessReviewerLaneConfig[] {
  return [
    {
      laneId: "claude-opus",
      agent: "claude",
      role: "opus-direct-reviewer",
      model: "opus",
      allowedTools:
        "Read,Grep,Glob,Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git status *),Bash(git ls-files *),Bash(find *),Bash(gh pr view *),Bash(gh pr diff *)",
    },
    {
      laneId: "pi-deepseek",
      agent: "pi",
      role: "deepseek-direct-reviewer",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "high",
      tools: "read,grep,find,ls",
    },
  ];
}

async function loadReviewContext(
  input: HeadlessCouncilGateInput,
  deps: {
    runCommand: CommandRunner;
    workspace: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<ReviewContext> {
  if (input.diffPath !== undefined) {
    return {
      issueId: input.issueId,
      repo: input.repo ?? null,
      prNumber: input.prNumber ?? null,
      baseRef: input.baseRef ?? "origin/main",
      headRef: input.headRef ?? "HEAD",
      diff: await readFile(input.diffPath, "utf-8"),
    };
  }

  if (input.prNumber !== undefined && input.repo !== undefined) {
    const view = await deps.runCommand(
      "gh",
      [
        "pr",
        "view",
        String(input.prNumber),
        "--repo",
        input.repo,
        "--json",
        "baseRefName,headRefName",
      ],
      { cwd: deps.workspace, env: deps.env },
    );
    if (view.exitCode !== 0) {
      throw new Error(`gh pr view failed: ${view.stderr || view.stdout}`);
    }
    const pr = JSON.parse(view.stdout) as {
      baseRefName?: string;
      headRefName?: string;
    };
    const diff = await deps.runCommand(
      "gh",
      ["pr", "diff", String(input.prNumber), "--repo", input.repo],
      { cwd: deps.workspace, env: deps.env },
    );
    if (diff.exitCode !== 0) {
      throw new Error(`gh pr diff failed: ${diff.stderr || diff.stdout}`);
    }
    return {
      issueId: input.issueId,
      repo: input.repo,
      prNumber: input.prNumber,
      baseRef: pr.baseRefName ?? input.baseRef ?? "main",
      headRef: pr.headRefName ?? input.headRef ?? "HEAD",
      diff: diff.stdout,
    };
  }

  const baseRef = input.baseRef ?? "origin/main";
  const headRef = input.headRef ?? "HEAD";
  const diff = await deps.runCommand(
    "git",
    ["diff", `${baseRef}...${headRef}`],
    {
      cwd: deps.workspace,
      env: deps.env,
    },
  );
  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr || diff.stdout}`);
  }
  return {
    issueId: input.issueId,
    repo: input.repo ?? null,
    prNumber: input.prNumber ?? null,
    baseRef,
    headRef,
    diff: diff.stdout,
  };
}

async function runReviewerLane(input: {
  lane: HeadlessReviewerLaneConfig;
  context: ReviewContext;
  artifactDir: string;
  workspace: string;
  cmuxSpawnBin: string;
  timeoutSeconds: number;
  runCommand: CommandRunner;
  env: NodeJS.ProcessEnv;
}): Promise<HeadlessLaneResult> {
  const promptPath = `${input.artifactDir}/${input.lane.laneId}.prompt.md`;
  const cliJsonPath = `${input.artifactDir}/${input.lane.laneId}.cli.json`;
  const stderrPath = `${input.artifactDir}/${input.lane.laneId}.cli.stderr`;
  await writeFile(
    promptPath,
    buildReviewerPrompt(input.context, input.lane.role),
  );

  const args = [
    "run",
    "--agent",
    input.lane.agent,
    "--workspace",
    input.workspace,
    "--prompt-file",
    promptPath,
    "--artifact-dir",
    input.artifactDir,
    "--artifact-name",
    input.lane.laneId,
    "--lane-id",
    input.lane.laneId,
    "--phase",
    "headless-council-review",
    "--timeout-seconds",
    String(input.timeoutSeconds),
    ...laneAgentArgs(input.lane),
  ];

  const result = await input.runCommand(input.cmuxSpawnBin, args, {
    cwd: input.workspace,
    env: input.env,
  });
  await writeFile(cliJsonPath, result.stdout);
  await writeFile(stderrPath, result.stderr);

  return await parseLaneResult({
    laneId: input.lane.laneId,
    agent: input.lane.agent,
    role: input.lane.role,
    model: input.lane.model,
    independentReviewer: true,
    promptPath,
    cliJsonPath,
    stderrPath,
    commandResult: result,
  });
}

async function runCodexLeadLane(input: {
  context: ReviewContext;
  reviewerResults: readonly HeadlessLaneResult[];
  artifactDir: string;
  workspace: string;
  cmuxSpawnBin: string;
  timeoutSeconds: number;
  runCommand: CommandRunner;
  env: NodeJS.ProcessEnv;
}): Promise<HeadlessLaneResult> {
  const laneId = "codex-xhigh-lead";
  const promptPath = `${input.artifactDir}/${laneId}.prompt.md`;
  const cliJsonPath = `${input.artifactDir}/${laneId}.cli.json`;
  const stderrPath = `${input.artifactDir}/${laneId}.cli.stderr`;
  await writeFile(
    promptPath,
    buildCodexLeadPrompt(input.context, input.reviewerResults),
  );

  const result = await input.runCommand(
    input.cmuxSpawnBin,
    [
      "run",
      "--agent",
      "codex",
      "--workspace",
      input.workspace,
      "--prompt-file",
      promptPath,
      "--artifact-dir",
      input.artifactDir,
      "--artifact-name",
      laneId,
      "--lane-id",
      laneId,
      "--phase",
      "headless-council-triage",
      "--timeout-seconds",
      String(input.timeoutSeconds),
      "--read-only",
      "--config",
      'model_reasoning_effort="high"',
    ],
    { cwd: input.workspace, env: input.env },
  );
  await writeFile(cliJsonPath, result.stdout);
  await writeFile(stderrPath, result.stderr);

  return await parseLaneResult({
    laneId,
    agent: "codex",
    role: "codex-lead-triage",
    model: "codex-extra-high",
    independentReviewer: false,
    promptPath,
    cliJsonPath,
    stderrPath,
    commandResult: result,
  });
}

function laneAgentArgs(lane: HeadlessReviewerLaneConfig): string[] {
  if (lane.agent === "claude") {
    return [
      "--model",
      lane.model,
      "--allowed-tools",
      lane.allowedTools ?? "Read,Grep,Glob,Bash(git diff *)",
    ];
  }

  return [
    "--provider",
    lane.provider ?? "deepseek",
    "--model",
    lane.model,
    "--thinking",
    lane.thinking ?? "high",
    "--tools",
    lane.tools ?? "read,grep,find,ls",
  ];
}

async function parseLaneResult(input: {
  laneId: string;
  agent: "claude" | "pi" | "codex";
  role: string;
  model: string;
  independentReviewer: boolean;
  promptPath: string;
  cliJsonPath: string;
  stderrPath: string;
  commandResult: CommandResult;
}): Promise<HeadlessLaneResult> {
  let parsed: CmuxRunJson;
  try {
    parsed = JSON.parse(input.commandResult.stdout) as CmuxRunJson;
  } catch {
    return {
      ...input,
      state: "error",
      verdict: "error",
      artifactPath: null,
      message: "cmux-spawn returned malformed JSON.",
    };
  }

  const state = parseLaneState(parsed.state);
  if (input.commandResult.exitCode !== 0 || state !== "complete") {
    return {
      ...input,
      state,
      verdict: "error",
      artifactPath: stringOrNull(parsed.artifact_path),
      message:
        parsed.message ??
        `cmux-spawn lane ended in ${state} with exit code ${input.commandResult.exitCode}.`,
    };
  }

  const artifactPath = stringOrNull(parsed.artifact_path);
  if (artifactPath === null || !(await fileHasContent(artifactPath))) {
    return {
      ...input,
      state: "error",
      verdict: "error",
      artifactPath,
      message: "Reviewer artifact was missing or empty.",
    };
  }

  const artifact = await readFile(artifactPath, "utf-8");
  const parsedVerdict = parseArtifactVerdict(artifact);
  return {
    ...input,
    state,
    verdict: parsedVerdict.verdict,
    artifactPath,
    message: parsedVerdict.message,
  };
}

function parseArtifactVerdict(artifact: string): ParsedArtifactVerdict {
  const verdictMatch =
    artifact.match(/^## Verdict\s*\n\s*(PASS|FINDINGS|FAIL)\b/im) ??
    artifact.match(/^Verdict:\s*(PASS|FINDINGS|FAIL)\b/im);

  if (verdictMatch === null) {
    return {
      verdict: "fail",
      message: "Artifact did not include a parseable Verdict section.",
    };
  }

  const token = verdictMatch[1]?.toUpperCase();
  if (token === "PASS") {
    return { verdict: "pass", message: null };
  }
  return { verdict: "fail", message: `Reviewer verdict was ${token}.` };
}

function aggregateHeadlessVerdict(
  lanes: readonly HeadlessLaneResult[],
): HeadlessGateVerdict {
  if (lanes.some((lane) => lane.verdict === "error")) {
    return "error";
  }
  if (lanes.some((lane) => lane.verdict === "fail")) {
    return "fail";
  }
  return "pass";
}

function collectDegradedConditions(
  lanes: readonly HeadlessLaneResult[],
): string[] {
  const conditions: string[] = [];
  for (const lane of lanes) {
    if (lane.verdict === "error") {
      conditions.push(`${lane.laneId}:${lane.state}`);
    }
    if (lane.message !== null && lane.verdict !== "pass") {
      conditions.push(`${lane.laneId}:${lane.message}`);
    }
  }
  return [...new Set(conditions)];
}

function summarizeVerdict(
  verdict: HeadlessGateVerdict,
  lanes: readonly HeadlessLaneResult[],
  degradedConditions: readonly string[],
): string {
  if (verdict === "pass") {
    return `Headless council review passed with ${lanes.length} lanes.`;
  }
  if (verdict === "fail") {
    return "Headless council review found blocking review findings.";
  }
  return `Headless council review failed closed: ${degradedConditions.join("; ")}`;
}

async function writeResult(
  result: HeadlessCouncilGateResult,
): Promise<HeadlessCouncilGateResult> {
  await writeFile(
    result.artifactPaths.resultJson,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await writeFile(
    result.artifactPaths.councilReport,
    formatCouncilReport(result),
  );
  return result;
}

function formatCouncilReport(result: HeadlessCouncilGateResult): string {
  const lines = [
    "# Headless Council Review",
    "",
    `Issue: ${result.issueId}`,
    `Verdict: ${result.verdict.toUpperCase()}`,
    `Summary: ${result.summary}`,
    "",
    "## PR",
    "",
    `- Repo: ${result.pr.repo ?? "n/a"}`,
    `- Number: ${result.pr.number ?? "n/a"}`,
    `- Base: ${result.pr.baseRef ?? "n/a"}`,
    `- Head: ${result.pr.headRef ?? "n/a"}`,
    "",
    "## Lanes",
    "",
    "| Lane | Agent | Role | Model | Independent | State | Verdict | Artifact |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const lane of result.lanes) {
    lines.push(
      `| ${lane.laneId} | ${lane.agent} | ${lane.role} | ${lane.model} | ${lane.independentReviewer ? "yes" : "no"} | ${lane.state} | ${lane.verdict} | ${lane.artifactPath ?? "n/a"} |`,
    );
  }

  lines.push("", "## Degraded Conditions", "");
  if (result.degradedConditions.length === 0) {
    lines.push("- None");
  } else {
    for (const condition of result.degradedConditions) {
      lines.push(`- ${condition}`);
    }
  }

  lines.push(
    "",
    "## Artifact Contract",
    "",
    `- Machine result: ${result.artifactPaths.resultJson}`,
    `- Human report: ${result.artifactPaths.councilReport}`,
    `- Diff: ${result.artifactPaths.diff ?? "n/a"}`,
    "",
  );
  return lines.join("\n");
}

function buildReviewerPrompt(context: ReviewContext, role: string): string {
  return [
    "You are a decorrelated reviewer in a headless Symphony council gate.",
    "",
    `Review role: ${role}`,
    `Issue: ${context.issueId}`,
    `Repository: ${context.repo ?? "local workspace"}`,
    `PR: ${context.prNumber ?? "local diff"}`,
    `Base: ${context.baseRef}`,
    `Head: ${context.headRef}`,
    "",
    "You are read-only. Do not edit files, create commits, update PRs, or change Linear.",
    "Review only the diff below. Prefer concrete correctness, safety, contract, or operator-risk findings.",
    "",
    "Severity:",
    "- P1: must fix before merge.",
    "- P2: should fix before merge.",
    "- Track: durable follow-up not introduced by this diff.",
    "",
    "Output exactly:",
    "",
    "## Verdict",
    "PASS or FINDINGS",
    "",
    "## P1 Must Fix",
    "Use `None` when empty.",
    "",
    "## P2 Should Fix",
    "Use `None` when empty.",
    "",
    "## Track",
    "Use `None` when empty.",
    "",
    "## Dismissed Or Theoretical",
    "Use `None` when empty.",
    "",
    "[DIFF]",
    "```diff",
    context.diff,
    "```",
  ].join("\n");
}

function buildCodexLeadPrompt(
  context: ReviewContext,
  reviewerResults: readonly HeadlessLaneResult[],
): string {
  const laneSummary = reviewerResults
    .map((lane) =>
      [
        `### ${lane.laneId}`,
        `- Agent: ${lane.agent}`,
        `- Role: ${lane.role}`,
        `- State: ${lane.state}`,
        `- Verdict: ${lane.verdict}`,
        `- Artifact: ${lane.artifactPath ?? "n/a"}`,
        `- Message: ${lane.message ?? "n/a"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    "You are Codex lead/triage for a headless Symphony council gate.",
    "",
    "Important assurance boundary: you are not counted as an independent decorrelated reviewer when Codex authored the implementation. Your job is cross-exam, dedupe, and final triage over the external reviewer artifacts.",
    "",
    `Issue: ${context.issueId}`,
    `Repository: ${context.repo ?? "local workspace"}`,
    `PR: ${context.prNumber ?? "local diff"}`,
    "",
    "Read the reviewer artifacts named below. Fail if any P1/P2 survives, if artifacts are missing/malformed, or if reviewer infrastructure degraded.",
    "",
    "Output exactly:",
    "",
    "## Verdict",
    "PASS or FINDINGS",
    "",
    "## Triage",
    "Summarize surviving P1/P2 findings or state `None`.",
    "",
    "## Track",
    "List durable follow-ups that should be filed in Linear, or `None`.",
    "",
    "## Reviewer Artifacts",
    "",
    laneSummary,
  ].join("\n");
}

function parseLaneState(value: unknown): HeadlessLaneState {
  if (
    value === "complete" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "stopped"
  ) {
    return value;
  }
  return "error";
}

async function fileHasContent(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const execFileCommand: CommandRunner = async (command, args, options) =>
  await new Promise<CommandResult>((resolveCommand) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const maybeError = error as
          | (Error & { code?: number | string | null })
          | null;
        const code =
          maybeError === null
            ? 0
            : typeof maybeError.code === "number"
              ? maybeError.code
              : 1;
        resolveCommand({
          exitCode: code,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
