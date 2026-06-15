import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, relative } from "node:path";

import {
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
} from "../config/defaults.js";
import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  type ModeScopedPermissionPolicy,
  detectModePermissionAction,
  evaluateModePermission,
} from "../policy/hard-stops.js";
import { getDefaultCodexSessionArtifactDirectory } from "../shared/codex-session-artifacts.js";
import {
  CODEX_APP_SERVER_LAUNCH_TOKEN_ENV,
  type ProcessIdentitySnapshot,
  readProcessIdentity,
  terminateChildProcessTree,
} from "../shared/process-tree.js";
import { VERSION } from "../version.js";
import {
  gitIsolationEnv,
  scrubGitPointerEnv,
} from "../workspace/git-isolation.js";

const DEFAULT_SYSTEM_SKILL_NAMES = Object.freeze([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);

const EPHEMERAL_CODEX_HOME_PREFIX = "symphony-codex-home-";
const CODEX_SESSION_LOG_ROOTS = Object.freeze(["sessions"]);
// Ephemeral homes leak when the process dies before close(); runs are bounded
// well under an hour, so anything this old is orphaned.
const STALE_EPHEMERAL_CODEX_HOME_MAX_AGE_MS = 48 * 60 * 60 * 1000;
let staleEphemeralCodexHomeSweepStarted = false;

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "symphony-ts",
  version: VERSION,
});

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
/**
 * Single source of truth for the throw in send() and the drop predicate in
 * sendResponseOrDrop() — a drift between the two silently turns late-response
 * drops back into unhandled rejections (SYMPH-332).
 */
const NOT_WRITABLE_MESSAGE = "Codex app-server process is not writable.";
const NOT_WRITABLE_STREAM_ERROR_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);
const SUPPORTED_CODEX_SANDBOX_TYPES =
  "danger-full-access, dangerFullAccess, read-only, readOnly, workspace-write, workspaceWrite";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  noCacheTokens?: number;
  reasoningTokens?: number;
}

export interface CodexSessionArtifact {
  label: string;
  path: string;
  sourcePath: string;
  bytes: number;
}

export type CodexTurnStatus = "completed" | "failed" | "cancelled";

export type CodexSessionClosureInitiator =
  | "budget_hard_stop"
  | "client_close"
  | "operator_abort"
  | "session_rotation"
  | "shutdown"
  | "upstream_exit";

export interface CodexClientEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "approval_auto_approved"
    | "unsupported_tool_call"
    | "compaction"
    | "session_artifact_saved"
    | "session_rotated"
    | "notification"
    | "other_message"
    | "malformed"
    | "activity_heartbeat";
  timestamp: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity?: ProcessIdentitySnapshot | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  usage?: CodexUsage;
  rateLimits?: Record<string, unknown> | null;
  errorCode?: string;
  closureInitiator?: CodexSessionClosureInitiator;
  message?: string;
  raw?: unknown;
  toolName?: string | null;
  artifacts?: CodexSessionArtifact[];
}

export interface CodexDynamicToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CodexDynamicTool extends CodexDynamicToolDefinition {
  execute: (input: unknown) => Promise<object>;
}

export interface CodexAppServerClientOptions {
  command: string;
  ephemeralHome?: boolean;
  disableSkills?: boolean;
  toolOutputTokenLimit?: number;
  modelAutoCompactTokenLimit?: number;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  artifactDirectory?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
  tools?: CodexDynamicToolDefinition[];
  dynamicTools?: CodexDynamicTool[];
  modePolicy?: ModeScopedPermissionPolicy;
  maxLineBytes?: number;
  onEvent?: (event: CodexClientEvent) => void;
}

export interface CodexStartSessionInput {
  prompt: string;
  title: string;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  threadId: string;
  turnId: string;
  sessionId: string;
  usage: CodexUsage | null;
  rateLimits: Record<string, unknown> | null;
  message: string | null;
}

export class CodexAppServerClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexAppServerClientError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (message: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly resolve: (result: CodexTurnResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  stallTimer: NodeJS.Timeout | null;
  /**
   * Last completed agent-message text streamed during this turn
   * (item/completed notifications). The real app-server's turn/completed
   * payload carries no agent message, so this is the only reliable source
   * for the turn's final message — losing it broke the [STAGE_COMPLETE]
   * early-exit and burned budgets past completion (SYMPH-350).
   */
  lastAgentMessage: string | null;
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;

  private child: ChildProcessWithoutNullStreams | null = null;
  private childIdentity: ProcessIdentitySnapshot | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private threadId: string | null = null;
  private currentTurn: ActiveTurn | null = null;
  private lastUsage: CodexUsage | null = null;
  private lastRateLimits: Record<string, unknown> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private stderrBuffer = "";
  private closed = false;
  private ephemeralCodexHome: string | null = null;
  private ephemeralCodexHomeCleanup: Promise<void> | null = null;
  private lastSessionId: string | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  async startSession(input: CodexStartSessionInput): Promise<CodexTurnResult> {
    await this.ensureStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "thread/start did not return a thread id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt: input.prompt,
      title: input.title,
    });
  }

  async continueTurn(prompt: string, title: string): Promise<CodexTurnResult> {
    await this.ensureStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "Cannot continue a turn before a thread is started.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt,
      title,
    });
  }

  async close(input?: {
    closureInitiator?: CodexSessionClosureInitiator;
    forceKillAfterGrace?: boolean;
    graceMs?: number;
  }): Promise<void> {
    this.closed = true;
    const closureInitiator = input?.closureInitiator ?? "client_close";
    this.rejectPending(
      new CodexAppServerClientError(
        "Codex session closed.",
        ERROR_CODES.codexProtocolError,
      ),
    );

    if (this.currentTurn !== null) {
      // Distinct code (SYMPH-412): a mid-turn closure must be classifiable
      // downstream so the retry path can force a fresh session instead of
      // re-accumulating the dead session's context.
      this.finishTurnWithError(
        new CodexAppServerClientError(
          "Codex session closed while a turn was running.",
          ERROR_CODES.codexSessionClosedMidTurn,
        ),
        "turn_ended_with_error",
        { closureInitiator },
      );
    }

    const child = this.child;
    this.child = null;
    this.childIdentity = null;
    if (child === null) {
      await this.cleanupEphemeralCodexHome();
      return;
    }

    await terminateChildProcessTree(child, {
      forceKillAfterGrace: input?.forceKillAfterGrace ?? false,
      ...(input?.graceMs === undefined ? {} : { graceMs: input.graceMs }),
    });
    await this.cleanupEphemeralCodexHome();
  }

  private async ensureStarted(): Promise<void> {
    if (this.child !== null) {
      return;
    }

    if (this.startPromise !== null) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    const launchToken = randomUUID();
    try {
      const env = await this.createSpawnEnvironment(launchToken);
      this.child = spawn("bash", ["-lc", this.renderSpawnCommand(env)], {
        cwd: this.options.cwd,
        env,
        detached: true,
        stdio: "pipe",
      });
    } catch (error) {
      await this.cleanupEphemeralCodexHomeBestEffort();
      const wrapped = new CodexAppServerClientError(
        `Failed to launch Codex app-server: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      throw wrapped;
    }

    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.handleStderrChunk(chunk);
    });
    child.stdin.on("error", (error) => {
      // Write callbacks retain request/response context; the stream event does not.
      if (isAppServerNotWritableError(error)) {
        return;
      }
      this.handleStdinWriteFailure(error);
    });
    child.on("error", (error) => {
      const wrapped = new CodexAppServerClientError(
        `Codex app-server process error: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      this.rejectPending(wrapped);
      if (this.currentTurn !== null) {
        this.finishTurnWithError(wrapped, "turn_ended_with_error", {
          closureInitiator: "upstream_exit",
        });
      }
    });
    child.on("exit", (code, signal) => {
      this.flushStderrBuffer();
      const error = new CodexAppServerClientError(
        `Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`,
        ERROR_CODES.codexProtocolError,
      );
      this.rejectPending(error);
      if (this.currentTurn !== null) {
        // Distinct code (SYMPH-412): the app-server died while a turn was
        // streaming — classify as a mid-turn session closure so retry policy
        // can rotate to a fresh session.
        this.finishTurnWithError(
          new CodexAppServerClientError(
            `Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"} while a turn was running.`,
            ERROR_CODES.codexSessionClosedMidTurn,
          ),
          "turn_ended_with_error",
          { closureInitiator: "upstream_exit" },
        );
      }
      if (!this.closed && this.threadId === null) {
        this.emit({
          event: "startup_failed",
          errorCode: error.code,
          message: error.message,
        });
      }
      this.child = null;
      this.childIdentity = null;
      void this.cleanupEphemeralCodexHome().catch((cleanupError) => {
        this.emit({
          event: "other_message",
          message: `Failed to clean up ephemeral Codex home: ${toErrorMessage(cleanupError)}`,
        });
      });
    });

    const childIdentity = await this.captureChildIdentity(child, launchToken);
    if (this.child === child) {
      this.childIdentity = childIdentity;
    }

    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? {},
      });
      this.send({
        method: "initialized",
        params: {},
      });

      const threadResult = await this.request("thread/start", {
        approvalPolicy: normalizeCodexApprovalPolicy(
          this.options.approvalPolicy,
        ),
        sandbox: normalizeCodexThreadSandbox(this.options.threadSandbox),
        cwd: this.options.cwd,
        tools: this.getAdvertisedTools(),
      });

      const threadId = extractNestedString(threadResult, [
        "result",
        "thread",
        "id",
      ]);
      if (threadId === null) {
        throw new CodexAppServerClientError(
          "thread/start did not include result.thread.id.",
          ERROR_CODES.codexHandshakeFailed,
        );
      }

      this.threadId = threadId;
    } catch (error) {
      const wrapped =
        error instanceof CodexAppServerClientError
          ? error
          : new CodexAppServerClientError(
              `Startup handshake failed: ${toErrorMessage(error)}`,
              ERROR_CODES.codexHandshakeFailed,
              { cause: error },
            );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      await this.close();
      throw wrapped;
    }
  }

  private async createSpawnEnvironment(
    launchToken: string,
  ): Promise<NodeJS.ProcessEnv> {
    if (this.options.ephemeralHome !== true) {
      if (this.options.disableSkills === true) {
        throw new CodexAppServerClientError(
          "codex.disable_skills requires codex.ephemeral_home so Symphony does not mutate the operator Codex config.",
          ERROR_CODES.codexLaunchFailed,
        );
      }
      return scrubGitPointerEnv({
        ...process.env,
        [CODEX_APP_SERVER_LAUNCH_TOKEN_ENV]: launchToken,
        ...gitIsolationEnv(this.options.cwd),
      });
    }

    await this.cleanupEphemeralCodexHome();
    this.sweepStaleEphemeralCodexHomesOnce();
    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const codexHome = await mkdtemp(
      join(tmpdir(), EPHEMERAL_CODEX_HOME_PREFIX),
    );
    this.ephemeralCodexHome = codexHome;

    const sourceAuth = join(sourceHome, "auth.json");
    try {
      await access(sourceAuth, constants.R_OK);
    } catch (error) {
      throw new CodexAppServerClientError(
        `Ephemeral Codex home requested, but no readable auth.json was found at ${sourceAuth}.`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
    }
    await symlink(sourceAuth, join(codexHome, "auth.json"));

    if (this.options.disableSkills === true) {
      await writeFile(
        join(codexHome, "config.toml"),
        await prepareDisabledSkillsConfig({
          codexHome,
          cwd: this.options.cwd,
          sourceHome,
          ...(this.options.toolOutputTokenLimit === undefined
            ? {}
            : { toolOutputTokenLimit: this.options.toolOutputTokenLimit }),
          ...(this.options.modelAutoCompactTokenLimit === undefined
            ? {}
            : {
                modelAutoCompactTokenLimit:
                  this.options.modelAutoCompactTokenLimit,
              }),
        }),
      );
    }

    return scrubGitPointerEnv({
      ...process.env,
      ...gitIsolationEnv(this.options.cwd),
      CODEX_HOME: codexHome,
      [CODEX_APP_SERVER_LAUNCH_TOKEN_ENV]: launchToken,
    });
  }

  private async captureChildIdentity(
    child: ChildProcessWithoutNullStreams,
    launchToken: string,
  ): Promise<ProcessIdentitySnapshot | null> {
    const pid = child.pid;
    if (pid === undefined) {
      return null;
    }
    const identity = await readProcessIdentity(pid);
    if (identity === null || identity.processGroupId !== pid) {
      return null;
    }
    return identity.launchToken === null || identity.launchToken === launchToken
      ? identity
      : null;
  }

  private sweepStaleEphemeralCodexHomesOnce(): void {
    if (staleEphemeralCodexHomeSweepStarted) {
      return;
    }
    staleEphemeralCodexHomeSweepStarted = true;
    // Fire-and-forget: orphan cleanup must never delay or fail a launch. The
    // trailing catch also covers a throwing onEvent handler inside emit.
    void sweepStaleCodexHomes({
      root: tmpdir(),
      maxAgeMs: STALE_EPHEMERAL_CODEX_HOME_MAX_AGE_MS,
      now: () => Date.now(),
    })
      .then((removed) => {
        if (removed.length > 0) {
          this.emit({
            event: "other_message",
            message: `Removed ${removed.length} stale ephemeral Codex home(s) from ${tmpdir()}.`,
          });
        }
      })
      .catch(() => {});
  }

  private async cleanupEphemeralCodexHome(): Promise<void> {
    if (this.ephemeralCodexHomeCleanup !== null) {
      await this.ephemeralCodexHomeCleanup;
      return;
    }

    const codexHome = this.ephemeralCodexHome;
    if (codexHome === null) {
      return;
    }
    this.ephemeralCodexHome = null;
    const cleanup = (async () => {
      let preservationError: unknown = null;
      try {
        await this.preserveEphemeralCodexHomeArtifacts(codexHome);
      } catch (error) {
        preservationError = error;
      }
      await rm(codexHome, { recursive: true, force: true });
      if (preservationError !== null) {
        this.emit({
          event: "other_message",
          sessionId: this.lastSessionId,
          threadId: this.threadId,
          message: `Failed to preserve ephemeral Codex session artifacts before cleanup: ${toErrorMessage(preservationError)}`,
        });
      }
    })().finally(() => {
      if (this.ephemeralCodexHomeCleanup === cleanup) {
        this.ephemeralCodexHomeCleanup = null;
      }
    });
    this.ephemeralCodexHomeCleanup = cleanup;
    await cleanup;
  }

  private async preserveEphemeralCodexHomeArtifacts(
    codexHome: string,
  ): Promise<void> {
    const sessionFiles = await findCodexSessionLogFiles(codexHome);
    if (sessionFiles.length === 0) {
      return;
    }

    const artifactRoot =
      this.options.artifactDirectory ??
      getDefaultCodexSessionArtifactDirectory(this.options.cwd);
    const artifactDirectory = join(artifactRoot, basename(codexHome));
    const artifacts: CodexSessionArtifact[] = [];

    for (const sourcePath of sessionFiles) {
      const relativePath = relative(codexHome, sourcePath);
      if (relativePath.length === 0 || relativePath.startsWith("..")) {
        continue;
      }
      const sourceStats = await lstat(sourcePath);
      if (!sourceStats.isFile()) {
        continue;
      }

      const destinationPath = join(artifactDirectory, relativePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      const stats = await stat(destinationPath);
      artifacts.push({
        label: relativePath,
        path: destinationPath,
        sourcePath,
        bytes: stats.size,
      });
    }

    if (artifacts.length === 0) {
      return;
    }

    this.emit({
      event: "session_artifact_saved",
      sessionId: this.lastSessionId,
      threadId: this.threadId,
      message: `Preserved ${artifacts.length} Codex session artifact(s).`,
      artifacts,
    });
  }

  private renderSpawnCommand(env: NodeJS.ProcessEnv): string {
    if (this.options.ephemeralHome !== true) {
      return this.options.command;
    }

    const codexHome = env.CODEX_HOME;
    if (codexHome === undefined || codexHome.length === 0) {
      throw new CodexAppServerClientError(
        "Ephemeral Codex home requested, but no CODEX_HOME was prepared.",
        ERROR_CODES.codexLaunchFailed,
      );
    }

    return `export CODEX_HOME=${quoteShellString(codexHome)}; ${this.options.command}`;
  }

  private async cleanupEphemeralCodexHomeBestEffort(): Promise<void> {
    try {
      await this.cleanupEphemeralCodexHome();
    } catch (cleanupError) {
      this.emit({
        event: "other_message",
        message: `Failed to clean up ephemeral Codex home: ${toErrorMessage(cleanupError)}`,
      });
    }
  }

  private async startTurn(input: {
    threadId: string;
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    if (this.currentTurn !== null) {
      throw new CodexAppServerClientError(
        "Only one turn can run at a time.",
        ERROR_CODES.codexProtocolError,
      );
    }

    this.lastUsage = null;
    const response = await this.request("turn/start", {
      threadId: input.threadId,
      input: [
        {
          type: "text",
          text: input.prompt,
        },
      ],
      cwd: this.options.cwd,
      title: input.title,
      approvalPolicy: normalizeCodexApprovalPolicy(this.options.approvalPolicy),
      sandboxPolicy: normalizeCodexSandboxPolicy(
        this.options.turnSandboxPolicy,
      ),
    });

    const turnId = extractNestedString(response, ["result", "turn", "id"]);
    if (turnId === null) {
      throw new CodexAppServerClientError(
        "turn/start did not include result.turn.id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    const sessionId = `${input.threadId}-${turnId}`;
    this.lastSessionId = sessionId;
    this.emit({
      event: "session_started",
      sessionId,
      threadId: input.threadId,
      turnId,
    });

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishTurnWithError(
          new CodexAppServerClientError(
            `Codex turn exceeded ${this.options.turnTimeoutMs}ms.`,
            ERROR_CODES.codexTurnTimeout,
          ),
          "turn_ended_with_error",
        );
      }, this.options.turnTimeoutMs);

      const activeTurn: ActiveTurn = {
        threadId: input.threadId,
        turnId,
        sessionId,
        resolve,
        reject,
        timeout,
        stallTimer: null,
        lastAgentMessage: null,
      };

      this.currentTurn = activeTurn;
      this.bumpStallTimer(activeTurn);
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxLineBytes) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Codex stdout line exceeded the maximum buffered size.",
      });
      this.stdoutBuffer = "";
      return;
    }

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseJsonLine(line);
    if (parsed === null) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Received non-JSON stdout line from Codex app-server.",
        raw: line,
      });
      return;
    }

    const usage = extractUsage(parsed);
    if (usage !== null) {
      this.lastUsage = usage;
    }

    const rateLimits = extractRateLimits(parsed);
    if (rateLimits !== null) {
      this.lastRateLimits = rateLimits;
    }

    if (this.currentTurn !== null) {
      this.bumpStallTimer(this.currentTurn);
      const agentMessage = extractCompletedAgentMessageText(parsed);
      if (agentMessage !== null) {
        // Unconditional overwrite is deliberate: the runner's completion
        // contract is that the turn's FINAL agent message ends with the
        // [STAGE_COMPLETE] sentinel. Preserving an earlier marker-bearing
        // message would falsely complete a stage that kept working.
        this.currentTurn.lastAgentMessage = agentMessage;
      }
    }

    const responseId = normalizeJsonRpcId(parsed.id);
    const method = typeof parsed.method === "string" ? parsed.method : null;

    if (responseId !== null && !("method" in parsed)) {
      const pending = this.pendingRequests.get(responseId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(responseId);
        const responseError = extractJsonRpcResponseError(
          parsed,
          pending.method,
        );
        if (responseError !== null) {
          pending.reject(responseError);
          return;
        }
        pending.resolve(parsed);
        return;
      }
    }

    if (isApprovalRequest(parsed, method)) {
      const outputDenial = evaluateHeadlessCommandOutputForApproval(parsed);
      if (outputDenial !== null) {
        if (responseId !== null) {
          this.sendResponseOrDrop(
            {
              id: parsed.id,
              result: createApprovalResponse(false, outputDenial.reason),
            },
            "headless output denial",
          );
        }
        this.emit({
          event: "unsupported_tool_call",
          sessionId: this.currentTurn?.sessionId ?? null,
          threadId: this.currentTurn?.threadId ?? this.threadId,
          turnId: this.currentTurn?.turnId ?? null,
          toolName: outputDenial.toolName,
          message: outputDenial.reason,
          raw: parsed,
          ...optionalTelemetry(usage, rateLimits),
        });
        return;
      }

      const permissionDenial = this.evaluateModePermissionForApproval(parsed);
      if (permissionDenial !== null) {
        if (responseId !== null) {
          this.sendResponseOrDrop(
            {
              id: parsed.id,
              result: createApprovalResponse(false, permissionDenial.reason),
            },
            "mode permission denial",
          );
        }
        this.emit({
          event: "unsupported_tool_call",
          sessionId: this.currentTurn?.sessionId ?? null,
          threadId: this.currentTurn?.threadId ?? this.threadId,
          turnId: this.currentTurn?.turnId ?? null,
          toolName: permissionDenial.toolName,
          message: permissionDenial.reason,
          raw: parsed,
          ...optionalTelemetry(usage, rateLimits),
        });
        return;
      }

      if (responseId !== null) {
        this.sendResponseOrDrop(
          {
            id: parsed.id,
            result: createApprovalResponse(true),
          },
          "approval auto-approve",
        );
      }
      this.emit({
        event: "approval_auto_approved",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        raw: parsed,
        ...optionalTelemetry(usage, rateLimits),
      });
      return;
    }

    if (isToolCallRequest(parsed, method)) {
      const toolName = extractToolName(parsed);
      const tool = toolName === null ? null : this.findDynamicTool(toolName);
      if (tool !== null && responseId !== null) {
        void this.handleDynamicToolCall(responseId, tool, parsed);
        return;
      }

      if (responseId !== null) {
        this.sendResponseOrDrop(
          {
            id: parsed.id,
            result: {
              success: false,
              error: {
                code: ERROR_CODES.codexDynamicToolRejected,
                message: `Unsupported tool call: ${toolName ?? "unknown"}`,
              },
            },
          },
          "unsupported dynamic tool call",
        );
      }
      this.emit({
        event: "unsupported_tool_call",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        toolName,
        raw: parsed,
        ...optionalTelemetry(usage, rateLimits),
      });
      return;
    }

    if (isUserInputRequired(parsed, method)) {
      const error = new CodexAppServerClientError(
        "Codex requested operator input during a turn.",
        ERROR_CODES.codexUserInputRequired,
      );
      if (responseId !== null) {
        this.sendResponseOrDrop(
          {
            id: parsed.id,
            error: {
              code: -32000,
              message: error.message,
              data: {
                code: error.code,
              },
            },
          },
          "user input required",
        );
      }
      this.emit({
        event: "turn_input_required",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        errorCode: error.code,
        message: error.message,
        raw: parsed,
        ...optionalTelemetry(usage, rateLimits),
      });
      this.finishTurnWithError(error, "turn_ended_with_error");
      return;
    }

    if (method === "turn/completed") {
      this.completeTurn("completed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/failed") {
      this.completeTurn("failed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/cancelled") {
      this.completeTurn("cancelled", usage, rateLimits, parsed);
      return;
    }

    if (method !== null) {
      this.emit({
        event: isCompactionNotification(method) ? "compaction" : "notification",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: method,
        raw: parsed,
        ...optionalTelemetry(usage, rateLimits),
      });
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      raw: parsed,
      ...optionalTelemetry(usage, rateLimits),
    });
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.emit({
        event: "other_message",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: line,
        raw: {
          stream: "stderr",
          line,
        },
      });
    }
  }

  private flushStderrBuffer(): void {
    const line = this.stderrBuffer.trim();
    this.stderrBuffer = "";
    if (line.length === 0) {
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      message: line,
      raw: {
        stream: "stderr",
        line,
      },
    });
  }

  private completeTurn(
    status: CodexTurnStatus,
    usage: CodexUsage | null,
    rateLimits: Record<string, unknown> | null,
    raw: JsonObject,
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    const result: CodexTurnResult = {
      status,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      sessionId: activeTurn.sessionId,
      usage: usage ?? this.lastUsage,
      rateLimits: rateLimits ?? this.lastRateLimits,
      // turn/completed carries no agent message on the real app-server;
      // fall back to the last streamed agent-message item (SYMPH-350).
      message: extractTurnMessage(raw) ?? activeTurn.lastAgentMessage,
    };

    this.emit({
      event:
        status === "completed"
          ? "turn_completed"
          : status === "failed"
            ? "turn_failed"
            : "turn_cancelled",
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      raw,
      ...(result.message === null ? {} : { message: result.message }),
      ...optionalTelemetry(result.usage, result.rateLimits),
    });

    activeTurn.resolve(result);
  }

  private finishTurnWithError(
    error: CodexAppServerClientError,
    event: "turn_ended_with_error",
    options?: { closureInitiator?: CodexSessionClosureInitiator },
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    this.emit({
      event,
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      errorCode: error.code,
      ...(options?.closureInitiator === undefined
        ? {}
        : { closureInitiator: options.closureInitiator }),
      message: error.message,
      ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
    });

    activeTurn.reject(error);
  }

  private bumpStallTimer(activeTurn: ActiveTurn): void {
    clearTimeoutIfPresent(activeTurn.stallTimer);

    if (this.options.stallTimeoutMs <= 0) {
      activeTurn.stallTimer = null;
      return;
    }

    activeTurn.stallTimer = setTimeout(() => {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          `Codex session stalled for ${this.options.stallTimeoutMs}ms.`,
          ERROR_CODES.codexSessionStalled,
        ),
        "turn_ended_with_error",
      );
    }, this.options.stallTimeoutMs);
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId++;

    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(
          new CodexAppServerClientError(
            `Timed out waiting for ${method} response after ${this.options.readTimeoutMs}ms.`,
            ERROR_CODES.codexReadTimeout,
          ),
        );
      }, this.options.readTimeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        resolve,
        reject,
        timer,
      });

      this.send({
        id,
        method,
        params,
      });
    });
  }

  private sendResponseOrDrop(payload: JsonObject, context: string): void {
    try {
      this.send(payload, { dropContext: context });
    } catch (error) {
      if (!isAppServerNotWritableError(error)) {
        throw error;
      }

      this.emitDroppedResponse(context, "app-server process is not writable.");
    }
  }

  private send(message: JsonObject, options?: { dropContext?: string }): void {
    const child = this.child;
    if (child === null || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new CodexAppServerClientError(
        NOT_WRITABLE_MESSAGE,
        ERROR_CODES.codexProtocolError,
      );
    }

    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.handleStdinWriteFailure(error, options);
      }
    });
  }

  private handleStdinWriteFailure(
    error: unknown,
    options?: { dropContext?: string },
  ): void {
    if (
      options?.dropContext !== undefined &&
      isAppServerNotWritableError(error)
    ) {
      this.emitDroppedResponse(
        options.dropContext,
        "app-server stdin is not writable.",
      );
      return;
    }

    const wrapped =
      error instanceof CodexAppServerClientError
        ? error
        : new CodexAppServerClientError(
            `Codex app-server stdin write failed: ${toErrorMessage(error)}`,
            ERROR_CODES.codexProtocolError,
            { cause: error },
          );
    this.rejectPending(wrapped);
    if (this.currentTurn !== null) {
      this.finishTurnWithError(wrapped, "turn_ended_with_error", {
        closureInitiator: "upstream_exit",
      });
    }
  }

  private emitDroppedResponse(context: string, reason: string): void {
    this.emit({
      event: "other_message",
      message: `Codex app-server response dropped for ${context}: ${reason}`,
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(
    input: Omit<
      CodexClientEvent,
      "timestamp" | "codexAppServerPid" | "codexAppServerIdentity"
    >,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: formatEasternTimestamp(new Date()),
      codexAppServerPid:
        this.child?.pid === undefined ? null : String(this.child.pid),
      codexAppServerIdentity: this.childIdentity,
    });
  }

  private get maxLineBytes(): number {
    return this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  private getAdvertisedTools(): CodexDynamicToolDefinition[] {
    const advertised = new Map<string, CodexDynamicToolDefinition>();

    for (const tool of this.options.tools ?? []) {
      advertised.set(tool.name, tool);
    }

    for (const tool of this.options.dynamicTools ?? []) {
      advertised.set(tool.name, {
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        ...(tool.inputSchema === undefined
          ? {}
          : { inputSchema: tool.inputSchema }),
      });
    }

    return [...advertised.values()];
  }

  private findDynamicTool(name: string): CodexDynamicTool | null {
    return (
      this.options.dynamicTools?.find((tool) => tool.name === name) ?? null
    );
  }

  private evaluateModePermissionForApproval(message: JsonObject): {
    toolName: string | null;
    reason: string;
  } | null {
    if (this.options.modePolicy === undefined) {
      return null;
    }

    const toolName = extractToolName(message);
    const action = detectModePermissionAction({
      toolName,
      toolInput: extractToolInput(message) ?? message,
    });
    if (action === null) {
      return null;
    }

    const permission = evaluateModePermission({
      policy: this.options.modePolicy,
      action,
    });
    if (permission.allowed) {
      return null;
    }

    return {
      toolName,
      reason: permission.hardStop.reason,
    };
  }

  private async handleDynamicToolCall(
    requestId: JsonRpcId,
    tool: CodexDynamicTool,
    message: JsonObject,
  ): Promise<void> {
    let toolResult: object;
    try {
      toolResult = await tool.execute(extractToolInput(message));
    } catch (execError) {
      this.sendResponseOrDrop(
        {
          id: requestId,
          result: {
            success: false,
            error: {
              code: ERROR_CODES.codexDynamicToolRejected,
              message: `Dynamic tool ${tool.name} failed: ${toErrorMessage(execError)}`,
            },
          },
        },
        `dynamic tool "${tool.name}" error for request ${String(requestId)}`,
      );
      return;
    }

    try {
      this.sendResponseOrDrop(
        {
          id: requestId,
          result: toolResult,
        },
        `dynamic tool "${tool.name}" result for request ${String(requestId)}`,
      );
    } catch (sendError) {
      // A successful tool result that cannot be serialized/sent (circular
      // structure, BigInt, ...) must become a reported dynamic-tool
      // failure — not an unhandled rejection escaping this detached
      // promise, which is the exact hazard this client guards against
      // (SYMPH-332). The failure envelope below is all primitives, so it
      // serializes; if the process died meanwhile, sendResponseOrDrop
      // drops it.
      this.sendResponseOrDrop(
        {
          id: requestId,
          result: {
            success: false,
            error: {
              code: ERROR_CODES.codexDynamicToolRejected,
              message: `Dynamic tool ${tool.name} result could not be sent: ${toErrorMessage(sendError)}`,
            },
          },
        },
        `dynamic tool "${tool.name}" result-send failure for request ${String(requestId)}`,
      );
    }
  }
}

/**
 * Render the generated config.toml that keeps headless Codex launches bare and
 * disables every Codex skill a worker launch could otherwise discover. Exported
 * so the probe script exercises the exact production path.
 */
export async function prepareDisabledSkillsConfig(input: {
  codexHome: string;
  cwd: string;
  sourceHome: string;
  toolOutputTokenLimit?: number;
  modelAutoCompactTokenLimit?: number;
}): Promise<string> {
  return renderHeadlessCodexConfig(await discoverCodexSkillPaths(input), {
    toolOutputTokenLimit:
      input.toolOutputTokenLimit ?? DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    modelAutoCompactTokenLimit:
      input.modelAutoCompactTokenLimit ??
      DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  });
}

async function discoverCodexSkillPaths(input: {
  codexHome: string;
  cwd: string;
  sourceHome: string;
}): Promise<string[]> {
  const paths = new Set<string>();
  const systemSkillNames = new Set(DEFAULT_SYSTEM_SKILL_NAMES);
  for (const skillPath of await findSkillFiles(
    join(input.sourceHome, "skills", ".system"),
  )) {
    systemSkillNames.add(basename(dirname(skillPath)));
  }
  for (const name of systemSkillNames) {
    paths.add(join(input.codexHome, "skills", ".system", name, "SKILL.md"));
  }

  for (const root of [
    join(homedir(), ".agents", "skills"),
    "/etc/codex/skills",
  ]) {
    for (const skillPath of await findSkillFiles(root)) {
      paths.add(skillPath);
    }
  }

  for (const root of repoSkillRoots(input.cwd)) {
    for (const skillPath of await findSkillFiles(root)) {
      paths.add(skillPath);
    }
  }

  return [...paths].sort();
}

export async function sweepStaleCodexHomes(input: {
  root: string;
  maxAgeMs: number;
  now: () => number;
}): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(input.root, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (
      !entry.name.startsWith(EPHEMERAL_CODEX_HOME_PREFIX) ||
      !entry.isDirectory()
    ) {
      continue;
    }
    const path = join(input.root, entry.name);
    try {
      const stats = await stat(path);
      if (input.now() - stats.mtimeMs <= input.maxAgeMs) {
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Best-effort: a concurrently removed or unreadable entry is not an error.
    }
  }
  return removed;
}

async function findSkillFiles(root: string): Promise<string[]> {
  try {
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const result: string[] = [];
  const seenDirectories = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    let canonicalDirectory = directory;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      return;
    }
    if (seenDirectories.has(canonicalDirectory)) {
      return;
    }
    seenDirectories.add(canonicalDirectory);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === "SKILL.md") {
        try {
          result.push(await realpath(path));
        } catch {
          result.push(path);
        }
        continue;
      }

      let entryStats: import("node:fs").Stats;
      try {
        entryStats = await stat(path);
      } catch {
        continue;
      }
      if (entryStats.isDirectory()) {
        await visit(path);
      }
    }
  };

  await visit(root);
  return result;
}

async function findCodexSessionLogFiles(codexHome: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let directoryStats: import("node:fs").Stats;
    try {
      directoryStats = await lstat(directory);
    } catch {
      return;
    }
    if (!directoryStats.isDirectory()) {
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }

      if (entry.name.endsWith(".jsonl")) {
        result.push(path);
      }
    }
  };

  for (const root of CODEX_SESSION_LOG_ROOTS) {
    await visit(join(codexHome, root));
  }
  return result.sort();
}

function repoSkillRoots(cwd: string): string[] {
  const roots: string[] = [];
  const filesystemRoot = parse(cwd).root;
  let current = cwd;
  while (true) {
    roots.push(join(current, ".agents", "skills"));
    if (current === filesystemRoot) {
      break;
    }
    if (pathExists(join(current, ".git"))) {
      break;
    }
    current = dirname(current);
  }
  return roots;
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function renderHeadlessCodexConfig(
  skillPaths: string[],
  caps: {
    toolOutputTokenLimit: number;
    modelAutoCompactTokenLimit: number;
  },
): string {
  // Enforceable in-turn context caps (SYMPH-319/454). Prompt-level output
  // discipline proved advisory-only; these codex-native limits bound what a
  // single tool output can pin in history and when accumulated history is
  // auto-compacted, independent of worker compliance.
  const featureConfig = `project_doc_max_bytes = 0
tool_output_token_limit = ${caps.toolOutputTokenLimit}
model_auto_compact_token_limit = ${caps.modelAutoCompactTokenLimit}

[features]
apps = false
browser_use = false
browser_use_external = false
computer_use = false
codex_hooks = false
goals = false
hooks = false
memories = false
multi_agent = false
plugins = false
plugin_hooks = false
tool_call_mcp_elicitation = false
`;
  return `${[
    featureConfig,
    ...skillPaths.map(
      (skillPath) =>
        `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`,
    ),
  ].join("\n")}\n`;
}

function quoteShellString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseJsonLine(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function normalizeJsonRpcId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractJsonRpcResponseError(
  message: JsonObject,
  method: string,
): CodexAppServerClientError | null {
  const error = message.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }

  const errorObject = error as JsonObject;
  const code =
    typeof errorObject.code === "number" || typeof errorObject.code === "string"
      ? String(errorObject.code)
      : "unknown";
  const responseMessage =
    typeof errorObject.message === "string" && errorObject.message.length > 0
      ? errorObject.message
      : JSON.stringify(errorObject);

  return new CodexAppServerClientError(
    `Codex app-server ${method} error ${code}: ${responseMessage}`,
    ERROR_CODES.codexProtocolError,
  );
}

function normalizeCodexApprovalPolicy(value: unknown): unknown {
  if (value === "full-auto") {
    // Symphony's full-auto mode means no interactive approval prompts; current
    // Codex app-server names that same behavior "never".
    return "never";
  }

  return value;
}

function createApprovalResponse(
  approved: boolean,
  reason?: string,
): JsonObject {
  return {
    decision: approved ? "accept" : "decline",
    approved,
    ...(reason === undefined ? {} : { reason }),
  };
}

// Codex exposes two sandbox shapes: thread/start takes a SandboxMode enum
// serialized as kebab-case strings, while turn/start takes a SandboxPolicy
// tagged union serialized with camelCase type discriminators.
function normalizeCodexThreadSandbox(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeKnownCodexSandboxMode(value, "thread/start sandbox");
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const objectValue = value as JsonObject;
  const type = objectValue.type;
  if (typeof type !== "string") {
    return value;
  }

  const unsupportedKeys = Object.keys(objectValue).filter(
    (key) => key !== "type",
  );
  if (unsupportedKeys.length > 0) {
    throw new CodexAppServerClientError(
      `thread/start sandbox only accepts a mode; unsupported fields: ${unsupportedKeys.sort().join(", ")}. Expected one of: ${SUPPORTED_CODEX_SANDBOX_TYPES}.`,
      ERROR_CODES.codexProtocolError,
    );
  }

  return normalizeKnownCodexSandboxMode(type, "thread/start sandbox");
}

function normalizeKnownCodexSandboxMode(
  value: string,
  context: string,
): string {
  const normalized = normalizeCodexSandboxMode(value);
  if (normalized === null) {
    throw unsupportedSandboxTypeError(context, value);
  }
  return normalized;
}

function normalizeCodexSandboxMode(value: string): string | null {
  switch (value) {
    case "danger-full-access":
    case "dangerFullAccess":
      return "danger-full-access";
    case "read-only":
    case "readOnly":
      return "read-only";
    case "workspace-write":
    case "workspaceWrite":
      return "workspace-write";
    default:
      return null;
  }
}

function normalizeCodexSandboxPolicy(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return normalizeCodexSandboxString(value);
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const objectValue = value as JsonObject;
  const rawType = objectValue.type;
  if (typeof rawType !== "string") {
    return value;
  }

  const normalizedType = normalizeCodexSandboxType(rawType);
  if (normalizedType === null) {
    throw unsupportedSandboxTypeError("turn/start sandboxPolicy", rawType);
  }

  if (normalizedType === "dangerFullAccess") {
    return {
      type: normalizedType,
    };
  }

  if (normalizedType === "readOnly") {
    return {
      type: normalizedType,
      networkAccess: readBooleanAlias(objectValue, "networkAccess", false),
    };
  }

  if (normalizedType === "workspaceWrite") {
    return {
      type: normalizedType,
      writableRoots: readStringArrayAlias(objectValue, "writableRoots"),
      networkAccess: readBooleanAlias(objectValue, "networkAccess", false),
      excludeTmpdirEnvVar: readBooleanAlias(
        objectValue,
        "excludeTmpdirEnvVar",
        false,
      ),
      excludeSlashTmp: readBooleanAlias(objectValue, "excludeSlashTmp", false),
    };
  }

  return value;
}

function normalizeCodexSandboxString(value: string): unknown {
  const normalizedType = normalizeCodexSandboxType(value);
  if (normalizedType === null) {
    throw unsupportedSandboxTypeError("turn/start sandboxPolicy", value);
  }

  if (normalizedType === "dangerFullAccess") {
    return { type: normalizedType };
  }
  if (normalizedType === "readOnly") {
    return { type: normalizedType, networkAccess: false };
  }
  if (normalizedType === "workspaceWrite") {
    return {
      type: normalizedType,
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  return value;
}

function normalizeCodexSandboxType(value: string): string | null {
  switch (value) {
    case "danger-full-access":
    case "dangerFullAccess":
      return "dangerFullAccess";
    case "read-only":
    case "readOnly":
      return "readOnly";
    case "workspace-write":
    case "workspaceWrite":
      return "workspaceWrite";
    default:
      return null;
  }
}

function unsupportedSandboxTypeError(
  context: string,
  value: string,
): CodexAppServerClientError {
  return new CodexAppServerClientError(
    `Unsupported Codex ${context} type "${value}". Expected one of: ${SUPPORTED_CODEX_SANDBOX_TYPES}.`,
    ERROR_CODES.codexProtocolError,
  );
}

function readBooleanAlias(
  source: JsonObject,
  camelKey: string,
  fallback: boolean,
): boolean {
  const direct = source[camelKey];
  if (typeof direct === "boolean") {
    return direct;
  }

  const snake = source[toSnakeCase(camelKey)];
  return typeof snake === "boolean" ? snake : fallback;
}

function readStringArrayAlias(source: JsonObject, camelKey: string): string[] {
  const direct = source[camelKey];
  if (isStringArray(direct)) {
    return direct;
  }

  const snake = source[toSnakeCase(camelKey)];
  return isStringArray(snake) ? snake : [];
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isApprovalRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  return normalized.includes("approval");
}

function isToolCallRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (
    normalized.includes("tool/call") ||
    normalized.includes("item/tool/call") ||
    normalized.includes("tool_call")
  ) {
    return true;
  }

  return false;
}

function isUserInputRequired(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method !== null) {
    const normalized = method.toLowerCase();
    if (
      (normalized.includes("input") && normalized.includes("required")) ||
      (normalized.includes("user") && normalized.includes("input")) ||
      normalized.includes("elicitation")
    ) {
      return true;
    }
  }

  return hasExplicitUserInputRequiredCode(message);
}

// Only treat protocol control fields as user-input-required signals. Codex
// echoes user prompts in item notifications, so scanning arbitrary text would
// let issue prose containing this code pause a headless worker.
function hasExplicitUserInputRequiredCode(message: JsonObject): boolean {
  const candidates = [
    extractNestedString(message, ["code"]),
    extractNestedString(message, ["reason"]),
    extractNestedString(message, ["data", "code"]),
    extractNestedString(message, ["error", "code"]),
    extractNestedString(message, ["error", "data", "code"]),
    extractNestedString(message, ["params", "code"]),
    extractNestedString(message, ["params", "reason"]),
    extractNestedString(message, ["params", "data", "code"]),
    extractNestedString(message, ["params", "error", "code"]),
    extractNestedString(message, ["params", "error", "data", "code"]),
  ];

  return candidates.some(
    (value) => value?.toLowerCase() === "codex_user_input_required",
  );
}

function extractToolName(message: JsonObject): string | null {
  const directNames = [
    extractNestedString(message, ["params", "toolName"]),
    extractNestedString(message, ["params", "name"]),
    extractNestedString(message, ["params", "tool", "name"]),
    extractNestedString(message, ["name"]),
  ];

  return directNames.find((value) => value !== null) ?? null;
}

function extractToolInput(message: JsonObject): unknown {
  const params =
    message.params !== null &&
    typeof message.params === "object" &&
    !Array.isArray(message.params)
      ? (message.params as JsonObject)
      : null;

  if (params === null) {
    return undefined;
  }

  const candidates = [
    params.input,
    params.arguments,
    params.args,
    params.payload,
    params.toolInput,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function evaluateHeadlessCommandOutputForApproval(message: JsonObject): {
  toolName: string | null;
  reason: string;
} | null {
  const toolName = extractToolName(message);
  const toolInput = extractToolInput(message) ?? message;
  const command = extractCommandText(toolInput);
  if (command === null) {
    return null;
  }

  const reason = detectHeadlessCommandOutputRisk(command);
  if (reason === null) {
    return null;
  }

  return {
    toolName,
    reason,
  };
}

export function detectHeadlessCommandOutputRisk(
  command: string,
): string | null {
  const normalized = command
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .join("\n")
    .trim();
  if (normalized.length === 0) {
    return null;
  }

  const riskySegment = normalized
    .split(/(?:&&|\|\||;|\n)/)
    .map((segment) => segment.trim())
    .find((segment) => detectRiskyCommandSegment(segment) !== null);

  if (riskySegment === undefined) {
    return null;
  }

  const risk = detectRiskyCommandSegment(riskySegment);
  if (risk === null) {
    return null;
  }

  return [
    `Headless output guard declined ${risk.description} because it is likely to add excessive output to the Codex thread.`,
    risk.remediation,
    `Declined command segment: ${truncateCommandForReason(riskySegment)}`,
  ].join(" ");
}

function usesLoggedCommandCapture(command: string): boolean {
  return /\bscripts\/symphony-run-logged\.mjs\b/.test(command);
}

function detectRiskyCommandSegment(segment: string): {
  description: string;
  remediation: string;
} | null {
  if (
    usesLoggedCommandCapture(segment) ||
    isArtifactRedirectedSegment(segment) ||
    isClearlyCappedSegment(segment)
  ) {
    return null;
  }

  if (isBroadLineRgSegment(segment)) {
    return {
      description: "a broad `rg` line-output command",
      remediation:
        "Use `rg -l` or `rg -c` for broad discovery, then run `rg -n ... -m 20 <specific-file>` on selected files.",
    };
  }

  if (isUncapturedValidationCommand(segment)) {
    return {
      description: "an uncaptured validation command",
      remediation:
        "Run validation through `node scripts/symphony-run-logged.mjs --label <label> -- <command> ...` so full stdout/stderr is preserved as an artifact and only a bounded tail reaches the transcript.",
    };
  }

  if (isUncapturedGithubFailedLogCommand(segment)) {
    return {
      description: "an uncaptured GitHub failed-log dump",
      remediation:
        "Redirect `gh run view --log-failed` to `.symphony/validation/` or run it through `scripts/symphony-run-logged.mjs`, then inspect a bounded tail/summary.",
    };
  }

  if (isUncapturedProcessListing(segment)) {
    return {
      description: "an uncaptured process listing",
      remediation:
        "Pipe process scans through `head`, `sed -n`, or `wc`, or write the full output to `.symphony/validation/` and return a bounded summary.",
    };
  }

  if (isUncapturedTailLogDump(segment)) {
    return {
      description: "an uncaptured log tail/source dump",
      remediation:
        "Use `tail -n <small number>` or write the full log to `.symphony/validation/` and return only the artifact path and bounded tail.",
    };
  }

  if (isUnboundedLinearListing(segment)) {
    return {
      description: "an unbounded `linear-pp-cli` listing",
      remediation:
        "Add `--limit` and a narrow `--select`, or write the listing to an artifact and return only metadata plus a bounded summary.",
    };
  }

  return null;
}

function isBroadLineRgSegment(segment: string): boolean {
  if (!/\brg\b/.test(segment)) {
    return false;
  }

  if (
    /(?:^|\s)(?:--files|-l|--files-with-matches|-c|--count)(?:\s|$)/.test(
      segment,
    )
  ) {
    return false;
  }

  return extractShellWords(segment).some(isBroadSearchPathToken);
}

function isUncapturedValidationCommand(segment: string): boolean {
  return /\b(?:pnpm\s+(?:test|vitest)|vitest\s+run|npm\s+test)\b/.test(segment);
}

function isUncapturedGithubFailedLogCommand(segment: string): boolean {
  return (
    /\bgh\s+run\s+view\b/.test(segment) &&
    /(?:^|\s)--log-failed(?:\s|$)/.test(segment)
  );
}

function isUncapturedProcessListing(segment: string): boolean {
  return /(?:^|\s)(?:ps|pgrep)(?:\s|$)/.test(segment);
}

function isUncapturedTailLogDump(segment: string): boolean {
  if (!/(?:^|\s)tail(?:\s|$)/.test(segment)) {
    return false;
  }
  if (/\btail\s+-n\s+(?:[1-9][0-9]?|1[0-9]{2}|200)\b/.test(segment)) {
    return false;
  }
  return /(?:\.log\b|\/logs?\/|stdout|stderr|\.jsonl\b)/.test(segment);
}

function isUnboundedLinearListing(segment: string): boolean {
  if (!/\blinear-pp-cli\b/.test(segment)) {
    return false;
  }
  if (/(?:\s|^)--limit(?:=|\s)|(?:\s|^)--select(?:=|\s)/.test(segment)) {
    return false;
  }
  return /\b(?:comments\s+list|issues\s+list|today|stale|slipped|blocking)\b/.test(
    segment,
  );
}

function isArtifactRedirectedSegment(segment: string): boolean {
  return /(?:>>?|1>>?|2>>?|&>>?)\s*['"]?\.symphony\/validation\//.test(segment);
}

function isClearlyCappedSegment(segment: string): boolean {
  return /\|\s*(?:head\b|wc\b|sed\s+-n\b)/.test(segment);
}

function isBroadSearchPathToken(token: string): boolean {
  const trimmed = token.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    trimmed.includes("=") ||
    trimmed.includes("*")
  ) {
    return false;
  }

  const rawUnquoted = trimmed.replace(/^["']|["']$/g, "");
  const unquoted =
    rawUnquoted === "./" ? "." : rawUnquoted.replace(/^\.\//, "");
  if (unquoted === "." || unquoted === "./") {
    return true;
  }

  return /^(?:src|tests|ops|docs|pipeline-config)(?:\/[^.\s/]+)*\/?$/.test(
    unquoted,
  );
}

function extractShellWords(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  return matches ?? [];
}

function extractCommandText(value: unknown, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  for (const key of [
    "tool_input",
    "toolInput",
    "input",
    "arguments",
    "args",
    "payload",
    "params",
  ]) {
    const nested = extractCommandText(record[key], depth + 1);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function truncateCommandForReason(command: string): string {
  const maxLength = 220;
  if (command.length <= maxLength) {
    return command;
  }

  return `${command.slice(0, maxLength)}...`;
}

function extractUsage(message: JsonObject): CodexUsage | null {
  for (const candidate of walkObjects(message)) {
    const usage = coerceUsage(candidate);
    if (usage !== null) {
      return usage;
    }
  }
  return null;
}

function coerceUsage(value: JsonObject): CodexUsage | null {
  const specificAliases = [
    ["inputTokens", "outputTokens", "totalTokens"],
    ["input_tokens", "output_tokens", "total_tokens"],
  ] as const;

  // Check specific aliases first (input + output sufficient)
  for (const [inputKey, outputKey, totalKey] of specificAliases) {
    const input = asFiniteNumber(value[inputKey]);
    const output = asFiniteNumber(value[outputKey]);
    const total = asFiniteNumber(value[totalKey]);
    // Accept usage if at least input and output are present; total is optional.
    if (input !== null && output !== null) {
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total ?? input + output,
        ...extractExtendedTokenFields(value),
      };
    }
  }

  // Check generic alias (require all 3 fields to avoid false matches)
  const genericInput = asFiniteNumber(value.input);
  const genericOutput = asFiniteNumber(value.output);
  const genericTotal = asFiniteNumber(value.total);
  if (
    genericInput !== null &&
    genericOutput !== null &&
    genericTotal !== null
  ) {
    return {
      inputTokens: genericInput,
      outputTokens: genericOutput,
      totalTokens: genericTotal,
      ...extractExtendedTokenFields(value),
    };
  }

  if ("total_token_usage" in value) {
    const nested = value.total_token_usage;
    if (
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      return coerceUsage(nested as JsonObject);
    }
  }

  return null;
}

/**
 * Extract optional extended token fields (cache, reasoning) from a usage object.
 * Handles both camelCase and snake_case variants.
 */
function extractExtendedTokenFields(
  value: JsonObject,
): Partial<
  Pick<
    CodexUsage,
    "cacheReadTokens" | "cacheWriteTokens" | "noCacheTokens" | "reasoningTokens"
  >
> {
  const result: Partial<
    Pick<
      CodexUsage,
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "noCacheTokens"
      | "reasoningTokens"
    >
  > = {};

  const cacheRead =
    asFiniteNumber(value.cacheReadTokens) ??
    asFiniteNumber(value.cache_read_tokens) ??
    asFiniteNumber(value.cache_read_input_tokens) ??
    // Codex app-server usage objects report the cached share as
    // cached_input_tokens (camelCase in v2 notifications). Without these
    // aliases the cache-aware budget discount never engages for codex runs.
    asFiniteNumber(value.cachedInputTokens) ??
    asFiniteNumber(value.cached_input_tokens);
  if (cacheRead !== null) {
    result.cacheReadTokens = cacheRead;
  }

  const cacheWrite =
    asFiniteNumber(value.cacheWriteTokens) ??
    asFiniteNumber(value.cache_write_tokens) ??
    asFiniteNumber(value.cache_creation_input_tokens);
  if (cacheWrite !== null) {
    result.cacheWriteTokens = cacheWrite;
  }

  const noCache =
    asFiniteNumber(value.noCacheTokens) ??
    asFiniteNumber(value.no_cache_tokens);
  if (noCache !== null) {
    result.noCacheTokens = noCache;
  }

  const reasoning =
    asFiniteNumber(value.reasoningTokens) ??
    asFiniteNumber(value.reasoning_tokens) ??
    asFiniteNumber(value.reasoningOutputTokens) ??
    asFiniteNumber(value.reasoning_output_tokens);
  if (reasoning !== null) {
    result.reasoningTokens = reasoning;
  }

  return result;
}

function extractRateLimits(
  message: JsonObject,
): Record<string, unknown> | null {
  for (const candidate of walkObjects(message)) {
    if ("rateLimits" in candidate) {
      const nested = candidate.rateLimits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
    if ("rate_limits" in candidate) {
      const nested = candidate.rate_limits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return null;
}

function isCompactionNotification(method: string): boolean {
  return method.toLowerCase() === "thread/autocompact/completed";
}

/**
 * Extract the text of a completed agent-message item from an
 * `item/completed` notification (codex-cli 0.135 protocol: agent text
 * streams via item notifications, never on turn/completed — SYMPH-350).
 * Tolerant of camelCase and snake_case item types and text aliases.
 */
function extractCompletedAgentMessageText(message: JsonObject): string | null {
  if (message.method !== "item/completed") {
    return null;
  }

  const params = asJsonObject(message.params);
  const item = asJsonObject(params?.item);
  if (item === null) {
    return null;
  }

  const itemType =
    typeof item.type === "string"
      ? item.type
      : typeof item.itemType === "string"
        ? item.itemType
        : typeof item.item_type === "string"
          ? item.item_type
          : null;
  if (itemType !== "agentMessage" && itemType !== "agent_message") {
    return null;
  }

  for (const alias of ["text", "message"]) {
    const value = item[alias];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  if (Array.isArray(item.content)) {
    const joined = item.content
      .map((entry) => {
        const record = asJsonObject(entry);
        return record !== null && typeof record.text === "string"
          ? record.text
          : "";
      })
      .join("");
    if (joined.trim().length > 0) {
      return joined;
    }
  }

  return null;
}

function asJsonObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function extractTurnMessage(message: JsonObject): string | null {
  const direct = [
    extractNestedString(message, ["params", "message"]),
    extractNestedString(message, ["params", "summary"]),
    extractNestedString(message, ["result", "message"]),
    extractNestedString(message, ["message"]),
  ];

  return direct.find((value) => value !== null) ?? null;
}

function extractNestedString(
  source: JsonObject,
  path: readonly string[],
): string | null {
  let current: unknown = source;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as JsonObject)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function* walkObjects(value: unknown): Generator<JsonObject> {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* walkObjects(entry);
    }
    return;
  }

  const objectValue = value as JsonObject;
  yield objectValue;
  for (const nested of Object.values(objectValue)) {
    yield* walkObjects(nested);
  }
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clearTimeoutIfPresent(timer: NodeJS.Timeout | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isAppServerNotWritableError(error: unknown): boolean {
  if (
    error instanceof CodexAppServerClientError &&
    error.message === NOT_WRITABLE_MESSAGE
  ) {
    return true;
  }

  if (error === null || typeof error !== "object") {
    return false;
  }

  const maybeStreamError = error as {
    code?: unknown;
    message?: unknown;
  };
  if (
    typeof maybeStreamError.code === "string" &&
    NOT_WRITABLE_STREAM_ERROR_CODES.has(maybeStreamError.code)
  ) {
    return true;
  }

  return (
    typeof maybeStreamError.message === "string" &&
    (maybeStreamError.message.includes("write EPIPE") ||
      maybeStreamError.message.includes("stream was destroyed") ||
      maybeStreamError.message.includes("write after end"))
  );
}

function optionalTelemetry(
  usage: CodexUsage | null,
  rateLimits: Record<string, unknown> | null,
): Partial<Pick<CodexClientEvent, "usage" | "rateLimits">> {
  return {
    ...(usage === null ? {} : { usage }),
    ...(rateLimits === null ? {} : { rateLimits }),
  };
}
