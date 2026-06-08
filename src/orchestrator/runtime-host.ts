import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  constants as fsConstants,
  mkdirSync,
  openSync,
} from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";

import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunnerEvent,
} from "../agent/runner.js";
import { AgentRunner } from "../agent/runner.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import type {
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import { WorkflowWatcher } from "../config/workflow-watch.js";
import type {
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  ExecutionHistory,
  Issue,
  LoopTraceEntry,
  LoopTraceJournal,
  RetryEntry,
  RunningEntry,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  type LoopTraceArtifactLocator,
  appendLoopTraceJournalEntry,
  buildLoopTraceJournalResponse,
  buildLoopTraceJournalResponseForPath,
  findLoopTraceJournalByIssueIdentifier,
  readLoopTraceJournal,
  writeLoopTraceJournal,
} from "../logging/loop-trace.js";
import {
  appendDispatcherRunJournalEntryToDisk,
  readDispatcherRunJournal,
} from "../logging/run-journal.js";
import {
  type RuntimeSnapshot,
  buildRuntimeSnapshot,
} from "../logging/runtime-snapshot.js";
import {
  buildActivityContext,
  extractToolInputFromRaw,
  extractToolNameFromRaw,
  summarizeCodexEvent,
} from "../logging/session-metrics.js";
import {
  StructuredLogger,
  createJsonLineSink,
} from "../logging/structured-logger.js";
import {
  type DashboardServerHost,
  type DashboardServerInstance,
  type IssueDetailResponse,
  type PipelineStatusResponse,
  type RefreshResponse,
  type StopIssueResponse,
  startDashboardServer,
} from "../observability/dashboard-server.js";
import { createRunnerFromConfig, isAiSdkRunner } from "../runners/factory.js";
import type { RunnerKind } from "../runners/types.js";
import { LinearTrackerClient } from "../tracker/linear-client.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { getDisplayVersion } from "../version.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type {
  OrchestratorCoreOptions,
  StopRequest,
  SupervisionResteerRequest,
  TimerScheduler,
} from "./core.js";
import { OrchestratorCore } from "./core.js";
import { runEnsembleGate } from "./gate-handler.js";
import type { PipelineNotificationSink } from "./pipeline-notifier.js";
import { createIssueSupervisionSnapshot } from "./supervision.js";

export interface AgentRunnerLike {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type ReadWorkspaceChangedFiles = (
  workspacePath: string,
) => Promise<string[]>;

export type ReadWorkspaceBaseRevision = (
  workspacePath: string,
) => Promise<string | null>;

interface StoredLoopTrace {
  artifactPath: string;
  journal: LoopTraceEntry[];
}

export interface RuntimeHostOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  agentRunner?: AgentRunnerLike;
  createAgentRunner?: (input: {
    onEvent: (event: AgentRunnerEvent) => void;
  }) => AgentRunnerLike;
  logger?: StructuredLogger;
  workspaceManager?: WorkspaceManager;
  notifier?: PipelineNotificationSink | null;
  readWorkspaceChangedFiles?: ReadWorkspaceChangedFiles;
  readWorkspaceBaseRevision?: ReadWorkspaceBaseRevision;
  readLoopTraceJournal?: (
    locator: LoopTraceArtifactLocator,
  ) => Promise<LoopTraceJournal>;
  writeLoopTraceJournal?: (
    locator: LoopTraceArtifactLocator,
    journal: LoopTraceJournal,
  ) => Promise<void>;
  readDispatcherRunJournal?: (
    workspaceRoot: string,
  ) => Promise<DispatcherRunJournal>;
  writeDispatcherRunJournalEntry?: (
    workspaceRoot: string,
    entry: DispatcherRunJournalEntry,
  ) => Promise<void>;
  now?: () => Date;
}

export interface RuntimeServiceOptions {
  config: ResolvedWorkflowConfig;
  logsRoot?: string | null;
  tracker?: IssueTracker;
  runtimeHost?: OrchestratorRuntimeHost;
  workspaceManager?: WorkspaceManager;
  workflowWatcher?: WorkflowWatcher | null;
  notifier?: PipelineNotificationSink | null;
  now?: () => Date;
  logger?: StructuredLogger;
  stdout?: Writable;
  shutdownTimeoutMs?: number;
}

export interface RuntimeServiceHandle {
  readonly runtimeHost: OrchestratorRuntimeHost;
  readonly logger: StructuredLogger;
  readonly dashboard: DashboardServerInstance | null;
  waitForExit(): Promise<number>;
  shutdown(): Promise<void>;
}

interface WorkerExecution {
  issueId: string;
  issueIdentifier: string;
  stageName: string | null;
  controller: AbortController;
  completion: Promise<void>;
  stopRequest: StopRequest | null;
  lastResult: AgentRunResult | null;
}

/** Maximum ms to wait for idle workers during shutdown before forcing exit. */
const SHUTDOWN_IDLE_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

export class RuntimeHostStartupError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeHostStartupError";
    this.code = code;
  }
}

export class OrchestratorRuntimeHost implements DashboardServerHost {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private workspaceManager: WorkspaceManager;

  private agentRunner: AgentRunnerLike;

  private readonly now: () => Date;

  private readonly logger: StructuredLogger | null;

  private readonly readWorkspaceChangedFiles: ReadWorkspaceChangedFiles;

  private readonly readWorkspaceBaseRevision: ReadWorkspaceBaseRevision;

  private readonly readLoopTraceJournal: (
    locator: LoopTraceArtifactLocator,
  ) => Promise<LoopTraceJournal>;

  private readonly writeLoopTraceJournal: (
    locator: LoopTraceArtifactLocator,
    journal: LoopTraceJournal,
  ) => Promise<void>;

  private readonly readDispatcherRunJournal: (
    workspaceRoot: string,
  ) => Promise<DispatcherRunJournal>;

  private readonly writeDispatcherRunJournalEntry: (
    workspaceRoot: string,
    entry: DispatcherRunJournalEntry,
  ) => Promise<void>;

  static readonly PRUNE_DEBOUNCE_MS = 300_000;

  #lastPruneAt = 0;
  private readonly workers = new Map<string, WorkerExecution>();
  private readonly expectedBaseRevisions = new Map<string, string | null>();

  private readonly orchestrator: OrchestratorCore;

  private readonly managesAgentRunner: boolean;

  private readonly agentEventSink: (event: AgentRunnerEvent) => void;

  private eventQueue: Promise<unknown> = Promise.resolve();

  private refreshQueued = false;

  private readonly snapshotListeners = new Set<() => void>();

  readonly notifier: PipelineNotificationSink | null;

  private readonly lastNotifiedReworkCount = new Map<string, number>();

  private readonly loopTraceHydrationTasks = new Map<string, Promise<void>>();
  private readonly loopTracePersistenceTasks = new Map<
    string,
    Promise<boolean>
  >();
  private readonly loopTracePendingJournals = new Map<
    string,
    { locator: LoopTraceArtifactLocator; journal: LoopTraceJournal }
  >();
  private dispatcherRunJournalHydrationTask: Promise<void> | null = null;
  private dispatcherRunJournalLoaded = false;

  constructor(options: RuntimeHostOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.notifier = options.notifier ?? null;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
    this.readWorkspaceChangedFiles =
      options.readWorkspaceChangedFiles ?? readGitChangedFiles;
    this.readWorkspaceBaseRevision =
      options.readWorkspaceBaseRevision ?? readGitBaseRevision;
    this.readLoopTraceJournal =
      options.readLoopTraceJournal ?? readLoopTraceJournal;
    this.writeLoopTraceJournal =
      options.writeLoopTraceJournal ?? writeLoopTraceJournal;
    this.readDispatcherRunJournal =
      options.readDispatcherRunJournal ?? readDispatcherRunJournal;
    this.writeDispatcherRunJournalEntry =
      options.writeDispatcherRunJournalEntry ??
      appendDispatcherRunJournalEntryToDisk;
    this.workspaceManager =
      options.workspaceManager ??
      createWorkspaceManagerFromConfig(options.config, this.logger);
    this.agentEventSink = (event) => {
      void this.enqueue(async () => {
        this.orchestrator.onCodexEvent({
          issueId: event.issueId,
          event,
        });
        await logAgentEvent(this.logger, event);
        await this.recordLoopTraceForAgentEvent(event);
      });
    };
    this.managesAgentRunner =
      options.agentRunner === undefined &&
      options.createAgentRunner === undefined;
    this.agentRunner =
      options.agentRunner ??
      options.createAgentRunner?.({
        onEvent: this.agentEventSink,
      }) ??
      this.createManagedAgentRunner({
        config: options.config,
        tracker: options.tracker,
        workspaceManager: this.workspaceManager,
      });

    const timerScheduler = createQueuedTimerScheduler({
      run: (callback) => {
        void this.enqueue(async () => {
          callback();
        });
      },
    });

    const orchestratorOptions: OrchestratorCoreOptions = {
      config: options.config,
      tracker: options.tracker,
      now: this.now,
      timerScheduler,
      writeRunJournalEntry: async (entry) => {
        try {
          await this.writeDispatcherRunJournalEntry(
            this.workspaceManager.root,
            entry,
          );
        } catch (error) {
          await this.logger?.warn(
            "dispatcher_run_journal_persist_failed",
            "Failed to persist dispatcher run journal entry.",
            {
              outcome: "degraded",
              reason: toErrorMessage(error),
              issue_id: entry.issueId,
              issue_identifier: entry.issueIdentifier,
              journal_kind: entry.kind,
            },
          );
          throw error;
        }
      },
      ...(this.tracker instanceof LinearTrackerClient
        ? {
            postComment: async (issueId: string, body: string) => {
              await (this.tracker as LinearTrackerClient).postComment(
                issueId,
                body,
              );
            },
            updateIssueState: async (
              issueId: string,
              issueIdentifier: string,
              stateName: string,
            ) => {
              const teamKey = issueIdentifier.split("-")[0] ?? issueIdentifier;
              await (this.tracker as LinearTrackerClient).updateIssueState(
                issueId,
                stateName,
                teamKey,
              );
            },
            autoCloseParentIssue: async (
              issueId: string,
              issueIdentifier: string,
            ) => {
              const teamKey = issueIdentifier.split("-")[0] ?? issueIdentifier;
              const terminalStates = options.config.tracker.terminalStates;
              await (this.tracker as LinearTrackerClient).checkAndCloseParent(
                issueId,
                terminalStates,
                teamKey,
              );
            },
          }
        : {}),
      spawnWorker: async ({
        issue,
        attempt,
        stage,
        stageName,
        reworkCount,
        isFirstDispatch,
        rightSizingDecision,
      }) => {
        const lastRework = this.lastNotifiedReworkCount.get(issue.id) ?? 0;
        const isNewRework = !isFirstDispatch && reworkCount > lastRework;

        if ((isFirstDispatch || isNewRework) && this.notifier !== null) {
          this.lastNotifiedReworkCount.set(issue.id, reworkCount);
          this.notifier.notify({
            type: "issue_dispatched",
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            issueUrl: issue.url ?? null,
            stageName,
            reworkCount,
            rightSizingDecision,
          });
        }
        return this.spawnWorkerExecution(
          issue,
          attempt,
          stage,
          stageName,
          reworkCount,
        );
      },
      onIssueDropped: ({ identifier, title, url, reason }) => {
        this.notifier?.notify({
          type: "issue_dropped",
          issueIdentifier: identifier,
          issueTitle: title ?? identifier,
          issueUrl: url,
          reason,
        });
      },
      stopRunningIssue: async (input) => {
        await this.stopWorkerExecution(input.issueId, {
          issueId: input.issueId,
          issueIdentifier: input.runningEntry.identifier,
          cleanupWorkspace: input.cleanupWorkspace,
          reason: input.reason,
        });
      },
      getRunningSupervisionSnapshots: async (runningEntries) =>
        await Promise.all(
          runningEntries.map(async (entry) =>
            this.createRunningSupervisionSnapshot(entry),
          ),
        ),
      requestSupervisionResteer: async (input) => {
        await this.handleSupervisionResteer(input);
      },
      runEnsembleGate: async ({ issue, stage }) => {
        const workspaceInfo = this.workspaceManager.resolveForIssue(issue.id);
        const gateOptions = {
          issue,
          stage,
          workspacePath: workspaceInfo.workspacePath,
          createReviewerClient: (
            reviewer: import("../config/types.js").ReviewerDefinition,
          ) => {
            const kind = (reviewer.runner ??
              options.config.runner.kind) as RunnerKind;
            if (!isAiSdkRunner(kind)) {
              throw new Error(
                `Reviewer runner kind "${kind}" is not an AI SDK runner — only claude-code and gemini are supported for ensemble review.`,
              );
            }
            return createRunnerFromConfig({
              config: { kind, model: reviewer.model },
              cwd: workspaceInfo.workspacePath,
              onEvent: () => {},
            });
          },
        };
        if (this.tracker instanceof LinearTrackerClient) {
          const tracker = this.tracker;
          return runEnsembleGate({
            ...gateOptions,
            postComment: async (issueId: string, body: string) => {
              await tracker.postComment(issueId, body);
            },
          });
        }
        return runEnsembleGate(gateOptions);
      },
    };

    this.orchestrator = new OrchestratorCore(orchestratorOptions);
  }

  getState() {
    return this.orchestrator.getState();
  }

  updateConfig(input: {
    config: ResolvedWorkflowConfig;
    tracker?: IssueTracker;
    workspaceManager?: WorkspaceManager;
  }): void {
    this.config = input.config;

    if (input.tracker !== undefined) {
      this.tracker = input.tracker;
      this.orchestrator.updateTracker(input.tracker);
    }

    if (input.workspaceManager !== undefined) {
      this.workspaceManager = input.workspaceManager;
      this.dispatcherRunJournalLoaded = false;
      this.dispatcherRunJournalHydrationTask = null;
    }

    this.orchestrator.updateConfig(input.config);

    if (this.managesAgentRunner) {
      this.agentRunner = this.createManagedAgentRunner({
        config: this.config,
        tracker: this.tracker,
        workspaceManager: this.workspaceManager,
      });
      return;
    }

    if (supportsConfigUpdate(this.agentRunner)) {
      this.agentRunner.updateConfig({
        config: this.config,
        ...(input.tracker === undefined ? {} : { tracker: this.tracker }),
        ...(input.workspaceManager === undefined
          ? {}
          : { workspaceManager: this.workspaceManager }),
      });
    }

    this.notifySnapshotListeners();
  }

  async pollOnce() {
    return this.enqueue(async () => {
      await this.ensureDispatcherRunJournalLoaded();
      return await this.orchestrator.pollTick();
    });
  }

  async runRetryTimer(issueId: string) {
    return this.enqueue(async () => {
      await this.ensureDispatcherRunJournalLoaded();
      const state = this.orchestrator.getState();
      const retryEntry = state.retryAttempts[issueId];
      const preStage = state.issueStages[issueId] ?? null;
      const preLoopTraceJournal = state.loopTraceJournal[issueId];
      const result = await this.orchestrator.onRetryTimer(issueId);

      if (retryEntry !== undefined && result.released) {
        if (
          preLoopTraceJournal !== undefined &&
          state.loopTraceJournal[issueId] === undefined
        ) {
          state.loopTraceJournal[issueId] = preLoopTraceJournal;
        }
        const postStatus = getIssueTraceStatus(state, issueId);
        await this.appendLoopTraceEntries(issueId, [
          {
            timestamp: this.now().toISOString(),
            kind: "stage_transition",
            issueId,
            issueIdentifier: retryEntry.identifier ?? issueId,
            stage: preStage,
            attempt: retryEntry.attempt,
            sessionId: null,
            summary:
              "Retry queue released the issue from active runtime state.",
            stageTransition: {
              from: preStage,
              to: null,
              status: postStatus,
            },
          },
        ]);
        this.forgetLoopTraceJournalAfterPersistence(issueId);
      }

      return result;
    });
  }

  async flushEvents(): Promise<void> {
    await this.eventQueue;
    await this.flushLoopTracePersistence();
  }

  async waitForIdle(): Promise<void> {
    await this.eventQueue;
    await this.flushLoopTracePersistence();
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.completion),
    );
    await this.eventQueue;
    await this.flushLoopTracePersistence();
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    return buildRuntimeSnapshot(this.orchestrator.getState(), {
      now: this.now(),
    });
  }

  async getIssueDetails(
    issueIdentifier: string,
  ): Promise<IssueDetailResponse | null> {
    const running = Object.values(this.orchestrator.getState().running).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (running !== undefined) {
      await this.ensureLoopTraceJournalLoadedBestEffort(running.issue.id);
      const parent = await this.fetchParentSafe(running.issue.id);
      return toRunningIssueDetail(
        running,
        this.workspaceManager,
        parent,
        buildLoopTraceJournalResponse(
          this.orchestrator.getState().loopTraceJournal[running.issue.id] ?? [],
          this.getLoopTraceLocator(running.issue.id),
        ),
      );
    }

    const retry = Object.values(
      this.orchestrator.getState().retryAttempts,
    ).find((entry) => entry.identifier === issueIdentifier);
    if (retry !== undefined) {
      await this.ensureLoopTraceJournalLoadedBestEffort(retry.issueId);
      const parent = await this.fetchParentSafe(retry.issueId);
      return toRetryIssueDetail(
        issueIdentifier,
        retry,
        parent,
        buildLoopTraceJournalResponse(
          this.orchestrator.getState().loopTraceJournal[retry.issueId] ?? [],
          this.getLoopTraceLocator(retry.issueId),
        ),
      );
    }

    const inMemoryTrace =
      this.findInMemoryLoopTraceByIssueIdentifier(issueIdentifier);
    if (inMemoryTrace !== null) {
      return toStoredIssueDetail(issueIdentifier, inMemoryTrace);
    }

    const storedTrace =
      await this.findStoredLoopTraceByIssueIdentifierBestEffort(
        issueIdentifier,
      );
    if (storedTrace !== null) {
      return toStoredIssueDetail(issueIdentifier, storedTrace);
    }

    return null;
  }

  private findInMemoryLoopTraceByIssueIdentifier(
    issueIdentifier: string,
  ): StoredLoopTrace | null {
    for (const [issueId, journal] of Object.entries(
      this.orchestrator.getState().loopTraceJournal,
    )) {
      if (journal.some((entry) => entry.issueIdentifier === issueIdentifier)) {
        return {
          artifactPath: buildLoopTraceJournalResponse(
            journal,
            this.getLoopTraceLocator(issueId),
          ).path,
          journal,
        };
      }
    }
    return null;
  }

  private async fetchParentSafe(
    issueId: string,
  ): Promise<{ identifier: string; title: string; url: string } | null> {
    if (typeof this.tracker.fetchParent !== "function") {
      return null;
    }
    try {
      return await this.tracker.fetchParent(issueId);
    } catch {
      // Non-critical — return null rather than failing the entire detail request
      return null;
    }
  }

  async requestRefresh(): Promise<RefreshResponse> {
    const requestedAt = formatEasternTimestamp(this.now());
    const coalesced = this.refreshQueued;
    this.refreshQueued = true;

    if (!coalesced) {
      void this.enqueue(async () => {
        await this.ensureDispatcherRunJournalLoaded();
        this.refreshQueued = false;
        await this.orchestrator.pollTick();
      });
    }

    return {
      queued: true,
      coalesced,
      requested_at: requestedAt,
      operations: ["poll", "reconcile"],
    };
  }

  async requestIssueStop(issueIdentifier: string): Promise<StopIssueResponse> {
    await this.ensureDispatcherRunJournalLoaded();
    const stopRequest =
      await this.orchestrator.requestStopByIdentifier(issueIdentifier);
    if (stopRequest === null) {
      return {
        issue_identifier: issueIdentifier,
        stopped: false,
        reason: `Issue '${issueIdentifier}' is not currently running.`,
      };
    }

    return {
      issue_identifier: issueIdentifier,
      stopped: true,
      reason: "manual_stop",
    };
  }

  private async ensureDispatcherRunJournalLoaded(): Promise<void> {
    if (this.dispatcherRunJournalLoaded) {
      return;
    }
    if (this.dispatcherRunJournalHydrationTask !== null) {
      await this.dispatcherRunJournalHydrationTask;
      return;
    }

    const task = (async () => {
      try {
        const journal = await this.readDispatcherRunJournal(
          this.workspaceManager.root,
        );
        this.orchestrator.recoverFromRunJournal(journal);
      } catch (error) {
        await this.logger?.warn(
          "dispatcher_run_journal_hydration_failed",
          "Failed to hydrate dispatcher run journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            workspace_root: this.workspaceManager.root,
          },
        );
        throw error;
      }
      this.dispatcherRunJournalLoaded = true;
    })();
    this.dispatcherRunJournalHydrationTask = task;
    try {
      await task;
    } finally {
      if (this.dispatcherRunJournalHydrationTask === task) {
        this.dispatcherRunJournalHydrationTask = null;
      }
    }
  }

  private getLoopTraceLocator(issueId: string): LoopTraceArtifactLocator {
    const { workspaceKey, workspaceRoot } =
      this.workspaceManager.resolveForIssue(issueId);
    return {
      workspaceKey,
      workspaceRoot,
    };
  }

  private async findStoredLoopTraceByIssueIdentifierBestEffort(
    issueIdentifier: string,
  ): Promise<StoredLoopTrace | null> {
    try {
      return await findLoopTraceJournalByIssueIdentifier(
        this.workspaceManager.root,
        issueIdentifier,
      );
    } catch (error) {
      try {
        await this.logger?.warn(
          "loop_trace_hydration_failed",
          "Failed to hydrate stored loop trace journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            issue_identifier: issueIdentifier,
            workspace_root: this.workspaceManager.root,
          },
        );
      } catch {
        // Trace hydration is best-effort; logging failure should not reject callers.
      }
      return null;
    }
  }

  private async ensureLoopTraceJournalLoadedBestEffort(
    issueId: string,
  ): Promise<void> {
    try {
      await this.ensureLoopTraceJournalLoaded(issueId);
    } catch (error) {
      const locator = this.getLoopTraceLocator(issueId);
      try {
        await this.logger?.warn(
          "loop_trace_hydration_failed",
          "Failed to hydrate loop trace journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            issue_id: issueId,
            workspace_key: locator.workspaceKey,
            workspace_root: locator.workspaceRoot,
          },
        );
      } catch {
        // Trace hydration is best-effort; logging failure should not reject callers.
      }
    }
  }

  private async ensureLoopTraceJournalLoaded(issueId: string): Promise<void> {
    if (this.orchestrator.getState().loopTraceJournal[issueId] !== undefined) {
      return;
    }

    const existingTask = this.loopTraceHydrationTasks.get(issueId);
    if (existingTask !== undefined) {
      await existingTask;
      return;
    }

    const task = (async () => {
      const journal = await this.readLoopTraceJournal(
        this.getLoopTraceLocator(issueId),
      );
      if (
        this.orchestrator.getState().loopTraceJournal[issueId] === undefined
      ) {
        this.orchestrator.getState().loopTraceJournal[issueId] = journal;
      }
    })();
    this.loopTraceHydrationTasks.set(issueId, task);

    try {
      await task;
    } finally {
      if (this.loopTraceHydrationTasks.get(issueId) === task) {
        this.loopTraceHydrationTasks.delete(issueId);
      }
    }
  }

  private scheduleLoopTraceJournalPersist(issueId: string): void {
    const locator = this.getLoopTraceLocator(issueId);
    const journal = [
      ...(this.orchestrator.getState().loopTraceJournal[issueId] ?? []),
    ];
    this.loopTracePendingJournals.set(issueId, { locator, journal });
    if (this.loopTracePersistenceTasks.has(issueId)) {
      return;
    }

    const task = this.persistLatestLoopTraceJournal(issueId).finally(() => {
      if (this.loopTracePersistenceTasks.get(issueId) === task) {
        this.loopTracePersistenceTasks.delete(issueId);
      }
    });
    this.loopTracePersistenceTasks.set(issueId, task);
  }

  private async persistLatestLoopTraceJournal(
    issueId: string,
  ): Promise<boolean> {
    let lastPersistSucceeded = true;
    await new Promise((resolve) => setTimeout(resolve, 0));

    while (true) {
      const pending = this.loopTracePendingJournals.get(issueId);
      if (pending === undefined) {
        return lastPersistSucceeded;
      }
      this.loopTracePendingJournals.delete(issueId);

      try {
        await this.writeLoopTraceJournal(pending.locator, pending.journal);
        lastPersistSucceeded = true;
      } catch (error) {
        lastPersistSucceeded = false;
        try {
          await this.logger?.warn(
            "loop_trace_persist_failed",
            "Failed to persist loop trace journal.",
            {
              outcome: "degraded",
              reason: toErrorMessage(error),
              issue_id: issueId,
              workspace_key: pending.locator.workspaceKey,
              workspace_root: pending.locator.workspaceRoot,
            },
          );
        } catch {
          // Persistence is best-effort; logging failure should not reject callers.
        }
      }
    }
  }

  private async flushLoopTracePersistence(): Promise<void> {
    while (this.loopTracePersistenceTasks.size > 0) {
      await Promise.allSettled([...this.loopTracePersistenceTasks.values()]);
    }
  }

  private forgetLoopTraceJournal(issueId: string): void {
    delete this.orchestrator.getState().loopTraceJournal[issueId];
    this.loopTraceHydrationTasks.delete(issueId);
    this.loopTracePendingJournals.delete(issueId);
  }

  private forgetLoopTraceJournalAfterPersistence(issueId: string): void {
    const task = this.loopTracePersistenceTasks.get(issueId);
    if (task === undefined) {
      this.forgetLoopTraceJournal(issueId);
      return;
    }

    void task.then((persisted) => {
      if (
        persisted &&
        this.loopTracePersistenceTasks.get(issueId) === undefined
      ) {
        this.forgetLoopTraceJournal(issueId);
      }
    });
  }

  private async appendLoopTraceEntries(
    issueId: string,
    entries: Array<Omit<LoopTraceEntry, "sequence">>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    try {
      await this.ensureLoopTraceJournalLoaded(issueId);
      let journal =
        this.orchestrator.getState().loopTraceJournal[issueId] ?? [];
      for (const entry of entries) {
        journal = appendLoopTraceJournalEntry(journal, entry);
      }
      this.orchestrator.getState().loopTraceJournal[issueId] = journal;
      this.scheduleLoopTraceJournalPersist(issueId);
    } catch (error) {
      try {
        await this.logger?.warn(
          "loop_trace_record_failed",
          "Failed to record loop trace entries.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            issue_id: issueId,
          },
        );
      } catch {
        // Trace recording is best-effort; sink failures should not reject callers.
      }
    }
  }

  private async recordLoopTraceForAgentEvent(
    event: AgentRunnerEvent,
  ): Promise<void> {
    const stage =
      this.orchestrator.getState().issueStages[event.issueId] ?? null;
    const base = {
      timestamp: event.timestamp,
      issueId: event.issueId,
      issueIdentifier: event.issueIdentifier,
      stage,
      attempt: event.attempt,
      sessionId: event.sessionId ?? null,
    } satisfies Omit<LoopTraceEntry, "sequence" | "kind" | "summary">;
    const entries: Array<Omit<LoopTraceEntry, "sequence">> = [];

    if (event.event === "session_started") {
      entries.push({
        ...base,
        kind: "session_start",
        summary: "Session started.",
      });

      if (
        (event.promptChars ?? 0) > 0 ||
        (event.estimatedPromptTokens ?? 0) > 0
      ) {
        entries.push({
          ...base,
          kind: "prompt_summary",
          summary: truncateTraceText(
            `Prompt prepared (${event.promptChars ?? 0} chars, ~${event.estimatedPromptTokens ?? 0} tokens).`,
          ),
          prompt: {
            chars: Math.max(0, event.promptChars ?? 0),
            estimatedTokens: event.estimatedPromptTokens ?? null,
          },
        });
      }
    }

    if (
      (event.event === "approval_auto_approved" ||
        event.event === "unsupported_tool_call") &&
      isRecord(event.raw)
    ) {
      const toolName =
        extractToolNameFromRaw(event.raw) ??
        (typeof event.toolName === "string" ? event.toolName : null);
      if (toolName !== null) {
        const toolInput = extractToolInputFromRaw(event.raw);
        const context = buildActivityContext(toolName, toolInput);
        entries.push({
          ...base,
          kind: "tool_action",
          summary: truncateTraceText(
            context === null
              ? `${toolName} invoked.`
              : `${toolName} invoked: ${context}`,
          ),
          toolAction: {
            toolName,
            context: context === null ? null : truncateTraceText(context, 160),
            totalTokens: event.usage?.totalTokens ?? null,
          },
        });

        if (
          toolName.toLowerCase() === "edit" ||
          toolName.toLowerCase() === "write"
        ) {
          const filePath = extractTraceFilePath(toolInput, event.workspacePath);
          if (filePath !== null) {
            entries.push({
              ...base,
              kind: "file_delta",
              summary: `Updated ${filePath}.`,
              fileDelta: {
                files: [filePath],
              },
            });
          }
        }
      }
    }

    if (
      event.event === "notification" ||
      event.event === "turn_completed" ||
      event.event === "turn_failed" ||
      event.event === "turn_cancelled" ||
      event.event === "turn_ended_with_error" ||
      event.event === "turn_input_required" ||
      event.event === "startup_failed" ||
      event.event === "other_message" ||
      event.event === "malformed"
    ) {
      const baseSummary = summarizeCodexEvent(event);
      const tokenSuffix =
        event.usage?.totalTokens !== undefined
          ? ` (${event.usage.totalTokens} tokens)`
          : "";
      entries.push({
        ...base,
        kind: "feedback_event",
        summary: truncateTraceText(`${baseSummary}${tokenSuffix}`),
      });
    }

    await this.appendLoopTraceEntries(event.issueId, entries);
  }

  private async createRunningSupervisionSnapshot(entry: RunningEntry) {
    const workspacePath = this.workspaceManager.resolveForIssue(
      entry.issue.id,
    ).workspacePath;
    let changedFiles: string[] = [];
    let currentBaseRevision: string | null = null;
    try {
      changedFiles = await this.readWorkspaceChangedFiles(workspacePath);
    } catch (error) {
      await this.logger?.warn(
        "supervision_snapshot_failed",
        "Failed to collect workspace supervision snapshot.",
        {
          outcome: "degraded",
          reason: toErrorMessage(error),
          issue_id: entry.issue.id,
          issue_identifier: entry.identifier,
          workspace_path: workspacePath,
        },
      );
    }
    try {
      currentBaseRevision = await this.readWorkspaceBaseRevision(workspacePath);
    } catch (error) {
      await this.logger?.warn(
        "supervision_snapshot_failed",
        "Failed to collect workspace supervision snapshot.",
        {
          outcome: "degraded",
          reason: toErrorMessage(error),
          issue_id: entry.issue.id,
          issue_identifier: entry.identifier,
          workspace_path: workspacePath,
          snapshot_component: "base_revision",
        },
      );
    }

    const previousExpectedBaseRevision =
      this.expectedBaseRevisions.get(entry.issue.id) ?? null;
    const expectedBaseRevision =
      previousExpectedBaseRevision ?? currentBaseRevision;
    this.expectedBaseRevisions.set(entry.issue.id, expectedBaseRevision);

    return createIssueSupervisionSnapshot(entry.issue, {
      workerId: entry.issue.id,
      changedFiles,
      expectedBaseRevision,
      currentBaseRevision,
    });
  }

  private async handleSupervisionResteer(
    input: SupervisionResteerRequest,
  ): Promise<void> {
    const issueIds = [
      ...new Set(input.findings.flatMap((finding) => finding.workerIds)),
    ];
    const issueIdentifiers = [
      ...new Set(input.findings.flatMap((finding) => finding.issueIdentifiers)),
    ];
    const files = [
      ...new Set(input.findings.flatMap((finding) => finding.files)),
    ];

    await this.logger?.warn(
      "supervision_resteer_requested",
      "Deterministic supervision requested a bounded re-steer.",
      {
        outcome: "blocked",
        phase: input.phase,
        finding_count: input.findings.length,
        finding_kinds: [
          ...new Set(input.findings.map((finding) => finding.kind)),
        ],
        issue_identifiers: issueIdentifiers,
        files,
      },
    );

    if (!(this.tracker instanceof LinearTrackerClient)) {
      return;
    }

    const tracker = this.tracker;
    await Promise.all(
      issueIds.map(async (issueId) => {
        try {
          await tracker.postComment(issueId, input.comment);
        } catch (error) {
          await this.logger?.warn(
            "supervision_resteer_comment_failed",
            "Failed to post deterministic supervision re-steer comment.",
            {
              outcome: "degraded",
              reason: toErrorMessage(error),
              issue_id: issueId,
            },
          );
        }
      }),
    );
  }

  subscribeToSnapshots(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  async getPipelineStatus(): Promise<PipelineStatusResponse> {
    if (!(this.tracker instanceof LinearTrackerClient)) {
      return { paused: false, issues: [] };
    }

    const tracker = this.tracker as LinearTrackerClient;
    if (tracker.fetchOpenIssuesByLabels === undefined) {
      return { paused: false, issues: [] };
    }

    const haltIssues = await tracker.fetchOpenIssuesByLabels(
      ["pipeline-halt"],
      ["Done", "Cancelled"],
    );

    return {
      paused: haltIssues.length > 0,
      issues: haltIssues.map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
      })),
    };
  }

  async requestPipelinePause(): Promise<PipelineStatusResponse> {
    // Check for existing halt issues first (idempotent pause)
    const status = await this.getPipelineStatus();
    if (status.paused) {
      return status;
    }

    if (!(this.tracker instanceof LinearTrackerClient)) {
      return { paused: false, issues: [] };
    }

    const tracker = this.tracker as LinearTrackerClient;
    if (tracker.createIssue === undefined) {
      return { paused: false, issues: [] };
    }

    // TODO(SYMPH-221): resolve teamId, projectId, and haltLabelId from the tracker's
    // configured project context once those fields are available on ResolvedWorkflowConfig.
    const trackerConfig = this.config.tracker;
    const teamId = trackerConfig.teamId ?? "";
    const projectId = trackerConfig.projectId ?? "";
    const haltLabelId = trackerConfig.haltLabelId ?? "";

    const created = await tracker.createIssue({
      teamId,
      title: "Pipeline Halt",
      projectId,
      labelIds: [haltLabelId],
    });

    return {
      paused: true,
      issues: [{ identifier: created.identifier, title: created.title }],
    };
  }

  async requestPipelineResume(): Promise<PipelineStatusResponse> {
    if (!(this.tracker instanceof LinearTrackerClient)) {
      return { paused: false, issues: [] };
    }

    const tracker = this.tracker as LinearTrackerClient;
    if (tracker.fetchOpenIssuesByLabels === undefined) {
      return { paused: false, issues: [] };
    }

    const haltIssues = await tracker.fetchOpenIssuesByLabels(
      ["pipeline-halt"],
      ["Done", "Cancelled"],
    );

    const teamKey = this.config.tracker.teamKey ?? "";
    for (const issue of haltIssues) {
      await tracker.updateIssueState(issue.id, "Cancelled", teamKey);
    }

    return { paused: false, issues: [] };
  }

  abortAllWorkers(): number {
    const count = this.workers.size;
    for (const worker of this.workers.values()) {
      worker.controller.abort("Shutdown: aborting running workers.");
    }
    return count;
  }

  private async spawnWorkerExecution(
    issue: Issue,
    attempt: number | null,
    stage: StageDefinition | null = null,
    stageName: string | null = null,
    reworkCount = 0,
  ): Promise<{
    workerHandle: WorkerExecution;
    monitorHandle: Promise<void>;
  }> {
    await this.logger?.info("worker_spawned", "Worker spawned for issue.", {
      outcome: "started",
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      state: issue.state,
      ...(stageName !== null ? { stage: stageName } : {}),
    });

    const controller = new AbortController();
    const execution: WorkerExecution = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      stageName,
      controller,
      stopRequest: null,
      lastResult: null,
      completion: Promise.resolve(),
    };

    await this.logger?.info(
      "agent_runner_starting",
      "Agent runner starting for issue.",
      {
        outcome: "started",
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        ...(stageName !== null ? { stage: stageName } : {}),
      },
    );

    const completion = this.agentRunner
      .run({
        issue,
        attempt,
        signal: controller.signal,
        stage,
        stageName,
        reworkCount,
      })
      .then(async (result) => {
        execution.lastResult = result;
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "normal",
            endedAt: this.now(),
          });
        });
      })
      .catch(async (error) => {
        await this.logger?.error("agent_runner_error", toErrorMessage(error), {
          outcome: "failed",
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          ...(stageName !== null ? { stage: stageName } : {}),
        });
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "abnormal",
            reason:
              execution.stopRequest === null
                ? toErrorMessage(error)
                : `stopped after ${execution.stopRequest.reason}`,
          });
        });
      });

    execution.completion = completion;
    this.workers.set(issue.id, execution);

    return {
      workerHandle: execution,
      monitorHandle: completion,
    };
  }

  private async stopWorkerExecution(
    issueId: string,
    input: StopRequest,
  ): Promise<void> {
    const execution = this.workers.get(issueId);
    if (execution === undefined) {
      return;
    }

    execution.stopRequest = input;
    execution.controller.abort(`Stopped due to ${input.reason}.`);
  }

  private async finalizeWorkerExecution(
    execution: WorkerExecution,
    input: {
      outcome: "normal" | "abnormal";
      reason?: string;
      endedAt?: Date;
    },
  ): Promise<void> {
    this.workers.delete(execution.issueId);
    this.expectedBaseRevisions.delete(execution.issueId);

    // Kill orphaned child processes (vitest, pnpm, bash) that survive the abort signal.
    // On stall_timeout, the CC subprocess is killed but its children are not — they
    // keep running in the workspace directory, accumulating across retry attempts.
    if (input.outcome === "abnormal") {
      try {
        const workspacePath = this.workspaceManager.resolveForIssue(
          execution.issueId,
        ).workspacePath;
        await this.killOrphanedProcesses(
          workspacePath,
          execution.issueIdentifier,
        );
      } catch {
        // Workspace may already be cleaned up — don't block finalization
      }
    }

    await this.logger?.log(
      input.outcome === "normal" ? "info" : "error",
      input.outcome === "normal"
        ? "worker_exit_normal"
        : "worker_exit_abnormal",
      input.outcome === "normal"
        ? "Worker completed normally."
        : "Worker completed abnormally.",
      {
        outcome: input.outcome === "normal" ? "completed" : "failed",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        issue_id: execution.issueId,
        issue_identifier: execution.issueIdentifier,
        session_id: execution.lastResult?.liveSession.sessionId ?? null,
      },
    );

    // Pre-capture data that advanceStage() deletes during onWorkerExit()
    const state = this.orchestrator.getState();
    const runningEntry = state.running[execution.issueId];
    const preStage = state.issueStages[execution.issueId] ?? null;
    const preLoopTraceJournal = state.loopTraceJournal[execution.issueId];

    // Compute durationMs using runAttempt.startedAt if available (normal completion case),
    // falling back to runningEntry.startedAt for abnormal cases (stall timeout where runAttempt is null).
    const durationMs = execution.lastResult?.runAttempt?.startedAt
      ? this.now().getTime() -
        new Date(execution.lastResult.runAttempt.startedAt).getTime()
      : runningEntry?.startedAt
        ? this.now().getTime() - new Date(runningEntry.startedAt).getTime()
        : 0;

    const liveSession = execution.lastResult?.liveSession;
    await this.logger?.log("info", "stage_completed", "Stage completed.", {
      issue_id: execution.issueId,
      issue_identifier: execution.issueIdentifier,
      session_id: liveSession?.sessionId ?? null,
      stage_name: execution.stageName,
      input_tokens: liveSession?.codexInputTokens ?? 0,
      output_tokens: liveSession?.codexOutputTokens ?? 0,
      total_tokens: liveSession?.codexTotalTokens ?? 0,
      ...(liveSession?.codexCacheReadTokens
        ? { cache_read_tokens: liveSession.codexCacheReadTokens }
        : {}),
      ...(liveSession?.codexCacheWriteTokens
        ? { cache_write_tokens: liveSession.codexCacheWriteTokens }
        : {}),
      ...(liveSession?.codexNoCacheTokens
        ? { no_cache_tokens: liveSession.codexNoCacheTokens }
        : {}),
      ...(liveSession?.codexReasoningTokens
        ? { reasoning_tokens: liveSession.codexReasoningTokens }
        : {}),
      turns_used: liveSession?.turnCount ?? 0,
      total_input_tokens: liveSession?.totalStageInputTokens ?? 0,
      total_output_tokens: liveSession?.totalStageOutputTokens ?? 0,
      total_total_tokens: liveSession?.totalStageTotalTokens ?? 0,
      ...(liveSession?.totalStageCacheReadTokens
        ? { total_cache_read_tokens: liveSession.totalStageCacheReadTokens }
        : {}),
      ...(liveSession?.totalStageCacheWriteTokens
        ? { total_cache_write_tokens: liveSession.totalStageCacheWriteTokens }
        : {}),
      turn_count: liveSession?.turnCount ?? 0,
      duration_ms: durationMs,
      outcome: input.outcome === "normal" ? "completed" : "failed",
    });

    if (execution.stopRequest?.cleanupWorkspace === true) {
      await this.workspaceManager.removeForIssue(execution.issueId);
      this.pruneLocalBranches();
    }

    const lastTurnMessage = execution.lastResult?.lastTurn?.message;
    const fallbackMessage = execution.lastResult?.liveSession?.lastCodexMessage;
    const agentMessage =
      (lastTurnMessage !== null &&
      lastTurnMessage !== undefined &&
      lastTurnMessage !== ""
        ? lastTurnMessage
        : fallbackMessage !== null &&
            fallbackMessage !== undefined &&
            fallbackMessage !== ""
          ? fallbackMessage
          : undefined) ?? undefined;

    // Capture remaining state data
    const preHistory: ExecutionHistory = [
      ...(state.issueExecutionHistory[execution.issueId] ?? []),
    ];
    const preReworkCount = state.issueReworkCounts[execution.issueId] ?? 0;
    const capturedTitle =
      runningEntry?.issue.title ?? execution.issueIdentifier;
    const capturedUrl = runningEntry?.issue.url ?? null;
    const capturedRetryAttempt = runningEntry?.retryAttempt ?? null;
    const preFailedHas = state.failed.has(execution.issueId);
    const capturedFirstDispatchedAt =
      state.issueFirstDispatchedAt[execution.issueId] ?? null;

    await this.orchestrator.onWorkerExit({
      issueId: execution.issueId,
      outcome: input.outcome,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      endedAt: input.endedAt ?? this.now(),
      ...(agentMessage === undefined || agentMessage === null
        ? {}
        : { agentMessage }),
    });
    if (
      preLoopTraceJournal !== undefined &&
      state.loopTraceJournal[execution.issueId] === undefined
    ) {
      state.loopTraceJournal[execution.issueId] = preLoopTraceJournal;
    }

    const postStatus = getIssueTraceStatus(
      this.orchestrator.getState(),
      execution.issueId,
    );
    const stageTransitionEntry = buildStageTransitionTraceEntry({
      endedAt: input.endedAt ?? this.now(),
      execution,
      preStage,
      postStage:
        this.orchestrator.getState().issueStages[execution.issueId] ?? null,
      postStatus,
    });
    await this.appendLoopTraceEntries(execution.issueId, [
      ...(stageTransitionEntry === null ? [] : [stageTransitionEntry]),
      {
        timestamp: (input.endedAt ?? this.now()).toISOString(),
        kind: "worker_exit",
        issueId: execution.issueId,
        issueIdentifier: execution.issueIdentifier,
        stage: preStage,
        attempt: runningEntry?.retryAttempt ?? null,
        sessionId: liveSession?.sessionId ?? null,
        summary: truncateTraceText(
          input.outcome === "normal"
            ? "Worker exited normally."
            : `Worker exited abnormally: ${input.reason ?? "worker failed"}.`,
        ),
        workerExit: {
          outcome: input.outcome,
          reason: input.reason ?? null,
          durationMs: Math.max(0, durationMs),
          turnCount: liveSession?.turnCount ?? 0,
          totalTokens: liveSession?.codexTotalTokens ?? 0,
        },
      },
    ]);
    if (shouldForgetLoopTraceJournal(postStatus)) {
      this.forgetLoopTraceJournalAfterPersistence(execution.issueId);
    }

    // Use the history snapshot captured inside onWorkerExit (after the stage
    // record push but before advanceStage deletes issueExecutionHistory for
    // terminal transitions). Fall back to the state map for non-terminal cases,
    // then to preHistory as a last resort.
    const postHistory: ExecutionHistory = [
      ...(this.orchestrator.consumeExitHistorySnapshot(execution.issueId) ??
        this.orchestrator.getState().issueExecutionHistory[execution.issueId] ??
        preHistory),
    ];

    // Fire notifications after state update
    if (this.notifier !== null) {
      this.fireWorkerNotification(execution, input, {
        preHistory: postHistory,
        preReworkCount,
        capturedTitle,
        capturedUrl,
        capturedRetryAttempt,
        capturedTurnCount: runningEntry?.turnCount ?? 0,
        preFailedHas,
        capturedFirstDispatchedAt,
        durationMs,
      });
    }
  }

  private async killOrphanedProcesses(
    workspacePath: string,
    issueIdentifier: string,
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync("lsof", ["-d", "cwd"], {
        timeout: 5000,
      });

      const pidsToKill = [
        ...new Set(
          stdout
            .split("\n")
            .filter((line) => line.includes(workspacePath))
            .map((line) => line.trim().split(/\s+/)[1])
            .filter(
              (pid): pid is string =>
                pid !== undefined &&
                /^\d+$/.test(pid) &&
                Number(pid) !== process.pid,
            ),
        ),
      ];

      if (pidsToKill.length > 0) {
        for (const pid of pidsToKill) {
          try {
            process.kill(Number(pid), "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
        await this.logger?.log(
          "info",
          "orphaned_processes_killed",
          `Killed ${pidsToKill.length} orphaned process(es) in ${workspacePath}`,
          { issue_identifier: issueIdentifier, pids: pidsToKill },
        );
      }
    } catch {
      // Best-effort — lsof unavailable or other failure should not block finalization
    }
  }

  private pruneLocalBranches(): void {
    if (process.env.SYMPHONY_SKIP_BRANCH_PRUNE === "1") {
      return;
    }

    const now = Date.now();
    if (now - this.#lastPruneAt < OrchestratorRuntimeHost.PRUNE_DEBOUNCE_MS) {
      void this.logger?.info(
        "branch_prune_debounced",
        "Branch prune skipped (debounce)",
      );
      return;
    }
    this.#lastPruneAt = now;

    const symphonyRoot = resolve(dirname(this.config.workflowPath), "../..");
    const ctlPath = join(symphonyRoot, "ops", "symphony-ctl");
    const logPath = join(symphonyRoot, "ops", "logs", "prune.log");

    void this.logger?.info("branch_prune_triggered", "Spawning branch prune");

    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const logFd = openSync(
        logPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
      );
      const child = spawn(ctlPath, ["prune-branches", "--execute"], {
        cwd: symphonyRoot,
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
      closeSync(logFd);
    } catch {
      // Best effort — if log file or spawn fails, skip silently
    }
  }

  private fireWorkerNotification(
    execution: WorkerExecution,
    input: {
      outcome: "normal" | "abnormal";
      reason?: string;
    },
    captured: {
      preHistory: ExecutionHistory;
      preReworkCount: number;
      capturedTitle: string;
      capturedUrl: string | null;
      capturedRetryAttempt: number | null;
      capturedTurnCount: number;
      preFailedHas: boolean;
      capturedFirstDispatchedAt: string | null;
      durationMs: number;
    },
  ): void {
    // biome-ignore lint/style/noNonNullAssertion: caller guards notifier !== null
    const notifier = this.notifier!;
    const state = this.orchestrator.getState();

    // Terminal failure — retries exhausted (check first; supersedes infra_error)
    const nowFailed =
      state.failed.has(execution.issueId) && !captured.preFailedHas;
    if (nowFailed) {
      const maxRetries = this.config.agent.maxRetryAttempts;
      const retriesExhausted =
        (captured.capturedRetryAttempt ?? 0) >= maxRetries;
      notifier.notify({
        type: "issue_failed",
        issueIdentifier: execution.issueIdentifier,
        issueTitle: captured.capturedTitle,
        issueUrl: captured.capturedUrl,
        failureReason: input.reason ?? null,
        retriesExhausted,
        retryAttempt: captured.capturedRetryAttempt,
      });
      return;
    }

    // Stall killed — immediate notification regardless of retry
    if (
      input.outcome === "abnormal" &&
      execution.stopRequest?.reason === "stall_timeout"
    ) {
      notifier.notify({
        type: "stall_killed",
        issueIdentifier: execution.issueIdentifier,
        issueTitle: captured.capturedTitle,
        stageName: execution.stageName,
        stallDurationMs: captured.durationMs,
      });
      return;
    }

    // Infra error — abnormal exit with 0 turns (agent never started)
    if (input.outcome === "abnormal" && captured.capturedTurnCount === 0) {
      notifier.notify({
        type: "infra_error",
        issueIdentifier: execution.issueIdentifier,
        issueTitle: captured.capturedTitle,
        errorReason: input.reason ?? "unknown error",
      });
      return;
    }

    // Terminal completion: issue is in completed set AND no continuation retry was scheduled
    // (completed is only added for terminal completions; hasContinuationRetry kept as defense-in-depth)
    const isInCompleted = state.completed.has(execution.issueId);
    const hasContinuationRetry =
      state.retryAttempts[execution.issueId] !== undefined;
    const isNewlyFailed =
      state.failed.has(execution.issueId) && !captured.preFailedHas;

    if (isInCompleted && !hasContinuationRetry && !isNewlyFailed) {
      const totalTokens = captured.preHistory.reduce(
        (sum, r) => sum + r.totalTokens,
        0,
      );
      const totalDurationMs =
        captured.capturedFirstDispatchedAt !== null
          ? this.now().getTime() -
            Date.parse(captured.capturedFirstDispatchedAt)
          : captured.durationMs;
      notifier.notify({
        type: "issue_completed",
        issueIdentifier: execution.issueIdentifier,
        issueTitle: captured.capturedTitle,
        issueUrl: captured.capturedUrl,
        executionHistory: captured.preHistory,
        reworkCount: captured.preReworkCount,
        totalTokens,
        totalDurationMs,
      });
    }
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.eventQueue.then(task, task);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.notifySnapshotListeners();
    });
  }

  private notifySnapshotListeners(): void {
    for (const listener of this.snapshotListeners) {
      try {
        listener();
      } catch {
        // Observability listeners must not affect runtime correctness.
      }
    }
  }

  private createManagedAgentRunner(input: {
    config: ResolvedWorkflowConfig;
    tracker: IssueTracker;
    workspaceManager: WorkspaceManager;
  }): AgentRunnerLike {
    return new AgentRunner({
      config: input.config,
      tracker: input.tracker,
      workspaceManager: input.workspaceManager,
      onEvent: this.agentEventSink,
    });
  }
}

export async function startRuntimeService(
  options: RuntimeServiceOptions,
): Promise<RuntimeServiceHandle> {
  const validation = validateDispatchConfig(options.config);
  if (!validation.ok) {
    throw new RuntimeHostStartupError(
      validation.error.message,
      validation.error.code,
    );
  }

  const logger =
    options.logger ??
    (await createRuntimeLogger({
      logsRoot: options.logsRoot ?? null,
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    }));
  let currentConfig = options.config;
  let tracker = options.tracker ?? createLinearTrackerFromConfig(currentConfig);
  let workspaceManager =
    options.workspaceManager ??
    createWorkspaceManagerFromConfig(currentConfig, logger);
  const notifier = options.notifier ?? null;
  const runtimeHost =
    options.runtimeHost ??
    new OrchestratorRuntimeHost({
      config: currentConfig,
      tracker,
      logger,
      workspaceManager,
      notifier,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const usesManagedTracker = options.tracker === undefined;
  const usesManagedWorkspaceManager = options.workspaceManager === undefined;
  const startupTimestamp = Date.now();

  await cleanupTerminalIssueWorkspaces({
    tracker,
    terminalStates: currentConfig.tracker.terminalStates,
    workspaceManager,
    logger,
  });

  const dashboard =
    currentConfig.server.port === null
      ? null
      : await startDashboardServer({
          host: runtimeHost,
          port: currentConfig.server.port,
          refreshMs: currentConfig.observability.refreshMs,
          renderIntervalMs: currentConfig.observability.renderIntervalMs,
          liveUpdatesEnabled: currentConfig.observability.dashboardEnabled,
        });

  const stopController = new AbortController();
  const exitPromise = createExitPromise();
  let pollTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  let pendingExitCode = 0;

  const scheduleNextPoll = () => {
    if (stopController.signal.aborted) {
      return;
    }

    pollTimer = setTimeout(() => {
      void runPollCycle();
    }, currentConfig.polling.intervalMs);
  };

  const runPollCycle = async () => {
    try {
      const pollStart = Date.now();
      const result = await runtimeHost.pollOnce();
      const durationMs = Date.now() - pollStart;
      await logPollCycleResult(logger, result, durationMs);
      scheduleNextPoll();
    } catch (error) {
      await logger.error("runtime_poll_failed", toErrorMessage(error), {
        error_code: ERROR_CODES.cliStartupFailed,
      });
      pendingExitCode = 1;
      void shutdown();
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void logger.info("runtime_shutdown_signal", `received ${signal}`, {
      reason: signal,
    });
    void shutdown();
  };

  const removeSignalHandlers = installSignalHandlers(onSignal);
  const workflowWatcher =
    options.workflowWatcher === undefined
      ? await createRuntimeWorkflowWatcher({
          config: currentConfig,
          logger,
          onReload: async (nextConfig) => {
            const previousConfig = currentConfig;
            currentConfig = nextConfig;

            if (usesManagedTracker) {
              tracker = createLinearTrackerFromConfig(nextConfig);
            }

            if (usesManagedWorkspaceManager) {
              workspaceManager = createWorkspaceManagerFromConfig(
                nextConfig,
                logger,
              );
            }

            runtimeHost.updateConfig({
              config: nextConfig,
              ...(usesManagedTracker ? { tracker } : {}),
              ...(usesManagedWorkspaceManager ? { workspaceManager } : {}),
            });

            if (pollTimer !== null) {
              clearTimeout(pollTimer);
              pollTimer = null;
              scheduleNextPoll();
            }

            if (
              dashboard !== null &&
              previousConfig.server.port !== nextConfig.server.port
            ) {
              await logger.warn(
                "workflow_reload_port_ignored",
                "Ignoring server.port change until runtime restart.",
                {
                  outcome: "degraded",
                  reason: "server_port_reload_requires_restart",
                  port: dashboard.port,
                },
              );
            }

            if (
              dashboard !== null &&
              previousConfig.observability.dashboardEnabled !==
                nextConfig.observability.dashboardEnabled
            ) {
              await logger.warn(
                "workflow_reload_observability_ignored",
                "Ignoring observability.dashboard_enabled change until runtime restart.",
                {
                  outcome: "degraded",
                  reason: "observability_reload_requires_restart",
                  port: dashboard.port,
                },
              );
            }
          },
        })
      : options.workflowWatcher;
  workflowWatcher?.start();

  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? SHUTDOWN_IDLE_TIMEOUT_MS;

  const shutdown = async () => {
    if (shuttingDown) {
      await exitPromise.closed;
      return;
    }
    shuttingDown = true;
    stopController.abort();

    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    removeSignalHandlers();

    const shutdownStart = Date.now();
    const workersAborted = runtimeHost.abortAllWorkers();

    let timedOut = false;
    const idleOrTimeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        void logger.warn(
          "shutdown_idle_timeout",
          "Timed out waiting for workers to become idle; proceeding with exit.",
          { timeout_ms: shutdownTimeoutMs },
        );
        resolve();
      }, shutdownTimeoutMs);
      void runtimeHost.waitForIdle().then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    await Promise.allSettled([
      idleOrTimeout,
      dashboard?.close() ?? Promise.resolve(),
      workflowWatcher?.close() ?? Promise.resolve(),
    ]);

    await logger.info("shutdown_complete", "Shutdown complete.", {
      workers_aborted: workersAborted,
      timed_out: timedOut,
      duration_ms: Date.now() - shutdownStart,
    });

    const runtimeState = runtimeHost.getState();
    runtimeHost.notifier?.notify({
      type: "pipeline_stopped",
      productName,
      completedCount: runtimeState.completed.size,
      failedCount: runtimeState.failed.size,
      durationMs: Date.now() - startupTimestamp,
    });

    await runtimeHost.notifier?.flush?.();

    resolveExit(exitPromise, pendingExitCode);
    resolveClosed(exitPromise);
  };

  await logger.info("runtime_starting", "Symphony runtime started.", {
    symphony_version: getDisplayVersion(),
    poll_interval_ms: currentConfig.polling.intervalMs,
    max_concurrent_agents: currentConfig.agent.maxConcurrentAgents,
    ...(dashboard === null ? {} : { port: dashboard.port }),
  });

  const productName = extractProductName(currentConfig.workflowPath);
  runtimeHost.notifier?.notify({
    type: "pipeline_started",
    productName,
    dashboardUrl:
      dashboard !== null
        ? `http://${dashboard.hostname === "0.0.0.0" ? hostname() : dashboard.hostname}:${dashboard.port}`
        : null,
  });

  void runPollCycle();

  return {
    runtimeHost,
    logger,
    dashboard,
    async waitForExit() {
      return exitPromise.exitCode;
    },
    shutdown,
  };
}

async function logPollCycleResult(
  logger: StructuredLogger,
  result: Awaited<ReturnType<OrchestratorRuntimeHost["pollOnce"]>>,
  durationMs: number,
): Promise<void> {
  if (!result.validation.ok) {
    await logger.error(
      "dispatch_validation_failed",
      result.validation.error.message,
      {
        error_code: result.validation.error.code,
      },
    );
  }

  if (result.reconciliationFetchFailed) {
    await logger.warn(
      "reconciliation_state_refresh_failed",
      "Issue state reconciliation failed; keeping current workers running.",
      {
        outcome: "degraded",
        reason: "tracker_state_refresh_failed",
      },
    );
  }

  if (result.trackerFetchFailed) {
    await logger.warn(
      "candidate_issue_fetch_failed",
      "Tracker candidate fetch failed; dispatch skipped for this tick.",
      {
        outcome: "degraded",
        reason: "tracker_candidate_fetch_failed",
      },
    );
  }

  await logger.info("poll_tick_completed", "Poll tick completed.", {
    dispatched_count: result.dispatchedIssueIds.length,
    running_count: result.runningCount,
    reconciled_stop_requests: result.stopRequests.length,
    duration_ms: durationMs,
  });
}

async function createRuntimeWorkflowWatcher(input: {
  config: ResolvedWorkflowConfig;
  logger: StructuredLogger;
  onReload: (config: ResolvedWorkflowConfig) => Promise<void>;
}): Promise<WorkflowWatcher | null> {
  try {
    await access(input.config.workflowPath);
  } catch {
    return null;
  }

  return await WorkflowWatcher.create({
    workflowPath: input.config.workflowPath,
    onReload: async ({ snapshot }) => {
      if (!snapshot.dispatchValidation.ok) {
        await input.logger.error(
          "workflow_reload_rejected",
          snapshot.dispatchValidation.error.message,
          {
            error_code: ERROR_CODES.workflowReloadRejected,
            reason: snapshot.dispatchValidation.error.code,
          },
        );
        return;
      }

      await input.onReload(snapshot.config);
      await input.logger.info(
        "workflow_reloaded",
        "Applied updated workflow configuration.",
        {
          poll_interval_ms: snapshot.config.polling.intervalMs,
          max_concurrent_agents: snapshot.config.agent.maxConcurrentAgents,
        },
      );
    },
    onError: async ({ error }) => {
      await input.logger.error(
        "workflow_reload_failed",
        toErrorMessage(error),
        {
          error_code:
            extractErrorCode(error) ?? ERROR_CODES.workflowReloadRejected,
        },
      );
    },
  });
}

async function cleanupTerminalIssueWorkspaces(input: {
  tracker: IssueTracker;
  terminalStates: string[];
  workspaceManager: WorkspaceManager;
  logger: StructuredLogger;
}): Promise<void> {
  try {
    const issues = await input.tracker.fetchIssuesByStates(
      input.terminalStates,
    );
    await Promise.all(
      issues.map(async (issue) => {
        await input.workspaceManager.removeForIssue(issue.id);
      }),
    );
  } catch (error) {
    await input.logger.warn(
      "startup_terminal_cleanup_failed",
      toErrorMessage(error),
      {
        outcome: "degraded",
        reason: "startup_terminal_cleanup_failed",
      },
    );
  }
}

function createLinearTrackerFromConfig(
  config: ResolvedWorkflowConfig,
): LinearTrackerClient {
  return new LinearTrackerClient({
    endpoint: config.tracker.endpoint,
    apiKey: config.tracker.apiKey,
    projectSlug: config.tracker.projectSlug,
    activeStates: config.tracker.activeStates,
  });
}

function createWorkspaceManagerFromConfig(
  config: ResolvedWorkflowConfig,
  logger?: StructuredLogger | null,
): WorkspaceManager {
  return new WorkspaceManager({
    root: config.workspace.root,
    hooks: new WorkspaceHookRunner({
      config: config.hooks,
      ...(logger === undefined || logger === null
        ? {}
        : {
            log: createWorkspaceHookLogger(logger),
          }),
    }),
  });
}

async function createRuntimeLogger(input: {
  logsRoot: string | null;
  stdout?: Writable;
}): Promise<StructuredLogger> {
  const sinks = [createJsonLineSink(input.stdout ?? process.stdout)];

  if (input.logsRoot !== null) {
    await mkdir(input.logsRoot, { recursive: true });
    sinks.push(
      createJsonLineSink(
        createWriteStream(join(input.logsRoot, "symphony.jsonl"), {
          flags: "a",
        }),
      ),
    );
  }

  return new StructuredLogger(sinks);
}

function createQueuedTimerScheduler(input: {
  run: (callback: () => void) => void;
}): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(() => {
        input.run(callback);
      }, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}

export async function readGitChangedFiles(
  workspacePath: string,
): Promise<string[]> {
  const commands = [
    ["diff", "--name-only", "HEAD", "--"],
    ["diff", "--name-only", "--cached", "--"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const results = await Promise.allSettled(
    commands.map(async (args) => {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, ...args],
        {
          timeout: 5000,
        },
      );
      return String(stdout);
    }),
  );
  const outputs = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (outputs.length === 0) {
    const rejectedResult = results.find(
      (result) => result.status === "rejected",
    );
    throw rejectedResult?.status === "rejected"
      ? rejectedResult.reason
      : new Error("Failed to collect git changed files.");
  }

  return [
    ...new Set(
      outputs
        .flatMap((output) => output.split(/\r?\n/))
        .map((file) => file.trim())
        .filter((file) => file.length > 0),
    ),
  ];
}

async function readGitBaseRevision(
  workspacePath: string,
): Promise<string | null> {
  let baseRef = "origin/main";
  try {
    const { stdout: headRefStdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        timeout: 5000,
      },
    );
    const headRef = String(headRefStdout).trim();
    if (headRef.length > 0) {
      baseRef = headRef;
    }
  } catch {
    // Fall back to origin/main when origin/HEAD is unavailable.
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, "merge-base", "HEAD", baseRef],
    {
      timeout: 5000,
    },
  );
  const revision = String(stdout).trim();
  return revision.length > 0 ? revision : null;
}

export function createWorkspaceHookLogger(logger: StructuredLogger): (entry: {
  level: "info" | "warn" | "error";
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out";
  hook: string;
  workspacePath: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  stdout?: string;
  stderr?: string;
}) => void {
  return (entry) => {
    void logger.log(
      entry.level,
      entry.event,
      `Workspace hook ${entry.hook} ${toHookMessageSuffix(entry.event)}.`,
      {
        ...(entry.event === "workspace_hook_completed"
          ? { outcome: "completed" }
          : entry.event === "workspace_hook_started"
            ? { outcome: "started" }
            : { outcome: "failed" }),
        hook: entry.hook,
        workspace_path: entry.workspacePath,
        ...(entry.durationMs === undefined
          ? {}
          : { duration_ms: entry.durationMs }),
        ...(entry.exitCode === undefined ? {} : { exit_code: entry.exitCode }),
        ...(entry.errorCode === undefined
          ? {}
          : { error_code: entry.errorCode }),
        ...(entry.stdout ? { stdout: entry.stdout } : {}),
        ...(entry.stderr ? { stderr: entry.stderr } : {}),
      },
    );
  };
}

async function logAgentEvent(
  logger: StructuredLogger | null,
  event: AgentRunnerEvent,
): Promise<void> {
  if (logger === null) {
    return;
  }

  const level =
    event.event === "turn_failed" ||
    event.event === "turn_ended_with_error" ||
    event.event === "startup_failed" ||
    event.event === "turn_input_required" ||
    event.event === "malformed"
      ? "error"
      : event.event === "unsupported_tool_call"
        ? "warn"
        : "info";

  const outcome =
    event.event === "session_started"
      ? "started"
      : event.event === "turn_completed"
        ? "completed"
        : event.event === "approval_auto_approved"
          ? "approved"
          : event.event === "turn_failed" ||
              event.event === "turn_cancelled" ||
              event.event === "turn_ended_with_error" ||
              event.event === "startup_failed" ||
              event.event === "turn_input_required" ||
              event.event === "malformed"
            ? "failed"
            : undefined;

  await logger.log(level, event.event, event.message ?? event.event, {
    ...(outcome === undefined ? {} : { outcome }),
    ...(event.errorCode === undefined ? {} : { error_code: event.errorCode }),
    issue_id: event.issueId,
    issue_identifier: event.issueIdentifier,
    session_id: event.sessionId ?? null,
    thread_id: event.threadId ?? null,
    turn_id: event.turnId ?? null,
    turn_number: event.turnCount,
    attempt: event.attempt,
    workspace_path: event.workspacePath,
    ...(event.promptChars !== undefined
      ? { prompt_chars: event.promptChars }
      : {}),
    ...(event.estimatedPromptTokens !== undefined
      ? { estimated_prompt_tokens: event.estimatedPromptTokens }
      : {}),
    ...(event.usage === undefined
      ? {}
      : {
          input_tokens: event.usage.inputTokens,
          output_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
          ...(event.usage.cacheReadTokens !== undefined
            ? { cache_read_tokens: event.usage.cacheReadTokens }
            : {}),
          ...(event.usage.cacheWriteTokens !== undefined
            ? { cache_write_tokens: event.usage.cacheWriteTokens }
            : {}),
          ...(event.usage.noCacheTokens !== undefined
            ? { no_cache_tokens: event.usage.noCacheTokens }
            : {}),
          ...(event.usage.reasoningTokens !== undefined
            ? { reasoning_tokens: event.usage.reasoningTokens }
            : {}),
        }),
  });
}

function toHookMessageSuffix(
  event:
    | "workspace_hook_started"
    | "workspace_hook_completed"
    | "workspace_hook_failed"
    | "workspace_hook_timed_out",
): string {
  switch (event) {
    case "workspace_hook_started":
      return "started";
    case "workspace_hook_completed":
      return "completed";
    case "workspace_hook_failed":
      return "failed";
    case "workspace_hook_timed_out":
      return "timed out";
  }
}

function toRunningIssueDetail(
  running: RunningEntry,
  workspaceManager: WorkspaceManager,
  parent: { identifier: string; title: string; url: string } | null,
  loopTraceJournal: IssueDetailResponse["loop_trace_journal"],
): IssueDetailResponse {
  return {
    issue_identifier: running.identifier,
    issue_id: running.issue.id,
    status: "running",
    workspace: {
      path: workspaceManager.resolveForIssue(running.issue.id).workspacePath,
    },
    attempts: {
      restart_count: running.retryAttempt ?? 0,
      current_retry_attempt: running.retryAttempt,
    },
    running: {
      session_id: running.sessionId,
      turn_count: running.turnCount,
      state: running.issue.state,
      started_at: running.startedAt,
      last_event: running.lastCodexEvent,
      last_message: running.lastCodexMessage,
      last_event_at: running.lastCodexTimestamp,
      tokens: {
        input_tokens: running.codexInputTokens,
        output_tokens: running.codexOutputTokens,
        total_tokens: running.codexTotalTokens,
      },
    },
    retry: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: running.recentActivity.map((entry) => ({
      at: entry.timestamp,
      event: entry.toolName,
      message: entry.context,
    })),
    loop_trace_journal: loopTraceJournal,
    last_error: null,
    tracked: {},
    parent,
  };
}

function toRetryIssueDetail(
  issueIdentifier: string,
  retry: RetryEntry,
  parent: { identifier: string; title: string; url: string } | null,
  loopTraceJournal: IssueDetailResponse["loop_trace_journal"],
): IssueDetailResponse {
  return {
    issue_identifier: issueIdentifier,
    issue_id: retry.issueId,
    status: "retry_queued",
    workspace: null,
    attempts: {
      restart_count: retry.attempt,
      current_retry_attempt: retry.attempt,
    },
    running: null,
    retry: {
      attempt: retry.attempt,
      due_at: formatEasternTimestamp(new Date(retry.dueAtMs)),
      error: retry.error,
    },
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    loop_trace_journal: loopTraceJournal,
    last_error: retry.error,
    tracked: {},
    parent,
  };
}

function toStoredIssueDetail(
  issueIdentifier: string,
  storedTrace: StoredLoopTrace,
): IssueDetailResponse | null {
  const issueEntry = findLatestTraceEntryForIdentifier(
    storedTrace.journal,
    issueIdentifier,
  );
  if (issueEntry === null) {
    return null;
  }
  const latest = storedTrace.journal.at(-1) ?? null;
  const status = deriveStoredIssueStatus(storedTrace.journal);
  return {
    issue_identifier: issueIdentifier,
    issue_id: issueEntry.issueId,
    status,
    workspace: null,
    attempts: {
      restart_count: latest?.attempt ?? 0,
      current_retry_attempt: null,
    },
    running: null,
    retry: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: storedTrace.journal.slice(-10).map((entry) => ({
      at: entry.timestamp,
      event: entry.kind,
      message: truncateTraceText(entry.summary),
    })),
    loop_trace_journal: buildLoopTraceJournalResponseForPath(
      storedTrace.journal,
      storedTrace.artifactPath,
    ),
    last_error:
      latest?.workerExit?.outcome === "abnormal"
        ? latest.workerExit.reason
        : null,
    tracked: {},
    parent: null,
  };
}

function buildStageTransitionTraceEntry(input: {
  endedAt: Date;
  execution: WorkerExecution;
  preStage: string | null;
  postStage: string | null;
  postStatus: IssueDetailResponse["status"];
}): Omit<LoopTraceEntry, "sequence"> | null {
  const { preStage, postStage, postStatus } = input;
  if (preStage === postStage && postStatus === "running") {
    return null;
  }

  let summary: string;
  if (preStage !== postStage && postStage !== null) {
    summary = `Stage transitioned from ${preStage ?? "unassigned"} to ${postStage}.`;
  } else {
    summary = `Stage ${preStage ?? "unassigned"} moved to ${postStatus}.`;
  }

  return {
    timestamp: input.endedAt.toISOString(),
    kind: "stage_transition",
    issueId: input.execution.issueId,
    issueIdentifier: input.execution.issueIdentifier,
    stage: postStage ?? preStage,
    attempt: null,
    sessionId: input.execution.lastResult?.liveSession.sessionId ?? null,
    summary,
    stageTransition: {
      from: preStage,
      to: postStage,
      status: postStatus,
    },
  };
}

function getIssueTraceStatus(
  state: ReturnType<OrchestratorRuntimeHost["getState"]>,
  issueId: string,
): IssueDetailResponse["status"] {
  if (state.running[issueId] !== undefined) {
    return "running";
  }
  if (state.retryAttempts[issueId] !== undefined) {
    return "retry_queued";
  }
  if (state.failed.has(issueId)) {
    return "failed";
  }
  if (state.completed.has(issueId)) {
    return "completed";
  }
  if (state.claimed.has(issueId)) {
    return "claimed";
  }
  return "released";
}

function shouldForgetLoopTraceJournal(
  status: IssueDetailResponse["status"],
): boolean {
  return status === "completed" || status === "failed" || status === "released";
}

function deriveStoredIssueStatus(
  journal: LoopTraceEntry[],
): IssueDetailResponse["status"] {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (
      entry?.stageTransition !== undefined &&
      isStoredIssueTraceStatus(entry.stageTransition.status)
    ) {
      return entry.stageTransition.status;
    }
  }

  const latest = journal.at(-1);
  if (latest?.workerExit?.outcome === "abnormal") {
    return "failed";
  }
  return "released";
}

function findLatestTraceEntryForIdentifier(
  journal: LoopTraceEntry[],
  issueIdentifier: string,
): LoopTraceEntry | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry?.issueIdentifier === issueIdentifier) {
      return entry;
    }
  }
  return null;
}

function extractTraceFilePath(
  toolInput: unknown,
  workspacePath: string,
): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  const rawPath = toolInput.file_path;
  if (typeof rawPath !== "string") {
    return null;
  }

  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!isAbsolute(trimmed)) {
    return trimmed;
  }

  const relativePath = relative(workspacePath, trimmed);
  return relativePath.startsWith("..") || isAbsolute(relativePath)
    ? trimmed
    : relativePath;
}

function truncateTraceText(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoredIssueTraceStatus(
  value: string,
): value is "completed" | "failed" | "released" {
  return value === "completed" || value === "failed" || value === "released";
}

function installSignalHandlers(
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, onSignal);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }
  };
}

function createExitPromise(): {
  exitCode: Promise<number>;
  closed: Promise<void>;
  resolveExit: (code: number) => void;
  resolveClosed: () => void;
} {
  let resolveExitCode: ((code: number) => void) | null = null;
  let resolveClosedPromise: (() => void) | null = null;

  return {
    exitCode: new Promise<number>((resolve) => {
      resolveExitCode = resolve;
    }),
    closed: new Promise<void>((resolve) => {
      resolveClosedPromise = resolve;
    }),
    resolveExit(code) {
      resolveExitCode?.(code);
      resolveExitCode = null;
    },
    resolveClosed() {
      resolveClosedPromise?.();
      resolveClosedPromise = null;
    },
  };
}

function resolveExit(
  exitPromise: ReturnType<typeof createExitPromise>,
  code: number,
): void {
  exitPromise.resolveExit(code);
}

function resolveClosed(
  exitPromise: ReturnType<typeof createExitPromise>,
): void {
  exitPromise.resolveClosed();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "worker failed";
}

function extractErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return null;
}

function supportsConfigUpdate(
  value: AgentRunnerLike,
): value is AgentRunnerLike & {
  updateConfig(input: {
    config: ResolvedWorkflowConfig;
    tracker?: IssueTracker;
    workspaceManager?: WorkspaceManager;
  }): void;
} {
  return "updateConfig" in value && typeof value.updateConfig === "function";
}

/**
 * Extract a human-readable product name from a WORKFLOW file path.
 * E.g., "/path/to/WORKFLOW-symphony.md" → "symphony"
 *       "/path/to/WORKFLOW.md" → "WORKFLOW"
 */
export function extractProductName(workflowPath: string): string {
  const filename = workflowPath.split("/").pop() ?? workflowPath;
  const base = filename.replace(/\.md$/i, "");
  const match = /^WORKFLOW-(.+)$/i.exec(base);
  return match !== null ? (match[1] ?? base) : base;
}
