import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import type { AgentRunnerCodexClient } from "../agent/runner.js";
import type {
  CodexClientEvent,
  CodexTurnResult,
  CodexUsage,
} from "../codex/app-server-client.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";

// ai-sdk-provider-claude-code uses short model names, not full Anthropic IDs.
// Map standard names to provider-expected short names.
const MODEL_ID_MAP: Record<string, string> = {
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
};

export function resolveClaudeModelId(model: string): string {
  return MODEL_ID_MAP[model] ?? model;
}

export interface ClaudeCodeRunnerOptions {
  cwd: string;
  model: string;
  onEvent?: (event: CodexClientEvent) => void;
  /** Interval in ms for workspace file-change heartbeat polling. Defaults to 5000. Set to 0 to disable. */
  heartbeatIntervalMs?: number;
}

export class ClaudeCodeRunner implements AgentRunnerCodexClient {
  private readonly options: ClaudeCodeRunnerOptions;
  private sessionId: string;
  private turnCount = 0;
  private closed = false;
  // AbortController for the in-flight generateText call.
  // claude-code provider keeps a subprocess alive — aborting ensures cleanup.
  private activeTurnController: AbortController | null = null;

  constructor(options: ClaudeCodeRunnerOptions) {
    this.options = options;
    this.sessionId = `claude-${Date.now()}`;
  }

  async startSession(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    return this.executeTurn(input.prompt, input.title);
  }

  async continueTurn(prompt: string, title: string): Promise<CodexTurnResult> {
    return this.executeTurn(prompt, title);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Abort any in-flight turn so the claude-code subprocess is killed
    this.activeTurnController?.abort();
    this.activeTurnController = null;
  }

  private async executeTurn(
    prompt: string,
    _title: string,
  ): Promise<CodexTurnResult> {
    this.turnCount += 1;
    const turnId = `turn-${this.turnCount}`;
    const threadId = this.sessionId;
    const fullSessionId = `${threadId}-${turnId}`;

    this.emit({
      event: "session_started",
      sessionId: fullSessionId,
      threadId,
      turnId,
    });

    const controller = new AbortController();
    this.activeTurnController = controller;

    const heartbeatMs = this.options.heartbeatIntervalMs ?? 5000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    try {
      // Start workspace file-change heartbeat polling.
      // Watch .git/index, workspace root, and immediate subdirectories.
      // Subdirectory mtimes change when files are created/deleted inside them,
      // catching agent activity in ops/, src/, tests/, etc. that the root
      // directory mtime alone would miss.
      if (heartbeatMs > 0) {
        const workspacePath = this.options.cwd;
        const mtimeMap = new Map<string, number>();
        mtimeMap.set(
          join(workspacePath, ".git", "index"),
          getMtimeMs(join(workspacePath, ".git", "index")),
        );
        mtimeMap.set(workspacePath, getMtimeMs(workspacePath));
        try {
          for (const entry of readdirSync(workspacePath, {
            withFileTypes: true,
          })) {
            if (
              entry.isDirectory() &&
              entry.name !== "node_modules" &&
              entry.name !== ".git"
            ) {
              const dirPath = join(workspacePath, entry.name);
              mtimeMap.set(dirPath, getMtimeMs(dirPath));
            }
          }
        } catch {
          // readdirSync may fail if workspace is not yet fully initialized
        }

        // Monitor the CC conversation directory for activity during test
        // execution and other operations that don't modify workspace files.
        // The CC conversation .jsonl file changes on every tool call and
        // response — the most reliable signal of agent activity.
        // Couples to CC project directory naming convention (undocumented);
        // degrades gracefully if the convention changes (catch blocks).
        const ccProjectKey = workspacePath
          .replace(/^\//, "-")
          .replace(/\//g, "-");
        const ccProjectDir = join(
          homedir(),
          ".claude",
          "projects",
          ccProjectKey,
        );
        // Snapshot the newest CC conversation mtime so pre-existing files
        // from previous sessions don't trigger a false heartbeat on tick 1.
        let lastCcConvMtimeMs = 0;
        try {
          for (const f of readdirSync(ccProjectDir)) {
            if (f.endsWith(".jsonl")) {
              const mtime = getMtimeMs(join(ccProjectDir, f));
              if (mtime > lastCcConvMtimeMs) lastCcConvMtimeMs = mtime;
            }
          }
        } catch {
          // CC project dir may not exist yet
        }

        heartbeatTimer = setInterval(() => {
          const changedPaths: string[] = [];
          for (const [path, lastMtime] of mtimeMap) {
            const current = getMtimeMs(path);
            if (current !== lastMtime) {
              mtimeMap.set(path, current);
              changedPaths.push(path);
            }
          }

          // Check CC conversation files for activity invisible to workspace monitoring
          try {
            for (const f of readdirSync(ccProjectDir)) {
              if (f.endsWith(".jsonl")) {
                const mtime = getMtimeMs(join(ccProjectDir, f));
                if (mtime > lastCcConvMtimeMs) {
                  lastCcConvMtimeMs = mtime;
                  changedPaths.push("cc-conversation");
                }
              }
            }
          } catch {
            // CC project dir may not exist yet or naming convention changed
          }

          if (changedPaths.length > 0) {
            this.emit({
              event: "activity_heartbeat",
              sessionId: fullSessionId,
              threadId,
              turnId,
              message: `workspace file change detected (${changedPaths.map((p) => p.replace(workspacePath, ".")).join(", ")})`,
            });
          }
        }, heartbeatMs);
      }

      const resolvedModel = resolveClaudeModelId(this.options.model);
      const result = await generateText({
        model: claudeCode(resolvedModel, {
          cwd: this.options.cwd,
          permissionMode: "bypassPermissions",
          env: { SYMPHONY_PIPELINE: "1" },
          settingSources: ["user", "project"],
          maxBudgetUsd: 50,
          streamingInput: "always",
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (...args: unknown[]) => {
                    try {
                      const arg = args[0];
                      if (
                        typeof arg === "object" &&
                        arg !== null &&
                        !Array.isArray(arg)
                      ) {
                        const input = arg as Record<string, unknown>;
                        const toolName = input.tool_name;
                        if (typeof toolName === "string") {
                          this.emit({
                            event: "approval_auto_approved",
                            sessionId: fullSessionId,
                            threadId,
                            turnId,
                            raw: {
                              params: {
                                name: toolName,
                                input: input.tool_input ?? null,
                              },
                            },
                            toolName,
                          });
                        }
                      }
                    } catch {
                      // Never let observation hook fail a tool call
                    }
                    return {};
                  },
                ],
              },
            ],
          },
        }),
        prompt,
        abortSignal: controller.signal,
      });

      const usage: CodexUsage = {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        ...(result.usage.inputTokenDetails?.cacheReadTokens !== undefined
          ? { cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens }
          : {}),
        ...(result.usage.inputTokenDetails?.cacheWriteTokens !== undefined
          ? {
              cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
            }
          : {}),
        ...(result.usage.inputTokenDetails?.noCacheTokens !== undefined
          ? { noCacheTokens: result.usage.inputTokenDetails.noCacheTokens }
          : {}),
        ...(result.usage.outputTokenDetails?.reasoningTokens !== undefined
          ? { reasoningTokens: result.usage.outputTokenDetails.reasoningTokens }
          : {}),
      };

      this.emit({
        event: "turn_completed",
        sessionId: fullSessionId,
        threadId,
        turnId,
        usage,
        message: result.text,
      });

      return {
        status: "completed",
        threadId,
        turnId,
        sessionId: fullSessionId,
        usage,
        rateLimits: null,
        message: result.text,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Claude Code turn failed";

      this.emit({
        event: "turn_failed",
        sessionId: fullSessionId,
        threadId,
        turnId,
        message,
      });

      return {
        status: "failed",
        threadId,
        turnId,
        sessionId: fullSessionId,
        usage: null,
        rateLimits: null,
        message,
      };
    } finally {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
      }
      // Clear the controller ref so close() doesn't abort a completed turn
      if (this.activeTurnController === controller) {
        this.activeTurnController = null;
      }
    }
  }

  private emit(
    input: Omit<CodexClientEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: formatEasternTimestamp(new Date()),
      codexAppServerPid: null,
    });
  }
}

function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
