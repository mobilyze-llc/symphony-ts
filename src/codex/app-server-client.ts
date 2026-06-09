import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants, statSync } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";

import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  type ModeScopedPermissionPolicy,
  detectModePermissionAction,
  evaluateModePermission,
} from "../policy/hard-stops.js";
import { VERSION } from "../version.js";

const DEFAULT_SYSTEM_SKILL_NAMES = Object.freeze([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "symphony-ts",
  version: VERSION,
});

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
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

export type CodexTurnStatus = "completed" | "failed" | "cancelled";

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
    | "notification"
    | "other_message"
    | "malformed"
    | "activity_heartbeat";
  timestamp: string;
  codexAppServerPid: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  usage?: CodexUsage;
  rateLimits?: Record<string, unknown> | null;
  errorCode?: string;
  message?: string;
  raw?: unknown;
  toolName?: string | null;
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
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
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
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;

  private child: ChildProcessWithoutNullStreams | null = null;
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

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(
      new CodexAppServerClientError(
        "Codex session closed.",
        ERROR_CODES.codexProtocolError,
      ),
    );

    if (this.currentTurn !== null) {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          "Codex session closed while a turn was running.",
          ERROR_CODES.codexProtocolError,
        ),
        "turn_ended_with_error",
      );
    }

    const child = this.child;
    this.child = null;
    if (child === null) {
      await this.cleanupEphemeralCodexHome();
      return;
    }

    const childExited = child.exitCode !== null || child.signalCode !== null;
    if (!childExited) {
      child.kill("SIGTERM");
    }

    await waitForChildExit(child);
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
    try {
      const env = await this.createSpawnEnvironment();
      this.child = spawn("bash", ["-lc", this.renderSpawnCommand(env)], {
        cwd: this.options.cwd,
        env,
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
        this.finishTurnWithError(wrapped, "turn_ended_with_error");
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
        this.finishTurnWithError(error, "turn_ended_with_error");
      }
      if (!this.closed && this.threadId === null) {
        this.emit({
          event: "startup_failed",
          errorCode: error.code,
          message: error.message,
        });
      }
      this.child = null;
      void this.cleanupEphemeralCodexHome().catch((cleanupError) => {
        this.emit({
          event: "other_message",
          message: `Failed to clean up ephemeral Codex home: ${toErrorMessage(cleanupError)}`,
        });
      });
    });

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

  private async createSpawnEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (this.options.ephemeralHome !== true) {
      if (this.options.disableSkills === true) {
        throw new CodexAppServerClientError(
          "codex.disable_skills requires codex.ephemeral_home so Symphony does not mutate the operator Codex config.",
          ERROR_CODES.codexLaunchFailed,
        );
      }
      return { ...process.env };
    }

    await this.cleanupEphemeralCodexHome();
    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const codexHome = await mkdtemp(join(tmpdir(), "symphony-codex-home-"));
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
      const skillPaths = await discoverCodexSkillPaths({
        codexHome,
        cwd: this.options.cwd,
        sourceHome,
      });
      await writeFile(
        join(codexHome, "config.toml"),
        renderDisabledSkillsConfig(skillPaths),
      );
    }

    return {
      ...process.env,
      CODEX_HOME: codexHome,
    };
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
    const cleanup = rm(codexHome, { recursive: true, force: true }).finally(
      () => {
        if (this.ephemeralCodexHomeCleanup === cleanup) {
          this.ephemeralCodexHomeCleanup = null;
        }
      },
    );
    this.ephemeralCodexHomeCleanup = cleanup;
    await cleanup;
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
      const permissionDenial = this.evaluateModePermissionForApproval(parsed);
      if (permissionDenial !== null) {
        if (responseId !== null) {
          this.send({
            id: parsed.id,
            result: createApprovalResponse(false, permissionDenial.reason),
          });
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
        this.send({
          id: parsed.id,
          result: createApprovalResponse(true),
        });
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
        this.send({
          id: parsed.id,
          result: {
            success: false,
            error: {
              code: ERROR_CODES.codexDynamicToolRejected,
              message: `Unsupported tool call: ${toolName ?? "unknown"}`,
            },
          },
        });
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
        this.send({
          id: parsed.id,
          error: {
            code: -32000,
            message: error.message,
            data: {
              code: error.code,
            },
          },
        });
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
        event: "notification",
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
      message: extractTurnMessage(raw),
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

  private send(message: JsonObject): void {
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      throw new CodexAppServerClientError(
        "Codex app-server process is not writable.",
        ERROR_CODES.codexProtocolError,
      );
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(
    input: Omit<CodexClientEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: formatEasternTimestamp(new Date()),
      codexAppServerPid:
        this.child?.pid === undefined ? null : String(this.child.pid),
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
    try {
      const result = await tool.execute(extractToolInput(message));
      this.send({
        id: requestId,
        result,
      });
    } catch (error) {
      this.send({
        id: requestId,
        result: {
          success: false,
          error: {
            code: ERROR_CODES.codexDynamicToolRejected,
            message: `Dynamic tool ${tool.name} failed: ${toErrorMessage(error)}`,
          },
        },
      });
    }
  }
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
    join(input.sourceHome, "skills"),
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

function renderDisabledSkillsConfig(skillPaths: string[]): string {
  if (skillPaths.length === 0) {
    return "";
  }
  return `${skillPaths
    .map(
      (skillPath) =>
        `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`,
    )
    .join("\n")}\n`;
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
  if (normalized.includes("approval")) {
    return true;
  }

  return containsStringValue(message, "approval");
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

  return containsStringValue(message, "user_input_required");
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
    asFiniteNumber(value.cache_read_input_tokens);
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
    asFiniteNumber(value.reasoning_tokens);
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

function containsStringValue(value: unknown, expected: string): boolean {
  const target = expected.toLowerCase();
  if (typeof value === "string") {
    return value.toLowerCase().includes(target);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsStringValue(entry, expected));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) =>
      containsStringValue(entry, expected),
    );
  }
  return false;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clearTimeoutIfPresent(timer: NodeJS.Timeout | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
