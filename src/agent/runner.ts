import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  CodexAppServerClient,
  type CodexClientEvent,
  type CodexDynamicTool,
  type CodexTurnResult,
} from "../codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../codex/linear-graphql-tool.js";
import { createWorkpadSyncDynamicTool } from "../codex/workpad-sync-tool.js";
import {
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
} from "../config/defaults.js";
import type {
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  createEmptyLiveSession,
  normalizeIssueState,
  parseFailureSignal,
} from "../domain/model.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import { applyCodexEventToSession } from "../logging/session-metrics.js";
import {
  type HardStopDecision,
  type ModeScopedPermissionPolicy,
  evaluateBudgetHardStop,
  evaluateIterationHardStop,
  evaluateNoProgressHardStop,
  resolveHardStopsConfig,
} from "../policy/hard-stops.js";
import { createRunnerFromConfig, isAiSdkRunner } from "../runners/factory.js";
import type { RunnerKind } from "../runners/types.js";
import { getDurableCodexSessionArtifactDirectory } from "../shared/codex-session-artifacts.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { validateWorkspaceCwd } from "../workspace/path-safety.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import {
  type BuildTurnPromptInput,
  buildTurnPrompt,
} from "./prompt-builder.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const PROMPT_FILE_EXTENSIONS = new Set([".liquid", ".md", ".txt"]);

export interface AgentRunnerEvent extends CodexClientEvent {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  turnCount: number;
  promptChars?: number;
  estimatedPromptTokens?: number;
}

export interface AgentRunnerCodexClient {
  startSession(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult>;
  continueTurn(prompt: string, title: string): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export interface AgentRunnerCodexClientFactoryInput {
  command: string;
  ephemeralHome: boolean;
  disableSkills: boolean;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  artifactDirectory?: string;
  dynamicTools: CodexDynamicTool[];
  modePolicy?: ModeScopedPermissionPolicy;
  onEvent: (event: CodexClientEvent) => void;
}

export interface AgentRunnerOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  workspaceManager?: WorkspaceManager;
  hooks?: WorkspaceHookRunner;
  workspaceBaseRefreshLogger?: (
    entry: WorkspaceBaseRefreshLogEntry,
  ) => void | Promise<void>;
  createCodexClient?: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;
  fetchFn?: typeof fetch;
  onEvent?: (event: AgentRunnerEvent) => void;
}

export interface AgentRunInput {
  issue: Issue;
  attempt: number | null;
  signal?: AbortSignal;
  stage?: StageDefinition | null;
  stageName?: string | null;
  reworkCount?: number;
  modePolicy?: ModeScopedPermissionPolicy;
}

export interface AgentRunResult {
  issue: Issue;
  workspace: Workspace;
  runAttempt: RunAttempt;
  liveSession: LiveSession;
  turnsCompleted: number;
  lastTurn: CodexTurnResult | null;
  rateLimits: Record<string, unknown> | null;
  hardStop?: HardStopDecision | null;
}

export interface WorkspaceBaseRefreshLogEntry {
  issueId: string;
  issueIdentifier: string;
  workspacePath: string;
  stageName: string | null;
  currentHead: string | null;
  desiredBase: string | null;
  previousDesiredBase?: string | null;
  baseRef: string | null;
  fetchedBaseRef?: string | null;
  action:
    | "current"
    | "fetch_failed"
    | "no_base_ref"
    | "reset_hard"
    | "rebase_autostash"
    | "refresh_failed"
    | "retry_preserved";
  dirty: boolean | null;
  reason?: string;
}

export class AgentRunnerError extends Error {
  readonly code: string | undefined;
  readonly status: RunAttemptPhase;
  readonly failedPhase: RunAttemptPhase;
  readonly issue: Issue;
  readonly workspace: Workspace | null;
  readonly runAttempt: RunAttempt;
  readonly liveSession: LiveSession;

  constructor(input: {
    message: string;
    code?: string;
    status: RunAttemptPhase;
    failedPhase: RunAttemptPhase;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentRunnerError";
    this.code = input.code;
    this.status = input.status;
    this.failedPhase = input.failedPhase;
    this.issue = input.issue;
    this.workspace = input.workspace;
    this.runAttempt = input.runAttempt;
    this.liveSession = input.liveSession;
  }
}

export class AgentRunner {
  private readonly config: ResolvedWorkflowConfig;

  private readonly tracker: IssueTracker;

  private readonly workspaceManager: WorkspaceManager;

  private readonly hooks: WorkspaceHookRunner;

  private readonly createCodexClient: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;

  private readonly fetchFn: typeof fetch | undefined;

  private readonly onEvent: ((event: AgentRunnerEvent) => void) | undefined;

  private readonly workspaceBaseRefreshLogger:
    | ((entry: WorkspaceBaseRefreshLogEntry) => void | Promise<void>)
    | undefined;

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.hooks =
      options.hooks ??
      new WorkspaceHookRunner({
        config: options.config.hooks,
      });
    this.workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        root: options.config.workspace.root,
        hooks: this.hooks,
      });
    this.createCodexClient =
      options.createCodexClient ??
      createDefaultClientFactory(
        options.config.runner.kind,
        options.config.runner.model,
      );
    this.fetchFn = options.fetchFn;
    this.onEvent = options.onEvent;
    this.workspaceBaseRefreshLogger = options.workspaceBaseRefreshLogger;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let issue = cloneIssue(input.issue);
    let workspace: Workspace | null = null;
    let client: AgentRunnerCodexClient | null = null;
    let lastTurn: CodexTurnResult | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    const liveSession = createEmptyLiveSession();
    const runAttempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: input.attempt,
      workspacePath: "",
      startedAt: formatEasternTimestamp(new Date()),
      status: "preparing_workspace",
    };
    const abortController = createAgentAbortController(input.signal);

    // Resolve effective config from stage overrides, falling back to global
    const stage = input.stage ?? null;
    const effectiveRunnerKind = (stage?.runner ??
      this.config.runner.kind) as RunnerKind;
    const effectiveModel = stage?.model ?? this.config.runner.model;
    const globalHardStops = resolveHardStopsConfig(
      this.config.hardStops,
      DEFAULT_HARD_STOPS_CONFIG,
    );
    const hardStops = resolveHardStopsConfig(stage?.hardStops, globalHardStops);
    const effectiveMaxTurns = Math.min(
      stage?.maxTurns ?? this.config.agent.maxTurns,
      hardStops.maxIterations,
    );
    const effectivePromptTemplateSource =
      stage?.prompt ?? this.config.promptTemplate;
    let hardStop: HardStopDecision | null = null;
    let previousProgressSignature: string | null = null;
    let repeatedNoProgressTurns = 0;
    const requestLiveBudgetStop = (decision: HardStopDecision): void => {
      if (hardStop !== null) {
        return;
      }

      hardStop = {
        ...decision,
        reason: `${decision.reason} Live token telemetry crossed the budget during an in-flight turn.`,
      };
      if (client !== null) {
        void closeBestEffort(client);
      }
    };

    try {
      abortController.throwIfAborted({
        issue,
        workspace,
        runAttempt,
        liveSession,
      });

      // On fresh dispatch with stages at the initial stage, remove stale workspace
      // for a clean start.  For flat dispatch (no stages) or continuation attempts,
      // preserve the workspace so interrupted work survives restarts.
      if (
        input.attempt === null &&
        input.stageName !== null &&
        input.stageName === (this.config.stages?.initialStage ?? null)
      ) {
        try {
          await this.workspaceManager.removeForIssue(issue.id);
        } catch {
          // Best-effort: workspace may not exist
        }
      }

      workspace = await this.workspaceManager.createForIssue(issue.id);
      if (!workspace.createdNow) {
        await this.refreshReusedWorkspaceBase({
          issue,
          workspace,
          stageName: input.stageName ?? null,
          attempt: input.attempt,
        });
      }
      runAttempt.workspacePath = validateWorkspaceCwd({
        cwd: workspace.path,
        workspacePath: workspace.path,
        workspaceRoot: this.config.workspace.root,
      });
      await cleanupWorkspaceArtifacts(workspace.path);
      const workspacePath = workspace.path;

      console.warn(
        `[agent-runner] ${issue.identifier}: Using workspace path ${workspacePath}`,
      );

      await this.hooks.run({
        name: "beforeRun",
        workspacePath: workspace.path,
        ...(input.stageName
          ? { env: { SYMPHONY_STAGE: input.stageName } }
          : {}),
      });

      runAttempt.status = "launching_agent_process";
      let currentPromptChars = 0;
      let currentEstimatedPromptTokens = 0;
      const effectiveClientFactory = isAiSdkRunner(effectiveRunnerKind)
        ? (factoryInput: AgentRunnerCodexClientFactoryInput) =>
            createRunnerFromConfig({
              config: { kind: effectiveRunnerKind, model: effectiveModel },
              cwd: factoryInput.cwd,
              onEvent: factoryInput.onEvent,
              ...(factoryInput.modePolicy === undefined
                ? {}
                : { modePolicy: factoryInput.modePolicy }),
            })
        : this.createCodexClient;
      client = effectiveClientFactory({
        command: this.config.codex.command,
        ephemeralHome: this.config.codex.ephemeralHome === true,
        disableSkills: this.config.codex.disableSkills === true,
        cwd: workspace.path,
        approvalPolicy:
          input.modePolicy?.approvalPolicy ?? this.config.codex.approvalPolicy,
        threadSandbox:
          input.modePolicy?.threadSandbox ?? this.config.codex.threadSandbox,
        turnSandboxPolicy:
          input.modePolicy?.turnSandboxPolicy ??
          this.config.codex.turnSandboxPolicy,
        readTimeoutMs: this.config.codex.readTimeoutMs,
        turnTimeoutMs: this.config.codex.turnTimeoutMs,
        stallTimeoutMs: this.config.codex.stallTimeoutMs,
        artifactDirectory: getDurableCodexSessionArtifactDirectory(
          this.config.workspace.root,
          workspace.workspaceKey,
        ),
        dynamicTools: this.createDynamicTools(),
        ...(input.modePolicy === undefined
          ? {}
          : { modePolicy: input.modePolicy }),
        onEvent: (event) => {
          const telemetry = applyCodexEventToSession(liveSession, event);
          if (event.rateLimits !== undefined) {
            rateLimits = event.rateLimits;
          }
          if (
            isLiveUsageEvent(event) &&
            telemetry.totalTokensDelta > 0 &&
            hardStop === null
          ) {
            const liveHardStop = evaluateBudgetHardStop({
              config: hardStops,
              turnCount: liveSession.turnCount,
              totalTokens: liveSession.totalStageTotalTokens,
            });
            if (liveHardStop !== null) {
              requestLiveBudgetStop(liveHardStop);
            }
          }
          if (
            event.event === "session_started" &&
            "codexAppServerPid" in event
          ) {
            console.warn(
              `[agent-runner] ${issue.identifier}: CC process spawned with PID ${event.codexAppServerPid}`,
            );
          }
          this.onEvent?.({
            ...event,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt: input.attempt,
            workspacePath,
            turnCount: liveSession.turnCount,
            promptChars: currentPromptChars,
            estimatedPromptTokens: currentEstimatedPromptTokens,
          });
        },
      });
      abortController.bindClient(client);

      for (
        let turnNumber = 1;
        turnNumber <= effectiveMaxTurns;
        turnNumber += 1
      ) {
        abortController.throwIfAborted({
          issue,
          workspace,
          runAttempt,
          liveSession,
        });
        runAttempt.status = "building_prompt";
        const effectivePromptTemplate =
          turnNumber === 1
            ? await resolvePromptTemplate({
                promptTemplate: effectivePromptTemplateSource,
                workflowPath: this.config.workflowPath,
              })
            : effectivePromptTemplateSource;
        const prompt = await buildTurnPrompt({
          workflow: {
            promptTemplate: effectivePromptTemplate,
          },
          issue,
          attempt: input.attempt,
          stageName: input.stageName ?? null,
          reworkCount: input.reworkCount ?? 0,
          modePolicy: input.modePolicy ?? null,
          turnNumber,
          maxTurns: effectiveMaxTurns,
        });
        currentPromptChars = prompt.length;
        currentEstimatedPromptTokens = Math.ceil(prompt.length / 4);
        const title = `${issue.identifier}: ${issue.title}`;

        runAttempt.status =
          turnNumber === 1 ? "initializing_session" : "streaming_turn";
        lastTurn = null;
        try {
          lastTurn =
            turnNumber === 1
              ? await client.startSession({ prompt, title })
              : await client.continueTurn(prompt, title);
        } catch (error) {
          if (hardStop !== null) {
            break;
          }
          throw error;
        }
        rateLimits = lastTurn.rateLimits;

        applyCodexEventToSession(liveSession, {
          event:
            lastTurn.status === "completed"
              ? "turn_completed"
              : lastTurn.status === "failed"
                ? "turn_failed"
                : "turn_cancelled",
          timestamp: formatEasternTimestamp(new Date()),
          codexAppServerPid: liveSession.codexAppServerPid,
          sessionId: lastTurn.sessionId,
          threadId: lastTurn.threadId,
          turnId: lastTurn.turnId,
          ...(lastTurn.usage === null ? {} : { usage: lastTurn.usage }),
          ...(lastTurn.rateLimits === null
            ? {}
            : { rateLimits: lastTurn.rateLimits }),
          ...(lastTurn.message === null ? {} : { message: lastTurn.message }),
        });

        // Early exit: agent signaled stage completion or failure
        if (hardStop !== null) {
          break;
        }
        if (lastTurn.message?.trimEnd().endsWith("[STAGE_COMPLETE]")) {
          break;
        }
        if (
          lastTurn.message !== null &&
          parseFailureSignal(lastTurn.message) !== null
        ) {
          break;
        }

        // Turn failed at infrastructure level (e.g. abort/timeout) without an
        // explicit agent failure signal — propagate so the orchestrator sees
        // worker_exit_abnormal instead of the misleading worker_exit_normal.
        if (lastTurn.status !== "completed") {
          throw new AgentRunnerError({
            message: lastTurn.message ?? "Agent turn failed unexpectedly.",
            status: "failed",
            failedPhase: runAttempt.status,
            issue,
            // biome-ignore lint/style/noNonNullAssertion: workspace is assigned before this point in the run loop
            workspace: workspace!,
            runAttempt: { ...runAttempt },
            liveSession: { ...liveSession },
          });
        }

        hardStop = evaluateBudgetHardStop({
          config: hardStops,
          turnCount: liveSession.turnCount,
          totalTokens: liveSession.totalStageTotalTokens,
        });
        if (hardStop !== null) {
          break;
        }

        runAttempt.status = "finishing";
        issue = await this.refreshIssueState(issue);
        if (!this.isIssueStillActive(issue)) {
          break;
        }

        const progressSignature = createProgressSignature(issue, lastTurn);
        if (progressSignature === previousProgressSignature) {
          repeatedNoProgressTurns += 1;
        } else {
          previousProgressSignature = progressSignature;
          repeatedNoProgressTurns = 1;
        }

        hardStop = evaluateNoProgressHardStop({
          config: hardStops,
          repeatedNoProgressTurns,
          turnCount: liveSession.turnCount,
          totalTokens: liveSession.totalStageTotalTokens,
        });
        if (hardStop !== null) {
          break;
        }

        hardStop = evaluateIterationHardStop({
          config: hardStops,
          turnCount: liveSession.turnCount,
          totalTokens: liveSession.totalStageTotalTokens,
        });
        if (hardStop !== null) {
          break;
        }
      }

      runAttempt.status = "succeeded";

      return {
        issue,
        workspace,
        runAttempt,
        liveSession,
        turnsCompleted: liveSession.turnCount,
        lastTurn,
        rateLimits,
        hardStop,
      };
    } catch (error) {
      const wrapped = this.toAgentRunnerError({
        error,
        issue,
        workspace,
        runAttempt,
        liveSession,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runAttempt.status = wrapped.status;
      runAttempt.error = wrapped.message;
      throw wrapped;
    } finally {
      abortController.dispose();

      if (client !== null) {
        await closeBestEffort(client);
      }

      if (workspace !== null) {
        await this.hooks.runBestEffort({
          name: "afterRun",
          workspacePath: workspace.path,
          ...(input.stageName
            ? { env: { SYMPHONY_STAGE: input.stageName } }
            : {}),
        });
      }
    }
  }

  private createDynamicTools(): CodexDynamicTool[] {
    if (normalizeIssueState(this.config.tracker.kind ?? "") !== "linear") {
      return [];
    }

    const tools: CodexDynamicTool[] = [
      createLinearGraphqlDynamicTool({
        endpoint: this.config.tracker.endpoint,
        apiKey: this.config.tracker.apiKey,
        ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
      }),
    ];

    if (this.config.tracker.apiKey !== null) {
      tools.push(
        createWorkpadSyncDynamicTool({
          apiKey: this.config.tracker.apiKey,
          endpoint: this.config.tracker.endpoint,
          ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
        }),
      );
    }

    return tools;
  }

  private async refreshIssueState(issue: Issue): Promise<Issue> {
    const refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
    const next = refreshed[0];

    if (next === undefined) {
      return issue;
    }

    return {
      ...issue,
      identifier:
        next.identifier.trim().length > 0 ? next.identifier : issue.identifier,
      state: next.state,
    };
  }

  private isIssueStillActive(issue: Issue): boolean {
    const activeStates = new Set(
      this.config.tracker.activeStates.map((state) =>
        normalizeIssueState(state),
      ),
    );
    return activeStates.has(normalizeIssueState(issue.state));
  }

  private async refreshReusedWorkspaceBase(input: {
    issue: Issue;
    workspace: Workspace;
    stageName: string | null;
    attempt: number | null;
  }): Promise<void> {
    if (input.attempt !== null) {
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead: null,
        desiredBase: null,
        baseRef: null,
        action: "retry_preserved",
        dirty: null,
        reason: "retry_attempt",
      });
      return;
    }

    let currentHead: string;
    try {
      currentHead = await readGitCommit(input.workspace.path, "HEAD");
    } catch (error) {
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead: null,
        desiredBase: null,
        baseRef: null,
        action: "refresh_failed",
        dirty: null,
        reason: toErrorMessage(error),
      });
      throw error;
    }
    const previousBase = await resolveWorkspaceBaseRevision(
      input.workspace.path,
    );
    let fetchedBaseRef: string | null = null;
    try {
      fetchedBaseRef = await fetchWorkspaceBaseRef(input.workspace.path);
    } catch (error) {
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead,
        desiredBase: previousBase?.revision ?? null,
        previousDesiredBase: previousBase?.revision ?? null,
        baseRef: null,
        action: "fetch_failed",
        dirty: null,
        reason: toErrorMessage(error),
      });
      throw error;
    }

    const base = await resolveWorkspaceBaseRevision(input.workspace.path);
    if (base === null) {
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead,
        desiredBase: null,
        previousDesiredBase: previousBase?.revision ?? null,
        baseRef: null,
        fetchedBaseRef,
        action: "no_base_ref",
        dirty: null,
        reason: "no_candidate_base_ref_resolved",
      });
      return;
    }

    const dirty = await hasGitChanges(input.workspace.path);
    if (currentHead === base.revision) {
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead,
        desiredBase: base.revision,
        previousDesiredBase: previousBase?.revision ?? null,
        baseRef: base.ref,
        fetchedBaseRef,
        action: "current",
        dirty,
      });
      return;
    }

    const currentIsAncestor = await isGitAncestor(
      input.workspace.path,
      currentHead,
      base.revision,
    );
    const action =
      dirty || !currentIsAncestor ? "rebase_autostash" : "reset_hard";

    try {
      if (action === "reset_hard") {
        await runGit(input.workspace.path, ["reset", "--hard", base.revision], {
          timeoutMs: 30_000,
        });
      } else {
        await runGit(
          input.workspace.path,
          ["rebase", "--autostash", base.revision],
          {
            timeoutMs: 60_000,
          },
        );
      }

      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead,
        desiredBase: base.revision,
        previousDesiredBase: previousBase?.revision ?? null,
        baseRef: base.ref,
        fetchedBaseRef,
        action,
        dirty,
      });
    } catch (error) {
      await runGit(input.workspace.path, ["rebase", "--abort"], {
        timeoutMs: 10_000,
      }).catch(() => undefined);
      await this.logWorkspaceBaseRefresh({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        workspacePath: input.workspace.path,
        stageName: input.stageName,
        currentHead,
        desiredBase: base.revision,
        previousDesiredBase: previousBase?.revision ?? null,
        baseRef: base.ref,
        fetchedBaseRef,
        action: "refresh_failed",
        dirty,
        reason: toErrorMessage(error),
      });
      throw error;
    }
  }

  private async logWorkspaceBaseRefresh(
    entry: WorkspaceBaseRefreshLogEntry,
  ): Promise<void> {
    await this.workspaceBaseRefreshLogger?.(entry);
    console.warn(
      [
        `[agent-runner] ${entry.issueIdentifier}: workspace base refresh`,
        `action=${entry.action}`,
        `workspace_path=${entry.workspacePath}`,
        `current_head=${entry.currentHead ?? "unknown"}`,
        `desired_base=${entry.desiredBase ?? "unknown"}`,
        `previous_desired_base=${entry.previousDesiredBase ?? "unknown"}`,
        `base_ref=${entry.baseRef ?? "unknown"}`,
        `fetched_base_ref=${entry.fetchedBaseRef ?? "unknown"}`,
        `dirty=${entry.dirty === null ? "unknown" : String(entry.dirty)}`,
        ...(entry.reason === undefined ? [] : [`reason=${entry.reason}`]),
      ].join(" "),
    );
  }

  private toAgentRunnerError(input: {
    error: unknown;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    signal?: AbortSignal;
  }): AgentRunnerError {
    if (input.error instanceof AgentRunnerError) {
      return input.error;
    }

    if (input.signal?.aborted) {
      return new AgentRunnerError({
        message: toAbortMessage(input.signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
        cause: input.error,
      });
    }

    const message =
      input.error instanceof Error ? input.error.message : "Agent run failed.";
    const code =
      typeof input.error === "object" &&
      input.error !== null &&
      "code" in input.error &&
      typeof input.error.code === "string"
        ? input.error.code
        : undefined;

    return new AgentRunnerError({
      message,
      ...(code === undefined ? {} : { code }),
      status: classifyFailureStatus(code),
      failedPhase: input.runAttempt.status,
      issue: input.issue,
      workspace: input.workspace,
      runAttempt: { ...input.runAttempt },
      liveSession: { ...input.liveSession },
      cause: input.error,
    });
  }
}

async function cleanupWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await rm(`${workspacePath}/tmp`, {
    force: true,
    recursive: true,
  });
}

async function resolvePromptTemplate(input: {
  promptTemplate: string;
  workflowPath: string;
}): Promise<string> {
  const promptPath = resolvePromptFilePath(input);
  if (promptPath === null) {
    return input.promptTemplate;
  }

  return await readFile(promptPath, "utf8");
}

function resolvePromptFilePath(input: {
  promptTemplate: string;
  workflowPath: string;
}): string | null {
  const trimmed = input.promptTemplate.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return null;
  }

  const extension = trimmed.slice(trimmed.lastIndexOf("."));
  if (!PROMPT_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  if (
    !trimmed.includes(sep) &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  ) {
    return null;
  }

  if (isAbsolute(trimmed)) {
    return normalize(trimmed);
  }

  return normalize(resolve(dirname(input.workflowPath), trimmed));
}

async function runGit(
  workspacePath: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, ...args],
    {
      encoding: "utf8",
      timeout: options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
    },
  );
  return stdout.trim();
}

async function readGitCommit(
  workspacePath: string,
  ref: string,
): Promise<string> {
  return await runGit(workspacePath, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
}

async function hasGitChanges(workspacePath: string): Promise<boolean> {
  const status = await runGit(workspacePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return status.length > 0;
}

async function isGitAncestor(
  workspacePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(workspacePath, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceBaseRevision(
  workspacePath: string,
): Promise<{ ref: string; revision: string } | null> {
  const originHeadRef = await readGitSymbolicRef(
    workspacePath,
    "refs/remotes/origin/HEAD",
  );
  for (const ref of createGitBaseRefCandidates({
    configuredBaseBranch: process.env.SYMPHONY_BASE_BRANCH,
    originHeadRef,
  })) {
    try {
      return {
        ref,
        revision: await readGitCommit(workspacePath, ref),
      };
    } catch {
      // Try the next candidate; stale workspaces may not carry every ref.
    }
  }
  return null;
}

async function fetchWorkspaceBaseRef(
  workspacePath: string,
): Promise<string | null> {
  const originHeadRef = await readGitSymbolicRef(
    workspacePath,
    "refs/remotes/origin/HEAD",
  );
  const failures: string[] = [];

  for (const branch of createGitBaseBranchCandidates({
    configuredBaseBranch: process.env.SYMPHONY_BASE_BRANCH,
    originHeadRef,
  })) {
    try {
      await runGit(
        workspacePath,
        [
          "fetch",
          "--prune",
          "origin",
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        { timeoutMs: 60_000 },
      );

      // Bare-clone worktrees sometimes rely on local branch refs as a
      // fallback. Keep that ref fresh when it is safe, but do not let a checked
      // out local branch reject the remote-tracking repair above.
      await runGit(
        workspacePath,
        ["fetch", "origin", `+refs/heads/${branch}:refs/heads/${branch}`],
        { timeoutMs: 60_000 },
      ).catch(() => undefined);

      return branch;
    } catch (error) {
      failures.push(`${branch}: ${toErrorMessage(error)}`);
    }
  }

  try {
    await runGit(workspacePath, ["fetch", "--prune", "origin"], {
      timeoutMs: 60_000,
    });
    return null;
  } catch (error) {
    failures.push(`all refs: ${toErrorMessage(error)}`);
  }

  throw new Error(
    `Failed to fetch configured workspace base ref; tried ${failures.join("; ")}`,
  );
}

async function readGitSymbolicRef(
  workspacePath: string,
  ref: string,
): Promise<string | null> {
  try {
    const value = await runGit(workspacePath, ["symbolic-ref", ref]);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function createGitBaseRefCandidates(input: {
  configuredBaseBranch: string | undefined;
  originHeadRef: string | null;
}): string[] {
  const candidates: string[] = [];
  const configuredBaseBranch = normalizeGitBranchName(
    input.configuredBaseBranch,
  );
  if (configuredBaseBranch !== null) {
    candidates.push(`origin/${configuredBaseBranch}`, configuredBaseBranch);
  }

  const originHeadRef = normalizeGitRef(input.originHeadRef);
  if (originHeadRef !== null) {
    candidates.push(originHeadRef);
  }

  candidates.push("origin/main", "main", "origin/master", "master");
  return [...new Set(candidates)];
}

function createGitBaseBranchCandidates(input: {
  configuredBaseBranch: string | undefined;
  originHeadRef: string | null;
}): string[] {
  const candidates: string[] = [];
  const configuredBaseBranch = normalizeGitBranchName(
    input.configuredBaseBranch,
  );
  if (configuredBaseBranch !== null) {
    candidates.push(configuredBaseBranch);
  }

  const originHeadBranch = normalizeGitBranchName(input.originHeadRef ?? "");
  if (originHeadBranch !== null) {
    candidates.push(originHeadBranch);
  }

  candidates.push("main", "master");
  return [...new Set(candidates)];
}

function normalizeGitBranchName(value: string | undefined): string | null {
  const normalized = normalizeGitRef(value);
  if (normalized === null) {
    return null;
  }
  return normalized.startsWith("origin/")
    ? normalized.slice("origin/".length)
    : normalized;
}

function normalizeGitRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("refs/remotes/")) {
    return trimmed.slice("refs/remotes/".length);
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  return trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createDefaultClientFactory(
  runnerKind: string,
  runnerModel: string | null = null,
): (input: AgentRunnerCodexClientFactoryInput) => AgentRunnerCodexClient {
  const kind = runnerKind as RunnerKind;

  if (isAiSdkRunner(kind)) {
    return (input) =>
      createRunnerFromConfig({
        config: { kind, model: runnerModel },
        cwd: input.cwd,
        onEvent: input.onEvent,
        ...(input.modePolicy === undefined
          ? {}
          : { modePolicy: input.modePolicy }),
      });
  }

  return createDefaultCodexClient;
}

function createDefaultCodexClient(
  input: AgentRunnerCodexClientFactoryInput,
): AgentRunnerCodexClient {
  return new CodexAppServerClient({
    command: input.command,
    ephemeralHome: input.ephemeralHome,
    disableSkills: input.disableSkills,
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    threadSandbox: input.threadSandbox,
    turnSandboxPolicy: input.turnSandboxPolicy,
    readTimeoutMs: input.readTimeoutMs,
    turnTimeoutMs: input.turnTimeoutMs,
    stallTimeoutMs: input.stallTimeoutMs,
    ...(input.artifactDirectory === undefined
      ? {}
      : { artifactDirectory: input.artifactDirectory }),
    dynamicTools: input.dynamicTools,
    ...(input.modePolicy === undefined ? {} : { modePolicy: input.modePolicy }),
    onEvent: input.onEvent,
  });
}

function classifyFailureStatus(code: string | undefined): RunAttemptPhase {
  if (code === "codex_turn_timeout" || code === "hook_timed_out") {
    return "timed_out";
  }

  if (code === "codex_session_stalled") {
    return "stalled";
  }

  return "failed";
}

async function closeBestEffort(client: AgentRunnerCodexClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing is cleanup-only here; preserve the primary failure cause.
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
  };
}

const DEFAULT_HARD_STOPS_CONFIG = {
  maxIterations: DEFAULT_HARD_STOP_MAX_ITERATIONS,
  noProgressTurns: DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  maxTokensPerUnit: DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  maxDollarBudgetUsd: DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  premiumBudgetPauseRatio: DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
  estimatedCostPer1kTokensUsd:
    DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
};

function createProgressSignature(issue: Issue, turn: CodexTurnResult): string {
  return JSON.stringify({
    state: normalizeIssueState(issue.state),
    title: issue.title,
    updatedAt: issue.updatedAt,
    status: turn.status,
    message: turn.message?.trim() ?? null,
  });
}

function isLiveUsageEvent(event: CodexClientEvent): boolean {
  if (event.usage === undefined) {
    return false;
  }

  switch (event.event) {
    case "notification":
    case "other_message":
    case "unsupported_tool_call":
      return true;
    case "activity_heartbeat":
    case "approval_auto_approved":
    case "malformed":
    case "session_started":
    case "startup_failed":
    case "turn_completed":
    case "turn_failed":
    case "turn_cancelled":
    case "turn_ended_with_error":
    case "turn_input_required":
    case "session_artifact_saved":
      return false;
  }
}

function createAgentAbortController(signal: AbortSignal | undefined): {
  bindClient(client: AgentRunnerCodexClient): void;
  dispose(): void;
  throwIfAborted(input: {
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
  }): void;
} {
  let client: AgentRunnerCodexClient | null = null;
  let listener: (() => void) | null = null;

  const closeClient = () => {
    if (client === null) {
      return;
    }

    void closeBestEffort(client);
  };

  if (signal !== undefined) {
    listener = () => {
      closeClient();
    };
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    bindClient(nextClient) {
      client = nextClient;
      if (signal?.aborted) {
        closeClient();
      }
    },
    dispose() {
      if (signal !== undefined && listener !== null) {
        signal.removeEventListener("abort", listener);
      }
      listener = null;
      client = null;
    },
    throwIfAborted(input) {
      if (!signal?.aborted) {
        return;
      }

      throw new AgentRunnerError({
        message: toAbortMessage(signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
      });
    },
  };
}

function toAbortMessage(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }

  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string" &&
    reason.message.trim().length > 0
  ) {
    return reason.message.trim();
  }

  return "Agent run cancelled.";
}

export type { BuildTurnPromptInput };
