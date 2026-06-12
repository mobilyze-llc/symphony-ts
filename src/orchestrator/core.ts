import { hostname } from "node:os";

import { extractAcceptanceCriteria } from "../agent/ac-gate.js";
import type {
  PauseTriageEvidence,
  PauseTriageVerdict,
} from "../agent/pause-triage.js";
import type { CodexClientEvent } from "../codex/app-server-client.js";
import {
  evaluateWindowHeadroom,
  parseRateLimitSnapshot,
} from "../codex/rate-limits.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import {
  DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
  DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
  DEFAULT_CONTINUOUS_FEEDBACK_EVENTS,
  DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
  DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
  DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
  DEFAULT_VERDICTS_PAGE_AFTER_TICKS,
} from "../config/defaults.js";
import type {
  DispatchValidationResult,
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import {
  type ContinuousFeedbackEvent,
  type ContinuousFeedbackLane,
  type DecorrelatedGateLane,
  type DecorrelatedGateOutcome,
  type DispatcherDecisionCategory,
  type DispatcherDecisionClassification,
  type DispatcherDecisionCostWeight,
  type DispatcherDecisionEvent,
  type DispatcherDecisionOutcome,
  type DispatcherLease,
  type DispatcherOperation,
  type DispatcherRunJournal,
  type DispatcherRunJournalEntry,
  type FailureClass,
  type Issue,
  type LiveSession,
  type OrchestratorState,
  type RetryEntry,
  type RightSizingDecision,
  type RightSizingMode,
  type RunningEntry,
  type StageRecord,
  VERDICT_DISPOSITIONS,
  type VerdictActor,
  type VerdictDisposition,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
  parseFailureSignal,
} from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  type ErrorSignatureClass,
  type NormalizedErrorSignature,
  normalizeErrorSignature,
} from "../errors/signature.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  appendDispatcherRunJournalEntry,
  rebuildDispatcherLeases,
} from "../logging/run-journal.js";
import {
  addEndedSessionRuntime,
  addPipelineActivity,
  applyCodexEventToOrchestratorState,
} from "../logging/session-metrics.js";
import type {
  HardStopDecision,
  HardStopTrigger,
} from "../policy/hard-stops.js";
import type { IssueStateSnapshot, IssueTracker } from "../tracker/tracker.js";
import { formatAdmissionCard } from "./admission-card.js";
import {
  type ContinuousFeedbackReviewResult,
  ensureDecorrelatedFeedbackLane,
  formatContinuousFeedbackComment,
  getOpenContinuousFeedbackFindings,
  markContinuousFeedbackFindingsBounced,
  mergeContinuousFeedbackCheckpoint,
} from "./continuous-feedback.js";
import {
  type EnsembleGateResult,
  formatExecutionReport,
  formatRebaseComment,
  formatReviewFindingsComment,
} from "./gate-handler.js";
import { createRightSizingDecision } from "./right-sizing.js";
import { SignatureClusterRegistry } from "./signature-cluster.js";
import type { ClusterMember } from "./signature-cluster.js";
import {
  type IgnoredSetupInstructionCollision,
  type SupervisionFinding,
  type WorkerSupervisionSnapshot,
  createIssueSupervisionSnapshot,
  detectIgnoredSetupInstructionCollisions,
  detectSupervisionFindings,
  formatSupervisionFindingsComment,
} from "./supervision.js";
import type { TrackerIssueWriteRequest } from "./tracker-write.js";

/**
 * Synthetic verdict scope for pipeline-wide dispatch gates that are not
 * attributable to a single issue (e.g. the global rate-limit admission floor).
 * Keyed into the dispositions map alongside real issue ids (SYMPH-405).
 */
export const PIPELINE_VERDICT_SCOPE_ID = "__dispatch__";
export const PIPELINE_VERDICT_SCOPE_IDENTIFIER = "PIPELINE";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_DELAY_MS = 10_000;
const DEFAULT_DISPATCHER_LEASE_TTL_MS = 15 * 60_000;
const EXPLICIT_RESUME_STATE = "resume";
// Tracker timestamps come from the tracker's clock, pausedAt from ours.
// Evidence must beat the pause by this margin so modest clock skew cannot
// promote a PRE-pause transition into resume evidence (false auto-readmit).
// Transitions inside the margin stay parked — the operator can re-flip.
const RESUME_EVIDENCE_SKEW_MARGIN_MS = 60_000;
// Per-issue lookup throttle and per-poll cap keep the evidence phase from
// amplifying tracker API load when many issues are wedged.
const RESUME_EVIDENCE_RECHECK_MS = 60_000;
const RESUME_EVIDENCE_MAX_LOOKUPS_PER_POLL = 5;

interface ResumeRequiredGuard {
  pausedState: string | null;
  observedNonResumeState: boolean;
  /** When the pause was recorded — tracker resume evidence must be newer. */
  pausedAt: string | null;
  /** Last tracker evidence lookup (ms epoch) — throttles per-issue queries. */
  evidenceCheckedAtMs?: number;
  /**
   * Monotonic park generation. A deferred triage verdict is causally tied
   * to exactly one park; comparing generations makes a verdict for an
   * earlier park a no-op even when a re-park lands moments later.
   */
  parkSeq: number;
}

export type WorkerExitOutcome =
  | "normal"
  | "abnormal"
  | "failed_to_start"
  | "timed_out"
  | "error";

export type StopReason =
  | "terminal_state"
  | "inactive_state"
  | "stall_timeout"
  | "manual_stop";

export interface SpawnWorkerResult {
  workerHandle: unknown;
  monitorHandle: unknown;
}

export interface StopRequest {
  issueId: string;
  issueIdentifier: string;
  cleanupWorkspace: boolean;
  reason: StopReason;
}

export interface PollTickResult {
  validation: DispatchValidationResult;
  dispatchedIssueIds: string[];
  modeDecisions: RightSizingDecision[];
  stopRequests: StopRequest[];
  trackerFetchFailed: boolean;
  reconciliationFetchFailed: boolean;
  runningCount: number;
}

export interface RetryTimerResult {
  dispatched: boolean;
  released: boolean;
  retryEntry: RetryEntry | null;
}

export interface CodexEventResult {
  applied: boolean;
  /** True when the event carried a fresh rate-limit snapshot (SYMPH-336). */
  rateLimitsUpdated: boolean;
}

export interface ContinuousFeedbackCheckpointResult {
  ran: boolean;
  status: "pass" | "finding" | "skipped";
  event: ContinuousFeedbackEvent;
  reviewerLane: ContinuousFeedbackLane | null;
  workerLane: ContinuousFeedbackLane | null;
  findingSignatures: string[];
  summary: string | null;
}

export interface SupervisionResteerRequest {
  phase: "dispatch" | "running";
  findings: readonly SupervisionFinding[];
  comment: string;
}

interface DecorrelatedGateContext {
  mode: RightSizingMode;
  explicitModeHint: RightSizingMode | null;
  workerLane: DecorrelatedGateLane;
  reviewerLanes: DecorrelatedGateLane[];
  verifierSeparated: boolean;
}

export interface TimerScheduler {
  set(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> | null;
  clear(handle: ReturnType<typeof setTimeout> | null): void;
}

interface ScheduledRetryContext {
  attempt: number;
  identifier: string | null;
  delayType: "continuation" | "failure";
}

export interface OrchestratorCoreOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  spawnWorker: (input: {
    issue: Issue;
    attempt: number | null;
    stage: StageDefinition | null;
    stageName: string | null;
    reworkCount: number;
    isFirstDispatch: boolean;
    rightSizingDecision: RightSizingDecision;
    /** base * multiplier^escalationSteps for this issue (SYMPH-337); 1 when unescalated. */
    budgetMultiplier: number;
    /**
     * Frozen gate-passed AC snapshot for prompt rendering (SYMPH-374);
     * null before the gate has passed (e.g. the investigate stage itself).
     */
    acceptanceCriteria: string | null;
  }) => Promise<SpawnWorkerResult> | SpawnWorkerResult;
  onIssueDropped?: (input: {
    issueId: string;
    identifier: string;
    title: string | null;
    url: string | null;
    reason: string;
  }) => void;
  stopRunningIssue?: (input: {
    issueId: string;
    runningEntry: RunningEntry;
    cleanupWorkspace: boolean;
    reason: StopReason;
  }) => Promise<void> | void;
  runEnsembleGate?: (input: {
    issue: Issue;
    stage: StageDefinition;
  }) => Promise<EnsembleGateResult>;
  postComment?: (issueId: string, body: string) => Promise<void>;
  /**
   * LLM pause triage (SYMPH-337 slice 2): render a continue/split/hold
   * verdict for a budget pause the escalation ladder could not absorb.
   * Resolve null to fail closed to the operator pause.
   */
  runPauseTriage?: (
    evidence: PauseTriageEvidence,
  ) => Promise<PauseTriageVerdict | null>;
  /**
   * Serialize a deferred task with the host's event queue. When provided,
   * pause triage runs PARK-THEN-REVISE: the issue parks immediately (the
   * worker-exit path never waits on the local model — a slow box would
   * otherwise stall every lane behind the shared event queue) and the
   * verdict, whenever it arrives, is applied as a small serialized task
   * that can only UPGRADE a still-standing park into a resume.
   */
  scheduleDeferred?: (task: () => Promise<void>) => void;
  /**
   * AC falsifiability gate (SYMPH-354): render a pass/rework verdict over
   * the investigate worker's completion message. Resolve null to fail OPEN
   * (advance with a warning) — judge outages must not halt the fleet.
   */
  runAcGate?: (evidence: {
    issueIdentifier: string;
    issueTitle: string;
    issueDescription: string | null;
    completionMessage: string | null;
  }) => Promise<{ verdict: "pass" | "rework"; feedback: string } | null>;
  /**
   * Spec-fidelity judge lane (SYMPH-343): independent local-model verdict
   * over the workspace diff vs acceptance criteria at review-stage exit.
   * Advisory — the verdict journals and comments; resolve null for "no
   * opinion" (fail open, never blocks).
   */
  runSpecFidelityJudge?: (evidence: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    /**
     * Canonical AC snapshot frozen at AC-gate pass (SYMPH-374), or null
     * when no gate passed for this issue (gate disabled / legacy issue).
     */
    acceptanceCriteria: string | null;
    reviewMessage: string | null;
  }) => Promise<{ verdict: "pass" | "rework"; findings: string } | null>;
  updateIssueState?: (
    issueId: string,
    issueIdentifier: string,
    stateName: string,
  ) => Promise<void>;
  autoCloseParentIssue?: (
    issueId: string,
    issueIdentifier: string,
  ) => Promise<void>;
  getRunningSupervisionSnapshots?: (
    runningEntries: readonly RunningEntry[],
  ) => Promise<WorkerSupervisionSnapshot[]> | WorkerSupervisionSnapshot[];
  requestSupervisionResteer?: (
    input: SupervisionResteerRequest,
  ) => Promise<void> | void;
  requestTrackerIssueWrite?: (
    input: TrackerIssueWriteRequest,
  ) => Promise<void> | void;
  runContinuousFeedback?: (input: {
    issue: Issue;
    event: ContinuousFeedbackEvent;
    stageName: string | null;
    workerLane: ContinuousFeedbackLane;
    reviewerLane: ContinuousFeedbackLane;
  }) =>
    | Promise<ContinuousFeedbackReviewResult>
    | ContinuousFeedbackReviewResult;
  timerScheduler?: TimerScheduler;
  now?: () => Date;
  runJournal?: DispatcherRunJournal;
  leaseOwnerId?: string;
  leaseTtlMs?: number;
  writeRunJournalEntry?: (
    entry: DispatcherRunJournalEntry,
  ) => Promise<void> | void;
  /**
   * Called when an issue's retries are exhausted or it is loud-parked
   * (SYMPH-397). Fire-and-forget; failures must never surface into the
   * scheduling loop.
   */
  onFailureExhausted?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    reason: string;
    stageName: string | null;
    failureSignature: string | null;
    failureClass: string | null;
  }) => void;
  /**
   * Called when a hard-stop budget ceiling parks an issue and the escalation
   * ladder cannot absorb it (SYMPH-397). Fire-and-forget.
   */
  onHardStopBudget?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    trigger: string;
    reason: string;
    totalTokens: number;
    estimatedCostUsd: number;
  }) => void;
  /**
   * Called on each successful step of the budget-escalation ladder
   * (SYMPH-397). Fire-and-forget.
   */
  onEscalationStep?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    step: number;
    maxSteps: number;
    multiplier: number;
    trigger: string;
  }) => void;
  /**
   * Called when an ensemble gate returns a non-pass aggregate (SYMPH-397).
   * Fire-and-forget.
   */
  onGateFailed?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    reason: string;
  }) => void;
  /**
   * Called when a failure signature becomes SYSTEMIC (SYMPH-398): K distinct
   * issues share the same normalized signature. Fired once-per-signature and
   * re-fired when the cluster grows. Fire-and-forget.
   */
  onSystemicCluster?: (input: {
    signature: string;
    errorClass: string;
    stageName: string | null;
    clusterSize: number;
    issueIdentifiers: string[];
    breakerOpened: boolean;
    canFileWatchdogTicket: boolean;
    members: ClusterMember[];
  }) => void;
  /**
   * Called when an issue's dispatch verdict CHANGES to gate or halt
   * (SYMPH-405). Transitions-only: an unchanged verdict never re-fires.
   * Fire-and-forget; notifier absence/failure never blocks dispatch.
   */
  onVerdictTransition?: (input: {
    issueId: string;
    issueIdentifier: string;
    disposition: VerdictDisposition;
    reasonCode: string;
    remedy: string | null;
    actor: VerdictActor;
  }) => void;
  /**
   * Called when the dispatch-starvation page condition fires or recovers
   * (SYMPH-405): eligible candidates > 0 with zero dispatches for
   * verdicts.page_after_ticks consecutive ticks. One alert per episode;
   * re-fired only on recovery. Fire-and-forget.
   */
  onDispatchPage?: (input: {
    kind: "page" | "recovery";
    eligibleCount: number;
    consecutiveTicks: number;
  }) => void;
}

export class OrchestratorCore {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private readonly spawnWorker: OrchestratorCoreOptions["spawnWorker"];

  private readonly onIssueDropped?: OrchestratorCoreOptions["onIssueDropped"];

  private readonly stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];

  private readonly runEnsembleGate?: OrchestratorCoreOptions["runEnsembleGate"];

  private readonly postComment?: OrchestratorCoreOptions["postComment"];

  private readonly runPauseTriage?: OrchestratorCoreOptions["runPauseTriage"];

  private readonly scheduleDeferred?: OrchestratorCoreOptions["scheduleDeferred"];

  private readonly runAcGate?: OrchestratorCoreOptions["runAcGate"];

  private readonly runSpecFidelityJudge?: OrchestratorCoreOptions["runSpecFidelityJudge"];

  private readonly updateIssueState?: OrchestratorCoreOptions["updateIssueState"];

  private readonly autoCloseParentIssue?: OrchestratorCoreOptions["autoCloseParentIssue"];

  private readonly getRunningSupervisionSnapshots?: OrchestratorCoreOptions["getRunningSupervisionSnapshots"];

  private readonly requestSupervisionResteer?: OrchestratorCoreOptions["requestSupervisionResteer"];

  private readonly requestTrackerIssueWrite?: OrchestratorCoreOptions["requestTrackerIssueWrite"];

  private readonly runContinuousFeedback?: OrchestratorCoreOptions["runContinuousFeedback"];

  private readonly timerScheduler: TimerScheduler;

  private readonly now: () => Date;

  private readonly state: OrchestratorState;

  private readonly leaseOwnerId: string;

  private readonly leaseTtlMs: number;

  private readonly writeRunJournalEntry?: OrchestratorCoreOptions["writeRunJournalEntry"];

  private readonly onFailureExhausted?: OrchestratorCoreOptions["onFailureExhausted"];

  private readonly onHardStopBudget?: OrchestratorCoreOptions["onHardStopBudget"];

  private readonly onEscalationStep?: OrchestratorCoreOptions["onEscalationStep"];

  private readonly onGateFailed?: OrchestratorCoreOptions["onGateFailed"];

  private readonly onSystemicCluster?: OrchestratorCoreOptions["onSystemicCluster"];

  private readonly onVerdictTransition?: OrchestratorCoreOptions["onVerdictTransition"];

  private readonly onDispatchPage?: OrchestratorCoreOptions["onDispatchPage"];

  private readonly signatureClusterRegistry: SignatureClusterRegistry;

  /**
   * Last verdict idempotency base key per issue (SYMPH-405). Gates the
   * dedup-on-change behavior: an UNCHANGED disposition+reason for an issue
   * never appends a new journal entry on subsequent ticks.
   */
  private readonly lastVerdictKeys = new Map<string, string>();

  /** Consecutive poll ticks with eligible candidates but zero dispatches. */
  private starvedTickCount = 0;

  /** Whether the dispatch-starvation page alert is currently latched. */
  private pageAlertActive = false;

  /**
   * Ordered disk-flush chain for run-journal entries. Every disk append —
   * the awaited writer (recordRunJournalEntry) and the fire-and-forget
   * verdict writer (commitVerdictJournalEntrySync) — chains through this
   * queue, so disk order always equals in-memory sequence order: an entry's
   * write may lag, but a later sequence can never land before an earlier
   * one. Without it, a crash could leave sequence N+1 on disk without N and
   * replay would rebuild different breaker/cluster state than was alerted.
   */
  private runJournalDiskFlushQueue: Promise<void> = Promise.resolve();

  /**
   * Highest sequence ever rolled back by the awaited writer
   * (recordRunJournalEntry). A rolled-back tail entry is removed from the
   * in-memory journal, so naive tail+1 allocation would reissue its
   * sequence. The built-in appendFile writer cannot write-then-reject, but
   * the persistence-callback contract does not forbid it — a reissued
   * sequence could then produce two disk rows with the same seq. Burning
   * the number (never reissuing a rolled-back sequence) removes the class.
   */
  private burnedRunJournalSequence = 0;

  private readonly reportedSupervisionFindings = new Set<string>();

  private readonly reportedIgnoredSetupInstructionCollisions =
    new Set<string>();

  /**
   * Snapshot of execution history captured after the final stage record is
   * appended but before advanceStage() deletes issueExecutionHistory.
   * This prevents the runtime-host from falling back to stale preHistory
   * when a terminal transition clears the canonical history.
   */
  private readonly lastExitHistorySnapshot: Map<
    string,
    import("../domain/model.js").ExecutionHistory
  > = new Map();

  private parkSequence = 0;

  private readonly resumeRequiredGuards = new Map<
    string,
    ResumeRequiredGuard
  >();

  constructor(options: OrchestratorCoreOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.spawnWorker = options.spawnWorker;
    this.onIssueDropped = options.onIssueDropped;
    this.stopRunningIssue = options.stopRunningIssue;
    this.runEnsembleGate = options.runEnsembleGate;
    this.postComment = options.postComment;
    this.runPauseTriage = options.runPauseTriage;
    this.scheduleDeferred = options.scheduleDeferred;
    this.runAcGate = options.runAcGate;
    this.runSpecFidelityJudge = options.runSpecFidelityJudge;
    this.updateIssueState = options.updateIssueState;
    this.autoCloseParentIssue = options.autoCloseParentIssue;
    this.getRunningSupervisionSnapshots =
      options.getRunningSupervisionSnapshots;
    this.requestSupervisionResteer = options.requestSupervisionResteer;
    this.requestTrackerIssueWrite = options.requestTrackerIssueWrite;
    this.runContinuousFeedback = options.runContinuousFeedback;
    this.timerScheduler = options.timerScheduler ?? defaultTimerScheduler();
    this.now = options.now ?? (() => new Date());
    this.leaseOwnerId = options.leaseOwnerId ?? "orchestrator-core";
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_DISPATCHER_LEASE_TTL_MS;
    this.writeRunJournalEntry = options.writeRunJournalEntry;
    this.onFailureExhausted = options.onFailureExhausted;
    this.onHardStopBudget = options.onHardStopBudget;
    this.onEscalationStep = options.onEscalationStep;
    this.onGateFailed = options.onGateFailed;
    this.onSystemicCluster = options.onSystemicCluster;
    this.onVerdictTransition = options.onVerdictTransition;
    this.onDispatchPage = options.onDispatchPage;
    this.signatureClusterRegistry = new SignatureClusterRegistry({
      systemicThreshold: options.config.watchdog.systemicThreshold,
      circuitBreakerEnabled: options.config.watchdog.circuitBreaker,
      maxFilingsPerHour: options.config.watchdog.maxFilingsPerHour,
    });
    this.state = createInitialOrchestratorState({
      pollIntervalMs: options.config.polling.intervalMs,
      maxConcurrentAgents: options.config.agent.maxConcurrentAgents,
    });
    this.recoverFromRunJournal(options.runJournal ?? []);
  }

  getState(): OrchestratorState {
    return this.state;
  }

  recoverFromRunJournal(journal: DispatcherRunJournal): void {
    this.state.dispatcherRunJournal = [...journal].sort(
      (left, right) => left.sequence - right.sequence,
    );
    this.state.dispatcherLeases = rebuildDispatcherLeases(
      this.state.dispatcherRunJournal,
    );
    this.reportedSupervisionFindings.clear();
    this.reportedIgnoredSetupInstructionCollisions.clear();
    this.state.decorrelatedGateOutcomes = {};
    this.lastVerdictKeys.clear();
    this.state.issueDispositions = {};
    this.starvedTickCount = 0;
    this.pageAlertActive = false;

    const nowMs = this.now().getTime();
    for (const entry of this.state.dispatcherRunJournal) {
      if (
        entry.kind === "re_steer_request" &&
        entry.metadata.status === "completed" &&
        typeof entry.metadata.signature === "string"
      ) {
        this.reportedSupervisionFindings.add(entry.metadata.signature);
      }

      if (
        entry.kind === "supervision_finding" &&
        entry.metadata.findingKind === "ignored_setup_instruction_collision" &&
        typeof entry.metadata.signature === "string"
      ) {
        this.reportedIgnoredSetupInstructionCollisions.add(
          entry.metadata.signature,
        );
      }

      if (
        entry.kind === "hard_stop_trigger" &&
        entry.metadata.status === "completed"
      ) {
        this.recoverHardStopTrigger(entry);
      }

      if (
        entry.kind === "operator_input_required" &&
        entry.metadata.status === "completed"
      ) {
        this.markIssueRequiresExplicitResume(
          entry.issueId,
          readMetadataString(entry.metadata, "issueState"),
          entry.timestamp,
        );
      }

      if (
        entry.kind === "failure_exhausted" &&
        entry.metadata.status === "completed"
      ) {
        this.markIssueRequiresExplicitResume(
          entry.issueId,
          readMetadataString(entry.metadata, "issueState"),
          entry.timestamp,
        );
      }

      if (isDispatcherAdmissionEntry(entry)) {
        this.clearResumeRequirement(entry.issueId);
      }

      if (entry.kind === "right_sizing") {
        // Restore the first-dispatch marker (SYMPH-379): a journaled
        // right_sizing entry proves this issue already dispatched, so a
        // post-restart dispatch must not re-post the admission card.
        // Entries replay in sequence order; a later terminal entry clears
        // the marker via clearTerminalIssueRuntimeState. Normalized to the
        // same format the live path writes at dispatch.
        this.state.issueFirstDispatchedAt[entry.issueId] ??=
          formatEasternTimestamp(new Date(entry.timestamp));
      }

      if (
        entry.kind === "ac_gate" &&
        entry.metadata.status === "completed" &&
        (entry.metadata.verdict === "pass" ||
          entry.metadata.verdict === "pass_open") &&
        typeof entry.metadata.acceptanceCriteria === "string" &&
        entry.metadata.acceptanceCriteria.length > 0
      ) {
        // Rehydrate the frozen AC snapshot (SYMPH-374). Entries replay in
        // sequence order, so the latest gate-passed snapshot wins and a
        // later terminal entry clears it via clearTerminalIssueRuntimeState.
        this.state.issueAcSnapshots[entry.issueId] =
          entry.metadata.acceptanceCriteria;
      }

      if (entry.kind === "dispatch_verdict") {
        const pageEvent = readMetadataString(entry.metadata, "page_event");
        if (pageEvent === "page") {
          this.recoverDispatchPageLatch();
        } else if (pageEvent === "recovery") {
          this.pageAlertActive = false;
          this.starvedTickCount = 0;
        } else {
          this.recoverDispatchVerdict(entry);
        }
      }

      if (entry.kind === "cluster_transition") {
        this.recoverClusterTransition(entry);
      }

      if (entry.kind === "breaker_transition") {
        this.recoverBreakerTransition(entry);
      }

      if (
        entry.kind === "gate_result" &&
        entry.operation === "gate" &&
        entry.lease?.status === "completed"
      ) {
        const recovered = this.recoverDecorrelatedGateOutcome(entry);

        if (recovered?.status === "skipped_prototype") {
          this.state.completed.add(entry.issueId);
          this.releaseClaim(entry.issueId);
          this.clearTerminalIssueRuntimeState(entry.issueId);
        } else if (recovered !== null) {
          this.recoverCompletedGateTransition(entry, recovered);
        }
      }
    }

    for (const lease of Object.values(this.state.dispatcherLeases)) {
      if (
        lease.status === "active" &&
        lease.operation !== "tracker_write" &&
        Date.parse(lease.expiresAt) > nowMs
      ) {
        this.state.claimed.add(lease.issueId);
      }
    }
  }

  /**
   * Rehydrate the dispatch-starvation page latch from a journaled "page"
   * event with no later "recovery" (SYMPH-405 council R1). The latch is
   * restored as active with the tick counter resumed AT the page threshold:
   * the active latch guarantees no double-page (trackDispatchStarvation only
   * pages on a false→true latch transition), and the latch staying set until
   * a genuinely non-starved tick guarantees the recovery alert still fires —
   * a restart can neither re-page an already-paged episode nor silently
   * un-page it.
   */
  private recoverDispatchPageLatch(): void {
    this.pageAlertActive = true;
    this.starvedTickCount =
      this.config.verdicts?.pageAfterTicks ?? DEFAULT_VERDICTS_PAGE_AFTER_TICKS;
  }

  /**
   * Rehydrate the last-verdict dedup map and the dispositions surface from a
   * journaled dispatch_verdict entry (SYMPH-405). Entries replay in sequence
   * order, so the latest verdict per issue wins.
   */
  private recoverDispatchVerdict(entry: DispatcherRunJournalEntry): void {
    const disposition = toVerdictDisposition(entry.metadata.disposition);
    const reasonCode = readMetadataString(entry.metadata, "reason_code");
    if (disposition === null || reasonCode === null) {
      return;
    }
    this.lastVerdictKeys.set(
      entry.issueId,
      `verdict:${entry.issueId}:${disposition}:${reasonCode}`,
    );
    this.state.issueDispositions[entry.issueId] = {
      disposition,
      reasonCode,
      remedy: readMetadataString(entry.metadata, "remedy"),
      since: entry.timestamp,
    };
  }

  /**
   * Rehydrate the signature cluster registry from a journaled
   * cluster_transition entry (SYMPH-405 amendment 2): the registry consumes
   * its own journaled transitions on recovery so a deploy mid-systemic-
   * signature does not reset the count below the threshold. Each entry
   * carries the full membership snapshot; latest wins per signature.
   */
  private recoverClusterTransition(entry: DispatcherRunJournalEntry): void {
    const signature = readMetadataString(entry.metadata, "signature");
    const details =
      typeof entry.metadata.details === "object" &&
      entry.metadata.details !== null
        ? (entry.metadata.details as Record<string, unknown>)
        : null;
    if (signature === null || details === null) {
      return;
    }

    const members = toClusterMembers(details.members);
    if (members === null) {
      return;
    }

    const rawErrorClass = details.errorClass;
    const errorClass: ErrorSignatureClass =
      rawErrorClass === "permanent" || rawErrorClass === "transient"
        ? rawErrorClass
        : "unknown";
    const lastAlertSize =
      typeof details.lastAlertSize === "number" ? details.lastAlertSize : 0;

    this.signatureClusterRegistry.hydrateCluster({
      signature,
      errorClass,
      normalizedText:
        typeof details.normalizedText === "string"
          ? details.normalizedText
          : "",
      members,
      lastAlertSize,
    });
  }

  /**
   * Rehydrate stage circuit-breaker state from journaled breaker_transition
   * entries (SYMPH-405). Replayed in sequence order: an "opened" entry sets
   * the breaker, a later "closed" entry clears it.
   */
  private recoverBreakerTransition(entry: DispatcherRunJournalEntry): void {
    const transition = readMetadataString(entry.metadata, "transition");
    const stageName = readMetadataString(entry.metadata, "stage");
    const signature = readMetadataString(entry.metadata, "signature");
    if (transition === null || stageName === null || signature === null) {
      return;
    }

    if (transition === "closed") {
      this.signatureClusterRegistry.resetCircuitBreaker(stageName);
      return;
    }
    if (transition !== "opened") {
      return;
    }

    const details =
      typeof entry.metadata.details === "object" &&
      entry.metadata.details !== null
        ? (entry.metadata.details as Record<string, unknown>)
        : null;
    const openedForIssueIds = Array.isArray(details?.openedForIssueIds)
      ? details.openedForIssueIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    this.signatureClusterRegistry.hydrateBreakerOpen({
      stageName,
      signature,
      openedAt: entry.timestamp,
      openedForIssueIds,
    });
  }

  private recoverHardStopTrigger(entry: DispatcherRunJournalEntry): void {
    const reason =
      typeof entry.metadata.reason === "string" ? entry.metadata.reason : null;
    const outcome =
      typeof entry.metadata.outcome === "string"
        ? entry.metadata.outcome
        : null;

    if (reason === "stall_timeout" || reason === "terminal_state") {
      return;
    }

    // requestStop records manual/inactive stops in the same journal kind with
    // StopReason codes; budget and cost hard stops use outcome-bearing entries.
    if (
      reason === "manual_stop" ||
      reason === "inactive_state" ||
      outcome !== null
    ) {
      this.markIssueRequiresExplicitResume(
        entry.issueId,
        readMetadataString(entry.metadata, "issueState"),
        entry.timestamp,
      );
    }
  }

  private recoverDecorrelatedGateOutcome(
    entry: DispatcherRunJournalEntry,
  ): DecorrelatedGateOutcome | null {
    const recovered = toDecorrelatedGateOutcome(entry);
    if (recovered === null) {
      return null;
    }

    this.state.decorrelatedGateOutcomes[entry.issueId] = [
      ...(this.state.decorrelatedGateOutcomes[entry.issueId] ?? []),
      recovered,
    ];
    return recovered;
  }

  private recoverCompletedGateTransition(
    entry: DispatcherRunJournalEntry,
    outcome: DecorrelatedGateOutcome,
  ): void {
    if (this.config.stages === null || entry.stage === null) {
      return;
    }

    const gateStage = this.config.stages.stages[entry.stage];
    if (gateStage === undefined || gateStage.type !== "gate") {
      return;
    }

    if (
      (outcome.status === "failed" || outcome.status === "blocked") &&
      entry.metadata.terminal === true
    ) {
      this.state.failed.add(entry.issueId);
      this.releaseClaim(entry.issueId);
      this.clearTerminalIssueRuntimeState(entry.issueId);
      return;
    }

    const nextStage =
      outcome.status === "passed"
        ? gateStage.transitions.onApprove
        : outcome.status === "failed" || outcome.status === "blocked"
          ? (outcome.reworkTarget ?? gateStage.transitions.onRework)
          : null;

    if (nextStage === null) {
      return;
    }

    this.state.issueStages[entry.issueId] = nextStage;
    if (outcome.status === "failed" || outcome.status === "blocked") {
      const reworkCount = toOptionalNumber(entry.metadata.reworkCount);
      if (reworkCount !== null) {
        this.state.issueReworkCounts[entry.issueId] = reworkCount;
      }
    }
  }

  /**
   * Request a stop for a running issue identified by its human-readable
   * identifier (e.g. "SYMPH-209"). Returns the StopRequest if the issue was
   * running, or null if the identifier is not currently tracked as running.
   */
  async requestStopByIdentifier(
    issueIdentifier: string,
  ): Promise<StopRequest | null> {
    const runningEntry = Object.values(this.state.running).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (runningEntry === undefined) {
      return null;
    }

    return await this.requestStop(runningEntry, true, "manual_stop");
  }

  /**
   * Retrieve and consume the execution history snapshot captured during the
   * most recent onWorkerExit call for the given issue. Returns undefined if
   * no snapshot exists (e.g., the exit did not append a stage record).
   */
  consumeExitHistorySnapshot(
    issueId: string,
  ): import("../domain/model.js").ExecutionHistory | undefined {
    const snapshot = this.lastExitHistorySnapshot.get(issueId);
    if (snapshot !== undefined) {
      this.lastExitHistorySnapshot.delete(issueId);
    }
    return snapshot;
  }

  updateConfig(config: ResolvedWorkflowConfig): void {
    this.config = config;
    this.syncStateFromConfig();
  }

  updateTracker(tracker: IssueTracker): void {
    this.tracker = tracker;
  }

  isDispatchEligible(
    issue: Issue,
    options?: {
      allowClaimedIssueId?: string;
    },
  ): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    this.observeResumeRequiredState(issue.id, normalizedState);

    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined ||
      this.hasBlockingDispatcherLease(issue.id)
    ) {
      return false;
    }

    // Stop-like pauses are stricter than ordinary completions/failures:
    // leaving the issue in Todo should not redispatch it after an operator or
    // hard-stop policy asked for human review.
    if (this.state.resumeRequired.has(issue.id)) {
      if (this.canConsumeResumeRequirement(issue.id, normalizedState)) {
        this.state.completed.delete(issue.id);
        this.state.failed.delete(issue.id);
        // Clear exhaustion-dedup marker so a re-dispatched issue can fire the
        // failure_exhausted alert again if it exhausts retries in this new
        // lifecycle (SYMPH-397).
        this.state.failureExhaustedIds.delete(issue.id);
        // Clear from signature cluster so a resumed issue re-counts fresh
        // if it fails again, and close any stage breaker opened for it so the
        // resumed issue is not immediately re-parked at the dispatch boundary
        // (SYMPH-398 — these two must happen together or the resume deadlocks).
        this.signatureClusterRegistry.clearIssueFromCluster(issue.id);
        this.resetBreakersForResumedIssue(issue.id);
        this.clearResumeRequirement(issue.id);
      } else {
        // The 2026-06-11 invisible skip (SYMPH-405): a stop-like pause waits
        // for an explicit Resume, and Todo alone is silently skipped.
        this.recordDispatchVerdict({
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          disposition: "skip",
          reasonCode: "requires_explicit_resume",
          remedy: "transition the issue into Resume (Todo alone is skipped)",
          details: { issueState: issue.state },
        });
        return false;
      }
    }

    // Allow ordinary completed/failed issues to be rerun from a
    // resume-designated state ("Resume" or "Todo"). Stop-like pauses are
    // handled above and require the stricter explicit Resume state.
    if (this.state.completed.has(issue.id) || this.state.failed.has(issue.id)) {
      const resumeStates: ReadonlySet<string> = new Set(["resume", "todo"]);
      if (resumeStates.has(normalizedState)) {
        this.state.completed.delete(issue.id);
        this.state.failed.delete(issue.id);
        // Clear exhaustion-dedup marker so the resumed issue starts a fresh
        // exhaustion lifecycle (SYMPH-397).
        this.state.failureExhaustedIds.delete(issue.id);
        // Clear from signature cluster so a resumed issue re-counts fresh
        // if it fails again, and close any stage breaker opened for it so the
        // resumed issue is not immediately re-parked at the dispatch boundary
        // (SYMPH-398 — these two must happen together or the resume deadlocks).
        this.signatureClusterRegistry.clearIssueFromCluster(issue.id);
        this.resetBreakersForResumedIssue(issue.id);
      } else {
        return false;
      }
    }

    const allowClaimedIssueId = options?.allowClaimedIssueId;
    if (
      this.state.claimed.has(issue.id) &&
      (allowClaimedIssueId === undefined || allowClaimedIssueId !== issue.id)
    ) {
      this.recordDispatchVerdict({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: "skip",
        reasonCode: "claimed",
        remedy:
          "Wait for the active claim/lease on this issue to complete or expire.",
      });
      return false;
    }

    if (this.availableSlots() <= 0) {
      this.recordDispatchVerdict({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: "skip",
        reasonCode: "no_slots",
        remedy:
          "Wait for a running worker to finish or raise agent.max_concurrent_agents.",
        details: { maxConcurrentAgents: this.state.maxConcurrentAgents },
      });
      return false;
    }

    if (this.availableSlotsForState(issue.state) <= 0) {
      this.recordDispatchVerdict({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: "skip",
        reasonCode: "no_state_slots",
        remedy: `Wait for a worker in state "${issue.state}" to finish or raise agent.max_concurrent_agents_by_state.`,
        details: { issueState: issue.state },
      });
      return false;
    }

    const openBlockers = issue.blockedBy.filter((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState === null || !terminalStates.has(blockerState);
    });
    if (openBlockers.length > 0) {
      this.recordDispatchVerdict({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: "skip",
        reasonCode: "blocked_by_open",
        remedy:
          "Close (or move to a terminal state) the blocking issues listed in details.",
        details: {
          blockers: openBlockers.map((blocker) => ({
            id: blocker.id,
            identifier: blocker.identifier,
            state: blocker.state,
          })),
        },
      });
      return false;
    }

    return true;
  }

  async pollTick(): Promise<PollTickResult> {
    this.syncStateFromConfig();
    await this.expireDispatcherLeases();

    const reconcileResult = await this.reconcileRunningIssues();
    const supervisionStops = await this.superviseRunningWorkers();
    reconcileResult.stopRequests.push(...supervisionStops);
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      return {
        validation,
        dispatchedIssueIds: [],
        modeDecisions: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        validation,
        dispatchedIssueIds: [],
        modeDecisions: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: true,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    await this.applyTrackerResumeEvidence(issues);

    // Check for pipeline-halt before dispatching
    const haltIssue = await this.checkPipelineHalt();
    if (haltIssue !== null) {
      console.warn(
        `[orchestrator] Pipeline halted: ${haltIssue.identifier} — ${haltIssue.title}. Skipping all dispatch.`,
      );
      // One journal-level halt verdict keyed on the halt issue; the
      // per-candidate skip is implied (SYMPH-405).
      this.recordDispatchVerdict({
        issueId: haltIssue.id,
        issueIdentifier: haltIssue.identifier,
        disposition: "halt",
        reasonCode: "pipeline_halt",
        remedy: `Move the pipeline-halt issue ${haltIssue.identifier} to a terminal state to resume dispatch.`,
        details: { haltIssueTitle: haltIssue.title },
      });
      this.trackDispatchStarvation(issues.length, 0);
      return {
        validation,
        dispatchedIssueIds: [],
        modeDecisions: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    // Refuse new admissions while observed Codex rate-limit headroom is
    // below the configured floor (SYMPH-333). Running lanes are unaffected.
    const rateLimitGate = this.evaluateRateLimitAdmissionGate();
    if (rateLimitGate.blocked) {
      console.warn(
        `[orchestrator] ${rateLimitGate.reason} Skipping all dispatch.`,
      );
      // The admission floor is pipeline-wide, not per-issue: one verdict on
      // the synthetic dispatch scope (SYMPH-405).
      const gateVerdict = this.buildRateLimitGateVerdict(rateLimitGate);
      this.recordDispatchVerdict({
        issueId: PIPELINE_VERDICT_SCOPE_ID,
        issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
        disposition: "gate",
        reasonCode: gateVerdict.reasonCode,
        remedy: gateVerdict.remedy,
        details: gateVerdict.details,
      });
      this.trackDispatchStarvation(issues.length, 0);
      return {
        validation,
        dispatchedIssueIds: [],
        modeDecisions: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    // Gate recovery: journal the flip back so the verdict stream shows when
    // the floor stopped blocking (SYMPH-405). Dedup map suppresses repeats.
    if (this.lastVerdictKeys.has(PIPELINE_VERDICT_SCOPE_ID)) {
      this.recordDispatchVerdict({
        issueId: PIPELINE_VERDICT_SCOPE_ID,
        issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
        disposition: "admit",
        reasonCode: "rate_window_clear",
      });
    }

    const dispatchedIssueIds: string[] = [];
    const modeDecisions: RightSizingDecision[] = [];
    let eligibleCount = 0;
    const admittedSnapshots = this.buildRunningAdmissionSnapshots();
    for (const issue of sortIssuesForDispatch(issues)) {
      if (this.availableSlots() <= 0) {
        break;
      }

      if (!this.isDispatchEligible(issue)) {
        continue;
      }

      const candidateSnapshot = createIssueSupervisionSnapshot(issue);
      const findings = this.detectDispatchAdmissionFindings(
        admittedSnapshots,
        candidateSnapshot,
      );
      if (findings.length > 0) {
        await this.recordDispatcherDecisionEvent({
          decisionId: `${issue.id}:dispatch:${formatAttemptKey(null)}:admission`,
          category: "admission",
          classifier: "deterministic-disjointness-v1",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          operation: "dispatcher",
          stage: null,
          attempt: null,
          summary: `Measured admission paused ${issue.identifier} due to deterministic overlap findings.`,
          context: {
            reason:
              "Deterministic dispatch supervision found overlapping scope before admission.",
            triggerHits: [],
            findingKinds: findings.map((finding) => finding.kind),
            files: findings.flatMap((finding) => finding.files),
            workerIds: findings.flatMap((finding) => finding.workerIds),
            details: {
              phase: "dispatch",
              issueState: issue.state,
            },
          },
          expectedOutcome: {
            decision: "pause",
            classification: "positive",
            rationale:
              "Admission must block co-runs when deterministic overlap exists.",
            costWeight: "medium",
          },
          observedOutcome: {
            decision: "pause",
            classification: "positive",
            rationale:
              "Dispatch remained paused after deterministic admission findings.",
            costWeight: "medium",
          },
        });
        await this.reportSupervisionFindings("dispatch", findings);
        continue;
      }

      // Counted at the FINAL admission boundary: candidates paused by
      // deterministic admission findings are journaled as dispatcher
      // decisions, not verdicts, so counting them as "eligible" would let
      // the starvation page fire while the dispositions map it points at
      // cannot explain the block.
      eligibleCount += 1;

      const dispatchResult = await this.dispatchIssue(issue, null);
      if (dispatchResult.dispatched) {
        dispatchedIssueIds.push(issue.id);
        modeDecisions.push(dispatchResult.rightSizingDecision);
        admittedSnapshots.push(candidateSnapshot);
      }
    }

    this.trackDispatchStarvation(eligibleCount, dispatchedIssueIds.length);

    return {
      validation,
      dispatchedIssueIds,
      modeDecisions,
      stopRequests: reconcileResult.stopRequests,
      trackerFetchFailed: false,
      reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
      runningCount: Object.keys(this.state.running).length,
    };
  }

  /**
   * Evaluate the global rate-limit headroom dispatch floor (SYMPH-333).
   * Fails open when no snapshot has been observed yet (e.g. right after a
   * restart, before any worker has run) or when a window's resets_at has
   * passed — a stale pre-reset snapshot must not block dispatch forever.
   */
  private evaluateRateLimitAdmissionGate(): {
    blocked: boolean;
    reason: string | null;
    /** Structured floor violations for verdict reason codes (SYMPH-405). */
    floorViolations: Array<{
      window: "primary" | "secondary";
      floorPct: number;
      headroomPct: number;
    }>;
  } {
    const floors = this.config.rateLimitAdmission;
    if (
      floors.minPrimaryHeadroomPct === null &&
      floors.minSecondaryHeadroomPct === null
    ) {
      this.state.rateLimitAdmission = null;
      return { blocked: false, reason: null, floorViolations: [] };
    }

    const now = this.now();
    const snapshot = parseRateLimitSnapshot(this.state.codexRateLimits);
    const primary = evaluateWindowHeadroom(
      snapshot?.primary ?? null,
      now.getTime(),
    );
    const secondary = evaluateWindowHeadroom(
      snapshot?.secondary ?? null,
      now.getTime(),
    );

    const violations: string[] = [];
    const floorViolations: Array<{
      window: "primary" | "secondary";
      floorPct: number;
      headroomPct: number;
    }> = [];
    if (
      floors.minPrimaryHeadroomPct !== null &&
      primary !== null &&
      !primary.expired &&
      primary.remainingPercent < floors.minPrimaryHeadroomPct
    ) {
      violations.push(
        `primary window headroom ${primary.remainingPercent.toFixed(1)}% < ${floors.minPrimaryHeadroomPct}% floor`,
      );
      floorViolations.push({
        window: "primary",
        floorPct: floors.minPrimaryHeadroomPct,
        headroomPct: primary.remainingPercent,
      });
    }
    if (
      floors.minSecondaryHeadroomPct !== null &&
      secondary !== null &&
      !secondary.expired &&
      secondary.remainingPercent < floors.minSecondaryHeadroomPct
    ) {
      violations.push(
        `secondary window headroom ${secondary.remainingPercent.toFixed(1)}% < ${floors.minSecondaryHeadroomPct}% floor`,
      );
      floorViolations.push({
        window: "secondary",
        floorPct: floors.minSecondaryHeadroomPct,
        headroomPct: secondary.remainingPercent,
      });
    }

    const blocked = violations.length > 0;
    const reason = blocked
      ? `Codex rate-limit headroom below dispatch floor: ${violations.join("; ")}. New dispatches refused until the window resets.`
      : null;

    this.state.rateLimitAdmission = {
      blocked,
      reason,
      evaluatedAt: now.toISOString(),
      minPrimaryHeadroomPct: floors.minPrimaryHeadroomPct,
      minSecondaryHeadroomPct: floors.minSecondaryHeadroomPct,
      primaryUsedPercent:
        primary !== null && !primary.expired ? primary.usedPercent : null,
      secondaryUsedPercent:
        secondary !== null && !secondary.expired ? secondary.usedPercent : null,
    };

    return { blocked, reason, floorViolations };
  }

  /**
   * Build the verdict fields for a blocked rate-limit admission gate
   * (SYMPH-405): stable reason code per violated window plus a remedy that
   * includes the configured floor and observed headroom.
   */
  private buildRateLimitGateVerdict(
    gate: ReturnType<OrchestratorCore["evaluateRateLimitAdmissionGate"]>,
  ): { reasonCode: string; remedy: string; details: Record<string, unknown> } {
    const violation = gate.floorViolations[0];
    const reasonCode =
      violation?.window === "secondary"
        ? "rate_window_secondary_floor"
        : "rate_window_primary_floor";
    const remedy =
      violation !== undefined
        ? `Wait for the ${violation.window} rate-limit window to reset: floor ${violation.floorPct}% headroom, observed ${violation.headroomPct.toFixed(1)}%.`
        : "Wait for the rate-limit window to reset.";
    return {
      reasonCode,
      remedy,
      details: { floorViolations: gate.floorViolations },
    };
  }

  budgetMultiplierForIssue(issueId: string): number {
    const steps = this.state.issueBudgetEscalations[issueId] ?? 0;
    if (steps <= 0) {
      return 1;
    }
    return this.config.budgetEscalation.multiplier ** steps;
  }

  /**
   * Deterministic budget-escalation ladder (SYMPH-337 slice 1). A budget
   * hard stop auto-resumes as a continuation with a multiplied unit budget
   * when the ladder is configured, steps remain, and the rate-limit floor
   * admits. Anything else falls through to the operator pause. no_progress,
   * iteration_cap, and permission stops are never escalated — by the time a
   * budget trigger fires, the no-progress guard has already vouched that the
   * unit was moving.
   */
  private async tryBudgetEscalation(
    issueId: string,
    runningEntry: RunningEntry,
    hardStop: HardStopDecision,
    stageName: string | null,
  ): Promise<RetryEntry | null> {
    if (hardStop.outcome !== "PAUSED-budget") {
      return null;
    }
    if (!isBudgetEscalationTrigger(hardStop.trigger)) {
      return null;
    }

    const ladder = this.config.budgetEscalation;
    if (ladder.maxSteps === null) {
      return null;
    }

    const steps = this.state.issueBudgetEscalations[issueId] ?? 0;
    if (steps >= ladder.maxSteps) {
      console.warn(
        `[orchestrator] Budget escalation exhausted for ${runningEntry.identifier} (${steps}/${ladder.maxSteps} steps used) — parking for operator.`,
      );
      return null;
    }

    const gate = this.evaluateRateLimitAdmissionGate();
    if (gate.blocked) {
      console.warn(
        `[orchestrator] Budget escalation deferred to operator for ${runningEntry.identifier}: ${gate.reason}`,
      );
      return null;
    }

    const nextStep = steps + 1;
    const nextMultiplier = ladder.multiplier ** nextStep;

    await this.recordRunJournalEntry({
      idempotencyKey: `budget_escalation:${issueId}:${stageName ?? "no-stage"}:${nextStep}`,
      timestamp: this.now().toISOString(),
      kind: "budget_escalation",
      issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt: runningEntry.retryAttempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Budget escalation step ${nextStep}/${ladder.maxSteps} for ${runningEntry.identifier}: auto-resuming with ${nextMultiplier}x unit budget after ${hardStop.trigger}.`,
      metadata: {
        status: "completed",
        trigger: hardStop.trigger,
        step: nextStep,
        maxSteps: ladder.maxSteps,
        multiplier: nextMultiplier,
        totalTokens: hardStop.totalTokens,
        estimatedCostUsd: hardStop.estimatedCostUsd,
      },
    });

    // Increment only after the journal write succeeded so an exception above
    // leaves the issue un-escalated and the pause falls through to the
    // operator park (PR #329 review P1).
    this.state.issueBudgetEscalations[issueId] = nextStep;

    const comment = [
      `Budget escalation step ${nextStep}/${ladder.maxSteps}: auto-resuming with a ${nextMultiplier}x unit budget.`,
      `Trigger: ${hardStop.trigger}`,
      `Reason: ${hardStop.reason}`,
      `Unit spend at pause: ${hardStop.billableTokens ?? hardStop.totalTokens} billable tokens (raw ${hardStop.totalTokens}), ~$${hardStop.estimatedCostUsd.toFixed(2)}.`,
    ].join("\n");
    try {
      await this.postComment?.(issueId, comment);
    } catch {
      // Observability is best-effort; the resume must not depend on Linear.
    }

    // Fire-and-forget escalation step notification (SYMPH-397).
    try {
      this.onEscalationStep?.({
        issueId,
        issueIdentifier: runningEntry.identifier,
        issueTitle: runningEntry.issue.title,
        stageName,
        step: nextStep,
        maxSteps: ladder.maxSteps,
        multiplier: nextMultiplier,
        trigger: hardStop.trigger,
      });
    } catch {
      // Notification failures are always swallowed
    }

    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: null,
      delayType: "continuation",
    });
  }

  /**
   * LLM pause triage (SYMPH-337 slice 2): consulted only for budget pauses
   * the ladder declined (exhausted or unconfigured), gated by the same
   * trigger set, the admission floor, and a per-issue resume bound. A
   * `continue` verdict grants exactly one continuation at the issue's
   * current budget ceiling; everything else (split/hold/null/failure)
   * parks for the operator with the verdict recorded.
   */
  private async tryPauseTriageResume(
    issueId: string,
    runningEntry: RunningEntry,
    hardStop: HardStopDecision,
    stageName: string | null,
  ): Promise<RetryEntry | null> {
    if (this.runPauseTriage === undefined) {
      return null;
    }
    if (hardStop.outcome !== "PAUSED-budget") {
      return null;
    }
    if (!isBudgetEscalationTrigger(hardStop.trigger)) {
      return null;
    }

    const resumesUsed = this.state.issuePauseTriageResumes[issueId] ?? 0;
    if (resumesUsed >= this.config.pauseTriage.maxResumes) {
      return null;
    }

    const gate = this.evaluateRateLimitAdmissionGate();
    if (gate.blocked) {
      return null;
    }

    const evidence: PauseTriageEvidence = {
      issueIdentifier: runningEntry.identifier,
      issueTitle: runningEntry.issue.title,
      stageName,
      hardStop,
      escalationStepsUsed: this.state.issueBudgetEscalations[issueId] ?? 0,
      triageResumesUsed: resumesUsed,
      reworkCount: this.state.issueReworkCounts[issueId] ?? 0,
      recentActivity: runningEntry.recentActivity.map((entry) => ({
        toolName: entry.toolName,
        context: entry.context,
      })),
      lastMessage: runningEntry.lastCodexMessage,
      stageHistory: (this.state.issueExecutionHistory[issueId] ?? []).map(
        (record) => ({
          stageName: record.stageName,
          outcome: record.outcome,
          turns: record.turns,
        }),
      ),
    };

    if (this.scheduleDeferred !== undefined) {
      // Park-then-revise: fall through to the normal park (return null)
      // while the verdict renders out-of-band. The local model may take
      // minutes under contention; nothing in the event queue waits on it.
      const runTriage = this.runPauseTriage;
      const scheduleDeferred = this.scheduleDeferred;
      // Capture the originating park's generation through the same
      // serialized queue: this task runs right after the current exit
      // handler records the park and before any re-park can possibly be
      // processed, causally tying the verdict to exactly this pause.
      const parkSeqAtFire = new Promise<number | null>((resolve) => {
        scheduleDeferred(async () => {
          resolve(this.resumeRequiredGuards.get(issueId)?.parkSeq ?? null);
        });
      });
      const verdictPromise = runTriage(evidence).catch((error) => {
        console.warn(
          `[orchestrator] deferred pause triage failed for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      void Promise.all([verdictPromise, parkSeqAtFire])
        .then(([verdict, expectedParkSeq]) => {
          scheduleDeferred(() =>
            this.applyDeferredPauseTriageVerdict({
              issueId,
              identifier: runningEntry.identifier,
              stageName,
              trigger: hardStop.trigger,
              resumesUsedAtFire: resumesUsed,
              attempt: runningEntry.retryAttempt,
              expectedParkSeq,
              verdict,
            }),
          );
        })
        .catch((error) => {
          // Final rejection boundary: nothing in this chain may become an
          // unhandled rejection; the park already stands either way.
          console.warn(
            `[orchestrator] deferred pause triage chain failed for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return null;
    }

    let verdict: PauseTriageVerdict | null = null;
    try {
      verdict = await this.runPauseTriage(evidence);
    } catch {
      verdict = null;
    }

    const willResume = verdict !== null && verdict.verdict === "continue";
    if (willResume) {
      this.state.issuePauseTriageResumes[issueId] = resumesUsed + 1;
    }

    // Journal the verdict together with the action actually taken so the
    // audit trail can never claim a resume that did not happen (PR #330
    // review P2). Journaling is best-effort relative to the resume itself.
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `pause_triage:${issueId}:${stageName ?? "no-stage"}:${resumesUsed + 1}:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "pause_triage",
        issueId,
        issueIdentifier: runningEntry.identifier,
        operation: "dispatcher",
        stage: stageName,
        attempt: runningEntry.retryAttempt,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary:
          verdict === null
            ? `Pause triage unavailable for ${runningEntry.identifier}; parking for operator.`
            : `Pause triage verdict for ${runningEntry.identifier}: ${verdict.verdict} (${willResume ? "resuming" : "parking"}).`,
        metadata: {
          status: "completed",
          trigger: hardStop.trigger,
          verdict: verdict?.verdict ?? "unavailable",
          rationale: verdict?.rationale ?? null,
          action: willResume ? "resumed" : "parked",
          resumesUsed,
        },
      });
    } catch {
      // Audit is best-effort; the verdict outcome must still apply.
    }

    if (verdict === null || verdict.verdict !== "continue") {
      if (verdict !== null) {
        try {
          await this.postComment?.(
            issueId,
            `Pause triage verdict: ${verdict.verdict}\n${verdict.rationale}`,
          );
        } catch {
          // Observability only.
        }
      }
      return null;
    }

    try {
      await this.postComment?.(
        issueId,
        [
          `Pause triage verdict: continue (resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes})`,
          verdict.rationale,
          "Auto-resuming one continuation unit at the current budget ceiling.",
        ].join("\n"),
      );
    } catch {
      // Observability only.
    }

    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: null,
      delayType: "continuation",
    });
  }

  /**
   * Apply an out-of-band triage verdict to a park that may no longer be
   * standing. The verdict can only UPGRADE: `continue` un-parks and
   * schedules one continuation; everything else just records itself.
   * Guards make stale verdicts no-ops: the issue must still be parked,
   * idle, with the same consumed-resume count as when the verdict was
   * requested, and the standing park must have been recorded within a
   * short window of the pause that requested it.
   */
  private async applyDeferredPauseTriageVerdict(input: {
    issueId: string;
    identifier: string;
    stageName: string | null;
    trigger: HardStopTrigger;
    resumesUsedAtFire: number;
    attempt: number | null;
    expectedParkSeq: number | null;
    verdict: PauseTriageVerdict | null;
  }): Promise<void> {
    const { issueId, identifier, stageName, verdict } = input;

    const guard = this.resumeRequiredGuards.get(issueId);
    const parkMatchesPause =
      input.expectedParkSeq !== null &&
      guard !== undefined &&
      guard.parkSeq === input.expectedParkSeq;
    const resumesUsed = this.state.issuePauseTriageResumes[issueId] ?? 0;
    const stillEligible =
      this.state.resumeRequired.has(issueId) &&
      !(issueId in this.state.running) &&
      this.state.retryAttempts[issueId] === undefined &&
      resumesUsed === input.resumesUsedAtFire &&
      parkMatchesPause;

    const willResume =
      stillEligible && verdict !== null && verdict.verdict === "continue";
    const action = willResume ? "resumed" : stillEligible ? "parked" : "stale";

    if (willResume) {
      this.state.issuePauseTriageResumes[issueId] = resumesUsed + 1;
    }

    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `pause_triage:${issueId}:${stageName ?? "no-stage"}:${input.resumesUsedAtFire + 1}:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "pause_triage",
        issueId,
        issueIdentifier: identifier,
        operation: "dispatcher",
        stage: stageName,
        attempt: input.attempt,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary:
          verdict === null
            ? `Pause triage unavailable for ${identifier}; parking for operator.`
            : `Pause triage verdict for ${identifier}: ${verdict.verdict} (${action === "resumed" ? "resuming" : action === "stale" ? "stale" : "parking"}).`,
        metadata: {
          status: "completed",
          trigger: input.trigger,
          verdict: verdict?.verdict ?? "unavailable",
          rationale: verdict?.rationale ?? null,
          action,
          resumesUsed: input.resumesUsedAtFire,
        },
      });
    } catch {
      // Audit is best-effort; the verdict outcome must still apply.
    }

    if (!willResume) {
      if (verdict !== null && stillEligible) {
        try {
          await this.postComment?.(
            issueId,
            `Pause triage verdict: ${verdict.verdict}\n${verdict.rationale}`,
          );
        } catch {
          // Observability only.
        }
      }
      return;
    }

    this.clearResumeRequirement(issueId);

    try {
      await this.postComment?.(
        issueId,
        [
          `Pause triage verdict: continue (resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes})`,
          verdict.rationale,
          "Auto-resuming one continuation unit at the current budget ceiling.",
        ].join("\n"),
      );
    } catch {
      // Observability only.
    }

    this.scheduleRetry(issueId, 1, {
      identifier,
      error: null,
      delayType: "continuation",
    });
  }

  /**
   * Route a deferred AC-gate verdict (SYMPH-354). pass → advance stage and
   * continue; rework → post the feedback as Review Findings and rerun the
   * same stage (the rework prompt path reads those comments); null →
   * FAIL OPEN: advance with a warning. Guards no-op if anything moved the
   * issue meanwhile.
   *
   * On pass/pass_open the AC section of the completion message is frozen
   * as the issue's canonical rubric (SYMPH-374): journaled for replay and
   * held in state for the spec-fidelity judge and implement prompts. The
   * workpad copy stays operator-visible but is never trusted again — the
   * implement worker is instructed to edit it (checking items off), so a
   * downstream stage must not be able to re-author what it is judged
   * against.
   */
  private async applyAcGateVerdict(input: {
    issueId: string;
    identifier: string;
    stageName: string;
    verdict: { verdict: "pass" | "rework"; feedback: string } | null;
    completionMessage: string | null;
  }): Promise<void> {
    const { issueId, identifier, stageName, verdict } = input;

    if (
      issueId in this.state.running ||
      this.state.retryAttempts[issueId] !== undefined ||
      this.state.resumeRequired.has(issueId) ||
      this.state.issueStages[issueId] !== stageName
    ) {
      return;
    }

    const action =
      verdict === null
        ? "pass_open"
        : verdict.verdict === "pass"
          ? "pass"
          : "rework";

    const acceptanceCriteria =
      action === "rework"
        ? null
        : extractAcceptanceCriteria(input.completionMessage);
    if (acceptanceCriteria !== null) {
      this.state.issueAcSnapshots[issueId] = acceptanceCriteria;
    }

    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `ac_gate:${issueId}:${stageName}:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "ac_gate",
        issueId,
        issueIdentifier: identifier,
        operation: "dispatcher",
        stage: stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary:
          verdict === null
            ? `AC gate unavailable for ${identifier}; advancing (fail open).`
            : `AC gate verdict for ${identifier}: ${verdict.verdict}.`,
        metadata: {
          status: "completed",
          verdict: action,
          feedback: verdict?.feedback ?? null,
          acceptanceCriteria,
        },
      });
    } catch (error) {
      // Audit best-effort, but never silent for the snapshot entry: the
      // live process keeps the in-state snapshot (judge correctness over
      // audit purity) while restart rehydration is journal-only, so a
      // failed write means the snapshot will NOT survive a restart.
      console.warn(
        `[orchestrator] ac_gate journal write failed for ${identifier}; AC snapshot will not survive restart: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (action === "rework" && verdict !== null) {
      try {
        await this.postComment?.(
          issueId,
          `## Review Findings (AC gate)\n${verdict.feedback}\nRevise the workpad acceptance criteria per the contract (test:/check:/judge: tags, falsifiable, covering the ticket intent) and complete the stage again.`,
        );
      } catch {
        // Observability only.
      }
      // Clear any stored failure signature for this stage so the first failure
      // of the reworked run gets a normal retry rather than false-parking
      // against a stale signature from a prior visit (SYMPH-396).
      this.clearStageFailureSignature(issueId, stageName);
      this.scheduleRetry(issueId, 1, {
        identifier,
        error: null,
        delayType: "continuation",
      });
      return;
    }

    if (verdict === null) {
      console.warn(
        `[orchestrator] AC gate unavailable for ${identifier}; advancing fail-open.`,
      );
    }
    const transition = this.advanceStage(issueId, identifier);
    if (transition === "completed") {
      this.state.completed.add(issueId);
      this.releaseClaim(issueId);
      return;
    }
    this.scheduleRetry(issueId, 1, {
      identifier,
      error: null,
      delayType: "continuation",
    });
  }

  private async recordSpecFidelityVerdict(input: {
    issueId: string;
    identifier: string;
    stageName: string;
    verdict: { verdict: "pass" | "rework"; findings: string };
  }): Promise<void> {
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `spec_fidelity:${input.issueId}:${input.stageName}:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "spec_fidelity",
        issueId: input.issueId,
        issueIdentifier: input.identifier,
        operation: "dispatcher",
        stage: input.stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Spec-fidelity verdict for ${input.identifier}: ${input.verdict.verdict}.`,
        metadata: {
          status: "completed",
          verdict: input.verdict.verdict,
          findings: input.verdict.findings,
        },
      });
    } catch {
      // Audit best-effort.
    }
    try {
      await this.postComment?.(
        input.issueId,
        `## Spec-fidelity verdict (independent judge): ${input.verdict.verdict}\n${input.verdict.findings}`,
      );
    } catch {
      // Observability only.
    }
  }

  async onRetryTimer(issueId: string): Promise<RetryTimerResult> {
    await this.expireDispatcherLeases();

    const retryEntry = this.state.retryAttempts[issueId];
    if (retryEntry === undefined) {
      return {
        dispatched: false,
        released: false,
        retryEntry: null,
      };
    }

    // Check for pipeline-halt before dispatching — fail-open on errors
    const haltIssue = await this.checkPipelineHalt();
    if (haltIssue !== null) {
      console.warn(
        `[orchestrator] Pipeline halted: ${haltIssue.identifier} — ${haltIssue.title}. Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      // Journal-level halt verdict keyed on the halt issue (SYMPH-405); the
      // per-candidate deferral is implied.
      this.recordDispatchVerdict({
        issueId: haltIssue.id,
        issueIdentifier: haltIssue.identifier,
        disposition: "halt",
        reasonCode: "pipeline_halt",
        remedy: `Move the pipeline-halt issue ${haltIssue.identifier} to a terminal state to resume dispatch.`,
        details: { haltIssueTitle: haltIssue.title },
      });
      // Don't consume the retry attempt — reschedule at the same attempt number
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: `pipeline halted: ${haltIssue.identifier}`,
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    // Rate-limit admission floor applies to retry/continuation dispatch too
    // (SYMPH-337): auto-resumes must never burn into protected headroom.
    const rateLimitGate = this.evaluateRateLimitAdmissionGate();
    if (rateLimitGate.blocked) {
      console.warn(
        `[orchestrator] ${rateLimitGate.reason} Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      const gateVerdict = this.buildRateLimitGateVerdict(rateLimitGate);
      this.recordDispatchVerdict({
        issueId,
        issueIdentifier: retryEntry.identifier ?? issueId,
        disposition: "gate",
        reasonCode: gateVerdict.reasonCode,
        remedy: gateVerdict.remedy,
        attempt: retryEntry.attempt,
        details: gateVerdict.details,
      });
      // Starvation tracking is intentionally NOT fed here: a gate-deferred
      // retry re-fires on its own timer, and pollTick's gate path already
      // calls trackDispatchStarvation every tick while the floor blocks, so
      // the page condition fires from polling regardless. Counting this
      // deferral too would double-count the same starved interval.
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: "rate-limit admission floor active",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    this.clearRetryEntry(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: retryEntry.identifier,
          error: "retry poll failed",
          delayType: retryEntry.delayType,
          // Orchestrator-synthetic, not issue-attributable: a tracker poll
          // exception must not feed the novelty short-circuit (council R5).
          deferral: true,
        }),
      };
    }

    const issue =
      candidates.find((candidate) => candidate.id === issueId) ?? null;
    if (issue === null) {
      this.state.failed.add(issueId);
      this.releaseClaim(issueId);
      this.clearTerminalIssueRuntimeState(issueId);
      this.onIssueDropped?.({
        issueId,
        identifier: retryEntry.identifier ?? issueId,
        title: null,
        url: null,
        reason: "issue no longer in candidate list",
      });
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (!this.isRetryCandidateEligible(issue)) {
      this.state.failed.add(issueId);
      this.releaseClaim(issueId);
      this.clearTerminalIssueRuntimeState(issueId);
      this.onIssueDropped?.({
        issueId,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url ?? null,
        reason: "issue no longer eligible for retry",
      });
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: issue.identifier,
          error: "no available orchestrator slots",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const candidateSnapshot = createIssueSupervisionSnapshot(issue);
    const findings = this.detectDispatchAdmissionFindings(
      this.buildRunningAdmissionSnapshots(),
      candidateSnapshot,
    );
    if (findings.length > 0) {
      await this.recordDispatcherDecisionEvent({
        decisionId: `${issue.id}:dispatch:${formatAttemptKey(retryEntry.attempt)}:admission`,
        category: "admission",
        classifier: "deterministic-disjointness-v1",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        operation: "dispatcher",
        stage: null,
        attempt: retryEntry.attempt,
        summary: `Measured retry admission paused ${issue.identifier} due to deterministic overlap findings.`,
        context: {
          reason:
            "Deterministic dispatch supervision found overlapping scope before retry admission.",
          triggerHits: [],
          findingKinds: findings.map((finding) => finding.kind),
          files: findings.flatMap((finding) => finding.files),
          workerIds: findings.flatMap((finding) => finding.workerIds),
          details: {
            phase: "dispatch",
            issueState: issue.state,
          },
        },
        expectedOutcome: {
          decision: "pause",
          classification: "positive",
          rationale:
            "Retry admission must block co-runs when deterministic overlap exists.",
          costWeight: "medium",
        },
        observedOutcome: {
          decision: "pause",
          classification: "positive",
          rationale:
            "Retry dispatch remained paused after deterministic admission findings.",
          costWeight: "medium",
        },
      });
      await this.reportSupervisionFindings("dispatch", findings);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: issue.identifier,
          error: "dispatch paused by deterministic supervision",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const dispatchResult = await this.dispatchIssue(issue, retryEntry.attempt);
    return {
      dispatched: dispatchResult.dispatched,
      released: false,
      retryEntry: null,
    };
  }

  async onWorkerExit(input: {
    issueId: string;
    outcome: WorkerExitOutcome;
    reason?: string;
    endedAt?: Date;
    agentMessage?: string;
    hardStop?: HardStopDecision | null;
  }): Promise<RetryEntry | null> {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return null;
    }

    const endedAt = input.endedAt ?? this.now();
    const exitedStageName = this.state.issueStages[input.issueId] ?? null;
    await this.completeDispatcherLease({
      leaseId: createDispatcherLeaseId({
        operation: "dispatcher",
        issueId: input.issueId,
        stage: exitedStageName,
        attempt: runningEntry.retryAttempt,
      }),
      idempotencyKey: `${createDispatcherLeaseId({
        operation: "dispatcher",
        issueId: input.issueId,
        stage: exitedStageName,
        attempt: runningEntry.retryAttempt,
      })}:worker_exit`,
      kind: "admission",
      issueId: input.issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: exitedStageName,
      attempt: runningEntry.retryAttempt,
      summary: `Worker lease completed for ${runningEntry.identifier}.`,
      metadata: {
        outcome: input.outcome,
      },
    });

    delete this.state.running[input.issueId];
    addEndedSessionRuntime(this.state, runningEntry.startedAt, endedAt);

    // Classify "abnormal" into a more descriptive outcome for stage records
    const classifiedOutcome =
      input.hardStop?.outcome ??
      classifyExitOutcome(input.outcome, runningEntry.turnCount, input.reason);

    // Append a StageRecord to execution history for this completed stage.
    const stageName = this.state.issueStages[input.issueId];
    if (stageName !== undefined) {
      const stageRecord: StageRecord = {
        stageName,
        durationMs: endedAt.getTime() - Date.parse(runningEntry.startedAt),
        totalTokens: runningEntry.totalStageTotalTokens,
        inputTokens: runningEntry.totalStageInputTokens,
        outputTokens: runningEntry.totalStageOutputTokens,
        cacheReadTokens: runningEntry.totalStageCacheReadTokens,
        cacheWriteTokens: runningEntry.totalStageCacheWriteTokens,
        turns: runningEntry.turnCount,
        outcome: classifiedOutcome,
      };
      let history = this.state.issueExecutionHistory[input.issueId];
      if (history === undefined) {
        history = [];
        this.state.issueExecutionHistory[input.issueId] = history;
      }
      history.push(stageRecord);

      // Snapshot history after the push so runtime-host can read it even if
      // advanceStage() deletes issueExecutionHistory for terminal transitions.
      this.lastExitHistorySnapshot.set(input.issueId, [...history]);
    }

    if (input.outcome === "normal") {
      if (input.hardStop !== undefined && input.hardStop !== null) {
        const escalation = await this.tryBudgetEscalation(
          input.issueId,
          runningEntry,
          input.hardStop,
          exitedStageName,
        );
        if (escalation !== null) {
          return escalation;
        }

        const triageResume = await this.tryPauseTriageResume(
          input.issueId,
          runningEntry,
          input.hardStop,
          exitedStageName,
        );
        if (triageResume !== null) {
          return triageResume;
        }

        await this.handleHardStopTrigger(input.issueId, runningEntry, {
          hardStop: input.hardStop,
          stageName: exitedStageName,
        });
        return null;
      }

      const failureSignal = parseFailureSignal(input.agentMessage);
      if (failureSignal !== null) {
        return this.handleFailureSignal(
          input.issueId,
          runningEntry,
          failureSignal.failureClass,
          input.agentMessage,
        );
      }

      const feedbackBounce = await this.handleContinuousFeedbackBounce(
        input.issueId,
        runningEntry,
        exitedStageName,
      );
      if (feedbackBounce !== undefined) {
        return feedbackBounce;
      }

      if (
        this.config.acGate.enabled &&
        this.runAcGate !== undefined &&
        this.scheduleDeferred !== undefined &&
        exitedStageName !== null &&
        exitedStageName === this.config.stages?.initialStage
      ) {
        // Hold-then-route (SYMPH-354): the stage neither advances nor
        // parks until the local model scores the acceptance criteria.
        // The claim stays held so nothing re-dispatches meanwhile; a
        // null verdict fails OPEN at the applier.
        const scheduleDeferred = this.scheduleDeferred;
        // The completion message is the one that carried [STAGE_COMPLETE]
        // (the AC echo lives there per the contract); fall back to the
        // session's last message when the exit carried no message body.
        const completionMessage =
          input.agentMessage ?? runningEntry.lastCodexMessage;
        void this.runAcGate({
          issueIdentifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          issueDescription: runningEntry.issue.description ?? null,
          completionMessage,
        })
          .catch((error) => {
            console.warn(
              `[orchestrator] AC gate failed for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
          .then((verdict) => {
            scheduleDeferred(() =>
              this.applyAcGateVerdict({
                issueId: input.issueId,
                identifier: runningEntry.identifier,
                stageName: exitedStageName,
                verdict,
                completionMessage,
              }),
            );
          })
          .catch((error) => {
            console.warn(
              `[orchestrator] AC gate chain failed for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return null;
      }

      const exitedStageDef =
        exitedStageName !== null && this.config.stages !== null
          ? this.config.stages.stages[exitedStageName]
          : undefined;
      if (
        this.config.specFidelity.enabled &&
        this.runSpecFidelityJudge !== undefined &&
        this.scheduleDeferred !== undefined &&
        exitedStageName !== null &&
        exitedStageDef?.transitions.onRework != null
      ) {
        // Advisory judge lane (SYMPH-343): fires alongside the normal
        // advance — nothing waits on the model, nothing is blocked. The
        // verdict lands later as a serialized journal+comment task.
        const scheduleDeferred = this.scheduleDeferred;
        const stageForVerdict = exitedStageName;
        void this.runSpecFidelityJudge({
          issueId: input.issueId,
          issueIdentifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          // The frozen gate-passed snapshot, never the workpad (SYMPH-374).
          acceptanceCriteria:
            this.state.issueAcSnapshots[input.issueId] ?? null,
          reviewMessage: runningEntry.lastCodexMessage,
        })
          .catch((error) => {
            console.warn(
              `[orchestrator] spec-fidelity judge failed for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
          .then((verdict) => {
            if (verdict === null) {
              return;
            }
            scheduleDeferred(() =>
              this.recordSpecFidelityVerdict({
                issueId: input.issueId,
                identifier: runningEntry.identifier,
                stageName: stageForVerdict,
                verdict,
              }),
            );
          })
          .catch(() => {
            // Chain must never become an unhandled rejection.
          });
      }

      const transition = this.advanceStage(
        input.issueId,
        runningEntry.identifier,
        runningEntry,
      );
      if (transition === "completed") {
        this.state.completed.add(input.issueId);
        this.releaseClaim(input.issueId);
        return null;
      }

      // Stage advanced or no stages configured — schedule continuation
      return this.scheduleRetry(input.issueId, 1, {
        identifier: runningEntry.identifier,
        error: null,
        delayType: "continuation",
      });
    }

    const stopReason = parseStoppedAfterReason(input.reason);
    if (stopReason === "manual_stop" || stopReason === "inactive_state") {
      this.markIssueRequiresExplicitResume(
        input.issueId,
        runningEntry.issue.state,
      );
      return null;
    }

    if (this.state.resumeRequired.has(input.issueId)) {
      this.releaseClaim(input.issueId);
      return null;
    }

    if (isCodexUserInputRequiredReason(input.reason)) {
      await this.handleOperatorInputRequiredPause(input.issueId, runningEntry, {
        reason: input.reason ?? ERROR_CODES.codexUserInputRequired,
        stageName: exitedStageName,
      });
      return null;
    }

    return this.scheduleRetry(
      input.issueId,
      nextRetryAttempt(runningEntry.retryAttempt),
      {
        identifier: runningEntry.identifier,
        issueTitle: runningEntry.issue.title,
        error: formatWorkerExitReason(input.reason),
        delayType: "failure",
      },
    );
  }

  /**
   * Advance issue to next stage based on transition rules.
   * Returns "completed" if the issue reached a terminal stage,
   * "advanced" if it moved to the next stage, or "unchanged" if
   * no stages are configured.
   *
   * When reaching a terminal stage that has a linearState configured,
   * fires updateIssueState as a best-effort side effect so the
   * tracker reflects the final state (e.g., "Done").
   */
  private advanceStage(
    issueId: string,
    issueIdentifier: string,
    session?: LiveSession,
  ): "completed" | "advanced" | "unchanged" {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return "unchanged";
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return "unchanged";
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return "unchanged";
    }

    const nextStageName = currentStage.transitions.onComplete;
    if (nextStageName === null) {
      // No on_complete transition — treat as terminal
      this.clearTerminalIssueRuntimeState(issueId);
      return "completed";
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      // Invalid target — treat as terminal
      this.clearTerminalIssueRuntimeState(issueId);
      return "completed";
    }

    if (nextStage.type === "terminal") {
      // Post execution report before cleanup (best-effort)
      if (nextStage.linearState !== null && this.postComment !== undefined) {
        const history = this.state.issueExecutionHistory[issueId] ?? [];
        const reworkCount = this.state.issueReworkCounts[issueId] ?? 0;
        const report = formatExecutionReport(
          issueIdentifier,
          history,
          reworkCount,
        );
        void this.postComment(issueId, report).catch((err) => {
          console.warn(
            `[orchestrator] Failed to post execution report for ${issueIdentifier}:`,
            err,
          );
        });
      }
      this.clearTerminalIssueRuntimeState(issueId);
      // Fire linearState update for the terminal stage (e.g., move to "Done")
      if (
        nextStage.linearState !== null &&
        this.updateIssueState !== undefined
      ) {
        void this.updateIssueState(
          issueId,
          issueIdentifier,
          nextStage.linearState,
        ).catch((err) => {
          console.warn(
            `[orchestrator] Failed to update terminal state for ${issueIdentifier}:`,
            err,
          );
        });
      }
      // Best-effort: check if all sibling sub-issues are terminal and auto-close parent
      if (this.autoCloseParentIssue !== undefined) {
        void this.autoCloseParentIssue(issueId, issueIdentifier).catch(
          (err) => {
            console.warn(
              `[orchestrator] Failed to auto-close parent for ${issueIdentifier}:`,
              err,
            );
          },
        );
      }
      return "completed";
    }

    // Record current stage as passed before advancing
    const passedStages = this.state.issuePassedStages[issueId] ?? [];
    if (!passedStages.includes(currentStageName)) {
      passedStages.push(currentStageName);
      this.state.issuePassedStages[issueId] = passedStages;
    }

    // Skip stages that have already been passed (e.g., review after a merge-triggered rework)
    let targetStageName = nextStageName;
    while (passedStages.includes(targetStageName)) {
      const targetStage = stagesConfig.stages[targetStageName];
      if (
        targetStage === undefined ||
        targetStage.transitions.onComplete === null
      ) {
        break;
      }
      targetStageName = targetStage.transitions.onComplete;
    }

    // Move to the target stage (may be ahead of nextStageName if stages were skipped)
    this.state.issueStages[issueId] = targetStageName;
    // Clear any stored failure signature for the incoming stage so a prior
    // failed visit cannot false-park the first failure of this new visit (SYMPH-396).
    this.clearStageFailureSignature(issueId, targetStageName);
    if (session !== undefined) {
      addPipelineActivity(
        session,
        "stage_transition",
        targetStageName === nextStageName
          ? `Stage → ${targetStageName}`
          : `Stage → ${targetStageName} (skipped previously-passed ${nextStageName})`,
      );
    }
    return "advanced";
  }

  /**
   * Handle agent-reported failure signals parsed from output.
   * Routes to retry, rework, or escalation based on failure class.
   */
  private handleFailureSignal(
    issueId: string,
    runningEntry: RunningEntry,
    failureClass: FailureClass,
    agentMessage: string | undefined,
  ): RetryEntry | null {
    if (failureClass === "spec") {
      // Spec failures are unrecoverable — escalate immediately.
      //
      // Cluster recording must happen here (SYMPH-398): spec failures skip
      // scheduleRetry entirely, so without this call a systemic spec-class
      // failure (e.g. a broken prompt template spec-failing every issue) would
      // never reach the cluster registry, the circuit breaker, or the watchdog
      // filer.  We capture stageName before clearTerminalIssueRuntimeState
      // erases it, and record into the cluster AFTER the terminal-state clear
      // so that clearIssueFromCluster (called inside clearTerminalIssueRuntimeState)
      // runs first — otherwise the record is immediately overwritten by the clear.
      const stageName = this.state.issueStages[issueId] ?? null;
      const specFailureText = "unrecoverable spec failure";
      const incoming = normalizeErrorSignature(specFailureText);

      this.state.failed.add(issueId);
      this.releaseClaim(issueId);
      this.clearTerminalIssueRuntimeState(issueId);

      // Record into the cluster after the terminal-state clear so the clear
      // doesn't erase this membership before the threshold check fires.
      this.recordFailureInCluster(
        issueId,
        runningEntry.identifier,
        incoming,
        stageName,
      );

      void this.fireEscalationSideEffects(
        issueId,
        runningEntry.identifier,
        "Agent reported unrecoverable spec failure. Escalating for manual review.",
      );
      void this.recordFailureExhausted(
        issueId,
        runningEntry.identifier,
        runningEntry.issue.title,
        specFailureText,
        {
          failure_signature: incoming.signature,
          failure_class: incoming.class,
        },
      );
      return null;
    }

    if (failureClass === "verify" || failureClass === "infra") {
      // Retryable failures — use existing exponential backoff
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: `agent reported failure: ${failureClass}`,
          delayType: "failure",
        },
      );
    }

    if (failureClass === "rebase") {
      // Rebase failures — trigger rework if onRework configured, else retry
      return this.handleRebaseFailure(issueId, runningEntry, agentMessage);
    }

    // failureClass === "review" — trigger rework via gate lookup
    return this.handleReviewFailure(issueId, runningEntry, agentMessage);
  }

  /**
   * Handle review failure: find the downstream gate and use its rework target.
   * Falls back to retry if no gate or rework target is found.
   * Posts a review findings comment before triggering rework.
   */
  private handleReviewFailure(
    issueId: string,
    runningEntry: RunningEntry,
    agentMessage: string | undefined,
  ): RetryEntry | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      // No stages — fall back to retry
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    // Check if the current stage itself has onRework (agent-type review stages)
    const currentStage = stagesConfig.stages[currentStageName];
    if (
      currentStage !== undefined &&
      currentStage.type === "agent" &&
      currentStage.transitions.onRework !== null
    ) {
      // Use reworkGate directly — it now supports agent stages with onRework
      const reworkTarget = this.reworkGate(issueId);
      if (reworkTarget === "escalated") {
        void this.fireEscalationSideEffects(
          issueId,
          runningEntry.identifier,
          "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
        );
        return null;
      }
      if (reworkTarget !== null) {
        this.postReviewFindingsComment(
          issueId,
          runningEntry.identifier,
          currentStageName,
          agentMessage,
        );
        return this.scheduleRetry(issueId, 1, {
          identifier: runningEntry.identifier,
          error: `agent review failure: rework to ${reworkTarget}`,
          delayType: "continuation",
        });
      }
      // reworkTarget === null should not happen since we checked onRework !== null,
      // but fall through to downstream gate search just in case
    }

    // Walk from current stage's onComplete to find the next gate
    const gateName = this.findDownstreamGate(currentStageName);
    if (gateName === null) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    // Use the gate's rework logic (reuses reworkGate by temporarily setting stage)
    // biome-ignore lint/style/noNonNullAssertion: issueId is guaranteed to exist in issueStages at this point
    const savedStage = this.state.issueStages[issueId]!;
    this.state.issueStages[issueId] = gateName;
    let reworkTarget: string | "escalated" | null;
    try {
      reworkTarget = this.reworkGate(issueId);
    } catch (err) {
      this.state.issueStages[issueId] = savedStage;
      throw err;
    }
    if (reworkTarget === null) {
      // No rework target — restore and fall back to retry
      this.state.issueStages[issueId] = savedStage;
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error:
            "agent reported failure: review (no rework target on downstream gate)",
          delayType: "failure",
        },
      );
    }

    if (reworkTarget === "escalated") {
      // reworkGate already cleaned up state — fire escalation side effects
      void this.fireEscalationSideEffects(
        issueId,
        runningEntry.identifier,
        "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
      );
      return null;
    }

    // Rework target set by reworkGate — post findings and schedule continuation
    this.postReviewFindingsComment(
      issueId,
      runningEntry.identifier,
      currentStageName,
      agentMessage,
    );
    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: `agent review failure: rework to ${reworkTarget}`,
      delayType: "continuation",
    });
  }

  /**
   * Post a review findings comment as a best-effort side effect.
   * Uses void...catch pattern to never affect pipeline flow.
   */
  private postReviewFindingsComment(
    issueId: string,
    issueIdentifier: string,
    stageName: string,
    agentMessage: string | undefined,
  ): void {
    if (this.postComment === undefined) {
      return;
    }
    const comment = formatReviewFindingsComment(
      issueIdentifier,
      stageName,
      agentMessage ?? "",
    );
    void this.postComment(issueId, comment).catch((err) => {
      console.warn(
        `[orchestrator] Failed to post review findings comment for ${issueIdentifier}:`,
        err,
      );
    });
  }

  /**
   * Handle rebase failure: check current stage for onRework and trigger rework.
   * Mirrors the first half of handleReviewFailure() — checks the current stage
   * has onRework, calls reworkGate(), posts a rebase comment, and schedules
   * a continuation retry. Falls back to retryable failure if no onRework.
   */
  private handleRebaseFailure(
    issueId: string,
    runningEntry: RunningEntry,
    agentMessage: string | undefined,
  ): RetryEntry | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: "agent reported failure: rebase",
          delayType: "failure",
        },
      );
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          error: "agent reported failure: rebase",
          delayType: "failure",
        },
      );
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (
      currentStage !== undefined &&
      currentStage.type === "agent" &&
      currentStage.transitions.onRework !== null
    ) {
      const reworkTarget = this.reworkGate(issueId);
      if (reworkTarget === "escalated") {
        void this.fireEscalationSideEffects(
          issueId,
          runningEntry.identifier,
          "Rebase failure: max rework attempts exceeded. Escalating for manual review.",
        );
        return null;
      }
      if (reworkTarget !== null) {
        this.postRebaseComment(
          issueId,
          runningEntry.identifier,
          currentStageName,
          agentMessage,
        );
        return this.scheduleRetry(issueId, 1, {
          identifier: runningEntry.identifier,
          error: `rebase failure: rework to ${reworkTarget}`,
          delayType: "continuation",
        });
      }
    }

    // No onRework configured — fall back to retryable failure
    return this.scheduleRetry(
      issueId,
      nextRetryAttempt(runningEntry.retryAttempt),
      {
        identifier: runningEntry.identifier,
        issueTitle: runningEntry.issue.title,
        error: "agent reported failure: rebase",
        delayType: "failure",
      },
    );
  }

  /**
   * Post a rebase comment as a best-effort side effect.
   * Uses void...catch pattern to never affect pipeline flow.
   */
  private postRebaseComment(
    issueId: string,
    issueIdentifier: string,
    stageName: string,
    agentMessage: string | undefined,
  ): void {
    if (this.postComment === undefined) {
      return;
    }
    const comment = formatRebaseComment(
      issueIdentifier,
      stageName,
      agentMessage ?? "",
    );
    void this.postComment(issueId, comment).catch((err) => {
      console.warn(
        `[orchestrator] Failed to post rebase comment for ${issueIdentifier}:`,
        err,
      );
    });
  }

  /**
   * Walk from a stage's onComplete transition to find the next gate stage.
   * Returns the gate stage name or null if none found.
   */
  private findDownstreamGate(startStageName: string): string | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const visited = new Set<string>();
    let current = startStageName;

    while (!visited.has(current)) {
      visited.add(current);
      const stage = stagesConfig.stages[current];
      if (stage === undefined) {
        return null;
      }

      const next = stage.transitions.onComplete;
      if (next === null) {
        return null;
      }

      const nextStage = stagesConfig.stages[next];
      if (nextStage === undefined) {
        return null;
      }

      if (nextStage.type === "gate") {
        return next;
      }

      // Agent-type stages with onRework can also serve as rework gates
      if (
        nextStage.type === "agent" &&
        nextStage.transitions.onRework !== null
      ) {
        return next;
      }

      current = next;
    }

    return null;
  }

  /**
   * Fire escalation side effects (updateIssueState + postComment).
   * Best-effort: failures are logged, not propagated.
   */
  /**
   * Durable record of a retry-exhausted (or spec-failed) issue (SYMPH-359):
   * without it, exhausted issues vanish from the dashboard and a restart
   * forgets the park entirely, re-dispatching work the orchestrator gave
   * up on. Replay re-creates the explicit-resume requirement.
   */
  private async recordFailureExhausted(
    issueId: string,
    issueIdentifier: string,
    issueTitle: string,
    reason: string,
    signatureMeta?: {
      failure_signature: string;
      failure_class: ErrorSignatureClass;
    },
  ): Promise<void> {
    // Mark immediately (before any await) so runtime-host's fireWorkerNotification
    // can check this set synchronously after onWorkerExit returns.
    this.state.failureExhaustedIds.add(issueId);
    const issueState = this.state.running[issueId]?.issue.state ?? null;
    const stageName = this.state.issueStages[issueId] ?? null;
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `failure_exhausted:${issueId}:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "failure_exhausted",
        issueId,
        issueIdentifier,
        operation: "dispatcher",
        stage: stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Retries exhausted for ${issueIdentifier}: ${reason}. Parked for operator.`,
        metadata: {
          status: "completed",
          reason,
          ...(issueState === null ? {} : { issueState }),
          ...(signatureMeta ?? {}),
        },
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal exhaustion for ${issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Fire-and-forget notification — never propagate into the scheduling loop
    try {
      this.onFailureExhausted?.({
        issueId,
        issueIdentifier,
        issueTitle,
        reason,
        stageName,
        failureSignature: signatureMeta?.failure_signature ?? null,
        failureClass: signatureMeta?.failure_class ?? null,
      });
    } catch {
      // Notification failures are always swallowed
    }
  }

  private async fireEscalationSideEffects(
    issueId: string,
    issueIdentifier: string,
    comment: string,
  ): Promise<void> {
    if (
      this.config.escalationState !== null &&
      this.updateIssueState !== undefined
    ) {
      // One retry: transient tracker 5xx dropped a live escalation
      // transition tonight, leaving an exhausted issue invisible in a
      // dashboard-neutral state with only a console line as evidence.
      let lastError: unknown = null;
      for (let attemptNo = 0; attemptNo < 2; attemptNo += 1) {
        try {
          await this.updateIssueState(
            issueId,
            issueIdentifier,
            this.config.escalationState,
          );
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      if (lastError !== null) {
        console.warn(
          `[orchestrator] Failed to update escalation state for ${issueIdentifier}:`,
          lastError,
        );
      }
    }
    if (this.postComment !== undefined) {
      try {
        await this.postComment(issueId, comment);
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to post escalation comment for ${issueIdentifier}:`,
          err,
        );
      }
    }
  }

  /**
   * Run ensemble gate: spawn reviewers, aggregate, transition.
   * Called asynchronously from dispatchIssue for ensemble gates.
   */
  private async handleEnsembleGate(
    issue: Issue,
    stage: StageDefinition,
    leaseId: string,
    stageName: string | null,
    attempt: number | null,
    gateContext: DecorrelatedGateContext | null,
  ): Promise<void> {
    try {
      // biome-ignore lint/style/noNonNullAssertion: runEnsembleGate is guaranteed to be set when this method is called
      const result = await this.runEnsembleGate!({ issue, stage });
      let reworkTarget: string | null = null;
      const reworkCountBeforeGate = this.state.issueReworkCounts[issue.id] ?? 0;

      if (result.aggregate === "pass") {
        const nextStage = this.approveGate(issue.id);
        if (nextStage !== null) {
          this.scheduleRetry(issue.id, 1, {
            identifier: issue.identifier,
            error: null,
            delayType: "continuation",
          });
        }
      } else {
        reworkTarget = this.reworkGate(issue.id);
        if (reworkTarget !== null && reworkTarget !== "escalated") {
          this.scheduleRetry(issue.id, 1, {
            identifier: issue.identifier,
            error: `Ensemble review failed: ${result.comment.slice(0, 200)}`,
            delayType: "continuation",
          });
        } else if (reworkTarget === "escalated") {
          if (
            this.config.escalationState !== null &&
            this.updateIssueState !== undefined
          ) {
            try {
              await this.updateIssueState(
                issue.id,
                issue.identifier,
                this.config.escalationState,
              );
            } catch (err) {
              console.warn(
                `[orchestrator] Failed to update escalation state for ${issue.identifier}:`,
                err,
              );
            }
          }
          if (this.postComment !== undefined) {
            const maxRework =
              stage.type === "gate" ? (stage.maxRework ?? 0) : 0;
            try {
              await this.postComment(
                issue.id,
                `Ensemble review: max rework attempts (${maxRework}) exceeded. Escalating for manual review.`,
              );
            } catch (err) {
              // Comment posting is best-effort — don't fail the gate on it.
              console.warn(
                `[orchestrator] Failed to post escalation comment for ${issue.identifier}:`,
                err,
              );
            }
          }
        }
      }
      if (gateContext !== null) {
        this.recordDecorrelatedGateOutcome({
          issue,
          stageName,
          gateContext,
          status: result.aggregate === "pass" ? "passed" : "failed",
          aggregate: result.aggregate,
          reworkTarget: reworkTarget === "escalated" ? null : reworkTarget,
          summary: `Decorrelated gate ${stageName ?? "unnamed"} ${result.aggregate === "pass" ? "passed" : "failed"} for ${issue.identifier}.`,
        });
      }
      await this.completeDispatcherLease({
        leaseId,
        idempotencyKey: `${leaseId}:result`,
        kind: "gate_result",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        operation: "gate",
        stage: stageName,
        attempt,
        summary: `Gate completed with ${result.aggregate} verdict.`,
        metadata: {
          aggregate: result.aggregate,
          mode: gateContext?.mode ?? null,
          workerLane: gateContext?.workerLane ?? null,
          reviewerLanes: gateContext?.reviewerLanes ?? [],
          verifierSeparated: gateContext?.verifierSeparated ?? null,
          authoritative:
            gateContext === null ? null : gateContext.mode !== "prototype",
          reworkTarget: reworkTarget === "escalated" ? null : reworkTarget,
          reworkCount:
            reworkTarget === "escalated"
              ? reworkCountBeforeGate
              : (this.state.issueReworkCounts[issue.id] ?? null),
          terminal: reworkTarget === "escalated",
          terminalReason:
            reworkTarget === "escalated" ? "max_rework_exceeded" : null,
        },
      });
      // Fire gate failure notification after the lease is durably completed so
      // the alert reflects a fully-journalled outcome (ordering hardening).
      if (result.aggregate !== "pass") {
        try {
          this.onGateFailed?.({
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            issueTitle: issue.title,
            stageName,
            reason: result.comment.slice(0, 200),
          });
        } catch {
          // Notification failures are always swallowed
        }
      }
    } catch (gateError) {
      // Gate handler failure — release claim so the issue can be retried on next poll.
      await this.recordRunJournalEntry({
        idempotencyKey: `${leaseId}:error:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "gate_result",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        operation: "gate",
        stage: stageName,
        attempt,
        ownerId: this.leaseOwnerId,
        lease: {
          ...(this.state.dispatcherLeases[leaseId] ?? {
            leaseId,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            operation: "gate" as const,
            ownerId: this.leaseOwnerId,
            acquiredAt: this.now().toISOString(),
            expiresAt: this.now().toISOString(),
            completedAt: null,
            stage: stageName,
            attempt,
            lastJournalSequence: 0,
          }),
          status: "expired",
          completedAt: this.now().toISOString(),
        },
        summary: "Gate handler failed before producing a durable verdict.",
        metadata: {
          status: "failed",
        },
      });
      this.releaseClaim(issue.id);
      // Fire-and-forget gate error notification (SYMPH-397).
      try {
        this.onGateFailed?.({
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          stageName,
          reason:
            gateError instanceof Error
              ? gateError.message.slice(0, 200)
              : "[STAGE_FAILED]",
        });
      } catch {
        // Notification failures are always swallowed
      }
    }
  }

  private async handlePrototypeGateBoundary(input: {
    issue: Issue;
    stageName: string | null;
    attempt: number | null;
    gateContext: DecorrelatedGateContext;
    leaseId: string;
  }): Promise<void> {
    const summary = `Prototype boundary reached for ${input.issue.identifier}; promotion requires a new gated production unit.`;
    this.recordDecorrelatedGateOutcome({
      issue: input.issue,
      stageName: input.stageName,
      gateContext: input.gateContext,
      status: "skipped_prototype",
      aggregate: null,
      reworkTarget: null,
      summary,
    });
    if (this.postComment !== undefined) {
      try {
        await this.postComment(
          input.issue.id,
          [
            "## Prototype promotion boundary",
            "",
            summary,
            "",
            "Prototype output is a runnable artifact plus recorded decision only. To merge, promote the decision into a new `thin` or `full` production unit and run the decorrelated acceptance gate there.",
          ].join("\n"),
        );
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to post prototype boundary comment for ${input.issue.identifier}:`,
          err,
        );
      }
    }
    if (this.requestTrackerIssueWrite !== undefined) {
      try {
        await this.runTrackerWriteOnce(
          {
            idempotencyKey: `tracker_write:promotion_boundary:${input.issue.id}:${input.stageName ?? "unnamed"}`,
            issueId: input.issue.id,
            issueIdentifier: input.issue.identifier,
            stage: input.stageName,
            attempt: input.attempt,
            action: "upsert_issue",
            summary:
              "Upsert tracker follow-up for prototype promotion boundary.",
          },
          async () => {
            await this.requestTrackerIssueWrite?.({
              boundary: {
                type: "promotion_boundary",
                label: `prototype promotion for ${input.issue.identifier}`,
                summary,
                sourceIssueIds: [input.issue.id],
              },
            });
          },
        );
      } catch (error) {
        console.warn(
          `[orchestrator] Failed to upsert tracker follow-up for prototype boundary ${input.issue.identifier}:`,
          error,
        );
      }
    }
    this.state.completed.add(input.issue.id);
    this.releaseClaim(input.issue.id);
    this.clearTerminalIssueRuntimeState(input.issue.id);
    await this.completeDispatcherLease({
      leaseId: input.leaseId,
      idempotencyKey: `${input.leaseId}:prototype_boundary`,
      kind: "gate_result",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      operation: "gate",
      stage: input.stageName,
      attempt: input.attempt,
      summary,
      metadata: {
        aggregate: null,
        mode: input.gateContext.mode,
        workerLane: input.gateContext.workerLane,
        reviewerLanes: input.gateContext.reviewerLanes,
        verifierSeparated: input.gateContext.verifierSeparated,
        authoritative: false,
        status: "skipped_prototype",
      },
    });
  }

  private async handleUndecorrelatedGate(input: {
    issue: Issue;
    stageName: string | null;
    stage: StageDefinition;
    attempt: number | null;
    gateContext: DecorrelatedGateContext;
    leaseId: string;
  }): Promise<void> {
    const reworkCountBeforeGate =
      this.state.issueReworkCounts[input.issue.id] ?? 0;
    const reworkTarget = this.reworkGate(input.issue.id);
    const blockReason =
      input.gateContext.reviewerLanes.length === 0
        ? "no decorrelated verifier lane is configured"
        : "a reviewer lane matches the worker lane";
    const summary = `Gate ${input.stageName ?? "unnamed"} blocked because ${blockReason}.`;
    this.recordDecorrelatedGateOutcome({
      issue: input.issue,
      stageName: input.stageName,
      gateContext: input.gateContext,
      status: "blocked",
      aggregate: "fail",
      reworkTarget: reworkTarget === "escalated" ? null : reworkTarget,
      summary,
    });
    if (this.postComment !== undefined) {
      try {
        await this.postComment(
          input.issue.id,
          [
            "## Decorrelated gate blocked",
            "",
            summary,
            "",
            `Worker lane: ${formatGateLane(input.gateContext.workerLane)}`,
            `Reviewer lanes: ${
              input.gateContext.reviewerLanes.length === 0
                ? "(none configured)"
                : input.gateContext.reviewerLanes.map(formatGateLane).join(", ")
            }`,
            "",
            "Configure an independent verifier lane, or promote the unit through a production gate with a different reviewer role/tool/model.",
          ].join("\n"),
        );
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to post undecorrelated gate comment for ${input.issue.identifier}:`,
          err,
        );
      }
    }
    if (reworkTarget !== null && reworkTarget !== "escalated") {
      this.scheduleRetry(input.issue.id, 1, {
        identifier: input.issue.identifier,
        error: `Decorrelated gate blocked: ${blockReason}`,
        delayType: "continuation",
      });
    } else if (reworkTarget === "escalated") {
      await this.fireEscalationSideEffects(
        input.issue.id,
        input.issue.identifier,
        `Decorrelated gate: max rework attempts (${input.stage.maxRework ?? 0}) exceeded after verifier-lane separation failure.`,
      );
    }
    await this.completeDispatcherLease({
      leaseId: input.leaseId,
      idempotencyKey: `${input.leaseId}:blocked`,
      kind: "gate_result",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      operation: "gate",
      stage: input.stageName,
      attempt: input.attempt,
      summary,
      metadata: {
        aggregate: "fail",
        mode: input.gateContext.mode,
        workerLane: input.gateContext.workerLane,
        reviewerLanes: input.gateContext.reviewerLanes,
        verifierSeparated: false,
        authoritative: true,
        status: "blocked",
        reworkTarget: reworkTarget === "escalated" ? null : reworkTarget,
        reworkCount:
          reworkTarget === "escalated"
            ? reworkCountBeforeGate
            : (this.state.issueReworkCounts[input.issue.id] ?? null),
        terminal: reworkTarget === "escalated",
        terminalReason:
          reworkTarget === "escalated" ? "max_rework_exceeded" : null,
      },
    });
  }

  private recordDecorrelatedGateOutcome(input: {
    issue: Issue;
    stageName: string | null;
    gateContext: DecorrelatedGateContext;
    status: "passed" | "failed" | "blocked" | "skipped_prototype";
    aggregate: "pass" | "fail" | null;
    reworkTarget: string | null;
    summary: string;
  }): void {
    const outcomes = this.state.decorrelatedGateOutcomes[input.issue.id] ?? [];
    this.state.decorrelatedGateOutcomes[input.issue.id] = [
      ...outcomes,
      {
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        gateStage: input.stageName,
        mode: input.gateContext.mode,
        status: input.status,
        aggregate: input.aggregate,
        checkedAt: this.now().toISOString(),
        workerLane: input.gateContext.workerLane,
        reviewerLanes: input.gateContext.reviewerLanes,
        verifierSeparated: input.gateContext.verifierSeparated,
        authoritative: input.status !== "skipped_prototype",
        reworkTarget: input.reworkTarget,
        summary: input.summary,
      },
    ];
  }

  private clearTerminalIssueRuntimeState(issueId: string): void {
    delete this.state.issueStages[issueId];
    delete this.state.issueReworkCounts[issueId];
    delete this.state.issuePassedStages[issueId];
    delete this.state.issueExecutionHistory[issueId];
    delete this.state.issueFirstDispatchedAt[issueId];
    delete this.state.issueRightSizingDecisions[issueId];
    delete this.state.issueBudgetEscalations[issueId];
    delete this.state.issuePauseTriageResumes[issueId];
    delete this.state.issueAcSnapshots[issueId];
    delete this.state.loopTraceJournal[issueId];
    delete this.state.continuousFeedback[issueId];
    // Clear the exhaustion-dedup marker so a resumed issue can fire the alert
    // again if it exhausts retries in a new lifecycle (SYMPH-397).
    this.state.failureExhaustedIds.delete(issueId);
    // Failure signatures are keyed by `${issueId}:${stage}` — purge all
    const sigPrefix = `${issueId}:`;
    for (const key of Object.keys(this.state.issueFailureSignatures)) {
      if (key.startsWith(sigPrefix) || key === issueId) {
        delete this.state.issueFailureSignatures[key];
      }
    }
    // NOTE (SYMPH-398): signature-cluster membership is deliberately NOT
    // cleared here. A terminally-parked issue must keep counting toward
    // SYSTEMIC so a second, distinct issue failing later with the same
    // signature tips the cluster (the SYMPH-330/332 motivation). Membership
    // clears only on resume / re-dispatch of the issue (isDispatchEligible),
    // which is also where any breaker opened for it is reset.
  }

  /**
   * Close any stage circuit breaker that was opened for a resumed issue
   * (SYMPH-398). Resume is an explicit operator action, so we fully close the
   * breaker; the resumed issue's first dispatch is the half-open canary — a
   * recurrence of the same signature re-crosses threshold and reopens the
   * breaker through the normal recordFailure path.
   */
  private resetBreakersForResumedIssue(issueId: string): void {
    const reset = this.signatureClusterRegistry.resetBreakersForIssue(issueId);
    for (const breaker of reset) {
      console.log(
        `[orchestrator] circuit breaker reset for stage "${breaker.stageName}" on resume of ${issueId}`,
      );
      this.recordBreakerTransition({
        transition: "closed",
        stageName: breaker.stageName,
        signature: breaker.signature,
        issueId,
        issueIdentifier: issueId,
        openedForIssueIds: breaker.openedForIssueIds,
      });
    }
  }

  /**
   * Journal a stage circuit-breaker open/close transition (SYMPH-405).
   * Fire-and-forget; replayed on recovery to rehydrate breaker state.
   */
  private recordBreakerTransition(input: {
    transition: "opened" | "closed";
    stageName: string;
    signature: string;
    issueId: string;
    issueIdentifier: string;
    openedForIssueIds: string[];
  }): void {
    const timestamp = this.now().toISOString();
    const actor = this.buildVerdictActor();
    // Sequence-suffixed key (not timestamp): an opened→closed→opened flip
    // within one millisecond must journal all three transitions, or replay
    // rebuilds a closed breaker that is live-open.
    this.commitVerdictJournalEntrySync({
      idempotencyKey: `breaker:${input.stageName}:${input.signature}:${input.transition}:${this.nextRunJournalSequence()}`,
      timestamp,
      kind: "breaker_transition",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: "dispatcher",
      stage: input.stageName,
      attempt: null,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Circuit breaker ${input.transition} for stage "${input.stageName}" (signature ${input.signature}) by ${actor.kind}@${actor.host}.`,
      metadata: {
        schema_version: 1,
        transition: input.transition,
        stage: input.stageName,
        signature: input.signature,
        actor,
        details: { openedForIssueIds: input.openedForIssueIds },
      },
    });
  }

  /**
   * Record a successful watchdog ticket filing in the signature-cluster
   * registry so the per-signature rate limiter (max_filings_per_hour) can
   * suppress duplicates (SYMPH-398). Uses the injected clock for determinism.
   */
  recordWatchdogFiling(input: {
    signature: string;
    issueIdentifier: string;
  }): void {
    this.signatureClusterRegistry.recordWatchdogFiling({
      signature: input.signature,
      issueIdentifier: input.issueIdentifier,
      now: this.now(),
    });
  }

  /**
   * Clear the stored failure signature for a single stage of an issue.
   * Called when an issue advances to (or is reworked back to) a stage so that
   * a stale signature from a prior visit cannot false-park the first failure of
   * the new visit (SYMPH-396).
   */
  private clearStageFailureSignature(issueId: string, stage: string): void {
    const sigKey = `${issueId}:${stage}`;
    delete this.state.issueFailureSignatures[sigKey];
  }

  private markIssueRequiresExplicitResume(
    issueId: string,
    issueState?: string | null,
    pausedAt?: string | null,
  ): void {
    this.recordIssueRequiresExplicitResume(issueId, issueState, pausedAt);
    this.releaseClaim(issueId);
  }

  private recordIssueRequiresExplicitResume(
    issueId: string,
    issueState?: string | null,
    pausedAt?: string | null,
  ): void {
    this.state.resumeRequired.add(issueId);
    const pausedState =
      issueState === undefined || issueState === null
        ? null
        : normalizeIssueState(issueState);
    const existingGuard = this.resumeRequiredGuards.get(issueId);
    this.parkSequence += 1;
    this.resumeRequiredGuards.set(issueId, {
      pausedState: pausedState === "" ? null : pausedState,
      observedNonResumeState:
        existingGuard?.observedNonResumeState === true ||
        pausedState !== EXPLICIT_RESUME_STATE,
      pausedAt: pausedAt ?? this.now().toISOString(),
      parkSeq: this.parkSequence,
    });
  }

  private clearResumeRequirement(issueId: string): void {
    this.state.resumeRequired.delete(issueId);
    this.resumeRequiredGuards.delete(issueId);
  }

  private observeResumeRequiredState(
    issueId: string,
    normalizedState: string,
  ): void {
    const guard = this.resumeRequiredGuards.get(issueId);
    if (
      guard === undefined ||
      guard.pausedState !== EXPLICIT_RESUME_STATE ||
      normalizedState === EXPLICIT_RESUME_STATE
    ) {
      return;
    }

    this.resumeRequiredGuards.set(issueId, {
      ...guard,
      observedNonResumeState: true,
    });
  }

  /**
   * SYMPH-291: a pause recorded while the issue was already IN Resume can
   * never be cleared by observation — Blocked is invisible to candidate
   * polls, and journal replay re-creates the wedged guard after restarts.
   * When the tracker exposes state history, an operator transition INTO
   * Resume that is newer than the pause is accepted as explicit resume
   * evidence. Evidence failures leave the issue parked (fail closed).
   */
  private async applyTrackerResumeEvidence(issues: Issue[]): Promise<void> {
    const fetchTransition = this.tracker.fetchLatestStateTransitionAt?.bind(
      this.tracker,
    );
    if (fetchTransition === undefined) {
      return;
    }

    let lookupsThisPoll = 0;
    for (const issue of issues) {
      if (lookupsThisPoll >= RESUME_EVIDENCE_MAX_LOOKUPS_PER_POLL) {
        return;
      }
      if (!this.state.resumeRequired.has(issue.id)) {
        continue;
      }
      const guard = this.resumeRequiredGuards.get(issue.id);
      if (
        guard === undefined ||
        guard.observedNonResumeState ||
        guard.pausedState !== EXPLICIT_RESUME_STATE ||
        guard.pausedAt === null ||
        normalizeIssueState(issue.state) !== EXPLICIT_RESUME_STATE
      ) {
        continue;
      }
      const nowMs = this.now().getTime();
      if (
        guard.evidenceCheckedAtMs !== undefined &&
        nowMs - guard.evidenceCheckedAtMs < RESUME_EVIDENCE_RECHECK_MS
      ) {
        continue;
      }
      this.resumeRequiredGuards.set(issue.id, {
        ...guard,
        evidenceCheckedAtMs: nowMs,
      });

      lookupsThisPoll += 1;
      try {
        // Matching is case-insensitive per the IssueTracker contract.
        const transitionAt = await fetchTransition(issue.id, "Resume");
        if (
          transitionAt !== null &&
          Date.parse(transitionAt) >
            Date.parse(guard.pausedAt) + RESUME_EVIDENCE_SKEW_MARGIN_MS
        ) {
          this.resumeRequiredGuards.set(issue.id, {
            ...guard,
            evidenceCheckedAtMs: nowMs,
            observedNonResumeState: true,
          });
        }
      } catch (error) {
        // Fail closed but never silently: a permanently broken history API
        // would otherwise present as an inexplicably parked issue.
        console.warn(
          `[orchestrator] resume-evidence lookup failed for ${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private canConsumeResumeRequirement(
    issueId: string,
    normalizedState: string,
  ): boolean {
    if (normalizedState !== EXPLICIT_RESUME_STATE) {
      return false;
    }

    const guard = this.resumeRequiredGuards.get(issueId);
    return guard === undefined || guard.observedNonResumeState;
  }

  private resolveDecorrelatedGateContext(
    issueId: string,
    stageName: string | null,
    stage: StageDefinition,
  ): DecorrelatedGateContext | null {
    const rightSizingDecision = this.state.issueRightSizingDecisions[issueId];
    if (rightSizingDecision === undefined) {
      return null;
    }

    const workerLane = this.resolveGateWorkerLane(issueId, stage);
    const reviewerLanes = stage.reviewers.map((reviewer) => ({
      runner: reviewer.runner,
      model: reviewer.model,
      role: reviewer.role,
      stageName,
    }));
    const verifierSeparated =
      reviewerLanes.length > 0 &&
      reviewerLanes.every(
        (reviewerLane) => !sameGateLane(reviewerLane, workerLane),
      );

    return {
      mode: rightSizingDecision.mode,
      explicitModeHint: rightSizingDecision.signals.explicitModeHint,
      workerLane,
      reviewerLanes,
      verifierSeparated,
    };
  }

  private resolveGateWorkerLane(
    issueId: string,
    gateStage: StageDefinition,
  ): DecorrelatedGateLane {
    const stagesConfig = this.config.stages;
    const reworkStageName = gateStage.transitions.onRework;
    const history = this.state.issueExecutionHistory[issueId] ?? [];
    const lastHistoryStageName = history.at(-1)?.stageName ?? null;
    const workerStageName =
      reworkStageName !== null ? reworkStageName : lastHistoryStageName;
    const workerStage =
      stagesConfig !== null && workerStageName !== null
        ? stagesConfig.stages[workerStageName]
        : undefined;

    return {
      runner: workerStage?.runner ?? this.config.runner.kind,
      model: workerStage?.model ?? this.config.runner.model,
      role: "worker",
      stageName: workerStageName,
    };
  }

  /**
   * Handle gate approval: advance to on_approve target.
   * Returns the next stage name, or null if already terminal/invalid.
   */
  approveGate(issueId: string): string | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return null;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined || currentStage.type !== "gate") {
      return null;
    }

    const nextStageName = currentStage.transitions.onApprove;
    if (nextStageName === null) {
      return null;
    }

    this.state.issueStages[issueId] = nextStageName;
    // Clear any stored failure signature for the destination stage so a stale
    // signature from a prior visit cannot false-park the first failure of the
    // new visit (SYMPH-396 — same class as advanceStage / reworkGate fixes).
    this.clearStageFailureSignature(issueId, nextStageName);
    return nextStageName;
  }

  /**
   * Handle gate rework: send issue back to rework target.
   * Tracks rework count and escalates to terminal if max exceeded.
   * Works for both gate-type stages and agent-type stages with onRework set.
   * Returns the rework target stage name, "escalated" if max rework
   * exceeded, or null if no rework transition defined.
   */
  reworkGate(issueId: string): string | "escalated" | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return null;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return null;
    }

    // Allow gate stages (always) and agent stages with onRework set
    if (
      currentStage.type !== "gate" &&
      !(
        currentStage.type === "agent" &&
        currentStage.transitions.onRework !== null
      )
    ) {
      return null;
    }

    const reworkTarget = currentStage.transitions.onRework;
    if (reworkTarget === null) {
      return null;
    }

    const maxRework = currentStage.maxRework ?? Number.POSITIVE_INFINITY;
    const currentCount = this.state.issueReworkCounts[issueId] ?? 0;

    if (currentCount >= maxRework) {
      // Exceeded max rework — escalate to completed/terminal
      this.clearTerminalIssueRuntimeState(issueId);
      this.state.failed.add(issueId);
      this.releaseClaim(issueId);
      return "escalated";
    }

    // Remove the failing stage from passedStages so it will be re-run.
    // Stages that passed BEFORE the failing stage remain — e.g., if merge fails,
    // review stays passed and will be skipped when advancing through it again.
    const passedStages = this.state.issuePassedStages[issueId];
    if (passedStages !== undefined) {
      const idx = passedStages.indexOf(currentStageName);
      if (idx !== -1) {
        passedStages.splice(idx, 1);
      }
    }

    this.state.issueReworkCounts[issueId] = currentCount + 1;
    this.state.issueStages[issueId] = reworkTarget;

    // Clear any stored failure signature for the rework target stage so the
    // first failure of the new visit gets a normal retry rather than
    // false-parking against a stale signature from a prior visit (SYMPH-396).
    this.clearStageFailureSignature(issueId, reworkTarget);

    return reworkTarget;
  }

  onCodexEvent(input: {
    issueId: string;
    event: CodexClientEvent;
  }): CodexEventResult {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return { applied: false, rateLimitsUpdated: false };
    }

    const telemetry = applyCodexEventToOrchestratorState(
      this.state,
      runningEntry,
      input.event,
    );
    return { applied: true, rateLimitsUpdated: telemetry.rateLimitsUpdated };
  }

  async runContinuousFeedbackCheckpoint(input: {
    issueId: string;
    event: ContinuousFeedbackEvent;
  }): Promise<ContinuousFeedbackCheckpointResult> {
    const runningEntry = this.state.running[input.issueId];
    const feedbackConfig = this.resolveContinuousFeedbackConfig();
    if (
      runningEntry === undefined ||
      !feedbackConfig.enabled ||
      !feedbackConfig.events.includes(input.event)
    ) {
      return {
        ran: false,
        status: "skipped",
        event: input.event,
        reviewerLane: null,
        workerLane: null,
        findingSignatures: [],
        summary: null,
      };
    }

    const stageName = this.state.issueStages[input.issueId] ?? null;
    const workerLane = this.resolveWorkerLane(stageName);
    const reviewerLane = ensureDecorrelatedFeedbackLane(
      {
        runner: feedbackConfig.runner,
        model: feedbackConfig.model,
        role: feedbackConfig.role,
      },
      workerLane,
    );

    if (this.runContinuousFeedback === undefined) {
      return {
        ran: false,
        status: "skipped",
        event: input.event,
        reviewerLane,
        workerLane,
        findingSignatures: [],
        summary: null,
      };
    }

    const checkedAt = this.now().toISOString();
    const result = await this.runContinuousFeedback({
      issue: runningEntry.issue,
      event: input.event,
      stageName,
      workerLane,
      reviewerLane,
    });
    const feedbackState = mergeContinuousFeedbackCheckpoint(
      this.state.continuousFeedback[input.issueId],
      {
        issueId: input.issueId,
        issueIdentifier: runningEntry.identifier,
        event: input.event,
        checkedAt,
        workerLane,
        reviewerLane,
        findings: result.findings,
      },
    );
    this.state.continuousFeedback[input.issueId] = feedbackState;
    const findingSignatures = result.findings.map(
      (finding) =>
        finding.signature ??
        [
          finding.severity ?? "warning",
          finding.file ?? "nofile",
          finding.line?.toString() ?? "noline",
          finding.title.trim().toLowerCase(),
        ].join(":"),
    );
    // Suppression-aware (SYMPH-378): a checkpoint whose findings all
    // failed the injection-hygiene policy is a pass — nothing bounces.
    const status = feedbackState.status;
    const suppressedSignatures = feedbackState.findings
      .filter((finding) => finding.status === "suppressed")
      .map((finding) => finding.signature);

    await this.recordRunJournalEntry({
      idempotencyKey: `continuous_feedback:${input.issueId}:${input.event}:${checkedAt}`,
      timestamp: checkedAt,
      kind: "continuous_feedback",
      issueId: input.issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "feedback_lane",
      stage: stageName,
      attempt: runningEntry.retryAttempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary:
        status === "pass"
          ? `Continuous feedback passed for ${runningEntry.identifier}.`
          : `Continuous feedback found ${result.findings.length} issue(s) for ${runningEntry.identifier}.`,
      metadata: {
        event: input.event,
        status,
        reviewerLane,
        workerLane,
        findingSignatures,
        suppressedSignatures,
        summary: result.summary ?? null,
        authoritative: false,
      },
    });

    return {
      ran: true,
      status,
      event: input.event,
      reviewerLane,
      workerLane,
      findingSignatures,
      summary: result.summary ?? null,
    };
  }

  /**
   * Check if any non-terminal pipeline-halt issues exist.
   * Prefers fetchOpenIssuesByLabels (server-side filtering) when available,
   * falls back to fetchIssuesByLabels with client-side filtering.
   * Returns the first open halt issue, or null if none / on error (fail-open).
   */
  private async checkPipelineHalt(): Promise<Issue | null> {
    if (this.tracker.fetchOpenIssuesByLabels !== undefined) {
      try {
        const haltIssues = await this.tracker.fetchOpenIssuesByLabels(
          ["pipeline-halt"],
          this.config.tracker.terminalStates,
        );
        return haltIssues[0] ?? null;
      } catch (error) {
        console.warn(
          "[orchestrator] fetchOpenIssuesByLabels failed, falling back to fetchIssuesByLabels.",
          error,
        );
      }
    }

    if (this.tracker.fetchIssuesByLabels !== undefined) {
      try {
        const haltIssues = await this.tracker.fetchIssuesByLabels([
          "pipeline-halt",
        ]);
        const terminalStates = toNormalizedStateSet(
          this.config.tracker.terminalStates,
        );
        const openHaltIssue = haltIssues.find((haltIssue) => {
          const normalizedState = normalizeIssueState(haltIssue.state);
          return !terminalStates.has(normalizedState);
        });
        return openHaltIssue ?? null;
      } catch (error) {
        console.warn(
          "[orchestrator] Failed to check for pipeline-halt issues. Continuing dispatch.",
          error,
        );
      }
    }

    return null;
  }

  /**
   * Record a dispatch verdict (SYMPH-405): every dispatch decision becomes a
   * deduped structured journal event. Dedup-on-change is gated by the
   * in-memory last-verdict map — an UNCHANGED disposition+reason for an issue
   * is a no-op (no journal append, no state churn, no alert). The journal's
   * own idempotency machinery dedupes by exact key; a flip BACK to a
   * previously journaled verdict (A→B→A) appends a key suffixed with the
   * next journal sequence number so the recovery is still journaled. The
   * sequence suffix is collision-safe where a millisecond timestamp is not:
   * two flip-backs to the same verdict within one tick get distinct keys.
   *
   * Fire-and-forget: verdict observability never blocks dispatch.
   */
  private recordDispatchVerdict(input: {
    issueId: string;
    issueIdentifier: string;
    disposition: VerdictDisposition;
    reasonCode: string;
    remedy?: string | null;
    stage?: string | null;
    attempt?: number | null;
    details?: Record<string, unknown>;
  }): void {
    const baseKey = `verdict:${input.issueId}:${input.disposition}:${input.reasonCode}`;
    if (this.lastVerdictKeys.get(input.issueId) === baseKey) {
      return;
    }
    this.lastVerdictKeys.set(input.issueId, baseKey);

    const timestamp = this.now().toISOString();
    const remedy = input.remedy ?? null;
    const actor = this.buildVerdictActor();
    this.state.issueDispositions[input.issueId] = {
      disposition: input.disposition,
      reasonCode: input.reasonCode,
      remedy,
      since: timestamp,
    };

    // A verdict's first emission uses the bare base key; every re-emission
    // (flip-back) is suffixed. Match both shapes so a flip-back after a
    // prior flip-back is still detected as already journaled.
    const alreadyJournaled = this.state.dispatcherRunJournal.some(
      (entry) =>
        entry.idempotencyKey === baseKey ||
        entry.idempotencyKey.startsWith(`${baseKey}:`),
    );
    this.commitVerdictJournalEntrySync({
      idempotencyKey: alreadyJournaled
        ? `${baseKey}:${this.nextRunJournalSequence()}`
        : baseKey,
      timestamp,
      kind: "dispatch_verdict",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: "dispatcher",
      stage: input.stage ?? null,
      attempt: input.attempt ?? null,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Dispatch verdict for ${input.issueIdentifier}: ${input.disposition} (${input.reasonCode}) by ${actor.kind}@${actor.host}.`,
      metadata: {
        schema_version: 1,
        disposition: input.disposition,
        reason_code: input.reasonCode,
        remedy,
        actor,
        details: input.details ?? {},
      },
    });

    // Transitions-only Slack notification: only when the disposition CHANGES
    // to gate/halt (the map check above guarantees the change). Fail-open.
    if (input.disposition === "gate" || input.disposition === "halt") {
      try {
        this.onVerdictTransition?.({
          issueId: input.issueId,
          issueIdentifier: input.issueIdentifier,
          disposition: input.disposition,
          reasonCode: input.reasonCode,
          remedy,
          actor,
        });
      } catch {
        // Notification failures are always swallowed.
      }
    }
  }

  private buildVerdictActor(): VerdictActor {
    return { kind: "dispatcher", host: hostname() };
  }

  /**
   * Synchronously commit a verdict-class journal entry (SYMPH-405) to the
   * in-memory journal, then hand the disk write to the ordered flush queue
   * fire-and-forget. Callable from sync paths (isDispatchEligible) — the
   * in-memory commit happens before any await, so overlapping appends can
   * never compute the same sequence from a stale journal. Verdict entries
   * never carry a lease, so no lease bookkeeping is needed.
   */
  private commitVerdictJournalEntrySync(
    entry: Omit<DispatcherRunJournalEntry, "sequence">,
  ): void {
    const result = appendDispatcherRunJournalEntry(
      this.state.dispatcherRunJournal,
      entry,
      this.burnedRunJournalSequence + 1,
    );
    if (!result.appended) {
      return;
    }
    this.state.dispatcherRunJournal = result.journal;
    this.flushRunJournalEntryToDisk(result.entry).catch((error) => {
      console.warn(
        `[orchestrator] Failed to persist ${entry.kind} journal entry for ${entry.issueIdentifier}:`,
        error,
      );
    });
  }

  /**
   * Append a journal entry's disk write to the ordered flush chain. Entries
   * are flushed strictly in the order this method is called, which (because
   * every caller commits to the in-memory journal first, and all callers run
   * inside the host's serialized event queue) is sequence order. A failed
   * write does not stall the chain; the caller decides whether the failure
   * propagates (awaited writer) or is logged (fire-and-forget writer).
   */
  private flushRunJournalEntryToDisk(
    entry: DispatcherRunJournalEntry,
  ): Promise<void> {
    const write = this.runJournalDiskFlushQueue.then(async () => {
      await this.writeRunJournalEntry?.(entry);
    });
    // Continuation catch: a failed awaited write leaves a sequence gap on
    // disk BY DESIGN — the entry was also rolled back in memory
    // (journal-first invariant), so disk and memory agree. Later entries
    // persisting after the gap is correct ordering, not an inversion.
    this.runJournalDiskFlushQueue = write.catch(() => undefined);
    return write;
  }

  /**
   * The sequence number the next committed journal entry will receive.
   * Used to build collision-safe idempotency keys for re-emissions: the
   * sequence is monotonic and survives restarts (the journal is replayed
   * into memory before any new entry is committed), unlike a millisecond
   * timestamp suffix which collides under same-tick re-emissions.
   */
  private nextRunJournalSequence(): number {
    return Math.max(
      (this.state.dispatcherRunJournal.at(-1)?.sequence ?? 0) + 1,
      this.burnedRunJournalSequence + 1,
    );
  }

  /**
   * Track the dispatch-starvation page condition (SYMPH-405): eligible
   * candidates > 0 AND dispatched_count == 0 for verdicts.page_after_ticks
   * consecutive ticks fires ONE page alert; the next non-starved tick fires
   * one recovery alert and unlatches. Each page/recovery transition is
   * journaled so a restart rehydrates the latch instead of resetting it
   * (the SYMPH-401 deploy-resets-counters class). Fail-open on callback
   * errors.
   */
  private trackDispatchStarvation(
    eligibleCount: number,
    dispatchedCount: number,
  ): void {
    const starved = eligibleCount > 0 && dispatchedCount === 0;
    if (starved) {
      this.starvedTickCount += 1;
      const pageAfterTicks =
        this.config.verdicts?.pageAfterTicks ??
        DEFAULT_VERDICTS_PAGE_AFTER_TICKS;
      if (!this.pageAlertActive && this.starvedTickCount >= pageAfterTicks) {
        this.pageAlertActive = true;
        this.recordDispatchPageEvent("page", eligibleCount);
        try {
          this.onDispatchPage?.({
            kind: "page",
            eligibleCount,
            consecutiveTicks: this.starvedTickCount,
          });
        } catch {
          // Notification failures are always swallowed.
        }
      }
      return;
    }

    if (this.pageAlertActive) {
      this.pageAlertActive = false;
      this.recordDispatchPageEvent("recovery", eligibleCount);
      try {
        this.onDispatchPage?.({
          kind: "recovery",
          eligibleCount,
          consecutiveTicks: this.starvedTickCount,
        });
      } catch {
        // Notification failures are always swallowed.
      }
    }
    this.starvedTickCount = 0;
  }

  /**
   * Journal a dispatch-starvation page transition (SYMPH-405 council R1).
   * Replay rehydrates the page latch from the latest of these entries, so a
   * deploy mid-starvation neither double-pages nor silently drops the latch.
   * Keyed on the next journal sequence: page episodes recur, so the key must
   * be unique per transition and survive restarts.
   */
  private recordDispatchPageEvent(
    event: "page" | "recovery",
    eligibleCount: number,
  ): void {
    this.commitVerdictJournalEntrySync({
      idempotencyKey: `page:${PIPELINE_VERDICT_SCOPE_ID}:${event}:${this.nextRunJournalSequence()}`,
      timestamp: this.now().toISOString(),
      kind: "dispatch_verdict",
      issueId: PIPELINE_VERDICT_SCOPE_ID,
      issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary:
        event === "page"
          ? `Dispatch starvation page fired after ${this.starvedTickCount} consecutive starved ticks.`
          : "Dispatch starvation recovered.",
      metadata: {
        schema_version: 1,
        page_event: event,
        eligible_count: eligibleCount,
        consecutive_ticks: this.starvedTickCount,
        actor: this.buildVerdictActor(),
      },
    });
  }

  private async recordDispatcherDecisionEvent(input: {
    decisionId: string;
    category: DispatcherDecisionCategory;
    classifier: string | null;
    issueId: string;
    issueIdentifier: string;
    operation: DispatcherOperation;
    stage: string | null;
    attempt: number | null;
    summary: string;
    context: DispatcherDecisionEvent["context"];
    expectedOutcome: DispatcherDecisionOutcome;
    observedOutcome?: DispatcherDecisionOutcome | null;
    operatorCorrection?: DispatcherDecisionEvent["operatorCorrection"];
  }): Promise<void> {
    const event: DispatcherDecisionEvent = {
      decisionId: input.decisionId,
      category: input.category,
      classifier: input.classifier,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: input.operation,
      stage: input.stage,
      attempt: input.attempt,
      timestamp: this.now().toISOString(),
      context: input.context,
      expectedOutcome: input.expectedOutcome,
      observedOutcome: input.observedOutcome ?? null,
      operatorCorrection: input.operatorCorrection ?? null,
    };

    await this.recordRunJournalEntry({
      idempotencyKey: `dispatcher_decision:${input.decisionId}`,
      timestamp: event.timestamp,
      kind: "dispatcher_decision",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: input.operation,
      stage: input.stage,
      attempt: input.attempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: input.summary,
      metadata: {
        status: "completed",
        decisionEvent: event,
      },
    });
  }

  private async acquireDispatcherLease(input: {
    leaseId: string;
    idempotencyKey: string;
    kind: DispatcherRunJournalEntry["kind"];
    issueId: string;
    issueIdentifier: string;
    operation: DispatcherOperation;
    stage: string | null;
    attempt: number | null;
    summary: string;
    metadata?: Record<string, unknown>;
  }): Promise<DispatcherLease | null> {
    const activeLease = this.getActiveDispatcherLease(input.leaseId);
    if (activeLease !== null) {
      return null;
    }

    const acquiredAt = this.now().toISOString();
    const lease: DispatcherLease = {
      leaseId: input.leaseId,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: input.operation,
      ownerId: this.leaseOwnerId,
      status: "active",
      acquiredAt,
      expiresAt: new Date(this.now().getTime() + this.leaseTtlMs).toISOString(),
      completedAt: null,
      stage: input.stage,
      attempt: input.attempt,
      lastJournalSequence: 0,
    };

    const entry = await this.recordRunJournalEntry({
      idempotencyKey: input.idempotencyKey,
      timestamp: acquiredAt,
      kind: input.kind,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: input.operation,
      stage: input.stage,
      attempt: input.attempt,
      ownerId: this.leaseOwnerId,
      lease,
      summary: input.summary,
      metadata: {
        status: "started",
        ...(input.metadata ?? {}),
      },
    });
    return entry.lease;
  }

  private async completeDispatcherLease(input: {
    leaseId: string;
    idempotencyKey: string;
    kind: DispatcherRunJournalEntry["kind"];
    issueId: string;
    issueIdentifier: string;
    operation: DispatcherOperation;
    stage: string | null;
    attempt: number | null;
    summary: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const lease = this.state.dispatcherLeases[input.leaseId];
    if (lease === undefined) {
      return;
    }

    const completedAt = this.now().toISOString();
    await this.recordRunJournalEntry({
      idempotencyKey: input.idempotencyKey,
      timestamp: completedAt,
      kind: input.kind,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: input.operation,
      stage: input.stage,
      attempt: input.attempt,
      ownerId: this.leaseOwnerId,
      lease: {
        ...lease,
        status: "completed",
        completedAt,
      },
      summary: input.summary,
      metadata: {
        status: "completed",
        ...(input.metadata ?? {}),
      },
    });
  }

  private async recordRunJournalEntry(
    entry: Omit<DispatcherRunJournalEntry, "sequence">,
  ): Promise<DispatcherRunJournalEntry> {
    const result = appendDispatcherRunJournalEntry(
      this.state.dispatcherRunJournal,
      entry,
      this.burnedRunJournalSequence + 1,
    );
    if (!result.appended) {
      return result.entry;
    }

    // Commit in-memory BEFORE the disk await: sequence assignment and
    // commit must be atomic so an overlapping append can never compute the
    // same sequence from a stale journal and drop this entry. Disk
    // durability is ordered separately by the flush queue.
    if (result.entry.lease !== null) {
      result.entry.lease.lastJournalSequence = result.entry.sequence;
    }
    this.state.dispatcherRunJournal = result.journal;
    try {
      await this.flushRunJournalEntryToDisk(result.entry);
    } catch (error) {
      // Journal-first: an entry that cannot be persisted must not take
      // effect. Roll back the in-memory append (entries committed after it
      // keep their sequences; replay tolerates the gap) and surface the
      // failure before any lease/claim side effects. Burn the rolled-back
      // sequence so it is never reissued — see burnedRunJournalSequence.
      this.burnedRunJournalSequence = Math.max(
        this.burnedRunJournalSequence,
        result.entry.sequence,
      );
      this.state.dispatcherRunJournal = this.state.dispatcherRunJournal.filter(
        (candidate) => candidate !== result.entry,
      );
      throw error;
    }
    if (result.entry.lease !== null) {
      this.state.dispatcherLeases[result.entry.lease.leaseId] =
        result.entry.lease;
      if (
        result.entry.lease.status === "active" &&
        result.entry.lease.operation !== "tracker_write"
      ) {
        this.state.claimed.add(result.entry.lease.issueId);
      } else {
        this.releaseRecoveredClaimIfIdle(result.entry.lease.issueId);
      }
    }
    return result.entry;
  }

  async expireDispatcherLeases(): Promise<void> {
    const nowMs = this.now().getTime();
    for (const lease of Object.values(this.state.dispatcherLeases)) {
      if (lease.status !== "active") {
        continue;
      }
      if (Date.parse(lease.expiresAt) > nowMs) {
        continue;
      }

      const expiredAt = this.now().toISOString();
      await this.recordRunJournalEntry({
        idempotencyKey: `lease:${lease.leaseId}:expired:${lease.expiresAt}`,
        timestamp: expiredAt,
        kind:
          lease.operation === "gate"
            ? "gate_result"
            : lease.operation === "tracker_write"
              ? "tracker_write"
              : lease.operation === "supervisor"
                ? "re_steer_request"
                : "admission",
        issueId: lease.issueId,
        issueIdentifier: lease.issueIdentifier,
        operation: lease.operation,
        stage: lease.stage,
        attempt: lease.attempt,
        ownerId: this.leaseOwnerId,
        lease: {
          ...lease,
          status: "expired",
          completedAt: expiredAt,
        },
        summary: "Dispatcher lease expired during recovery.",
        metadata: {
          status: "expired",
        },
      });
    }
  }

  private getActiveDispatcherLease(leaseId: string): DispatcherLease | null {
    const lease = this.state.dispatcherLeases[leaseId];
    if (lease === undefined || lease.status !== "active") {
      return null;
    }

    if (Date.parse(lease.expiresAt) <= this.now().getTime()) {
      return null;
    }

    return lease;
  }

  private hasBlockingDispatcherLease(issueId: string): boolean {
    return Object.values(this.state.dispatcherLeases).some(
      (lease) =>
        lease.issueId === issueId &&
        lease.operation !== "tracker_write" &&
        lease.status === "active" &&
        Date.parse(lease.expiresAt) > this.now().getTime(),
    );
  }

  private hasCompletedJournalEntry(idempotencyKey: string): boolean {
    return this.state.dispatcherRunJournal.some(
      (entry) =>
        entry.idempotencyKey === idempotencyKey &&
        entry.metadata.status === "completed",
    );
  }

  private releaseRecoveredClaimIfIdle(issueId: string): void {
    if (
      this.state.running[issueId] !== undefined ||
      this.state.retryAttempts[issueId] !== undefined
    ) {
      return;
    }
    if (this.hasBlockingDispatcherLease(issueId)) {
      return;
    }
    this.state.claimed.delete(issueId);
  }

  private formatPauseResumeInstruction(
    pausedState: string | null | undefined,
    pauseVerb: "continuing" | "retrying",
  ): string {
    const base = `The worker has paused instead of ${pauseVerb} silently.`;
    const normalized =
      pausedState === undefined || pausedState === null
        ? null
        : normalizeIssueState(pausedState);
    if (normalized === EXPLICIT_RESUME_STATE) {
      // Requeue only triggers on a fresh transition into Resume, so an issue
      // paused while already in Resume must leave the state before re-entering.
      return `${base} This issue was already in Resume when it paused, so it will only requeue on a fresh transition into Resume: move it out of Resume (if it is still there) and back into Resume after human review.`;
    }
    return `${base} Move the issue to Resume after human review to requeue it.`;
  }

  private async handleHardStopTrigger(
    issueId: string,
    runningEntry: RunningEntry,
    input: {
      hardStop: HardStopDecision;
      stageName: string | null;
    },
  ): Promise<void> {
    await this.recordRunJournalEntry({
      idempotencyKey: `hard_stop:${issueId}:${input.stageName ?? "no-stage"}:${formatAttemptKey(runningEntry.retryAttempt)}:${input.hardStop.trigger}:${input.hardStop.turnCount}`,
      timestamp: this.now().toISOString(),
      kind: "hard_stop_trigger",
      issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: input.stageName,
      attempt: runningEntry.retryAttempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Hard stop ${input.hardStop.outcome} triggered for ${runningEntry.identifier}: ${input.hardStop.reason}`,
      metadata: {
        status: "completed",
        outcome: input.hardStop.outcome,
        trigger: input.hardStop.trigger,
        reason: input.hardStop.reason,
        turnCount: input.hardStop.turnCount,
        totalTokens: input.hardStop.totalTokens,
        estimatedCostUsd: input.hardStop.estimatedCostUsd,
        issueState: runningEntry.issue.state,
      },
    });

    this.markIssueRequiresExplicitResume(issueId, runningEntry.issue.state);

    const comment = [
      `Hard stop outcome: ${input.hardStop.outcome}`,
      `Trigger: ${input.hardStop.trigger}`,
      `Reason: ${input.hardStop.reason}`,
      `Turns: ${input.hardStop.turnCount}`,
      `Total tokens: ${input.hardStop.totalTokens}`,
      `Estimated cost: $${input.hardStop.estimatedCostUsd.toFixed(2)}`,
      "",
      this.formatPauseResumeInstruction(runningEntry.issue.state, "continuing"),
    ].join("\n");

    await this.fireEscalationSideEffects(
      issueId,
      runningEntry.identifier,
      comment,
    );

    // Fire-and-forget budget-ceiling notification (SYMPH-397).
    // Only alert for budget-category outcomes (not iteration_cap, no_progress, etc.)
    if (isBudgetEscalationTrigger(input.hardStop.trigger)) {
      try {
        this.onHardStopBudget?.({
          issueId,
          issueIdentifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          stageName: input.stageName,
          trigger: input.hardStop.trigger,
          reason: input.hardStop.reason,
          totalTokens: input.hardStop.totalTokens,
          estimatedCostUsd: input.hardStop.estimatedCostUsd,
        });
      } catch {
        // Notification failures are always swallowed
      }
    }
  }

  private async handleOperatorInputRequiredPause(
    issueId: string,
    runningEntry: RunningEntry,
    input: {
      reason: string;
      stageName: string | null;
    },
  ): Promise<void> {
    await this.recordRunJournalEntry({
      idempotencyKey: `operator_input_required:${issueId}:${input.stageName ?? "no-stage"}:${formatAttemptKey(runningEntry.retryAttempt)}`,
      timestamp: this.now().toISOString(),
      kind: "operator_input_required",
      issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: input.stageName,
      attempt: runningEntry.retryAttempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Codex requested operator input for ${runningEntry.identifier}.`,
      metadata: {
        status: "completed",
        reason: input.reason,
        errorCode: ERROR_CODES.codexUserInputRequired,
        issueState: runningEntry.issue.state,
      },
    });

    this.markIssueRequiresExplicitResume(issueId, runningEntry.issue.state);

    const comment = [
      "Headless Codex requested operator input during the worker turn.",
      `Reason: ${input.reason}`,
      "",
      this.formatPauseResumeInstruction(runningEntry.issue.state, "retrying"),
    ].join("\n");

    await this.fireEscalationSideEffects(
      issueId,
      runningEntry.identifier,
      comment,
    );
  }

  private async handleContinuousFeedbackBounce(
    issueId: string,
    runningEntry: RunningEntry,
    stageName: string | null,
  ): Promise<RetryEntry | null | undefined> {
    if (!this.resolveContinuousFeedbackConfig().bounceOnFinding) {
      return undefined;
    }
    const feedback = this.state.continuousFeedback[issueId];
    const openFindings = getOpenContinuousFeedbackFindings(feedback);
    if (feedback === undefined || openFindings.length === 0) {
      return undefined;
    }

    this.state.issueReworkCounts[issueId] =
      (this.state.issueReworkCounts[issueId] ?? 0) + 1;
    this.state.continuousFeedback[issueId] =
      markContinuousFeedbackFindingsBounced(
        feedback,
        openFindings.map((finding) => finding.signature),
      );

    await this.recordRunJournalEntry({
      idempotencyKey: `continuous_feedback:${issueId}:${stageName ?? "no-stage"}:${formatAttemptKey(runningEntry.retryAttempt)}:bounce:${openFindings.map((finding) => finding.signature).join("|")}`,
      timestamp: this.now().toISOString(),
      kind: "continuous_feedback",
      issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "feedback_lane",
      stage: stageName,
      attempt: runningEntry.retryAttempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Continuous feedback bounced ${runningEntry.identifier} for inner-loop rework.`,
      metadata: {
        status: "bounced",
        findingSignatures: openFindings.map((finding) => finding.signature),
        authoritative: false,
      },
    });

    if (this.postComment !== undefined) {
      void this.postComment(
        issueId,
        formatContinuousFeedbackComment({
          issueIdentifier: runningEntry.identifier,
          stageName,
          findings: openFindings,
        }),
      ).catch((err) => {
        console.warn(
          `[orchestrator] Failed to post continuous feedback findings for ${runningEntry.identifier}:`,
          err,
        );
      });
    }

    return this.scheduleRetry(issueId, runningEntry.retryAttempt ?? 1, {
      identifier: runningEntry.identifier,
      error: "continuous feedback requested inner-loop rework",
      delayType: "continuation",
    });
  }

  private resolveWorkerLane(stageName: string | null): ContinuousFeedbackLane {
    const stage =
      stageName === null ? undefined : this.config.stages?.stages[stageName];
    return {
      runner: stage?.runner ?? this.config.runner.kind,
      model: stage?.model ?? this.config.runner.model,
      role: stageName ?? "worker",
    };
  }

  private resolveContinuousFeedbackConfig(): NonNullable<
    ResolvedWorkflowConfig["continuousFeedback"]
  > {
    return (
      this.config.continuousFeedback ?? {
        enabled: DEFAULT_CONTINUOUS_FEEDBACK_ENABLED,
        events: [...DEFAULT_CONTINUOUS_FEEDBACK_EVENTS],
        runner: DEFAULT_CONTINUOUS_FEEDBACK_RUNNER,
        model: DEFAULT_CONTINUOUS_FEEDBACK_MODEL,
        role: DEFAULT_CONTINUOUS_FEEDBACK_ROLE,
        bounceOnFinding: DEFAULT_CONTINUOUS_FEEDBACK_BOUNCE_ON_FINDING,
      }
    );
  }

  private async runTrackerWriteOnce(
    input: {
      idempotencyKey: string;
      issueId: string;
      issueIdentifier: string;
      stage: string | null;
      attempt: number | null;
      action: "update_issue_state" | "upsert_issue";
      summary: string;
    },
    write: () => Promise<void>,
  ): Promise<{ skipped: boolean }> {
    const completedKey = `${input.idempotencyKey}:completed`;
    if (this.hasCompletedJournalEntry(completedKey)) {
      return { skipped: true };
    }

    const leaseId = createDispatcherLeaseId({
      operation: "tracker_write",
      issueId: input.issueId,
      stage: input.stage,
      attempt: input.attempt,
      suffix: input.idempotencyKey,
    });
    const lease = await this.acquireDispatcherLease({
      leaseId,
      idempotencyKey: `${input.idempotencyKey}:started`,
      kind: "tracker_write",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: "tracker_write",
      stage: input.stage,
      attempt: input.attempt,
      summary: input.summary,
      metadata: {
        action: input.action,
      },
    });
    if (lease === null) {
      return { skipped: true };
    }

    await write();
    await this.completeDispatcherLease({
      leaseId,
      idempotencyKey: completedKey,
      kind: "tracker_write",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      operation: "tracker_write",
      stage: input.stage,
      attempt: input.attempt,
      summary: input.summary,
      metadata: {
        action: input.action,
      },
    });
    return { skipped: false };
  }

  private syncStateFromConfig(): void {
    this.state.pollIntervalMs = this.config.polling.intervalMs;
    this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;
  }

  private availableSlots(): number {
    return Math.max(
      this.state.maxConcurrentAgents - Object.keys(this.state.running).length,
      0,
    );
  }

  private availableSlotsForState(issueState: string): number {
    const normalizedState = normalizeIssueState(issueState);
    const limit =
      this.config.agent.maxConcurrentAgentsByState[normalizedState] ??
      this.state.maxConcurrentAgents;
    const runningForState = Object.values(this.state.running).filter(
      (entry) => normalizeIssueState(entry.issue.state) === normalizedState,
    ).length;
    return Math.max(limit - runningForState, 0);
  }

  private isRetryCandidateEligible(issue: Issue): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined ||
      this.hasBlockingDispatcherLease(issue.id)
    ) {
      return false;
    }

    if (normalizedState !== "todo") {
      return true;
    }

    return issue.blockedBy.every((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState !== null && terminalStates.has(blockerState);
    });
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
  ): Promise<
    | {
        dispatched: boolean;
        rightSizingDecision: RightSizingDecision;
      }
    | {
        dispatched: false;
        rightSizingDecision: RightSizingDecision | null;
      }
  > {
    const stagesConfig = this.config.stages;
    let stage: StageDefinition | null = null;
    let stageName: string | null = null;
    const attemptKey = formatAttemptKey(attempt);

    if (stagesConfig !== null) {
      const cachedStage = this.state.issueStages[issue.id];
      if (cachedStage !== undefined) {
        stageName = cachedStage;
      } else if (stagesConfig.fastTrack != null) {
        const matchedFastTrackLabel = stagesConfig.fastTrack.labels.find(
          (label) => issue.labels.includes(label),
        );
        if (matchedFastTrackLabel === undefined) {
          stageName = stagesConfig.initialStage;
        } else {
          stageName = stagesConfig.fastTrack.initialStage;
          console.log(
            `[orchestrator] Fast-tracking ${issue.identifier} to ${stageName} (label: ${matchedFastTrackLabel})`,
          );
        }
      } else {
        stageName = stagesConfig.initialStage;
      }
      stage = stagesConfig.stages[stageName] ?? null;

      if (cachedStage === undefined) {
        // Fresh admission (no live or gate-recovered stage): any lingering
        // AC snapshot is stale by definition — journal replay rehydrates
        // ac_gate entries from PRIOR runs after a restart, but agent-stage
        // completion has no replay-side clear (council R3, SYMPH-374). The
        // run starting now re-freezes its rubric at its own gate pass;
        // fast-tracked runs legitimately have none.
        delete this.state.issueAcSnapshots[issue.id];
      }

      if (stage !== null && stage.type === "terminal") {
        this.state.completed.add(issue.id);
        this.releaseClaim(issue.id);
        this.clearTerminalIssueRuntimeState(issue.id);
        // Fire linearState update for the terminal stage (e.g., move to "Done")
        if (stage.linearState !== null && this.updateIssueState !== undefined) {
          const linearState = stage.linearState;
          const updateIssueState = this.updateIssueState;
          void this.runTrackerWriteOnce(
            {
              idempotencyKey: `tracker_write:${issue.id}:terminal:${stageName}:${linearState}`,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              stage: stageName,
              attempt,
              action: "update_issue_state",
              summary: `Move ${issue.identifier} to terminal state ${linearState}.`,
            },
            async () => {
              await updateIssueState(issue.id, issue.identifier, linearState);
            },
          ).catch((err) => {
            console.warn(
              `[orchestrator] Failed to update terminal state for ${issue.identifier}:`,
              err,
            );
          });
        }
        return {
          dispatched: false,
          rightSizingDecision: null,
        };
      }

      if (stage !== null && stage.type === "gate") {
        const gateContext = this.resolveDecorrelatedGateContext(
          issue.id,
          stageName,
          stage,
        );
        const gateCycle = this.state.issueReworkCounts[issue.id] ?? 0;
        const gateLeaseId = createDispatcherLeaseId({
          operation: "gate",
          issueId: issue.id,
          stage: stageName,
          attempt,
          suffix: `gate-cycle-${gateCycle}`,
        });
        const gateLease = await this.acquireDispatcherLease({
          leaseId: gateLeaseId,
          idempotencyKey: `${gateLeaseId}:started`,
          kind: "gate_started",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          operation: "gate",
          stage: stageName,
          attempt,
          summary: `Gate ${stageName ?? "unnamed"} started for ${issue.identifier}.`,
          metadata: {
            gateType: stage.gateType,
            mode: gateContext?.mode ?? null,
            workerLane: gateContext?.workerLane ?? null,
            reviewerLanes: gateContext?.reviewerLanes ?? [],
            verifierSeparated: gateContext?.verifierSeparated ?? null,
            authoritative:
              gateContext === null ? null : gateContext.mode !== "prototype",
            gateCycle,
          },
        });
        if (gateLease === null) {
          return {
            dispatched: false,
            rightSizingDecision: null,
          };
        }
        this.state.issueStages[issue.id] = stageName;
        this.state.claimed.add(issue.id);

        if (gateContext?.explicitModeHint === "prototype") {
          await this.handlePrototypeGateBoundary({
            issue,
            stageName,
            attempt,
            gateContext,
            leaseId: gateLeaseId,
          });
          return {
            dispatched: false,
            rightSizingDecision: null,
          };
        }

        if (
          gateContext !== null &&
          stage.gateType === "ensemble" &&
          gateContext.mode !== "prototype" &&
          !gateContext.verifierSeparated
        ) {
          await this.handleUndecorrelatedGate({
            issue,
            stageName,
            stage,
            attempt,
            gateContext,
            leaseId: gateLeaseId,
          });
          return {
            dispatched: false,
            rightSizingDecision: null,
          };
        }

        if (stage.linearState !== null && this.updateIssueState !== undefined) {
          const linearState = stage.linearState;
          const updateIssueState = this.updateIssueState;
          try {
            await this.runTrackerWriteOnce(
              {
                idempotencyKey: `tracker_write:${issue.id}:gate:${stageName}:${linearState}`,
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                stage: stageName,
                attempt,
                action: "update_issue_state",
                summary: `Move ${issue.identifier} to gate state ${linearState}.`,
              },
              async () => {
                await updateIssueState(issue.id, issue.identifier, linearState);
              },
            );
          } catch (err) {
            console.warn(
              `[orchestrator] Failed to update issue state for ${issue.identifier}:`,
              err,
            );
          }
        }

        if (
          stage.gateType === "ensemble" &&
          this.runEnsembleGate !== undefined
        ) {
          // Fire ensemble gate asynchronously — resolve transitions on completion.
          void this.handleEnsembleGate(
            issue,
            stage,
            gateLeaseId,
            stageName,
            attempt,
            gateContext,
          );
        }
        // Human gates (or ensemble gates without handler): stay in gate state.
        return {
          dispatched: false,
          rightSizingDecision: null,
        };
      }

      // Track the issue's current stage
      this.state.issueStages[issue.id] = stageName;

      // Circuit breaker check (SYMPH-398): if the breaker is open for this
      // stage, park the issue loudly at the dispatch boundary and refuse to
      // spawn a worker. The breaker resets when the operator resumes an issue
      // it was opened for (isDispatchEligible -> resetBreakersForResumedIssue);
      // the resumed issue's first dispatch is the half-open canary and a
      // recurrence reopens the breaker via recordFailure. This check runs after
      // stage resolution so we have a real stage name.
      if (
        stageName !== null &&
        this.signatureClusterRegistry.isBreakerOpen(stageName)
      ) {
        const breakerEntry =
          this.signatureClusterRegistry.getBreakerEntry(stageName);
        const parkReason = `circuit breaker open for stage "${stageName}" (signature ${breakerEntry?.signature ?? "unknown"}): systemic failure cluster detected — operator action required`;
        this.state.failed.add(issue.id);
        this.releaseClaim(issue.id);
        this.clearTerminalIssueRuntimeState(issue.id);
        void this.fireEscalationSideEffects(
          issue.id,
          issue.identifier,
          parkReason,
        );
        void this.recordFailureExhausted(
          issue.id,
          issue.identifier,
          issue.title,
          parkReason,
        );
        console.log(
          `[orchestrator] ${issue.identifier}: parked at dispatch — circuit breaker open for stage "${stageName}"`,
        );
        return {
          dispatched: false,
          rightSizingDecision: null,
        };
      }
    }

    const isFirstDispatch = !this.state.issueFirstDispatchedAt[issue.id];
    if (isFirstDispatch) {
      this.state.issueFirstDispatchedAt[issue.id] = formatEasternTimestamp(
        this.now(),
      );
      this.state.decorrelatedGateOutcomes[issue.id] = [];
    }

    const rightSizingDecision = createRightSizingDecision({
      issue,
      config: this.config,
      stageName,
      attempt,
    });
    this.state.issueRightSizingDecisions[issue.id] = rightSizingDecision;
    const dispatchLeaseId = createDispatcherLeaseId({
      operation: "dispatcher",
      issueId: issue.id,
      stage: stageName,
      attempt,
    });
    const dispatchLease = await this.acquireDispatcherLease({
      leaseId: dispatchLeaseId,
      idempotencyKey: `${dispatchLeaseId}:admission`,
      kind: "admission",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt,
      summary: `Admitted ${issue.identifier} for worker dispatch.`,
      metadata: {
        attemptKey,
      },
    });
    if (dispatchLease === null) {
      if (isFirstDispatch) {
        // Unwind the premature first-dispatch marker: no lease means no
        // dispatch happened, so the next successful attempt must still
        // count as the first (and post the admission card).
        delete this.state.issueFirstDispatchedAt[issue.id];
      }
      return {
        dispatched: false,
        rightSizingDecision: null,
      };
    }
    await this.recordDispatcherDecisionEvent({
      decisionId: `${issue.id}:${stageName ?? "no-stage"}:${attemptKey}:admission`,
      category: "admission",
      classifier: "deterministic-disjointness-v1",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt,
      summary: `Measured admission accepted ${issue.identifier} for dispatch.`,
      context: {
        reason:
          "Issue passed deterministic eligibility and disjointness checks.",
        triggerHits: [],
        findingKinds: [],
        files:
          createIssueSupervisionSnapshot(issue).declaredFileScope?.slice() ??
          [],
        workerIds: [issue.id],
        details: {
          issueState: issue.state,
        },
      },
      expectedOutcome: {
        decision: "admit",
        classification: "negative",
        rationale:
          "Dispatch can proceed when no deterministic admission findings exist.",
        costWeight: "low",
      },
      observedOutcome: {
        decision: "admit",
        classification: "negative",
        rationale: "Issue was admitted and leased for worker dispatch.",
        costWeight: "low",
      },
    });
    await this.recordRunJournalEntry({
      idempotencyKey: `${dispatchLeaseId}:right_sizing`,
      timestamp: this.now().toISOString(),
      kind: "right_sizing",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Right-sized ${issue.identifier} as ${rightSizingDecision.mode}.`,
      metadata: {
        mode: rightSizingDecision.mode,
        classifier: rightSizingDecision.classifier,
        modelRoutingReason: rightSizingDecision.modelRouting.reason,
      },
    });
    if (
      this.config.admissionCard.enabled &&
      isFirstDispatch &&
      this.postComment !== undefined
    ) {
      // Admission card (SYMPH-379): publish the decision the dispatcher
      // already journaled. Fire-and-forget — observability never gates
      // dispatch, so even a synchronous formatter or transport fault is
      // contained here. A crash between the journal write above and this
      // post loses the card rather than double-posting — the deliberate
      // tradeoff for an observability-only surface.
      try {
        void this.postComment(
          issue.id,
          formatAdmissionCard({
            issueIdentifier: issue.identifier,
            stageName,
            decision: rightSizingDecision,
            budgetMultiplier: this.budgetMultiplierForIssue(issue.id),
            hasFrozenAcceptanceCriteria:
              this.state.issueAcSnapshots[issue.id] !== undefined,
          }),
        ).catch((err) => {
          console.warn(
            `[orchestrator] Failed to post admission card for ${issue.identifier}:`,
            err,
          );
        });
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to post admission card for ${issue.identifier}:`,
          err,
        );
      }
    }
    await this.recordDispatcherDecisionEvent({
      decisionId: `${issue.id}:${stageName ?? "no-stage"}:${attemptKey}:right_sizing`,
      category: "right_sizing",
      classifier: rightSizingDecision.classifier,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt,
      summary: `Measured right-sizing selected ${rightSizingDecision.mode} for ${issue.identifier}.`,
      context: {
        reason: rightSizingDecision.reason,
        triggerHits: rightSizingDecision.triggerHits,
        findingKinds: [],
        files: rightSizingDecision.signals.declaredScopeFiles,
        workerIds: [issue.id],
        details: {
          impactSurface: rightSizingDecision.signals.impactSurface,
          budget: rightSizingDecision.signals.budget,
          labels: rightSizingDecision.signals.labels,
          retryCount: rightSizingDecision.signals.retryCount,
          stageCount: rightSizingDecision.signals.stageCount,
          gateCount: rightSizingDecision.signals.gateCount,
          reviewerCount: rightSizingDecision.signals.reviewerCount,
        },
      },
      expectedOutcome: {
        decision: rightSizingDecision.mode,
        classification: classifyRightSizingDecision(rightSizingDecision.mode),
        rationale: rightSizingDecision.reason,
        costWeight: budgetToDecisionCostWeight(
          rightSizingDecision.signals.budget,
        ),
      },
    });
    await this.recordDispatcherDecisionEvent({
      decisionId: `${issue.id}:${stageName ?? "no-stage"}:${attemptKey}:model_routing`,
      category: "model_routing",
      classifier: rightSizingDecision.classifier,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: stageName,
      attempt,
      summary: `Measured model routing decided ${rightSizingDecision.modelRouting.allowed ? "route_to_strong" : "stay_deterministic"} for ${issue.identifier}.`,
      context: {
        reason: `Routing decision derived from ${rightSizingDecision.modelRouting.reason}.`,
        triggerHits: rightSizingDecision.triggerHits,
        findingKinds: [],
        files: rightSizingDecision.signals.declaredScopeFiles,
        workerIds: [issue.id],
        details: {
          mode: rightSizingDecision.mode,
          routingReason: rightSizingDecision.modelRouting.reason,
        },
      },
      expectedOutcome: {
        decision: rightSizingDecision.modelRouting.allowed
          ? "route_to_strong"
          : "stay_deterministic",
        classification: rightSizingDecision.modelRouting.allowed
          ? "positive"
          : "negative",
        rationale: `Routing reason: ${rightSizingDecision.modelRouting.reason}.`,
        costWeight: budgetToDecisionCostWeight(
          rightSizingDecision.signals.budget,
        ),
      },
    });

    if (
      stage?.linearState !== null &&
      stage?.linearState !== undefined &&
      this.updateIssueState !== undefined
    ) {
      const linearState = stage.linearState;
      const updateIssueState = this.updateIssueState;
      try {
        await this.runTrackerWriteOnce(
          {
            idempotencyKey: `tracker_write:${issue.id}:stage:${stageName}:${linearState}:${attemptKey}`,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            stage: stageName,
            attempt,
            action: "update_issue_state",
            summary: `Move ${issue.identifier} to stage state ${linearState}.`,
          },
          async () => {
            await updateIssueState(issue.id, issue.identifier, linearState);
          },
        );
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to update issue state for ${issue.identifier}:`,
          err,
        );
      }
    }

    try {
      const reworkCount = this.state.issueReworkCounts[issue.id] ?? 0;
      const spawned = await this.spawnWorker({
        issue,
        attempt,
        stage,
        stageName,
        reworkCount,
        isFirstDispatch,
        rightSizingDecision,
        budgetMultiplier: this.budgetMultiplierForIssue(issue.id),
        acceptanceCriteria: this.state.issueAcSnapshots[issue.id] ?? null,
      });
      const runEntry: RunningEntry = {
        ...createEmptyLiveSession(),
        issue,
        identifier: issue.identifier,
        retryAttempt: normalizeRetryAttempt(attempt),
        startedAt: formatEasternTimestamp(this.now()),
        workerHandle: spawned.workerHandle,
        monitorHandle: spawned.monitorHandle,
        failureReason: null,
      };
      this.state.running[issue.id] = runEntry;
      this.state.claimed.add(issue.id);
      this.clearRetryEntry(issue.id);
      // Verdict event (SYMPH-405): the dispatch went out. The right-sizing
      // decision summary is already in hand, so it rides along in details.
      this.recordDispatchVerdict({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: "admit",
        reasonCode: "dispatched",
        stage: stageName,
        attempt,
        details: {
          mode: rightSizingDecision.mode,
          classifier: rightSizingDecision.classifier,
          modelRoutingReason: rightSizingDecision.modelRouting.reason,
        },
      });
      return {
        dispatched: true,
        rightSizingDecision,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.warn(
        `[orchestrator] ${issue.identifier}: Dispatch failure: ${errorMessage}`,
        errorStack ?? "",
      );
      // Capture failure in a transient running entry for observability before
      // scheduling the retry. The entry is removed so it does not block retry
      // dispatch eligibility.
      const failedEntry: RunningEntry = {
        ...createEmptyLiveSession(),
        issue,
        identifier: issue.identifier,
        retryAttempt: normalizeRetryAttempt(attempt),
        startedAt: formatEasternTimestamp(this.now()),
        workerHandle: null,
        monitorHandle: null,
        failureReason: errorMessage,
      };
      this.state.running[issue.id] = failedEntry;
      this.scheduleRetry(issue.id, nextRetryAttempt(attempt), {
        identifier: issue.identifier,
        issueTitle: issue.title,
        error: errorMessage,
        delayType: "failure",
      });
      await this.completeDispatcherLease({
        leaseId: dispatchLeaseId,
        idempotencyKey: `${dispatchLeaseId}:spawn_failed`,
        kind: "admission",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        operation: "dispatcher",
        stage: stageName,
        attempt,
        summary: `Worker dispatch failed for ${issue.identifier}.`,
        metadata: {
          error: errorMessage,
        },
      });
      delete this.state.running[issue.id];
      return {
        dispatched: false,
        rightSizingDecision: null,
      };
    }
  }

  private async reconcileRunningIssues(): Promise<{
    stopRequests: StopRequest[];
    reconciliationFetchFailed: boolean;
  }> {
    const stopRequests = await this.reconcileStalledRuns();
    const runningIds = Object.keys(this.state.running);
    if (runningIds.length === 0) {
      return {
        stopRequests,
        reconciliationFetchFailed: false,
      };
    }

    let refreshed: IssueStateSnapshot[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch {
      return {
        stopRequests,
        reconciliationFetchFailed: true,
      };
    }

    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    const refreshedIds = new Set(refreshed.map((snapshot) => snapshot.id));

    for (const snapshot of refreshed) {
      const runningEntry = this.state.running[snapshot.id];
      if (runningEntry === undefined) {
        continue;
      }

      const normalizedState = normalizeIssueState(snapshot.state);
      if (terminalStates.has(normalizedState)) {
        if (!this.isWorkerInFinalActiveStage(snapshot.id)) {
          stopRequests.push(
            await this.requestStop(runningEntry, true, "terminal_state"),
          );
        }
        continue;
      }

      if (activeStates.has(normalizedState)) {
        runningEntry.issue = {
          ...runningEntry.issue,
          identifier: snapshot.identifier,
          state: snapshot.state,
        };
        runningEntry.identifier = snapshot.identifier;
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    for (const runningId of runningIds) {
      if (refreshedIds.has(runningId)) {
        continue;
      }

      const runningEntry = this.state.running[runningId];
      if (runningEntry === undefined) {
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    return {
      stopRequests,
      reconciliationFetchFailed: false,
    };
  }

  /**
   * Returns true if the worker for the given issue is in the final active
   * stage — i.e., its onComplete target is null or points to a terminal stage.
   * In that case, the worker itself drove the issue to terminal state and
   * should be allowed to finish gracefully rather than being stopped.
   */
  private isWorkerInFinalActiveStage(issueId: string): boolean {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return false;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      // Stage already cleaned up by advanceStage (completed) — the worker
      // is finishing its final stage. Allow it to complete gracefully.
      return true;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return false;
    }

    const nextStageName = currentStage.transitions.onComplete;
    if (nextStageName === null) {
      return true;
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      return false;
    }

    return nextStage.type === "terminal";
  }

  private async reconcileStalledRuns(): Promise<StopRequest[]> {
    if (this.config.codex.stallTimeoutMs <= 0) {
      return [];
    }

    const nowMs = this.now().getTime();
    const stopRequests: StopRequest[] = [];
    for (const runningEntry of Object.values(this.state.running)) {
      const baselineTimestamp = parseEventTimestamp(
        runningEntry.lastCodexTimestamp,
        runningEntry.startedAt,
      );
      if (baselineTimestamp === null) {
        continue;
      }

      if (nowMs - baselineTimestamp > this.config.codex.stallTimeoutMs) {
        stopRequests.push(
          await this.requestStop(runningEntry, false, "stall_timeout"),
        );
      }
    }

    return stopRequests;
  }

  private async superviseRunningWorkers(): Promise<StopRequest[]> {
    const runningEntries = Object.values(this.state.running);
    if (runningEntries.length === 0) {
      return [];
    }

    const snapshots =
      this.getRunningSupervisionSnapshots === undefined
        ? runningEntries.map((entry) =>
            createIssueSupervisionSnapshot(entry.issue, {
              workerId: entry.issue.id,
            }),
          )
        : await this.getRunningSupervisionSnapshots(runningEntries);
    await this.reportIgnoredSetupInstructionCollisions(
      detectIgnoredSetupInstructionCollisions(snapshots),
    );
    const findings = detectSupervisionFindings(snapshots);
    if (findings.length === 0) {
      return [];
    }

    await this.reportSupervisionFindings("running", findings);
    return await this.enforceWriteCollisions(findings);
  }

  /**
   * SYMPH-363: a confirmed live write collision pauses exactly one lane —
   * detection without enforcement let two colliding workers burn for 25
   * minutes after a correct re-steer comment. Precedence is deterministic:
   * later pipeline stage survives, then the earlier first-dispatch, then
   * lexicographic identifier. The loser stops through the standard stop
   * machinery (parks loudly, resumable via the normal Resume path) with a
   * resume-plan comment.
   */
  private async enforceWriteCollisions(
    findings: readonly SupervisionFinding[],
  ): Promise<StopRequest[]> {
    const stops: StopRequest[] = [];
    for (const finding of findings) {
      if (finding.kind !== "actual_write_collision") {
        continue;
      }
      const entries = finding.workerIds
        .map((workerId) => this.state.running[workerId])
        .filter((entry): entry is RunningEntry => entry !== undefined);
      if (entries.length < 2) {
        continue;
      }

      const ranked = [...entries].sort((a, b) => {
        const stageDelta =
          this.stagePrecedence(b.issue.id) - this.stagePrecedence(a.issue.id);
        if (stageDelta !== 0) {
          return stageDelta;
        }
        const aFirstRaw = this.state.issueFirstDispatchedAt[a.issue.id];
        const bFirstRaw = this.state.issueFirstDispatchedAt[b.issue.id];
        const aFirst =
          aFirstRaw === undefined ? Number.MAX_VALUE : Date.parse(aFirstRaw);
        const bFirst =
          bFirstRaw === undefined ? Number.MAX_VALUE : Date.parse(bFirstRaw);
        if (aFirst !== bFirst) {
          return aFirst - bFirst;
        }
        return a.identifier.localeCompare(b.identifier);
      });

      const survivor = ranked[0];
      for (const loser of ranked.slice(1)) {
        if (survivor === undefined || loser === undefined) {
          continue;
        }
        if (stops.some((stop) => stop.issueId === loser.issue.id)) {
          continue;
        }
        try {
          await this.postComment?.(
            loser.issue.id,
            [
              "## Supervision enforcement: paused for write collision",
              `${loser.identifier} and ${survivor.identifier} are changing the same files (${finding.files.join(", ")}). ${survivor.identifier} has precedence (further along / earlier dispatch); this lane is paused.`,
              `Resume plan: move this issue to Resume after ${survivor.identifier}'s PR merges — the workspace base refresh will reconcile the overlap.`,
            ].join("\n"),
          );
        } catch {
          // Observability only.
        }
        stops.push(await this.requestStop(loser, false, "manual_stop"));
      }
    }
    return stops;
  }

  private stagePrecedence(issueId: string): number {
    const stageName = this.state.issueStages[issueId];
    if (stageName === undefined || this.config.stages === null) {
      return -1;
    }
    return Object.keys(this.config.stages.stages).indexOf(stageName);
  }

  private buildRunningAdmissionSnapshots(): WorkerSupervisionSnapshot[] {
    return Object.values(this.state.running).map((entry) =>
      createIssueSupervisionSnapshot(entry.issue, {
        workerId: entry.issue.id,
      }),
    );
  }

  private detectDispatchAdmissionFindings(
    admittedSnapshots: readonly WorkerSupervisionSnapshot[],
    candidateSnapshot: WorkerSupervisionSnapshot,
  ): SupervisionFinding[] {
    return detectSupervisionFindings([
      ...admittedSnapshots,
      candidateSnapshot,
    ]).filter(
      (finding) =>
        finding.workerIds.includes(candidateSnapshot.workerId) &&
        (finding.kind === "declared_scope_overlap" ||
          finding.kind === "branch_divergence"),
    );
  }

  private async reportSupervisionFindings(
    phase: SupervisionResteerRequest["phase"],
    findings: readonly SupervisionFinding[],
  ): Promise<void> {
    const freshFindings = findings.filter((finding) => {
      const signature = formatSupervisionFindingSignature(phase, finding);
      if (this.reportedSupervisionFindings.has(signature)) {
        return false;
      }
      this.reportedSupervisionFindings.add(signature);
      return true;
    });
    if (freshFindings.length === 0) {
      return;
    }

    for (const finding of freshFindings) {
      const signature = formatSupervisionFindingSignature(phase, finding);
      await this.recordRunJournalEntry({
        idempotencyKey: `supervision_finding:${signature}`,
        timestamp: this.now().toISOString(),
        kind: "supervision_finding",
        issueId: finding.workerIds[0] ?? "unknown",
        issueIdentifier: finding.issueIdentifiers[0] ?? "unknown",
        operation: "supervisor",
        stage: null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: finding.message,
        metadata: {
          phase,
          signature,
          findingKind: finding.kind,
          action: finding.action,
          workerIds: finding.workerIds,
          issueIdentifiers: finding.issueIdentifiers,
          files: finding.files,
        },
      });

      if (this.requestTrackerIssueWrite !== undefined) {
        try {
          await this.runTrackerWriteOnce(
            {
              idempotencyKey: `tracker_write:follow_up:${signature}`,
              issueId: finding.workerIds[0] ?? "unknown",
              issueIdentifier: finding.issueIdentifiers[0] ?? "unknown",
              stage: null,
              attempt: null,
              action: "upsert_issue",
              summary: `Upsert tracker follow-up for ${finding.kind}.`,
            },
            async () => {
              await this.requestTrackerIssueWrite?.({
                boundary: {
                  type: "explicit_finding",
                  phase,
                  finding,
                },
              });
            },
          );
        } catch (error) {
          console.warn(
            `[orchestrator] Failed to upsert tracker follow-up for ${finding.issueIdentifiers[0] ?? "unknown"}:`,
            error,
          );
        }
      }
    }

    const resteerSignature = freshFindings
      .map((finding) => formatSupervisionFindingSignature(phase, finding))
      .join("|");
    await this.recordDispatcherDecisionEvent({
      decisionId: `re_steer:${phase}:${resteerSignature}`,
      category: "re_steer",
      classifier: "deterministic-supervision-v1",
      issueId: freshFindings[0]?.workerIds[0] ?? "unknown",
      issueIdentifier: freshFindings[0]?.issueIdentifiers[0] ?? "unknown",
      operation: "supervisor",
      stage: null,
      attempt: null,
      summary: `Measured re-steer decision for ${freshFindings.length} supervision finding(s).`,
      context: {
        reason:
          "Fresh deterministic supervision findings require bounded re-steer or escalation.",
        triggerHits: [],
        findingKinds: freshFindings.map((finding) => finding.kind),
        files: freshFindings.flatMap((finding) => finding.files),
        workerIds: freshFindings.flatMap((finding) => finding.workerIds),
        details: {
          phase,
          signature: resteerSignature,
          actions: freshFindings.map((finding) => finding.action),
        },
      },
      expectedOutcome: {
        decision: "request_re_steer",
        classification: "positive",
        rationale:
          "Fresh supervision findings should trigger a bounded re-steer request.",
        costWeight: "high",
      },
      observedOutcome:
        this.requestSupervisionResteer === undefined
          ? null
          : {
              decision: "request_re_steer",
              classification: "positive",
              rationale:
                "A re-steer side effect is available and was requested.",
              costWeight: "high",
            },
    });

    if (this.requestSupervisionResteer === undefined) {
      return;
    }

    const resteerKey = `re_steer_request:${phase}:${resteerSignature}`;
    if (this.hasCompletedJournalEntry(`${resteerKey}:completed`)) {
      return;
    }
    const lease = await this.acquireDispatcherLease({
      leaseId: resteerKey,
      idempotencyKey: `${resteerKey}:started`,
      kind: "re_steer_request",
      issueId: freshFindings[0]?.workerIds[0] ?? "unknown",
      issueIdentifier: freshFindings[0]?.issueIdentifiers[0] ?? "unknown",
      operation: "supervisor",
      stage: null,
      attempt: null,
      summary: `Re-steer requested for ${freshFindings.length} supervision finding(s).`,
      metadata: {
        phase,
        signature: resteerSignature,
      },
    });
    if (lease === null) {
      return;
    }

    await this.requestSupervisionResteer({
      phase,
      findings: freshFindings,
      comment: formatSupervisionFindingsComment({
        phase,
        findings: freshFindings,
      }),
    });
    await this.completeDispatcherLease({
      leaseId: resteerKey,
      idempotencyKey: `${resteerKey}:completed`,
      kind: "re_steer_request",
      issueId: freshFindings[0]?.workerIds[0] ?? "unknown",
      issueIdentifier: freshFindings[0]?.issueIdentifiers[0] ?? "unknown",
      operation: "supervisor",
      stage: null,
      attempt: null,
      summary: "Re-steer request side effect completed.",
      metadata: {
        phase,
        signature: resteerSignature,
      },
    });
  }

  private async reportIgnoredSetupInstructionCollisions(
    collisions: readonly IgnoredSetupInstructionCollision[],
  ): Promise<void> {
    for (const collision of collisions) {
      const signature =
        formatIgnoredSetupInstructionCollisionSignature(collision);
      if (this.reportedIgnoredSetupInstructionCollisions.has(signature)) {
        continue;
      }
      this.reportedIgnoredSetupInstructionCollisions.add(signature);

      try {
        await this.recordRunJournalEntry({
          idempotencyKey: `supervision_ignored_setup_instruction_collision:${signature}`,
          timestamp: this.now().toISOString(),
          kind: "supervision_finding",
          issueId: collision.workerIds[0] ?? "unknown",
          issueIdentifier: collision.issueIdentifiers[0] ?? "unknown",
          operation: "supervisor",
          stage: null,
          attempt: null,
          ownerId: this.leaseOwnerId,
          lease: null,
          summary: collision.message,
          metadata: {
            phase: "running",
            signature,
            findingKind: "ignored_setup_instruction_collision",
            action: "ignored",
            workerIds: collision.workerIds,
            issueIdentifiers: collision.issueIdentifiers,
            files: collision.files,
            ignored: true,
            nonBlocking: true,
          },
        });
      } catch (error) {
        console.warn(
          "[orchestrator] Failed to record ignored setup-instruction collision diagnostic:",
          error,
        );
      }
    }
  }

  private async requestStop(
    runningEntry: RunningEntry,
    cleanupWorkspace: boolean,
    reason: StopReason,
  ): Promise<StopRequest> {
    const stopRequest: StopRequest = {
      issueId: runningEntry.issue.id,
      issueIdentifier: runningEntry.identifier,
      cleanupWorkspace,
      reason,
    };
    const leaseId = createDispatcherLeaseId({
      operation: "dispatcher",
      issueId: runningEntry.issue.id,
      stage: this.state.issueStages[runningEntry.issue.id] ?? null,
      attempt: runningEntry.retryAttempt,
      suffix: `hard_stop:${reason}`,
    });
    const lease = await this.acquireDispatcherLease({
      leaseId,
      idempotencyKey: `${leaseId}:started`,
      kind: "hard_stop_trigger",
      issueId: runningEntry.issue.id,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: this.state.issueStages[runningEntry.issue.id] ?? null,
      attempt: runningEntry.retryAttempt,
      summary: `Hard-stop requested for ${runningEntry.identifier}: ${reason}.`,
      metadata: {
        cleanupWorkspace,
        reason,
        issueState: runningEntry.issue.state,
      },
    });

    if (lease !== null) {
      if (reason === "manual_stop" || reason === "inactive_state") {
        this.recordIssueRequiresExplicitResume(
          runningEntry.issue.id,
          runningEntry.issue.state,
        );
      }
      await this.stopRunningIssue?.({
        issueId: runningEntry.issue.id,
        runningEntry,
        cleanupWorkspace,
        reason,
      });
      await this.completeDispatcherLease({
        leaseId,
        idempotencyKey: `${leaseId}:completed`,
        kind: "hard_stop_trigger",
        issueId: runningEntry.issue.id,
        issueIdentifier: runningEntry.identifier,
        operation: "dispatcher",
        stage: this.state.issueStages[runningEntry.issue.id] ?? null,
        attempt: runningEntry.retryAttempt,
        summary: `Hard-stop completed for ${runningEntry.identifier}: ${reason}.`,
        metadata: {
          cleanupWorkspace,
          reason,
          issueState: runningEntry.issue.state,
        },
      });
    }

    return stopRequest;
  }

  /**
   * Record a failure into the cross-ticket signature cluster registry and fire
   * onSystemicCluster if the cluster crosses the alert threshold. This is the
   * single seam that both scheduleRetry and any park-without-retry path must
   * call so that all failure classes (including "spec") participate in systemic
   * detection and circuit-breaker logic.
   *
   * The caller is responsible for normalizing the error text via
   * normalizeErrorSignature before passing it in; the method takes the already-
   * decomposed fields so it can also be used by paths that compute the signature
   * themselves for other purposes (e.g. the novelty short-circuit).
   */
  private recordFailureInCluster(
    issueId: string,
    issueIdentifier: string,
    incoming: NormalizedErrorSignature,
    stageName: string | null,
  ): void {
    const clusterResult = this.signatureClusterRegistry.recordFailure({
      signature: incoming.signature,
      errorClass: incoming.class,
      normalizedText: incoming.normalizedText,
      issueId,
      issueIdentifier,
      stageName,
      now: this.now(),
    });

    // Verdict events (SYMPH-405): journal cluster growth / systemic
    // transitions and breaker opens so the registry can rebuild on replay
    // (closes the SYMPH-398 restart-amnesia hole). Fire-and-forget.
    if (clusterResult.memberAdded || clusterResult.shouldAlert) {
      const timestamp = this.now().toISOString();
      const transition = clusterResult.isSystemic ? "systemic" : "growth";
      const stages = [
        ...new Set(
          clusterResult.members
            .map((member) => member.stageName)
            .filter((stage): stage is string => stage !== null),
        ),
      ];
      // Sequence-suffixed key (not timestamp): a same-ms re-entry of the
      // same issue/signature after a membership reset must not drop the
      // latest membership snapshot from the replay record.
      this.commitVerdictJournalEntrySync({
        idempotencyKey: `cluster:${clusterResult.signature}:${issueId}:${this.nextRunJournalSequence()}`,
        timestamp,
        kind: "cluster_transition",
        issueId,
        issueIdentifier,
        operation: "dispatcher",
        stage: stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Signature cluster ${clusterResult.signature} ${transition}: ${clusterResult.clusterSize} distinct issue(s).`,
        metadata: {
          schema_version: 1,
          transition,
          signature: clusterResult.signature,
          issueCount: clusterResult.clusterSize,
          stages,
          details: {
            errorClass: clusterResult.errorClass,
            normalizedText: clusterResult.normalizedText,
            members: clusterResult.members,
            lastAlertSize: clusterResult.shouldAlert
              ? clusterResult.clusterSize
              : clusterResult.lastAlertSize,
          },
        },
      });
    }
    if (clusterResult.shouldOpenBreaker && stageName !== null) {
      this.recordBreakerTransition({
        transition: "opened",
        stageName,
        signature: clusterResult.signature,
        issueId,
        issueIdentifier,
        openedForIssueIds: clusterResult.members.map(
          (member) => member.issueId,
        ),
      });
    }

    if (clusterResult.shouldAlert) {
      try {
        this.onSystemicCluster?.({
          signature: clusterResult.signature,
          errorClass: clusterResult.errorClass,
          stageName,
          clusterSize: clusterResult.clusterSize,
          issueIdentifiers: clusterResult.members.map((m) => m.issueIdentifier),
          breakerOpened: clusterResult.shouldOpenBreaker,
          canFileWatchdogTicket: clusterResult.canFileWatchdogTicket,
          members: clusterResult.members,
        });
      } catch {
        // Cluster callbacks are fire-and-forget; never surface into the loop
      }
    }
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    input: {
      identifier: string | null;
      /** Issue title to thread into failure-exhausted notifications. When omitted,
       * the title is resolved from state.running (which may already be cleared). */
      issueTitle?: string;
      error: string | null;
      delayType: "continuation" | "failure";
      /** When true, this call is an admission deferral (no-slots or deterministic
       * supervision pause) — not a real worker failure.  Deferrals must never
       * participate in the novelty short-circuit: neither recording nor comparing
       * failure signatures.  Two consecutive same-reason deferrals would otherwise
       * produce identical signatures and falsely park a healthy queued issue. */
      deferral?: boolean;
    },
  ): RetryEntry | null {
    // Max retry guard — only applies to failure retries, not continuations
    if (
      input.delayType === "failure" &&
      attempt > this.config.agent.maxRetryAttempts
    ) {
      const exhaustedTitle =
        input.issueTitle ??
        this.state.running[issueId]?.issue.title ??
        input.identifier ??
        issueId;
      this.state.failed.add(issueId);
      this.releaseClaim(issueId);
      this.clearTerminalIssueRuntimeState(issueId);
      void this.fireEscalationSideEffects(
        issueId,
        input.identifier ?? issueId,
        `Max retry attempts (${this.config.agent.maxRetryAttempts}) exceeded. Escalating for manual review.`,
      );
      void this.recordFailureExhausted(
        issueId,
        input.identifier ?? issueId,
        exhaustedTitle,
        input.error ?? "max retry attempts exceeded",
      );
      return null;
    }

    // Retry-without-novelty short-circuit (SYMPH-396): record the normalized
    // failure signature on every failure retry so subsequent attempts can
    // detect a repeat. On attempt >= 2, if the incoming signature matches the
    // stored one AND the class is not "transient", park immediately — retrying
    // an identical permanent failure is futile.
    //
    // Admission deferrals (input.deferral === true) are explicitly excluded:
    // a deferral is an orchestrator-synthetic "not yet" decision, not a real
    // worker failure.  Two consecutive same-reason deferrals would otherwise
    // produce identical signatures and falsely park a healthy queued issue
    // before any worker attempt fires.
    if (
      input.delayType === "failure" &&
      input.error !== null &&
      !input.deferral
    ) {
      const stage = this.state.issueStages[issueId] ?? null;
      const sigKey = `${issueId}:${stage ?? ""}`;
      const incoming = normalizeErrorSignature(input.error);
      const previous = this.state.issueFailureSignatures[sigKey];
      if (
        attempt >= 2 &&
        previous !== undefined &&
        incoming.signature === previous.signature &&
        incoming.class !== "transient"
      ) {
        // Identical non-transient signature — park loudly, skip ladder
        const parkReason = `retry futile: identical failure signature ${incoming.signature} (${incoming.class})`;
        const parkedTitle =
          input.issueTitle ??
          this.state.running[issueId]?.issue.title ??
          input.identifier ??
          issueId;
        this.state.failed.add(issueId);
        this.releaseClaim(issueId);
        this.clearTerminalIssueRuntimeState(issueId);
        void this.fireEscalationSideEffects(
          issueId,
          input.identifier ?? issueId,
          parkReason,
        );
        void this.recordFailureExhausted(
          issueId,
          input.identifier ?? issueId,
          parkedTitle,
          parkReason,
          {
            failure_signature: incoming.signature,
            failure_class: incoming.class,
          },
        );
        return null;
      }
      // Record (or update) the signature for comparison on the next attempt
      this.state.issueFailureSignatures[sigKey] = {
        signature: incoming.signature,
        class: incoming.class,
      };

      // Cross-ticket signature clustering (SYMPH-398): record this failure in
      // the registry via the shared seam so spec-park and other non-retry paths
      // can call the same logic without duplication.
      this.recordFailureInCluster(
        issueId,
        input.identifier ?? issueId,
        incoming,
        stage,
      );
    }

    this.clearRetryEntry(issueId);

    const delayMs =
      input.delayType === "continuation"
        ? CONTINUATION_RETRY_DELAY_MS
        : computeFailureRetryDelayMs(
            attempt,
            this.config.agent.maxRetryBackoffMs,
          );
    const dueAtMs = this.now().getTime() + delayMs;
    const timerHandle = this.timerScheduler.set(() => {
      void this.runScheduledRetryTimer(issueId, {
        attempt,
        identifier: input.identifier,
        delayType: input.delayType,
      });
    }, delayMs);

    const retryEntry: RetryEntry = {
      issueId,
      identifier: input.identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error: input.error,
      delayType: input.delayType,
    };

    this.state.claimed.add(issueId);
    this.state.retryAttempts[issueId] = retryEntry;
    return retryEntry;
  }

  private async runScheduledRetryTimer(
    issueId: string,
    retryContext: ScheduledRetryContext,
  ): Promise<void> {
    try {
      await this.onRetryTimer(issueId);
    } catch (error) {
      const errorMessage = formatUnknownError(error);
      console.warn(
        `[orchestrator] Retry timer failed for ${retryContext.identifier ?? issueId}: ${errorMessage}`,
      );
      this.scheduleRetry(issueId, retryContext.attempt + 1, {
        identifier: retryContext.identifier,
        error: `retry timer failed: ${errorMessage}`,
        delayType: retryContext.delayType,
      });
    }
  }

  private clearRetryEntry(issueId: string): void {
    const current = this.state.retryAttempts[issueId];
    if (current !== undefined) {
      this.timerScheduler.clear(current.timerHandle);
      delete this.state.retryAttempts[issueId];
    }
  }

  private releaseClaim(issueId: string): void {
    this.clearRetryEntry(issueId);
    this.state.claimed.delete(issueId);
  }
}

export function sortIssuesForDispatch(issues: readonly Issue[]): Issue[] {
  return issues.slice().sort((left, right) => {
    const priorityDelta =
      toSortablePriority(left.priority) - toSortablePriority(right.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const createdAtDelta =
      toSortableDate(left.createdAt) - toSortableDate(right.createdAt);
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return left.identifier.localeCompare(right.identifier, "en");
  });
}

export function computeFailureRetryDelayMs(
  attempt: number,
  maxRetryBackoffMs: number,
): number {
  const normalizedAttempt = Math.max(attempt, 1);
  const exponentialDelay =
    FAILURE_RETRY_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1);
  return Math.min(exponentialDelay, maxRetryBackoffMs);
}

// rate_limit_budget is deliberately NOT escalatable: the ladder widens token
// and dollar budgets but cannot relieve a subscription-window constraint, so
// escalating a window-bound unit mechanically re-triggers and burns widened
// budget for no gain (PR #329 review P1). Window pauses wait for the floor /
// reset timing or the operator.
export const BUDGET_ESCALATION_TRIGGERS: ReadonlySet<HardStopTrigger> = new Set(
  ["token_budget", "dollar_budget", "premium_spend_near_ceiling"],
);

function isBudgetEscalationTrigger(trigger: HardStopTrigger): boolean {
  return BUDGET_ESCALATION_TRIGGERS.has(trigger);
}

function nextRetryAttempt(attempt: number | null): number {
  return attempt === null ? 1 : attempt + 1;
}

function createDispatcherLeaseId(input: {
  operation: DispatcherOperation;
  issueId: string;
  stage: string | null;
  attempt: number | null;
  suffix?: string;
}): string {
  return [
    input.operation,
    input.issueId,
    input.stage ?? "no-stage",
    formatAttemptKey(input.attempt),
    input.suffix ?? "lease",
  ]
    .map(sanitizeJournalKeyPart)
    .join(":");
}

function formatAttemptKey(attempt: number | null): string {
  return attempt === null ? "initial" : `attempt-${attempt}`;
}

function classifyRightSizingDecision(
  mode: RightSizingDecision["mode"],
): DispatcherDecisionClassification {
  return mode === "prototype" ? "negative" : "positive";
}

function budgetToDecisionCostWeight(
  budget: RightSizingDecision["signals"]["budget"],
): DispatcherDecisionCostWeight {
  switch (budget) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
  }
}

function sanitizeJournalKeyPart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function normalizeRetryAttempt(attempt: number | null): number | null {
  return attempt === null ? null : Math.max(1, Math.floor(attempt));
}

function formatWorkerExitReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return normalized && normalized.length > 0
    ? `worker exited: ${normalized}`
    : "worker exited: abnormal";
}

function toSortablePriority(priority: number | null): number {
  return priority === null ? Number.POSITIVE_INFINITY : priority;
}

function toSortableDate(timestamp: string | null): number {
  if (timestamp === null) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseEventTimestamp(
  lastCodexTimestamp: string | null,
  startedAt: string,
): number | null {
  if (lastCodexTimestamp !== null) {
    const parsed = Date.parse(lastCodexTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function toNormalizedStateSet(states: readonly string[]): Set<string> {
  return new Set(states.map((state) => normalizeIssueState(state)));
}

function toDecorrelatedGateOutcome(
  entry: DispatcherRunJournalEntry,
): DecorrelatedGateOutcome | null {
  const status = toDecorrelatedGateStatus(entry.metadata);
  const mode = toRightSizingMode(entry.metadata.mode);
  const workerLane = toDecorrelatedGateLane(entry.metadata.workerLane);
  const reviewerLanes = toDecorrelatedGateLanes(entry.metadata.reviewerLanes);
  const verifierSeparated = toOptionalBoolean(entry.metadata.verifierSeparated);
  const authoritative = toOptionalBoolean(entry.metadata.authoritative);

  if (
    status === null ||
    mode === null ||
    workerLane === null ||
    reviewerLanes === null ||
    verifierSeparated === null
  ) {
    return null;
  }

  return {
    issueId: entry.issueId,
    issueIdentifier: entry.issueIdentifier,
    gateStage: entry.stage,
    mode,
    status,
    aggregate: toGateAggregate(entry.metadata.aggregate),
    checkedAt: entry.timestamp,
    workerLane,
    reviewerLanes,
    verifierSeparated,
    authoritative: authoritative ?? status !== "skipped_prototype",
    reworkTarget:
      typeof entry.metadata.reworkTarget === "string"
        ? entry.metadata.reworkTarget
        : null,
    summary: entry.summary,
  };
}

function toDecorrelatedGateStatus(
  metadata: Record<string, unknown>,
): DecorrelatedGateOutcome["status"] | null {
  if (metadata.status === "skipped_prototype") {
    return "skipped_prototype";
  }
  if (metadata.status === "blocked") {
    return "blocked";
  }
  if (metadata.aggregate === "pass") {
    return "passed";
  }
  if (metadata.aggregate === "fail") {
    return "failed";
  }
  return null;
}

function toGateAggregate(value: unknown): "pass" | "fail" | null {
  return value === "pass" || value === "fail" ? value : null;
}

function toRightSizingMode(value: unknown): RightSizingMode | null {
  return value === "prototype" || value === "thin" || value === "full"
    ? value
    : null;
}

function toDecorrelatedGateLanes(
  value: unknown,
): DecorrelatedGateLane[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const lanes: DecorrelatedGateLane[] = [];
  for (const item of value) {
    const lane = toDecorrelatedGateLane(item);
    if (lane === null) {
      return null;
    }
    lanes.push(lane);
  }
  return lanes;
}

function toDecorrelatedGateLane(value: unknown): DecorrelatedGateLane | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.runner !== "string" ||
    typeof value.role !== "string" ||
    (value.model !== null && typeof value.model !== "string") ||
    (value.stageName !== null && typeof value.stageName !== "string")
  ) {
    return null;
  }

  return {
    runner: value.runner,
    model: value.model,
    role: value.role,
    stageName: value.stageName,
  };
}

function toOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSupervisionFindingSignature(
  phase: SupervisionResteerRequest["phase"],
  finding: SupervisionFinding,
): string {
  return [
    phase,
    finding.kind,
    finding.action,
    ...finding.issueIdentifiers,
    ...finding.workerIds,
    ...finding.files,
  ].join("\0");
}

function formatIgnoredSetupInstructionCollisionSignature(
  collision: IgnoredSetupInstructionCollision,
): string {
  return [
    "running",
    "ignored_setup_instruction_collision",
    ...collision.issueIdentifiers,
    ...collision.workerIds,
    ...collision.files,
  ].join("\0");
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameGateLane(
  left: DecorrelatedGateLane,
  right: DecorrelatedGateLane,
): boolean {
  return (
    left.runner === right.runner &&
    left.model === right.model &&
    left.role === right.role
  );
}

function formatGateLane(lane: DecorrelatedGateLane): string {
  return `${lane.runner}${lane.model === null ? "" : `/${lane.model}`} (${lane.role})`;
}

export function classifyExitOutcome(
  outcome: WorkerExitOutcome,
  turnCount: number,
  reason: string | undefined,
): string {
  if (outcome === "normal") {
    return "normal";
  }
  // Already classified — pass through
  if (
    outcome === "failed_to_start" ||
    outcome === "timed_out" ||
    outcome === "error"
  ) {
    return outcome;
  }
  // Classify "abnormal" based on context
  if (isCodexUserInputRequiredReason(reason)) {
    return "input_required";
  }
  if (turnCount === 0) {
    return "failed_to_start";
  }
  if (reason?.includes("stall_timeout")) {
    return "timed_out";
  }
  return "error";
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

function parseStoppedAfterReason(
  reason: string | undefined,
): StopReason | null {
  if (reason === undefined) {
    return null;
  }

  const prefix = "stopped after ";
  if (!reason.startsWith(prefix)) {
    return null;
  }

  const rawReason = reason.slice(prefix.length);
  return isStopReason(rawReason) ? rawReason : null;
}

function isStopReason(value: string): value is StopReason {
  return (
    value === "terminal_state" ||
    value === "inactive_state" ||
    value === "stall_timeout" ||
    value === "manual_stop"
  );
}

function isDispatcherAdmissionEntry(entry: DispatcherRunJournalEntry): boolean {
  return (
    entry.kind === "admission" &&
    entry.operation === "dispatcher" &&
    entry.metadata.status === "started"
  );
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function toVerdictDisposition(value: unknown): VerdictDisposition | null {
  return typeof value === "string" &&
    (VERDICT_DISPOSITIONS as readonly string[]).includes(value)
    ? (value as VerdictDisposition)
    : null;
}

function toClusterMembers(value: unknown): ClusterMember[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const members: ClusterMember[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as { issueId?: unknown }).issueId !== "string" ||
      typeof (candidate as { issueIdentifier?: unknown }).issueIdentifier !==
        "string"
    ) {
      return null;
    }
    const raw = candidate as {
      issueId: string;
      issueIdentifier: string;
      stageName?: unknown;
      recordedAt?: unknown;
      normalizedText?: unknown;
    };
    members.push({
      issueId: raw.issueId,
      issueIdentifier: raw.issueIdentifier,
      stageName: typeof raw.stageName === "string" ? raw.stageName : null,
      recordedAt: typeof raw.recordedAt === "string" ? raw.recordedAt : "",
      normalizedText:
        typeof raw.normalizedText === "string" ? raw.normalizedText : "",
    });
  }
  return members;
}

function defaultTimerScheduler(): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}
