import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  CodexAppServerClient,
  type CodexClientEvent,
  type CodexDynamicTool,
  type CodexSessionClosureInitiator,
  type CodexTurnResult,
} from "../codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../codex/linear-graphql-tool.js";
import { createWorkpadSyncDynamicTool } from "../codex/workpad-sync-tool.js";
import {
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
  DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  DEFAULT_HARD_STOP_MAX_DOLLAR_BUDGET_USD,
  DEFAULT_HARD_STOP_MAX_ITERATIONS,
  DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT,
  DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT,
  DEFAULT_HARD_STOP_MAX_TOKENS_PER_UNIT,
  DEFAULT_HARD_STOP_NO_PROGRESS_TURNS,
  DEFAULT_HARD_STOP_PREMIUM_BUDGET_PAUSE_RATIO,
} from "../config/defaults.js";
import type {
  ResolvedWorkflowConfig,
  StageDefinition,
  WorkflowHardStopsConfig,
} from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type ReasoningEffort,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  containsStageCompleteSignal,
  createEmptyLiveSession,
  normalizeIssueState,
  parseFailureSignal,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import { applyCodexEventToSession } from "../logging/session-metrics.js";
import {
  type HardStopDecision,
  type ModeScopedPermissionPolicy,
  evaluateBudgetHardStop,
  evaluateIterationHardStop,
  evaluateNoProgressHardStop,
  evaluateRateLimitBudgetHardStop,
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
/**
 * SYMPH-412: in-run cap on fresh-session rotations after mid-turn closures.
 * Past this, the closure propagates as codex_session_closed_mid_turn so the
 * orchestrator retry ladder (and the SYMPH-398 stage circuit breaker) bound
 * the recurrence instead of the runner looping forever.
 */
const MAX_MID_TURN_CLOSURE_ROTATIONS_PER_RUN = 2;

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
  close(input?: {
    closureInitiator?: CodexSessionClosureInitiator;
  }): Promise<void>;
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
  toolOutputTokenLimit: number;
  modelAutoCompactTokenLimit: number;
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
  /**
   * Frozen gate-passed AC snapshot (SYMPH-374), rendered into the prompt
   * as `acceptance_criteria`; null/absent before the gate has passed.
   */
  acceptanceCriteria?: string | null;
  modePolicy?: ModeScopedPermissionPolicy;
  /**
   * Budget-escalation multiplier for this unit (SYMPH-337): scales the
   * token and dollar unit budgets after stage/global resolution. 1 or
   * undefined means no escalation.
   */
  budgetMultiplier?: number;
  /**
   * Per-run Codex reasoning override for risk-predicate escalation. null or
   * undefined preserves the workflow's baseline command.
   */
  reasoningEffort?: ReasoningEffort | null;
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
    const resolvedHardStops = resolveHardStopsConfig(
      stage?.hardStops,
      globalHardStops,
    );
    const hardStops = applyBudgetMultiplier(
      resolvedHardStops,
      input.budgetMultiplier,
    );
    const effectiveMaxTurns = Math.min(
      stage?.maxTurns ?? this.config.agent.maxTurns,
      hardStops.maxIterations,
    );
    const effectivePromptTemplateSource =
      stage?.prompt ?? this.config.promptTemplate;
    let hardStop: HardStopDecision | null = null;
    let pendingLiveBudgetGraceStop: HardStopDecision | null = null;
    let previousProgressSignature: string | null = null;
    let repeatedNoProgressTurns = 0;
    const rateLimitBudgetConfigured =
      hardStops.maxPrimaryWindowPctPerUnit !== null ||
      hardStops.maxSecondaryWindowPctPerUnit !== null;
    const requestLiveBudgetStop = (decision: HardStopDecision): void => {
      if (hardStop !== null) {
        return;
      }

      if (canDeferLiveBudgetStopWithinGrace(decision, hardStops)) {
        pendingLiveBudgetGraceStop = decision;
        return;
      }

      hardStop = addLiveBudgetStopReason(
        decision,
        isBudgetHardStopTrigger(decision.trigger) &&
          hardStops.liveBudgetGraceRatio > 0
          ? `Live token telemetry exceeded the ${formatLiveBudgetGracePct(hardStops.liveBudgetGraceRatio)} grace ceiling during an in-flight turn.`
          : "Live token telemetry crossed the budget during an in-flight turn.",
      );
      if (client !== null) {
        void closeBestEffort(client, "budget_hard_stop");
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
      const workspaceKey = workspace.workspaceKey;

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
      // Workspaces are git worktrees: index writes land in the per-worktree
      // gitdir, while object/ref writes land in this product's shared bare
      // clone outside the workspace cwd. Grant both roots so preserved
      // worktrees can commit without reopening discovery to the runtime repo.
      const gitMetadataRoots = await resolveGitMetadataWritableRoots(
        workspace.path,
        this.config.workspace.root,
      );
      const buildClient = (): AgentRunnerCodexClient =>
        effectiveClientFactory({
          command: applyReasoningEffortToCodexCommand(
            this.config.codex.command,
            input.reasoningEffort ?? null,
          ),
          ephemeralHome: this.config.codex.ephemeralHome === true,
          disableSkills: this.config.codex.disableSkills === true,
          cwd: workspacePath,
          approvalPolicy:
            input.modePolicy?.approvalPolicy ??
            this.config.codex.approvalPolicy,
          // thread/start only accepts a sandbox MODE; writable roots are a
          // turn-level concept — and turns are where git executes.
          threadSandbox:
            input.modePolicy?.threadSandbox ?? this.config.codex.threadSandbox,
          // The bare-clone root keeps git commits working (SYMPH-353); the
          // cmux-spawn state dir keeps in-pipeline council lanes from EPERMing
          // on their concurrency lock and failing the gate closed (SYMPH-394).
          turnSandboxPolicy: augmentWorkspaceWriteSandbox(
            input.modePolicy?.turnSandboxPolicy ??
              this.config.codex.turnSandboxPolicy,
            ...gitMetadataRoots,
            resolveCmuxSpawnStateRoot(),
          ),
          readTimeoutMs: this.config.codex.readTimeoutMs,
          turnTimeoutMs: this.config.codex.turnTimeoutMs,
          stallTimeoutMs: this.config.codex.stallTimeoutMs,
          toolOutputTokenLimit:
            this.config.codex.toolOutputTokenLimit ??
            DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
          modelAutoCompactTokenLimit:
            this.config.codex.modelAutoCompactTokenLimit ??
            DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
          artifactDirectory: getDurableCodexSessionArtifactDirectory(
            this.config.workspace.root,
            workspaceKey,
          ),
          dynamicTools: this.createDynamicTools(),
          ...(input.modePolicy === undefined
            ? {}
            : { modePolicy: input.modePolicy }),
          onEvent: (event) => {
            const telemetry = applyCodexEventToSession(liveSession, event);
            if (event.rateLimits !== undefined) {
              rateLimits = event.rateLimits;
              if (rateLimitBudgetConfigured && hardStop === null) {
                const rateLimitHardStop = evaluateRateLimitBudgetHardStop({
                  config: hardStops,
                  turnCount: liveSession.turnCount,
                  totalTokens: liveSession.totalStageTotalTokens,
                  cacheReadTokens: liveSession.totalStageCacheReadTokens,
                  rateLimitUsage: liveSession.rateLimitWindows,
                });
                if (rateLimitHardStop !== null) {
                  requestLiveBudgetStop(rateLimitHardStop);
                }
              }
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
                cacheReadTokens: liveSession.totalStageCacheReadTokens,
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
      client = buildClient();
      abortController.bindClient(client);

      // Session rotation state (SYMPH-412). `clientFreshSession` tracks
      // whether the next turn must open a NEW session (startSession) rather
      // than continue the existing thread; `clientInputTokens` accumulates
      // input tokens observed on the current session only, so the proactive
      // rotation guard bounds per-session context, not per-stage totals.
      let clientFreshSession = true;
      let clientInputTokens = 0;
      let midTurnClosureRotations = 0;
      const sessionRotationInputTokens =
        this.config.codex.sessionRotationInputTokens ??
        DEFAULT_CODEX_SESSION_ROTATION_INPUT_TOKENS;
      const rotateClient = async (
        reason: "mid_turn_closure" | "input_token_threshold",
        detail: string,
      ): Promise<void> => {
        const previous = client;
        if (previous !== null) {
          await closeBestEffort(previous, "session_rotation");
        }
        client = buildClient();
        abortController.bindClient(client);
        clientFreshSession = true;
        clientInputTokens = 0;
        console.warn(`[agent-runner] ${issue.identifier}: ${detail}`);
        this.onEvent?.({
          event: "session_rotated",
          timestamp: formatEasternTimestamp(new Date()),
          codexAppServerPid: liveSession.codexAppServerPid,
          sessionId: liveSession.sessionId,
          threadId: liveSession.threadId,
          message: detail,
          raw: { rotation_reason: reason },
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          attempt: input.attempt,
          workspacePath,
          turnCount: liveSession.turnCount,
        });
      };

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
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          modePolicy: input.modePolicy ?? null,
          turnNumber,
          maxTurns: effectiveMaxTurns,
        });
        currentPromptChars = prompt.length;
        currentEstimatedPromptTokens = Math.ceil(prompt.length / 4);
        const title = `${issue.identifier}: ${issue.title}`;

        runAttempt.status = clientFreshSession
          ? "initializing_session"
          : "streaming_turn";
        lastTurn = null;
        try {
          lastTurn = clientFreshSession
            ? await client.startSession({ prompt, title })
            : await client.continueTurn(prompt, title);
          clientFreshSession = false;
        } catch (error) {
          if (hardStop !== null) {
            break;
          }
          // Mid-turn session closure (SYMPH-412): the app-server died (or was
          // closed) while this turn was streaming. Resuming the dead session
          // is impossible and re-running the whole attempt re-accumulates the
          // same context — rotate to a FRESH session and retry this turn
          // in-place, bounded per run. Aborts and hard stops never rotate.
          if (
            isMidTurnSessionClosureError(error) &&
            input.signal?.aborted !== true &&
            midTurnClosureRotations < MAX_MID_TURN_CLOSURE_ROTATIONS_PER_RUN
          ) {
            midTurnClosureRotations += 1;
            pendingLiveBudgetGraceStop = null;
            await rotateClient(
              "mid_turn_closure",
              `fresh session forced after mid-turn closure (rotation ${midTurnClosureRotations}/${MAX_MID_TURN_CLOSURE_ROTATIONS_PER_RUN}): ${toErrorMessage(error)}`,
            );
            // Retry the same turn number on the fresh session.
            turnNumber -= 1;
            continue;
          }
          throw error;
        }
        clientInputTokens += lastTurn.usage?.inputTokens ?? 0;
        rateLimits = lastTurn.rateLimits;

        // SYMPH-412: a mid-turn closure already emitted one `session_started`
        // (which incremented `liveSession.turnCount`) for a turn that produced
        // no output; the rotated retry emits a SECOND `session_started` for the
        // same logical turn. Subtract the per-run rotation count so policy gates
        // (iteration cap) and the reported `turnsCompleted` reflect real turns,
        // not the inflated session-start tally. Proactive rotations do NOT
        // double-count (they replace one continueTurn with one startSession),
        // so only mid-turn-closure rotations are compensated.
        const realTurnCount = liveSession.turnCount - midTurnClosureRotations;

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

        const hasStageCompleteSignal = containsStageCompleteSignal(
          lastTurn.message,
        );
        const hasFailureSignal =
          lastTurn.message !== null &&
          parseFailureSignal(lastTurn.message) !== null;

        // Early exit: agent signaled stage completion or failure.
        if (hardStop !== null) {
          break;
        }
        if (lastTurn.status !== "completed" && !hasFailureSignal) {
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

        const postTurnBudgetStop = evaluateBudgetHardStop({
          config: hardStops,
          turnCount: realTurnCount,
          totalTokens: liveSession.totalStageTotalTokens,
          cacheReadTokens: liveSession.totalStageCacheReadTokens,
        });
        if (pendingLiveBudgetGraceStop !== null) {
          const finalDecision =
            postTurnBudgetStop ?? pendingLiveBudgetGraceStop;
          hardStop = addLiveBudgetStopReason(
            finalDecision,
            canDeferLiveBudgetStopWithinGrace(finalDecision, hardStops)
              ? `Live token telemetry crossed the budget during an in-flight turn; paused after the turn finished within ${formatLiveBudgetGracePct(hardStops.liveBudgetGraceRatio)} grace.`
              : `Live token telemetry crossed the budget during an in-flight turn; final completed-turn usage exceeded the ${formatLiveBudgetGracePct(hardStops.liveBudgetGraceRatio)} grace ceiling before another live update interrupted it.`,
          );
          break;
        }
        if (hasStageCompleteSignal || hasFailureSignal) {
          break;
        }
        hardStop = postTurnBudgetStop;
        if (hardStop !== null) {
          break;
        }

        if (rateLimitBudgetConfigured) {
          hardStop = evaluateRateLimitBudgetHardStop({
            config: hardStops,
            turnCount: realTurnCount,
            totalTokens: liveSession.totalStageTotalTokens,
            cacheReadTokens: liveSession.totalStageCacheReadTokens,
            rateLimitUsage: liveSession.rateLimitWindows,
          });
          if (hardStop !== null) {
            break;
          }
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
          turnCount: realTurnCount,
          totalTokens: liveSession.totalStageTotalTokens,
          cacheReadTokens: liveSession.totalStageCacheReadTokens,
        });
        if (hardStop !== null) {
          break;
        }

        hardStop = evaluateIterationHardStop({
          config: hardStops,
          turnCount: realTurnCount,
          totalTokens: liveSession.totalStageTotalTokens,
          cacheReadTokens: liveSession.totalStageCacheReadTokens,
        });
        if (hardStop !== null) {
          break;
        }

        // Proactive session rotation (SYMPH-412): mid-turn closures cluster
        // at very high cumulative session context (0.9M–2.5M input tokens).
        // Rotate to a fresh session BEFORE the next turn once this session's
        // cumulative input tokens cross the configured threshold.
        if (
          sessionRotationInputTokens > 0 &&
          clientInputTokens >= sessionRotationInputTokens &&
          turnNumber < effectiveMaxTurns
        ) {
          await rotateClient(
            "input_token_threshold",
            `fresh session forced before next turn: cumulative session input tokens ${clientInputTokens} >= rotation threshold ${sessionRotationInputTokens}`,
          );
        }
      }

      runAttempt.status = "succeeded";

      return {
        issue,
        workspace,
        runAttempt,
        liveSession,
        // SYMPH-412: discount the extra session_started emitted by each
        // mid-turn-closure rotation so this reports real completed turns.
        turnsCompleted: liveSession.turnCount - midTurnClosureRotations,
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
        await closeBestEffort(client, "shutdown");
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

const MODEL_REASONING_EFFORT_CONFIG_PATTERN =
  /--config\s+(?:"model_reasoning_effort=(?:\\"|")?(?:low|medium|high)(?:\\"|")?"|'model_reasoning_effort="(?:low|medium|high)"'|model_reasoning_effort=(?:"(?:low|medium|high)"|(?:low|medium|high)))/;

function applyReasoningEffortToCodexCommand(
  command: string,
  effort: ReasoningEffort | null,
): string {
  if (effort === null) {
    return command;
  }

  const configFlag = `--config 'model_reasoning_effort="${effort}"'`;
  if (MODEL_REASONING_EFFORT_CONFIG_PATTERN.test(command)) {
    return command.replace(MODEL_REASONING_EFFORT_CONFIG_PATTERN, configFlag);
  }

  const inserted = command.replace(
    /(^|\s)app-server(\s|$)/,
    `$1${configFlag} app-server$2`,
  );
  return inserted === command ? `${command} ${configFlag}` : inserted;
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
    toolOutputTokenLimit: input.toolOutputTokenLimit,
    modelAutoCompactTokenLimit: input.modelAutoCompactTokenLimit,
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

/**
 * SYMPH-412: a Codex session/process died while a turn was streaming. The
 * thread cannot be resumed and the recovery policy is a fresh session.
 */
function isMidTurnSessionClosureError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === ERROR_CODES.codexSessionClosedMidTurn
  );
}

async function closeBestEffort(
  client: AgentRunnerCodexClient,
  closureInitiator: CodexSessionClosureInitiator,
): Promise<void> {
  try {
    await client.close({ closureInitiator });
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
  liveBudgetGraceRatio: DEFAULT_HARD_STOP_LIVE_BUDGET_GRACE_RATIO,
  estimatedCostPer1kTokensUsd:
    DEFAULT_HARD_STOP_ESTIMATED_COST_PER_1K_TOKENS_USD,
  cachedTokenCostRatio: DEFAULT_HARD_STOP_CACHED_TOKEN_COST_RATIO,
  maxPrimaryWindowPctPerUnit: DEFAULT_HARD_STOP_MAX_PRIMARY_WINDOW_PCT_PER_UNIT,
  maxSecondaryWindowPctPerUnit:
    DEFAULT_HARD_STOP_MAX_SECONDARY_WINDOW_PCT_PER_UNIT,
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

// Escalated units (SYMPH-337) widen the per-unit token and dollar budgets;
// iteration/no-progress caps and pricing inputs stay fixed.
/**
 * Resolve the git metadata directories the turn sandbox must be allowed to
 * write (SYMPH-353, SYMPH-447). Worktree workspaces carry a `.git` FILE
 * pointing at `<bare-clone>/worktrees/<id>`; Git creates `index.lock` in that
 * per-worktree gitdir, while new objects and branch refs still live in the
 * common bare clone. Grant both, resolving relative gitdir pointers the same
 * way Git does. Unparseable layouts fall back to the product's `.bare-clones`
 * parent so commits keep working.
 */
async function resolveGitMetadataWritableRoots(
  workspacePath: string,
  workspaceRoot: string,
): Promise<string[]> {
  const fallback = join(workspaceRoot, ".bare-clones");
  try {
    const pointer = await readFile(join(workspacePath, ".git"), "utf8");
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
    if (match?.[1] !== undefined) {
      const rawGitdir = match[1].trim();
      const gitdir = normalize(
        isAbsolute(rawGitdir) ? rawGitdir : resolve(workspacePath, rawGitdir),
      );
      const marker = `${sep}worktrees${sep}`;
      const markerIndex = gitdir.lastIndexOf(marker);
      if (markerIndex > 0) {
        return dedupeRoots([], [gitdir, gitdir.slice(0, markerIndex)]);
      }
      return [gitdir];
    }
  } catch {
    // `.git` is a directory (full clone) or unreadable — fall through.
  }
  return [fallback];
}

/**
 * Resolve cmux-spawn's cross-process state directory (SYMPH-394). cmux-spawn
 * (crucible/scripts/cmux_spawn.py) takes a per-agent flock under
 * `~/.cmux-spawn/locks/` to enforce its concurrency cap; the sandbox must be
 * allowed to write the whole `~/.cmux-spawn` dir (locks today, future state
 * files tomorrow) or every in-pipeline council lane EPERMs on the lock and the
 * gate fails closed. The Python side hardcodes `Path.home() / ".cmux-spawn"`
 * with no env override, so we mirror that default here.
 */
export function resolveCmuxSpawnStateRoot(): string {
  return join(homedir(), ".cmux-spawn");
}

/**
 * Append shared writable roots (the git-metadata bare clone, SYMPH-353; the
 * cmux-spawn state dir, SYMPH-394) to a workspace-write sandbox policy. String
 * policies are expanded to object form; object policies keep their other
 * fields (the client reads camelCase before snake_case). Each extra root is
 * deduped against roots already present. Non-workspace-write policies pass
 * through untouched.
 */
export function augmentWorkspaceWriteSandbox(
  value: unknown,
  ...extraRoots: string[]
): unknown {
  if (value === "workspace-write" || value === "workspaceWrite") {
    return {
      type: "workspace-write",
      writableRoots: dedupeRoots([], extraRoots),
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "workspace-write" && type !== "workspaceWrite") {
    return value;
  }

  const isStringArray = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every((entry) => typeof entry === "string");
  const existing = [record.writableRoots, record.writable_roots].find(
    isStringArray,
  );
  for (const [key, candidate] of [
    ["writableRoots", record.writableRoots],
    ["writable_roots", record.writable_roots],
  ] as const) {
    if (candidate !== undefined && !isStringArray(candidate)) {
      // The client normalizer would silently drop this too — at least say so.
      console.warn(
        `[agent-runner] sandbox policy ${key} is not a string array; ignoring it`,
      );
    }
  }
  const roots = existing ?? [];
  const merged = dedupeRoots(roots, extraRoots);
  if (merged.length === roots.length) {
    // Every extra root is already present — nothing to add.
    return value;
  }

  // Rebuild without either original key so neither a stale snake_case
  // duplicate nor a malformed camelCase value survives the spread.
  const {
    writable_roots: _staleSnakeRoots,
    writableRoots: _staleCamelRoots,
    ...rest
  } = record;
  return {
    ...rest,
    writableRoots: merged,
  };
}

/** Append each extra root that is not already present, preserving order. */
function dedupeRoots(existing: string[], extraRoots: string[]): string[] {
  const merged = [...existing];
  for (const root of extraRoots) {
    if (!merged.includes(root)) {
      merged.push(root);
    }
  }
  return merged;
}

function applyBudgetMultiplier(
  config: WorkflowHardStopsConfig,
  multiplier: number | undefined,
): WorkflowHardStopsConfig {
  if (
    multiplier === undefined ||
    !Number.isFinite(multiplier) ||
    multiplier <= 1
  ) {
    return config;
  }

  return {
    ...config,
    // Tokens are integral counts; dollars stay fractional on purpose.
    maxTokensPerUnit: Math.round(config.maxTokensPerUnit * multiplier),
    maxDollarBudgetUsd: config.maxDollarBudgetUsd * multiplier,
  };
}

function canDeferLiveBudgetStopWithinGrace(
  decision: HardStopDecision,
  config: WorkflowHardStopsConfig,
): boolean {
  if (
    config.liveBudgetGraceRatio <= 0 ||
    !isBudgetHardStopTrigger(decision.trigger) ||
    decision.billableTokens === undefined
  ) {
    return false;
  }

  const graceMultiplier = 1 + config.liveBudgetGraceRatio;
  const dollarGraceThreshold =
    decision.trigger === "premium_spend_near_ceiling"
      ? config.maxDollarBudgetUsd * config.premiumBudgetPauseRatio
      : config.maxDollarBudgetUsd;
  return (
    decision.billableTokens <= config.maxTokensPerUnit * graceMultiplier &&
    decision.estimatedCostUsd <= dollarGraceThreshold * graceMultiplier
  );
}

function isBudgetHardStopTrigger(
  trigger: HardStopDecision["trigger"],
): boolean {
  return (
    trigger === "token_budget" ||
    trigger === "dollar_budget" ||
    trigger === "premium_spend_near_ceiling"
  );
}

function addLiveBudgetStopReason(
  decision: HardStopDecision,
  suffix: string,
): HardStopDecision {
  return {
    ...decision,
    reason: `${decision.reason} ${suffix}`,
  };
}

function formatLiveBudgetGracePct(ratio: number): string {
  return `${(ratio * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function isLiveUsageEvent(event: CodexClientEvent): boolean {
  if (event.usage === undefined) {
    return false;
  }

  switch (event.event) {
    case "notification":
    case "other_message":
    case "unsupported_tool_call":
    case "compaction":
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
    case "session_rotated":
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

    void closeBestEffort(client, "operator_abort");
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
