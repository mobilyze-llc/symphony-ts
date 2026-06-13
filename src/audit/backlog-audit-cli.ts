#!/usr/bin/env node

import { promises as fs, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveWorkflowConfig } from "../config/config-resolver.js";
import { loadWorkflowDefinition } from "../config/workflow-loader.js";
import { LinearTrackerClient } from "../tracker/linear-client.js";
import {
  DEFAULT_BACKLOG_AUDIT_CHUNK_SIZE,
  DEFAULT_BACKLOG_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS,
  DEFAULT_BACKLOG_AUDIT_MAX_STATE_BYTES,
  DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_BYTES,
  DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_ENTRIES,
  createBacklogAuditModelFetch,
  fetchBacklogAuditRuntimeEvidence,
  renderBacklogAuditReport,
  runBacklogAuditChunked,
} from "./backlog-audit.js";

interface ParsedArgs {
  workflowPath: string | null;
  outPath: string | null;
  stateBaseUrl: string;
  modelBaseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  timeoutMs: number | null;
  states: string[] | null;
  maxStateBytes: number | null;
  maxStateDeltaEntries: number | null;
  maxStateDeltaBytes: number | null;
  maxIssueDescriptionChars: number | null;
  chunkSize: number | null;
  help: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usage(): string {
  return [
    "Usage: symphony-backlog-audit [WORKFLOW.md] --state-base-url <url> [--out <file>] --model-base-url <url> --model <name>",
    "",
    "Runs the SYMPH-482 disposable backlog audit against live Linear backlog",
    "and runtime JSON read-models. Model endpoint must be local/OpenAI-compatible.",
    "",
    "Options:",
    "  --state-base-url <url>    Symphony dashboard base URL (for /api/v1/state and /state/delta)",
    "  --out <file>              Markdown report path (default: ./queue-backlog-audit-<timestamp>.md)",
    "  --model-base-url <url>    Local OpenAI-compatible base URL, or SYMPHONY_QUEUE_AUDIT_BASE_URL",
    "  --model <name>            Local model name, or SYMPHONY_QUEUE_AUDIT_MODEL",
    "  --api-key <key>           Optional local endpoint API key, or SYMPHONY_QUEUE_AUDIT_API_KEY",
    "  --timeout-ms <ms>         Runtime read-model and local judge timeout (default: 600000)",
    "  --states <csv>            Linear states to audit (default: workflow active_states)",
    `  --max-state-bytes <n>          Approx max /state JSON bytes in the judge prompt (default: ${DEFAULT_BACKLOG_AUDIT_MAX_STATE_BYTES}, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_BYTES)`,
    `  --max-state-delta-entries <n>  Max /state/delta entries in the judge prompt (default: ${DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_ENTRIES}, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_ENTRIES)`,
    `  --max-state-delta-bytes <n>    Approx max /state/delta JSON bytes in the judge prompt (default: ${DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_BYTES}, or SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_BYTES)`,
    `  --max-issue-description-chars <n>  Max ticket description chars in the judge prompt (default: ${DEFAULT_BACKLOG_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS}, or SYMPHONY_QUEUE_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS)`,
    `  --chunk-size <n>          Issues per local-model call (default: ${DEFAULT_BACKLOG_AUDIT_CHUNK_SIZE}, or SYMPHONY_QUEUE_AUDIT_CHUNK_SIZE)`,
  ].join("\n");
}

export function parseBacklogAuditArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      workflowPath: null,
      outPath: null,
      stateBaseUrl: "",
      modelBaseUrl: env.SYMPHONY_QUEUE_AUDIT_BASE_URL ?? null,
      model: env.SYMPHONY_QUEUE_AUDIT_MODEL ?? null,
      apiKey: env.SYMPHONY_QUEUE_AUDIT_API_KEY ?? null,
      timeoutMs: null,
      states: null,
      maxStateBytes: null,
      maxStateDeltaEntries: null,
      maxStateDeltaBytes: null,
      maxIssueDescriptionChars: null,
      chunkSize: null,
      help: true,
    };
  }

  let workflowPath: string | null = null;
  let outPath: string | null = null;
  let stateBaseUrl: string | null = null;
  let modelBaseUrl: string | null = env.SYMPHONY_QUEUE_AUDIT_BASE_URL ?? null;
  let model: string | null = env.SYMPHONY_QUEUE_AUDIT_MODEL ?? null;
  let apiKey: string | null = env.SYMPHONY_QUEUE_AUDIT_API_KEY ?? null;
  let timeoutMs: number | null = null;
  let states: string[] | null = null;
  let maxStateBytes = parseOptionalPositiveIntegerEnv(
    env.SYMPHONY_QUEUE_AUDIT_MAX_STATE_BYTES,
    "SYMPHONY_QUEUE_AUDIT_MAX_STATE_BYTES",
  );
  let maxStateDeltaEntries = parseOptionalPositiveIntegerEnv(
    env.SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_ENTRIES,
    "SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_ENTRIES",
  );
  let maxStateDeltaBytes = parseOptionalPositiveIntegerEnv(
    env.SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_BYTES,
    "SYMPHONY_QUEUE_AUDIT_MAX_STATE_DELTA_BYTES",
  );
  let maxIssueDescriptionChars = parseOptionalPositiveIntegerEnv(
    env.SYMPHONY_QUEUE_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS,
    "SYMPHONY_QUEUE_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS",
  );
  let chunkSize = parseOptionalPositiveIntegerEnv(
    env.SYMPHONY_QUEUE_AUDIT_CHUNK_SIZE,
    "SYMPHONY_QUEUE_AUDIT_CHUNK_SIZE",
  );
  const help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--out") {
      outPath = resolve(cwd, readValue(argv, ++index, "--out"));
      continue;
    }
    if (token === "--state-base-url") {
      stateBaseUrl = readValue(argv, ++index, "--state-base-url");
      continue;
    }
    if (token === "--model-base-url") {
      modelBaseUrl = readValue(argv, ++index, "--model-base-url");
      continue;
    }
    if (token === "--model") {
      model = readValue(argv, ++index, "--model");
      continue;
    }
    if (token === "--api-key") {
      apiKey = readValue(argv, ++index, "--api-key");
      continue;
    }
    if (token === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(
        readValue(argv, ++index, "--timeout-ms"),
      );
      continue;
    }
    if (token === "--states") {
      states = parseStates(readValue(argv, ++index, "--states"));
      continue;
    }
    if (token === "--max-state-bytes") {
      maxStateBytes = parsePositiveInteger(
        readValue(argv, ++index, "--max-state-bytes"),
        "--max-state-bytes",
      );
      continue;
    }
    if (token === "--max-state-delta-entries") {
      maxStateDeltaEntries = parsePositiveInteger(
        readValue(argv, ++index, "--max-state-delta-entries"),
        "--max-state-delta-entries",
      );
      continue;
    }
    if (token === "--max-state-delta-bytes") {
      maxStateDeltaBytes = parsePositiveInteger(
        readValue(argv, ++index, "--max-state-delta-bytes"),
        "--max-state-delta-bytes",
      );
      continue;
    }
    if (token === "--max-issue-description-chars") {
      maxIssueDescriptionChars = parsePositiveInteger(
        readValue(argv, ++index, "--max-issue-description-chars"),
        "--max-issue-description-chars",
      );
      continue;
    }
    if (token === "--chunk-size") {
      chunkSize = parsePositiveInteger(
        readValue(argv, ++index, "--chunk-size"),
        "--chunk-size",
      );
      continue;
    }
    if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}\n\n${usage()}`);
    }
    if (workflowPath !== null) {
      throw new UsageError(`Unexpected argument: ${token}\n\n${usage()}`);
    }
    workflowPath = resolve(cwd, token);
  }

  if (help) {
    return {
      workflowPath,
      outPath,
      stateBaseUrl: stateBaseUrl ?? "",
      modelBaseUrl,
      model,
      apiKey,
      timeoutMs,
      states,
      maxStateBytes,
      maxStateDeltaEntries,
      maxStateDeltaBytes,
      maxIssueDescriptionChars,
      chunkSize,
      help,
    };
  }
  if (stateBaseUrl === null || stateBaseUrl.trim() === "") {
    throw new UsageError(`--state-base-url is required\n\n${usage()}`);
  }
  if (modelBaseUrl === null || modelBaseUrl.trim() === "") {
    throw new UsageError(
      `--model-base-url or SYMPHONY_QUEUE_AUDIT_BASE_URL is required\n\n${usage()}`,
    );
  }
  if (model === null || model.trim() === "") {
    throw new UsageError(
      `--model or SYMPHONY_QUEUE_AUDIT_MODEL is required\n\n${usage()}`,
    );
  }

  return {
    workflowPath,
    outPath,
    stateBaseUrl,
    modelBaseUrl,
    model,
    apiKey,
    timeoutMs,
    states,
    maxStateBytes: maxStateBytes ?? DEFAULT_BACKLOG_AUDIT_MAX_STATE_BYTES,
    maxStateDeltaEntries:
      maxStateDeltaEntries ?? DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_ENTRIES,
    maxStateDeltaBytes:
      maxStateDeltaBytes ?? DEFAULT_BACKLOG_AUDIT_MAX_STATE_DELTA_BYTES,
    maxIssueDescriptionChars:
      maxIssueDescriptionChars ??
      DEFAULT_BACKLOG_AUDIT_MAX_ISSUE_DESCRIPTION_CHARS,
    chunkSize: chunkSize ?? DEFAULT_BACKLOG_AUDIT_CHUNK_SIZE,
    help,
  };
}

export async function runBacklogAuditCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseBacklogAuditArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    console.log(usage());
    return 0;
  }

  const workflow = await loadWorkflowDefinition(args.workflowPath ?? undefined);
  const config = resolveWorkflowConfig(workflow, env);
  const tracker = new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
    activeStates: config.tracker.activeStates,
  });

  const issues =
    args.states === null
      ? await tracker.fetchCandidateIssues()
      : await tracker.fetchIssuesByStates(args.states);
  const runtimeEvidence = await fetchBacklogAuditRuntimeEvidence({
    baseUrl: args.stateBaseUrl,
    timeoutMs: args.timeoutMs,
  });
  const report = await runBacklogAuditChunked({
    config: {
      baseUrl: args.modelBaseUrl as string,
      model: args.model as string,
      apiKey: args.apiKey,
      timeoutMs: args.timeoutMs,
    },
    issues,
    runtimeEvidence,
    evidenceLimits: {
      maxStateBytes: args.maxStateBytes,
      maxStateDeltaEntries: args.maxStateDeltaEntries,
      maxStateDeltaBytes: args.maxStateDeltaBytes,
      maxIssueDescriptionChars: args.maxIssueDescriptionChars,
    },
    fetchFn: createBacklogAuditModelFetch({ timeoutMs: args.timeoutMs }),
    chunkSize: args.chunkSize,
    onRelationshipPassStart: ({ issueCount }) => {
      console.error(
        `Running backlog audit relationship pass (${issueCount} issues)`,
      );
    },
    onChunkStart: ({ chunkIndex, chunkCount, issueCount }) => {
      if (chunkCount > 1) {
        console.error(
          `Running backlog audit chunk ${chunkIndex}/${chunkCount} (${issueCount} issues)`,
        );
      }
    },
  });
  const outputPath =
    args.outPath ??
    resolve(
      process.cwd(),
      `queue-backlog-audit-${new Date().toISOString().replaceAll(":", "-")}.md`,
    );
  const markdown = renderBacklogAuditReport({
    report,
    outputPath,
    issueIdentifier: "SYMPH-482",
  });
  const tmpPath = `${outputPath}.tmp-${process.pid}`;
  const unregisterCleanup = registerTempPathCleanup(tmpPath);
  await fs.mkdir(dirname(outputPath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, `${markdown}\n`, "utf8");
    await fs.rename(tmpPath, outputPath);
    unregisterCleanup();
  } catch (error) {
    unregisterCleanup();
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  console.error(`Backlog audit report written to ${outputPath}`);
  return 0;
}

function registerTempPathCleanup(tmpPath: string): () => void {
  let active = true;
  const cleanup = () => {
    if (!active) {
      return;
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup for interrupted report writes.
    }
  };
  process.once("exit", cleanup);
  return () => {
    active = false;
    process.off("exit", cleanup);
  };
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

function parsePositiveInteger(value: string, flag = "--timeout-ms"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalPositiveIntegerEnv(
  value: string | undefined,
  name: string,
): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return parsePositiveInteger(value, name);
}

function parseStates(value: string): string[] {
  const states = value
    .split(",")
    .map((state) => state.trim())
    .filter((state) => state.length > 0);
  if (states.length === 0) {
    throw new UsageError("--states must include at least one state name");
  }
  return states;
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
  runBacklogAuditCli(process.argv.slice(2))
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
