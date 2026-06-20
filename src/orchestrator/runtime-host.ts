import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  constants as fsConstants,
  mkdirSync,
  openSync,
} from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runAcGate } from "../agent/ac-gate.js";
import { runPauseTriage } from "../agent/pause-triage.js";
import type {
  ImplementationCommentDelta,
  ImplementationCommentDeltaContext,
  WorkpadRetryContext,
} from "../agent/prompt-builder.js";
import { fenceJudgeBoundaryTags } from "../agent/prompt-fence.js";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunnerEvent,
} from "../agent/runner.js";
import { AgentRunner } from "../agent/runner.js";
import { runSpecFidelityJudge } from "../agent/spec-fidelity.js";
import { runStuckTriage } from "../agent/stuck-triage.js";
import { createCmuxPlannerRunner } from "../agent/triage-planner.js";
import { publishVerdictStatus } from "../agent/verdict-status.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import {
  DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
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
  DispatchValidationResult,
  ResolvedWorkflowConfig,
  StageDefinition,
  StageExecutionBackend as StageExecutionBackendKind,
} from "../config/types.js";
import { WorkflowWatcher } from "../config/workflow-watch.js";
import type {
  CodexSessionLogEntry,
  ContinuousFeedbackEvent,
  DispatchGateInfo,
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  DispatcherRunJournalEventKind,
  ExecutionHistory,
  Issue,
  LoopTraceEntry,
  LoopTraceJournal,
  ManagerRunJournal,
  RetryEntry,
  RightSizingDecision,
  RunningEntry,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { ErrorSignatureClass } from "../errors/signature.js";
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
import { readManagerRunJournal } from "../logging/manager-run-journal.js";
import {
  type CompactDispatcherRunJournalOptions,
  type CompactDispatcherRunJournalResult,
  DISPATCHER_RUN_JOURNAL_DEFAULT_COMPACTION_TAIL_ENTRIES,
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntryToDisk,
  compactDispatcherRunJournalFileWithLock,
  readDispatcherRunJournal,
} from "../logging/run-journal.js";
import {
  type RuntimeSnapshot,
  type RuntimeSnapshotContinuousFeedbackPreflight,
  type StateDeltaResponse,
  buildRuntimeSnapshot,
  buildStateDelta,
} from "../logging/runtime-snapshot.js";
import {
  buildActivityContext,
  extractToolInputFromRaw,
  extractToolNameFromRaw,
  summarizeCodexEvent,
} from "../logging/session-metrics.js";
import { readStandingPlanJournal } from "../logging/standing-plan-journal.js";
import {
  StructuredLogger,
  createJsonLineSink,
} from "../logging/structured-logger.js";
import { buildComponentStatuses } from "../observability/component-status.js";
import {
  type AnchorFieldEditRequest,
  type AnchorFieldEditResult,
  type DashboardServerHost,
  type DashboardServerInstance,
  type DispatchFenceRequest,
  type DispatchFenceResponse,
  type EmergencyStopResponse,
  type EmergencyStopStateResponse,
  type IntentRequest,
  type IntentRequestResult,
  type IssueDetailResponse,
  type PipelineControlContext,
  type PipelineRestartSafetyResponse,
  type PipelineStatusResponse,
  type RefreshResponse,
  type StopIssueResponse,
  type StopSignalDeliveryResponse,
  startDashboardServer,
} from "../observability/dashboard-server.js";
import {
  type DeployDriftStatus,
  captureDeployDrift,
  qualifyDeployDriftFreshness,
} from "../observability/deploy-drift.js";
import {
  createModeScopedPermissionPolicy,
  resolveHardStopsConfig,
} from "../policy/hard-stops.js";
import { upsertPortfolioClassificationBlock } from "../portfolio/classifier.js";
import {
  type LinearWebhookAcceptedDelivery,
  runPortfolioWebhookRepair,
} from "../portfolio/linear-webhook-reconciler.js";
import { createRunnerFromConfig, isAiSdkRunner } from "../runners/factory.js";
import type { RunnerKind } from "../runners/types.js";
import { getDurableCodexSessionArtifactDirectory } from "../shared/codex-session-artifacts.js";
import {
  processTreeTerminationConfirmed,
  readProcessIdentity as readProcessIdentityDefault,
  readProcessIdentityMetadata,
  terminateDetachedPidTree as terminateDetachedPidTreeDefault,
  terminateDetachedProcessGroupTree as terminateDetachedProcessGroupTreeDefault,
} from "../shared/process-tree.js";
import type {
  ProcessIdentitySnapshot,
  ProcessTreeTerminationResult,
} from "../shared/process-tree.js";
import {
  DEFAULT_SPEC_REVIEW_COMMENT_CONFIG,
  type SpecReviewCommentDisposition,
} from "../spec-review/spec-review.js";
import {
  CurrentRunnerStageExecutionBackend,
  type StageExecutionBackendRunner,
  type StageExecutionJobSpec,
  UnsupportedStageExecutionBackendError,
} from "../stage-execution/backend.js";
import { createStageExecutionJobSpec } from "../stage-execution/job-spec.js";
import { serializeTrackerErrorDetails } from "../tracker/errors.js";
import {
  type LinearIssueComment,
  type LinearIssueReference,
  LinearTrackerClient,
} from "../tracker/linear-client.js";
import {
  type LinearDocumentRef,
  createLinearDocument,
  fetchLinearDocumentComments,
  updateLinearDocument,
} from "../tracker/linear-documents.js";
import {
  classifyActor,
  normalizeOperatorConfig,
} from "../tracker/ticket-feature.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { getDisplayVersion } from "../version.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import {
  type ContinuousFeedbackCommandExecutor,
  type ContinuousFeedbackProbeResult,
  createContinuousFeedbackProvider,
  probeContinuousFeedbackModel,
  runContinuousFeedbackCommand,
} from "./continuous-feedback-provider.js";
import type {
  ContinuousFeedbackCheckpointResult,
  OrchestratorCoreOptions,
  PlanDrivenDispatchDecision,
  PlanDrivenDispatchInput,
  StopReason,
  StopRequest,
  StopSignalDelivery,
  StopSignalDeliveryAttempt,
  StopSignalStatus,
  SupervisionResteerRequest,
  TimerScheduler,
} from "./core.js";
import {
  OrchestratorCore,
  SERVICE_SHUTDOWN_ABORT_REASON,
  deriveAttemptedStopSignalDeliveryStatus,
  getFailedStopSignalDeliveryAttempts,
  isStopSignalDelivery,
} from "./core.js";
import { projectEmergencyStopInterruptedIssue } from "./emergency-stop-projection.js";
import { getDiff, runEnsembleGate } from "./gate-handler.js";
import {
  type IntentActor,
  type IntentReason,
  type PlanControlVerb,
  isPipelineSentinelValue,
  isPlanControlVerb,
} from "./intent.js";
import { reduceManagerRunJournal } from "./manager-run.js";
import type {
  MergeActuatorLiveState,
  MergeCandidateRecord,
} from "./merge-candidate.js";
import type {
  DispatchPageAlertEvent,
  PipelineNotificationSink,
} from "./pipeline-notifier.js";
import {
  getRateLimitSnapshotPath,
  loadPersistedRateLimitSnapshot,
  persistRateLimitSnapshot,
} from "./rate-limit-persistence.js";
import {
  type ClusterMember,
  formatWatchdogTicketBody,
} from "./signature-cluster.js";
import { resolveAdmittedIdentifiersForTick } from "./standing-plan-admission.js";
import { decidePlanDrivenDispatch } from "./standing-plan-consumer.js";
import {
  ingestControlDocComments,
  publishControlDoc,
} from "./standing-plan-control-surface.js";
import { computeRecentlyShipped } from "./standing-plan-doc-render.js";
import {
  type TerminalOutcomeResult,
  resolveBatchOutcome,
} from "./standing-plan-outcome.js";
import { runStandingPlanShadowTick } from "./standing-plan-shadow.js";
import {
  listHonoredDecisions,
  loadStandingPlan,
  recordBatchOutcome,
  recordPlanControlDecision,
} from "./standing-plan-store.js";
import { createIssueSupervisionSnapshot } from "./supervision.js";
import {
  type TrackFindingFilingRef,
  type TrackFindingFilingRequest,
  type TrackFindingFilingResult,
  type TrackFindingIssueContext,
  buildTrackFindingIssueBody,
  buildTrackFindingIssueTitle,
} from "./track-finding-filing.js";
import { writeTrackerIssueFromBoundary } from "./tracker-write.js";

const DEFAULT_RUNTIME_HARD_STOPS_CONFIG = {
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

export interface AgentRunnerLike {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type ReadWorkspaceChangedFiles = (
  workspacePath: string,
) => Promise<string[]>;

export type ReadWorkspaceBaseRevision = (
  workspacePath: string,
) => Promise<string | null>;

export interface WorkerStopSignalDeliveryInput {
  issueId: string;
  issueIdentifier: string;
  reason: StopReason;
  workspacePath: string | null;
  trackedProcessPid: number | null;
  trackedProcessIdentity?: ProcessIdentitySnapshot | null;
  attemptedAt: Date;
}

export type DeliverWorkerStopSignal = (
  input: WorkerStopSignalDeliveryInput,
) => Promise<StopSignalDelivery>;
type WorkspaceCwdRecheckSkipReason =
  | "current_cwd_unavailable"
  | "current_cwd_timed_out"
  | "current_cwd_outside_workspace";
interface WorkspaceCwdRecheckSkip {
  pid: number;
  discoveredCwdPath: string;
  currentCwdPath: string | null;
  reason: WorkspaceCwdRecheckSkipReason;
}
interface WorkspaceCwdProcessListerOptions {
  onSkippedRecheck?: (skip: WorkspaceCwdRecheckSkip) => void | Promise<void>;
}
type WorkspaceCwdProcessLister = (
  workspacePath: string,
  options?: WorkspaceCwdProcessListerOptions,
) => Promise<number[]>;
type ProcessIdentityReader = (
  pid: number,
) => Promise<ProcessIdentitySnapshot | null>;

export interface ProcessSignalDeliveryResult {
  status: Exclude<StopSignalDeliveryAttempt["sigterm"], "not_attempted">;
  processGroupId: number | null;
}

type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;
type ProcessCwdReader = (pid: number) => Promise<string | null>;
type ProcessCommandReader = (pid: number) => Promise<string | null>;

interface TrackedWorkerStopSignalDeliveryOptions {
  readProcessCwd?: ProcessCwdReader;
  readProcessCommand?: ProcessCommandReader;
  readProcessIdentity?: ProcessIdentityReader;
  sendSignal?: ProcessSignalSender;
  emergencyStopGraceMs?: number;
}

const EMERGENCY_STOP_SIGNAL_GRACE_MS = 1_000;

export interface LsofCwdProcessEntry {
  pid: number;
  cwdPath: string;
}

export interface TrackedProcessSignalTargetVerification {
  verified: boolean;
  failureKind: "unavailable" | "mismatch" | null;
  warning: string | null;
}

interface StoredLoopTrace {
  issueId: string;
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
  readManagerRunJournal?: (workspaceRoot: string) => Promise<ManagerRunJournal>;
  writeDispatcherRunJournalEntry?: (
    workspaceRoot: string,
    entry: DispatcherRunJournalEntry,
  ) => Promise<void>;
  listWorkspaceCwdProcessIds?: WorkspaceCwdProcessLister;
  readProcessIdentity?: ProcessIdentityReader;
  compactDispatcherRunJournal?: (
    workspaceRoot: string,
    checkpointDraft: DispatcherRunJournalEntryDraft,
    options?: CompactDispatcherRunJournalOptions,
  ) => Promise<CompactDispatcherRunJournalResult>;
  dispatcherRunJournalCompactionTailEntries?: number;
  terminateDetachedPidTree?: typeof terminateDetachedPidTreeDefault;
  terminateDetachedProcessGroupTree?: typeof terminateDetachedProcessGroupTreeDefault;
  runContinuousFeedback?: OrchestratorCoreOptions["runContinuousFeedback"];
  runContinuousFeedbackCommand?: ContinuousFeedbackCommandExecutor;
  /**
   * Additional stage execution backends. The host always keeps a default
   * current-runner backend; pass a "current-runner" entry here only to replace
   * that default implementation.
   */
  stageExecutionBackends?: ReadonlyMap<
    StageExecutionBackendKind,
    StageExecutionBackendRunner
  >;
  deliverWorkerStopSignal?: DeliverWorkerStopSignal;
  /**
   * Injectable deploy-drift capture (SYMPH-407). Default runs git rev-parse
   * against the repo root once at the first snapshot; never refreshed (the
   * staleness contract lives in deploy-drift.ts).
   */
  captureDeployDrift?: () => Promise<DeployDriftStatus | null>;
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
  /**
   * Injectable continuous-feedback runner command (SYMPH-761), forwarded to the
   * default-constructed host so the startup model-availability preflight can be
   * stubbed in tests instead of spawning the real runner. Ignored when a
   * pre-built `runtimeHost` is supplied (that host owns its own command).
   */
  runContinuousFeedbackCommand?: ContinuousFeedbackCommandExecutor;
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
  codexAppServerPid: number | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
  controller: AbortController;
  completion: Promise<void>;
  stopRequest: StopRequest | null;
  lastResult: AgentRunResult | null;
}

/** Maximum ms to wait for idle workers during shutdown before forcing exit. */
const SHUTDOWN_IDLE_TIMEOUT_MS = 30_000;
const PIPELINE_HALT_LABEL = "pipeline-halt";
// Workspace-cwd orphan discovery rechecks at most 8 PIDs at a time, each with
// a 5s cap, so worst-case recheck latency is ceil(candidate_count / 8) * 5s.
const WORKSPACE_CWD_RECHECK_CONCURRENCY = 8;
const WORKSPACE_CWD_RECHECK_TIMEOUT_MS = 5_000;
const WORKSPACE_CWD_RECHECK_SKIP_LOG_LIMIT = 20;

const PIPELINE_RESTART_GUIDANCE = [
  "Stage candidate tickets outside Pipeline first.",
  "Add dependency relations and acceptance criteria before adding the Pipeline project.",
  "Once tickets enter Pipeline, wait for active Pipeline issues and runtime lanes to drain before restarting Symphony.",
];
const SNAPSHOT_REFRESH_EXTERNAL_JOURNAL_KINDS =
  new Set<DispatcherRunJournalEventKind>([
    "review_round",
    "fix_round",
    "review_rework",
    "review_lane",
    "review_finding",
    "review_synthesis",
    "review_escalation",
    "review_gate_result",
    "spec_review_result",
  ]);

const execFileAsync = promisify(execFile);

/**
 * Repo root of the running checkout for deploy-drift capture:
 * dist/src/orchestrator/runtime-host.js -> 3 levels up (same resolution
 * pattern as resolveDeployScriptPath in dashboard-server.ts).
 */
function resolveRuntimeRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), "..", "..", "..");
}

function issueFromLinearReference(reference: LinearIssueReference): Issue {
  return {
    id: reference.id,
    identifier: reference.identifier,
    title: reference.title,
    description: reference.description,
    teamKey: reference.teamKey,
    projectId: reference.projectId,
    projectSlug: reference.projectSlug,
    projectName: reference.projectName ?? null,
    priority: null,
    state: "unknown",
    branchName: null,
    url: reference.url,
    labels: reference.labels,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function mergeDispatcherRunJournals(
  currentJournal: DispatcherRunJournal,
  durableJournal: DispatcherRunJournal,
): DispatcherRunJournal {
  const seenIdempotencyKeys = new Set(
    currentJournal.map((entry) => entry.idempotencyKey),
  );
  const merged: DispatcherRunJournal = [...currentJournal];

  for (const entry of durableJournal) {
    if (seenIdempotencyKeys.has(entry.idempotencyKey)) {
      continue;
    }
    seenIdempotencyKeys.add(entry.idempotencyKey);
    merged.push(entry);
  }

  return merged.sort((left, right) => {
    const sequenceDelta = left.sequence - right.sequence;
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }
    return left.idempotencyKey.localeCompare(right.idempotencyKey, "en");
  });
}

function createMergedStageExecutionBackends(
  runner: AgentRunnerLike,
  customBackends: ReadonlyMap<
    StageExecutionBackendKind,
    StageExecutionBackendRunner
  > | null,
): ReadonlyMap<StageExecutionBackendKind, StageExecutionBackendRunner> {
  // Custom entries come last so callers can replace "current-runner" explicitly.
  return new Map<StageExecutionBackendKind, StageExecutionBackendRunner>([
    ["current-runner", new CurrentRunnerStageExecutionBackend(runner)],
    ...(customBackends?.entries() ?? []),
  ]);
}

function isSnapshotRefreshExternalJournalEntry(
  entry: DispatcherRunJournalEntry,
): boolean {
  return (
    entry.lease === null &&
    SNAPSHOT_REFRESH_EXTERNAL_JOURNAL_KINDS.has(entry.kind)
  );
}

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

  /** Queue Triage v2: a plan-control/predicate-driven re-plan request (SYMPH-787/789). */
  private standingPlanReplanRequested = false;

  /** Per-process de-dup for unresolved control-doc comments (SYMPH-791). */
  private readonly controlDocSeen = new Set<string>();

  /** Serializes control-surface ticks so overlapping first-publishes can't
   * create two docs (council R1, Codex P3). */
  private controlSurfaceInFlight = false;

  private tracker: IssueTracker;

  private workspaceManager: WorkspaceManager;

  private agentRunner: AgentRunnerLike;

  private stageExecutionBackends: ReadonlyMap<
    StageExecutionBackendKind,
    StageExecutionBackendRunner
  >;

  private readonly customStageExecutionBackends: ReadonlyMap<
    StageExecutionBackendKind,
    StageExecutionBackendRunner
  > | null;

  private readonly now: () => Date;

  private readonly logger: StructuredLogger | null;

  private readonly readWorkspaceChangedFiles: ReadWorkspaceChangedFiles;

  private readonly readWorkspaceBaseRevision: ReadWorkspaceBaseRevision;

  private readonly deliverWorkerStopSignal: DeliverWorkerStopSignal;

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

  private readonly readManagerRunJournal: (
    workspaceRoot: string,
  ) => Promise<ManagerRunJournal>;

  private readonly writeDispatcherRunJournalEntry: (
    workspaceRoot: string,
    entry: DispatcherRunJournalEntry,
  ) => Promise<void>;

  private readonly listWorkspaceCwdProcessIds: WorkspaceCwdProcessLister;

  private readonly readProcessIdentity: ProcessIdentityReader;

  private readonly compactDispatcherRunJournal: (
    workspaceRoot: string,
    checkpointDraft: DispatcherRunJournalEntryDraft,
    options?: CompactDispatcherRunJournalOptions,
  ) => Promise<CompactDispatcherRunJournalResult>;

  private readonly dispatcherRunJournalCompactionTailEntries: number;

  private readonly terminateDetachedPidTree: typeof terminateDetachedPidTreeDefault;

  private readonly terminateDetachedProcessGroupTree: typeof terminateDetachedProcessGroupTreeDefault;

  static readonly PRUNE_DEBOUNCE_MS = 300_000;

  #lastPruneAt = 0;
  private readonly startupOrphanCleanupSweeps = new Set<string>();
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
  private dispatcherRunJournalRoot: string | null = null;
  private readonly dispatcherLeaseRoots = new Map<string, string>();
  private managerRunJournalHydrationTask: Promise<void> | null = null;
  private rateLimitSnapshotHydrated = false;
  private lastPersistedRateLimitsJson: string | null = null;
  /**
   * Mirror of the persisted runner rate-limit snapshot file (SYMPH-407 dual
   * rate views). Updated at hydration and on every write-behind persist —
   * this process is the file's only writer, so the mirror is exact.
   */
  private rateLimitFileView: {
    observedAt: string;
    rateLimits: Record<string, unknown>;
  } | null = null;
  private readonly captureDeployDriftFn: () => Promise<DeployDriftStatus | null>;
  /** Single-flight, captured once; see deploy-drift.ts staleness contract. */
  private deployDriftCapture: Promise<DeployDriftStatus | null> | null = null;
  private deployDrift: DeployDriftStatus | null = null;
  /** Command executor shared by the continuous-feedback provider and the
   * startup model-availability preflight (SYMPH-761), so the probe exercises
   * the exact runner the live lane uses. */
  private readonly continuousFeedbackCommand: ContinuousFeedbackCommandExecutor;
  /** Continuous-feedback model preflight result (SYMPH-761); captured once at
   * startup and surfaced in the runtime snapshot. Null until the preflight
   * runs or when it is skipped. */
  private continuousFeedbackPreflight: RuntimeSnapshotContinuousFeedbackPreflight | null =
    null;

  constructor(options: RuntimeHostOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.notifier = options.notifier ?? null;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? null;
    this.continuousFeedbackCommand =
      options.runContinuousFeedbackCommand ?? runContinuousFeedbackCommand;
    this.customStageExecutionBackends = options.stageExecutionBackends ?? null;
    this.readWorkspaceChangedFiles =
      options.readWorkspaceChangedFiles ?? readGitChangedFiles;
    this.readWorkspaceBaseRevision =
      options.readWorkspaceBaseRevision ?? readGitBaseRevision;
    this.deliverWorkerStopSignal =
      options.deliverWorkerStopSignal ?? deliverTrackedWorkerStopSignal;
    this.readLoopTraceJournal =
      options.readLoopTraceJournal ?? readLoopTraceJournal;
    this.writeLoopTraceJournal =
      options.writeLoopTraceJournal ?? writeLoopTraceJournal;
    this.readDispatcherRunJournal =
      options.readDispatcherRunJournal ?? readDispatcherRunJournal;
    this.readManagerRunJournal =
      options.readManagerRunJournal ?? readManagerRunJournal;
    this.writeDispatcherRunJournalEntry =
      options.writeDispatcherRunJournalEntry ??
      appendDispatcherRunJournalEntryToDisk;
    this.listWorkspaceCwdProcessIds =
      options.listWorkspaceCwdProcessIds ??
      ((workspacePath, listerOptions) =>
        listWorkspaceCwdProcessIdsFromLsof(workspacePath, listerOptions));
    this.readProcessIdentity =
      options.readProcessIdentity ?? readProcessIdentityDefault;
    this.compactDispatcherRunJournal =
      options.compactDispatcherRunJournal ??
      compactDispatcherRunJournalFileWithLock;
    this.dispatcherRunJournalCompactionTailEntries =
      normalizeDispatcherRunJournalCompactionTailEntries(
        options.dispatcherRunJournalCompactionTailEntries,
      );
    this.terminateDetachedPidTree =
      options.terminateDetachedPidTree ?? terminateDetachedPidTreeDefault;
    this.terminateDetachedProcessGroupTree =
      options.terminateDetachedProcessGroupTree ??
      terminateDetachedProcessGroupTreeDefault;
    this.captureDeployDriftFn =
      options.captureDeployDrift ??
      (() => captureDeployDrift({ repoRoot: resolveRuntimeRepoRoot() }));
    this.workspaceManager =
      options.workspaceManager ??
      createWorkspaceManagerFromConfig(options.config, this.logger);
    this.agentEventSink = (event) => {
      const execution = this.workers.get(event.issueId);
      if (execution !== undefined) {
        execution.codexAppServerPid = parseProcessId(event.codexAppServerPid);
        execution.codexAppServerIdentity =
          event.codexAppServerIdentity === undefined
            ? null
            : event.codexAppServerIdentity;
      }
      void this.enqueue(async () => {
        const codexEventResult = this.orchestrator.onCodexEvent({
          issueId: event.issueId,
          event,
        });
        if (codexEventResult.rateLimitsUpdated) {
          await this.persistRateLimitSnapshotBestEffort();
        }
        await logAgentEvent(this.logger, event);
        await this.recordLoopTraceForAgentEvent(event);
        const feedbackEvent = toContinuousFeedbackEvent(event);
        if (feedbackEvent !== null) {
          const feedbackResult =
            await this.orchestrator.runContinuousFeedbackCheckpoint({
              issueId: event.issueId,
              event: feedbackEvent,
            });
          await this.recordLoopTraceForContinuousFeedback(
            event,
            feedbackResult,
          );
        }
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
    this.stageExecutionBackends = createMergedStageExecutionBackends(
      this.agentRunner,
      this.customStageExecutionBackends,
    );

    const timerScheduler = createQueuedTimerScheduler({
      run: (callback) => {
        void this.enqueue(async () => {
          callback();
        });
      },
    });

    const runContinuousFeedback =
      options.runContinuousFeedback ??
      createContinuousFeedbackProvider({
        resolveWorkspacePath: (issueId) =>
          this.workspaceManager.resolveForIssue(issueId).workspacePath,
        runCommand: this.continuousFeedbackCommand,
      });

    const orchestratorOptions: OrchestratorCoreOptions = {
      config: options.config,
      tracker: options.tracker,
      now: this.now,
      timerScheduler,
      writeRunJournalEntry: async (entry) => {
        await this.persistDispatcherRunJournalEntry(entry);
      },
      planDrivenDispatch: (input) => this.computePlanDrivenDispatch(input),
      resolveAdmittedIdentifiers: () => this.computeAdmittedIdentifiers(),
      runContinuousFeedback,
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
            // SYMPH-735 merge-actuator substrate. Provided to OrchestratorCore
            // but dormant: the live merge-stage dispatch barrier still parks
            // (merge_actuator_unwired) and never invokes these until Phase 2.
            getMergeActuatorLiveState: (candidate: MergeCandidateRecord) =>
              this.fetchMergeActuatorLiveState(candidate),
            mergeActuatorSideEffects: {
              markReady: async (candidate: MergeCandidateRecord) => {
                await this.runGh([
                  "pr",
                  "ready",
                  String(candidate.prNumber),
                  "--repo",
                  candidate.repo,
                ]);
              },
              enqueue: async (candidate: MergeCandidateRecord) => {
                await this.runGh(buildMergeActuatorEnqueueArgs(candidate));
              },
              disableAutoMerge: async (candidate: MergeCandidateRecord) => {
                await this.runGh(buildMergeActuatorDisableAutoArgs(candidate));
              },
              writeTrackerDone: async (candidate: MergeCandidateRecord) => {
                const teamKey =
                  candidate.issueIdentifier.split("-")[0] ??
                  candidate.issueIdentifier;
                await (this.tracker as LinearTrackerClient).updateIssueState(
                  candidate.issueId,
                  "Done",
                  teamKey,
                );
              },
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
        budgetMultiplier,
        acceptanceCriteria,
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
          rightSizingDecision,
          acceptanceCriteria,
          budgetMultiplier,
          rightSizingDecision.reasoningEffort.selectedEffort,
        );
      },
      runPauseTriage: (evidence) =>
        runPauseTriage({
          config: this.config.pauseTriage,
          evidence,
        }),
      // Watchdog L2 stuck-ticket triage (SYMPH-399). The module itself
      // resolves null when the lane is unconfigured or disabled; the core
      // additionally gates on watchdog.stuck_triage.enabled so a disabled
      // lane produces zero side effects.
      ...(this.config.watchdog.stuckTriage === undefined
        ? {}
        : {
            runStuckTriage: (
              evidence: Parameters<typeof runStuckTriage>[0]["evidence"],
            ) =>
              runStuckTriage({
                // biome-ignore lint/style/noNonNullAssertion: guarded by the spread condition
                config: this.config.watchdog.stuckTriage!,
                evidence,
              }),
          }),
      scheduleDeferred: (task) => void this.enqueue(task),
      runAcGate: (evidence) =>
        runAcGate({
          config: this.config.pauseTriage,
          evidence,
        }),
      runSpecFidelityJudge: async (evidence) => {
        // Harness-measured evidence: the actual workspace diff, resolved
        // from the same sanitized path the workspace manager uses. A
        // missing/unreadable workspace yields a null diff and the judge
        // declines to opine (fail open).
        let workspacePath: string | null = null;
        let diff: string | null = null;
        try {
          ({ workspacePath } = this.workspaceManager.resolveForIssue(
            evidence.issueId,
          ));
          diff = getDiff(workspacePath);
        } catch {
          workspacePath = null;
          diff = null;
        }
        const verdict = await runSpecFidelityJudge({
          config: this.config.pauseTriage,
          evidence: {
            issueIdentifier: evidence.issueIdentifier,
            issueTitle: evidence.issueTitle,
            // Frozen gate-passed snapshot resolved by core from journal-
            // backed state (SYMPH-374) — never workpad or worker-supplied.
            acceptanceCriteria: evidence.acceptanceCriteria,
            diff,
            reviewMessage: evidence.reviewMessage,
          },
        });
        if (verdict !== null && workspacePath !== null) {
          // Out-of-band enforcement (SYMPH-355): publish the verdict as a
          // commit status on the workspace HEAD so branch protection can
          // require it. Fire-and-forget — the judge result never waits on
          // GitHub, and a failed publish fails open (warn only).
          void publishVerdictStatus({
            workspacePath,
            issueIdentifier: evidence.issueIdentifier,
            context: "symphony/spec-fidelity",
            verdict: verdict.verdict,
            description: `${verdict.verdict}: ${verdict.findings.slice(0, 120)}`,
          }).catch((error) => {
            console.warn(
              `[verdict-status] unexpected publish rejection for ${evidence.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        return verdict;
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
        return await this.stopWorkerExecution(input.issueId, {
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
      requestTrackerIssueWrite: async (input) => {
        if (!(this.tracker instanceof LinearTrackerClient)) {
          return;
        }
        await writeTrackerIssueFromBoundary({
          client: this.tracker,
          request: input,
          terminalStates: options.config.tracker.terminalStates,
          now: this.now,
          onFailure: ({ title, sourceIssueIds, error }) => {
            const trackerError =
              error instanceof Error
                ? (error as {
                    code?: unknown;
                    status?: unknown;
                    details?: unknown;
                  })
                : null;
            const reason =
              error instanceof Error ? error.message : String(error);
            const httpStatus =
              typeof trackerError?.status === "number"
                ? trackerError.status
                : null;
            // Serialize the tracker error payload — logging the raw object
            // renders as "[object Object]" in the journal line (SYMPH-413).
            const serializedDetails = serializeTrackerErrorDetails(
              trackerError?.details,
            );
            void this.logger?.warn(
              "tracker_follow_up_write_failed",
              "Failed to create or update dispatcher follow-up issue.",
              {
                outcome: "degraded",
                title,
                source_issue_ids: sourceIssueIds,
                reason,
                ...(typeof trackerError?.code === "string"
                  ? { error_code: trackerError.code }
                  : {}),
                ...(httpStatus !== null ? { http_status: httpStatus } : {}),
                ...(serializedDetails !== null
                  ? { details: serializedDetails }
                  : {}),
              },
            );
            // Surface on the Slack alert channel (SYMPH-397) — a warn-level
            // journal line alone let three branch_divergence findings vanish.
            // Fail-open: this runs inside the tracker-write catch block, which
            // re-throws the original error; a throwing notifier must not mask
            // it (the SYMPH-397 fail-open contract).
            try {
              this.notifier?.notify({
                type: "tracker_write_failed",
                followUpTitle: title,
                sourceIssueIds,
                reason,
                httpStatus,
                details: serializeTrackerErrorDetails(
                  trackerError?.details,
                  500,
                ),
              });
            } catch (notifyError) {
              void this.logger?.warn(
                "tracker_write_failed_notify_error",
                "Failed to emit tracker_write_failed Slack alert.",
                {
                  outcome: "degraded",
                  reason:
                    notifyError instanceof Error
                      ? notifyError.message
                      : String(notifyError),
                },
              );
            }
          },
        });
      },
      fileTrackFindings: async (request) =>
        this.fileTrackFindingsBestEffort(request),
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
      // Watchdog / lifecycle alert callbacks (SYMPH-397).
      // Capture notifier in a local so biome can narrow the non-null assertion
      // without needing the !-operator on a class property.
      ...(this.notifier !== null
        ? ((_notifier) => ({
            onFailureExhausted: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              reason: string;
              stageName: string | null;
              failureSignature: string | null;
              failureClass: string | null;
            }) => {
              _notifier.notify({
                type: "failure_exhausted",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                reason: input.reason,
                failureSignature: input.failureSignature,
                failureClass: input.failureClass,
              });
            },
            onHardStopBudget: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              stageName: string | null;
              trigger: string;
              reason: string;
              totalTokens: number;
              estimatedCostUsd: number;
            }) => {
              _notifier.notify({
                type: "hard_stop_budget",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                trigger: input.trigger,
                reason: input.reason,
                totalTokens: input.totalTokens,
                estimatedCostUsd: input.estimatedCostUsd,
              });
            },
            onEscalationStep: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              stageName: string | null;
              step: number;
              maxSteps: number;
              multiplier: number;
              trigger: string;
            }) => {
              _notifier.notify({
                type: "escalation_step",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                step: input.step,
                maxSteps: input.maxSteps,
                multiplier: input.multiplier,
                trigger: input.trigger,
              });
            },
            onGateFailed: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              stageName: string | null;
              reason: string;
            }) => {
              _notifier.notify({
                type: "gate_failed",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                reason: input.reason,
              });
            },
            onAcGateFailOpen: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              stageName: string | null;
              failOpenStreak: number;
              severity: "warning" | "critical";
            }) => {
              _notifier.notify({
                type: "ac_gate_fail_open",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                failOpenStreak: input.failOpenStreak,
                severity: input.severity,
              });
            },
            onSystemicCluster: (input: {
              signature: string;
              errorClass: string;
              stageName: string | null;
              clusterSize: number;
              issueIdentifiers: string[];
              breakerOpened: boolean;
              canFileWatchdogTicket: boolean;
              members: ClusterMember[];
              journalSequence: number | null;
            }) => {
              // Fire the SYSTEMIC Slack alert (once-per-signature, re-alert on growth)
              _notifier.notify({
                type: "systemic_cluster_alert",
                signature: input.signature,
                errorClass: input.errorClass,
                stageName: input.stageName,
                clusterSize: input.clusterSize,
                issueIdentifiers: input.issueIdentifiers,
                breakerOpened: input.breakerOpened,
                watchdogTicketFiling: input.canFileWatchdogTicket,
                journalSequence: input.journalSequence,
              });

              // Watchdog ticket filer — best-effort, never blocks the loop
              if (input.canFileWatchdogTicket) {
                void this.fileWatchdogTicketBestEffort(input);
              }
            },
            // Verdict-event alerts (SYMPH-405): transitions-only gate/halt
            // notifications and the dispatch-starvation page condition.
            // Fail-open — notifier absence/failure never blocks dispatch.
            onVerdictTransition: (input: {
              issueId: string;
              issueIdentifier: string;
              disposition: "admit" | "skip" | "gate" | "halt";
              reasonCode: string;
              remedy: string | null;
              actor: { kind: string; host: string; session?: string };
              sequence: number | null;
            }) => {
              if (
                input.disposition !== "gate" &&
                input.disposition !== "halt"
              ) {
                return;
              }
              _notifier.notify({
                type: "dispatch_verdict_alert",
                issueIdentifier: input.issueIdentifier,
                disposition: input.disposition,
                reasonCode: input.reasonCode,
                remedy: input.remedy,
                actor: input.actor,
                sequence: input.sequence,
              });
            },
            onDispatchPage: (input: {
              kind: "page" | "recovery";
              eligibleCount: number;
              consecutiveTicks: number;
              gate?: DispatchGateInfo;
            }) => {
              const event = {
                type: "dispatch_page_alert",
                kind: input.kind,
                eligibleCount: input.eligibleCount,
                consecutiveTicks: input.consecutiveTicks,
              } satisfies DispatchPageAlertEvent;
              _notifier.notify(
                input.gate === undefined
                  ? event
                  : { ...event, gate: input.gate },
              );
            },
            onExistingActiveResumed: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              issueUrl: string | null;
              stageName: string | null;
              attempt: number | null;
              reworkCount: number;
              sequence: number | null;
            }) => {
              _notifier.notify({
                type: "resumed_existing_active",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: input.issueUrl,
                stageName: input.stageName,
                attempt: input.attempt,
                reworkCount: input.reworkCount,
                journalSequence: input.sequence,
              });
            },
            // Watchdog L2 escalate_human verdicts page through the same
            // SYMPH-397 alert channel (SYMPH-399).
            onTriageEscalation: (input: {
              issueId: string;
              issueIdentifier: string;
              issueTitle: string;
              stageName: string | null;
              classification: string;
              confidence: string;
              caseText: string;
            }) => {
              _notifier.notify({
                type: "triage_escalation",
                issueIdentifier: input.issueIdentifier,
                issueTitle: input.issueTitle,
                issueUrl: this.resolveIssueUrlBestEffort(input.issueId),
                stageName: input.stageName,
                classification: input.classification,
                confidence: input.confidence,
                caseText: input.caseText,
                attribution: `by watchdog-l2@${hostname().split(".")[0] ?? hostname()}`,
              });
            },
          }))(this.notifier)
        : {}),
      // Watchdog ticket filer without a notifier: the circuit breaker operates
      // purely inside the SignatureClusterRegistry; the host always wires the
      // ticket-filing side of onSystemicCluster regardless of whether a Slack
      // notifier is present. When both notifier and tracker are present the
      // notifier spread above covers the full path; this branch handles the
      // tracker-only case where notifier is null.
      ...(this.notifier === null
        ? {
            onSystemicCluster: (input: {
              signature: string;
              errorClass: string;
              stageName: string | null;
              clusterSize: number;
              issueIdentifiers: string[];
              breakerOpened: boolean;
              canFileWatchdogTicket: boolean;
              members: ClusterMember[];
              journalSequence: number | null;
            }) => {
              if (input.canFileWatchdogTicket) {
                void this.fileWatchdogTicketBestEffort(input);
              }
            },
          }
        : {}),
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
      const previousRoot = this.workspaceManager.root;
      this.workspaceManager = input.workspaceManager;
      this.dispatcherRunJournalHydrationTask = null;
      if (previousRoot !== this.workspaceManager.root) {
        this.handleDispatcherRunJournalRootSwap();
      }
      this.managerRunJournalHydrationTask = null;
    }

    this.orchestrator.updateConfig(input.config);

    if (this.managesAgentRunner) {
      this.agentRunner = this.createManagedAgentRunner({
        config: this.config,
        tracker: this.tracker,
        workspaceManager: this.workspaceManager,
      });
      this.stageExecutionBackends = createMergedStageExecutionBackends(
        this.agentRunner,
        this.customStageExecutionBackends,
      );
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
    this.stageExecutionBackends = createMergedStageExecutionBackends(
      this.agentRunner,
      this.customStageExecutionBackends,
    );

    this.notifySnapshotListeners();
  }

  async pollOnce() {
    return this.enqueue(async () => {
      await this.ensureDispatcherRunJournalLoaded();
      await this.ensureRateLimitSnapshotHydrated();
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

  /**
   * Continuous-feedback model-availability preflight (SYMPH-761). Probes ONCE
   * at startup that the configured continuous_feedback.model resolves on its
   * runner and records the result in runtime state (surfaced in the snapshot).
   * Skips when the lane is disabled or has no configured model — the
   * local-model gate: a null model means "runner default", with nothing
   * specific to probe. An unavailable model surfaces a single startup warning;
   * with continuous_feedback.preflight_fail_closed it instead fails startup
   * closed (RuntimeHostStartupError) for operators who require the inner-loop
   * reviewer to be live before launch. Warn-not-block is the default — the
   * lane already degrades gracefully at runtime (status "unavailable").
   */
  async runContinuousFeedbackModelPreflight(): Promise<ContinuousFeedbackProbeResult | null> {
    // Probe at most once (the "ONCE at startup" contract): a repeat call (e.g.
    // a future config-reload path) is a no-op that returns the recorded result
    // rather than re-spawning the runner and overwriting runtime state.
    if (this.continuousFeedbackPreflight !== null) {
      return null;
    }
    const feedback = this.config.continuousFeedback;
    // Local-model gate: probe only an explicitly configured, non-blank model.
    // null / absent collapses to the runner default (no `--model`), and a blank
    // string would otherwise spawn `--model ""` and crash a fail-closed launch
    // (council R1). Both mean "nothing specific to probe" — skip.
    const model = feedback?.model ?? null;
    if (
      feedback === undefined ||
      !feedback.enabled ||
      model === null ||
      model.trim() === ""
    ) {
      return null;
    }
    const result = await probeContinuousFeedbackModel(
      {
        runner: feedback.runner,
        model,
        role: feedback.role,
      },
      { runCommand: this.continuousFeedbackCommand },
    );
    this.continuousFeedbackPreflight = {
      available: result.available,
      model,
      runner: feedback.runner,
      detail: result.detail,
      checked_at: this.now().toISOString(),
    };
    if (result.available) {
      await this.logger?.info(
        "continuous_feedback_preflight",
        `Continuous-feedback model ${model} resolved on runner ${feedback.runner}.`,
        { model, runner: feedback.runner },
      );
      return result;
    }
    await this.logger?.warn(
      "continuous_feedback_preflight_unavailable",
      `Continuous-feedback model ${model} is unavailable on runner ${feedback.runner}.`,
      {
        model,
        runner: feedback.runner,
        detail: result.detail,
        fail_closed: feedback.preflightFailClosed,
      },
    );
    if (feedback.preflightFailClosed) {
      throw new RuntimeHostStartupError(
        `continuous-feedback model ${model} unavailable on runner ${feedback.runner}: ${result.detail}`,
        "continuous_feedback_model_unavailable",
      );
    }
    return result;
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    // The dashboard starts listening before the first poll cycle — hydrate
    // the durable dispatcher journal eagerly so early reads see persisted
    // entries instead of an empty in-memory journal. Idempotent and
    // single-flight (shared hydration task with the poll path). Best-effort:
    // a disk-read failure degrades to in-memory state, never fails the read.
    await this.refreshDispatcherRunJournalForSnapshot().catch(() => undefined);
    await this.refreshManagerRunJournalForSnapshot();
    const state = this.orchestrator.getState();
    state.managerRuns = reduceManagerRunJournal(state.managerRunJournal, {
      now: this.now(),
    });
    return buildRuntimeSnapshot(this.orchestrator.getState(), {
      now: this.now(),
      enrichment: {
        asOfSequence: this.orchestrator.getRunJournalCursor(),
        components: buildComponentStatuses({
          config: this.config,
          notifierPresent: this.notifier !== null,
          rateLimitTelemetryPresent: state.codexRateLimits !== null,
        }),
        deployDrift: this.readDeployDriftNonBlocking(),
        continuousFeedbackPreflight: this.continuousFeedbackPreflight,
        codexCaps: {
          toolOutputTokenLimit:
            this.config.codex.toolOutputTokenLimit ??
            DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
          modelAutoCompactTokenLimit:
            this.config.codex.modelAutoCompactTokenLimit ??
            DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
          maxHealthyCompactionsPerStage:
            this.config.codex.maxHealthyCompactionsPerStage ??
            DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
        },
        rateLimitFile:
          this.rateLimitFileView === null
            ? null
            : {
                path: getRateLimitSnapshotPath(this.workspaceManager.root),
                observedAt: this.rateLimitFileView.observedAt,
                rateLimits: this.rateLimitFileView.rateLimits,
              },
        watchdog: this.orchestrator.getWatchdogRegistrySnapshot(),
      },
    });
  }

  /**
   * Cursor-forward delta read (SYMPH-407): journal-backed entries with
   * sequence > since_seq, bounded. Reads the same in-memory journal the
   * snapshot reducers consume — no second source of truth.
   */
  async getStateDelta(input: {
    sinceSeq: number;
    limit?: number;
  }): Promise<StateDeltaResponse> {
    // Same eager hydration as getRuntimeSnapshot: deltas must be served
    // from the durable journal even before the first poll cycle runs.
    await this.refreshDispatcherRunJournalForSnapshot().catch(() => undefined);
    return buildStateDelta(this.orchestrator.getState().dispatcherRunJournal, {
      sinceSeq: input.sinceSeq,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      asOfSequence: this.orchestrator.getRunJournalCursor(),
    });
  }

  /**
   * Non-blocking deploy-drift read: the first snapshot kicks off the
   * single-flight capture and reports null; later snapshots report the
   * captured value. Never blocks the snapshot path on a git subprocess
   * (the dashboard snapshot read has a 1s timeout). A failed capture
   * degrades to null and is retried on a later snapshot.
   */
  private readDeployDriftNonBlocking(): DeployDriftStatus | null {
    if (this.deployDriftCapture === null) {
      this.deployDriftCapture = this.captureDeployDriftFn()
        .then((captured) => {
          this.deployDrift = captured;
          return captured;
        })
        .catch(() => {
          this.deployDriftCapture = null;
          return null;
        });
    }
    return this.deployDrift === null
      ? null
      : qualifyDeployDriftFreshness(this.deployDrift, { now: this.now() });
  }

  async getIssueDetails(issueKey: string): Promise<IssueDetailResponse | null> {
    const running = Object.values(this.orchestrator.getState().running).find(
      (entry) => entry.identifier === issueKey || entry.issue.id === issueKey,
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
    ).find(
      (entry) => entry.identifier === issueKey || entry.issueId === issueKey,
    );
    if (retry !== undefined) {
      await this.ensureLoopTraceJournalLoadedBestEffort(retry.issueId);
      const parent = await this.fetchParentSafe(retry.issueId);
      return toRetryIssueDetail(
        retry.identifier ?? issueKey,
        retry,
        parent,
        await this.readCodexSessionLogsForIssueBestEffort(retry.issueId),
        buildLoopTraceJournalResponse(
          this.orchestrator.getState().loopTraceJournal[retry.issueId] ?? [],
          this.getLoopTraceLocator(retry.issueId),
        ),
      );
    }

    const inMemoryTrace = this.findInMemoryLoopTraceByIssueKey(issueKey);
    if (inMemoryTrace !== null) {
      return toStoredIssueDetail(
        issueKey,
        inMemoryTrace,
        await this.readCodexSessionLogsForIssueBestEffort(
          inMemoryTrace.issueId,
        ),
      );
    }

    const storedTrace =
      await this.findStoredLoopTraceByIssueKeyBestEffort(issueKey);
    if (storedTrace !== null) {
      return toStoredIssueDetail(
        issueKey,
        storedTrace,
        await this.readCodexSessionLogsForIssueBestEffort(storedTrace.issueId),
      );
    }

    return null;
  }

  async handleLinearWebhookDelivery(
    delivery: LinearWebhookAcceptedDelivery,
  ): Promise<void> {
    if (!(this.tracker instanceof LinearTrackerClient)) {
      throw new Error(
        "Linear webhook reconciliation requires a Linear-backed tracker.",
      );
    }
    const tracker = this.tracker;
    const plan = await runPortfolioWebhookRepair({
      delivery,
      callbacks: {
        loadIssue: async (identifierOrId) => {
          const refs = await tracker.fetchIssueReferencesByIds([
            identifierOrId,
          ]);
          const ref = refs[0];
          if (ref !== undefined) {
            return issueFromLinearReference(ref);
          }
          if (/^[A-Z]+-\d+$/.test(identifierOrId)) {
            return await tracker.fetchIssueByIdentifier(identifierOrId);
          }
          return null;
        },
        repairIssueProject: async ({ issue, projectId, classification }) => {
          const labelIds =
            issue.teamKey === null ||
            issue.teamKey === undefined ||
            issue.labels.length === 0
              ? null
              : (
                  await tracker.resolveLabelIdsByNames(
                    issue.labels,
                    issue.teamKey,
                  )
                ).map((label) => label.id);
          await tracker.updateIssue({
            issueId: issue.id,
            description: upsertPortfolioClassificationBlock(
              issue.description ?? "",
              classification,
            ),
            projectId,
            ...(labelIds === null ? {} : { labelIds }),
          });
        },
      },
    });

    if (plan !== null && plan.action !== "noop") {
      await this.logger?.info(
        "linear_webhook_portfolio_repair",
        `Linear webhook repaired portfolio classification for ${plan.issue.identifier}.`,
        {
          delivery_id: delivery.deliveryId,
          issue_id: plan.issue.id,
          issue_identifier: plan.issue.identifier,
          action: plan.action,
          target_project_id: plan.targetProjectId,
          reason: plan.reason,
        },
      );
    }
  }

  /**
   * Best-effort resolution of the Linear URL for an issue ID from runtime
   * state. Returns null when the issue is no longer in the running or retry
   * maps — that is acceptable; callers use it only for notification enrichment.
   */
  private resolveIssueUrlBestEffort(issueId: string): string | null {
    const state = this.orchestrator.getState();
    return state.running[issueId]?.issue.url ?? null;
  }

  /**
   * File a watchdog ticket for a SYSTEMIC failure cluster. Best-effort — any
   * failure is logged and swallowed. Uses the first cluster member's issue ID
   * to resolve team context from the tracker (SYMPH-398).
   */
  private async fileWatchdogTicketBestEffort(input: {
    signature: string;
    errorClass: string;
    stageName: string | null;
    members: ClusterMember[];
    journalSequence?: number | null;
  }): Promise<void> {
    if (!(this.tracker instanceof LinearTrackerClient)) {
      return;
    }
    const firstMember = input.members[0];
    if (firstMember === undefined) {
      return;
    }
    try {
      const tracker = this.tracker;

      // Derive team context: prefer config.tracker fields, fall back to member
      // issue lookup so the filer works even when teamId is not pre-populated.
      let teamId = this.config.tracker.teamId;
      let teamKey = this.config.tracker.teamKey;
      if (!teamId || !teamKey) {
        const refs = await tracker.fetchIssueReferencesByIds([
          firstMember.issueId,
        ]);
        const ref = refs[0];
        if (ref?.teamId && ref.teamKey) {
          teamId = ref.teamId;
          teamKey = ref.teamKey;
        }
      }
      // Derive team key from the identifier (e.g. "SYMPH-123" → "SYMPH") as a
      // last resort so simple setups without explicit teamId still work.
      teamKey ||= firstMember.issueIdentifier.split("-")[0] ?? "";
      // teamId is mandatory for issueCreate; an empty teamId reaches Linear and
      // is rejected, and the catch would swallow it silently. Fail LOUDLY and
      // skip rather than attempt a create that can never succeed (SYMPH-398).
      if (!teamId || !teamKey) {
        await this.logger?.warn(
          "watchdog_ticket_filing_skipped",
          "Cannot file watchdog ticket: team context not resolvable.",
          {
            outcome: "degraded",
            signature: input.signature,
            issue_id: firstMember.issueId,
            reason: !teamId
              ? "teamId could not be resolved (config.tracker.teamId unset and not derivable from member issues)"
              : "teamKey could not be resolved",
          },
        );
        return;
      }

      const title = `[watchdog] SYSTEMIC failure cluster: ${input.signature}`;
      const body = formatWatchdogTicketBody({
        signature: input.signature,
        errorClass: input.errorClass as ErrorSignatureClass,
        members: input.members,
        stageName: input.stageName,
        observedAt: new Date().toISOString(),
        journalSequence: input.journalSequence ?? null,
      });
      const result = await tracker.createWatchdogIssue({
        teamId,
        teamKey,
        title,
        description: body,
      });
      // Record the filing so the per-signature rate limiter can suppress
      // duplicates without a tracker round-trip (SYMPH-398). Record on both
      // created and deduped outcomes — a deduped result still consumed a filing
      // opportunity and the throttle window should reflect that.
      this.orchestrator.recordWatchdogFiling({
        signature: input.signature,
        issueIdentifier: result.identifier,
      });
      await this.logger?.info(
        "watchdog_ticket_filed",
        `Watchdog ticket ${result.created ? "created" : "deduped"}: ${result.identifier}`,
        {
          outcome: result.created ? "created" : "deduped",
          signature: input.signature,
          identifier: result.identifier,
        },
      );
    } catch (err) {
      await this.logger?.warn(
        "watchdog_ticket_filing_failed",
        "Failed to file watchdog ticket.",
        {
          outcome: "degraded",
          signature: input.signature,
          reason: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  /**
   * File the council's surviving Track findings to Linear (SYMPH-763). Wired
   * into the orchestrator's review→merge closeout as the `fileTrackFindings`
   * callback; mirrors {@link fileWatchdogTicketBestEffort} (team-context
   * resolution + LinearTrackerClient dedup). Returns the durable refs the
   * orchestrator journals plus an explicit per-finding reason for anything the
   * tracker could not file — never throws, so the merge advance is never blocked
   * and no finding is silently dropped (SYMPH-760 invariant).
   */
  private async fileTrackFindingsBestEffort(
    request: TrackFindingFilingRequest,
  ): Promise<TrackFindingFilingResult> {
    const allUnfiled = (reason: string): TrackFindingFilingResult => ({
      filed: [],
      unfiled: request.findings.map((finding) => ({
        fingerprint: finding.fingerprint,
        reason,
      })),
    });

    if (!(this.tracker instanceof LinearTrackerClient)) {
      return allUnfiled(
        "tracker is not Linear-backed; Track findings cannot be filed",
      );
    }
    const tracker = this.tracker;

    // Resolve team context: prefer config.tracker fields, fall back to the
    // source issue lookup, then the identifier prefix (e.g. "SYMPH-1" → "SYMPH").
    let teamId = this.config.tracker.teamId;
    let teamKey = this.config.tracker.teamKey;
    if (!teamId || !teamKey) {
      try {
        const refs = await tracker.fetchIssueReferencesByIds([request.issueId]);
        const ref = refs[0];
        if (ref?.teamId && ref.teamKey) {
          teamId = ref.teamId;
          teamKey = ref.teamKey;
        }
      } catch {
        // Fall through to identifier-prefix derivation below.
      }
    }
    teamKey ||= request.issueIdentifier.split("-")[0] ?? "";
    if (!teamId || !teamKey) {
      const reason = !teamId
        ? "team context not resolvable: teamId unset and not derivable from the source issue"
        : "team context not resolvable: teamKey unset";
      await this.logger?.warn(
        "track_finding_filing_skipped",
        "Cannot file Track findings: team context not resolvable.",
        { outcome: "degraded", issue_id: request.issueId, reason },
      );
      return allUnfiled(reason);
    }

    const context: TrackFindingIssueContext = {
      sourceIssueIdentifier: request.issueIdentifier,
      sourceIssueUrl: request.issueUrl,
      repo: request.repo,
      prNumber: request.prNumber,
      reviewedHeadSha: request.reviewedHeadSha,
    };

    const filed: TrackFindingFilingRef[] = [];
    const unfiled: Array<{ fingerprint: string; reason: string }> = [];
    for (const finding of request.findings) {
      try {
        const result = await tracker.createTrackFindingIssue({
          teamId,
          teamKey,
          fingerprint: finding.fingerprint,
          title: buildTrackFindingIssueTitle(finding),
          description: buildTrackFindingIssueBody(finding, context),
        });
        filed.push({
          fingerprint: finding.fingerprint,
          issueId: result.id,
          identifier: result.identifier,
          url: result.url,
        });
        await this.logger?.info(
          "track_finding_filed",
          `Track finding ${result.created ? "filed" : "deduped"}: ${result.identifier}`,
          {
            outcome: result.created ? "created" : "deduped",
            issue_id: request.issueId,
            identifier: result.identifier,
            fingerprint: finding.fingerprint,
          },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        unfiled.push({ fingerprint: finding.fingerprint, reason });
        await this.logger?.warn(
          "track_finding_filing_failed",
          "Failed to file a Track finding.",
          {
            outcome: "degraded",
            issue_id: request.issueId,
            fingerprint: finding.fingerprint,
            reason,
          },
        );
      }
    }
    return { filed, unfiled };
  }

  private findInMemoryLoopTraceByIssueKey(
    issueKey: string,
  ): StoredLoopTrace | null {
    for (const [issueId, journal] of Object.entries(
      this.orchestrator.getState().loopTraceJournal,
    )) {
      if (journal.some((entry) => isTraceEntryForIssueKey(entry, issueKey))) {
        return {
          issueId,
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

  private async readCodexSessionLogsForIssueBestEffort(
    issueId: string,
  ): Promise<CodexSessionLogEntry[]> {
    try {
      const { workspaceKey } = this.workspaceManager.resolveForIssue(issueId);
      return await readCodexSessionLogsForIssue(
        this.workspaceManager.root,
        workspaceKey,
      );
    } catch {
      return [];
    }
  }

  async requestRefresh(): Promise<RefreshResponse> {
    const requestedAt = formatEasternTimestamp(this.now());
    const coalesced = this.refreshQueued;
    this.refreshQueued = true;

    if (!coalesced) {
      void this.enqueue(async () => {
        await this.ensureDispatcherRunJournalLoaded();
        await this.ensureRateLimitSnapshotHydrated();
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
      signal_delivery:
        stopRequest.signalDelivery === undefined
          ? null
          : toStopSignalDeliveryResponse(stopRequest.signalDelivery),
    };
  }

  /**
   * Hydrate the last persisted Codex rate-limit snapshot into orchestrator
   * state once per process (SYMPH-336), so the dispatch admission floor can
   * engage from the first poll tick after a restart. Live telemetry always
   * wins for orchestrator STATE: hydration only assigns it while no snapshot
   * has been observed yet. The runner-file view, by contrast, is always
   * loaded from the persisted file (it mirrors what the FILE says even when
   * live telemetry superseded it). Stale data is safe — the admission gate
   * ignores windows whose resets_at has passed.
   */
  private async ensureRateLimitSnapshotHydrated(): Promise<void> {
    if (this.rateLimitSnapshotHydrated) {
      return;
    }
    this.rateLimitSnapshotHydrated = true;

    const state = this.orchestrator.getState();

    try {
      const persisted = await loadPersistedRateLimitSnapshot(
        this.workspaceManager.root,
      );
      if (persisted === null) {
        return;
      }
      // Mirror the on-disk runner snapshot for the dual rate views
      // (SYMPH-407) even when live telemetry already superseded it — the
      // point of the file view is showing what the FILE says.
      this.rateLimitFileView = {
        observedAt: persisted.observedAt,
        rateLimits: persisted.rateLimits,
      };
      if (state.codexRateLimits === null) {
        state.codexRateLimits = persisted.rateLimits;
        state.codexRateLimitsObservedAt = persisted.observedAt;
        this.lastPersistedRateLimitsJson = JSON.stringify(persisted.rateLimits);
        await this.logger?.info(
          "rate_limit_snapshot_hydrated",
          "Hydrated persisted Codex rate-limit snapshot.",
          {
            outcome: "hydrated",
            observed_at: persisted.observedAt,
            workspace_root: this.workspaceManager.root,
          },
        );
      }
    } catch (error) {
      await this.logger?.warn(
        "rate_limit_snapshot_hydration_failed",
        "Failed to hydrate persisted rate-limit snapshot.",
        {
          outcome: "degraded",
          reason: toErrorMessage(error),
          workspace_root: this.workspaceManager.root,
        },
      );
    }
  }

  /**
   * Write-behind persistence of the latest rate-limit snapshot. Best-effort
   * and deduplicated on content: failures degrade to pre-SYMPH-336 behavior
   * and must never disturb the event path.
   */
  private async persistRateLimitSnapshotBestEffort(): Promise<void> {
    const rateLimits = this.orchestrator.getState().codexRateLimits;
    if (rateLimits === null) {
      return;
    }

    const serialized = JSON.stringify(rateLimits);
    if (serialized === this.lastPersistedRateLimitsJson) {
      return;
    }

    try {
      const observedAt = this.now().toISOString();
      await persistRateLimitSnapshot(this.workspaceManager.root, {
        observedAt,
        rateLimits,
      });
      this.lastPersistedRateLimitsJson = serialized;
      this.rateLimitFileView = { observedAt, rateLimits };
    } catch (error) {
      await this.logger?.warn(
        "rate_limit_snapshot_persist_failed",
        "Failed to persist rate-limit snapshot.",
        {
          outcome: "degraded",
          reason: toErrorMessage(error),
          workspace_root: this.workspaceManager.root,
        },
      );
    }
  }

  private async ensureDispatcherRunJournalLoaded(): Promise<void> {
    const workspaceRoot = this.workspaceManager.root;
    if (this.dispatcherRunJournalLoaded) {
      if (this.dispatcherRunJournalRoot === workspaceRoot) {
        return;
      }
      if (this.hasActiveDispatcherLeases()) {
        await this.orchestrator.expireDispatcherLeases();
      }
      if (this.hasDispatcherRootOwnedWork()) {
        throw new Error(
          `Dispatcher run journal root swap from ${this.dispatcherRunJournalRoot ?? "unknown"} to ${workspaceRoot} is pending active leases or workers.`,
        );
      }
      this.dispatcherRunJournalLoaded = false;
      this.dispatcherRunJournalRoot = null;
    }
    if (this.dispatcherRunJournalHydrationTask !== null) {
      await this.dispatcherRunJournalHydrationTask;
      return;
    }

    const task = (async () => {
      try {
        let journal = await this.readDispatcherRunJournal(workspaceRoot);
        this.orchestrator.recoverFromRunJournal(journal);
        await this.cleanupUnconfirmedEmergencyStopProcesses(journal);
        await this.cleanupRecoveredDispatcherAdmissionOrphans(
          this.orchestrator.getState().dispatcherRunJournal,
        );
        journal = this.orchestrator.getState().dispatcherRunJournal;
        const compaction =
          await this.compactLoadedDispatcherRunJournal(workspaceRoot);
        if (compaction?.compacted === true) {
          journal = compaction.journal;
          this.orchestrator.recoverFromRunJournal(journal);
        }
        this.rememberDispatcherRunJournalRoot(workspaceRoot, journal);
      } catch (error) {
        await this.logger?.warn(
          "dispatcher_run_journal_hydration_failed",
          "Failed to hydrate dispatcher run journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            workspace_root: workspaceRoot,
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

  private async refreshDispatcherRunJournalForSnapshot(): Promise<void> {
    await this.ensureDispatcherRunJournalLoaded();
    const workspaceRoot = this.workspaceManager.root;
    if (this.dispatcherRunJournalRoot !== workspaceRoot) {
      return;
    }

    const durableJournal = await this.readDispatcherRunJournal(workspaceRoot);
    const durableCursor = durableJournal.at(-1)?.sequence ?? 0;
    const currentCursor = this.orchestrator.getRunJournalCursor();
    if (durableCursor <= currentCursor) {
      return;
    }

    // Snapshot reads may observe standalone read-model writers such as
    // spec-review watch or council-review gate. Merge those rows directly into
    // the journal without replaying operational state; mutating dispatcher
    // effects must still route through the runtime host.
    const mergedJournal = mergeDispatcherRunJournals(
      this.orchestrator.getState().dispatcherRunJournal,
      durableJournal.filter(isSnapshotRefreshExternalJournalEntry),
    );
    if ((mergedJournal.at(-1)?.sequence ?? 0) <= currentCursor) {
      return;
    }

    this.orchestrator.getState().dispatcherRunJournal = mergedJournal;
    this.rememberDispatcherRunJournalRoot(workspaceRoot, mergedJournal);
  }

  private async compactLoadedDispatcherRunJournal(
    workspaceRoot: string,
  ): Promise<CompactDispatcherRunJournalResult | null> {
    const unconfirmedEmergencyStopPlans =
      collectUnconfirmedEmergencyStopCleanupPlans(
        this.orchestrator.getState().dispatcherRunJournal,
      );
    if (unconfirmedEmergencyStopPlans.length > 0) {
      await this.logger?.warn(
        "dispatcher_run_journal_compaction_skipped",
        "Skipped dispatcher run-journal compaction while emergency-stop cleanup proof remains unconfirmed.",
        {
          outcome: "degraded",
          skipped_reason: "unconfirmed_emergency_stop_cleanup",
          unconfirmed_cleanup_plan_count: unconfirmedEmergencyStopPlans.length,
        },
      );
      return null;
    }
    const checkpointDraft = this.orchestrator.createRunJournalCheckpointDraft();
    if (checkpointDraft === null) {
      return null;
    }
    const result = await this.compactDispatcherRunJournal(
      workspaceRoot,
      checkpointDraft,
      { tailEntryCount: this.dispatcherRunJournalCompactionTailEntries },
    );
    if (result.compacted) {
      await this.logger?.info(
        "dispatcher_run_journal_compacted",
        "Compacted dispatcher run journal after hydration.",
        {
          original_entry_count: result.originalEntryCount,
          retained_entry_count: result.retainedEntryCount,
          dropped_entry_count: result.droppedEntryCount,
          checkpoint_sequence: result.checkpointSequence,
          covered_through_sequence: result.coveredThroughSequence,
          retained_tail_entries: result.retainedTailEntries,
        },
      );
    } else if (result.skippedReason === "stale_checkpoint") {
      await this.logger?.warn(
        "dispatcher_run_journal_compaction_skipped",
        "Skipped dispatcher run-journal compaction because the disk cursor advanced before the locked rewrite.",
        {
          outcome: "degraded",
          skipped_reason: result.skippedReason,
          current_cursor: result.coveredThroughSequence,
        },
      );
    }
    return result;
  }

  private async cleanupUnconfirmedEmergencyStopProcesses(
    journal: DispatcherRunJournal,
  ): Promise<void> {
    const cleanupPlans = collectUnconfirmedEmergencyStopCleanupPlans(journal);
    const cleanupPlansByIssue = new Map<
      string,
      EmergencyStopRecoveryCleanupPlan[]
    >();
    for (const plan of cleanupPlans) {
      const plans = cleanupPlansByIssue.get(plan.issueId) ?? [];
      plans.push(plan);
      cleanupPlansByIssue.set(plan.issueId, plans);
    }

    for (const [issueId, plans] of cleanupPlansByIssue) {
      const sortedPlans = plans.sort(
        (left, right) => left.setBySequence - right.setBySequence,
      );
      const latestPlan = sortedPlans.at(-1);
      if (latestPlan === undefined) {
        continue;
      }
      this.orchestrator.requireEmergencyStopProcessCleanup(issueId, {
        setBySequence: latestPlan.setBySequence,
        since: latestPlan.since,
      });

      const unconfirmedPlans: EmergencyStopRecoveryCleanupPlan[] = [];
      const orphanCleanupSweeps = new Set<string>();
      for (const plan of sortedPlans) {
        const parsedPid = parseProcessPid(plan.codexAppServerPid);
        let targetedCleanupSucceeded = false;
        try {
          if (
            parsedPid !== null &&
            parsedPid !== process.pid &&
            plan.codexAppServerIdentity !== null &&
            plan.codexAppServerIdentity.pid === parsedPid &&
            plan.codexAppServerIdentity.processGroupId === parsedPid
          ) {
            const termination = await this.terminateDetachedPidTree(parsedPid, {
              graceMs: 1_000,
              expectedIdentity: plan.codexAppServerIdentity,
            });
            if (processTreeTerminationConfirmed(termination)) {
              targetedCleanupSucceeded = true;
              await this.logger?.log(
                "info",
                "emergency_stop_recovery_process_tree_killed",
                `Confirmed recovered emergency-stop process-tree cleanup for ${plan.issueIdentifier}.`,
                {
                  issue_id: issueId,
                  issue_identifier: plan.issueIdentifier,
                  codex_app_server_pid: plan.codexAppServerPid,
                  source_sequence: plan.setBySequence,
                  ...processTreeTerminationLogFields(termination),
                },
              );
            } else {
              unconfirmedPlans.push(plan);
              await this.logger?.warn(
                "emergency_stop_recovery_cleanup_unconfirmed",
                "Emergency-stop recovery could not confirm recovered Codex app-server process-tree cleanup.",
                {
                  outcome: "degraded",
                  issue_id: issueId,
                  issue_identifier: plan.issueIdentifier,
                  codex_app_server_pid: plan.codexAppServerPid,
                  source_sequence: plan.setBySequence,
                  ...processTreeTerminationLogFields(termination),
                },
              );
            }
          } else {
            unconfirmedPlans.push(plan);
            await this.logger?.warn(
              "emergency_stop_recovery_missing_pid",
              "Emergency-stop recovery found an interrupted issue without a usable Codex app-server PID and process identity.",
              {
                outcome: "degraded",
                issue_id: issueId,
                issue_identifier: plan.issueIdentifier,
                codex_app_server_pid: plan.codexAppServerPid,
                source_sequence: plan.setBySequence,
              },
            );
          }

          const { workspacePath } =
            this.workspaceManager.resolveForIssue(issueId);
          const orphanCleanupSweepKey = `${issueId}\0${workspacePath}`;
          if (!orphanCleanupSweeps.has(orphanCleanupSweepKey)) {
            orphanCleanupSweeps.add(orphanCleanupSweepKey);
            this.startupOrphanCleanupSweeps.add(orphanCleanupSweepKey);
            await this.killOrphanedProcesses(
              workspacePath,
              plan.issueIdentifier,
            );
          }
          if (targetedCleanupSucceeded) {
            const cleanupSequence =
              await this.orchestrator.recordEmergencyStopRecoveryCleanup({
                issueId,
                issueIdentifier: plan.issueIdentifier,
                codexAppServerPid: plan.codexAppServerPid,
                codexAppServerIdentity: plan.codexAppServerIdentity,
                sourceSequence: plan.setBySequence,
              });
            if (cleanupSequence === null) {
              unconfirmedPlans.push(plan);
            }
          }
        } catch (error) {
          unconfirmedPlans.push(plan);
          await this.logger?.warn(
            "emergency_stop_recovery_cleanup_failed",
            "Failed to clean up recovered emergency-stop process tree.",
            {
              outcome: "degraded",
              issue_id: issueId,
              issue_identifier: plan.issueIdentifier,
              source_sequence: plan.setBySequence,
              reason: toErrorMessage(error),
            },
          );
        }
      }

      const latestUnconfirmedPlan = unconfirmedPlans.at(-1);
      if (latestUnconfirmedPlan !== undefined) {
        this.orchestrator.requireEmergencyStopProcessCleanup(issueId, {
          setBySequence: latestUnconfirmedPlan.setBySequence,
          since: latestUnconfirmedPlan.since,
        });
      }
    }
  }

  private handleDispatcherRunJournalRootSwap(): void {
    if (!this.dispatcherRunJournalLoaded) {
      this.dispatcherRunJournalRoot = null;
      return;
    }

    if (this.hasDispatcherRootOwnedWork()) {
      return;
    }

    this.dispatcherRunJournalLoaded = false;
    this.dispatcherRunJournalRoot = null;
  }

  private hasActiveDispatcherLeases(): boolean {
    return Object.values(this.orchestrator.getState().dispatcherLeases).some(
      (lease) => lease.status === "active",
    );
  }

  private hasDispatcherRootOwnedWork(): boolean {
    return this.hasActiveDispatcherLeases() || this.workers.size > 0;
  }

  private rememberDispatcherRunJournalRoot(
    workspaceRoot: string,
    journal: DispatcherRunJournal,
  ): void {
    this.dispatcherRunJournalRoot = workspaceRoot;
    for (const entry of journal) {
      this.rememberDispatcherLeaseRoot(entry, workspaceRoot);
    }
  }

  private rememberDispatcherLeaseRoot(
    entry: DispatcherRunJournalEntry,
    workspaceRoot: string,
  ): void {
    if (entry.lease === null) {
      return;
    }
    this.dispatcherLeaseRoots.set(entry.lease.leaseId, workspaceRoot);
  }

  private getDispatcherRunJournalRootForEntry(
    entry: DispatcherRunJournalEntry,
  ): string {
    if (entry.lease !== null && entry.lease.status !== "active") {
      const leaseRoot = this.dispatcherLeaseRoots.get(entry.lease.leaseId);
      if (leaseRoot !== undefined) {
        return leaseRoot;
      }
    }

    return this.dispatcherRunJournalRoot ?? this.workspaceManager.root;
  }

  private async persistDispatcherRunJournalEntry(
    entry: DispatcherRunJournalEntry,
  ): Promise<void> {
    const workspaceRoot = this.getDispatcherRunJournalRootForEntry(entry);
    try {
      await this.writeDispatcherRunJournalEntry(workspaceRoot, entry);
      this.rememberDispatcherLeaseRoot(entry, workspaceRoot);
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
          workspace_root: workspaceRoot,
        },
      );
      throw error;
    }
  }

  private async refreshManagerRunJournalForSnapshot(): Promise<void> {
    if (this.managerRunJournalHydrationTask !== null) {
      await this.managerRunJournalHydrationTask;
      return;
    }

    const task = (async () => {
      try {
        const journal = await this.readManagerRunJournal(
          this.workspaceManager.root,
        );
        const state = this.orchestrator.getState();
        state.managerRunJournal = journal;
        state.managerRuns = reduceManagerRunJournal(journal, {
          now: this.now(),
        });
      } catch (error) {
        await this.logger?.warn(
          "manager_run_journal_hydration_failed",
          "Failed to hydrate manager run journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            workspace_root: this.workspaceManager.root,
          },
        );
        throw error;
      }
    })();
    this.managerRunJournalHydrationTask = task;
    try {
      await task;
    } finally {
      if (this.managerRunJournalHydrationTask === task) {
        this.managerRunJournalHydrationTask = null;
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

  private async findStoredLoopTraceByIssueKeyBestEffort(
    issueKey: string,
  ): Promise<StoredLoopTrace | null> {
    try {
      const storedTrace =
        (await findLoopTraceJournalByIssueIdentifier(
          this.workspaceManager.root,
          issueKey,
        )) ?? (await this.readStoredLoopTraceByIssueIdBestEffort(issueKey));
      if (storedTrace === null) {
        return null;
      }
      const issueEntry = findLatestTraceEntryForIssueKey(
        storedTrace.journal,
        issueKey,
      );
      if (issueEntry === null) {
        return null;
      }
      return {
        issueId: issueEntry.issueId,
        ...storedTrace,
      };
    } catch (error) {
      try {
        await this.logger?.warn(
          "loop_trace_hydration_failed",
          "Failed to hydrate stored loop trace journal.",
          {
            outcome: "degraded",
            reason: toErrorMessage(error),
            issue_identifier: issueKey,
            workspace_root: this.workspaceManager.root,
          },
        );
      } catch {
        // Trace hydration is best-effort; logging failure should not reject callers.
      }
      return null;
    }
  }

  private async readStoredLoopTraceByIssueIdBestEffort(
    issueId: string,
  ): Promise<{ artifactPath: string; journal: LoopTraceJournal } | null> {
    const locator = this.getLoopTraceLocator(issueId);
    const journal = await this.readLoopTraceJournal(locator);
    if (!journal.some((entry) => entry.issueId === issueId)) {
      return null;
    }
    return {
      artifactPath: buildLoopTraceJournalResponse(journal, locator).path,
      journal,
    };
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
      event.event === "compaction" ||
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

  private async recordLoopTraceForContinuousFeedback(
    event: AgentRunnerEvent,
    result: ContinuousFeedbackCheckpointResult,
  ): Promise<void> {
    if (!result.ran) {
      return;
    }
    const stage =
      this.orchestrator.getState().issueStages[event.issueId] ?? null;
    await this.appendLoopTraceEntries(event.issueId, [
      {
        timestamp: event.timestamp,
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        stage,
        attempt: event.attempt,
        sessionId: event.sessionId ?? null,
        kind: "continuous_feedback",
        summary: summarizeContinuousFeedbackLoopTrace(result),
        continuousFeedback: {
          event: result.event,
          status:
            result.status === "unavailable"
              ? "unavailable"
              : result.status === "finding"
                ? "finding"
                : "pass",
          unavailableSummary:
            result.status === "unavailable" ? result.summary : null,
          reviewerRunner: result.reviewerLane?.runner ?? "unknown",
          reviewerModel: result.reviewerLane?.model ?? null,
          findingSignatures: result.findingSignatures,
        },
      },
    ]);
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
    const ignoredFiles = [
      ...new Set(
        input.findings.flatMap((finding) => finding.ignoredFiles ?? []),
      ),
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
        ignored_files: ignoredFiles,
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
    const restartSafety = await this.getPipelineRestartSafety();
    const emergencyStop = this.getEmergencyStopStatus();
    const localPause = this.getPipelineLocalPauseStatus();

    if (!(this.tracker instanceof LinearTrackerClient)) {
      return {
        paused: localPause !== null,
        issues: [],
        halt_view: { status: "unsupported" },
        local_pause: localPause,
        restart_safety: restartSafety,
        emergency_stop: emergencyStop,
      };
    }

    const tracker = this.tracker as LinearTrackerClient;
    if (tracker.fetchOpenIssuesByLabels === undefined) {
      return {
        paused: localPause !== null,
        issues: [],
        halt_view: { status: "unsupported" },
        local_pause: localPause,
        restart_safety: restartSafety,
        emergency_stop: emergencyStop,
      };
    }

    let haltIssues: Issue[];
    try {
      haltIssues = await tracker.fetchOpenIssuesByLabels(
        [PIPELINE_HALT_LABEL],
        ["Done", "Cancelled"],
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        paused: localPause !== null,
        issues: [],
        halt_view: { status: "unknown", error_message: message },
        local_pause: localPause,
        degraded: [
          {
            code: "pipeline_halt_view_unavailable",
            message: `Pipeline halt view is unreadable: ${message}`,
          },
        ],
        restart_safety: restartSafety,
        emergency_stop: emergencyStop,
      };
    }

    return {
      paused: haltIssues.length > 0 || localPause !== null,
      issues: haltIssues.map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
      })),
      halt_view: { status: "known" },
      local_pause: localPause,
      restart_safety: restartSafety,
      emergency_stop: emergencyStop,
    };
  }

  private getPipelineLocalPauseStatus(): Exclude<
    PipelineStatusResponse["local_pause"],
    undefined
  > {
    const localPause = this.orchestrator.getState().pipelinePause;
    if (localPause === null) {
      return null;
    }
    return {
      active: true,
      since: localPause.since,
      reason: localPause.reason,
      actor: localPause.actor,
      set_by_sequence: localPause.setBySequence,
      halt_view: {
        status: localPause.haltView.status,
        issue_identifier: localPause.haltView.issueIdentifier,
        issue_title: localPause.haltView.issueTitle,
        error_message: localPause.haltView.errorMessage,
      },
    };
  }

  private getEmergencyStopStatus(): EmergencyStopStateResponse | null {
    const emergencyStop = this.orchestrator.getState().emergencyStop;
    if (emergencyStop === null) {
      return null;
    }
    return {
      active: true,
      since: emergencyStop.since,
      reason: emergencyStop.reason,
      set_by_sequence: emergencyStop.setBySequence,
      interrupted_issues: emergencyStop.interruptedIssues.map((issue) =>
        projectEmergencyStopInterruptedIssue(
          issue,
          this.orchestrator.getState(),
        ),
      ),
    };
  }

  /**
   * Thin transport adapter for POST /api/v1/intents (SYMPH-408b): resolve
   * the issue, then route the orchestrator's writeIntent primitive. No verb
   * semantics live here — idempotency, fencing, attribution, and replay are
   * all writeIntent's.
   */
  async requestIntent(input: IntentRequest): Promise<IntentRequestResult> {
    await this.ensureDispatcherRunJournalLoaded();

    // Queue Triage v2 plan-control verbs (SYMPH-789) are plan/batch-scoped, not
    // issue-scoped: handle them via the standing-plan store and skip the
    // issue-resolution + writeIntent path entirely.
    if (isPlanControlVerb(input.verb)) {
      return this.handlePlanControlIntent(input.verb, input);
    }

    // The pipeline sentinel is a reserved journal scope, never an
    // addressable issue. The HTTP schema rejects it too; this check covers
    // direct callers of requestIntent (defense in depth).
    if (
      isPipelineSentinelValue(input.issueId) ||
      isPipelineSentinelValue(input.issueIdentifier)
    ) {
      return {
        status: "invalid_request",
        detail:
          "The pipeline sentinel is not an addressable issue; use the pipeline pause/resume endpoints.",
        sequence: null,
        verb: input.verb,
        issue_id: input.issueId ?? null,
        issue_identifier: input.issueIdentifier ?? null,
      };
    }

    const resolved = await this.resolveIntentIssue(input);
    if (resolved.outcome === "mismatch") {
      return {
        status: "invalid_request",
        detail: `issueIdentifier '${input.issueIdentifier ?? ""}' does not match the known identifier '${resolved.knownIdentifier}' for issue id '${input.issueId ?? ""}'.`,
        sequence: null,
        verb: input.verb,
        issue_id: input.issueId ?? null,
        issue_identifier: input.issueIdentifier ?? null,
      };
    }
    if (resolved.outcome === "not_found") {
      return {
        status: "issue_not_found",
        detail: `Issue '${input.issueIdentifier ?? input.issueId ?? ""}' could not be resolved from runtime state or the tracker's active states.`,
        sequence: null,
        verb: input.verb,
        issue_id: input.issueId ?? null,
        issue_identifier: input.issueIdentifier ?? null,
      };
    }

    const reason: IntentReason = {
      class: `api:${input.verb}`,
      human: input.reason,
    };
    const result = await this.orchestrator.writeIntent({
      verb: input.verb,
      issueId: resolved.issueId,
      issueIdentifier: resolved.issueIdentifier,
      actor: input.actor,
      reason,
      ...(input.fence === undefined ? {} : { fence: input.fence }),
      ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    });

    return {
      status: result.status,
      detail: result.detail,
      sequence: result.sequence,
      verb: input.verb,
      issue_id: resolved.issueId,
      issue_identifier: resolved.issueIdentifier,
    };
  }

  /**
   * Handle a Queue Triage v2 plan-control intent (SYMPH-789): record the
   * operator action as a revision-bound PlanDecision in the standing-plan store.
   * The actor is the authenticated operator (the dashboard/symphonyctl surface
   * is operator-gated; the agent identity cannot reach here — the doc-comment
   * path in PR3 enforces the allowlist for that channel). modify_plan also
   * requests a re-plan on the next heartbeat.
   */
  private async handlePlanControlIntent(
    verb: PlanControlVerb,
    input: IntentRequest,
  ): Promise<IntentRequestResult> {
    // Defense-in-depth (no ambient control surfaces): a high-consequence plan
    // control signal must bind an operator actor. The dashboard route is
    // already operator-authenticated, but gate the host method too so a direct
    // caller (or a future non-dashboard surface) cannot self-approve with a
    // watchdog/agent actor (council R1, Codex P2).
    if (input.actor.kind !== "operator") {
      return {
        status: "invalid_request",
        detail: `plan-control intents require an operator actor (got ${input.actor.kind}).`,
        sequence: null,
        verb,
        issue_id: null,
        issue_identifier: null,
      };
    }
    const batch = input.batch;
    if (batch === undefined) {
      return {
        status: "invalid_request",
        detail:
          "plan-control intents require a batch payload with the plan revision.",
        sequence: null,
        verb,
        issue_id: null,
        issue_identifier: null,
      };
    }
    if (
      (verb === "release_batch" || verb === "hold") &&
      batch.batchId === undefined
    ) {
      return {
        status: "invalid_request",
        detail: `${verb} requires batch.batchId.`,
        sequence: null,
        verb,
        issue_id: null,
        issue_identifier: null,
      };
    }

    const kind =
      verb === "release_batch"
        ? "approve"
        : verb === "hold"
          ? "hold"
          : "modify";
    const actorLabel = `${input.actor.kind}@${input.actor.host}${input.actor.session ? `#${input.actor.session}` : ""}`;
    const decisionId = `${verb}:${batch.batchId ?? "plan"}:rev${batch.revision}:${actorLabel}`;
    const result = await recordPlanControlDecision(this.workspaceManager.root, {
      kind,
      revision: batch.revision,
      batchId: batch.batchId ?? null,
      actor: actorLabel,
      // `reason` is a user-controlled HTTP field; fence prompt-boundary tags
      // before it enters the durable journal, exactly as the doc-comment ingest
      // path does — keep PlanDecision.note fenced on BOTH paths so a future
      // consumer can never read a raw-text injection (council R2, Pi P2).
      note: fenceJudgeBoundaryTags(input.reason),
      decisionId,
      createdAt: this.now().toISOString(),
    });

    // modify_plan asks the Manager to re-plan on the next heartbeat.
    if (verb === "modify_plan" && result.recorded) {
      this.requestStandingPlanReplan();
    }

    const status: IntentRequestResult["status"] =
      result.reason === "no_plan"
        ? "no_plan"
        : result.reason === "stale_revision"
          ? "rejected_stale"
          : result.reason === "batch_not_found"
            ? "invalid_request"
            : result.recorded
              ? "applied"
              : "no_op";
    return {
      status,
      detail:
        result.reason === "no_plan"
          ? "No standing plan exists yet."
          : result.reason === "stale_revision"
            ? `Revision ${batch.revision} is superseded; the action is void.`
            : result.reason === "batch_not_found"
              ? `Batch ${batch.batchId ?? ""} is not in revision ${batch.revision}.`
              : result.recorded
                ? `${verb} recorded against revision ${batch.revision}.`
                : `${verb} already recorded (idempotent).`,
      sequence: null,
      verb,
      issue_id: null,
      issue_identifier: null,
    };
  }

  /**
   * Control-surface tick (SYMPH-790/791): render+publish the living "🚦Ticket
   * Triage Controls" doc and ingest operator comments as revision-bound
   * plan-control decisions. Best-effort + gated (controlDoc.enabled + a team id);
   * the live document API is verified at deploy (shadow). Delegates to the
   * tested orchestration in standing-plan-control-surface.
   */
  async runControlSurfaceTick(): Promise<void> {
    const cfg = this.config.queueTriage;
    if (
      cfg === undefined ||
      !cfg.enabled ||
      !cfg.controlDoc.enabled ||
      cfg.controlDoc.teamId === null
    ) {
      return;
    }
    const apiKey = this.config.tracker.apiKey;
    if (apiKey === null) {
      return;
    }
    if (this.controlSurfaceInFlight) {
      return; // serialize: never two concurrent first-publishes (Codex P3)
    }
    this.controlSurfaceInFlight = true;
    const root = this.workspaceManager.root;
    try {
      const plan = await loadStandingPlan(root);
      if (plan === null) {
        return;
      }
      const docDeps = {
        endpoint: this.config.tracker.endpoint,
        apiKey,
        fetchFn: globalThis.fetch,
      };
      const inFlight = Object.values(this.orchestrator.getState().running).map(
        (entry) => ({
          issueIdentifier: entry.issue.identifier,
          stage: entry.issue.state,
        }),
      );
      // Read the journal once for both the "Recently shipped" rollup (merged
      // outcomes, SYMPH-803) and the revision changelog.
      const controlDocJournal = await readStandingPlanJournal(root);
      const published = await publishControlDoc({
        plan,
        context: {
          recentlyShipped: computeRecentlyShipped(controlDocJournal, 10),
          inFlight,
          changelog:
            this.buildControlDocChangelogFromJournal(controlDocJournal),
        },
        teamId: cfg.controlDoc.teamId,
        docClient: {
          create: (input) => createLinearDocument(docDeps, input),
          update: (input) => updateLinearDocument(docDeps, input),
        },
        loadDocRef: () => this.loadControlDocRef(root),
        saveDocRef: (ref) => this.saveControlDocRef(root, ref),
        lastPublishedContentHash: await this.loadControlDocLastHash(root),
        notify: (url) =>
          this.notifier?.notify({
            type: "info_alert",
            issueIdentifier: "PLAN",
            message: "🚦 Ticket Triage Controls updated",
            linkUrl: url,
            linkLabel: "open",
          }),
        log: (event, message, fields) => {
          void this.logger?.info(event, message, fields);
        },
      });
      // Persist the content hash only when we actually published, so the next
      // tick can throttle an unchanged re-render (SYMPH-820).
      if (published.action !== "unchanged") {
        await this.saveControlDocLastHash(root, published.contentHash);
      }
      const operatorAllowlist = new Set(
        (this.config.operatorAnchors?.operatorAllowlist ?? []).map((email) =>
          email.trim().toLowerCase(),
        ),
      );
      await ingestControlDocComments({
        documentId: published.ref.id,
        plan,
        operatorAllowlist,
        docClient: {
          fetchComments: (input) => fetchLinearDocumentComments(docDeps, input),
        },
        fence: (text) => fenceJudgeBoundaryTags(text),
        recordDecision: (input) => recordPlanControlDecision(root, input),
        requestReplan: () => this.requestStandingPlanReplan(),
        log: (event, message, fields) => {
          void this.logger?.info(event, message, fields);
        },
        seen: this.controlDocSeen,
        now: this.now,
      });
    } catch (error) {
      await this.logger?.warn(
        "queue_triage_control_surface_failed",
        "Control-surface tick failed (best-effort; dispatch unaffected).",
        { outcome: "degraded", detail: toErrorMessage(error) },
      );
    } finally {
      this.controlSurfaceInFlight = false;
    }
  }

  private controlDocRefPath(root: string): string {
    return join(root, ".symphony", "standing-plan-doc.json");
  }

  private async loadControlDocRef(
    root: string,
  ): Promise<LinearDocumentRef | null> {
    try {
      const parsed = JSON.parse(
        await readFile(this.controlDocRefPath(root), "utf8"),
      ) as Partial<LinearDocumentRef>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.slugId === "string" &&
        typeof parsed.url === "string"
      ) {
        return { id: parsed.id, slugId: parsed.slugId, url: parsed.url };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async saveControlDocRef(
    root: string,
    ref: LinearDocumentRef,
  ): Promise<void> {
    await mkdir(join(root, ".symphony"), { recursive: true });
    // Atomic write (temp + rename): a crash mid-write must not truncate the
    // ref and orphan the living doc on the next load (council R1, Pi P1).
    const path = this.controlDocRefPath(root);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(ref)}\n`, "utf8");
    await rename(tmp, path);
  }

  private controlDocHashPath(root: string): string {
    return join(root, ".symphony", "standing-plan-doc.hash");
  }

  private async loadControlDocLastHash(root: string): Promise<string | null> {
    try {
      const hash = (
        await readFile(this.controlDocHashPath(root), "utf8")
      ).trim();
      return hash === "" ? null : hash;
    } catch {
      return null;
    }
  }

  private async saveControlDocLastHash(
    root: string,
    contentHash: string,
  ): Promise<void> {
    await mkdir(join(root, ".symphony"), { recursive: true });
    // Atomic write (temp + rename), mirroring saveControlDocRef.
    const path = this.controlDocHashPath(root);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${contentHash}\n`, "utf8");
    await rename(tmp, path);
  }

  private buildControlDocChangelogFromJournal(
    journal: Awaited<ReturnType<typeof readStandingPlanJournal>>,
  ): Array<{ revision: number; createdAt: string; rationale: string }> {
    return journal
      .filter((entry) => entry.kind === "plan_revision")
      .map(
        (entry) =>
          (
            entry as {
              revision: {
                revision: number;
                createdAt: string;
                rationale: string;
              };
            }
          ).revision,
      )
      .slice(-5)
      .reverse()
      .map((revision) => ({
        revision: revision.revision,
        createdAt: revision.createdAt,
        rationale: revision.rationale,
      }));
  }

  /** Request a standing-plan re-plan on the next heartbeat (SYMPH-787/789). */
  requestStandingPlanReplan(): void {
    this.standingPlanReplanRequested = true;
  }

  /** Consume the re-plan request flag (check-and-reset). */
  consumeStandingPlanReplanRequest(): boolean {
    const requested = this.standingPlanReplanRequested;
    this.standingPlanReplanRequested = false;
    return requested;
  }

  /**
   * Queue Triage v2 consumer (SYMPH-787/789) — the dispatch-hot-path hook. ZERO
   * model calls: it reads the persisted plan, runs the deterministic
   * predicates, and selects the releasable batch members. Degrades to the
   * comparator unless the feature is enabled, NOT in shadow mode, and a fresh,
   * aligned plan exists. A tripped re-plan predicate degrades this tick and
   * requests a re-plan on the next heartbeat (no stalling on a stale plan).
   */
  private async computePlanDrivenDispatch(
    input: PlanDrivenDispatchInput,
  ): Promise<PlanDrivenDispatchDecision> {
    const cfg = this.config.queueTriage;
    if (cfg === undefined || !cfg.enabled || cfg.shadowMode) {
      return { mode: "degrade" };
    }
    // The store reads are disk-only (no model call), but a disk/journal error
    // must DEGRADE to the comparator — never propagate and crash the poll
    // (council R1, Pi P1). Safety never depends on the standing-plan store.
    try {
      const root = this.workspaceManager.root;
      const plan = await loadStandingPlan(root);
      const honoredApprovals =
        plan === null ? [] : await listHonoredDecisions(root);
      // SYMPH-801 re-plan predicate inputs: candidate priority bands (Linear
      // priority, with "no priority" sorted last) and how many merges landed
      // since the plan was computed. Only assembled when a plan exists — with no
      // plan the decision degrades immediately and never reads them (council R1,
      // Pi P3).
      const candidatePriorityBands =
        plan === null
          ? new Map<string, number>()
          : new Map<string, number>(
              input.candidates.map((candidate) => [
                candidate.identifier,
                // Linear: 1=urgent…4=low; 0/none → least urgent (band 5).
                candidate.priority === null || candidate.priority === 0
                  ? 5
                  : candidate.priority,
              ]),
            );
      const mergedOutcomes =
        plan === null
          ? { sinceCount: 0, identifiers: new Set<string>() }
          : await this.collectMergedOutcomes(root, plan.createdAt);
      const decision = decidePlanDrivenDispatch({
        config: cfg,
        plan,
        honoredApprovals,
        candidateIdentifiers: new Set(
          input.candidates.map((candidate) => candidate.identifier),
        ),
        runningIssueIdentifiers: input.runningIssueIdentifiers,
        nowMs: this.now().getTime(),
        // Team-scoped candidate source ⇒ the plan path releases only
        // operator-approved batches, never the posture-B auto-release frontier
        // (SYMPH-794: the team backlog must never dispatch without an explicit go).
        teamScoped: (this.config.tracker.teamKeys ?? []).length > 0,
        candidatePriorityBands,
        mergedSincePlanCount: mergedOutcomes.sinceCount,
        mergedIssueIdentifiers: mergedOutcomes.identifiers,
      });
      if (decision.forceReplan) {
        this.requestStandingPlanReplan();
      }
      return decision.action === "plan"
        ? {
            mode: "plan",
            orderedIssueIdentifiers: decision.orderedIssueIdentifiers,
          }
        : { mode: "degrade" };
    } catch (error) {
      await this.logger?.warn(
        "queue_triage_consumer_degraded",
        "Standing-plan consumer failed; falling back to the comparator.",
        { outcome: "degraded", detail: toErrorMessage(error) },
      );
      return { mode: "degrade" };
    }
  }

  /**
   * No-ambient-control-surfaces admission guardrail (SYMPH-794). Returns the
   * issue identifiers an operator has EXPLICITLY admitted — the members of
   * current-revision batches carrying an honored `approve` decision — or null
   * when the guardrail is disabled (inert; zero-diff). The store reads are
   * disk-only (no model call); on a read error this fails CLOSED (returns an
   * empty set → the dispatch loop holds everything this tick) rather than
   * falling open to bare-project dispatch.
   */
  private async computeAdmittedIdentifiers(): Promise<ReadonlySet<string> | null> {
    const cfg = this.config.queueTriage;
    const root = this.workspaceManager.root;
    // The admitted-set gate is MANDATORY whenever the candidate source is
    // team-scoped (SYMPH-794): the eligible backlog must never dispatch raw, so
    // a bare team-scoped candidate is held until an explicit operator go —
    // independent of the admission_guardrail opt-in, which still arms the gate
    // for a legacy project-scoped pool. Fail-closed on any store-read error.
    return resolveAdmittedIdentifiersForTick({
      teamScoped: (this.config.tracker.teamKeys ?? []).length > 0,
      admissionGuardrailEnabled: cfg?.admissionGuardrail.enabled === true,
      // ONE journal read per tick — the helper projects the plan AND the honored
      // decisions from the same snapshot (SYMPH-823), closing the TOCTOU where a
      // re-plan between two reads paired plan revision N with decisions honored
      // against N+1.
      readJournal: () => readStandingPlanJournal(root),
      onError: async (error) => {
        // Awaited inside the helper so the degrade diagnostic flushes before the
        // empty-set (fail-closed) return; the helper swallows any logger error.
        await this.logger?.warn(
          "queue_triage_admission_degraded",
          "Admission gate store read failed; failing closed (no admissions this tick).",
          { outcome: "degraded", detail: toErrorMessage(error) },
        );
      },
    });
  }

  /**
   * Persist a planned issue's terminal pipeline result as a batch outcome
   * (SYMPH-803) — the calibration substrate. Gated on queueTriage.enabled (no
   * point recording when the Manager is off; records in shadow too, so a shadow
   * window accrues real recommendation→outcome data). The disk read/write is
   * best-effort: a failure is logged and swallowed so it can never disturb the
   * worker-exit notification path.
   */
  private async recordTerminalBatchOutcome(
    issueIdentifier: string,
    result: TerminalOutcomeResult,
  ): Promise<void> {
    const cfg = this.config.queueTriage;
    if (cfg === undefined || !cfg.enabled) {
      return;
    }
    try {
      const root = this.workspaceManager.root;
      // Attribution is against the CURRENT plan at exit time. If a re-plan moved
      // this issue to a different batch (or dropped it) between dispatch and
      // exit, the outcome attaches to its current batch (a true fact) or is
      // skipped — it is never attributed to a batch the issue isn't in. Durable
      // dispatch-time attribution (so the outcome always joins the dispatching
      // revision's decision) is a tracked follow-up (SYMPH-813); it only affects
      // calibration accuracy on the plan-driven path (Stage 3+), not shadow.
      const outcome = resolveBatchOutcome({
        plan: await loadStandingPlan(root),
        issueIdentifier,
        result,
        createdAt: this.now().toISOString(),
      });
      if (outcome === null) {
        return; // no plan, or a bare/comparator issue — nothing to attribute
      }
      await recordBatchOutcome(root, outcome);
    } catch (error) {
      await this.logger?.warn(
        "queue_triage_outcome_record_failed",
        "Failed to record a batch outcome; calibration may miss this result.",
        { outcome: "degraded", detail: toErrorMessage(error) },
      );
    }
  }

  /**
   * Merged-outcome facts for the consumer's plan-driven decision (one journal
   * pass): how many issues merged since `sinceIso` (the merge-moved-the-world
   * re-plan predicate, SYMPH-801) and the set of ALL merged issue identifiers
   * (canary contingent-release + merged-exclusion, SYMPH-800). Only called on the
   * plan-driven path (not shadow), so the read is off the shadow hot path.
   */
  private async collectMergedOutcomes(
    root: string,
    sinceIso: string,
  ): Promise<{ sinceCount: number; identifiers: Set<string> }> {
    const sinceMs = Date.parse(sinceIso);
    const journal = await readStandingPlanJournal(root);
    let sinceCount = 0;
    const identifiers = new Set<string>();
    for (const entry of journal) {
      if (entry.kind !== "plan_outcome" || entry.outcome.result !== "merged") {
        continue;
      }
      for (const identifier of entry.outcome.issueIdentifiers) {
        identifiers.add(identifier);
      }
      const outcomeMs = Date.parse(entry.outcome.createdAt);
      if (
        !Number.isNaN(sinceMs) &&
        !Number.isNaN(outcomeMs) &&
        outcomeMs > sinceMs
      ) {
        sinceCount += 1;
      }
    }
    return { sinceCount, identifiers };
  }

  async requestAnchorFieldEdit(
    input: AnchorFieldEditRequest,
  ): Promise<AnchorFieldEditResult> {
    await this.ensureDispatcherRunJournalLoaded();

    const resolved = await this.resolveIntentIssue({
      verb: "anchor",
      ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
      ...(input.issueIdentifier === undefined
        ? {}
        : { issueIdentifier: input.issueIdentifier }),
      reason: `Linear field edit for ${input.fieldName}`,
      actor: { kind: "operator", host: input.editorEmail },
    });
    if (resolved.outcome === "mismatch") {
      return {
        status: "invalid_request",
        detail: `issueIdentifier '${input.issueIdentifier ?? ""}' does not match the known identifier '${resolved.knownIdentifier}' for issue id '${input.issueId ?? ""}'.`,
        sequence: null,
        issue_id: input.issueId ?? null,
        issue_identifier: input.issueIdentifier ?? null,
      };
    }
    if (resolved.outcome === "not_found") {
      return {
        status: "issue_not_found",
        detail: `Issue '${input.issueIdentifier ?? input.issueId ?? ""}' could not be resolved from runtime state or the tracker's active states.`,
        sequence: null,
        issue_id: input.issueId ?? null,
        issue_identifier: input.issueIdentifier ?? null,
      };
    }

    const result = await this.orchestrator.ingestAnchorFieldEdit({
      issueId: resolved.issueId,
      issueIdentifier: resolved.issueIdentifier,
      fieldName: input.fieldName,
      value: input.value,
      editorEmail: input.editorEmail,
      editedAt: input.editedAt,
    });
    return {
      status: result.status,
      detail: result.detail,
      sequence: result.sequence,
      issue_id: resolved.issueId,
      issue_identifier: resolved.issueIdentifier,
    };
  }

  async requestDispatchFence(
    input: DispatchFenceRequest & { actor: IntentActor },
  ): Promise<DispatchFenceResponse> {
    await this.ensureDispatcherRunJournalLoaded();
    return await this.orchestrator.setDispatchFence({
      issueIdentifiers: input.issue_identifiers,
      source: input.source ?? "api",
      actor: input.actor,
      reason: {
        class: "operator_dispatch_fence",
        human: input.reason ?? "dispatch fence requested",
      },
    });
  }

  async requestDispatchFenceClear(
    context: PipelineControlContext,
  ): Promise<DispatchFenceResponse> {
    await this.ensureDispatcherRunJournalLoaded();
    return await this.orchestrator.clearDispatchFence({
      actor: context.actor,
      reason: {
        class: "operator_dispatch_unfence",
        human: context.reason,
      },
    });
  }

  /**
   * Resolve an intent target to an issue id: explicit id wins, then the
   * in-memory running/retry lanes, then a tracker lookup across the
   * configured active states (covers parked issues that hold no lane).
   *
   * When BOTH issueId and issueIdentifier are supplied, the body's
   * identifier is not trusted blindly: if the running/retry lanes or the
   * tracker know the real identifier for that id, a mismatching pair is
   * rejected ("mismatch" → 400 at the HTTP boundary) and a matching pair
   * uses the authoritative identifier. If no source knows the id, the pair
   * is accepted as supplied (the journal records what the caller asserted;
   * we cannot verify what nothing knows).
   */
  private async resolveIntentIssue(
    input: IntentRequest,
  ): Promise<
    | { outcome: "resolved"; issueId: string; issueIdentifier: string }
    | { outcome: "not_found" }
    | { outcome: "mismatch"; knownIdentifier: string }
  > {
    if (input.issueId !== undefined) {
      const issueId = input.issueId;
      // Verification (lanes + tracker) only runs when the caller asserted
      // an identifier alongside the id; id-only requests stay a free path.
      const knownIdentifier =
        input.issueIdentifier === undefined
          ? null
          : await this.lookupKnownIssueIdentifier(issueId);
      if (
        input.issueIdentifier !== undefined &&
        knownIdentifier !== null &&
        knownIdentifier !== input.issueIdentifier
      ) {
        return { outcome: "mismatch", knownIdentifier };
      }
      return {
        outcome: "resolved",
        issueId,
        issueIdentifier:
          knownIdentifier ?? input.issueIdentifier ?? input.issueId,
      };
    }

    const identifier = input.issueIdentifier;
    if (identifier === undefined) {
      return { outcome: "not_found" };
    }

    const state = this.orchestrator.getState();
    const running = Object.values(state.running).find(
      (entry) => entry.identifier === identifier,
    );
    if (running !== undefined) {
      return {
        outcome: "resolved",
        issueId: running.issue.id,
        issueIdentifier: identifier,
      };
    }

    const retry = Object.values(state.retryAttempts).find(
      (entry) => entry.identifier === identifier,
    );
    if (retry !== undefined) {
      return {
        outcome: "resolved",
        issueId: retry.issueId,
        issueIdentifier: identifier,
      };
    }

    try {
      const issues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.activeStates,
      );
      const match = issues.find((issue) => issue.identifier === identifier);
      if (match !== undefined) {
        return {
          outcome: "resolved",
          issueId: match.id,
          issueIdentifier: identifier,
        };
      }
    } catch (error) {
      // Tracker lookup is best-effort; fall through to not-found — but the
      // swallowed error must stay visible for diagnosis.
      console.warn(
        `[runtime-host] intent issue resolution tracker lookup failed for '${identifier}': ${toErrorMessage(error)}`,
      );
    }

    return { outcome: "not_found" };
  }

  /**
   * Best-effort authoritative identifier for an issue id: in-memory
   * running/retry lanes first (free), then the tracker's active states.
   * Returns null when no source knows the id.
   */
  private async lookupKnownIssueIdentifier(
    issueId: string,
  ): Promise<string | null> {
    const state = this.orchestrator.getState();
    const running = Object.values(state.running).find(
      (entry) => entry.issue.id === issueId,
    );
    if (running !== undefined) {
      return running.identifier;
    }

    const retry = Object.values(state.retryAttempts).find(
      (entry) => entry.issueId === issueId,
    );
    if (retry !== undefined) {
      return retry.identifier;
    }

    try {
      const issues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.activeStates,
      );
      const match = issues.find((issue) => issue.id === issueId);
      if (match !== undefined) {
        return match.identifier;
      }
    } catch (error) {
      console.warn(
        `[runtime-host] intent identifier verification tracker lookup failed for id '${issueId}': ${toErrorMessage(error)}`,
      );
    }

    return null;
  }

  /** Actor recorded when a pipeline control request carries no attribution. */
  private defaultPipelineControlActor(): IntentActor {
    const label = hostname().split(".")[0];
    return {
      kind: "operator",
      host: label === undefined || label === "" ? hostname() : label,
    };
  }

  /**
   * Journal a pipeline intent entry and surface a journal-write failure as
   * a warn-only degraded mode. Used AFTER the Linear view mutation: the
   * view is already mutated, so a lost audit entry cannot abort it — it is
   * the documented degraded mode (SYMPH-408 council R1).
   */
  private async journalPipelineIntentDegradedOk(input: {
    action: "pause" | "resume";
    status: "applied" | "no_op";
    actor: IntentActor;
    reason: IntentReason;
    detail: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const sequence = await this.orchestrator.journalPipelineIntent(input);
    if (sequence === null) {
      console.warn(
        `[runtime-host] pipeline ${input.action} ${input.status} but the intent journal write failed; view state stands, audit entry lost (degraded mode)`,
      );
    }
  }

  /**
   * Pipeline pause/resume transaction contract (SYMPH-408 council R1):
   *
   * 1. Feasibility is determined BEFORE any mutation: an already-satisfied
   *    request or a tracker that cannot apply the view journals a `no_op`
   *    naming why, and the view is never touched.
   * 2. The Linear view mutation runs next. If it throws, NOTHING is
   *    journaled as `applied` — the error propagates to the caller and the
   *    journal never claims an outcome that did not happen.
   * 3. `applied` is journaled only AFTER the mutation succeeded. A failed
   *    journal write at that point is warn-only degraded mode (the view is
   *    already mutated; a lost audit entry is the documented degradation,
   *    see journalPipelineIntentDegradedOk).
   */
  async requestPipelinePause(
    context?: PipelineControlContext,
  ): Promise<PipelineStatusResponse> {
    return await this.enqueue(async () => {
      return await this.requestPipelinePauseUnqueued(context);
    });
  }

  private async requestPipelinePauseUnqueued(
    context?: PipelineControlContext,
  ): Promise<PipelineStatusResponse> {
    await this.ensureDispatcherRunJournalLoaded();
    const actor = context?.actor ?? this.defaultPipelineControlActor();
    const reason: IntentReason = {
      class: "operator_pipeline_pause",
      human: context?.reason ?? "pipeline pause requested",
    };

    // Check for existing halt issues first (idempotent pause).
    const status = await this.getPipelineStatus();
    if (status.paused) {
      await this.journalPipelineIntentDegradedOk({
        action: "pause",
        status: "no_op",
        actor,
        reason,
        detail: "pipeline already paused; halt issue view unchanged",
      });
      return status;
    }

    // Feasibility: the pause view requires a Linear tracker that can
    // create halt issues. Infeasible requests journal a no_op naming why —
    // never "applied" for a mutation that cannot run.
    const tracker =
      this.tracker instanceof LinearTrackerClient
        ? (this.tracker as LinearTrackerClient)
        : null;
    if (tracker === null || tracker.createIssue === undefined) {
      await this.journalPipelineIntentDegradedOk({
        action: "pause",
        status: "no_op",
        actor,
        reason,
        detail:
          "pipeline pause infeasible: tracker cannot create halt issues; view unchanged",
      });
      return status;
    }

    // TODO(SYMPH-221): resolve teamId, projectId, and haltLabelId from the tracker's
    // configured project context once those fields are available on ResolvedWorkflowConfig.
    const trackerConfig = this.config.tracker;
    const teamId = trackerConfig.teamId ?? "";
    const projectId = trackerConfig.projectId ?? "";
    const haltLabelId = trackerConfig.haltLabelId ?? "";

    const haltViewWasUnknown = status.halt_view?.status === "unknown";
    let created: { identifier: string; title: string } | null = null;
    let haltIssueCreateError: string | null = null;
    try {
      created = await tracker.createIssue({
        teamId,
        title: "Pipeline Halt",
        projectId,
        labelIds: [haltLabelId],
      });
    } catch (error) {
      if (!haltViewWasUnknown) {
        throw error;
      }
      haltIssueCreateError = toErrorMessage(error);
    }

    const haltViewError = [
      status.halt_view?.error_message,
      haltIssueCreateError === null
        ? null
        : `halt issue creation failed: ${haltIssueCreateError}`,
    ]
      .filter((part): part is string => part !== null && part !== undefined)
      .join("; ");
    const haltViewMetadata = {
      status: haltViewWasUnknown ? "uncertain" : "created",
      issue_identifier: created?.identifier ?? null,
      issue_title: created?.title ?? null,
      error_message: haltViewError === "" ? null : haltViewError,
    };

    await this.journalPipelineIntentDegradedOk({
      action: "pause",
      status: "applied",
      actor,
      reason,
      detail:
        created === null
          ? "pipeline pause applied via runtime-local gate; halt issue view uncertain"
          : haltViewWasUnknown
            ? `pipeline pause applied via runtime-local gate; halt issue ${created.identifier} created but prior halt view is uncertain`
            : `pipeline pause applied; halt issue ${created.identifier} created`,
      metadata: {
        local_pause: true,
        halt_view: haltViewMetadata,
      },
    });

    return {
      paused: true,
      issues:
        created === null
          ? []
          : [{ identifier: created.identifier, title: created.title }],
      halt_view: haltViewWasUnknown
        ? {
            status: "unknown",
            ...(haltViewError === "" ? {} : { error_message: haltViewError }),
          }
        : { status: "known" },
      local_pause: this.getPipelineLocalPauseStatus(),
      ...(haltViewWasUnknown
        ? {
            degraded: [
              {
                code: "pipeline_pause_applied_halt_view_uncertain",
                message:
                  "Runtime-local pipeline pause is active, but the Linear halt view is uncertain.",
              },
            ],
          }
        : {}),
      ...(status.restart_safety !== undefined
        ? { restart_safety: status.restart_safety }
        : {}),
      emergency_stop: status.emergency_stop ?? null,
    };
  }

  /** See requestPipelinePause for the transaction ordering contract. */
  async requestPipelineResume(
    context?: PipelineControlContext,
  ): Promise<PipelineStatusResponse> {
    return await this.enqueue(async () => {
      return await this.requestPipelineResumeUnqueued(context);
    });
  }

  private async requestPipelineResumeUnqueued(
    context?: PipelineControlContext,
  ): Promise<PipelineStatusResponse> {
    await this.ensureDispatcherRunJournalLoaded();
    const actor = context?.actor ?? this.defaultPipelineControlActor();
    const reason: IntentReason = {
      class: "operator_pipeline_resume",
      human: context?.reason ?? "pipeline resume requested",
    };

    const priorStatus = await this.getPipelineStatus();
    const localPauseWasActive =
      this.orchestrator.getState().pipelinePause !== null;
    if (!priorStatus.paused) {
      if (this.orchestrator.getState().emergencyStop !== null) {
        await this.journalPipelineIntentDegradedOk({
          action: "resume",
          status: "applied",
          actor,
          reason,
          detail: "pipeline resume applied; emergency stop cleared",
        });
        return await this.getPipelineStatus();
      }
      if (priorStatus.halt_view?.status === "unknown") {
        throw new Error(
          `pipeline resume cannot verify halt issues while the halt view is unreadable: ${priorStatus.halt_view.error_message ?? "unknown error"}`,
        );
      }
      await this.journalPipelineIntentDegradedOk({
        action: "resume",
        status: "no_op",
        actor,
        reason,
        detail: "pipeline not paused; halt issue view unchanged",
      });
      return priorStatus;
    }

    // Feasibility: the resume view requires a Linear tracker that can
    // enumerate and cancel halt issues.
    const tracker =
      this.tracker instanceof LinearTrackerClient
        ? (this.tracker as LinearTrackerClient)
        : null;
    if (tracker === null || tracker.fetchOpenIssuesByLabels === undefined) {
      await this.journalPipelineIntentDegradedOk({
        action: "resume",
        status: "no_op",
        actor,
        reason,
        detail:
          "pipeline resume infeasible: tracker cannot cancel halt issues; view unchanged",
      });
      return priorStatus;
    }

    // View mutation. A throw propagates and journals nothing.
    const haltIssues = await tracker.fetchOpenIssuesByLabels(
      [PIPELINE_HALT_LABEL],
      ["Done", "Cancelled"],
    );

    if (haltIssues.length === 0) {
      if (localPauseWasActive) {
        await this.journalPipelineIntentDegradedOk({
          action: "resume",
          status: "applied",
          actor,
          reason,
          detail:
            "pipeline resume applied; runtime-local pause cleared and no halt issues found",
        });
        return await this.getPipelineStatus();
      }

      // Race guard: the pipeline read as paused above, but the halt issues were
      // resolved (or cancelled by another actor) between the two reads. Nothing
      // was mutated, so this must journal no_op — "applied" means ≥1 cancelled.
      await this.journalPipelineIntentDegradedOk({
        action: "resume",
        status: "no_op",
        actor,
        reason,
        detail: "no halt issues found; view unchanged",
      });
      const refreshed = await this.getPipelineStatus();
      return refreshed;
    }

    const teamKey = this.config.tracker.teamKey ?? "";
    for (const issue of haltIssues) {
      await tracker.updateIssueState(issue.id, "Cancelled", teamKey);
    }

    await this.journalPipelineIntentDegradedOk({
      action: "resume",
      status: "applied",
      actor,
      reason,
      detail: `pipeline resume applied; ${haltIssues.length} halt issue(s) cancelled`,
    });

    const status = await this.getPipelineStatus();
    return {
      paused: false,
      issues: [],
      ...(status.halt_view === undefined
        ? {}
        : { halt_view: status.halt_view }),
      local_pause: status.local_pause ?? null,
      ...(status.degraded === undefined ? {} : { degraded: status.degraded }),
      ...(status.restart_safety !== undefined
        ? { restart_safety: status.restart_safety }
        : {}),
      emergency_stop: status.emergency_stop ?? null,
    };
  }

  async requestEmergencyStop(
    context?: PipelineControlContext,
  ): Promise<EmergencyStopResponse> {
    const actor = context?.actor ?? this.defaultPipelineControlActor();
    return await this.enqueue(async () => {
      await this.ensureDispatcherRunJournalLoaded();
      const result = await this.orchestrator.requestEmergencyStop({
        actor,
        reason: {
          class: "operator_emergency_stop",
          human: context?.reason ?? "emergency stop requested",
        },
      });

      const response = {
        status: result.status,
        detail: result.detail,
        sequence: result.sequence,
        interrupted_issues: result.interruptedIssues.map((issue) =>
          projectEmergencyStopInterruptedIssue(
            issue,
            this.orchestrator.getState(),
          ),
        ),
        stop_requests: result.stopRequests.map((request) => ({
          issue_identifier: request.issueIdentifier,
          stopped: true,
          reason: request.reason,
        })),
      };

      try {
        await this.requestPipelinePauseUnqueued({
          actor,
          reason: "emergency stop asserted runtime halt condition",
        });
      } catch (error) {
        await this.logger?.warn(
          "emergency_stop_halt_view_failed",
          "Emergency stop applied, but asserting the pipeline-halt Linear view failed.",
          { error: toErrorMessage(error) },
        );
      }

      return response;
    });
  }

  private async getPipelineRestartSafety(): Promise<PipelineRestartSafetyResponse> {
    const state = this.orchestrator.getState();
    const runningLaneCount = Object.keys(state.running).length;
    const retryingLaneCount = Object.keys(state.retryAttempts).length;

    let activeIssues: Issue[] = [];
    let errorMessage: string | null = null;
    try {
      activeIssues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.activeStates,
      );
    } catch (error) {
      errorMessage = toErrorMessage(error);
    }

    const restartBlockingIssues = activeIssues
      .filter((issue) => !hasPipelineHaltLabel(issue))
      .map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state,
      }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier));

    if (errorMessage !== null) {
      return {
        restart_safe: false,
        reason: "queue_status_unavailable",
        running_lane_count: runningLaneCount,
        retrying_lane_count: retryingLaneCount,
        active_issue_count: 0,
        active_issues: [],
        guidance: PIPELINE_RESTART_GUIDANCE,
        error_message: errorMessage,
      };
    }

    const lanesActive = runningLaneCount > 0 || retryingLaneCount > 0;
    const queueActive = restartBlockingIssues.length > 0;

    return {
      restart_safe: !lanesActive && !queueActive,
      reason: getPipelineRestartSafetyReason(lanesActive, queueActive),
      running_lane_count: runningLaneCount,
      retrying_lane_count: retryingLaneCount,
      active_issue_count: restartBlockingIssues.length,
      active_issues: restartBlockingIssues,
      guidance: PIPELINE_RESTART_GUIDANCE,
    };
  }

  abortAllWorkers(): number {
    const count = this.workers.size;
    for (const worker of this.workers.values()) {
      worker.controller.abort(SERVICE_SHUTDOWN_ABORT_REASON);
    }
    return count;
  }

  private async fetchMergeActuatorLiveState(
    candidate: MergeCandidateRecord,
  ): Promise<MergeActuatorLiveState | null> {
    const output = await this.runGh([
      "pr",
      "view",
      String(candidate.prNumber),
      "--repo",
      candidate.repo,
      "--json",
      "url,state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefOid,baseRefName,statusCheckRollup,mergedAt,mergeCommit",
    ]);
    const parsed = parseJsonObject(output);
    if (parsed === null) {
      return null;
    }

    const state = parsePrState(parsed.state);
    const isDraft = booleanValue(parsed.isDraft);
    const headSha = stringValue(parsed.headRefOid);
    const baseRef = stringValue(parsed.baseRefName);
    if (
      state === null ||
      isDraft === null ||
      headSha === null ||
      baseRef === null
    ) {
      return null;
    }

    return {
      repo: candidate.repo,
      prNumber: candidate.prNumber,
      prUrl: stringValue(parsed.url),
      state,
      isDraft,
      mergeStateStatus: nullableStringValue(parsed.mergeStateStatus),
      mergeable: nullableStringValue(parsed.mergeable),
      reviewDecision: nullableStringValue(parsed.reviewDecision),
      headSha,
      baseRef,
      baseSha: candidate.baseSha,
      requiredChecks: parseStatusCheckRollup(parsed.statusCheckRollup),
      requiresGithubReview: nullableStringValue(parsed.reviewDecision) !== null,
      mergeQueueRequired: true,
      mergedAt: nullableStringValue(parsed.mergedAt),
      mergeCommit: parseMergeCommit(parsed.mergeCommit),
    };
  }

  private async runGh(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: this.workspaceManager.root,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  private async spawnWorkerExecution(
    issue: Issue,
    attempt: number | null,
    stage: StageDefinition | null,
    stageName: string | null,
    reworkCount: number,
    rightSizingDecision: RightSizingDecision,
    acceptanceCriteria: string | null = null,
    budgetMultiplier = 1,
    reasoningEffort = rightSizingDecision.reasoningEffort.selectedEffort,
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
      codexAppServerPid: null,
      codexAppServerIdentity: null,
      controller,
      stopRequest: null,
      lastResult: null,
      completion: Promise.resolve(),
    };
    const executionJob = this.createStageExecutionJobSpec({
      issue,
      attempt,
      stage,
      stageName,
    });
    const stageExecutionBackend =
      this.resolveStageExecutionBackend(executionJob);

    await this.logger?.info(
      "agent_runner_starting",
      "Agent runner starting for issue.",
      {
        outcome: "started",
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        ...(stageName !== null ? { stage: stageName } : {}),
        stage_execution_backend: executionJob.backend,
        stage_execution_run_group_id: executionJob.identity.runGroupId,
        stage_execution_idempotency_key: executionJob.identity.idempotencyKey,
      },
    );

    const globalHardStops = resolveHardStopsConfig(
      this.config.hardStops,
      DEFAULT_RUNTIME_HARD_STOPS_CONFIG,
    );
    const effectiveHardStops = resolveHardStopsConfig(
      stage?.hardStops,
      globalHardStops,
    );

    const runnerInput: AgentRunInput = {
      issue,
      attempt,
      signal: controller.signal,
      stage,
      stageName,
      reworkCount,
      acceptanceCriteria,
      implementationCommentDeltas:
        await this.buildImplementationCommentDeltaContext(issue, stageName),
      workpadContext: await this.buildWorkpadRetryContext(
        issue,
        stageName,
        attempt,
      ),
      budgetMultiplier: Math.max(1, budgetMultiplier),
      reasoningEffort,
      modePolicy: createModeScopedPermissionPolicy({
        mode: rightSizingDecision.mode,
        stageName,
        configuredApprovalPolicy: this.config.codex.approvalPolicy,
        configuredThreadSandbox: this.config.codex.threadSandbox,
        configuredTurnSandboxPolicy: this.config.codex.turnSandboxPolicy,
        // Mode ceilings (prototype $5 / thin $20) intentionally still cap
        // the scaled budget: right-sizing promises bound escalations, so a
        // prototype unit cannot ladder past its mode's hard ceiling.
        maxBudgetUsd:
          effectiveHardStops.maxDollarBudgetUsd * Math.max(1, budgetMultiplier),
      }),
    };
    const completion = stageExecutionBackend
      .execute({
        job: executionJob,
        runnerInput,
      })
      .then(async ({ result }) => {
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
                ? formatWorkerErrorReason(error)
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

  private createStageExecutionJobSpec(input: {
    issue: Issue;
    attempt: number | null;
    stage: StageDefinition | null;
    stageName: string | null;
  }): StageExecutionJobSpec {
    return createStageExecutionJobSpec({
      ...input,
      defaultRunnerKind: this.config.runner.kind,
      defaultRunnerModel: this.config.runner.model,
      baseRef: resolveStageExecutionBaseRef(),
      artifactRoot: getDurableCodexSessionArtifactDirectory(
        this.config.workspace.root,
        input.issue.id,
      ),
    });
  }

  private resolveStageExecutionBackend(
    job: StageExecutionJobSpec,
  ): StageExecutionBackendRunner {
    const backend = this.stageExecutionBackends.get(job.backend);
    if (backend === undefined) {
      throw new UnsupportedStageExecutionBackendError(job);
    }
    return backend;
  }

  private async buildImplementationCommentDeltaContext(
    issue: Issue,
    stageName: string | null,
  ): Promise<ImplementationCommentDeltaContext | null> {
    if (stageName !== "implement") {
      return null;
    }
    if (!(this.tracker instanceof LinearTrackerClient)) {
      return null;
    }

    const review = findLatestValidSpecReview(
      this.orchestrator.getState().dispatcherRunJournal,
      issue.id,
    );
    if (review === null || review.completedAt === null) {
      return null;
    }

    let comments: LinearIssueComment[];
    try {
      comments = await this.tracker.fetchIssueComments(issue.id, {
        maxPages: DEFAULT_SPEC_REVIEW_COMMENT_CONFIG.maxCommentPages,
      });
    } catch (error) {
      console.warn(
        `[orchestrator] ${issue.identifier}: failed to fetch implementation comment deltas: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const accountSets = normalizeOperatorConfig(this.config.operatorAnchors);
    const dispositionById = new Map(
      review.commentDispositions.map((record) => [
        record.id,
        record.disposition,
      ]),
    );
    const cutoffMs = Date.parse(review.completedAt);
    const operatorContextReasons: string[] = [];

    const deltas: ImplementationCommentDelta[] = [];
    for (const comment of comments) {
      const effectiveAt = getEffectiveCommentTimestamp(comment);
      const effectiveMs = Date.parse(effectiveAt);
      const actor = comment.botActor ?? comment.user;
      const authorClass = classifyActor(actor, accountSets);
      const disposition = dispositionById.get(comment.id);
      const isPreCutoff =
        !Number.isNaN(effectiveMs) &&
        !Number.isNaN(cutoffMs) &&
        effectiveMs <= cutoffMs;
      if (
        disposition === "uncited" &&
        isPreCutoff &&
        (authorClass === "operator" || authorClass === "unknown")
      ) {
        operatorContextReasons.push(`${comment.id} (${authorClass})`);
      }
      if (disposition === "carried_forward") {
        deltas.push({
          id: comment.id,
          authorClass,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          effectiveAt,
          disposition: "carried_forward",
          body: comment.body,
        });
        continue;
      }
      if (!Number.isNaN(effectiveMs) && effectiveMs > cutoffMs) {
        deltas.push({
          id: comment.id,
          authorClass,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          effectiveAt,
          disposition: "post_cutoff",
          body: comment.body,
        });
      }
    }

    return {
      sourceIntentHash: review.sourceIntentHash,
      cutoff: review.completedAt,
      requiresOperatorContext: operatorContextReasons.length > 0,
      operatorContextReason:
        operatorContextReasons.length === 0
          ? null
          : `Uncited comments at or before the spec-review cutoff require operator reconciliation: ${operatorContextReasons.join(", ")}.`,
      comments: deltas,
    };
  }

  private async buildWorkpadRetryContext(
    issue: Issue,
    stageName: string | null,
    attempt: number | null,
  ): Promise<WorkpadRetryContext | null> {
    if (stageName !== "investigate" || attempt === null) {
      return null;
    }
    if (!(this.tracker instanceof LinearTrackerClient)) {
      return null;
    }

    let comments: LinearIssueComment[];
    try {
      comments = await this.tracker.fetchIssueComments(issue.id, {
        maxPages: DEFAULT_SPEC_REVIEW_COMMENT_CONFIG.maxCommentPages,
      });
    } catch (error) {
      console.warn(
        `[orchestrator] ${issue.identifier}: failed to fetch workpad retry context: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const latestWorkpad = comments
      .filter((comment) => comment.body.trimStart().startsWith("## Workpad"))
      .sort(
        (left, right) =>
          Date.parse(getEffectiveCommentTimestamp(right)) -
          Date.parse(getEffectiveCommentTimestamp(left)),
      )[0];

    if (latestWorkpad === undefined) {
      return { present: false, commentId: null };
    }

    return {
      present: true,
      commentId: latestWorkpad.id,
    };
  }

  private async stopWorkerExecution(
    issueId: string,
    input: StopRequest,
  ): Promise<StopSignalDelivery | null> {
    const execution = this.workers.get(issueId);
    if (execution === undefined) {
      return null;
    }

    execution.stopRequest = input;
    let workspacePath: string | null = null;
    try {
      workspacePath =
        this.workspaceManager.resolveForIssue(issueId).workspacePath;
    } catch {
      workspacePath = null;
    }

    execution.controller.abort(`Stopped due to ${input.reason}.`);

    await this.logger?.info(
      "worker_stop_requested",
      "Worker stop requested; aborting runner before tracked process signal delivery.",
      {
        outcome: "requested",
        issue_id: execution.issueId,
        issue_identifier: execution.issueIdentifier,
        reason: input.reason,
        attempted_reason: input.reason,
        ...(execution.stageName === null ? {} : { stage: execution.stageName }),
        ...(workspacePath === null ? {} : { workspace_path: workspacePath }),
      },
    );

    const delivery = await this.deliverWorkerStopSignalSafe({
      issueId: execution.issueId,
      issueIdentifier: execution.issueIdentifier,
      reason: input.reason,
      workspacePath,
      trackedProcessPid: execution.codexAppServerPid,
      trackedProcessIdentity: execution.codexAppServerIdentity,
      attemptedAt: this.now(),
    });
    await this.logStopSignalDelivery(delivery, execution);
    return delivery;
  }

  private async deliverWorkerStopSignalSafe(
    input: WorkerStopSignalDeliveryInput,
  ): Promise<StopSignalDelivery> {
    try {
      const delivery = await this.deliverWorkerStopSignal(input);
      if (isStopSignalDelivery(delivery)) {
        return delivery;
      }
      return createFailedStopSignalDelivery(
        input,
        "Tracked process signal delivery returned invalid telemetry; no attempts were recorded.",
      );
    } catch (error) {
      return createFailedStopSignalDelivery(
        input,
        `Tracked process signal delivery failed before attempts were recorded: ${toErrorMessage(error)}`,
      );
    }
  }

  private async logStopSignalDelivery(
    delivery: StopSignalDelivery,
    execution: WorkerExecution,
  ): Promise<void> {
    const failedAttempts = getFailedStopSignalDeliveryAttempts(
      delivery.attempts,
    );
    const processGroupIds = delivery.attempts
      .map((attempt) => attempt.processGroupId)
      .filter((id): id is number => id !== null);
    const failedProcessGroupIds = failedAttempts
      .map((attempt) => attempt.processGroupId)
      .filter((id): id is number => id !== null);
    const context = {
      outcome:
        delivery.status === "failed" || delivery.status === "partial"
          ? "degraded"
          : delivery.status,
      reason: delivery.reason,
      issue_id: execution.issueId,
      issue_identifier: execution.issueIdentifier,
      attempted_reason: delivery.reason,
      signal_delivery_status: delivery.status,
      tracked_process_pid: delivery.attempts[0]?.pid ?? null,
      pids: delivery.attempts.map((attempt) => attempt.pid),
      failed_pids: failedAttempts.map((attempt) => attempt.pid),
      attempts: delivery.attempts,
      ...(processGroupIds.length === 0
        ? {}
        : { process_group_ids: processGroupIds }),
      ...(failedProcessGroupIds.length === 0
        ? {}
        : { failed_process_group_ids: failedProcessGroupIds }),
      ...(delivery.workspacePath === null
        ? {}
        : { workspace_path: delivery.workspacePath }),
      ...(execution.stageName === null ? {} : { stage: execution.stageName }),
      ...(delivery.warning === null ? {} : { warning: delivery.warning }),
    };

    if (delivery.status === "failed" || delivery.status === "partial") {
      await this.logger?.warn(
        "worker_stop_signal_delivery_failed",
        "Worker stop signal delivery failed for one or more tracked process targets.",
        context,
      );
      return;
    }

    await this.logger?.info(
      "worker_stop_signal_delivery",
      "Worker stop signal delivery telemetry recorded.",
      context,
    );
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

    const hardStop = execution.lastResult?.hardStop ?? null;
    const hardStopFields =
      hardStop === null
        ? {}
        : {
            hard_stop_outcome: hardStop.outcome,
            hard_stop_trigger: hardStop.trigger,
            hard_stop_reason: hardStop.reason,
            hard_stop_turn_count: hardStop.turnCount,
            hard_stop_total_tokens: hardStop.totalTokens,
            hard_stop_estimated_cost_usd: hardStop.estimatedCostUsd,
          };
    const inputRequiredPause =
      hardStop === null &&
      input.outcome === "abnormal" &&
      isCodexUserInputRequiredReason(input.reason);
    const exitEvent =
      hardStop !== null || inputRequiredPause
        ? "worker_exit_paused"
        : input.outcome === "normal"
          ? "worker_exit_normal"
          : "worker_exit_abnormal";
    const exitOutcome =
      hardStop !== null || inputRequiredPause
        ? "paused"
        : input.outcome === "normal"
          ? "completed"
          : "failed";
    const exitMessage =
      hardStop !== null
        ? "Worker paused by hard stop."
        : inputRequiredPause
          ? "Worker paused because Codex requested operator input."
          : input.outcome === "normal"
            ? "Worker completed normally."
            : "Worker completed abnormally.";

    await this.logger?.log(
      hardStop !== null || inputRequiredPause
        ? "warn"
        : input.outcome === "normal"
          ? "info"
          : "error",
      exitEvent,
      exitMessage,
      {
        outcome: exitOutcome,
        ...(input.reason === undefined && hardStop === null
          ? {}
          : { reason: input.reason ?? hardStop?.reason }),
        issue_id: execution.issueId,
        issue_identifier: execution.issueIdentifier,
        session_id: execution.lastResult?.liveSession.sessionId ?? null,
        ...(inputRequiredPause
          ? { pause_reason: ERROR_CODES.codexUserInputRequired }
          : {}),
        ...hardStopFields,
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
    await this.logger?.log(
      hardStop !== null || inputRequiredPause ? "warn" : "info",
      "stage_completed",
      hardStop !== null
        ? "Stage paused by hard stop."
        : inputRequiredPause
          ? "Stage paused because Codex requested operator input."
          : input.outcome === "normal"
            ? "Stage completed."
            : "Stage failed.",
      {
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
        outcome:
          hardStop !== null || inputRequiredPause
            ? "paused"
            : input.outcome === "normal"
              ? "completed"
              : "failed",
        ...(inputRequiredPause
          ? { pause_reason: ERROR_CODES.codexUserInputRequired }
          : {}),
        ...hardStopFields,
      },
    );

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
    const preExhaustedHas = state.failureExhaustedIds.has(execution.issueId);
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
      hardStop: execution.lastResult?.hardStop ?? null,
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
          inputRequiredPause
            ? `Worker paused for operator input: ${input.reason ?? "Codex requested input"}.`
            : input.outcome === "normal"
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

    // Queue Triage v2 (SYMPH-803): record this issue's terminal pipeline result
    // as a batch outcome. Gated on queueTriage.enabled, NOT on the notifier, so
    // it runs even with Slack disabled (council R1, Codex P2). Single
    // classification (failed > merged > parked; a continuation-retry exit records
    // nothing). Best-effort inside recordTerminalBatchOutcome — never disturbs
    // the worker-exit path.
    {
      const outcomeState = this.orchestrator.getState();
      const terminalOutcome: TerminalOutcomeResult | null =
        outcomeState.failureExhaustedIds.has(execution.issueId)
          ? "failed"
          : outcomeState.completed.has(execution.issueId) &&
              outcomeState.retryAttempts[execution.issueId] === undefined
            ? "merged"
            : outcomeState.resumeRequired.has(execution.issueId)
              ? "parked"
              : null;
      if (terminalOutcome !== null) {
        await this.recordTerminalBatchOutcome(
          execution.issueIdentifier,
          terminalOutcome,
        );
      }
    }

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
        preExhaustedHas,
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
      // This fallback only discovers processes whose cwd is still inside the
      // workspace. Descendants that chdir elsewhere must be contained by the
      // tracked PID/process-tree stop path instead of this lsof sweep.
      const skippedCwdRechecks: WorkspaceCwdRecheckSkip[] = [];
      let skippedCwdRecheckCount = 0;
      const pidsToKill = await this.listWorkspaceCwdProcessIds(workspacePath, {
        onSkippedRecheck: (skip) => {
          skippedCwdRecheckCount += 1;
          if (
            skippedCwdRechecks.length < WORKSPACE_CWD_RECHECK_SKIP_LOG_LIMIT
          ) {
            skippedCwdRechecks.push(skip);
          }
        },
      });
      await this.logWorkspaceCwdRecheckSkips({
        issueIdentifier,
        workspacePath,
        skippedCount: skippedCwdRecheckCount,
        skipped: skippedCwdRechecks,
      });

      if (pidsToKill.length > 0) {
        type OrphanCleanupOutcome = {
          pid: number;
          processGroupId: number | null;
          termination: ProcessTreeTerminationResult | null;
          reason: string | null;
        };
        type ConfirmedOrphanCleanupOutcome = OrphanCleanupOutcome & {
          termination: ProcessTreeTerminationResult;
          reason: null;
        };
        const outcomes: OrphanCleanupOutcome[] = await Promise.all(
          pidsToKill.map(async (pid): Promise<OrphanCleanupOutcome> => {
            try {
              const identity = await this.readProcessIdentity(pid);
              if (identity === null || identity.processGroupId === null) {
                return {
                  pid,
                  processGroupId: null,
                  termination: null,
                  reason: "process_identity_unavailable",
                };
              }
              const termination =
                identity.processGroupId === pid
                  ? await this.terminateDetachedPidTree(pid, {
                      graceMs: 1_000,
                      expectedIdentity: identity,
                    })
                  : await this.terminateDetachedProcessGroupTree(
                      identity.processGroupId,
                      { graceMs: 1_000 },
                    );
              return {
                pid,
                processGroupId: identity.processGroupId,
                termination,
                reason: null,
              };
            } catch (error) {
              return {
                pid,
                processGroupId: null,
                termination: null,
                reason: toErrorMessage(error),
              };
            }
          }),
        );
        const confirmedOutcomes = outcomes.filter(
          (outcome): outcome is ConfirmedOrphanCleanupOutcome =>
            outcome.termination !== null &&
            processTreeTerminationConfirmed(outcome.termination),
        );
        const degradedOutcomes = outcomes.filter(
          (outcome) =>
            outcome.termination === null ||
            !processTreeTerminationConfirmed(outcome.termination),
        );

        if (confirmedOutcomes.length > 0) {
          await this.logger?.log(
            "info",
            "orphaned_processes_killed",
            `Confirmed cleanup for ${confirmedOutcomes.length} orphaned process(es) in ${workspacePath}`,
            {
              issue_identifier: issueIdentifier,
              pids: confirmedOutcomes.map((outcome) => String(outcome.pid)),
              discovery: "workspace_cwd",
              cleanup_results: confirmedOutcomes.map((outcome) => ({
                pid: outcome.pid,
                process_group_id: outcome.processGroupId,
                ...processTreeTerminationLogFields(outcome.termination),
              })),
            },
          );
        }

        if (degradedOutcomes.length > 0) {
          await this.logger?.warn(
            "orphaned_process_cleanup_degraded",
            `Could not confirm cleanup for ${degradedOutcomes.length} orphaned process(es) in ${workspacePath}`,
            {
              outcome: "degraded",
              issue_identifier: issueIdentifier,
              pids: degradedOutcomes.map((outcome) => String(outcome.pid)),
              discovery: "workspace_cwd",
              cleanup_results: degradedOutcomes.map((outcome) => ({
                pid: outcome.pid,
                process_group_id: outcome.processGroupId,
                ...(outcome.termination === null
                  ? { error: outcome.reason }
                  : processTreeTerminationLogFields(outcome.termination)),
              })),
            },
          );
        }
      }
    } catch {
      // Best-effort — lsof unavailable or other failure should not block finalization
    }
  }

  private async logWorkspaceCwdRecheckSkips(input: {
    issueIdentifier: string;
    workspacePath: string;
    skippedCount: number;
    skipped: WorkspaceCwdRecheckSkip[];
  }): Promise<void> {
    if (input.skippedCount === 0) {
      return;
    }
    try {
      await this.logger?.warn(
        "workspace_cwd_recheck_skipped",
        `Skipped ${input.skippedCount} workspace-cwd candidate process(es) whose current cwd could not be verified.`,
        {
          outcome: "degraded",
          issue_identifier: input.issueIdentifier,
          workspace_path: input.workspacePath,
          discovery: "workspace_cwd",
          skipped_count: input.skippedCount,
          truncated: input.skippedCount > WORKSPACE_CWD_RECHECK_SKIP_LOG_LIMIT,
          skipped_rechecks: input.skipped.map((skip) => ({
            pid: skip.pid,
            reason: skip.reason,
            discovered_cwd_path: skip.discoveredCwdPath,
            current_cwd_path: skip.currentCwdPath,
          })),
        },
      );
    } catch {
      // Logging is diagnostic only; cleanup remains best-effort fail-open.
    }
  }

  private async cleanupRecoveredDispatcherAdmissionOrphans(
    journal: DispatcherRunJournal,
  ): Promise<void> {
    for (const plan of collectRecoveredDispatcherAdmissionCleanupPlans(
      journal,
    )) {
      try {
        const { workspacePath } = this.workspaceManager.resolveForIssue(
          plan.issueId,
        );
        const sweepKey = `${plan.issueId}\0${workspacePath}`;
        if (this.startupOrphanCleanupSweeps.has(sweepKey)) {
          continue;
        }
        this.startupOrphanCleanupSweeps.add(sweepKey);
        await this.killOrphanedProcesses(workspacePath, plan.issueIdentifier);
      } catch (error) {
        await this.logger?.warn(
          "dispatcher_recovery_orphan_cleanup_failed",
          "Failed to clean up orphaned process groups for a recovered dispatcher admission.",
          {
            outcome: "degraded",
            issue_id: plan.issueId,
            issue_identifier: plan.issueIdentifier,
            reason: toErrorMessage(error),
          },
        );
      }
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
      /** Whether a failure_exhausted alert had already fired before onWorkerExit ran. */
      preExhaustedHas: boolean;
      capturedFirstDispatchedAt: string | null;
      durationMs: number;
    },
  ): void {
    // biome-ignore lint/style/noNonNullAssertion: caller guards notifier !== null
    const notifier = this.notifier!;
    const state = this.orchestrator.getState();

    // Terminal failure — issue newly entered failed set (check first; supersedes infra_error)
    const nowFailed =
      state.failed.has(execution.issueId) && !captured.preFailedHas;
    if (nowFailed) {
      // Dedup: if a failure_exhausted alert fired during this onWorkerExit call
      // (i.e. exhaustedIds grew since we captured preExhaustedHas), suppress
      // the generic issue_failed post to avoid double terminal alerts for the
      // same event. This covers both count-based exhaustion AND novelty short-circuit
      // parks that fire failure_exhausted at attempt < maxRetries.
      const exhaustedAlertFired =
        state.failureExhaustedIds.has(execution.issueId) &&
        !captured.preExhaustedHas;
      if (!exhaustedAlertFired) {
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
      }
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

    if (state.resumeRequired.has(execution.issueId)) {
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
      workspaceBaseRefreshLogger: async (entry) => {
        const failed =
          entry.action === "fetch_failed" || entry.action === "refresh_failed";
        const repairedBaseRef =
          entry.previousDesiredBase !== undefined &&
          entry.previousDesiredBase !== null &&
          entry.desiredBase !== null &&
          entry.previousDesiredBase !== entry.desiredBase;
        await this.logger?.log(
          failed ? "error" : "info",
          "workspace_base_refresh",
          "Checked reused workspace base before agent run.",
          {
            outcome: failed
              ? "failed"
              : (entry.action === "current" && !repairedBaseRef) ||
                  entry.action === "retry_preserved"
                ? "unchanged"
                : "completed",
            action: entry.action,
            issue_id: entry.issueId,
            issue_identifier: entry.issueIdentifier,
            workspace_path: entry.workspacePath,
            stage_name: entry.stageName,
            current_head: entry.currentHead,
            desired_base: entry.desiredBase,
            ...(entry.previousDesiredBase === undefined
              ? {}
              : { previous_desired_base: entry.previousDesiredBase }),
            base_ref: entry.baseRef,
            ...(entry.fetchedBaseRef === undefined
              ? {}
              : { fetched_base_ref: entry.fetchedBaseRef }),
            dirty: entry.dirty,
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          },
        );
      },
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
  await warnSuppressedContractViolations({
    logger,
    validation,
    phase: "startup",
  });
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
      ...(options.runContinuousFeedbackCommand === undefined
        ? {}
        : {
            runContinuousFeedbackCommand: options.runContinuousFeedbackCommand,
          }),
    });
  const usesManagedTracker = options.tracker === undefined;
  const usesManagedWorkspaceManager = options.workspaceManager === undefined;
  const startupTimestamp = Date.now();

  // Continuous-feedback model preflight (SYMPH-761): surface a misconfigured or
  // down local reviewer model at startup. Awaited so the bounded probe always
  // completes before the poll loop starts and can never outlive shutdown
  // (council R1: the prior fire-and-forget could orphan a runner child). The
  // host decides policy from its OWN config: warn-not-block (default) records
  // runtime state + a startup warning and proceeds; fail-closed throws
  // RuntimeHostStartupError to abort launch (same contract as
  // validateDispatchConfig). Deciding inside the host avoids downgrading a
  // fail-closed prebuilt host through an options.config that disagrees.
  await runtimeHost.runContinuousFeedbackModelPreflight();

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
          ...(currentConfig.server.host === null
            ? {}
            : { hostname: currentConfig.server.host }),
          refreshMs: currentConfig.observability.refreshMs,
          renderIntervalMs: currentConfig.observability.renderIntervalMs,
          liveUpdatesEnabled: currentConfig.observability.dashboardEnabled,
          anchorFieldEditSecret:
            currentConfig.operatorAnchors?.ingestSecret ?? null,
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

  // Queue Triage v2 shadow tick (SYMPH-784). Fire-and-forget AFTER the poll's
  // dispatch decision so the dispatch path is byte-identical whether or not the
  // feature is enabled (zero-diff). The in-flight guard prevents overlapping
  // planner runs across fast polls; the heartbeat gate inside the tick keeps it
  // to its own cadence. Inert unless `queueTriage.enabled`.
  let standingPlanShadowTickInFlight = false;
  const runStandingPlanShadowTickIfEnabled = (): void => {
    if (standingPlanShadowTickInFlight) {
      return;
    }
    if (currentConfig.queueTriage?.enabled !== true) {
      return;
    }
    standingPlanShadowTickInFlight = true;
    // A re-plan predicate trip or an operator modify_plan intent forces a
    // re-plan now, bypassing the heartbeat cadence (SYMPH-787/789).
    const force = runtimeHost.consumeStandingPlanReplanRequest();
    void runStandingPlanShadowTick({
      config: currentConfig.queueTriage,
      workspaceRoot: workspaceManager.root,
      fetchCandidates: () => tracker.fetchCandidateIssues(),
      getInFlight: () =>
        Object.values(runtimeHost.getState().running).map((entry) => ({
          issueIdentifier: entry.issue.identifier,
          stage: entry.issue.state,
        })),
      createPlannerRunner: (model) =>
        createCmuxPlannerRunner({
          workspace: process.cwd(),
          artifactDir: join(
            workspaceManager.root,
            ".symphony",
            "standing-plan",
          ),
          model,
        }),
      log: (event, message, fields) => {
        void logger.info(event, message, fields);
      },
      now: () => new Date(),
      force,
    })
      .then((result) => {
        // Re-arm a forced re-plan that did not actually land (transient
        // tracker/planner failure or a skip): the modify_plan / predicate
        // request must not evaporate (council R1, Codex P2).
        if (force && result.status !== "ok") {
          runtimeHost.requestStandingPlanReplan();
        }
      })
      .catch(() => {
        // The tick threw: best-effort, but preserve a forced re-plan request.
        if (force) {
          runtimeHost.requestStandingPlanReplan();
        }
      })
      .finally(() => {
        standingPlanShadowTickInFlight = false;
        // Render/publish the living control doc + ingest operator comments
        // (SYMPH-790/791). Best-effort + gated; runs after the plan tick so the
        // doc reflects the freshest revision.
        void runtimeHost.runControlSurfaceTick();
      });
  };

  const runPollCycle = async () => {
    try {
      const pollStart = Date.now();
      const result = await runtimeHost.pollOnce();
      const durationMs = Date.now() - pollStart;
      await logPollCycleResult(logger, result, durationMs);
      runStandingPlanShadowTickIfEnabled();
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

/**
 * Loud, repeated re-alert for `contracts.override: true` (SYMPH-409): every
 * startup and config reload re-warns about each suppressed config-contract
 * violation until the override is removed. The override never expires; this
 * repetition is the bypass resistance.
 */
async function warnSuppressedContractViolations(input: {
  logger: StructuredLogger;
  validation: DispatchValidationResult;
  phase: "startup" | "reload";
}): Promise<void> {
  if (!input.validation.ok) {
    return;
  }

  for (const violation of input.validation.suppressedContractViolations ?? []) {
    await input.logger.warn(
      "config_contract_override_active",
      `contracts.override is suppressing a config contract violation: ${violation.message} Remove contracts.override once the config is fixed — this warning repeats at every startup and reload.`,
      {
        phase: input.phase,
        rule: violation.rule,
        config_key: violation.key,
        offending_value: violation.value,
      },
    );
  }
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

      await warnSuppressedContractViolations({
        logger: input.logger,
        validation: snapshot.dispatchValidation,
        phase: "reload",
      });

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
    teamKeys: config.tracker.teamKeys ?? [],
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

export async function readGitBaseRevision(
  workspacePath: string,
): Promise<string> {
  const originHeadRef = await readGitOriginHeadRef(workspacePath);
  const baseRefs = createGitBaseRefCandidates({
    configuredBaseBranch: process.env.SYMPHONY_BASE_BRANCH,
    originHeadRef,
  });
  const failures: string[] = [];

  for (const baseRef of baseRefs) {
    if (!(await gitRefExists(workspacePath, baseRef))) {
      failures.push(`${baseRef}: ref not found`);
      continue;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspacePath, "merge-base", "HEAD", baseRef],
        {
          timeout: 5000,
        },
      );
      const revision = String(stdout).trim();
      if (revision.length > 0) {
        return revision;
      }
      failures.push(`${baseRef}: empty merge-base`);
    } catch (error) {
      failures.push(`${baseRef}: ${toErrorMessage(error)}`);
    }
  }

  throw new Error(
    `Failed to resolve git base revision for ${workspacePath}; tried ${failures.join("; ")}`,
  );
}

async function readGitOriginHeadRef(
  workspacePath: string,
): Promise<string | null> {
  try {
    const { stdout: headRefStdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        timeout: 5000,
      },
    );
    const headRef = String(headRefStdout).trim();
    return headRef.length > 0 ? headRef : null;
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

function resolveStageExecutionBaseRef(): string {
  const configuredBaseBranch = normalizeGitBranchName(
    process.env.SYMPHONY_BASE_BRANCH,
  );
  return configuredBaseBranch === null
    ? "origin/main"
    : `origin/${configuredBaseBranch}`;
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

async function gitRefExists(
  workspacePath: string,
  ref: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        workspacePath,
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ],
      {
        timeout: 1000,
      },
    );
    return true;
  } catch {
    return false;
  }
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
    ...(event.closureInitiator === undefined
      ? {}
      : { closure_initiator: event.closureInitiator }),
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

const ISSUE_DETAIL_TOKEN_TELEMETRY_MAX_ENTRIES = 25;

function toRunningIssueDetail(
  running: RunningEntry,
  workspaceManager: WorkspaceManager,
  parent: { identifier: string; title: string; url: string } | null,
  loopTraceJournal: IssueDetailResponse["loop_trace_journal"],
): IssueDetailResponse {
  const tokenTelemetry = tailEntries(
    running.tokenTelemetry,
    ISSUE_DETAIL_TOKEN_TELEMETRY_MAX_ENTRIES,
  );

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
        ...(running.codexCacheReadTokens > 0
          ? { cache_read_tokens: running.codexCacheReadTokens }
          : {}),
        ...(running.codexCacheWriteTokens > 0
          ? { cache_write_tokens: running.codexCacheWriteTokens }
          : {}),
        ...(running.codexNoCacheTokens > 0
          ? { no_cache_tokens: running.codexNoCacheTokens }
          : {}),
        ...(running.codexReasoningTokens > 0
          ? { reasoning_tokens: running.codexReasoningTokens }
          : {}),
      },
      token_telemetry: tokenTelemetry.map((entry) => ({
        at: entry.timestamp,
        event: entry.event,
        session_id: entry.sessionId,
        turn_id: entry.turnId,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        total_tokens: entry.totalTokens,
        input_tokens_delta: entry.inputTokensDelta,
        output_tokens_delta: entry.outputTokensDelta,
        total_tokens_delta: entry.totalTokensDelta,
        cache_read_tokens: entry.cacheReadTokens,
        cache_write_tokens: entry.cacheWriteTokens,
        no_cache_tokens: entry.noCacheTokens,
        reasoning_tokens: entry.reasoningTokens,
        cache_read_tokens_delta: entry.cacheReadTokensDelta,
        cache_write_tokens_delta: entry.cacheWriteTokensDelta,
        no_cache_tokens_delta: entry.noCacheTokensDelta,
        reasoning_tokens_delta: entry.reasoningTokensDelta,
      })),
      token_telemetry_total_entries: running.tokenTelemetryObservedCount,
      token_telemetry_retained_entries: running.tokenTelemetry.length,
      token_telemetry_observed_entries: running.tokenTelemetryObservedCount,
      token_telemetry_truncated:
        tokenTelemetry.length < running.tokenTelemetry.length,
      token_telemetry_retention_truncated:
        running.tokenTelemetry.length < running.tokenTelemetryObservedCount,
    },
    retry: null,
    logs: {
      codex_session_logs: running.codexSessionLogs.map((entry) => ({
        label: entry.label,
        path: entry.path,
        url: entry.url,
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      })),
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

function tailEntries<T>(entries: readonly T[], maxEntries: number): T[] {
  if (entries.length <= maxEntries) {
    return [...entries];
  }

  return entries.slice(entries.length - maxEntries);
}

function toIssueDetailCodexSessionLogs(
  entries: readonly CodexSessionLogEntry[],
): IssueDetailResponse["logs"]["codex_session_logs"] {
  return entries.map((entry) => ({
    label: entry.label,
    path: entry.path,
    url: entry.url,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
  }));
}

function toRetryIssueDetail(
  issueIdentifier: string,
  retry: RetryEntry,
  parent: { identifier: string; title: string; url: string } | null,
  codexSessionLogs: CodexSessionLogEntry[],
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
      codex_session_logs: toIssueDetailCodexSessionLogs(codexSessionLogs),
    },
    recent_events: [],
    loop_trace_journal: loopTraceJournal,
    last_error: retry.error,
    tracked: {},
    parent,
  };
}

async function readCodexSessionLogsForIssue(
  workspaceRoot: string,
  workspaceKey: string,
): Promise<CodexSessionLogEntry[]> {
  const artifactRoot = getDurableCodexSessionArtifactDirectory(
    workspaceRoot,
    workspaceKey,
  );
  try {
    if (!(await lstat(artifactRoot)).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  const result: CodexSessionLogEntry[] = [];

  const visit = async (directory: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      let bytes: number | undefined;
      try {
        const stats = await lstat(entryPath);
        if (!stats.isFile()) {
          continue;
        }
        bytes = stats.size;
      } catch {
        bytes = undefined;
      }

      result.push({
        label: relative(artifactRoot, entryPath),
        path: entryPath,
        url: null,
        ...(bytes !== undefined ? { bytes } : {}),
      });
    }
  };

  await visit(artifactRoot);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function toStoredIssueDetail(
  issueKey: string,
  storedTrace: StoredLoopTrace,
  codexSessionLogs: CodexSessionLogEntry[],
): IssueDetailResponse | null {
  const issueEntry = findLatestTraceEntryForIssueKey(
    storedTrace.journal,
    issueKey,
  );
  if (issueEntry === null) {
    return null;
  }
  const latest = storedTrace.journal.at(-1) ?? null;
  const status = deriveStoredIssueStatus(storedTrace.journal);
  return {
    issue_identifier: issueEntry.issueIdentifier,
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
      codex_session_logs: toIssueDetailCodexSessionLogs(codexSessionLogs),
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

function toContinuousFeedbackEvent(
  event: AgentRunnerEvent,
): ContinuousFeedbackEvent | null {
  return event.event === "turn_completed" ? "checkpoint" : null;
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

function findLatestTraceEntryForIssueKey(
  journal: LoopTraceEntry[],
  issueKey: string,
): LoopTraceEntry | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (entry !== undefined && isTraceEntryForIssueKey(entry, issueKey)) {
      return entry;
    }
  }
  return null;
}

function isTraceEntryForIssueKey(
  entry: LoopTraceEntry,
  issueKey: string,
): boolean {
  return entry.issueIdentifier === issueKey || entry.issueId === issueKey;
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

function normalizeDispatcherRunJournalCompactionTailEntries(
  value: number | undefined,
): number {
  if (value === undefined) {
    return DISPATCHER_RUN_JOURNAL_DEFAULT_COMPACTION_TAIL_ENTRIES;
  }
  return Number.isInteger(value) && value > 0
    ? value
    : DISPATCHER_RUN_JOURNAL_DEFAULT_COMPACTION_TAIL_ENTRIES;
}

interface EmergencyStopRecoveryCleanupPlan {
  issueId: string;
  issueIdentifier: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
  setBySequence: number;
  since: string;
}

function collectUnconfirmedEmergencyStopCleanupPlans(
  journal: DispatcherRunJournal,
): EmergencyStopRecoveryCleanupPlan[] {
  const pendingPlansByIssue = new Map<
    string,
    EmergencyStopRecoveryCleanupPlan[]
  >();
  const plansByKey = new Map<string, EmergencyStopRecoveryCleanupPlan>();
  const provenPlanKeys = new Set<string>();

  for (const entry of [...journal].sort((a, b) => a.sequence - b.sequence)) {
    if (
      entry.kind === "intent" &&
      entry.metadata.status === "applied" &&
      entry.metadata.verb === "pipeline_stop"
    ) {
      for (const issue of readEmergencyStopInterruptedIssues(entry.metadata)) {
        const plan: EmergencyStopRecoveryCleanupPlan = {
          issueId: issue.issueId,
          issueIdentifier: issue.issueIdentifier,
          codexAppServerPid: issue.codexAppServerPid,
          codexAppServerIdentity: issue.codexAppServerIdentity,
          setBySequence: entry.sequence,
          since: entry.timestamp,
        };
        const plans = pendingPlansByIssue.get(issue.issueId) ?? [];
        plans.push(plan);
        pendingPlansByIssue.set(issue.issueId, plans);
        plansByKey.set(
          emergencyStopCleanupPlanKey(issue.issueId, entry.sequence),
          plan,
        );
      }
      continue;
    }

    if (
      entry.kind !== "hard_stop_trigger" ||
      entry.metadata.status !== "completed" ||
      entry.metadata.reason !== "emergency_stop"
    ) {
      continue;
    }

    const sourceSequence = readEmergencyStopSourceSequence(entry.metadata);
    if (sourceSequence !== null) {
      provenPlanKeys.add(
        emergencyStopCleanupPlanKey(entry.issueId, sourceSequence),
      );
      continue;
    }

    // Legacy completion entries predate sourceSequence. Pair them with the
    // latest unproven same-issue stop; current entries use the precise key.
    const pendingPlans = pendingPlansByIssue.get(entry.issueId) ?? [];
    for (let index = pendingPlans.length - 1; index >= 0; index -= 1) {
      const plan = pendingPlans[index];
      if (plan === undefined) {
        continue;
      }
      const key = emergencyStopCleanupPlanKey(plan.issueId, plan.setBySequence);
      if (!provenPlanKeys.has(key)) {
        provenPlanKeys.add(key);
        break;
      }
    }
  }

  return [...plansByKey.entries()].flatMap(([key, plan]) =>
    provenPlanKeys.has(key) ? [] : [plan],
  );
}

function emergencyStopCleanupPlanKey(
  issueId: string,
  sourceSequence: number,
): string {
  return `${issueId}:${sourceSequence}`;
}

function readEmergencyStopInterruptedIssues(
  metadata: Record<string, unknown>,
): Array<{
  issueId: string;
  issueIdentifier: string;
  codexAppServerPid: string | null;
  codexAppServerIdentity: ProcessIdentitySnapshot | null;
}> {
  const value = metadata.interruptedIssues;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const issueId = item.issueId;
    const issueIdentifier = item.issueIdentifier;
    if (typeof issueId !== "string" || typeof issueIdentifier !== "string") {
      return [];
    }
    const codexAppServerPid = item.codexAppServerPid;
    const codexAppServerIdentity = readProcessIdentityMetadata(
      item.codexAppServerIdentity,
    );
    return [
      {
        issueId,
        issueIdentifier,
        codexAppServerPid:
          typeof codexAppServerPid === "string" &&
          codexAppServerPid.trim() !== ""
            ? codexAppServerPid
            : null,
        codexAppServerIdentity,
      },
    ];
  });
}

function readEmergencyStopSourceSequence(
  metadata: Record<string, unknown>,
): number | null {
  const value = metadata.sourceSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseProcessPid(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "worker failed";
}

function createFailedStopSignalDelivery(
  input: WorkerStopSignalDeliveryInput,
  warning: string,
): StopSignalDelivery {
  return {
    status: "failed",
    reason: input.reason,
    attemptedAt: input.attemptedAt.toISOString(),
    workspacePath: input.workspacePath,
    attempts: [],
    warning,
  };
}

function toStopSignalDeliveryResponse(
  delivery: StopSignalDelivery | null,
): StopSignalDeliveryResponse | null {
  if (delivery === null) {
    return null;
  }
  return {
    status: delivery.status,
    reason: delivery.reason,
    attempted_at: delivery.attemptedAt,
    workspace_path: delivery.workspacePath,
    attempts: delivery.attempts.map((attempt) => ({
      pid: attempt.pid,
      ...(attempt.processGroupId === null
        ? {}
        : { process_group_id: attempt.processGroupId }),
      sigterm: attempt.sigterm,
      sigkill: attempt.sigkill,
    })),
    warning: delivery.warning,
  };
}

export async function deliverTrackedWorkerStopSignal(
  input: WorkerStopSignalDeliveryInput,
  options: TrackedWorkerStopSignalDeliveryOptions = {},
): Promise<StopSignalDelivery> {
  if (input.workspacePath === null) {
    return {
      status: "not_attempted",
      reason: input.reason,
      attemptedAt: input.attemptedAt.toISOString(),
      workspacePath: null,
      attempts: [],
      warning:
        "Workspace path unavailable; tracked process signal delivery was not attempted.",
    };
  }

  if (input.trackedProcessPid === null) {
    return {
      status: "not_attempted",
      reason: input.reason,
      attemptedAt: input.attemptedAt.toISOString(),
      workspacePath: input.workspacePath,
      attempts: [],
      warning:
        "Worker process PID unavailable; process signal delivery was not attempted.",
    };
  }

  if (
    input.trackedProcessIdentity !== undefined &&
    input.trackedProcessIdentity !== null &&
    input.trackedProcessIdentity.pid === input.trackedProcessPid
  ) {
    const termination = await terminateDetachedPidTreeDefault(
      input.trackedProcessPid,
      {
        expectedIdentity: input.trackedProcessIdentity,
        probeIdentity:
          options.readProcessIdentity ?? readProcessIdentityDefault,
        graceMs: options.emergencyStopGraceMs ?? EMERGENCY_STOP_SIGNAL_GRACE_MS,
        ...(options.sendSignal === undefined
          ? {}
          : {
              kill: (pid, signal) => {
                if (typeof signal === "string") {
                  options.sendSignal?.(pid, signal as NodeJS.Signals);
                }
                return true;
              },
            }),
      },
    );
    const identityWarning = stopSignalDeliveryWarningForIdentity(termination);
    if (identityWarning !== null) {
      return {
        status: "not_attempted",
        reason: input.reason,
        attemptedAt: input.attemptedAt.toISOString(),
        workspacePath: input.workspacePath,
        attempts: [],
        warning: `Tracked process PID ${input.trackedProcessPid} was not signaled: ${identityWarning}`,
      };
    }

    const attempt = stopSignalDeliveryAttemptFromTermination(
      input.trackedProcessPid,
      termination,
    );
    const attempts = [attempt];
    const failedAttempts = getFailedStopSignalDeliveryAttempts(attempts);
    const status =
      deriveAttemptedStopSignalDeliveryStatus(attempts) ?? "not_attempted";
    return {
      status,
      reason: input.reason,
      attemptedAt: input.attemptedAt.toISOString(),
      workspacePath: input.workspacePath,
      attempts,
      warning:
        failedAttempts.length === 0
          ? null
          : input.reason === "emergency_stop"
            ? `Emergency stop signal proof failed for ${failedAttempts.length} worker process target(s): ${failedAttempts
                .map((failedAttempt) => `pid=${failedAttempt.pid}`)
                .join(", ")}`
            : `SIGTERM and SIGKILL both failed for ${failedAttempts.length} worker process target(s): ${failedAttempts
                .map((failedAttempt) => `pid=${failedAttempt.pid}`)
                .join(", ")}`,
    };
  }

  const ownership = await verifyTrackedProcessSignalTarget({
    pid: input.trackedProcessPid,
    workspacePath: input.workspacePath,
    readProcessCwd: options.readProcessCwd ?? readProcessCwd,
    readProcessCommand: options.readProcessCommand ?? readProcessCommand,
  });
  if (!ownership.verified) {
    return {
      status: "not_attempted",
      reason: input.reason,
      attemptedAt: input.attemptedAt.toISOString(),
      workspacePath: input.workspacePath,
      attempts: [],
      warning: `Tracked process PID ${input.trackedProcessPid} was not signaled: ${ownership.warning}`,
    };
  }

  const attempts: StopSignalDeliveryAttempt[] = [];
  for (const pid of [input.trackedProcessPid]) {
    const sigterm = signalPid(pid, "SIGTERM", options.sendSignal);
    let sigkill: ProcessSignalDeliveryResult | null = null;
    if (input.reason === "emergency_stop") {
      await delay(
        options.emergencyStopGraceMs ?? EMERGENCY_STOP_SIGNAL_GRACE_MS,
      );
      sigkill = signalPid(pid, "SIGKILL", options.sendSignal);
    } else if (sigterm.status === "failed") {
      sigkill = signalPid(pid, "SIGKILL", options.sendSignal);
    }
    attempts.push({
      pid,
      processGroupId: null,
      sigterm: sigterm.status,
      sigkill: sigkill?.status ?? "not_attempted",
    });
  }

  const failedAttempts = getFailedStopSignalDeliveryAttempts(attempts);
  const status =
    deriveAttemptedStopSignalDeliveryStatus(attempts) ?? "not_attempted";
  return {
    status,
    reason: input.reason,
    attemptedAt: input.attemptedAt.toISOString(),
    workspacePath: input.workspacePath,
    attempts,
    warning:
      failedAttempts.length === 0
        ? null
        : input.reason === "emergency_stop"
          ? `Emergency stop signal proof failed for ${failedAttempts.length} worker process target(s): ${failedAttempts
              .map((attempt) => `pid=${attempt.pid}`)
              .join(", ")}`
          : `SIGTERM and SIGKILL both failed for ${failedAttempts.length} worker process target(s): ${failedAttempts
              .map((attempt) => `pid=${attempt.pid}`)
              .join(", ")}`,
  };
}

async function listWorkspaceCwdProcessIdsFromLsof(
  workspacePath: string,
  options?: WorkspaceCwdProcessListerOptions,
): Promise<number[]> {
  const { stdout } = await execFileAsync("lsof", ["-d", "cwd", "-Fpn"], {
    timeout: 5000,
  });
  return findWorkspaceCwdProcessIds(String(stdout), workspacePath, {
    readCurrentProcessCwd: readProcessCwd,
    onSkippedRecheck: options?.onSkippedRecheck,
  });
}

export async function verifyTrackedProcessSignalTarget(input: {
  pid: number;
  workspacePath: string;
  readProcessCwd?: ProcessCwdReader;
  readProcessCommand?: ProcessCommandReader;
}): Promise<TrackedProcessSignalTargetVerification> {
  const readCwd = input.readProcessCwd ?? readProcessCwd;
  const readCommand = input.readProcessCommand ?? readProcessCommand;
  const [processCwd, processCommand] = await Promise.all([
    readCwd(input.pid),
    readCommand(input.pid),
  ]);

  if (processCwd === null) {
    return {
      verified: false,
      failureKind: "unavailable",
      warning: "process cwd could not be read for ownership verification",
    };
  }

  if (processCommand === null) {
    return {
      verified: false,
      failureKind: "unavailable",
      warning: "process command could not be read for ownership verification",
    };
  }

  if (!(await directoryIsWithinWorkspace(processCwd, input.workspacePath))) {
    return {
      verified: false,
      failureKind: "mismatch",
      warning: `process cwd ${processCwd} is outside workspace containment boundary ${input.workspacePath}`,
    };
  }

  if (!isCodexAppServerCommand(processCommand)) {
    return {
      verified: false,
      failureKind: "mismatch",
      warning: "process command does not look like a Codex app-server",
    };
  }

  return { verified: true, failureKind: null, warning: null };
}

function stopSignalDeliveryWarningForIdentity(
  termination: ProcessTreeTerminationResult,
): string | null {
  switch (termination.identityStatus) {
    case "missing_expected_identity":
      return "captured process identity is missing";
    case "identity_inconclusive":
      return "current process identity could not be verified";
    case "identity_mismatch":
      return "current process identity does not match captured app-server identity";
    case "not_checked":
    case "matched":
    case "absent":
    case undefined:
      return null;
  }
  return null;
}

function stopSignalDeliveryAttemptFromTermination(
  pid: number,
  termination: ProcessTreeTerminationResult,
): StopSignalDeliveryAttempt {
  return {
    pid,
    processGroupId: termination.processGroupId ?? null,
    sigterm: stopSignalStatusFromProcessDelivery(termination.sigterm, {
      absent: termination.identityStatus === "absent",
      failed: false,
    }),
    sigkill: stopSignalKillStatusFromProcessDelivery(termination),
  };
}

function stopSignalStatusFromProcessDelivery(
  delivery: ProcessTreeTerminationResult["sigterm"] | null | undefined,
  fallback: { absent: boolean; failed: boolean },
): Exclude<StopSignalStatus, "not_attempted"> {
  if (delivery === undefined || delivery === null) {
    return fallback.absent
      ? "already_exited"
      : fallback.failed
        ? "failed"
        : "delivered";
  }
  switch (delivery.status) {
    case "delivered":
      return "delivered";
    case "absent":
      return "already_exited";
    case "failed":
      return "failed";
  }
}

function stopSignalKillStatusFromProcessDelivery(
  termination: ProcessTreeTerminationResult,
): StopSignalStatus {
  if (termination.sigkill === undefined || termination.sigkill === null) {
    return termination.postGraceIdentityStatus !== undefined &&
      termination.postGraceIdentityStatus !== null &&
      termination.postGraceIdentityStatus !== "absent" &&
      termination.postGraceIdentityStatus !== "matched"
      ? "failed"
      : "not_attempted";
  }
  return stopSignalStatusFromProcessDelivery(termination.sigkill, {
    absent: false,
    failed: false,
  });
}

export function signalPid(
  pid: number,
  signal: NodeJS.Signals,
  sendSignal: ProcessSignalSender = process.kill,
): ProcessSignalDeliveryResult {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return { status: "failed", processGroupId: null };
  }

  try {
    sendSignal(pid, signal);
    return { status: "delivered", processGroupId: null };
  } catch (error) {
    return {
      status: isNoSuchProcess(error) ? "already_exited" : "failed",
      processGroupId: null,
    };
  }
}

async function readProcessCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { timeout: 5000 },
    );
    return parseLsofName(stdout);
  } catch {
    return null;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 5000 },
    );
    const command = stdout.trim();
    return command.length === 0 ? null : command;
  } catch {
    return null;
  }
}

function parseLsofName(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n") && line.length > 1) {
      return line.slice(1);
    }
  }
  return null;
}

export function parseLsofCwdProcessEntries(
  stdout: string,
): LsofCwdProcessEntry[] {
  const entries: LsofCwdProcessEntry[] = [];
  let currentPid: number | null = null;
  let sawFieldRecord = false;

  for (const line of stdout.split("\n")) {
    if (/^p\d+$/.test(line)) {
      sawFieldRecord = true;
      currentPid = parseProcessId(line.slice(1));
      continue;
    }
    if (currentPid !== null && line.startsWith("n")) {
      sawFieldRecord = true;
      if (line.length > 1) {
        entries.push({ pid: currentPid, cwdPath: line.slice(1) });
      }
    }
  }

  if (sawFieldRecord) {
    return entries;
  }

  // Production calls lsof with -Fpn. Keep this legacy fallback for captured
  // table output and lsof variants that ignore field mode; NAME is the line
  // remainder because cwd paths may contain whitespace.
  return stdout
    .split("\n")
    .map(parseLsofCwdTableEntry)
    .filter((entry): entry is LsofCwdProcessEntry => entry !== null);
}

export async function findWorkspaceCwdProcessIds(
  stdout: string,
  workspacePath: string,
  options?: {
    readCurrentProcessCwd?: (pid: number) => Promise<string | null>;
    recheckConcurrency?: number;
    recheckTimeoutMs?: number;
    onSkippedRecheck?: WorkspaceCwdProcessListerOptions["onSkippedRecheck"];
  },
): Promise<number[]> {
  const candidates: LsofCwdProcessEntry[] = [];
  const seen = new Set<number>();

  for (const entry of parseLsofCwdProcessEntries(stdout)) {
    if (seen.has(entry.pid)) {
      continue;
    }
    if (!(await directoryIsWithinWorkspace(entry.cwdPath, workspacePath))) {
      continue;
    }
    seen.add(entry.pid);
    candidates.push(entry);
  }

  const readCurrentProcessCwd = options?.readCurrentProcessCwd;
  const onSkippedRecheck = options?.onSkippedRecheck;
  if (readCurrentProcessCwd === undefined) {
    return candidates.map((entry) => entry.pid);
  }

  const recheckConcurrency = normalizePositiveInteger(
    options?.recheckConcurrency,
    WORKSPACE_CWD_RECHECK_CONCURRENCY,
  );
  const recheckTimeoutMs = normalizePositiveInteger(
    options?.recheckTimeoutMs,
    WORKSPACE_CWD_RECHECK_TIMEOUT_MS,
  );
  const checkedPids = await mapWithConcurrency(
    candidates,
    recheckConcurrency,
    async (entry): Promise<number | null> => {
      const currentCwd = await readCurrentProcessCwdWithTimeout(
        readCurrentProcessCwd,
        entry.pid,
        recheckTimeoutMs,
      );
      if (currentCwd.cwdPath === null) {
        await notifyWorkspaceCwdRecheckSkipped(onSkippedRecheck, {
          pid: entry.pid,
          discoveredCwdPath: entry.cwdPath,
          currentCwdPath: null,
          reason: currentCwd.timedOut
            ? "current_cwd_timed_out"
            : "current_cwd_unavailable",
        });
        return null;
      }
      if (
        !(await directoryIsWithinWorkspace(currentCwd.cwdPath, workspacePath))
      ) {
        await notifyWorkspaceCwdRecheckSkipped(onSkippedRecheck, {
          pid: entry.pid,
          discoveredCwdPath: entry.cwdPath,
          currentCwdPath: currentCwd.cwdPath,
          reason: "current_cwd_outside_workspace",
        });
        return null;
      }
      return entry.pid;
    },
  );

  return checkedPids.filter((pid): pid is number => pid !== null);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const indexedItems = items.map((item, index) => ({ index, item }));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, indexedItems.length) },
    async () => {
      while (nextIndex < indexedItems.length) {
        const index = nextIndex;
        nextIndex += 1;
        const next = indexedItems[index];
        if (next !== undefined) {
          results[next.index] = await fn(next.item);
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function readCurrentProcessCwdWithTimeout(
  readCurrentProcessCwd: (pid: number) => Promise<string | null>,
  pid: number,
  timeoutMs: number,
): Promise<{ cwdPath: string | null; timedOut: boolean }> {
  let timer: NodeJS.Timeout | null = null;
  const currentCwd = readCurrentProcessCwd(pid).then(
    (cwdPath) => ({ cwdPath, timedOut: false }),
    () => ({ cwdPath: null, timedOut: false }),
  );
  const timeout = new Promise<{ cwdPath: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ cwdPath: null, timedOut: true });
    }, timeoutMs);
  });
  const result = await Promise.race([currentCwd, timeout]);
  if (timer !== null) {
    clearTimeout(timer);
  }
  return result;
}

async function notifyWorkspaceCwdRecheckSkipped(
  onSkippedRecheck:
    | WorkspaceCwdProcessListerOptions["onSkippedRecheck"]
    | undefined,
  skip: WorkspaceCwdRecheckSkip,
): Promise<void> {
  try {
    await onSkippedRecheck?.(skip);
  } catch {
    // Skip telemetry is diagnostic only; discovery remains best-effort.
  }
}

function normalizePositiveInteger(
  value: number | null | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function parseLsofCwdTableEntry(line: string): LsofCwdProcessEntry | null {
  const trimmedStart = line.trimStart();
  if (trimmedStart === "" || trimmedStart.startsWith("COMMAND ")) {
    return null;
  }

  const match = trimmedStart.match(
    /^\S+\s+(\d+)\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/,
  );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }

  const pid = parseProcessId(match[1]);
  if (pid === null) {
    return null;
  }

  const fd = match[2];
  if (fd !== "cwd" && !fd?.startsWith("cwd")) {
    return null;
  }

  const cwdPath = match[3];
  return cwdPath === "" ? null : { pid, cwdPath };
}

async function directoryIsWithinWorkspace(
  directoryPath: string,
  workspacePath: string,
): Promise<boolean> {
  const [directory, workspace] = await Promise.all([
    resolveDirectoryForOwnership(directoryPath),
    resolveDirectoryForOwnership(workspacePath),
  ]);
  const relativePath = relative(workspace, directory);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function resolveDirectoryForOwnership(path: string): Promise<string> {
  try {
    return resolve(await realpath(path));
  } catch {
    return resolve(path);
  }
}

function isCodexAppServerCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes("codex") && normalized.includes("app-server");
}

function parseProcessId(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid ? pid : null;
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function processTreeTerminationLogFields(
  result: ProcessTreeTerminationResult,
): Record<string, unknown> {
  return {
    process_tree_cleanup_confirmed: processTreeTerminationConfirmed(result),
    process_tree_process_group_id: result.processGroupId ?? null,
    process_tree_sigterm_sent: result.sigtermSent,
    process_tree_sigkill_sent: result.sigkillSent,
    process_tree_sigterm_status: result.sigterm?.status ?? null,
    process_tree_sigterm_delivered_to: result.sigterm?.deliveredTo ?? null,
    process_tree_sigkill_status: result.sigkill?.status ?? null,
    process_tree_sigkill_delivered_to: result.sigkill?.deliveredTo ?? null,
    process_tree_identity_status: result.identityStatus ?? null,
    process_tree_post_grace_identity_status:
      result.postGraceIdentityStatus ?? null,
    process_tree_sigterm_attempts: processSignalAttemptsForLog(result.sigterm),
    process_tree_sigkill_attempts: processSignalAttemptsForLog(result.sigkill),
  };
}

function processSignalAttemptsForLog(
  delivery: ProcessTreeTerminationResult["sigterm"],
): Array<Record<string, unknown>> {
  return (
    delivery?.attempts.map((attempt) => ({
      target: attempt.target,
      pid: attempt.pid,
      signal: attempt.signal,
      status: attempt.status,
      error_code: attempt.errorCode,
    })) ?? []
  );
}

function collectRecoveredDispatcherAdmissionCleanupPlans(
  journal: DispatcherRunJournal,
): Array<{ issueId: string; issueIdentifier: string }> {
  const activeAdmissions = new Map<
    string,
    { issueId: string; issueIdentifier: string }
  >();
  for (const entry of journal) {
    if (entry.kind !== "admission" || entry.operation !== "dispatcher") {
      continue;
    }
    const leaseStatus = entry.lease?.status ?? null;
    const metadataStatus = entry.metadata.status;
    if (leaseStatus === "active" || metadataStatus === "started") {
      activeAdmissions.set(entry.issueId, {
        issueId: entry.issueId,
        issueIdentifier: entry.issueIdentifier,
      });
      continue;
    }
    if (
      leaseStatus === "completed" ||
      leaseStatus === "expired" ||
      "outcome" in entry.metadata
    ) {
      activeAdmissions.delete(entry.issueId);
    }
  }
  return [...activeAdmissions.values()];
}

function formatWorkerErrorReason(error: unknown): string {
  const message = toErrorMessage(error);
  const code = extractErrorCode(error);
  return code === null ? message : `${code}: ${message}`;
}

function findLatestValidSpecReview(
  journal: readonly DispatcherRunJournalEntry[],
  issueId: string,
): {
  sourceIntentHash: string | null;
  completedAt: string | null;
  commentDispositions: Array<{
    id: string;
    disposition: SpecReviewCommentDisposition;
  }>;
} | null {
  let latest: DispatcherRunJournalEntry | null = null;
  for (const entry of journal) {
    if (
      entry.kind !== "spec_review_result" ||
      entry.issueId !== issueId ||
      entry.metadata.readiness_state !== "valid"
    ) {
      continue;
    }
    if (latest === null || entry.sequence > latest.sequence) {
      latest = entry;
    }
  }
  if (latest === null) {
    return null;
  }
  return {
    sourceIntentHash: stringMetadata(latest.metadata.source_intent_hash),
    completedAt:
      stringMetadata(latest.metadata.completed_at) ?? latest.timestamp,
    commentDispositions: parseSpecReviewCommentDispositions(
      latest.metadata.comment_dispositions,
    ),
  };
}

function parseSpecReviewCommentDispositions(
  value: unknown,
): Array<{ id: string; disposition: SpecReviewCommentDisposition }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      !("disposition" in entry) ||
      typeof entry.id !== "string" ||
      typeof entry.disposition !== "string" ||
      !isSpecReviewCommentDisposition(entry.disposition)
    ) {
      return [];
    }
    return [{ id: entry.id, disposition: entry.disposition }];
  });
}

function isSpecReviewCommentDisposition(
  value: string,
): value is SpecReviewCommentDisposition {
  return (
    value === "incorporated" ||
    value === "superseded" ||
    value === "carried_forward" ||
    value === "uncited"
  );
}

function getEffectiveCommentTimestamp(comment: LinearIssueComment): string {
  const created = Date.parse(comment.createdAt);
  const updated = Date.parse(comment.updatedAt);
  if (Number.isNaN(created)) {
    return comment.updatedAt;
  }
  if (Number.isNaN(updated)) {
    return comment.createdAt;
  }
  return updated > created ? comment.updatedAt : comment.createdAt;
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function summarizeContinuousFeedbackLoopTrace(
  result: ContinuousFeedbackCheckpointResult,
): string {
  switch (result.status) {
    case "pass":
      return "Continuous feedback passed.";
    case "finding":
      return `Continuous feedback found ${result.findingSignatures.length} issue(s).`;
    case "unavailable": {
      const detail =
        result.summary === null || result.summary.trim() === ""
          ? ""
          : ` ${result.summary.trim()}`;
      return `Continuous feedback unavailable.${detail}`;
    }
    case "skipped":
      return "Continuous feedback skipped.";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCodexUserInputRequiredReason(reason: string | undefined): boolean {
  if (reason === undefined) {
    return false;
  }
  return (
    reason.includes(ERROR_CODES.codexUserInputRequired) ||
    reason.includes("turn_input_required") ||
    reason.includes("Codex requested operator input")
  );
}

function hasPipelineHaltLabel(issue: Issue): boolean {
  return issue.labels.some(
    (label) => label.trim().toLowerCase() === PIPELINE_HALT_LABEL,
  );
}

function getPipelineRestartSafetyReason(
  lanesActive: boolean,
  queueActive: boolean,
): PipelineRestartSafetyResponse["reason"] {
  if (lanesActive && queueActive) {
    return "runtime_and_queue_not_drained";
  }
  if (lanesActive) {
    return "running_or_retrying_lanes";
  }
  if (queueActive) {
    return "active_pipeline_issues";
  }
  return "drained";
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

// --- SYMPH-735 merge-actuator live-state parsing (substrate; consumed by
// fetchMergeActuatorLiveState). Pure, fail-closed helpers at the gh I/O
// boundary; exported via runtimeHostMergeActuatorTesting for unit coverage.

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parsePrState(value: unknown): MergeActuatorLiveState["state"] | null {
  return value === "OPEN" || value === "MERGED" || value === "CLOSED"
    ? value
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}

function parseMergeCommit(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return stringValue((value as Record<string, unknown>).oid);
}

function parseStatusCheckRollup(
  value: unknown,
): MergeActuatorLiveState["requiredChecks"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): MergeActuatorLiveState["requiredChecks"] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    // gh's statusCheckRollup mixes two node shapes: CheckRun (GitHub Actions —
    // name/status/conclusion) and StatusContext (legacy commit statuses —
    // context/state). Detect by field presence so a missing `name` no longer
    // silently drops a StatusContext (which would hide a failing or in-flight
    // legacy check from the actuator).
    const checkRunName = stringValue(record.name);
    if (checkRunName !== null) {
      return [{ name: checkRunName, status: classifyCheckRunStatus(record) }];
    }
    const contextName = stringValue(record.context);
    if (contextName !== null) {
      return [
        { name: contextName, status: classifyStatusContextState(record) },
      ];
    }
    return [];
  });
}

function classifyCheckRunStatus(
  record: Record<string, unknown>,
): "pass" | "fail" | "pending" {
  const conclusion = nullableStringValue(record.conclusion)?.toUpperCase();
  // Still running: gh reports conclusion: null until the run reaches a
  // terminal state. The actuator must wait on these, not fail them.
  if (conclusion === undefined) {
    return "pending";
  }
  if (
    conclusion === "SUCCESS" ||
    conclusion === "NEUTRAL" ||
    conclusion === "SKIPPED"
  ) {
    return "pass";
  }
  // ACTION_REQUIRED is completed-but-needs-manual-action; existing actuator
  // intent treats it as pending (bounded recovery times it out rather than
  // hard-failing). Preserve that.
  if (conclusion === "ACTION_REQUIRED") {
    return "pending";
  }
  // FAILURE / CANCELLED / TIMED_OUT / STARTUP_FAILURE / STALE / unknown
  // terminal conclusions fail closed.
  return "fail";
}

function classifyStatusContextState(
  record: Record<string, unknown>,
): "pass" | "fail" | "pending" {
  const state = nullableStringValue(record.state)?.toUpperCase();
  if (state === "SUCCESS") {
    return "pass";
  }
  // EXPECTED and PENDING are still-in-flight legacy statuses → wait.
  if (state === "PENDING" || state === "EXPECTED") {
    return "pending";
  }
  // ERROR / FAILURE / unknown → fail closed: an unrecognized legacy state
  // must never be treated as passing.
  return "fail";
}

/**
 * Builds the `gh pr merge` enqueue args for the live merge actuator.
 *
 * Head-pin guarantee (SYMPH-750). `--match-head-commit <reviewedHeadSha>` is
 * GitHub's documented mechanism for enforcing the reviewed head at MERGE time
 * (not merely at enablement). Combined with the poll-driven identity guard
 * (layer 3), an advancing head cannot silently merge unreviewed code:
 *
 *   1. `--match-head-commit` maps to the GraphQL `expectedHeadOid`, documented
 *      as "OID that the pull request head ref must match TO ALLOW MERGE; if
 *      omitted, no check is performed." (GitHub GraphQL `MergePullRequestInput`,
 *      confirmed via live `gh api graphql` schema introspection 2026-06-16). gh
 *      builds one `mergePayload` carrying `expectedHeadOid: MatchHeadCommit` and,
 *      because `--auto` is set, passes that SAME input into the
 *      `enablePullRequestAutoMerge` mutation (cli/cli pkg/cmd/pr/merge
 *      `merge.go` + `http.go`). The pinned OID therefore rides into the
 *      auto-merge / merge-queue enablement; per those documented merge-input
 *      semantics it should be re-checked when the deferred merge fires,
 *      rejecting a head advanced past `reviewedHeadSha`. The merge-QUEUE path's
 *      re-validation timing is the least-documented part, so (1)-(2) are not
 *      treated as proof — layer (3) is the guarantee that holds regardless.
 *   2. This repo uses a GitHub merge QUEUE. A push by a NON-write user dequeues /
 *      disables auto-merge (GitHub Docs, "Automatically merging a pull request"),
 *      but GitHub does NOT document dequeue-on-push for WRITE-permission pushers,
 *      and there is a known force-push merge-queue staleness bug
 *      (cli/cli community discussion #194832). So dequeue-on-push is a partial,
 *      not a guaranteed, defense — the `expectedHeadOid` merge-time semantics
 *      (not dequeue-on-push) are the intended head-pin enforcement.
 *   3. Defense in depth: the poll-driven identity guard `firstLiveIdentityBlocker`
 *      (src/orchestrator/merge-candidate.ts) re-checks `live.headSha ===
 *      reviewedHeadSha` on EVERY OPEN poll cycle (via `firstLiveBlocker`) AND on
 *      the MERGED path. Any drift parks the candidate as `stale_reviewed_head`
 *      rather than completing the issue, bounding blast radius even if (1) and
 *      (2) ever regressed.
 *
 * The exact arg vector is locked by a unit test (runtime-host.test.ts) so the
 * `--match-head-commit <reviewedHeadSha>` pin cannot be silently dropped.
 */
function buildMergeActuatorEnqueueArgs(
  candidate: MergeCandidateRecord,
): string[] {
  return [
    "pr",
    "merge",
    String(candidate.prNumber),
    "--repo",
    candidate.repo,
    "--match-head-commit",
    candidate.reviewedHeadSha,
    "--auto",
  ];
}

/**
 * Dequeue args (SYMPH-766): `gh pr merge <pr> --repo <repo> --disable-auto`
 * removes the candidate from GitHub's merge queue / disables auto-merge so the
 * queue cannot merge it behind a late spec-fidelity rework. Idempotent — `gh`
 * tolerates disabling auto-merge that is already off. No strategy or head-pin
 * flag: this only turns auto-merge off; it never merges. The arg vector is
 * locked by a runtime-host unit test so the `--disable-auto` intent cannot be
 * silently changed into a merge.
 */
function buildMergeActuatorDisableAutoArgs(
  candidate: MergeCandidateRecord,
): string[] {
  return [
    "pr",
    "merge",
    String(candidate.prNumber),
    "--repo",
    candidate.repo,
    "--disable-auto",
  ];
}

export const runtimeHostMergeActuatorTesting = {
  buildMergeActuatorEnqueueArgs,
  buildMergeActuatorDisableAutoArgs,
  parseJsonObject,
  parseMergeCommit,
  parsePrState,
  parseStatusCheckRollup,
};
