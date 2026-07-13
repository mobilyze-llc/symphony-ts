#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveWorkflowConfig } from "../config/config-resolver.js";
import { WORKFLOW_FILENAME } from "../config/defaults.js";
import type { StageExecutionBackend as StageExecutionBackendKind } from "../config/types.js";
import { loadWorkflowDefinition } from "../config/workflow-loader.js";
import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  PipelineNotifier,
  createSlackPoster,
  createWebhookPoster,
} from "../orchestrator/pipeline-notifier.js";
import {
  type RuntimeServiceHandle,
  startRuntimeService,
} from "../orchestrator/runtime-host.js";
import { createCrabrunnerReviewStageDispatcher } from "../review/crabrunner-review-dispatcher.js";
import type { StageExecutionBackendRunner } from "../stage-execution/backend.js";
import {
  type CrabrunnerPromptRenderingConfig,
  createCrabrunnerStageExecutionBackends,
} from "../stage-execution/crabrunner-backend-factory.js";
import { parseCrabrunnerStaticSlotsJson } from "../stage-execution/crabrunner-static-slots.js";
import { getDisplayVersion } from "../version.js";

export const CLI_ACKNOWLEDGEMENT_FLAG = "--acknowledge-high-trust-preview";

export interface CliOptions {
  workflowPath: string | null;
  logsRoot: string | null;
  port: number | null;
  acknowledged: boolean;
  help: boolean;
  version: boolean;
}

export interface CliRuntimeSettings {
  config: ReturnType<typeof resolveWorkflowConfig>;
  logsRoot: string | null;
}

export interface CliHost {
  waitForExit(): Promise<number | undefined>;
  shutdown?(): Promise<void>;
}

export interface StartCliHostInput {
  options: CliOptions;
  runtime: CliRuntimeSettings;
  env: NodeJS.ProcessEnv;
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  loadWorkflowDefinition?: typeof loadWorkflowDefinition;
  resolveWorkflowConfig?: typeof resolveWorkflowConfig;
  startHost?: (input: StartCliHostInput) => Promise<CliHost>;
}

export class CliUsageError extends Error {
  readonly code = ERROR_CODES.cliStartupFailed;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let workflowPath: string | null = null;
  let logsRoot: string | null = null;
  let port: number | null = null;
  let acknowledged = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("-")) {
      if (workflowPath !== null) {
        throw new CliUsageError(
          "CLI accepts at most one positional workflow path argument.",
        );
      }

      workflowPath = token;
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--version" || token === "-V") {
      version = true;
      continue;
    }

    if (token === CLI_ACKNOWLEDGEMENT_FLAG) {
      acknowledged = true;
      continue;
    }

    if (token === "--logs-root") {
      logsRoot = readValueFlag(argv, ++index, "--logs-root");
      continue;
    }

    if (token.startsWith("--logs-root=")) {
      logsRoot = token.slice("--logs-root=".length);
      ensureFlagValue(logsRoot, "--logs-root");
      continue;
    }

    if (token === "--port") {
      port = parsePort(readValueFlag(argv, ++index, "--port"));
      continue;
    }

    if (token.startsWith("--port=")) {
      port = parsePort(token.slice("--port=".length));
      continue;
    }

    throw new CliUsageError(`Unknown CLI argument: ${token}`);
  }

  return {
    workflowPath,
    logsRoot,
    port,
    acknowledged,
    help,
    version,
  };
}

export function applyCliOverrides(
  config: ReturnType<typeof resolveWorkflowConfig>,
  options: CliOptions,
  cwd = process.cwd(),
): CliRuntimeSettings {
  return {
    config: {
      ...config,
      server: {
        ...config.server,
        port: options.port ?? config.server.port,
      },
    },
    logsRoot: options.logsRoot === null ? null : resolve(cwd, options.logsRoot),
  };
}

export async function startCliHost(
  input: StartCliHostInput,
): Promise<RuntimeServiceHandle> {
  const slackEnabled = input.runtime.config.notifications.slackEnabled;
  const webhookUrl = input.env.SYMPHONY_SLACK_WEBHOOK_URL;
  const slackChannel = input.runtime.config.server.slackNotifyChannel;
  const slackToken = input.env.SLACK_BOT_TOKEN;

  // Webhook poster takes precedence over bot-token poster; both require
  // per-product slackEnabled to be true (default: true).
  // Require a non-empty trimmed value: an empty-string env var passes !==
  // undefined but produces "Failed to parse URL from " on every notify call,
  // silently blocking the otherwise-working bot-token fallback.
  const canUseWebhook =
    slackEnabled && webhookUrl !== undefined && webhookUrl.trim() !== "";
  const canUseToken =
    slackEnabled && slackChannel !== null && slackToken !== undefined;

  let notifier: PipelineNotifier | null = null;

  if (canUseWebhook) {
    notifier = new PipelineNotifier({
      channel: "webhook",
      poster: createWebhookPoster({ webhookUrl }),
      onError: (error) =>
        logToStderr({
          timestamp: formatEasternTimestamp(new Date()),
          level: "error",
          event: "slack_notification_failed",
          transport: "webhook",
          message: safeErrorMessage(error),
        }),
    });
  } else if (canUseToken) {
    notifier = new PipelineNotifier({
      channel: slackChannel,
      poster: createSlackPoster({ botToken: slackToken }),
      onError: (error) =>
        logToStderr({
          timestamp: formatEasternTimestamp(new Date()),
          level: "error",
          event: "slack_notification_failed",
          channel: slackChannel,
          message: safeErrorMessage(error),
        }),
    });
  }

  logToStderr({
    timestamp: formatEasternTimestamp(new Date()),
    level: "info",
    event: "notifier_init",
    enabled: notifier !== null,
    transport: canUseWebhook ? "webhook" : canUseToken ? "bot_token" : "none",
    slackEnabled,
    // Never log the webhook URL — it contains a secret token
    webhookPresent: webhookUrl !== undefined,
    channel: slackChannel,
    tokenPresent: slackToken !== undefined,
  });

  // Crabrunner backend (SYMPH-853/SYMPH-812): registered only when
  // SYMPHONY_CRABRUNNER_ROOT is set and non-empty. Workflows that opt into
  // review_execution.crabrunner_job_group.enabled fail closed without this env,
  // because the CMUX review runtime has been removed from the active path.
  // The workflow config supplies the prompt-rendering inputs (SYMPH-856) so the
  // built backend renders + threads the stage prompt into each delegated lane.
  const stageExecutionBackends = buildCrabrunnerStageExecutionBackends(
    input.env,
    {
      promptTemplate: input.runtime.config.promptTemplate,
      workflowPath: input.runtime.config.workflowPath,
    },
  );
  const reviewStageDispatcher =
    stageExecutionBackends === null
      ? null
      : createCrabrunnerReviewStageDispatcher({
          env: input.env,
          defaultRunnerKind: input.runtime.config.runner.kind,
          defaultRunnerModel: input.runtime.config.runner.model,
          defaultRunnerProvider: input.runtime.config.runner.provider ?? null,
          defaultTurnTimeoutMs: input.runtime.config.codex.turnTimeoutMs,
          defaultStallTimeoutMs: input.runtime.config.codex.stallTimeoutMs,
          ...(input.runtime.config.reviewExecution?.preReviewVerify ===
          undefined
            ? {}
            : {
                preReviewVerify:
                  input.runtime.config.reviewExecution.preReviewVerify,
              }),
          ...(input.runtime.config.hardStops === undefined
            ? {}
            : { hardStops: input.runtime.config.hardStops }),
        });

  return startRuntimeService({
    config: input.runtime.config,
    logsRoot: input.runtime.logsRoot,
    notifier,
    ...(stageExecutionBackends === null ? {} : { stageExecutionBackends }),
    ...(reviewStageDispatcher === null ? {} : { reviewStageDispatcher }),
  });
}

/**
 * Build the gated crabrunner stage-execution backend map from environment, or
 * return null when the environment is not enabled. For workflows with
 * review_execution.crabrunner_job_group.enabled, null is intentionally
 * fail-closed: the host will not fall back to the removed CMUX review runtime.
 *
 * Enabled iff `SYMPHONY_CRABRUNNER_ROOT` is set and non-empty (the Crucible
 * repo root). `SYMPHONY_CRABRUNNER_TARGET_REPO` selects the target repo root
 * (falls back to a non-empty `REPO_URL`, then cwd); `SYMPHONY_CRABRUNNER_HOST`
 * and `SYMPHONY_CRABRUNNER_STATE_ROOT` are optional local overrides. Remote
 * hosts additionally need `SYMPHONY_CRABRUNNER_REMOTE_USER`; fixed-slot
 * Crabrunner generations also need `SYMPHONY_CRABRUNNER_STATIC_SLOTS_JSON`.
 * Optional remote
 * run knobs are `SYMPHONY_CRABRUNNER_REMOTE_PORT`,
 * `SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT`,
 * `SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT`,
 * `SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR`,
 * `SYMPHONY_CRABRUNNER_CRABBOX_BIN`, and `SYMPHONY_CRABRUNNER_VERSION`.
 */
export function buildCrabrunnerStageExecutionBackends(
  env: NodeJS.ProcessEnv,
  promptRendering?: CrabrunnerPromptRenderingConfig,
): ReadonlyMap<StageExecutionBackendKind, StageExecutionBackendRunner> | null {
  const crucibleRoot = env.SYMPHONY_CRABRUNNER_ROOT;
  if (crucibleRoot === undefined || crucibleRoot.trim() === "") {
    return null;
  }

  // Use `||` (not `??`) so an empty-string SYMPHONY_CRABRUNNER_TARGET_REPO or
  // REPO_URL falls through to the next source instead of resolving to ""
  // (DeepSeek P2-2).
  const targetRepoRoot =
    firstNonEmpty(env.SYMPHONY_CRABRUNNER_TARGET_REPO, env.REPO_URL) ??
    process.cwd();
  const host = env.SYMPHONY_CRABRUNNER_HOST;
  const stateRoot = env.SYMPHONY_CRABRUNNER_STATE_ROOT;
  const remoteUser = env.SYMPHONY_CRABRUNNER_REMOTE_USER;
  const remoteStaticSlots = parseCrabrunnerStaticSlotsJson(
    env.SYMPHONY_CRABRUNNER_STATIC_SLOTS_JSON,
  );
  const remotePort = env.SYMPHONY_CRABRUNNER_REMOTE_PORT;
  const remoteWorkRoot = env.SYMPHONY_CRABRUNNER_REMOTE_WORK_ROOT;
  const remoteStateRoot = env.SYMPHONY_CRABRUNNER_REMOTE_STATE_ROOT;
  const remoteRunArtifactDir = env.SYMPHONY_CRABRUNNER_REMOTE_ARTIFACT_DIR;
  const crabboxBin = env.SYMPHONY_CRABRUNNER_CRABBOX_BIN;
  const crabrunnerVersion = env.SYMPHONY_CRABRUNNER_VERSION;

  logToStderr({
    timestamp: formatEasternTimestamp(new Date()),
    level: "info",
    event: "crabrunner_backend_enabled",
    crucibleRoot,
    targetRepoRoot,
    host: host ?? "local",
    stateRootOverride: stateRoot !== undefined && stateRoot.trim() !== "",
    remoteUserConfigured:
      remoteUser !== undefined && remoteUser.trim().length > 0,
    remoteStaticSlotCount: remoteStaticSlots?.length ?? 0,
    remoteStateRootOverride:
      remoteStateRoot !== undefined && remoteStateRoot.trim() !== "",
    remoteArtifactDirOverride:
      remoteRunArtifactDir !== undefined && remoteRunArtifactDir.trim() !== "",
  });

  return createCrabrunnerStageExecutionBackends({
    crucibleRoot: crucibleRoot.trim(),
    targetRepoRoot: targetRepoRoot.trim(),
    ...(host === undefined || host.trim() === "" ? {} : { host: host.trim() }),
    ...(stateRoot === undefined || stateRoot.trim() === ""
      ? {}
      : { stateRoot: stateRoot.trim() }),
    ...(remoteUser === undefined || remoteUser.trim() === ""
      ? {}
      : { remoteUser: remoteUser.trim() }),
    ...(remoteStaticSlots === undefined ? {} : { remoteStaticSlots }),
    ...(remotePort === undefined || remotePort.trim() === ""
      ? {}
      : { remotePort: remotePort.trim() }),
    ...(remoteWorkRoot === undefined || remoteWorkRoot.trim() === ""
      ? {}
      : { remoteWorkRoot: remoteWorkRoot.trim() }),
    ...(remoteStateRoot === undefined || remoteStateRoot.trim() === ""
      ? {}
      : { remoteStateRoot: remoteStateRoot.trim() }),
    ...(remoteRunArtifactDir === undefined || remoteRunArtifactDir.trim() === ""
      ? {}
      : { remoteRunArtifactDir: remoteRunArtifactDir.trim() }),
    ...(crabboxBin === undefined || crabboxBin.trim() === ""
      ? {}
      : { crabboxBin: crabboxBin.trim() }),
    ...(crabrunnerVersion === undefined || crabrunnerVersion.trim() === ""
      ? {}
      : { crabrunnerVersion: crabrunnerVersion.trim() }),
    // SYMPH-856: when the workflow config is provided, the default resolver
    // renders + threads the stage prompt; omitted only by older callers/tests
    // that just assert backend registration (the lane stays fail-closed then).
    ...(promptRendering === undefined ? {} : { promptRendering }),
  });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };
  const loadWorkflow =
    dependencies.loadWorkflowDefinition ?? loadWorkflowDefinition;
  const resolveConfig =
    dependencies.resolveWorkflowConfig ?? resolveWorkflowConfig;
  const startHost = dependencies.startHost ?? startCliHost;

  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n${renderUsage()}`);
    return 1;
  }

  if (options.version) {
    io.stdout(`symphony-ts ${getDisplayVersion()}\n`);
    return 0;
  }

  if (options.help) {
    io.stdout(renderUsage());
    return 0;
  }

  if (!options.acknowledged) {
    io.stderr(
      `Refusing to start without ${CLI_ACKNOWLEDGEMENT_FLAG}. Symphony is a high-trust preview intended for trusted environments.\n`,
    );
    return 1;
  }

  try {
    const workflowPath =
      options.workflowPath === null
        ? resolve(cwd, WORKFLOW_FILENAME)
        : resolve(cwd, options.workflowPath);
    const workflow = await loadWorkflow(workflowPath);
    const config = resolveConfig(workflow, env);
    const runtime = applyCliOverrides(config, options, cwd);
    const host = await startHost({
      options,
      runtime,
      env,
    });
    const exitCode = await host.waitForExit();

    if (typeof exitCode === "number" && exitCode !== 0) {
      io.stderr(`Symphony host exited abnormally with code ${exitCode}.\n`);
      return exitCode;
    }

    return 0;
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n`);
    return 1;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "[non-stringifiable value]";
  }
}

/** First argument whose trimmed value is non-empty, else undefined. */
function firstNonEmpty(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

/** Best-effort structured JSON line to stderr. Never throws. */
function logToStderr(entry: Record<string, unknown>): void {
  try {
    writeSync(2, `${JSON.stringify(entry)}\n`);
  } catch {
    // Swallow — logging must never crash the pipeline.
  }
}

export function handleUncaughtException(error: unknown): void {
  process.exitCode = 70;
  logToStderr({
    timestamp: formatEasternTimestamp(new Date()),
    level: "error",
    event: "process_crash",
    message: safeErrorMessage(error),
    error_code: "uncaught_exception",
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(70);
}

export function handleUnhandledRejection(reason: unknown): void {
  logToStderr({
    timestamp: formatEasternTimestamp(new Date()),
    level: "error",
    event: "unhandled_rejection",
    message: safeErrorMessage(reason),
    error_code: "unhandled_rejection",
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Do NOT process.exit() — unhandled rejections from third-party SDKs
  // (e.g. agent-sdk "Operation aborted" during abort) must not kill all
  // concurrent workers. The stall timeout cleans up stuck workers.
}

export async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

export function shouldRunAsCli(
  importMetaUrl: string,
  entryPath: string | undefined,
): boolean {
  if (!entryPath) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entryPath)
    );
  } catch {
    return importMetaUrl === pathToFileURL(entryPath).href;
  }
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  ensureFlagValue(value, flag);
  return value;
}

function ensureFlagValue(
  value: string | undefined,
  flag: string,
): asserts value is string {
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${flag}.`);
  }
}

function parsePort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort.trim())) {
    throw new CliUsageError(`Invalid value for --port: ${rawPort}`);
  }

  return Number.parseInt(rawPort, 10);
}

function formatCliError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Symphony failed to start.";
}

function renderUsage(): string {
  return [
    "Usage: symphony [path-to-WORKFLOW.md] [options]",
    "",
    "Options:",
    `  ${CLI_ACKNOWLEDGEMENT_FLAG}  required before startup`,
    "  --logs-root <path>           override the logs root directory",
    "  --port <number>              override the HTTP server port",
    "  --help                       show this help text",
    "",
  ].join("\n");
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  process.on("uncaughtException", handleUncaughtException);
  process.on("unhandledRejection", handleUnhandledRejection);
  void main().catch(handleUnhandledRejection);
}
