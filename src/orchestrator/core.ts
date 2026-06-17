import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

import { extractAcceptanceCriteria } from "../agent/ac-gate.js";
import type {
  PauseTriageEvidence,
  PauseTriageVerdict,
} from "../agent/pause-triage.js";
import type {
  StuckTriageEvidence,
  StuckTriageParkKind,
  StuckTriageVerdict,
} from "../agent/stuck-triage.js";
import type { CodexClientEvent } from "../codex/app-server-client.js";
import {
  evaluateWindowHeadroom,
  observedWindowDeltaPercent,
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
  type BlockerRef,
  type ComputedDispatchOrderSnapshot,
  type ContinuousFeedbackEvent,
  type ContinuousFeedbackIssueState,
  type ContinuousFeedbackLane,
  type ContinuousFeedbackStatus,
  type DecorrelatedGateLane,
  type DecorrelatedGateOutcome,
  type DispatchFenceSource,
  type DispatchFenceState,
  type DispatcherDecisionCategory,
  type DispatcherDecisionClassification,
  type DispatcherDecisionCostWeight,
  type DispatcherDecisionEvent,
  type DispatcherDecisionOutcome,
  type DispatcherLease,
  type DispatcherOperation,
  type DispatcherRunJournal,
  type DispatcherRunJournalEntry,
  type ExecutionHistory,
  FAILURE_CLASSES,
  type FailureClass,
  type Issue,
  type IssueAnchorExpiry,
  type IssueAnchorPlacement,
  type IssueAnchorRecord,
  type LiveSession,
  type OrchestratorState,
  type PendingStageSignal,
  type PipelineEmergencyStopState,
  type PipelinePauseState,
  type RateLimitAdmissionState,
  type RetryEntry,
  type RightSizingDecision,
  type RightSizingMode,
  type RunningEntry,
  type StageRecord,
  VERDICT_DISPOSITIONS,
  type VerdictActor,
  type VerdictDisposition,
  containsStageCompleteSignal,
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
  normalizeReviewFailureSignature,
} from "../errors/signature.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  type DispatcherRunJournalEntryDraft,
  appendDispatcherRunJournalEntry,
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
import type { HeadlessCouncilGateResult } from "../review/headless-council-gate.js";
import { buildReviewJournalEntries } from "../review/review-journal-events.js";
import { normalizeAccountEmail } from "../shared/account-email.js";
import { sanitizeForLinear } from "../shared/egress.js";
import { readProcessIdentityMetadata } from "../shared/process-tree.js";
import {
  type TicketFeature,
  extractTicketFeatures,
} from "../tracker/ticket-feature.js";
import type { IssueStateSnapshot, IssueTracker } from "../tracker/tracker.js";
import { formatAdmissionCard } from "./admission-card.js";
import { parseAnchorUntilTimestamp } from "./anchor-date.js";
import {
  formatInvalidAnchorPlacementDetail,
  isIssueAnchorExpired,
  normalizeIssueIdentifier,
  validateAnchorPlacementForIssue,
} from "./anchor-policy.js";
import {
  type BacklogHygieneLaneResult,
  type BacklogHygieneProposal,
  type BacklogHygieneProposalDecision,
  type RunBacklogHygieneProposalLaneInput,
  buildBacklogHygieneCodeGroundingInput,
  buildBacklogHygieneDecisionJournalEntry,
  buildBacklogHygieneProposalJournalEntry,
  runBacklogHygieneProposalLane as runBacklogHygieneProposalLaneForInput,
} from "./backlog-hygiene.js";
import type {
  CodeGroundingCommandRunner,
  CodeGroundingTarget,
} from "./code-grounding.js";
import {
  CONTINUOUS_FEEDBACK_PROVIDER_FAILURE_SUMMARY_PREFIX,
  type ContinuousFeedbackReviewResult,
  ensureDecorrelatedFeedbackLane,
  formatContinuousFeedbackComment,
  getOpenContinuousFeedbackFindings,
  markContinuousFeedbackFindingsBounced,
  mergeContinuousFeedbackCheckpoint,
} from "./continuous-feedback.js";
import { extractDispatcherDecisionEvents } from "./decision-quality.js";
import {
  DISPATCH_COMPARATOR_VERSION,
  computeDispatchOrder,
  sortIssuesForDispatch as sortIssuesForDispatchByPriorityFifo,
} from "./dispatch-comparator.js";
import {
  type EnsembleGateResult,
  formatExecutionReport,
  formatRebaseComment,
  formatReviewFindingsComment,
} from "./gate-handler.js";
import {
  type AnchorIntentPayload,
  INTENT_SCHEMA_VERSION,
  type IntentActor,
  type IntentFence,
  type IntentReason,
  type IntentVerb,
  type IntentWriteResult,
  PIPELINE_INTENT_ISSUE_ID,
  PIPELINE_INTENT_ISSUE_IDENTIFIER,
  formatIntentActorKey,
  formatIntentAttribution,
  isIntentActorKind,
} from "./intent.js";
import {
  type MergeActuatorLiveState,
  type MergeActuatorSideEffects,
  type MergeCandidateRecord,
  mergeActuatorPollAttempt,
  mergeReworkParkDetail,
  reduceMergeCandidates,
  runMergeActuatorCycle,
} from "./merge-candidate.js";
import { createRightSizingDecision } from "./right-sizing.js";
import { SignatureClusterRegistry } from "./signature-cluster.js";
import type {
  ClusterMember,
  WatchdogRegistrySnapshot,
} from "./signature-cluster.js";
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
const HARD_STOP_COMMENT_UNTRUSTED_FIELD_MAX_LEN = 600;

/**
 * An issue may fail review on the SAME pre-gate criterion at most twice
 * before parking (SYMPH-402): the Nth identical failure would start rework
 * round N, and a third round against an unchanged criterion is futile.
 */
const MAX_SAME_CRITERION_REVIEW_FAILURES = 3;
const SAME_FAMILY_REASONING_TRIPWIRE_COUNT = 2;
const MAX_REVIEW_SUBSTRATE_DEGRADATION_FAILURES = 2;
const MAX_REVIEW_GATE_ERROR_FAILURES = 2;
const REVIEW_SUBSTRATE_DEGRADATION_REGEX =
  /\b(?:substrate_stall|malformed_substrate_json):/i;
const REVIEW_SUBSTRATE_DEGRADATION_PREFIXES = [
  "substrate_stall:",
  "malformed_substrate_json:",
];
const REVIEW_GATE_RESULT_PATH_PREFIX = "[REVIEW_GATE_RESULT_PATH:";
const REVIEW_GATE_RESULT_PATH_SUFFIX = "]";
const FAILURE_RETRY_BASE_DELAY_MS = 10_000;
/**
 * Orchestrator-side merge-actuator re-poll backoff ladder (SYMPH-753). Replaces
 * the flat 1s continuation cadence for actuator re-polls so a PR held in the
 * merge queue (or a bounded pre-enqueue wait) issues O(log) `gh pr view` calls
 * over the wait window instead of ~one per second. The attempt index is derived
 * from the durable journal (replay-stable). The last rung caps the delay.
 */
const MERGE_ACTUATOR_POLL_BACKOFF_MS: readonly number[] = [
  30_000, 30_000, 60_000, 120_000, 300_000,
];
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
  /**
   * Pipeline emergency-stop replay found the interrupted issue but did not see
   * a completed per-issue stop record. A normal Resume transition cannot prove
   * the old detached process tree was killed, so runtime recovery must confirm
   * cleanup before ordinary Resume can clear this fail-closed guard.
   */
  requiresConfirmedEmergencyStop?: boolean;
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

interface PendingStageConsumptionRollbackSnapshot {
  state: OrchestratorState;
  lastExitHistorySnapshot: Map<string, ExecutionHistory>;
  resumeRequiredGuards: Map<string, ResumeRequiredGuard>;
  issueParkGenerations: Map<string, number>;
  triagedParkGenerations: Map<string, number>;
  escalatedParkGenerations: Map<string, number | null>;
  issueAnchorCursors: Map<string, { generation: number; atMs: number }>;
  anchorCursorSequence: number;
  parkSequence: number;
}

interface BudgetPauseHandlingResult {
  handled: boolean;
  retryEntry: RetryEntry | null;
}

interface FailureSignalHandlingOptions {
  emitSideEffects: boolean;
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
  | "manual_stop"
  | "emergency_stop";

export interface SpawnWorkerResult {
  workerHandle: unknown;
  monitorHandle: unknown;
}

export interface StopRequest {
  issueId: string;
  issueIdentifier: string;
  cleanupWorkspace: boolean;
  reason: StopReason;
  signalDelivery?: StopSignalDelivery | null;
}

export type StopSignalDeliveryStatus =
  | "not_attempted"
  | "already_exited"
  | "delivered"
  | "partial"
  | "failed";

export type StopSignalStatus =
  | "delivered"
  | "already_exited"
  | "failed"
  | "not_attempted";

export interface StopSignalDeliveryAttempt {
  pid: number;
  processGroupId: number | null;
  sigterm: Exclude<StopSignalStatus, "not_attempted">;
  sigkill: StopSignalStatus;
}

export interface StopSignalDelivery {
  /**
   * Aggregate proof status. "delivered" means every target reached a terminal
   * non-failed state; it can include a failed SIGTERM followed by delivered
   * SIGKILL, so operator displays must keep per-signal attempts visible.
   */
  status: StopSignalDeliveryStatus;
  reason: StopReason;
  attemptedAt: string;
  workspacePath: string | null;
  attempts: StopSignalDeliveryAttempt[];
  warning: string | null;
}

interface IntentWriteInput {
  verb: IntentVerb;
  issueId: string;
  issueIdentifier: string;
  actor: IntentActor;
  reason: IntentReason;
  fence?: IntentFence;
  /** Stage context: restored for retry_once; rework source for rework_with_hint. */
  stage?: string | null;
  /** Hint text for rework_with_hint (journaled; the caller renders it). */
  hint?: string | null;
  /** Anchor payload for the anchor verb (SYMPH-486). */
  anchor?: AnchorIntentPayload;
  /** Tracker state at write time, journaled for replay parity. */
  issueState?: string | null;
  /** Signature the retry_once grant guards against (SYMPH-396 fields). */
  grantSignature?: string | null;
  /**
   * When false, suppress the intent's own attribution comment (callers
   * that render a richer attributed surface, e.g. triage verdicts, must
   * include formatIntentAttribution themselves).
   */
  renderComment?: boolean;
  extraMetadata?: Record<string, unknown>;
}

type IntentWriteOutput = IntentWriteResult & {
  stopRequest?: StopRequest | null;
  retryEntry?: RetryEntry | null;
};

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

type DispatchIssueDisposition =
  | "dispatched"
  | "pending_stage_signal"
  | "terminal_stage"
  | "gate_lease_unavailable"
  | "prototype_gate"
  | "undecorrelated_gate"
  | "gate_started"
  | "circuit_breaker_open"
  | "merge_candidate_barrier"
  | "lease_unavailable"
  | "spawn_failed";

type DispatchIssueResult =
  | {
      dispatched: true;
      rightSizingDecision: RightSizingDecision;
      disposition: "dispatched";
      reasonCode: "dispatched";
    }
  | {
      dispatched: false;
      rightSizingDecision: null;
      disposition: Exclude<DispatchIssueDisposition, "dispatched">;
      reasonCode: string;
    };

interface DispatchAttemptObservation {
  issueId: string;
  issueIdentifier: string;
  disposition: DispatchIssueDisposition;
  reasonCode: string;
}

export interface EmergencyStopResult {
  status: "applied" | "no_op";
  detail: string;
  sequence: number | null;
  interruptedIssues: PipelineEmergencyStopState["interruptedIssues"];
  stopRequests: StopRequest[];
}

export interface CodexEventResult {
  applied: boolean;
  /** True when the event carried a fresh rate-limit snapshot (SYMPH-336). */
  rateLimitsUpdated: boolean;
}

export interface ContinuousFeedbackCheckpointResult {
  ran: boolean;
  status: ContinuousFeedbackStatus | "skipped";
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
  delayType: "continuation" | "failure" | "merge_actuator_poll";
}

/**
 * Evidence captured at a watchdog park site BEFORE clearTerminalIssueRuntimeState
 * erases the per-issue runtime state it digests (SYMPH-399). parkKind gates
 * whether the L2 triage lane fires: only "novelty" and "breaker" parks are
 * triaged; "retry_once_failed" explicitly never is (no second triage).
 */
interface WatchdogParkContext {
  parkKind:
    | StuckTriageParkKind
    | "spec"
    | "retry_exhausted"
    | "retry_once_failed";
  stageName: string | null;
  issueDescription: string | null;
  attemptCount: number | null;
  reworkCount: number;
  stageHistory: Array<{ stageName: string; outcome: string; turns: number }>;
  failureRecords: Array<{
    raw: string;
    signature: string | null;
    failureClass: string | null;
  }>;
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
  }) => Promise<unknown> | unknown;
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
  // SYMPH-735 merge-actuator substrate. Dormant in this phase: assigned to
  // private fields but never invoked; the live merge-stage dispatch barrier
  // still parks (merge_actuator_unwired) until Phase 2 wires the dispatch.
  getMergeActuatorLiveState?: (
    candidate: MergeCandidateRecord,
  ) => Promise<MergeActuatorLiveState | null>;
  mergeActuatorSideEffects?: MergeActuatorSideEffects;
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
   * Called when an ensemble gate returns code-review failures, or when repeated
   * reviewer infrastructure errors park the issue (SYMPH-397/SYMPH-366).
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
   * Called when the AC falsifiability gate fails open (SYMPH-431).
   * Fire-and-forget; a notifier failure must not block stage advancement.
   */
  onAcGateFailOpen?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    failOpenStreak: number;
    severity: "warning" | "critical";
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
    /**
     * Journal sequence of the cluster_transition entry behind this alert
     * (SYMPH-407): embedded in Slack alerts and watchdog ticket bodies as
     * the event cursor. Null when no entry was journaled (idempotent replay).
     */
    journalSequence: number | null;
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
    /**
     * Journal sequence of the dispatch_verdict entry behind this transition
     * (SYMPH-407): embedded in outbound alerts as the (issue, seq) cursor.
     * Null when the verdict deduped to an existing journal entry.
     */
    sequence: number | null;
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
  /**
   * Called after a replayed active Pipeline issue successfully spawns work
   * again in this process (SYMPH-455). The journal entry is committed before
   * this fires; `sequence` is the cursor operators can inspect via /state.
   */
  onExistingActiveResumed?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    issueUrl: string | null;
    stageName: string | null;
    attempt: number | null;
    reworkCount: number;
    sequence: number | null;
  }) => void;
  /**
   * Watchdog L2 stuck-ticket triage (SYMPH-399): render a bounded-action
   * verdict over a watchdog park (novelty short-circuit or breaker park).
   * Resolve null to fail closed — the park stands. Only consulted when
   * `watchdog.stuck_triage.enabled` is true.
   */
  runStuckTriage?: (
    evidence: StuckTriageEvidence,
  ) => Promise<StuckTriageVerdict | null>;
  /**
   * Called when an L2 triage verdict escalates to a human (SYMPH-399),
   * carrying the model's one-paragraph case. Posts through the SYMPH-397
   * notifier. Fire-and-forget; failures never surface into the loop.
   */
  onTriageEscalation?: (input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    classification: string;
    confidence: string;
    caseText: string;
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

  private readonly getMergeActuatorLiveState?: OrchestratorCoreOptions["getMergeActuatorLiveState"];

  private readonly mergeActuatorSideEffects?: OrchestratorCoreOptions["mergeActuatorSideEffects"];

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

  private readonly onAcGateFailOpen?: OrchestratorCoreOptions["onAcGateFailOpen"];

  private readonly onSystemicCluster?: OrchestratorCoreOptions["onSystemicCluster"];

  private readonly onVerdictTransition?: OrchestratorCoreOptions["onVerdictTransition"];

  private readonly onDispatchPage?: OrchestratorCoreOptions["onDispatchPage"];

  private readonly onExistingActiveResumed?: OrchestratorCoreOptions["onExistingActiveResumed"];

  private readonly runStuckTriage?: OrchestratorCoreOptions["runStuckTriage"];

  private readonly onTriageEscalation?: OrchestratorCoreOptions["onTriageEscalation"];

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
   * visibility writer (commitRunJournalEntrySync) — chains through this
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

  private acGateFailOpenStreak = 0;

  private readonly reportedSupervisionFindings = new Set<string>();

  /**
   * Sequences of stage_record entries already reduced into
   * issueExecutionHistory. The stage_record reducer is the lone additive
   * reducer in recoverFromRunJournal, so a repeated replay of the same
   * journal must not double-count spend.
   */
  private readonly reducedStageRecordSequences = new Set<number>();

  private readonly reportedIgnoredSetupInstructionCollisions =
    new Set<string>();

  /**
   * Issues whose prior dispatch state was rehydrated from the dispatcher
   * journal in this process. A subsequent successful worker spawn is a
   * restart pickup/resume, distinct from same-process stage continuation.
   */
  private readonly replayedDispatchedIssueIds = new Set<string>();

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

  /**
   * Current park generation per issue (SYMPH-399 intent fencing). Set on
   * EVERY park path (stop-like pauses via recordIssueRequiresExplicitResume
   * AND watchdog failure-exhausted parks); cleared on release/resume and at
   * terminal cleanup. An intent verb carrying a stale generation is
   * rejected without mutating anything.
   */
  private readonly issueParkGenerations = new Map<string, number>();

  /**
   * One-triage-per-park guard (SYMPH-399): park generation that already
   * received a stuck-triage dispatch. A verdict is causally tied to exactly
   * one park; a re-park (new generation) may triage again, the same park
   * never does.
   */
  private readonly triagedParkGenerations = new Map<string, number>();

  /**
   * Escalation-once-per-park guard (SYMPH-422 council P2): park generation
   * whose escalate_human already applied. escalate_human is the one verb
   * that returns "applied" while the park stands, so journal-key dedup is
   * its only re-issue guard — and key dedup is exact string equality, which
   * a key-format migration breaks (a #374-era entry never matches a
   * re-issued new-format key, double-applying the escalation and posting a
   * duplicate comment on upgrade restart). This marker makes the verb
   * itself idempotent per park: a re-park (new generation) may escalate
   * again; the same park never does. `null` records an escalation against
   * a parked issue with no generation (defensive — parks always mint one).
   */
  private readonly escalatedParkGenerations = new Map<string, number | null>();

  private anchorCursorSequence = 0;

  /**
   * Last effective anchor-family mutation per issue. This covers anchor,
   * unanchor, expiry, and terminal-consumption clears, including the
   * unanchored state where `issueAnchors` has no record left to compare.
   */
  private readonly issueAnchorCursors = new Map<
    string,
    { generation: number; atMs: number }
  >();
  private readonly anchorMutationLocks = new Map<string, Promise<void>>();

  /**
   * Single retry_once grant per issue (SYMPH-399): the signature of the
   * park the grant was issued against. Consumed on the first post-grant
   * failure: an identical signature goes straight back to park with NO
   * second triage; a novel signature re-enters the normal ladder.
   */
  private readonly retryOnceGrants = new Map<
    string,
    { signature: string | null }
  >();

  private readonly pendingDispatcherLeaseIds = new Set<string>();

  private readonly pendingDispatcherLeaseIssueIds = new Set<string>();

  private rateLimitAdmissionReservation: {
    key: string;
    count: number;
  } | null = null;

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
    this.getMergeActuatorLiveState = options.getMergeActuatorLiveState;
    this.mergeActuatorSideEffects = options.mergeActuatorSideEffects;
    this.autoCloseParentIssue = options.autoCloseParentIssue;
    this.getRunningSupervisionSnapshots =
      options.getRunningSupervisionSnapshots;
    this.requestSupervisionResteer = options.requestSupervisionResteer;
    this.requestTrackerIssueWrite = options.requestTrackerIssueWrite;
    this.runContinuousFeedback = options.runContinuousFeedback;
    this.timerScheduler = options.timerScheduler ?? defaultTimerScheduler();
    this.now = options.now ?? (() => new Date());
    this.leaseOwnerId = options.leaseOwnerId ?? createDefaultLeaseOwnerId();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_DISPATCHER_LEASE_TTL_MS;
    this.writeRunJournalEntry = options.writeRunJournalEntry;
    this.onFailureExhausted = options.onFailureExhausted;
    this.onHardStopBudget = options.onHardStopBudget;
    this.onEscalationStep = options.onEscalationStep;
    this.onGateFailed = options.onGateFailed;
    this.onAcGateFailOpen = options.onAcGateFailOpen;
    this.onSystemicCluster = options.onSystemicCluster;
    this.onVerdictTransition = options.onVerdictTransition;
    this.onDispatchPage = options.onDispatchPage;
    this.onExistingActiveResumed = options.onExistingActiveResumed;
    this.runStuckTriage = options.runStuckTriage;
    this.onTriageEscalation = options.onTriageEscalation;
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

  /**
   * Current durable journal cursor (SYMPH-407): the sequence of the last
   * committed journal entry. Burned rollback sequences are an in-process
   * allocator floor only; advertising them would let since_seq consumers skip
   * a reused committed entry after restart.
   */
  getRunJournalCursor(): number {
    return this.state.dispatcherRunJournal.at(-1)?.sequence ?? 0;
  }

  createRunJournalCheckpointDraft(): DispatcherRunJournalEntryDraft | null {
    const coveredThroughSequence = this.getRunJournalCursor();
    if (coveredThroughSequence <= 0) {
      return null;
    }
    const timestamp = this.now().toISOString();
    return {
      idempotencyKey: `journal_checkpoint:${coveredThroughSequence}`,
      timestamp,
      kind: "journal_checkpoint",
      issueId: "__dispatcher__",
      issueIdentifier: "DISPATCHER",
      operation: "dispatcher",
      stage: null,
      attempt: null,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Dispatcher run-journal checkpoint through seq ${coveredThroughSequence}.`,
      metadata: {
        schema_version: 1,
        checkpoint_type: "dispatcher_run_journal",
        coveredThroughSequence,
        state: this.createRunJournalCheckpointState(),
        privateState: this.createRunJournalCheckpointPrivateState(),
        decisionQualityEvents: extractDispatcherDecisionEvents(
          this.state.dispatcherRunJournal,
        ),
      },
    };
  }

  confirmEmergencyStopProcessCleanup(issueId: string): void {
    const guard = this.resumeRequiredGuards.get(issueId);
    if (guard?.requiresConfirmedEmergencyStop !== true) {
      return;
    }
    this.resumeRequiredGuards.set(issueId, {
      ...guard,
      requiresConfirmedEmergencyStop: false,
    });
    const mark = this.state.resumeRequiredMarks[issueId];
    if (mark?.reason === "killed_mid_run_unconfirmed") {
      this.state.resumeRequiredMarks[issueId] = {
        ...mark,
        reason: "killed_mid_run",
      };
    }
  }

  requireEmergencyStopProcessCleanup(
    issueId: string,
    input: { setBySequence: number | null; since: string | null },
  ): void {
    const guard = this.resumeRequiredGuards.get(issueId);
    if (guard === undefined) {
      return;
    }
    this.resumeRequiredGuards.set(issueId, {
      ...guard,
      pausedAt: input.since ?? guard.pausedAt,
      requiresConfirmedEmergencyStop: true,
    });
    const mark = this.state.resumeRequiredMarks[issueId];
    if (mark !== undefined) {
      this.state.resumeRequiredMarks[issueId] = {
        ...mark,
        reason: "killed_mid_run_unconfirmed",
        setBySequence: input.setBySequence,
        since: input.since ?? mark.since,
      };
    }
  }

  async recordEmergencyStopRecoveryCleanup(input: {
    issueId: string;
    issueIdentifier: string;
    codexAppServerPid: string | null;
    codexAppServerIdentity: PipelineEmergencyStopState["interruptedIssues"][number]["codexAppServerIdentity"];
    sourceSequence: number;
  }): Promise<number | null> {
    try {
      const timestamp = this.now().toISOString();
      const entry = await this.recordRunJournalEntry({
        idempotencyKey: `hard_stop:${input.issueId}:recovery:emergency_stop:${input.sourceSequence}`,
        timestamp,
        kind: "hard_stop_trigger",
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Emergency-stop recovery cleanup completed for ${input.issueIdentifier}.`,
        metadata: {
          status: "completed",
          // Recovery cleanup only proves the detached process tree is gone;
          // preserving the workspace keeps post-mortem state available. The
          // owning hard-stop entry, not this cleanup proof, carries stage and
          // passed-stage continuity during journal replay.
          cleanupWorkspace: false,
          reason: "emergency_stop",
          recovery: "journal_hydration",
          sourceSequence: input.sourceSequence,
          codexAppServerPid: input.codexAppServerPid,
          codexAppServerIdentity: input.codexAppServerIdentity,
        },
      });
      this.recoverHardStopTrigger(entry);
      return entry.sequence;
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal emergency-stop recovery cleanup for ${input.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Serializable cluster/breaker summary for the /api/v1/state watchdog
   * section (SYMPH-407). Delegates to the same registry the dispatcher
   * consults — no second source of truth.
   */
  getWatchdogRegistrySnapshot(): WatchdogRegistrySnapshot {
    return this.signatureClusterRegistry.toWatchdogSnapshot();
  }

  recoverFromRunJournal(journal: DispatcherRunJournal): void {
    this.state.dispatcherRunJournal = [...journal].sort(
      (left, right) => left.sequence - right.sequence,
    );
    this.state.dispatcherLeases = {};
    this.signatureClusterRegistry.clearForReplay();
    this.reportedSupervisionFindings.clear();
    this.reportedIgnoredSetupInstructionCollisions.clear();
    this.state.decorrelatedGateOutcomes = {};
    this.lastVerdictKeys.clear();
    this.state.issueDispositions = {};
    this.state.resumeRequiredMarks = {};
    this.state.issueAnchors = {};
    this.issueAnchorCursors.clear();
    this.anchorCursorSequence = 0;
    this.state.emergencyStop = null;
    this.state.pipelinePause = null;
    this.state.issuePendingStageSignals = {};
    // Re-invocation safety (council R2): the stage_record reducer is
    // additive, so a replay against a different journal (runtime-host root
    // swap) must rebuild spend history from scratch — clear the
    // seen-sequence guard together with the history it feeds, or stale
    // sequence numbers from the previous journal would suppress reduction.
    this.reducedStageRecordSequences.clear();
    this.state.issueExecutionHistory = {};
    this.state.continuousFeedback = {};
    this.replayedDispatchedIssueIds.clear();
    this.starvedTickCount = 0;
    this.pageAlertActive = false;
    this.acGateFailOpenStreak = 0;

    const nowMs = this.now().getTime();
    let checkpointCoveredThroughSequence = 0;
    for (const entry of this.state.dispatcherRunJournal) {
      if (entry.kind === "journal_checkpoint") {
        const coveredThroughSequence = this.recoverRunJournalCheckpoint(entry);
        if (coveredThroughSequence !== null) {
          checkpointCoveredThroughSequence = Math.max(
            checkpointCoveredThroughSequence,
            coveredThroughSequence,
          );
        }
        continue;
      }
      if (entry.sequence <= checkpointCoveredThroughSequence) {
        continue;
      }

      if (entry.lease !== null) {
        this.state.dispatcherLeases[entry.lease.leaseId] = {
          ...entry.lease,
          lastJournalSequence: entry.sequence,
        };
      }

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
          {
            reason: "operator_input_required",
            setBySequence: entry.sequence,
            parkGeneration: readMetadataNumber(
              entry.metadata,
              "parkGeneration",
            ),
          },
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
          { reason: "failure_exhausted", setBySequence: entry.sequence },
        );
      }

      if (isDispatcherAdmissionEntry(entry)) {
        this.clearResumeRequirement(entry.issueId);
        this.clearRetryEntry(entry.issueId);
        this.state.claimed.delete(entry.issueId);
      }

      // Intent events replay through the same reducer (SYMPH-399): a
      // journaled release/retry/rework clears any earlier park so replay of
      // park → release converges on released (SYMPH-368: operator releases
      // used to be invisible to the journal and replay re-parked over them).
      if (
        entry.kind === "intent" &&
        entry.metadata.status === "no_op" &&
        (entry.metadata.verb === "anchor" ||
          entry.metadata.verb === "unanchor") &&
        parseAnchorCursorTimestamp(entry.metadata.anchorEditedAt) !== null
      ) {
        this.recordAnchorCursorFromJournalEntry(entry);
      }

      if (entry.kind === "intent" && entry.metadata.status === "applied") {
        const verb = entry.metadata.verb;
        if (verb === "anchor") {
          this.applyAnchorJournalEntry(entry);
        } else if (verb === "unanchor") {
          delete this.state.issueAnchors[entry.issueId];
          this.recordAnchorCursorFromJournalEntry(entry);
        } else if (verb === "pipeline_stop") {
          this.recoverEmergencyStopIntent(entry);
        } else if (verb === "pipeline_resume") {
          this.state.emergencyStop = null;
          this.state.pipelinePause = null;
        } else if (verb === "pipeline_pause") {
          this.recoverPipelinePauseIntent(entry);
        } else if (
          verb === "pipeline_dispatch_fence" ||
          verb === "pipeline_dispatch_unfence"
        ) {
          this.recoverDispatchFenceIntent(entry);
        } else if (verb === "park" || verb === "halt") {
          this.markIssueRequiresExplicitResume(
            entry.issueId,
            readMetadataString(entry.metadata, "issueState"),
            entry.timestamp,
            {
              reason: formatIntentMarkReason(verb, entry.metadata),
              setBySequence: entry.sequence,
            },
          );
        } else if (
          verb === "release" ||
          verb === "retry_once" ||
          verb === "rework_with_hint"
        ) {
          this.clearResumeRequirement(entry.issueId);
          this.state.failed.delete(entry.issueId);
          this.state.failureExhaustedIds.delete(entry.issueId);
          this.issueParkGenerations.delete(entry.issueId);
          this.triagedParkGenerations.delete(entry.issueId);
          this.retryOnceGrants.delete(entry.issueId);
          this.escalatedParkGenerations.delete(entry.issueId);

          if (verb === "rework_with_hint") {
            // Restore the rework stage transition so a mid-rework restart
            // converges on the rework stage, not the pre-rework stage
            // (SYMPH-399 P2 / SYMPH-368 pattern). The entry's metadata
            // carries the RESOLVED reworkTarget and post-increment
            // reworkCount journaled at apply time (council R2): replaying
            // them verbatim keeps the landing stage stable across config
            // edits and prevents a crash-replay from forgetting the
            // consumed rework and granting one extra pass beyond maxRework.
            const journaledTarget = readMetadataString(
              entry.metadata,
              "reworkTarget",
            );
            const journaledCount = readMetadataNumber(
              entry.metadata,
              "reworkCount",
            );
            if (journaledTarget !== null && journaledCount !== null) {
              this.state.issueStages[entry.issueId] = journaledTarget;
              this.state.issueReworkCounts[entry.issueId] = journaledCount;
            } else {
              // Legacy entry written before the resolved values were
              // journaled: fall back to deriving the target from the
              // current config (best effort — may differ if the workflow
              // changed since the write). The consumed count cannot be
              // recovered from a legacy entry, so it stays unrestored and
              // such an issue may get one extra rework after a replay.
              const parkedStage = entry.stage;
              if (parkedStage !== null && this.config.stages !== null) {
                const stageDef = this.config.stages.stages[parkedStage];
                const reworkTarget = stageDef?.transitions.onRework ?? null;
                if (reworkTarget !== null) {
                  this.state.issueStages[entry.issueId] = reworkTarget;
                }
              }
            }
          }

          if (verb === "retry_once") {
            // Restore the single-retry grant so the post-restart granted
            // attempt is still exempt from the novelty short-circuit
            // (SYMPH-399 P3 — grant envelope survives restart in the grant
            // window). The grant signature is journaled in grantSignature metadata.
            const sig = readMetadataString(entry.metadata, "grantSignature");
            this.retryOnceGrants.set(entry.issueId, {
              signature: sig,
            });
            // Restore the granted stage so a post-restart dispatch reruns
            // the SAME stage the grant was issued for, not the workflow
            // initial stage (council R3). The live apply records the stage
            // it granted on the entry; mirror its stage set + signature
            // clear so the replayed grant window behaves identically.
            const grantedStage = entry.stage;
            if (grantedStage !== null) {
              this.state.issueStages[entry.issueId] = grantedStage;
              this.clearStageFailureSignature(entry.issueId, grantedStage);
            }
          }

          if (verb === "retry_once" || verb === "rework_with_hint") {
            // Applied retry/rework intents release a park and schedule exactly
            // one continuation live. Rebuild that timer on replay so a restart
            // between the intent write and retry admission does not strand the
            // issue until an unrelated poll happens to notice it.
            this.scheduleRetry(entry.issueId, 1, {
              identifier: entry.issueIdentifier,
              error: null,
              delayType: "continuation",
            });
          }
        }
        if (verb === "escalate_human") {
          // Restore the escalation-once-per-park marker (SYMPH-422 council
          // P2). Matched on verb+status, NEVER on idempotency-key shape:
          // pre-discriminator (#374-era) entries carry old-format keys that
          // can never string-match a re-issued new-format key, so without
          // this marker every upgrade restart double-applies each journaled
          // escalation and posts a duplicate comment. The marker is scoped
          // to the CURRENT replay-minted generation (journaled generation
          // numbers do not survive a restart — replay re-mints them), so a
          // later replayed release → re-park still permits re-escalation.
          this.escalatedParkGenerations.set(
            entry.issueId,
            this.issueParkGenerations.get(entry.issueId) ?? null,
          );
        }
        // escalate_human leaves the park (replayed from its source event)
        // standing; resume replays as a no-op (its continuation is
        // in-memory scheduling and an un-parked issue is already
        // dispatch-eligible); no_op / rejected_stale entries mutate nothing.
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
        this.replayedDispatchedIssueIds.add(entry.issueId);
      }

      if (
        entry.kind === "budget_escalation" &&
        entry.metadata.status === "completed"
      ) {
        // Restore the escalation ladder position (SYMPH-401): entries replay
        // in sequence order so the latest step wins, a restart resumes the
        // ladder at the journaled step instead of step 0, and the next
        // escalation computes step N+1 (no duplicate step-1 entry — the
        // idempotency key `budget_escalation:{issue}:{stage}:{step}` would
        // dedupe a re-issue anyway). A later terminal entry clears the
        // counter via clearTerminalIssueRuntimeState.
        const step = readMetadataNumber(entry.metadata, "step");
        if (step !== null) {
          this.state.issueBudgetEscalations[entry.issueId] = step;
        }
        this.recoverPendingStageSignal(entry);
      }

      if (
        entry.kind === "pause_triage" &&
        entry.metadata.status === "completed" &&
        entry.metadata.action === "resumed"
      ) {
        // Restore the authorized-resume count (SYMPH-401): each journaled
        // resumed verdict carries the pre-increment `resumesUsed`, so the
        // post-restart count converges on resumesUsed + 1 and the triage cap
        // (maxResumes) is enforced across a deploy boundary.
        const resumesUsed = readMetadataNumber(entry.metadata, "resumesUsed");
        if (resumesUsed !== null) {
          this.state.issuePauseTriageResumes[entry.issueId] = resumesUsed + 1;
        }
        this.recoverPendingStageSignal(entry);
      }

      if (
        entry.kind === "stage_record" &&
        entry.metadata.status === "completed" &&
        // Seen-sequence guard: this is the lone ADDITIVE reducer, so a
        // repeated replay of the same entry would double-count spend.
        !this.reducedStageRecordSequences.has(entry.sequence)
      ) {
        // Restore per-stage spend into execution history (SYMPH-401): the
        // /state per-issue cumulative spend reduces from these entries, so
        // pre-restart tokens + post-restart deltas sum without a bespoke
        // store. A later terminal entry clears the history via
        // clearTerminalIssueRuntimeState.
        const record = toStageRecordFromMetadata(entry.metadata);
        if (record !== null) {
          this.reducedStageRecordSequences.add(entry.sequence);
          const history = this.state.issueExecutionHistory[entry.issueId];
          if (history === undefined) {
            this.state.issueExecutionHistory[entry.issueId] = [record];
          } else {
            history.push(record);
          }
        }
      }

      if (
        entry.kind === "pending_stage_signal" &&
        entry.metadata.status === "consumed"
      ) {
        this.recoverConsumedPendingStageSignal(entry);
      }

      if (entry.kind === "continuous_feedback") {
        this.recoverContinuousFeedbackCheckpoint(entry);
      }

      if (
        entry.kind === "tracker_write" &&
        entry.idempotencyKey.includes(":terminal:") &&
        entry.idempotencyKey.endsWith(":completed")
      ) {
        // Terminal-completion evidence (council R1): both terminal paths
        // (admission-path terminal and the agent-stage advance) journal
        // their Linear move through runTrackerWriteOnce with a
        // `tracker_write:{issue}:terminal:...` key. Replaying the completed
        // entry mirrors the live paths (completed + claim release + runtime
        // clear), so restored budget_escalation / pause_triage / stage_record
        // state cannot outlive a completion the live process already
        // performed — a reopened issue starts with fresh counters.
        this.state.completed.add(entry.issueId);
        this.releaseClaim(entry.issueId);
        this.clearTerminalIssueRuntimeState(
          entry.issueId,
          this.journalEntryTimestampMs(entry),
        );
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
      if (entry.kind === "ac_gate" && entry.metadata.status === "completed") {
        this.acGateFailOpenStreak =
          entry.metadata.verdict === "pass_open"
            ? this.acGateFailOpenStreak + 1
            : 0;
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
          this.clearTerminalIssueRuntimeState(
            entry.issueId,
            this.journalEntryTimestampMs(entry),
          );
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

  private createRunJournalCheckpointState(): Record<string, unknown> {
    return {
      claimedIssueIds: [...this.state.claimed],
      completedIssueIds: [...this.state.completed],
      failedIssueIds: [...this.state.failed],
      resumeRequiredIssueIds: [...this.state.resumeRequired],
      resumeRequiredMarks: clonePlain(this.state.resumeRequiredMarks),
      issueAnchors: clonePlain(this.state.issueAnchors),
      dispatchFence: clonePlain(this.state.dispatchFence),
      computedDispatchOrder: clonePlain(this.state.computedDispatchOrder),
      emergencyStop: clonePlain(this.state.emergencyStop),
      pipelinePause: clonePlain(this.state.pipelinePause),
      rateLimitAdmission: clonePlain(this.state.rateLimitAdmission),
      issueStages: clonePlain(this.state.issueStages),
      issuePendingStageSignals: clonePlain(this.state.issuePendingStageSignals),
      issueBudgetEscalations: clonePlain(this.state.issueBudgetEscalations),
      issuePauseTriageResumes: clonePlain(this.state.issuePauseTriageResumes),
      issueReworkCounts: clonePlain(this.state.issueReworkCounts),
      issuePassedStages: clonePlain(this.state.issuePassedStages),
      issueFirstDispatchedAt: clonePlain(this.state.issueFirstDispatchedAt),
      issueExecutionHistory: clonePlain(this.state.issueExecutionHistory),
      issueRightSizingDecisions: clonePlain(
        this.state.issueRightSizingDecisions,
      ),
      issueAcSnapshots: clonePlain(this.state.issueAcSnapshots),
      decorrelatedGateOutcomes: clonePlain(this.state.decorrelatedGateOutcomes),
      continuousFeedback: clonePlain(this.state.continuousFeedback),
      dispatcherLeases: clonePlain(this.state.dispatcherLeases),
      signatureClusterRegistry:
        this.signatureClusterRegistry.toCheckpointSnapshot(),
      issueFailureSignatures: clonePlain(this.state.issueFailureSignatures),
      issueDispositions: clonePlain(this.state.issueDispositions),
      issueReviewFailureStreaks: clonePlain(
        this.state.issueReviewFailureStreaks,
      ),
      issueReviewInfrastructureStalls: clonePlain(
        this.state.issueReviewInfrastructureStalls,
      ),
      failureExhaustedIssueIds: [...this.state.failureExhaustedIds],
    };
  }

  private createRunJournalCheckpointPrivateState(): Record<string, unknown> {
    return {
      reportedSupervisionFindingSignatures: [
        ...this.reportedSupervisionFindings,
      ],
      reportedIgnoredSetupInstructionCollisionSignatures: [
        ...this.reportedIgnoredSetupInstructionCollisions,
      ],
      lastVerdictKeyEntries: [...this.lastVerdictKeys.entries()],
      dispatchStarvation: {
        pageAlertActive: this.pageAlertActive,
        starvedTickCount: this.starvedTickCount,
      },
      acGateFailOpenStreak: this.acGateFailOpenStreak,
      replayedDispatchedIssueIds: [...this.replayedDispatchedIssueIds],
      resumeRequiredGuardEntries: [...this.resumeRequiredGuards.entries()],
      parkSequence: this.parkSequence,
      issueParkGenerationEntries: [...this.issueParkGenerations.entries()],
      triagedParkGenerationEntries: [...this.triagedParkGenerations.entries()],
      escalatedParkGenerationEntries: [
        ...this.escalatedParkGenerations.entries(),
      ],
      issueAnchorCursorEntries: [...this.issueAnchorCursors.entries()],
      anchorCursorSequence: this.anchorCursorSequence,
      retryOnceGrantEntries: [...this.retryOnceGrants.entries()],
    };
  }

  private recoverRunJournalCheckpoint(
    entry: DispatcherRunJournalEntry,
  ): number | null {
    const checkpointType = readMetadataString(
      entry.metadata,
      "checkpoint_type",
    );
    if (checkpointType !== "dispatcher_run_journal") {
      return null;
    }
    const state = toRecord(entry.metadata.state);
    if (state === null) {
      return null;
    }
    const coveredThroughSequence =
      readMetadataNumber(entry.metadata, "coveredThroughSequence") ??
      entry.sequence;

    // Claims are time-sensitive: active leases may expire between the
    // checkpoint write and a later restart. Rebuild claimed after replay from
    // unexpired active leases instead of restoring a stale set verbatim.
    this.state.claimed = new Set();
    this.state.completed = new Set(readStringArray(state.completedIssueIds));
    this.state.failed = new Set(readStringArray(state.failedIssueIds));
    this.state.resumeRequired = new Set(
      readStringArray(state.resumeRequiredIssueIds),
    );
    this.state.resumeRequiredMarks = readRecordOr(
      state.resumeRequiredMarks,
      {},
    );
    this.state.issueAnchors = readRecordOr(state.issueAnchors, {});
    this.state.dispatchFence =
      state.dispatchFence === null
        ? null
        : readRecordOr<DispatchFenceState | null>(state.dispatchFence, null);
    this.state.computedDispatchOrder =
      state.computedDispatchOrder === null
        ? null
        : readRecordOr<ComputedDispatchOrderSnapshot | null>(
            state.computedDispatchOrder,
            null,
          );
    this.state.emergencyStop =
      state.emergencyStop === null
        ? null
        : readRecordOr<PipelineEmergencyStopState | null>(
            state.emergencyStop,
            null,
          );
    this.state.pipelinePause =
      state.pipelinePause === null
        ? null
        : readRecordOr<PipelinePauseState | null>(state.pipelinePause, null);
    this.state.rateLimitAdmission =
      state.rateLimitAdmission === null
        ? null
        : readRecordOr<RateLimitAdmissionState | null>(
            state.rateLimitAdmission,
            null,
          );
    this.state.issueStages = readRecordOr(state.issueStages, {});
    this.state.issuePendingStageSignals = readRecordOr(
      state.issuePendingStageSignals,
      {},
    );
    this.state.issueBudgetEscalations = readRecordOr(
      state.issueBudgetEscalations,
      {},
    );
    this.state.issuePauseTriageResumes = readRecordOr(
      state.issuePauseTriageResumes,
      {},
    );
    this.state.issueReworkCounts = readRecordOr(state.issueReworkCounts, {});
    this.state.issuePassedStages = readRecordOr(state.issuePassedStages, {});
    this.state.issueFirstDispatchedAt = readRecordOr(
      state.issueFirstDispatchedAt,
      {},
    );
    this.state.issueExecutionHistory = readRecordOr(
      state.issueExecutionHistory,
      {},
    );
    this.state.issueRightSizingDecisions = readRecordOr(
      state.issueRightSizingDecisions,
      {},
    );
    this.state.issueAcSnapshots = readRecordOr(state.issueAcSnapshots, {});
    this.state.decorrelatedGateOutcomes = readRecordOr(
      state.decorrelatedGateOutcomes,
      {},
    );
    this.state.continuousFeedback = readContinuousFeedbackStateRecord(
      state.continuousFeedback,
    );
    this.state.dispatcherLeases = readRecordOr(state.dispatcherLeases, {});
    this.signatureClusterRegistry.hydrateCheckpointSnapshot(
      state.signatureClusterRegistry,
    );
    this.state.issueFailureSignatures = readRecordOr(
      state.issueFailureSignatures,
      {},
    );
    this.state.issueDispositions = readRecordOr(state.issueDispositions, {});
    this.state.issueReviewFailureStreaks = readRecordOr(
      state.issueReviewFailureStreaks,
      {},
    );
    this.state.issueReviewInfrastructureStalls = readRecordOr(
      state.issueReviewInfrastructureStalls,
      {},
    );
    this.state.failureExhaustedIds = new Set(
      readStringArray(state.failureExhaustedIssueIds),
    );

    const privateState = toRecord(entry.metadata.privateState);
    if (privateState !== null) {
      restoreStringSet(
        this.reportedSupervisionFindings,
        privateState.reportedSupervisionFindingSignatures,
      );
      restoreStringSet(
        this.reportedIgnoredSetupInstructionCollisions,
        privateState.reportedIgnoredSetupInstructionCollisionSignatures,
      );
      restoreStringStringMap(
        this.lastVerdictKeys,
        privateState.lastVerdictKeyEntries,
      );
      const dispatchStarvation = toRecord(privateState.dispatchStarvation);
      if (dispatchStarvation !== null) {
        this.pageAlertActive = dispatchStarvation.pageAlertActive === true;
        this.starvedTickCount =
          typeof dispatchStarvation.starvedTickCount === "number"
            ? dispatchStarvation.starvedTickCount
            : 0;
      }
      this.acGateFailOpenStreak =
        typeof privateState.acGateFailOpenStreak === "number"
          ? privateState.acGateFailOpenStreak
          : 0;
      restoreStringSet(
        this.replayedDispatchedIssueIds,
        privateState.replayedDispatchedIssueIds,
      );
      restoreStringRecordMap(
        this.resumeRequiredGuards,
        privateState.resumeRequiredGuardEntries,
      );
      this.parkSequence =
        typeof privateState.parkSequence === "number"
          ? privateState.parkSequence
          : 0;
      restoreStringNumberMap(
        this.issueParkGenerations,
        privateState.issueParkGenerationEntries,
      );
      restoreStringNumberMap(
        this.triagedParkGenerations,
        privateState.triagedParkGenerationEntries,
      );
      restoreStringNullableNumberMap(
        this.escalatedParkGenerations,
        privateState.escalatedParkGenerationEntries,
      );
      restoreStringRecordMap(
        this.issueAnchorCursors,
        privateState.issueAnchorCursorEntries,
      );
      this.anchorCursorSequence =
        typeof privateState.anchorCursorSequence === "number"
          ? privateState.anchorCursorSequence
          : 0;
      restoreStringRecordMap(
        this.retryOnceGrants,
        privateState.retryOnceGrantEntries,
      );
    }

    return coveredThroughSequence;
  }

  private recoverContinuousFeedbackCheckpoint(
    entry: DispatcherRunJournalEntry,
  ): void {
    const event = toContinuousFeedbackEvent(entry.metadata.event);
    const workerLane = toContinuousFeedbackLane(entry.metadata.workerLane);
    const reviewerLane = toContinuousFeedbackLane(entry.metadata.reviewerLane);
    const summary = readMetadataString(entry.metadata, "summary") ?? null;
    const rawStatus = entry.metadata.status;
    const parsedStatus = toContinuousFeedbackStatus(rawStatus);
    const status = projectContinuousFeedbackStatus(
      parsedStatus,
      summary ?? entry.summary,
      {
        allowLegacySummaryProjection:
          readMetadataNumber(
            entry.metadata,
            "continuousFeedbackStatusVersion",
          ) === null,
      },
    );
    if (parsedStatus === null && rawStatus !== undefined) {
      console.warn(
        `[orchestrator] Ignoring corrupt continuous-feedback checkpoint for ${entry.issueIdentifier}: invalid status ${JSON.stringify(rawStatus)}.`,
      );
    }
    if (
      event === null ||
      workerLane === null ||
      reviewerLane === null ||
      status === null
    ) {
      return;
    }
    if (status === "finding") {
      console.warn(
        `[orchestrator] Skipping replay of continuous-feedback finding checkpoint for ${entry.issueIdentifier}: journal stores signatures but not full finding payloads; a live checkpoint will recheck.`,
      );
      return;
    }

    this.state.continuousFeedback[entry.issueId] =
      mergeContinuousFeedbackCheckpoint(
        this.state.continuousFeedback[entry.issueId],
        {
          issueId: entry.issueId,
          issueIdentifier: entry.issueIdentifier,
          event,
          checkedAt: entry.timestamp,
          workerLane,
          reviewerLane,
          findings: [],
          status,
          summary,
        },
      );
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
      rawErrorClass === "permanent" ||
      rawErrorClass === "infra" ||
      rawErrorClass === "transient"
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
    if (reason === "emergency_stop") {
      const terminationConfirmed =
        // Old emergency-stop hard-stop records predate explicit proof metadata;
        // keep those upgrade replays compatible while treating explicit false
        // as an unconfirmed live kill.
        readMetadataBoolean(
          entry.metadata,
          "emergencyStopTerminationConfirmed",
        ) !== false;
      this.markIssueRequiresExplicitResume(
        entry.issueId,
        readMetadataString(entry.metadata, "issueState"),
        entry.timestamp,
        {
          reason: terminationConfirmed
            ? "killed_mid_run"
            : "killed_mid_run_unconfirmed",
          setBySequence: entry.sequence,
          parkGeneration: readMetadataNumber(entry.metadata, "parkGeneration"),
        },
      );
      if (terminationConfirmed) {
        this.confirmEmergencyStopProcessCleanup(entry.issueId);
      } else {
        this.requireEmergencyStopProcessCleanup(entry.issueId, {
          setBySequence: entry.sequence,
          since: entry.timestamp,
        });
      }
      this.recoverPendingStageSignal(entry);
      return;
    }

    if (
      reason === "manual_stop" ||
      reason === "inactive_state" ||
      outcome !== null
    ) {
      const trigger = readMetadataString(entry.metadata, "trigger");
      this.recoverHardStopStage(entry);
      this.markIssueRequiresExplicitResume(
        entry.issueId,
        readMetadataString(entry.metadata, "issueState"),
        entry.timestamp,
        {
          reason:
            reason === "manual_stop" || reason === "inactive_state"
              ? reason
              : `hard_stop:${trigger ?? outcome ?? "unknown"}`,
          setBySequence: entry.sequence,
          parkGeneration: readMetadataNumber(entry.metadata, "parkGeneration"),
        },
      );
      this.recoverPendingStageSignal(entry);
    }
  }

  private recoverHardStopStage(entry: DispatcherRunJournalEntry): void {
    if (entry.stage !== null) {
      this.state.issueStages[entry.issueId] = entry.stage;
    }
    const passedStages = readStringArray(entry.metadata.passedStages);
    if (passedStages.length > 0) {
      this.state.issuePassedStages[entry.issueId] = passedStages;
    }
  }

  private recoverPendingStageSignal(entry: DispatcherRunJournalEntry): void {
    if (
      entry.kind !== "hard_stop_trigger" &&
      entry.kind !== "budget_escalation" &&
      entry.kind !== "pause_triage"
    ) {
      return;
    }
    const pending = readPendingStageSignalMetadata(entry);
    if (pending === null) {
      return;
    }
    if (this.state.issuePendingStageSignals[entry.issueId] !== undefined) {
      return;
    }
    this.state.issuePendingStageSignals[entry.issueId] = {
      ...pending,
      setBySequence: entry.sequence,
    };
  }

  private recoverConsumedPendingStageSignal(
    entry: DispatcherRunJournalEntry,
  ): void {
    delete this.state.issuePendingStageSignals[entry.issueId];
    this.clearResumeRequirement(entry.issueId);
    const resultingStageName = readMetadataString(
      entry.metadata,
      "resultingStageName",
    );
    if (resultingStageName !== null) {
      this.state.issueStages[entry.issueId] = resultingStageName;
    }
    if (entry.metadata.completed === true) {
      this.state.completed.add(entry.issueId);
      this.clearTerminalIssueRuntimeState(
        entry.issueId,
        this.journalEntryTimestampMs(entry),
      );
      return;
    }
    const signal = readMetadataString(entry.metadata, "signal");
    if (signal !== "failure") {
      return;
    }
    const failureClass = readMetadataString(entry.metadata, "failureClass");
    if (!isFailureClass(failureClass)) {
      return;
    }
    const agentMessage =
      readMetadataString(entry.metadata, "agentMessage") ?? undefined;
    this.handleFailureSignal(
      entry.issueId,
      createPendingRunningEntry({
        issue: createReplayIssue(entry.issueId, entry.issueIdentifier),
        identifier: entry.issueIdentifier,
        attempt: entry.attempt,
        agentMessage: agentMessage ?? "",
      }),
      failureClass,
      agentMessage,
      { emitSideEffects: false },
    );
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
      this.clearTerminalIssueRuntimeState(
        entry.issueId,
        this.journalEntryTimestampMs(entry),
      );
      return;
    }

    if (outcome.aggregate === "error") {
      this.state.issueStages[entry.issueId] = entry.stage;
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
    actor?: IntentActor,
  ): Promise<StopRequest | null> {
    const runningEntry = Object.values(this.state.running).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (runningEntry === undefined) {
      return null;
    }

    // Routed through the shared intent-verb layer (SYMPH-399): manual halts
    // are operator intent — journaled with attribution and replayable.
    const result = await this.writeIntent({
      verb: "halt",
      issueId: runningEntry.issue.id,
      issueIdentifier,
      actor: actor ?? { kind: "operator", host: this.intentHost() },
      reason: {
        class: "manual_stop",
        human: `manual stop requested for ${issueIdentifier}`,
      },
      issueState: runningEntry.issue.state,
    });
    return result.stopRequest ?? null;
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
      blockers?: readonly BlockerRef[];
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
        this.clearResumedIssueLifecycleState(issue.id);
      } else {
        const resumeBlock = this.resumeRequirementBlockVerdict(
          issue.id,
          issue.state,
          normalizedState,
        );
        // The 2026-06-11 invisible skip (SYMPH-405): a stop-like pause waits
        // for an explicit Resume, and Todo alone is silently skipped.
        this.recordDispatchVerdict({
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          disposition: "skip",
          reasonCode: resumeBlock.reasonCode,
          remedy: resumeBlock.remedy,
          details: resumeBlock.details,
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
        this.clearResumedIssueLifecycleState(issue.id);
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

    const openBlockers = (options?.blockers ?? issue.blockedBy).filter(
      (blocker) => {
        const blockerState =
          blocker.state === null ? null : normalizeIssueState(blocker.state);
        return blockerState === null || !terminalStates.has(blockerState);
      },
    );
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

    const emergencyStopResult = this.blockForEmergencyStop(issues.length);
    if (emergencyStopResult !== null) {
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

    const runtimePauseResult = this.blockForPipelinePause(issues.length);
    if (runtimePauseResult !== null) {
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

    // Check for pipeline-halt before dispatching
    const haltIssue = await this.checkPipelineHalt();
    if (haltIssue !== null) {
      const computedDispatchOrder = await this.computeDispatchOrderForPoll(
        issues,
        {
          ticketFeatureFetch: "skip",
          ticketFeatureUnavailableReason:
            "TicketFeature fetch skipped because pipeline halt blocks dispatch for this poll.",
        },
      );
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
      await this.recordQueueBaselineSample({
        consideredIssues: this.issuesFromComputedOrder(
          computedDispatchOrder,
          issues,
        ),
        dispatchPicks: [],
        computedOrder: computedDispatchOrder,
        force: true,
      });
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
      const computedDispatchOrder = await this.computeDispatchOrderForPoll(
        issues,
        {
          ticketFeatureFetch: "skip",
          ticketFeatureUnavailableReason:
            "TicketFeature fetch skipped because the rate-limit admission gate blocks dispatch for this poll.",
        },
      );
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
      await this.recordQueueBaselineSample({
        consideredIssues: this.issuesFromComputedOrder(
          computedDispatchOrder,
          issues,
        ),
        dispatchPicks: [],
        computedOrder: computedDispatchOrder,
        force: true,
      });
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

    const computedDispatchOrder =
      await this.computeDispatchOrderForPoll(issues);
    const dispatchedIssueIds: string[] = [];
    const dispatchAttempts: DispatchAttemptObservation[] = [];
    const modeDecisions: RightSizingDecision[] = [];
    let eligibleCount = 0;
    const admittedSnapshots = this.buildRunningAdmissionSnapshots();
    const sortedIssuesFromOrder = this.issuesFromComputedOrder(
      computedDispatchOrder,
      issues,
    );
    const sortedIssues = await this.requireComputedOrderDispatchCandidates({
      candidates: sortedIssuesFromOrder,
      computedOrder: computedDispatchOrder,
      sourceIssues: issues,
    });
    if (sortedIssues === null) {
      this.trackDispatchStarvation(issues.length, 0);
      await this.recordQueueBaselineSample({
        consideredIssues: [],
        dispatchPicks: [],
        computedOrder: computedDispatchOrder,
        force: true,
      });
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
    if (
      this.state.dispatchFence !== null &&
      sortedIssues.length === 0 &&
      computedDispatchOrder.exclusions.some(
        (exclusion) => exclusion.source === "dispatch_fence",
      )
    ) {
      this.recordDispatchVerdict({
        issueId: PIPELINE_VERDICT_SCOPE_ID,
        issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
        disposition: "gate",
        reasonCode: "dispatch_fence_no_eligible_candidates",
        remedy:
          "Clear or update the dispatch fence, or make an allowlisted issue eligible.",
        details: {
          fence_issue_identifiers: this.state.dispatchFence.issueIdentifiers,
          excluded_issue_identifiers: computedDispatchOrder.exclusions
            .filter((exclusion) => exclusion.source === "dispatch_fence")
            .map((exclusion) => exclusion.issue_identifier),
        },
      });
      this.trackDispatchStarvation(issues.length, 0);
      await this.recordQueueBaselineSample({
        consideredIssues: [],
        dispatchPicks: [],
        computedOrder: computedDispatchOrder,
        force: true,
      });
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
    const computedHeadIssue = sortedIssues[0] ?? null;
    let computedHeadReachedDispatchBoundary = false;
    for (const issue of sortedIssues) {
      if (this.availableSlots() <= 0) {
        break;
      }
      if (!this.isDispatchEligible(issue, { blockers: [] })) {
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

      if (computedHeadIssue?.id === issue.id) {
        computedHeadReachedDispatchBoundary = true;
      }
      const reservationKey = this.reserveRateLimitAdmission(rateLimitGate);
      if (reservationKey === false) {
        break;
      }
      const dispatchResult = await this.dispatchIssue(issue, null);
      if (!dispatchResult.dispatched) {
        this.releaseRateLimitAdmissionReservation(reservationKey);
      }
      dispatchAttempts.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        disposition: dispatchResult.disposition,
        reasonCode: dispatchResult.reasonCode,
      });
      if (dispatchResult.dispatched) {
        dispatchedIssueIds.push(issue.id);
        modeDecisions.push(dispatchResult.rightSizingDecision);
        admittedSnapshots.push(candidateSnapshot);
      }
    }

    this.trackDispatchStarvation(eligibleCount, dispatchedIssueIds.length);
    await this.recordOrderingDisagreementIfNeeded({
      computedOrder: computedDispatchOrder,
      expectedIssue: computedHeadReachedDispatchBoundary
        ? computedHeadIssue
        : null,
      issues,
      dispatchPicks: dispatchedIssueIds,
      dispatchAttempts,
    });
    await this.recordQueueBaselineSample({
      consideredIssues: sortedIssues,
      dispatchPicks: dispatchedIssueIds,
      computedOrder: computedDispatchOrder,
      dispatchAttempts,
    });

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

  private async computeDispatchOrderForPoll(
    issues: readonly Issue[],
    options?: {
      ticketFeatureFetch?: "fetch" | "skip";
      ticketFeatureUnavailableReason?: string;
    },
  ): Promise<ComputedDispatchOrderSnapshot> {
    let ticketFeatures: TicketFeature[] | undefined;
    let ticketFeatureUnavailableReason: string | null = null;
    if (this.tracker.fetchTicketFeatureIssuesByStates === undefined) {
      ticketFeatureUnavailableReason =
        "TicketFeature feed unavailable; preserving current blockedBy eligibility semantics.";
    } else if (options?.ticketFeatureFetch === "skip") {
      ticketFeatureUnavailableReason =
        options.ticketFeatureUnavailableReason ??
        "TicketFeature fetch skipped; preserving current blockedBy eligibility semantics.";
    } else {
      try {
        const sourceIssues =
          await this.tracker.fetchTicketFeatureIssuesByStates(
            this.config.tracker.activeStates,
          );
        ticketFeatures = extractTicketFeatures({
          issues: sourceIssues,
          operatorConfig: this.config.operatorAnchors ?? {
            operatorAllowlist: [],
            serviceAccounts: [],
          },
          runJournal: this.state.dispatcherRunJournal,
        });
      } catch (error) {
        console.warn(
          `[orchestrator] failed to fetch TicketFeature dispatch edges: ${formatWarningError(error)}`,
        );
        ticketFeatureUnavailableReason =
          "TicketFeature fetch failed; preserving current blockedBy eligibility semantics.";
      }
    }

    let computedOrder: ComputedDispatchOrderSnapshot;
    try {
      computedOrder = computeDispatchOrder({
        issues,
        anchors: this.state.issueAnchors,
        ticketFeatures,
        ticketFeatureUnavailableReason,
        terminalStates: this.config.tracker.terminalStates,
        completedIssueIds: this.state.completed,
        dispatchFence: this.state.dispatchFence,
        now: this.now(),
      });
    } catch (error) {
      const formattedError = formatBoundedWarningError(error);
      console.warn(
        `[orchestrator] dispatch comparator failed; skipping dispatch for this poll: ${formattedError}`,
      );
      computedOrder = createDispatchComparatorFailureSnapshot({
        generatedAt: this.now(),
        warning: `Dispatch comparator failed; skipped dispatch for this poll: ${formattedError}`,
      });
      await this.recordDispatchComparatorSafetyEvent({
        decisionId: `dispatch-comparator-exception:${this.nextRunJournalSequence()}`,
        summary:
          "Dispatch comparator failed closed; no new issue dispatches were admitted.",
        reason: "The dispatch comparator threw while computing queue order.",
        findingKinds: ["dispatch_comparator_exception"],
        details: {
          candidate_count: issues.length,
          candidate_issue_ids: issues.map((issue) => issue.id),
          candidate_issue_identifiers: issues.map((issue) => issue.identifier),
          error: formattedError,
        },
        observedDecision: "skip_dispatch",
        observedRationale:
          "Comparator failure produced an empty computed-order snapshot, so no candidate reached admission.",
      });
    }
    this.state.computedDispatchOrder = computedOrder;
    return computedOrder;
  }

  private issuesFromComputedOrder(
    computedOrder: ComputedDispatchOrderSnapshot,
    issues: readonly Issue[],
  ): Issue[] {
    const issueById = new Map(issues.map((issue) => [issue.id, issue]));
    return computedOrder.positions
      .map((position) => issueById.get(position.issue_id) ?? null)
      .filter((issue): issue is Issue => issue !== null);
  }

  private async requireComputedOrderDispatchCandidates(input: {
    candidates: readonly Issue[];
    computedOrder: ComputedDispatchOrderSnapshot;
    sourceIssues: readonly Issue[];
  }): Promise<Issue[] | null> {
    const computedIssueIds = new Set(
      input.computedOrder.positions.map((position) => position.issue_id),
    );
    const outsideSnapshot = input.candidates.filter(
      (issue) => !computedIssueIds.has(issue.id),
    );
    if (outsideSnapshot.length === 0) {
      return [...input.candidates];
    }

    const outsideSnapshotIdentifiers = outsideSnapshot
      .map((issue) => issue.identifier)
      .join(", ");
    console.warn(
      `[orchestrator] computed dispatch order invariant failed; ${outsideSnapshotIdentifiers} entered the dispatch loop outside the computed-order snapshot. Skipping all dispatch.`,
    );
    await this.recordDispatchComparatorSafetyEvent({
      decisionId: `computed-order-snapshot-drift:${this.nextRunJournalSequence()}`,
      summary:
        "Dispatch loop candidate set drifted from computed-order snapshot; no new issue dispatches were admitted.",
      reason:
        "Every issue entering the dispatch loop must come from computedDispatchOrder.positions.",
      findingKinds: ["computed_order_candidate_outside_snapshot"],
      details: {
        candidate_count: input.sourceIssues.length,
        computed_order_issue_ids: [...computedIssueIds],
        outside_snapshot_issue_ids: outsideSnapshot.map((issue) => issue.id),
        outside_snapshot_issue_identifiers: outsideSnapshot.map(
          (issue) => issue.identifier,
        ),
      },
      observedDecision: "skip_dispatch",
      observedRationale:
        "Dispatch loop candidate drift would bypass comparator blocker gating, so the poll failed closed.",
    });
    return null;
  }

  private async recordOrderingDisagreementIfNeeded(input: {
    computedOrder: ComputedDispatchOrderSnapshot;
    expectedIssue: Issue | null;
    issues: readonly Issue[];
    dispatchPicks: readonly string[];
    dispatchAttempts: readonly DispatchAttemptObservation[];
  }): Promise<void> {
    if (input.expectedIssue === null || input.dispatchPicks.length === 0) {
      return;
    }
    const computedTop = input.computedOrder.positions[0];
    if (
      computedTop === undefined ||
      input.expectedIssue.id === input.dispatchPicks[0]
    ) {
      return;
    }
    const actualIssue = input.issues.find(
      (issue) => issue.id === input.dispatchPicks[0],
    );
    if (actualIssue === undefined) {
      return;
    }
    const computedTopDispatchAttempt = input.dispatchAttempts.find(
      (attempt) => attempt.issueId === input.expectedIssue?.id,
    );
    if (computedTopDispatchAttempt?.disposition === "spawn_failed") {
      return;
    }
    const timestamp = this.now().toISOString();
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `ordering_disagreement:${input.computedOrder.generated_at}:${computedTop.issue_id}:${actualIssue.id}`,
        timestamp,
        kind: "ordering_disagreement",
        issueId: actualIssue.id,
        issueIdentifier: actualIssue.identifier,
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Dispatch admitted ${actualIssue.identifier} while computed eligible order led with ${input.expectedIssue.identifier}.`,
        metadata: {
          status: "observed",
          comparator_version: input.computedOrder.comparator_version,
          computed_order_status: input.computedOrder.status,
          computed_top_issue_id: computedTop.issue_id,
          computed_top_issue_identifier: computedTop.issue_identifier,
          expected_issue_id: input.expectedIssue.id,
          expected_issue_identifier: input.expectedIssue.identifier,
          computed_top_dispatch_disposition:
            computedTopDispatchAttempt?.disposition ?? "not_attempted",
          computed_top_dispatch_reason_code:
            computedTopDispatchAttempt?.reasonCode ?? null,
          actual_issue_id: actualIssue.id,
          actual_issue_identifier: actualIssue.identifier,
        },
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal ordering disagreement: ${formatWarningError(error)}`,
      );
    }
  }

  async recordBacklogHygieneProposal(input: {
    proposal: BacklogHygieneProposal;
    actor: VerdictActor;
    timestamp?: string;
  }): Promise<number | null> {
    try {
      const entry = await this.recordRunJournalEntry(
        buildBacklogHygieneProposalJournalEntry({
          proposal: input.proposal,
          actor: input.actor,
          ownerId: this.leaseOwnerId,
          ...(input.timestamp === undefined
            ? {}
            : { timestamp: input.timestamp }),
        }),
      );
      return entry.sequence;
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal backlog hygiene proposal: ${formatWarningError(error)}`,
      );
      return null;
    }
  }

  async runBacklogHygieneProposalLane(
    input: Omit<RunBacklogHygieneProposalLaneInput, "codeGrounding"> & {
      runId: string;
      codeGroundingTarget: CodeGroundingTarget | null;
      codeGroundingCommandRunner?: CodeGroundingCommandRunner;
    },
  ): Promise<BacklogHygieneLaneResult> {
    const {
      runId,
      codeGroundingTarget,
      codeGroundingCommandRunner,
      ...laneInput
    } = input;
    const codeGrounding =
      codeGroundingTarget === null
        ? null
        : buildBacklogHygieneCodeGroundingInput({
            workflowConfig: this.config,
            runId,
            target: codeGroundingTarget,
            ...(codeGroundingCommandRunner === undefined
              ? {}
              : { commandRunner: codeGroundingCommandRunner }),
          });
    return runBacklogHygieneProposalLaneForInput({
      ...laneInput,
      codeGrounding,
    });
  }

  async recordBacklogHygieneProposalDecision(input: {
    proposal: BacklogHygieneProposal;
    decision: BacklogHygieneProposalDecision;
    actor: VerdictActor;
    reason: string;
    timestamp?: string;
  }): Promise<number | null> {
    try {
      const entry = await this.recordRunJournalEntry(
        buildBacklogHygieneDecisionJournalEntry({
          proposal: input.proposal,
          decision: input.decision,
          actor: input.actor,
          ownerId: this.leaseOwnerId,
          reason: input.reason,
          timestamp: input.timestamp ?? this.now().toISOString(),
        }),
      );
      return entry.sequence;
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal backlog hygiene proposal decision: ${formatWarningError(error)}`,
      );
      return null;
    }
  }

  private async recordQueueBaselineSample(input: {
    consideredIssues: readonly Issue[];
    dispatchPicks: readonly string[];
    dispatchAttempts?: readonly DispatchAttemptObservation[];
    computedOrder?: ComputedDispatchOrderSnapshot | null;
    force?: boolean;
  }): Promise<void> {
    const timestamp = this.now().toISOString();
    let metadata: Record<string, unknown>;
    try {
      const outcomeWindow = resolveQueueBaselineOutcomeWindow(
        this.state.dispatcherRunJournal,
      );
      const outcomeSinceSequence = outcomeWindow.sinceSequence;
      const manualJumpsReorders = collectOperatorIntentSamples(
        this.state.dispatcherRunJournal,
        outcomeSinceSequence,
      );
      const quietDeathOutcomes = collectQuietDeathOutcomes(
        this.state.dispatcherRunJournal,
        outcomeSinceSequence,
      );
      const urgentReopenOutcomes = collectUrgentReopenOutcomes(
        this.state.dispatcherRunJournal,
        outcomeSinceSequence,
        manualJumpsReorders,
      );
      const deliveryOutcomes = collectDeliveryOutcomes(
        this.state.dispatcherRunJournal,
        outcomeSinceSequence,
      );
      if (
        input.force !== true &&
        input.consideredIssues.length === 0 &&
        input.dispatchPicks.length === 0 &&
        manualJumpsReorders.length === 0 &&
        quietDeathOutcomes.length === 0 &&
        urgentReopenOutcomes.length === 0 &&
        deliveryOutcomes.length === 0
      ) {
        return;
      }
      metadata = {
        schema_version: 1,
        comparator_version:
          input.computedOrder?.comparator_version ?? "priority-fifo-control-v0",
        computed_order_status: input.computedOrder?.status ?? "legacy_control",
        computed_order_issue_ids:
          input.computedOrder?.positions.map((position) => position.issue_id) ??
          input.consideredIssues.map((issue) => issue.id),
        hard_exclusion_count:
          countUniqueComputedOrderExclusionIssues(input.computedOrder) ?? 0,
        computed_order_issue_count:
          input.computedOrder?.positions.length ??
          input.consideredIssues.length,
        hard_cycle_issue_count:
          input.computedOrder?.hard_cycle?.issue_ids.length ?? 0,
        hard_cycle_count: input.computedOrder?.hard_cycles.length ?? 0,
        hard_cycle_omitted_count:
          input.computedOrder?.hard_cycle_omitted_count ?? 0,
        advisory_warning_count:
          input.computedOrder?.advisory_warnings.length ?? 0,
        would_have_been_advisory_exclusion_count:
          input.computedOrder?.would_have_been_excluded_by_advisory_edges
            .length ?? 0,
        superseded_native_hard_blocker_count:
          input.computedOrder?.superseded_native_hard_blockers.length ?? 0,
        hard_cycle_issue_ids: input.computedOrder?.hard_cycle?.issue_ids ?? [],
        hard_cycle_issue_id_groups:
          input.computedOrder?.hard_cycles.map((cycle) => cycle.issue_ids) ??
          [],
        superseded_native_hard_blockers:
          input.computedOrder?.superseded_native_hard_blockers ?? [],
        outcome_since_sequence: outcomeSinceSequence,
        outcome_window_semantics:
          "Outcome arrays contain events observed after outcome_since_sequence. The first baseline without a prior queue_baseline anchors at the current journal tail so pre-existing history is excluded while considered issues and dispatch picks are still recorded. urgent_reopen_outcomes may reference the earlier failure it reopened. delivery_outcomes.spend is resource consumption inside the baseline window, not lifetime ticket total.",
        outcome_window_anchor: outcomeWindow.anchor,
        outcome_window_as_of_sequence: outcomeWindow.asOfSequence,
        outcome_window_scanned_entry_count: outcomeWindow.scannedEntryCount,
        considered_issue_ids: input.consideredIssues.map((issue) => issue.id),
        considered_issue_identifiers: input.consideredIssues.map(
          (issue) => issue.identifier,
        ),
        dispatch_picks: [...input.dispatchPicks],
        dispatch_attempts: (input.dispatchAttempts ?? []).map((attempt) => ({
          issue_id: attempt.issueId,
          issue_identifier: attempt.issueIdentifier,
          disposition: attempt.disposition,
          reason_code: attempt.reasonCode,
        })),
        manual_jumps_reorders: manualJumpsReorders,
        quiet_death_outcomes: quietDeathOutcomes,
        urgent_reopen_outcomes: urgentReopenOutcomes,
        delivery_outcomes: deliveryOutcomes,
      };
    } catch (error) {
      console.warn(
        `[orchestrator] failed to collect queue baseline sample: ${formatWarningError(error)}`,
      );
      return;
    }

    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `queue_baseline:${timestamp}:${this.nextRunJournalSequence()}`,
        timestamp,
        kind: "queue_baseline",
        issueId: PIPELINE_VERDICT_SCOPE_ID,
        issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Queue baseline sampled ${input.consideredIssues.length} considered issue(s) and ${input.dispatchPicks.length} dispatch pick(s).`,
        metadata,
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal queue baseline sample: ${formatWarningError(error)}`,
      );
    }
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
    expectedUnitBurnPct: number | null;
    deferredUntil: string | null;
    admissionCapacity: number | null;
    /** Structured floor violations for verdict reason codes (SYMPH-405). */
    floorViolations: Array<{
      window: "primary" | "secondary";
      floorPct: number;
      headroomPct: number;
      expectedUnitBurnPct: number | null;
    }>;
  } {
    const floors = this.config.rateLimitAdmission;
    if (
      floors.minPrimaryHeadroomPct === null &&
      floors.minSecondaryHeadroomPct === null
    ) {
      this.state.rateLimitAdmission = null;
      return {
        blocked: false,
        reason: null,
        expectedUnitBurnPct: null,
        deferredUntil: null,
        admissionCapacity: null,
        floorViolations: [],
      };
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
      expectedUnitBurnPct: number | null;
    }> = [];
    const deferUntilReset = floors.deferUntilReset === true;
    const expectedUnitBurnPct = deferUntilReset
      ? this.estimateExpectedUnitBurnPct()
      : null;
    const usesExpectedUnitBurn =
      expectedUnitBurnPct !== null && expectedUnitBurnPct > 0;
    if (
      floors.minPrimaryHeadroomPct !== null &&
      primary !== null &&
      !primary.expired
    ) {
      const requiredHeadroomPct =
        deferUntilReset && usesExpectedUnitBurn
          ? floors.minPrimaryHeadroomPct + expectedUnitBurnPct
          : floors.minPrimaryHeadroomPct;
      if (primary.remainingPercent < requiredHeadroomPct) {
        violations.push(
          deferUntilReset && usesExpectedUnitBurn
            ? `primary window headroom ${primary.remainingPercent.toFixed(1)}% < ${requiredHeadroomPct.toFixed(1)}% required for ${expectedUnitBurnPct.toFixed(1)}% expected unit burn above ${floors.minPrimaryHeadroomPct}% floor`
            : `primary window headroom ${primary.remainingPercent.toFixed(1)}% < ${floors.minPrimaryHeadroomPct}% floor`,
        );
        floorViolations.push({
          window: "primary",
          floorPct: floors.minPrimaryHeadroomPct,
          headroomPct: primary.remainingPercent,
          expectedUnitBurnPct,
        });
      }
    }
    if (
      floors.minSecondaryHeadroomPct !== null &&
      secondary !== null &&
      !secondary.expired
    ) {
      const requiredHeadroomPct =
        deferUntilReset && usesExpectedUnitBurn
          ? floors.minSecondaryHeadroomPct + expectedUnitBurnPct
          : floors.minSecondaryHeadroomPct;
      if (secondary.remainingPercent < requiredHeadroomPct) {
        violations.push(
          deferUntilReset && usesExpectedUnitBurn
            ? `secondary window headroom ${secondary.remainingPercent.toFixed(1)}% < ${requiredHeadroomPct.toFixed(1)}% required for ${expectedUnitBurnPct.toFixed(1)}% expected unit burn above ${floors.minSecondaryHeadroomPct}% floor`
            : `secondary window headroom ${secondary.remainingPercent.toFixed(1)}% < ${floors.minSecondaryHeadroomPct}% floor`,
        );
        floorViolations.push({
          window: "secondary",
          floorPct: floors.minSecondaryHeadroomPct,
          headroomPct: secondary.remainingPercent,
          expectedUnitBurnPct,
        });
      }
    }

    const blocked = violations.length > 0;
    const deferredUntil =
      blocked && deferUntilReset
        ? computeRateLimitDeferredUntil({
            violations: floorViolations,
            primary,
            secondary,
            jitterMs: floors.deferJitterMs ?? 0,
          })
        : null;
    const admissionCapacity =
      deferUntilReset && usesExpectedUnitBurn
        ? computeRateLimitAdmissionCapacity({
            expectedUnitBurnPct,
            primary:
              floors.minPrimaryHeadroomPct === null
                ? null
                : {
                    headroom: primary,
                    floorPct: floors.minPrimaryHeadroomPct,
                  },
            secondary:
              floors.minSecondaryHeadroomPct === null
                ? null
                : {
                    headroom: secondary,
                    floorPct: floors.minSecondaryHeadroomPct,
                  },
          })
        : null;
    const reasonPrefix =
      deferUntilReset && usesExpectedUnitBurn
        ? "Codex rate-limit headroom below expected dispatch burn"
        : "Codex rate-limit headroom below dispatch floor";
    const reason = blocked
      ? `${reasonPrefix}: ${violations.join("; ")}. New dispatches refused${deferredUntil !== null ? ` until the window resets at ${deferredUntil}` : ""}.`
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
      expectedUnitBurnPct,
      deferredUntil,
      admissionCapacity,
    };

    return {
      blocked,
      reason,
      expectedUnitBurnPct,
      deferredUntil,
      admissionCapacity,
      floorViolations,
    };
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
      details: {
        floorViolations: gate.floorViolations,
        expectedUnitBurnPct: gate.expectedUnitBurnPct,
        deferredUntil: gate.deferredUntil,
        admissionCapacity: gate.admissionCapacity,
      },
    };
  }

  private reserveRateLimitAdmission(
    gate: ReturnType<OrchestratorCore["evaluateRateLimitAdmissionGate"]>,
  ): string | false | null {
    if (gate.admissionCapacity === null) {
      return null;
    }
    const reservationKey = JSON.stringify({
      codexRateLimits: this.state.codexRateLimits,
      expectedUnitBurnPct: gate.expectedUnitBurnPct,
      deferredUntil: gate.deferredUntil,
      admissionCapacity: gate.admissionCapacity,
    });
    if (
      this.rateLimitAdmissionReservation === null ||
      this.rateLimitAdmissionReservation.key !== reservationKey
    ) {
      this.rateLimitAdmissionReservation = {
        key: reservationKey,
        count: 0,
      };
    }
    if (this.rateLimitAdmissionReservation.count >= gate.admissionCapacity) {
      return false;
    }
    this.rateLimitAdmissionReservation.count += 1;
    return reservationKey;
  }

  private releaseRateLimitAdmissionReservation(
    reservationKey: string | null,
  ): void {
    if (
      reservationKey === null ||
      this.rateLimitAdmissionReservation === null ||
      this.rateLimitAdmissionReservation.key !== reservationKey ||
      this.rateLimitAdmissionReservation.count <= 0
    ) {
      return;
    }
    this.rateLimitAdmissionReservation.count -= 1;
  }

  private estimateExpectedUnitBurnPct(): number | null {
    const observedBurn: Array<{
      burnPct: number;
      completedAtMs: number;
      insertionIndex: number;
    }> = [];
    let insertionIndex = 0;
    for (const history of Object.values(this.state.issueExecutionHistory)) {
      for (const stage of history) {
        const primary = observedWindowDeltaPercent(
          stage.rateLimitWindows?.primary ?? null,
        );
        const secondary = observedWindowDeltaPercent(
          stage.rateLimitWindows?.secondary ?? null,
        );
        const stageBurn = Math.max(primary, secondary);
        if (stageBurn > 0) {
          const completedAtMs =
            stage.completedAt === undefined
              ? insertionIndex
              : Date.parse(stage.completedAt);
          observedBurn.push({
            burnPct: stageBurn,
            completedAtMs: Number.isFinite(completedAtMs)
              ? completedAtMs
              : insertionIndex,
            insertionIndex,
          });
        }
        insertionIndex += 1;
      }
    }
    const recentBurn = observedBurn
      .sort((left, right) =>
        left.completedAtMs === right.completedAtMs
          ? left.insertionIndex - right.insertionIndex
          : left.completedAtMs - right.completedAtMs,
      )
      .slice(-20)
      .map((sample) => sample.burnPct);
    return (
      median(recentBurn) ??
      this.config.rateLimitAdmission.expectedUnitBurnPct ??
      null
    );
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
    pendingStageSignal: PendingStageSignal | null,
  ): Promise<BudgetPauseHandlingResult> {
    if (hardStop.outcome !== "PAUSED-budget") {
      return { handled: false, retryEntry: null };
    }
    if (!isBudgetEscalationTrigger(hardStop.trigger)) {
      return { handled: false, retryEntry: null };
    }

    const ladder = this.config.budgetEscalation;
    if (ladder.maxSteps === null) {
      return { handled: false, retryEntry: null };
    }

    const steps = this.state.issueBudgetEscalations[issueId] ?? 0;
    if (steps >= ladder.maxSteps) {
      console.warn(
        `[orchestrator] Budget escalation exhausted for ${runningEntry.identifier} (${steps}/${ladder.maxSteps} steps used) — parking for operator.`,
      );
      return { handled: false, retryEntry: null };
    }

    const gate = this.evaluateRateLimitAdmissionGate();
    if (gate.blocked) {
      console.warn(
        `[orchestrator] Budget escalation deferred to operator for ${runningEntry.identifier}: ${gate.reason}`,
      );
      return { handled: false, retryEntry: null };
    }

    const nextStep = steps + 1;
    const nextMultiplier = ladder.multiplier ** nextStep;

    const escalationEntry = await this.recordRunJournalEntry({
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
        ...pendingStageSignalMetadata(pendingStageSignal),
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

    if (pendingStageSignal !== null) {
      const storedPendingStageSignal = {
        ...pendingStageSignal,
        setBySequence: escalationEntry.sequence,
      };
      this.state.issuePendingStageSignals[issueId] = storedPendingStageSignal;
      return {
        handled: true,
        retryEntry: await this.consumePendingStageSignal(
          issueId,
          runningEntry,
          storedPendingStageSignal,
        ),
      };
    }

    return {
      handled: true,
      retryEntry: this.scheduleRetry(issueId, 1, {
        identifier: runningEntry.identifier,
        error: null,
        delayType: "continuation",
      }),
    };
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
    pendingStageSignal: PendingStageSignal | null,
  ): Promise<BudgetPauseHandlingResult> {
    if (this.runPauseTriage === undefined) {
      return { handled: false, retryEntry: null };
    }
    if (hardStop.outcome !== "PAUSED-budget") {
      return { handled: false, retryEntry: null };
    }
    if (!isBudgetEscalationTrigger(hardStop.trigger)) {
      return { handled: false, retryEntry: null };
    }

    const resumesUsed = this.state.issuePauseTriageResumes[issueId] ?? 0;
    if (resumesUsed >= this.config.pauseTriage.maxResumes) {
      return { handled: false, retryEntry: null };
    }

    const gate = this.evaluateRateLimitAdmissionGate();
    if (gate.blocked) {
      return { handled: false, retryEntry: null };
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
              issue: runningEntry.issue,
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
      return { handled: false, retryEntry: null };
    }

    let verdict: PauseTriageVerdict | null = null;
    try {
      verdict = await this.runPauseTriage(evidence);
    } catch {
      verdict = null;
    }

    const willResume = verdict !== null && verdict.verdict === "continue";

    // Journal the verdict together with the action actually taken so the
    // audit trail can never claim a resume that did not happen (PR #330
    // review P2). Journal-first for resumes (council R1, mirroring
    // budget_escalation's PR #329 contract): a resume that cannot be
    // journaled is not granted — otherwise a restart replays a lower
    // consumed-resume count and the triage cap (maxResumes) can be exceeded
    // across a deploy. Park-side journaling stays best-effort because the
    // park is the safe default either way.
    let pauseTriageEntry: DispatcherRunJournalEntry | null = null;
    try {
      pauseTriageEntry = await this.recordRunJournalEntry({
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
          ...pendingStageSignalMetadata(pendingStageSignal),
        },
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal pause-triage verdict for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (willResume) {
        // Journal failure means the resume is NOT authorized: fall through
        // to the normal operator park without consuming a resume, so live
        // and replay agree on the count (both omit it).
        return { handled: false, retryEntry: null };
      }
    }

    if (willResume) {
      this.state.issuePauseTriageResumes[issueId] = resumesUsed + 1;
      if (pendingStageSignal !== null && pauseTriageEntry !== null) {
        const storedPendingStageSignal = {
          ...pendingStageSignal,
          setBySequence: pauseTriageEntry.sequence,
        };
        this.state.issuePendingStageSignals[issueId] = storedPendingStageSignal;
      }
    }

    if (verdict === null || verdict.verdict !== "continue") {
      if (verdict !== null) {
        try {
          await this.postComment?.(
            issueId,
            `Pause triage verdict: ${verdict.verdict}\n${sanitizeForLinear(verdict.rationale)}`,
          );
        } catch {
          // Observability only.
        }
      }
      return { handled: false, retryEntry: null };
    }

    // Routed through the shared intent-verb layer (SYMPH-422 parity with
    // the deferred path's release intent): the continuation is a `resume`
    // intent attributed to watchdog-l2, so the sync continue is journaled
    // and replayable like every other verb caller. No park exists at this
    // point (the park only fires after triage declines), so there is no
    // generation to fence against — the verb's own not-parked/not-running
    // preconditions are the guard.
    const actor = this.watchdogL2Actor();

    try {
      await this.postComment?.(
        issueId,
        [
          `Pause triage verdict: continue (resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes}) — ${formatIntentAttribution(actor)}`,
          sanitizeForLinear(verdict.rationale),
          "Auto-resuming one continuation unit at the current budget ceiling.",
        ].join("\n"),
      );
    } catch {
      // Observability only.
    }

    if (pendingStageSignal !== null) {
      const storedPendingStageSignal =
        this.state.issuePendingStageSignals[issueId] ?? pendingStageSignal;
      return {
        handled: true,
        retryEntry: await this.consumePendingStageSignal(
          issueId,
          runningEntry,
          storedPendingStageSignal,
        ),
      };
    }

    const resumeResult = await this.writeIntent({
      verb: "resume",
      issueId,
      issueIdentifier: runningEntry.identifier,
      actor,
      reason: {
        class: "pause_triage_continue",
        human: `pause triage authorized resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes}`,
      },
      stage: stageName,
      renderComment: false,
    });
    return {
      handled: true,
      retryEntry: resumeResult.retryEntry ?? null,
    };
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
    issue: Issue;
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

    // Journal-first for resumes (council R1): same contract as the sync
    // path above — a resume that cannot be journaled is not granted, so a
    // restart can never replay a lower consumed-resume count than live.
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
          ...pendingStageSignalMetadata(
            this.state.issuePendingStageSignals[issueId] ?? null,
          ),
        },
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal deferred pause-triage verdict for ${identifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (willResume) {
        // Journal failure means the resume is NOT authorized; the standing
        // park stays and no resume is consumed (live and replay agree).
        return;
      }
    }

    if (willResume) {
      this.state.issuePauseTriageResumes[issueId] = resumesUsed + 1;
    }

    if (!willResume) {
      if (verdict !== null && stillEligible) {
        try {
          await this.postComment?.(
            issueId,
            `Pause triage verdict: ${verdict.verdict}\n${sanitizeForLinear(verdict.rationale)}`,
          );
        } catch {
          // Observability only.
        }
      }
      return;
    }

    // Routed through the shared intent-verb layer (SYMPH-399): the un-park
    // is a fenced release attributed to watchdog-l2, so a pause-triage
    // resume and an operator resume are indistinguishable in the journal
    // except for the actor field. The fence re-checks the park generation
    // the eligibility guard above already validated (belt-and-braces).
    const actor = this.watchdogL2Actor();
    const releaseResult = await this.writeIntent({
      verb: "release",
      issueId,
      issueIdentifier: identifier,
      actor,
      reason: {
        class: "pause_triage_continue",
        human: `pause triage authorized resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes}`,
      },
      ...(input.expectedParkSeq === null
        ? {}
        : { fence: { expectedParkSeq: input.expectedParkSeq } }),
      renderComment: false,
    });
    if (releaseResult.status === "rejected_stale") {
      return;
    }

    const postContinueComment = async (): Promise<void> => {
      try {
        await this.postComment?.(
          issueId,
          [
            `Pause triage verdict: continue (resume ${resumesUsed + 1}/${this.config.pauseTriage.maxResumes}) — ${formatIntentAttribution(actor)}`,
            sanitizeForLinear(verdict.rationale),
            "Auto-resuming one continuation unit at the current budget ceiling.",
          ].join("\n"),
        );
      } catch {
        // Observability only.
      }
    };

    const pendingStageSignal = this.state.issuePendingStageSignals[issueId];
    if (pendingStageSignal !== undefined) {
      await this.consumePendingStageSignal(
        issueId,
        createPendingRunningEntry({
          issue: input.issue,
          identifier,
          attempt: pendingStageSignal.attempt,
          agentMessage: pendingStageSignal.agentMessage,
        }),
        pendingStageSignal,
      );
      await postContinueComment();
      return;
    }

    await postContinueComment();

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
    issueTitle: string;
    stageName: string;
    verdict: { verdict: "pass" | "rework"; feedback: string } | null;
    completionMessage: string | null;
  }): Promise<void> {
    const { issueId, identifier, issueTitle, stageName, verdict } = input;

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
    const failOpenStreak =
      action === "pass_open" ? this.acGateFailOpenStreak + 1 : 0;
    const failOpenSeverity =
      action === "pass_open"
        ? failOpenStreak >= 2
          ? "critical"
          : "warning"
        : null;
    this.acGateFailOpenStreak = failOpenStreak;

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
          failOpenStreak: action === "pass_open" ? failOpenStreak : null,
          alertSeverity: failOpenSeverity,
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
          `## Review Findings (AC gate)\n${sanitizeForLinear(verdict.feedback, { maxLen: 4000 })}\nRevise the workpad acceptance criteria per the contract (test:/check:/judge: tags, falsifiable, covering the ticket intent) and complete the stage again.`,
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
      try {
        this.onAcGateFailOpen?.({
          issueId,
          issueIdentifier: identifier,
          issueTitle,
          stageName,
          failOpenStreak,
          severity: failOpenSeverity ?? "warning",
        });
      } catch {
        // Notification failures are always swallowed.
      }
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

  private async handleNormalStageExit(
    issueId: string,
    runningEntry: RunningEntry,
    exitedStageName: string | null,
    agentMessage: string | undefined,
  ): Promise<RetryEntry | null> {
    const feedbackBounce = await this.handleContinuousFeedbackBounce(
      issueId,
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
      // Hold-then-route (SYMPH-354): the stage neither advances nor parks
      // until the local model scores the acceptance criteria. This same path
      // is used when a deferred budget pause is resumed with a pending
      // [STAGE_COMPLETE] signal (SYMPH-440): the budget gate has already
      // authorized consumption, and the terminal completion message is still
      // routed through the normal AC gate.
      const scheduleDeferred = this.scheduleDeferred;
      const completionMessage = agentMessage ?? runningEntry.lastCodexMessage;
      // Normal exits already hold the claim from dispatch; pending-signal
      // consumption reclaims it here so nothing redispatches while AC runs.
      this.state.claimed.add(issueId);
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
              issueId,
              identifier: runningEntry.identifier,
              issueTitle: runningEntry.issue.title,
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

    const reviewMergeReady = await this.prepareReviewCompletionForMerge({
      issueId,
      runningEntry,
      exitedStageName,
      agentMessage,
    });
    if (!reviewMergeReady) {
      return null;
    }

    if (
      this.config.specFidelity.enabled &&
      this.runSpecFidelityJudge !== undefined &&
      this.scheduleDeferred !== undefined &&
      exitedStageName !== null &&
      exitedStageDef?.transitions.onRework != null
    ) {
      // Advisory judge lane (SYMPH-343): fires alongside the normal advance.
      // Fired AFTER prepareReviewCompletionForMerge so this round's merge
      // candidate already exists, letting us capture the canonical candidate's
      // reviewed head at FIRE time rather than re-resolving it at
      // deferred-record time (SYMPH-758, council R1 P1) — that prevents a later
      // review round's candidate from mis-keying this verdict. Null when no
      // candidate was promoted (advisory only). NOTE: when an OLD candidate is
      // already canonical from a parked/resumed lifecycle, prepareReviewCompletionForMerge
      // short-circuits and the captured head may be that stale candidate's —
      // a pre-existing merge-candidate-lifecycle gap tracked in SYMPH-764, not
      // introduced here (the prior record-time lookup had the same staleness).
      // Gated behind the reviewMergeReady guard, so a parked review skips the
      // advisory judge — acceptable, as that path is already parked for an
      // operator. Still before advanceStage, so the AC snapshot is intact.
      const scheduleDeferred = this.scheduleDeferred;
      const stageForVerdict = exitedStageName;
      const reviewedHeadShaForVerdict =
        this.findCanonicalMergeCandidate(issueId)?.reviewedHeadSha ?? null;
      const stageSkippedReason = this.issueStageSkippedAcGateReason(issueId);
      if (
        this.state.issueAcSnapshots[issueId] === undefined &&
        stageSkippedReason !== null
      ) {
        // SYMPH-765: this issue skipped the investigate AC gate and its ticket
        // carried no AC section, so there is no canonical rubric to judge
        // against. Running the judge on a null AC would force a generic
        // `rework` ("no acceptance criteria recorded") that parks an otherwise
        // healthy merge — the SYMPH-759 canary false positive. Record an
        // explicit, operator-visible non-gating marker keyed to the reviewed
        // head and skip the judge entirely (per the Hybrid decision: thin
        // direct-to-implement issues with no canonical rubric are non-gating,
        // never reworked).
        scheduleDeferred(() =>
          this.recordSpecFidelityNonGating({
            issueId,
            identifier: runningEntry.identifier,
            stageName: stageForVerdict,
            reason: stageSkippedReason,
            reviewedHeadSha: reviewedHeadShaForVerdict,
          }),
        );
      } else {
        void this.runSpecFidelityJudge({
          issueId,
          issueIdentifier: runningEntry.identifier,
          issueTitle: runningEntry.issue.title,
          acceptanceCriteria: this.state.issueAcSnapshots[issueId] ?? null,
          // Pending-signal consumption sets lastCodexMessage to the terminal
          // message before routing through the normal exit path.
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
                issueId,
                identifier: runningEntry.identifier,
                stageName: stageForVerdict,
                verdict,
                reviewedHeadSha: reviewedHeadShaForVerdict,
              }),
            );
          })
          .catch(() => {
            // Chain must never become an unhandled rejection.
          });
      }
    }

    const transition = this.advanceStage(
      issueId,
      runningEntry.identifier,
      runningEntry,
    );
    if (transition === "completed") {
      this.state.completed.add(issueId);
      this.releaseClaim(issueId);
      return null;
    }

    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: null,
      delayType: "continuation",
    });
  }

  private async prepareReviewCompletionForMerge(input: {
    issueId: string;
    runningEntry: RunningEntry;
    exitedStageName: string | null;
    agentMessage: string | undefined;
  }): Promise<boolean> {
    if (!this.isReviewToMergeTransition(input.exitedStageName)) {
      return true;
    }

    // SYMPH-764: only short-circuit when the existing canonical candidate
    // reflects THIS review round. The prior guard returned on ANY canonical
    // candidate, which wrongly skipped re-ingestion after a parked candidate was
    // resumed into a NEW review round — the new round's review_gate_result /
    // merge_candidate rows were never appended, so merge dispatch and the
    // spec-fidelity verdict (SYMPH-758) kept keying to the stale candidate's
    // reviewed head. The decision is deferred until after the artifact is read,
    // where this round's reviewed head is known.
    const existingCanonical = this.findCanonicalMergeCandidate(input.issueId);

    const markerPath = extractReviewGateResultPath(
      input.agentMessage ?? input.runningEntry.lastCodexMessage,
    );
    if (markerPath === null) {
      // No fresh review artifact on this exit. If a prior round already recorded
      // a canonical candidate this is an idempotent re-exit — advance on it.
      // Otherwise the review produced no canonical rows at all: park.
      if (existingCanonical !== null) {
        return true;
      }
      await this.parkMergeCandidateInvariantFailure({
        issue: input.runningEntry.issue,
        stageName: input.exitedStageName,
        reasonCode: "missing_canonical_review_gate_result",
        detail:
          "review stage completed without [REVIEW_GATE_RESULT_PATH: ...], so the runtime host cannot append canonical review_gate_result and merge_candidate rows",
      });
      return false;
    }

    const artifactResult = await this.readAndValidateReviewGateArtifact({
      path: markerPath,
      issueId: input.issueId,
      issueIdentifier: input.runningEntry.identifier,
    });
    if (!artifactResult.ok) {
      // SYMPH-764 (council R1 P2): the marker is present but its artifact is
      // unreadable/missing — e.g. an idempotent re-exit after the ephemeral
      // /tmp artifact was cleaned up once the canonical was already journaled.
      // The durable journal is the source of truth: when a canonical candidate
      // already exists (its passing source review_gate_result is journaled),
      // advance on it rather than parking a review that already completed. This
      // cannot revive the SYMPH-764 stale-candidate bug — that path has a
      // READABLE new-head artifact and is resolved by the head-match check
      // below; only a genuinely unreadable artifact reaches here.
      if (existingCanonical !== null) {
        return true;
      }
      await this.parkMergeCandidateInvariantFailure({
        issue: input.runningEntry.issue,
        stageName: input.exitedStageName,
        reasonCode: "missing_canonical_review_gate_result",
        detail: artifactResult.reason,
        reviewResultPath: markerPath,
      });
      return false;
    }

    const entries = buildReviewJournalEntries(artifactResult.result, {
      issueId: input.issueId,
      issueIdentifier: input.runningEntry.identifier,
      ownerId: this.leaseOwnerId,
      stage: "review",
      attempt: input.runningEntry.retryAttempt,
      source: "pipeline",
      actor: {
        kind: "dispatcher",
        id: this.leaseOwnerId,
      },
    });
    if (
      !entries.some((entry) => entry.kind === "review_gate_result") ||
      !entries.some((entry) => entry.kind === "merge_candidate")
    ) {
      await this.parkMergeCandidateInvariantFailure({
        issue: input.runningEntry.issue,
        stageName: input.exitedStageName,
        reasonCode: "missing_canonical_review_gate_result",
        detail:
          "review-result artifact did not reduce to both review_gate_result and merge_candidate rows; expected verdict pass with decorrelation_merge_eligible true",
        reviewResultPath: markerPath,
      });
      return false;
    }

    // SYMPH-764: short-circuit only when the existing canonical candidate is
    // this round's candidate (same reviewed head) — an idempotent re-exit whose
    // rows are already present. A canonical candidate from an earlier,
    // since-parked round has a different reviewed head; appending this round's
    // rows (idempotent by key) lets the reducer supersede it so the canonical
    // reviewed head reflects the current round.
    const mergeCandidateEntry = entries.find(
      (entry) => entry.kind === "merge_candidate",
    );
    const reviewedHeadSha =
      mergeCandidateEntry === undefined
        ? null
        : readMetadataString(mergeCandidateEntry.metadata, "reviewed_head_sha");
    if (
      existingCanonical !== null &&
      reviewedHeadSha !== null &&
      existingCanonical.reviewedHeadSha === reviewedHeadSha
    ) {
      return true;
    }

    for (const entry of entries) {
      await this.recordRunJournalEntry(entry);
    }

    if (this.findCanonicalMergeCandidate(input.issueId) === null) {
      await this.parkMergeCandidateInvariantFailure({
        issue: input.runningEntry.issue,
        stageName: input.exitedStageName,
        reasonCode: "missing_canonical_review_gate_result",
        detail:
          "canonical review rows were appended, but no reducible merge_candidate exists for the issue",
        reviewResultPath: markerPath,
      });
      return false;
    }

    return true;
  }

  private isReviewToMergeTransition(exitedStageName: string | null): boolean {
    if (exitedStageName !== "review" || this.config.stages === null) {
      return false;
    }
    const stage = this.config.stages.stages[exitedStageName];
    return stage?.transitions.onComplete === "merge";
  }

  private async readAndValidateReviewGateArtifact(input: {
    path: string;
    issueId: string;
    issueIdentifier: string;
  }): Promise<
    | { ok: true; result: HeadlessCouncilGateResult }
    | { ok: false; reason: string }
  > {
    if (input.path.includes("\0")) {
      return { ok: false, reason: "review artifact path contains NUL byte" };
    }
    const resolvedPath = resolve(input.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
    } catch {
      return {
        ok: false,
        reason: "review artifact unreadable or malformed",
      };
    }

    if (!isRecord(parsed)) {
      return { ok: false, reason: "review artifact root is not an object" };
    }
    const result = parsed as unknown as HeadlessCouncilGateResult;
    if (
      result.issueId !== input.issueIdentifier &&
      result.issueId !== input.issueId
    ) {
      return {
        ok: false,
        reason: `review artifact issue mismatch: expected ${input.issueIdentifier} or ${input.issueId}, got ${String(result.issueId)}`,
      };
    }
    if (result.verdict !== "pass") {
      return {
        ok: false,
        reason: `review artifact verdict is ${String(result.verdict)}; expected pass`,
      };
    }
    if (
      !isRecord(result.pr) ||
      typeof result.pr.repo !== "string" ||
      typeof result.pr.number !== "number" ||
      typeof result.pr.baseRef !== "string" ||
      typeof result.pr.headRef !== "string"
    ) {
      return {
        ok: false,
        reason:
          "review artifact missing repo, PR number, base ref, or head ref",
      };
    }
    if (
      !isRecord(result.review_metadata) ||
      typeof result.review_metadata.base_sha !== "string" ||
      typeof result.review_metadata.reviewed_head_sha !== "string" ||
      typeof result.review_metadata.round !== "number"
    ) {
      return {
        ok: false,
        reason:
          "review artifact missing base SHA, reviewed head SHA, or review round",
      };
    }
    if (!isRecord(result.artifactPaths)) {
      return {
        ok: false,
        reason:
          "review artifact resultJson path does not match the dispatcher marker",
      };
    }
    const resultJsonPath = result.artifactPaths.resultJson;
    if (typeof resultJsonPath !== "string" || resultJsonPath.includes("\0")) {
      return {
        ok: false,
        reason:
          "review artifact resultJson path does not match the dispatcher marker",
      };
    }
    if (resolve(resultJsonPath) !== resolvedPath) {
      return {
        ok: false,
        reason:
          "review artifact resultJson path does not match the dispatcher marker",
      };
    }
    const artifactDirPath = result.artifactPaths.artifactDir;
    if (typeof artifactDirPath !== "string" || artifactDirPath.includes("\0")) {
      return {
        ok: false,
        reason:
          "review artifact directory does not match the dispatcher marker parent directory",
      };
    }
    if (resolve(artifactDirPath) !== dirname(resolvedPath)) {
      return {
        ok: false,
        reason:
          "review artifact directory does not match the dispatcher marker parent directory",
      };
    }
    const reviewRouting = result.review_routing;
    const decorrelationBasis =
      isRecord(reviewRouting) && isRecord(reviewRouting.decorrelationBasis)
        ? reviewRouting.decorrelationBasis
        : null;
    if (decorrelationBasis?.mergeEligible !== true) {
      return {
        ok: false,
        reason:
          "review artifact is not merge-eligible under its decorrelation basis",
      };
    }

    return { ok: true, result };
  }

  private findCanonicalMergeCandidate(
    issueId: string,
  ): MergeCandidateRecord | null {
    const candidate = reduceMergeCandidates(this.state.dispatcherRunJournal)[
      issueId
    ];
    if (candidate === undefined) {
      return null;
    }
    const candidateEntry = this.state.dispatcherRunJournal.findLast(
      (entry) =>
        entry.kind === "merge_candidate" &&
        entry.issueId === issueId &&
        readMetadataString(entry.metadata, "candidate_id") ===
          candidate.candidateId,
    );
    const sourceKey =
      candidateEntry === undefined
        ? null
        : readMetadataString(
            candidateEntry.metadata,
            "source_review_idempotency_key",
          );
    if (sourceKey === null) {
      return null;
    }
    const sourceReview = this.state.dispatcherRunJournal.find(
      (entry) =>
        entry.kind === "review_gate_result" &&
        entry.issueId === issueId &&
        entry.idempotencyKey === sourceKey &&
        readMetadataString(entry.metadata, "gate_verdict") === "pass",
    );
    return sourceReview === undefined ? null : candidate;
  }

  /**
   * SYMPH-765: when an issue skips the investigate AC gate and its ticket
   * carried no AC section, admission journals an `ac_gate` entry with
   * `status: "skipped"`. Returns that entry's reason when the most recent
   * `ac_gate` entry for the issue is such a skip, so spec-fidelity treats the
   * missing rubric as a structural stage-skip (non-gating) rather than a worker
   * AC failure. Returns null when the latest `ac_gate` entry is a frozen
   * snapshot (Branch A) or a normal gate pass, or when there is none — the more
   * recent entry always wins, so a re-dispatch that freezes or gates an AC
   * supersedes an earlier skip.
   */
  private issueStageSkippedAcGateReason(issueId: string): string | null {
    const entry = this.state.dispatcherRunJournal.findLast(
      (e) => e.kind === "ac_gate" && e.issueId === issueId,
    );
    if (entry === undefined || entry.metadata.status !== "skipped") {
      return null;
    }
    return (
      readMetadataString(entry.metadata, "reason") ??
      "no_canonical_ac_stage_skipped"
    );
  }

  private async parkMergeCandidateInvariantFailure(input: {
    issue: Issue;
    stageName: string | null;
    reasonCode: string;
    detail: string;
    reviewResultPath?: string;
  }): Promise<void> {
    const reason = `${input.reasonCode}: ${input.detail}`;
    const signature = hashReviewInfrastructureSignature(
      `merge_candidate_invariant:${input.reasonCode}:${input.issue.id}`,
    );
    const stageHistory = this.state.issueExecutionHistory[input.issue.id] ?? [];
    this.state.failed.add(input.issue.id);
    this.releaseClaim(input.issue.id);
    this.clearTerminalIssueRuntimeState(input.issue.id);
    this.markIssueRequiresExplicitResume(
      input.issue.id,
      input.issue.state,
      null,
      {
        reason: input.reasonCode,
        setBySequence: null,
      },
    );
    this.recordFailureInCluster(
      input.issue.id,
      input.issue.identifier,
      {
        signature,
        normalizedText: reason,
        class: "infra",
      },
      input.stageName,
    );
    try {
      await this.fireEscalationSideEffects(
        input.issue.id,
        input.issue.identifier,
        [
          "## Parked: canonical merge candidate missing",
          "",
          `Reason: ${sanitizeForLinear(reason, { maxLen: 2000 })}`,
          ...(input.reviewResultPath === undefined
            ? []
            : [`Review result path: ${input.reviewResultPath}`]),
          "",
          "The runtime host refused to advance or dispatch merge without canonical review_gate_result and merge_candidate journal rows.",
        ].join("\n"),
      );
    } catch (error) {
      console.warn(
        `Failed to post merge-candidate invariant escalation for ${input.issue.identifier}: ${formatUnknownError(error)}`,
      );
    }
    await this.recordFailureExhausted(
      input.issue.id,
      input.issue.identifier,
      input.issue.title,
      reason,
      {
        failure_signature: signature,
        failure_class: "infra",
      },
      {
        issueDescription: input.issue.description ?? "",
        stageName: input.stageName,
        parkKind: "retry_exhausted",
        attemptCount: 0,
        reworkCount: this.state.issueReworkCounts[input.issue.id] ?? 0,
        failureRecords: [],
        stageHistory,
      },
    );
  }

  private async consumePendingStageSignal(
    issueId: string,
    runningEntry: RunningEntry,
    pendingStageSignal: PendingStageSignal,
  ): Promise<RetryEntry | null> {
    const rollbackSnapshot = this.snapshotPendingStageConsumptionRollback(
      issueId,
      runningEntry,
    );
    const originalLastCodexMessage = runningEntry.lastCodexMessage;
    try {
      delete this.state.issuePendingStageSignals[issueId];
      if (pendingStageSignal.stageName !== null) {
        this.state.issueStages[issueId] = pendingStageSignal.stageName;
      }
      runningEntry.lastCodexMessage = pendingStageSignal.agentMessage;

      let retryEntry: RetryEntry | null;
      if (pendingStageSignal.signal === "failure") {
        await this.recordPendingStageSignalConsumed(
          issueId,
          runningEntry,
          pendingStageSignal,
        );
        this.clearResumeRequirement(issueId);
        retryEntry = this.handleFailureSignal(
          issueId,
          runningEntry,
          pendingStageSignal.failureClass,
          pendingStageSignal.agentMessage,
        );
      } else {
        retryEntry = await this.handleNormalStageExit(
          issueId,
          runningEntry,
          pendingStageSignal.stageName,
          pendingStageSignal.agentMessage,
        );
        await this.recordPendingStageSignalConsumed(
          issueId,
          runningEntry,
          pendingStageSignal,
        );
        this.clearResumeRequirement(issueId);
      }
      return retryEntry;
    } catch (error) {
      runningEntry.lastCodexMessage = originalLastCodexMessage;
      this.clearRetryEntry(issueId);
      this.restorePendingStageConsumptionRollback(rollbackSnapshot);
      throw error;
    }
  }

  private snapshotPendingStageConsumptionRollback(
    issueId: string,
    runningEntry: RunningEntry,
  ): PendingStageConsumptionRollbackSnapshot {
    const state = cloneOrchestratorState(this.state);
    if (
      state.running[issueId] === undefined &&
      runningEntry.workerHandle !== null
    ) {
      state.running[issueId] = cloneRunningEntry(runningEntry);
    }
    return {
      state,
      lastExitHistorySnapshot: cloneExecutionHistoryMap(
        this.lastExitHistorySnapshot,
      ),
      resumeRequiredGuards: cloneResumeRequiredGuards(
        this.resumeRequiredGuards,
      ),
      issueParkGenerations: new Map(this.issueParkGenerations),
      triagedParkGenerations: new Map(this.triagedParkGenerations),
      escalatedParkGenerations: new Map(this.escalatedParkGenerations),
      issueAnchorCursors: new Map(this.issueAnchorCursors),
      anchorCursorSequence: this.anchorCursorSequence,
      parkSequence: this.parkSequence,
    };
  }

  private restorePendingStageConsumptionRollback(
    snapshot: PendingStageConsumptionRollbackSnapshot,
  ): void {
    restoreOrchestratorState(this.state, snapshot.state);
    restoreMap(this.lastExitHistorySnapshot, snapshot.lastExitHistorySnapshot);
    restoreMap(this.resumeRequiredGuards, snapshot.resumeRequiredGuards);
    restoreMap(this.issueParkGenerations, snapshot.issueParkGenerations);
    restoreMap(this.triagedParkGenerations, snapshot.triagedParkGenerations);
    restoreMap(
      this.escalatedParkGenerations,
      snapshot.escalatedParkGenerations,
    );
    restoreMap(this.issueAnchorCursors, snapshot.issueAnchorCursors);
    this.anchorCursorSequence = snapshot.anchorCursorSequence;
    this.parkSequence = snapshot.parkSequence;
  }

  private async recordPendingStageSignalConsumed(
    issueId: string,
    runningEntry: RunningEntry,
    pendingStageSignal: PendingStageSignal,
  ): Promise<void> {
    const resultingStageName = this.state.issueStages[issueId] ?? null;
    await this.recordRunJournalEntry({
      idempotencyKey: `pending_stage_signal:${issueId}:${pendingStageSignal.setBySequence ?? "live"}:consumed`,
      timestamp: this.now().toISOString(),
      kind: "pending_stage_signal",
      issueId,
      issueIdentifier: runningEntry.identifier,
      operation: "dispatcher",
      stage: pendingStageSignal.stageName,
      attempt: pendingStageSignal.attempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Consumed pending ${pendingStageSignal.signal} signal for ${runningEntry.identifier} after budget-pause authorization.`,
      metadata: {
        status: "consumed",
        sourceSequence: pendingStageSignal.setBySequence,
        signal: pendingStageSignal.signal,
        failureClass: pendingStageSignal.failureClass,
        sourceStageName: pendingStageSignal.stageName,
        agentMessage: pendingStageSignal.agentMessage,
        resultingStageName,
        completed: this.state.completed.has(issueId),
      },
    });
  }

  private async recordSpecFidelityVerdict(input: {
    issueId: string;
    identifier: string;
    stageName: string;
    verdict: { verdict: "pass" | "rework"; findings: string };
    /**
     * Reviewed head the judge evaluated, captured at judge-FIRE time by the
     * caller (SYMPH-758). It must NOT be re-resolved here: this recording runs
     * in a deferred task, and a later review round can promote a newer candidate
     * before it fires — resolving the canonical candidate now would key the
     * verdict to the wrong head, letting a stale `pass` mask a real `rework`
     * (council R1 P1, confirmed by Codex + Pi). Null when no candidate was
     * promoted, leaving the verdict purely advisory.
     */
    reviewedHeadSha: string | null;
  }): Promise<void> {
    const reviewedHeadSha = input.reviewedHeadSha;
    try {
      await this.recordRunJournalEntry({
        // Include the reviewed head so distinct-head verdicts never collide and
        // the entry is correlated to the exact judged commit (SYMPH-758, council
        // R1 P2). The timestamp is retained so a re-judged `pass` for the same
        // head is a NEW row that supersedes an earlier `rework` (latest-wins);
        // a head-only key would dedupe it and break supersession.
        idempotencyKey: `spec_fidelity:${input.issueId}:${input.stageName}:${reviewedHeadSha ?? "no-head"}:${this.now().toISOString()}`,
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
          ...(reviewedHeadSha === null
            ? {}
            : { reviewed_head_sha: reviewedHeadSha }),
        },
      });
    } catch {
      // Audit best-effort.
    }
    try {
      await this.postComment?.(
        input.issueId,
        `## Spec-fidelity verdict (independent judge): ${input.verdict.verdict}\n${sanitizeForLinear(input.verdict.findings, { maxLen: 6000 })}`,
      );
    } catch {
      // Observability only.
    }
  }

  /**
   * SYMPH-765: record an explicit, operator-visible non-gating spec-fidelity
   * outcome for a candidate with no canonical AC rubric because the issue
   * skipped the investigate AC gate and its ticket had no AC section. This is
   * deliberately NOT a `rework` verdict: {@link hasCurrentSpecFidelityRework}
   * keys only on `verdict === "rework"`, so a `skipped`/`non_gating` row never
   * blocks merge actuation. It distinguishes "no canonical AC because the stage
   * was skipped" from "the worker failed to satisfy AC" (AC #3) without parking
   * a healthy merge.
   */
  private async recordSpecFidelityNonGating(input: {
    issueId: string;
    identifier: string;
    stageName: string;
    reason: string;
    reviewedHeadSha: string | null;
  }): Promise<void> {
    const reviewedHeadSha = input.reviewedHeadSha;
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `spec_fidelity:${input.issueId}:${input.stageName}:${reviewedHeadSha ?? "no-head"}:non-gating:${this.now().toISOString()}`,
        timestamp: this.now().toISOString(),
        kind: "spec_fidelity",
        issueId: input.issueId,
        issueIdentifier: input.identifier,
        operation: "dispatcher",
        stage: input.stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Spec-fidelity non-gating for ${input.identifier}: ${input.reason}.`,
        metadata: {
          status: "skipped",
          verdict: "non_gating",
          reason: input.reason,
          findings:
            "No canonical acceptance-criteria snapshot: the issue skipped the investigate AC gate and its ticket carried no AC section. Spec-fidelity is non-gating for this merge candidate.",
          ...(reviewedHeadSha === null
            ? {}
            : { reviewed_head_sha: reviewedHeadSha }),
        },
      });
    } catch {
      // Audit best-effort.
    }
    try {
      await this.postComment?.(
        input.issueId,
        `## Spec-fidelity: non-gating\nNo canonical acceptance-criteria snapshot for this merge candidate (\`${input.reason}\`): the issue skipped the investigate AC gate and its ticket has no \`## Acceptance Criteria\` section. The independent judge did not run; merge gating proceeds on the council review result alone.`,
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

    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      console.warn(
        `[orchestrator] ${validation.error.message} Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      this.recordDispatchVerdict({
        issueId,
        issueIdentifier: retryEntry.identifier ?? issueId,
        disposition: "gate",
        reasonCode: validation.error.code,
        remedy: validation.error.message,
        attempt: retryEntry.attempt,
        details: { message: validation.error.message },
      });
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: `dispatch validation failed: ${validation.error.message}`,
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const emergencyStopResult = this.blockForEmergencyStop(1);
    if (emergencyStopResult !== null) {
      console.warn(
        `[orchestrator] Emergency stop active. Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: "emergency stop active",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const runtimePauseResult = this.blockForPipelinePause(1);
    if (runtimePauseResult !== null) {
      console.warn(
        `[orchestrator] Runtime pipeline pause active. Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: "runtime pipeline pause active",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
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
      // SYMPH-773: a closed rate gate must not pin a retry whose issue already
      // left the active set (e.g. an operator parked it to a state outside
      // active_states). Reconcile against a fresh candidate fetch BEFORE the
      // deferral so the retry is released within one timer cycle instead of
      // rescheduling forever behind the gate. The fetch is bounded — at most one
      // per gated retry-timer fire, not per poll. Merge-actuator re-polls are
      // journal-bounded and intentionally outlive candidate-set membership, so
      // they are exempt and simply re-defer.
      if (retryEntry.delayType !== "merge_actuator_poll") {
        let gateCandidates: Issue[] | null;
        try {
          gateCandidates = await this.tracker.fetchCandidateIssues();
        } catch {
          // A tracker hiccup must not drop a healthy retry: fall through to the
          // normal gate deferral and reconcile again on the next timer fire.
          gateCandidates = null;
        }
        if (
          gateCandidates !== null &&
          !gateCandidates.some((candidate) => candidate.id === issueId)
        ) {
          this.dropDepartedRetryCandidate(
            issueId,
            retryEntry.identifier ?? issueId,
            null,
            null,
          );
          return { dispatched: false, released: true, retryEntry: null };
        }
      }
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
      this.dropDepartedRetryCandidate(
        issueId,
        retryEntry.identifier ?? issueId,
        null,
        null,
      );
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (!this.admitRetryResumeRequirement(issue, retryEntry)) {
      this.releaseClaim(issueId);
      return {
        dispatched: false,
        released: false,
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

    const currentRateLimitGate = this.evaluateRateLimitAdmissionGate();
    if (currentRateLimitGate.blocked) {
      console.warn(
        `[orchestrator] ${currentRateLimitGate.reason} Deferring retry for ${issue.identifier}.`,
      );
      const gateVerdict = this.buildRateLimitGateVerdict(currentRateLimitGate);
      this.recordDispatchVerdict({
        issueId,
        issueIdentifier: issue.identifier,
        disposition: "gate",
        reasonCode: gateVerdict.reasonCode,
        remedy: gateVerdict.remedy,
        attempt: retryEntry.attempt,
        details: gateVerdict.details,
      });
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: issue.identifier,
          error: "rate-limit admission floor active",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const reservationKey = this.reserveRateLimitAdmission(currentRateLimitGate);
    if (reservationKey === false) {
      this.recordDispatchVerdict({
        issueId,
        issueIdentifier: issue.identifier,
        disposition: "gate",
        reasonCode: "rate_window_admission_capacity",
        remedy:
          "Wait for rate-limit usage telemetry to refresh before admitting another retry.",
        attempt: retryEntry.attempt,
        details: {
          expectedUnitBurnPct: currentRateLimitGate.expectedUnitBurnPct,
          deferredUntil: currentRateLimitGate.deferredUntil,
          admissionCapacity: currentRateLimitGate.admissionCapacity,
        },
      });
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: issue.identifier,
          error: "rate-limit admission capacity exhausted",
          delayType: retryEntry.delayType,
          deferral: true,
        }),
      };
    }

    const dispatchResult = await this.dispatchIssue(issue, retryEntry.attempt);
    if (!dispatchResult.dispatched) {
      this.releaseRateLimitAdmissionReservation(reservationKey);
    }
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
        completedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - Date.parse(runningEntry.startedAt),
        totalTokens: runningEntry.totalStageTotalTokens,
        inputTokens: runningEntry.totalStageInputTokens,
        outputTokens: runningEntry.totalStageOutputTokens,
        cacheReadTokens: runningEntry.totalStageCacheReadTokens,
        cacheWriteTokens: runningEntry.totalStageCacheWriteTokens,
        compactions: runningEntry.totalStageCompactions ?? 0,
        rateLimitWindows: cloneRateLimitTelemetry(
          runningEntry.rateLimitWindows,
        ),
        usageEventCadence: buildStageUsageEventCadence(runningEntry),
        turns: runningEntry.turnCount,
        outcome: classifiedOutcome,
      };
      // Journal the stage record (SYMPH-401) so replay reduces it back into
      // issueExecutionHistory and per-issue cumulative spend survives a
      // restart. Sequence-suffixed key: continuations reuse stage+attempt,
      // so a stable key would dedupe (and drop) every stage after the first.
      // Journal-first (council R1, mirroring budget_escalation's PR #329
      // contract): the record reaches live execution history only after the
      // journal write succeeded, so memory and disk always agree on spend.
      // On a failed write both surfaces omit the record — both-miss keeps
      // live and replay convergent, while a live-only push would silently
      // under-count spend after the next restart.
      try {
        await this.recordRunJournalEntry({
          idempotencyKey: `stage_record:${input.issueId}:${stageName}:${formatAttemptKey(runningEntry.retryAttempt)}:${this.nextRunJournalSequence()}`,
          timestamp: endedAt.toISOString(),
          kind: "stage_record",
          issueId: input.issueId,
          issueIdentifier: runningEntry.identifier,
          operation: "dispatcher",
          stage: stageName,
          attempt: runningEntry.retryAttempt,
          ownerId: this.leaseOwnerId,
          lease: null,
          summary: `Stage record for ${runningEntry.identifier} (${stageName}): ${stageRecord.totalTokens} tokens over ${stageRecord.turns} turns (${stageRecord.outcome}).`,
          metadata: {
            schema_version: 1,
            status: "completed",
            ...stageRecord,
          },
        });
        const history = this.state.issueExecutionHistory[input.issueId];
        if (history === undefined) {
          this.state.issueExecutionHistory[input.issueId] = [stageRecord];
        } else {
          history.push(stageRecord);
        }
      } catch (error) {
        console.warn(
          `[orchestrator] failed to journal stage record for ${runningEntry.identifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Snapshot history after the (conditional) push so runtime-host can
      // read it even if advanceStage() deletes issueExecutionHistory for
      // terminal transitions.
      this.lastExitHistorySnapshot.set(input.issueId, [
        ...(this.state.issueExecutionHistory[input.issueId] ?? []),
      ]);
    }

    if (input.outcome === "normal") {
      if (input.hardStop !== undefined && input.hardStop !== null) {
        const pendingStageSignal = createPendingStageSignal(
          exitedStageName,
          input.agentMessage,
          runningEntry.retryAttempt,
        );
        const escalation = await this.tryBudgetEscalation(
          input.issueId,
          runningEntry,
          input.hardStop,
          exitedStageName,
          pendingStageSignal,
        );
        if (escalation.handled) {
          return escalation.retryEntry;
        }

        const triageResume = await this.tryPauseTriageResume(
          input.issueId,
          runningEntry,
          input.hardStop,
          exitedStageName,
          pendingStageSignal,
        );
        if (triageResume.handled) {
          return triageResume.retryEntry;
        }

        await this.handleHardStopTrigger(input.issueId, runningEntry, {
          hardStop: input.hardStop,
          stageName: exitedStageName,
          pendingStageSignal,
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

      return this.handleNormalStageExit(
        input.issueId,
        runningEntry,
        exitedStageName,
        input.agentMessage,
      );
    }

    const stopReason = parseStoppedAfterReason(input.reason);
    if (stopReason === "manual_stop" || stopReason === "inactive_state") {
      this.markIssueRequiresExplicitResume(
        input.issueId,
        runningEntry.issue.state,
      );
      return null;
    }

    if (isServiceShutdownAbortReason(input.reason)) {
      this.releaseClaim(input.issueId);
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
      // No on_complete transition — treat as terminal. No tracker write
      // fires here, so journal synthetic terminal evidence (council R2) or
      // replay would restore the counters this clear erases.
      this.journalTerminalEvidence(issueId, issueIdentifier, currentStageName);
      this.clearTerminalIssueRuntimeState(issueId);
      return "completed";
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      // Invalid target — treat as terminal (same evidence rule as above)
      this.journalTerminalEvidence(issueId, issueIdentifier, currentStageName);
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
      // Fire linearState update for the terminal stage (e.g., move to "Done").
      // Routed through runTrackerWriteOnce (council R1) so this path leaves
      // the same `tracker_write:{issue}:terminal:...` completed evidence the
      // admission-path terminal write does — replay keys terminal-completion
      // cleanup off that entry (see recoverFromRunJournal).
      if (
        nextStage.linearState !== null &&
        this.updateIssueState !== undefined
      ) {
        const linearState = nextStage.linearState;
        const updateIssueState = this.updateIssueState;
        void this.runTrackerWriteOnce(
          {
            idempotencyKey: `tracker_write:${issueId}:terminal:${nextStageName}:${linearState}`,
            issueId,
            issueIdentifier,
            stage: nextStageName,
            attempt: null,
            action: "update_issue_state",
            summary: `Move ${issueIdentifier} to terminal state ${linearState}.`,
          },
          async () => {
            await updateIssueState(issueId, issueIdentifier, linearState);
          },
        ).catch((err) => {
          console.warn(
            `[orchestrator] Failed to update terminal state for ${issueIdentifier}:`,
            err,
          );
        });
      } else {
        // No tracker write fires (linearState null or no updateIssueState
        // callback): journal synthetic terminal evidence (council R2) so
        // replay still clears the counters this completion erased live.
        this.journalTerminalEvidence(issueId, issueIdentifier, nextStageName);
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
    if (currentStageName === "review" || targetStageName === "review") {
      delete this.state.issueReviewInfrastructureStalls[issueId];
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
    options: FailureSignalHandlingOptions = { emitSideEffects: true },
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

      if (options.emitSideEffects) {
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
      }
      return null;
    }

    if (failureClass === "verify" || failureClass === "infra") {
      if (
        failureClass === "infra" &&
        options.emitSideEffects &&
        this.handleReviewSubstrateDegradation(
          issueId,
          runningEntry,
          agentMessage,
        )
      ) {
        return null;
      }
      if (failureClass === "verify") {
        delete this.state.issueReviewInfrastructureStalls[issueId];
      }
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
      delete this.state.issueReviewInfrastructureStalls[issueId];
      // Rebase failures — trigger rework if onRework configured, else retry
      return this.handleRebaseFailure(
        issueId,
        runningEntry,
        agentMessage,
        options,
      );
    }

    // failureClass === "review" — trigger rework via gate lookup
    delete this.state.issueReviewInfrastructureStalls[issueId];
    return this.handleReviewFailure(
      issueId,
      runningEntry,
      agentMessage,
      options,
    );
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
    options: FailureSignalHandlingOptions = { emitSideEffects: true },
  ): RetryEntry | null {
    // Same-criterion rework brake (SYMPH-402): rework cycles bypass the
    // retry path, so the SYMPH-396 retry-without-novelty short-circuit never
    // sees them, and the SYMPH-398 cluster needs distinct ISSUES sharing a
    // signature. Track the criterion-aware review-failure streak here and
    // park loudly instead of entering a third rework round on the same
    // failed pre-gate criterion.
    const streak = this.trackReviewFailureStreak(issueId, agentMessage);
    if (streak.count >= MAX_SAME_CRITERION_REVIEW_FAILURES) {
      this.parkRepeatedReviewFailure(issueId, runningEntry, streak, options);
      return null;
    }

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
        if (options.emitSideEffects) {
          void this.fireEscalationSideEffects(
            issueId,
            runningEntry.identifier,
            "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
          );
        }
        return null;
      }
      if (reworkTarget !== null) {
        if (options.emitSideEffects) {
          this.postReviewFindingsComment(
            issueId,
            runningEntry.identifier,
            currentStageName,
            agentMessage,
          );
        }
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
      if (options.emitSideEffects) {
        void this.fireEscalationSideEffects(
          issueId,
          runningEntry.identifier,
          "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
        );
      }
      return null;
    }

    // Rework target set by reworkGate — post findings and schedule continuation
    if (options.emitSideEffects) {
      this.postReviewFindingsComment(
        issueId,
        runningEntry.identifier,
        currentStageName,
        agentMessage,
      );
    }
    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: `agent review failure: rework to ${reworkTarget}`,
      delayType: "continuation",
    });
  }

  /**
   * Record the criterion-aware signature of a review-stage failure and
   * return the current consecutive streak (SYMPH-402). An identical
   * signature increments the streak; a different one resets it to 1.
   */
  private trackReviewFailureStreak(
    issueId: string,
    agentMessage: string | undefined,
  ): { signature: string; count: number; matchedCriteria: string[] } {
    const normalized = normalizeReviewFailureSignature(
      agentMessage ?? null,
      this.state.issueAcSnapshots[issueId] ?? null,
    );
    const previous = this.state.issueReviewFailureStreaks[issueId];
    const count =
      previous !== undefined && previous.signature === normalized.signature
        ? previous.count + 1
        : 1;
    this.state.issueReviewFailureStreaks[issueId] = {
      signature: normalized.signature,
      count,
    };
    return {
      signature: normalized.signature,
      count,
      matchedCriteria: normalized.matchedCriteria,
    };
  }

  /**
   * SYMPH-441 / SYMPH-511: a degraded council substrate is infrastructure,
   * not code rework. The review worker reports the first occurrence as
   * `[STAGE_FAILED: infra]`, which retries the same review stage. If another
   * same-family substrate degradation follows, park loudly so operators can
   * relaunch/requeue without burning another implement round.
   */
  private handleReviewSubstrateDegradation(
    issueId: string,
    runningEntry: RunningEntry,
    agentMessage: string | undefined,
  ): boolean {
    const stageName = this.state.issueStages[issueId] ?? null;
    if (!isReviewSubstrateDegradationMessage(agentMessage)) {
      const hadSubstrateDegradation =
        this.state.issueReviewInfrastructureStalls[issueId] !== undefined;
      delete this.state.issueReviewInfrastructureStalls[issueId];
      if (hadSubstrateDegradation && stageName === "review") {
        delete this.state.issueFailureSignatures[`${issueId}:review`];
      }
      return false;
    }

    if (stageName !== "review") {
      delete this.state.issueReviewInfrastructureStalls[issueId];
      return false;
    }

    const stalledLanes = extractReviewSubstrateDegradedLanes(agentMessage);
    const signatureSource =
      stalledLanes.length > 0
        ? `review_substrate_degraded:${stalledLanes.join(",")}`
        : "review_substrate_degraded:unknown-lane";
    const signature = hashReviewInfrastructureSignature(signatureSource);
    const previous = this.state.issueReviewInfrastructureStalls[issueId];
    const count = previous !== undefined ? previous.count + 1 : 1;
    this.state.issueReviewInfrastructureStalls[issueId] = {
      signature,
      count,
      stalledLanes,
    };
    delete this.state.issueFailureSignatures[`${issueId}:review`];

    if (count < MAX_REVIEW_SUBSTRATE_DEGRADATION_FAILURES) {
      return false;
    }

    this.parkReviewInfrastructureBlocked(issueId, runningEntry, {
      signature,
      count,
      stalledLanes,
      agentMessage,
    });
    return true;
  }

  private parkReviewInfrastructureBlocked(
    issueId: string,
    runningEntry: RunningEntry,
    input: {
      signature: string;
      count: number;
      stalledLanes: string[];
      agentMessage: string | undefined;
    },
  ): void {
    const stageName = this.state.issueStages[issueId] ?? null;
    const laneText =
      input.stalledLanes.length > 0
        ? input.stalledLanes.join(", ")
        : "lane set not parseable from worker message";
    const parkReason = `review gate infrastructure blocked: ${input.count} consecutive review-substrate degradation failures for ${laneText} (signature ${input.signature}); parked instead of reworking code (SYMPH-441/SYMPH-511)`;
    const reworkCount = this.state.issueReworkCounts[issueId] ?? 0;
    const stageHistory = this.state.issueExecutionHistory[issueId] ?? [];

    this.state.failed.add(issueId);
    this.releaseClaim(issueId);
    this.clearTerminalIssueRuntimeState(issueId);
    this.recordFailureInCluster(
      issueId,
      runningEntry.identifier,
      {
        signature: input.signature,
        normalizedText: parkReason,
        class: "permanent",
      },
      stageName,
    );

    void this.fireEscalationSideEffects(
      issueId,
      runningEntry.identifier,
      [
        "## Parked: review gate infrastructure blocked (SYMPH-441/SYMPH-511)",
        "",
        `The review gate reported ${input.count} consecutive review-substrate infrastructure failures. Latest stalled lane set / degraded lane set: ${laneText}.`,
        "",
        "This is not a council FAIL with code findings, and the orchestrator did not dispatch implement rework. Requeue after the council substrate is healthy or relaunch the review gate in a quiet window.",
        "",
        "Last review-stage message:",
        sanitizeForLinear(input.agentMessage ?? "(missing)", { maxLen: 2000 }),
      ].join("\n"),
    );
    void this.recordFailureExhausted(
      issueId,
      runningEntry.identifier,
      runningEntry.issue.title,
      parkReason,
      {
        failure_signature: input.signature,
        failure_class: "permanent",
      },
      {
        issueDescription: runningEntry.issue.description ?? "",
        stageName,
        parkKind: "retry_exhausted",
        attemptCount: runningEntry.retryAttempt ?? 1,
        reworkCount,
        failureRecords: [],
        stageHistory,
      },
    );
  }

  /**
   * Park an issue that keeps failing review on the SAME pre-gate criterion
   * (SYMPH-402): another implement rework round against an unchanged
   * criterion is futile — the SYMPH-332 / PR #350 loop burned a day of
   * budget against a finished, CI-green PR. Parks via the same
   * failure_exhausted machinery as the SYMPH-396 novelty short-circuit and
   * posts a loud operator-facing Linear comment.
   */
  private parkRepeatedReviewFailure(
    issueId: string,
    runningEntry: RunningEntry,
    streak: { signature: string; count: number; matchedCriteria: string[] },
    options: FailureSignalHandlingOptions = { emitSideEffects: true },
  ): void {
    const stageName = this.state.issueStages[issueId] ?? null;
    const criteriaBlock =
      streak.matchedCriteria.length > 0
        ? streak.matchedCriteria.map((c) => `- ${c}`).join("\n")
        : "- (criterion not isolatable — the review failure message repeated identically)";
    const parkReason = `review rework futile: ${streak.count} consecutive review-stage failures on the same pre-gate criterion (signature ${streak.signature}); parked instead of entering rework round ${streak.count} (SYMPH-402)`;

    this.state.failed.add(issueId);
    this.releaseClaim(issueId);
    this.clearTerminalIssueRuntimeState(issueId);
    // Record into the cluster after the terminal-state clear (same ordering
    // as the spec-failure path) so the clear cannot erase this membership.
    this.recordFailureInCluster(
      issueId,
      runningEntry.identifier,
      {
        signature: streak.signature,
        normalizedText: parkReason,
        class: "permanent",
      },
      stageName,
    );
    if (options.emitSideEffects) {
      void this.fireEscalationSideEffects(
        issueId,
        runningEntry.identifier,
        [
          "## Parked: repeated review failure on the same criterion (SYMPH-402)",
          "",
          `The review stage failed ${streak.count} consecutive rounds with the same pre-gate criterion unsatisfied:`,
          criteriaBlock,
          "",
          "The orchestrator parked this issue instead of starting another implement rework round. Likely cause: a frozen acceptance criterion that contradicts the SYMPH-358 verify contract (e.g. a bare full-suite `check:` while CI on the PR head SHA is green — CI is the contract's authority).",
          "Operator action: inspect the frozen AC snapshot and the PR's CI status; correct the criterion or the evidence, then resume with a fresh Todo → Resume transition.",
        ].join("\n"),
      );
      void this.recordFailureExhausted(
        issueId,
        runningEntry.identifier,
        runningEntry.issue.title,
        parkReason,
        {
          failure_signature: streak.signature,
          failure_class: "permanent",
        },
      );
    }
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
    options: FailureSignalHandlingOptions = { emitSideEffects: true },
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
        if (options.emitSideEffects) {
          void this.fireEscalationSideEffects(
            issueId,
            runningEntry.identifier,
            "Rebase failure: max rework attempts exceeded. Escalating for manual review.",
          );
        }
        return null;
      }
      if (reworkTarget !== null) {
        if (options.emitSideEffects) {
          this.postRebaseComment(
            issueId,
            runningEntry.identifier,
            currentStageName,
            agentMessage,
          );
        }
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
    triageContext?: WatchdogParkContext,
  ): Promise<void> {
    // Mark immediately (before any await) so runtime-host's fireWorkerNotification
    // can check this set synchronously after onWorkerExit returns.
    this.state.failureExhaustedIds.add(issueId);
    // Register the park generation synchronously too (SYMPH-399): a fenced
    // intent verb issued against this park must observe a stable nonce, and
    // the deferred triage verdict is causally tied to exactly this value.
    const parkSeq = this.recordWatchdogPark(issueId);
    const issueState = this.state.running[issueId]?.issue.state ?? null;
    const stageName =
      triageContext?.stageName ?? this.state.issueStages[issueId] ?? null;
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

    // Watchdog L2 stuck-ticket triage (SYMPH-399): fired only for the
    // watchdog park kinds (novelty short-circuit, breaker), at most once
    // per park generation, and only when the lane is enabled.
    this.maybeRunStuckTriage({
      issueId,
      issueIdentifier,
      issueTitle,
      parkReason: reason,
      parkSeq,
      failureSignature: signatureMeta?.failure_signature ?? null,
      failureClass: signatureMeta?.failure_class ?? null,
      triageContext,
    });
  }

  /**
   * Dispatch the L2 stuck-triage lane for a watchdog park (SYMPH-399),
   * park-then-revise: nothing waits on the local model; the park already
   * stands and the verdict, whenever it arrives, executes through fenced
   * writeIntent calls that can only act on this exact park generation.
   */
  private maybeRunStuckTriage(input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    parkReason: string;
    parkSeq: number;
    failureSignature: string | null;
    failureClass: string | null;
    triageContext: WatchdogParkContext | undefined;
  }): void {
    const context = input.triageContext;
    if (context === undefined) {
      return;
    }
    const parkKind = context.parkKind;
    if (parkKind !== "novelty" && parkKind !== "breaker") {
      // spec / retry_exhausted parks are not L2's input class, and a
      // retry_once_failed park must NEVER triage again (no second triage).
      return;
    }
    const runStuckTriage = this.runStuckTriage;
    if (runStuckTriage === undefined) {
      return;
    }
    if (this.config.watchdog.stuckTriage?.enabled !== true) {
      return;
    }
    // One-triage-per-park guard: a park generation triages at most once.
    if (this.triagedParkGenerations.get(input.issueId) === input.parkSeq) {
      return;
    }
    this.triagedParkGenerations.set(input.issueId, input.parkSeq);

    const evidence: StuckTriageEvidence = {
      issueIdentifier: input.issueIdentifier,
      issueTitle: input.issueTitle,
      issueDescription: context.issueDescription,
      stageName: context.stageName,
      parkKind,
      parkReason: input.parkReason,
      failureSignature: input.failureSignature,
      failureClass: input.failureClass,
      attemptCount: context.attemptCount,
      reworkCount: context.reworkCount,
      failureRecords: context.failureRecords,
      stageHistory: context.stageHistory,
    };

    const apply = (verdict: StuckTriageVerdict | null) =>
      this.applyStuckTriageVerdict({
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        issueTitle: input.issueTitle,
        stageName: context.stageName,
        parkKind,
        parkSeq: input.parkSeq,
        failureSignature: input.failureSignature,
        failureClass: input.failureClass,
        verdict,
      });

    const verdictPromise = runStuckTriage(evidence).catch((error) => {
      console.warn(
        `[orchestrator] stuck triage failed for ${input.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });

    const scheduleDeferred = this.scheduleDeferred;
    if (scheduleDeferred !== undefined) {
      void verdictPromise
        .then((verdict) => {
          scheduleDeferred(() => apply(verdict));
        })
        .catch((error) => {
          // Final rejection boundary: the park already stands either way.
          console.warn(
            `[orchestrator] stuck triage chain failed for ${input.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return;
    }

    void verdictPromise
      .then((verdict) => apply(verdict))
      .catch((error) => {
        console.warn(
          `[orchestrator] stuck triage apply failed for ${input.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * Apply an out-of-band L2 triage verdict to a park that may no longer be
   * standing (SYMPH-399). The envelope owns the bounds: low-confidence
   * verdicts park; retry_once against a non-transient failure class parks
   * (retrying an identical permanent/infra failure is futile — SYMPH-396's
   * own rule); rework without a hint parks; everything executes through fenced
   * writeIntent calls so a verdict for an earlier park is a no-op even if
   * a re-park landed moments later.
   */
  private async applyStuckTriageVerdict(input: {
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    stageName: string | null;
    parkKind: StuckTriageParkKind;
    parkSeq: number;
    failureSignature: string | null;
    failureClass: string | null;
    verdict: StuckTriageVerdict | null;
  }): Promise<void> {
    const { issueId, issueIdentifier, verdict } = input;
    const actor = this.watchdogL2Actor();

    // Envelope-enforced bounds on the model's proposed action.
    const notes: string[] = [];
    let effectiveAction:
      | "park"
      | "retry_once"
      | "rework_with_hint"
      | "escalate_human";
    if (verdict === null) {
      effectiveAction = "park";
      notes.push("triage unavailable — fail closed, park stands");
    } else {
      effectiveAction = verdict.action;
      if (verdict.confidence === "low" && effectiveAction !== "park") {
        notes.push(
          `low-confidence ${verdict.action} coerced to park (fail closed)`,
        );
        effectiveAction = "park";
      }
      if (
        effectiveAction === "retry_once" &&
        (input.failureClass === "permanent" || input.failureClass === "infra")
      ) {
        notes.push(
          "retry_once for a non-transient failure class coerced to park (identical permanent/infra failures are futile to retry — SYMPH-396)",
        );
        effectiveAction = "park";
      }
      if (
        effectiveAction === "rework_with_hint" &&
        (verdict.hint === undefined || verdict.hint.trim() === "")
      ) {
        notes.push("rework_with_hint without a hint coerced to park");
        effectiveAction = "park";
      }
    }

    const stillParked =
      this.isIssueParked(issueId) &&
      !(issueId in this.state.running) &&
      this.state.retryAttempts[issueId] === undefined &&
      this.issueParkGenerations.get(issueId) === input.parkSeq;
    const status =
      verdict === null ? "unavailable" : stillParked ? "applied" : "stale";

    // Journal the verdict together with the action the envelope actually
    // executes — the audit trail can never claim an action that did not
    // happen (pause-triage convention, PR #330 review P2).
    try {
      await this.recordRunJournalEntry({
        idempotencyKey: `triage_verdict:${issueId}:gen-${input.parkSeq}`,
        timestamp: this.now().toISOString(),
        kind: "triage_verdict",
        issueId,
        issueIdentifier,
        operation: "dispatcher",
        stage: input.stageName,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary:
          verdict === null
            ? `Stuck triage unavailable for ${issueIdentifier}; park stands.`
            : `Stuck triage verdict for ${issueIdentifier}: ${verdict.action} → ${effectiveAction} (${status}).`,
        metadata: {
          schema_version: INTENT_SCHEMA_VERSION,
          status,
          parkKind: input.parkKind,
          parkGeneration: input.parkSeq,
          classification: verdict?.classification ?? null,
          modelAction: verdict?.action ?? null,
          action: effectiveAction,
          confidence: verdict?.confidence ?? null,
          rationale: verdict?.rationale ?? null,
          ...(verdict?.hint === undefined ? {} : { hint: verdict.hint }),
          notes,
          actor: {
            kind: actor.kind,
            host: actor.host,
            session: actor.session ?? null,
          },
          ...(input.failureSignature === null
            ? {}
            : { failure_signature: input.failureSignature }),
          ...(input.failureClass === null
            ? {}
            : { failure_class: input.failureClass }),
        },
      });
    } catch {
      // Audit is best-effort; the verdict outcome must still apply.
    }

    if (!stillParked) {
      return;
    }

    // Human-visible verdict comment (pause-triage convention) with the
    // mandatory actor attribution.
    if (verdict !== null) {
      const commentLines = [
        `Stuck-ticket triage verdict: ${effectiveAction}${effectiveAction === verdict.action ? "" : ` (model proposed ${verdict.action})`} — ${formatIntentAttribution(actor)}`,
        `Classification: ${verdict.classification} | confidence: ${verdict.confidence}`,
        // Rationale is model-authored; notes are deterministic (SYMPH-421).
        sanitizeForLinear(verdict.rationale),
        ...notes.map((note) => `Note: ${note}`),
      ];
      try {
        await this.postComment?.(issueId, commentLines.join("\n"));
      } catch {
        // Observability only.
      }
    }

    const fence: IntentFence = { expectedParkSeq: input.parkSeq };
    const reasonHuman =
      verdict === null
        ? "stuck triage unavailable"
        : `stuck triage: ${verdict.classification} (${verdict.confidence}) — ${verdict.rationale}`;

    switch (effectiveAction) {
      case "park": {
        // The park already stands — record the decision as an idempotent
        // intent no_op so the journal shows L2 affirmed the park.
        await this.writeIntent({
          verb: "park",
          issueId,
          issueIdentifier,
          actor,
          reason: { class: "stuck_triage_park", human: reasonHuman },
          fence,
          renderComment: false,
        });
        return;
      }

      case "retry_once": {
        await this.writeIntent({
          verb: "retry_once",
          issueId,
          issueIdentifier,
          actor,
          reason: { class: "stuck_triage_retry_once", human: reasonHuman },
          fence,
          stage: input.stageName,
          grantSignature: input.failureSignature,
          renderComment: false,
        });
        return;
      }

      case "rework_with_hint": {
        // biome-ignore lint/style/noNonNullAssertion: effectiveAction can only be rework_with_hint when verdict is non-null with a hint (envelope coercion above)
        const hint = verdict!.hint!;
        const result = await this.writeIntent({
          verb: "rework_with_hint",
          issueId,
          issueIdentifier,
          actor,
          reason: { class: "stuck_triage_rework", human: reasonHuman },
          fence,
          stage: input.stageName,
          hint,
          renderComment: false,
        });
        if (result.status === "applied") {
          // Route the hint through the structured rework-feedback comment
          // the rework prompts already consume (Review Findings format).
          // SYMPH-378's continuous-feedback channel is strictly mid-flight
          // steering and cannot reach a parked issue.
          const reworkStage =
            this.state.issueStages[issueId] ?? input.stageName ?? "(unknown)";
          // Sanitize the hint before posting (SYMPH-399 Q3 / SYMPH-421
          // consolidation): the shared helper neutralizes fences and links
          // and redacts credentials; the tighter 4000 cap from the original
          // bespoke rule is kept. formatReviewFindingsComment applies
          // sanitizeForReworkChannel again downstream — idempotent backstop.
          const safeHint = sanitizeForLinear(hint, { maxLen: 4000 });
          this.postReviewFindingsComment(
            issueId,
            issueIdentifier,
            reworkStage,
            [
              `Watchdog triage hint (${formatIntentAttribution(actor)}):`,
              "",
              safeHint,
            ].join("\n"),
          );
        } else {
          try {
            await this.postComment?.(
              issueId,
              `Stuck-ticket triage: rework_with_hint not executable (${result.detail}); park stands — ${formatIntentAttribution(actor)}`,
            );
          } catch {
            // Observability only.
          }
        }
        return;
      }

      case "escalate_human": {
        await this.writeIntent({
          verb: "escalate_human",
          issueId,
          issueIdentifier,
          actor,
          reason: { class: "stuck_triage_escalate", human: reasonHuman },
          fence,
          renderComment: false,
        });
        // Page through the SYMPH-397 notifier with the model's case.
        try {
          this.onTriageEscalation?.({
            issueId,
            issueIdentifier,
            issueTitle: input.issueTitle,
            stageName: input.stageName,
            // biome-ignore lint/style/noNonNullAssertion: escalate_human only survives coercion when verdict is non-null
            classification: verdict!.classification,
            // biome-ignore lint/style/noNonNullAssertion: see above
            confidence: verdict!.confidence,
            // biome-ignore lint/style/noNonNullAssertion: see above
            caseText: verdict!.rationale,
          });
        } catch {
          // Notification failures are always swallowed
        }
        return;
      }
    }
  }

  /**
   * Capture the evidence the L2 triage lane needs BEFORE
   * clearTerminalIssueRuntimeState erases it (SYMPH-399).
   */
  private captureWatchdogParkContext(
    issueId: string,
    parkKind: WatchdogParkContext["parkKind"],
    stageName: string | null,
    rawError: string | null,
    attemptCount: number | null,
  ): WatchdogParkContext {
    const running = this.state.running[issueId];
    const incoming =
      rawError === null ? null : normalizeErrorSignature(rawError);
    return {
      parkKind,
      stageName,
      issueDescription: running?.issue.description ?? null,
      attemptCount,
      reworkCount: this.state.issueReworkCounts[issueId] ?? 0,
      stageHistory: (this.state.issueExecutionHistory[issueId] ?? []).map(
        (record) => ({
          stageName: record.stageName,
          outcome: record.outcome,
          turns: record.turns,
        }),
      ),
      failureRecords:
        rawError === null || incoming === null
          ? []
          : [
              {
                raw: rawError,
                signature: incoming.signature,
                failureClass: incoming.class,
              },
            ],
    };
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
        // Choke point for every escalation/park comment: bodies can embed
        // worker/runtime-authored reasons (e.g. Codex operator-input
        // requests, hard-stop reasons), so the whole body is sanitized
        // here. Deterministic caller strings pass through unchanged
        // (sanitizeForLinear is identity on clean text). SYMPH-421.
        await this.postComment(issueId, sanitizeForLinear(comment));
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
      let terminal = false;
      let terminalReason: string | null = null;
      let consecutiveGateErrors: number | null = null;
      let gateErrorPark: { count: number; comment: string } | null = null;

      if (result.aggregate === "pass") {
        const nextStage = this.approveGate(issue.id);
        if (nextStage !== null) {
          this.scheduleRetry(issue.id, 1, {
            identifier: issue.identifier,
            error: null,
            delayType: "continuation",
          });
        }
      } else if (result.aggregate === "error") {
        consecutiveGateErrors =
          this.countConsecutiveReviewGateErrors(issue.id, stageName) + 1;
        if (consecutiveGateErrors >= MAX_REVIEW_GATE_ERROR_FAILURES) {
          terminal = true;
          terminalReason = "review_gate_error_cap";
          gateErrorPark = {
            count: consecutiveGateErrors,
            comment: result.comment,
          };
        } else {
          // Gate infrastructure errors are bounded by the consecutive
          // aggregate-error cap below. Use a continuation retry so the
          // generic worker-failure retry ladder does not spend implement
          // retry budget before the gate-specific cap decides whether to park.
          this.scheduleRetry(issue.id, nextRetryAttempt(attempt), {
            identifier: issue.identifier,
            error: `Ensemble review infrastructure error: ${result.comment.slice(0, 200)}`,
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
        const outcomeVerb =
          result.aggregate === "pass"
            ? "passed"
            : result.aggregate === "error"
              ? "errored"
              : "failed";
        this.recordDecorrelatedGateOutcome({
          issue,
          stageName,
          gateContext,
          status: result.aggregate === "pass" ? "passed" : "failed",
          aggregate: result.aggregate,
          reworkTarget: reworkTarget === "escalated" ? null : reworkTarget,
          summary: `Decorrelated gate ${stageName ?? "unnamed"} ${outcomeVerb} for ${issue.identifier}.`,
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
            result.aggregate === "error" ||
            terminal ||
            reworkTarget === "escalated"
              ? reworkCountBeforeGate
              : (this.state.issueReworkCounts[issue.id] ?? null),
          consecutiveGateErrors,
          terminal: terminal || reworkTarget === "escalated",
          terminalReason:
            terminalReason ??
            (reworkTarget === "escalated" ? "max_rework_exceeded" : null),
        },
      });
      if (gateErrorPark !== null) {
        this.parkRepeatedReviewGateError(issue, stageName, gateErrorPark);
      }
      // Fire gate failure notification after the lease is durably completed so
      // the alert reflects a fully-journalled outcome (ordering hardening).
      if (result.aggregate === "fail" || terminal) {
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

  private countConsecutiveReviewGateErrors(
    issueId: string,
    stageName: string | null,
  ): number {
    let count = 0;
    for (let i = this.state.dispatcherRunJournal.length - 1; i >= 0; i -= 1) {
      const entry = this.state.dispatcherRunJournal[i];
      if (
        entry === undefined ||
        entry.issueId !== issueId ||
        entry.stage !== stageName
      ) {
        continue;
      }

      if (entry.kind === "gate_started") {
        continue;
      }
      // Completed gate results are the only durable verdict boundary. Other
      // same-issue/stage entries break the streak because replay cannot prove
      // they belong to the same uninterrupted gate-error sequence.
      if (
        entry.kind !== "gate_result" ||
        entry.operation !== "gate" ||
        entry.lease?.status !== "completed"
      ) {
        return count;
      }

      if (entry.metadata.aggregate === "error") {
        count += 1;
        continue;
      }
      return count;
    }
    return count;
  }

  private parkRepeatedReviewGateError(
    issue: Issue,
    stageName: string | null,
    input: {
      count: number;
      comment: string;
    },
  ): void {
    const signature = hashReviewInfrastructureSignature(
      `review_gate_error:${stageName ?? "unnamed"}`,
    );
    const reworkCount = this.state.issueReworkCounts[issue.id] ?? 0;
    const stageHistory = this.state.issueExecutionHistory[issue.id] ?? [];
    const parkReason = `review gate infrastructure blocked: ${input.count} consecutive all-reviewer error aggregates (signature ${signature}); parked instead of reworking code (SYMPH-366)`;

    this.state.failed.add(issue.id);
    this.releaseClaim(issue.id);
    this.clearTerminalIssueRuntimeState(issue.id);
    this.recordFailureInCluster(
      issue.id,
      issue.identifier,
      {
        signature,
        normalizedText: parkReason,
        class: "transient",
      },
      stageName,
    );

    void this.fireEscalationSideEffects(
      issue.id,
      issue.identifier,
      [
        "## Parked: review gate infrastructure blocked (SYMPH-366)",
        "",
        `The ensemble review gate produced ${input.count} consecutive all-reviewer error aggregates.`,
        "",
        "This is not a council FAIL with code findings, and the orchestrator did not dispatch implement rework. Requeue after reviewer infrastructure is healthy.",
        "",
        "Last gate comment:",
        sanitizeForLinear(input.comment, { maxLen: 2000 }),
      ].join("\n"),
    ).catch((err) => {
      console.warn(
        "[orchestrator] Failed to post review gate error park side effects",
        issue.identifier,
        err,
      );
    });
    void this.recordFailureExhausted(
      issue.id,
      issue.identifier,
      issue.title,
      parkReason,
      {
        failure_signature: signature,
        failure_class: "transient",
      },
      {
        issueDescription: issue.description ?? "",
        stageName,
        parkKind: "retry_exhausted",
        attemptCount: input.count,
        reworkCount,
        failureRecords: [],
        stageHistory,
      },
    ).catch((err) => {
      console.warn(
        "[orchestrator] Failed to record review gate error park",
        issue.identifier,
        err,
      );
    });
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
    aggregate: "pass" | "fail" | "error" | null;
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

  /**
   * Journal replay-visible terminal-completion evidence for completion
   * paths that fire NO tracker write (council R2): a terminal stage whose
   * linearState is null, a missing updateIssueState callback, or an
   * onComplete transition that is null/invalid. Reuses the tracker_write
   * journal kind with the same `:terminal:` / `:completed` key shape the
   * runTrackerWriteOnce paths produce, so recoverFromRunJournal keeps a
   * single terminal-evidence predicate; metadata marks that no tracker
   * call happened. Consumer contract (council R3): a `:terminal:` +
   * `:completed` tracker_write entry — real or synthetic — means only
   * "this issue reached terminal completion"; it is NOT proof a tracker
   * API call occurred. Consumers needing the latter must check
   * metadata.skipped !== true. Best-effort: a journal outage must never block live
   * terminal completion — counters surviving replay after a failed write
   * is the documented degraded mode.
   */
  private journalTerminalEvidence(
    issueId: string,
    issueIdentifier: string,
    stage: string | null,
  ): void {
    void this.recordRunJournalEntry({
      idempotencyKey: `tracker_write:${issueId}:terminal:${stage ?? "none"}:none:completed`,
      timestamp: this.now().toISOString(),
      kind: "tracker_write",
      issueId,
      issueIdentifier,
      operation: "tracker_write",
      stage,
      attempt: null,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Terminal completion for ${issueIdentifier} (no tracker write).`,
      metadata: {
        status: "completed",
        action: "update_issue_state",
        skipped: true,
      },
    }).catch((err) => {
      console.warn(
        `[orchestrator] Failed to journal terminal evidence for ${issueIdentifier}:`,
        err,
      );
    });
  }

  private clearTerminalIssueRuntimeState(
    issueId: string,
    anchorCursorAtMs = this.now().getTime(),
  ): void {
    delete this.state.issueStages[issueId];
    delete this.state.issuePendingStageSignals[issueId];
    delete this.state.issueReworkCounts[issueId];
    delete this.state.issuePassedStages[issueId];
    delete this.state.issueExecutionHistory[issueId];
    delete this.state.issueFirstDispatchedAt[issueId];
    delete this.state.issueRightSizingDecisions[issueId];
    delete this.state.issueBudgetEscalations[issueId];
    delete this.state.issuePauseTriageResumes[issueId];
    delete this.state.issueAcSnapshots[issueId];
    delete this.state.issueReviewFailureStreaks[issueId];
    delete this.state.issueReviewInfrastructureStalls[issueId];
    delete this.state.loopTraceJournal[issueId];
    this.replayedDispatchedIssueIds.delete(issueId);
    delete this.state.continuousFeedback[issueId];
    if (this.state.issueAnchors[issueId] !== undefined) {
      this.recordAnchorCursor(issueId, anchorCursorAtMs);
    }
    delete this.state.issueAnchors[issueId];
    // Clear the exhaustion-dedup marker so a resumed issue can fire the alert
    // again if it exhausts retries in a new lifecycle (SYMPH-397).
    this.state.failureExhaustedIds.delete(issueId);
    // Coupled surfaces (council P3): a terminally-cleared issue cannot be
    // awaiting an explicit resume, so the resumeRequired set, its mark, and
    // its guard die with the counters (clearResumeRequirement keeps the
    // three atomic — never a marked-set entry without a mark record). Park
    // paths that call this method re-mark AFTERWARDS, same ordering as the
    // park-generation note below.
    this.clearResumeRequirement(issueId);
    // SYMPH-399 lifecycle: intent fence generation, one-triage-per-park
    // marker, and any unconsumed retry_once grant all die with the issue's
    // runtime state. Park paths that call this method re-set the generation
    // AFTER the clear (recordWatchdogPark runs later in those paths), so the
    // ordering here is deliberate — mirror of the cluster-membership note
    // below.
    this.issueParkGenerations.delete(issueId);
    this.triagedParkGenerations.delete(issueId);
    this.retryOnceGrants.delete(issueId);
    this.escalatedParkGenerations.delete(issueId);
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
    this.commitRunJournalEntrySync({
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
    mark?: {
      reason: string;
      setBySequence: number | null;
      parkGeneration?: number | null;
    },
  ): void {
    this.recordIssueRequiresExplicitResume(issueId, issueState, pausedAt, mark);
    this.releaseClaim(issueId);
  }

  private recordIssueRequiresExplicitResume(
    issueId: string,
    issueState?: string | null,
    pausedAt?: string | null,
    mark?: {
      reason: string;
      setBySequence: number | null;
      parkGeneration?: number | null;
    },
  ): void {
    const wasParked = this.isIssueParked(issueId);
    this.state.resumeRequired.add(issueId);
    // Persistable mark surface (SYMPH-406): reason + the journal cursor that
    // set the mark. A re-mark without fresh attribution (e.g. the worker-exit
    // path re-asserting a park requestStop already recorded) preserves the
    // existing reason/cursor instead of erasing it.
    const existingMark = this.state.resumeRequiredMarks[issueId];
    this.state.resumeRequiredMarks[issueId] = {
      reason: mark?.reason ?? existingMark?.reason ?? "stop_like_pause",
      setBySequence: mark?.setBySequence ?? existingMark?.setBySequence ?? null,
      since: pausedAt ?? existingMark?.since ?? this.now().toISOString(),
    };
    const pausedState =
      issueState === undefined || issueState === null
        ? null
        : normalizeIssueState(issueState);
    const existingGuard = this.resumeRequiredGuards.get(issueId);
    const parkGeneration =
      mark?.parkGeneration ??
      (wasParked ? (this.issueParkGenerations.get(issueId) ?? null) : null);
    const nextParkGeneration = parkGeneration ?? this.parkSequence + 1;
    this.parkSequence = Math.max(this.parkSequence, nextParkGeneration);
    this.resumeRequiredGuards.set(issueId, {
      pausedState: pausedState === "" ? null : pausedState,
      observedNonResumeState:
        existingGuard?.observedNonResumeState === true ||
        pausedState !== EXPLICIT_RESUME_STATE,
      pausedAt: pausedAt ?? this.now().toISOString(),
      parkSeq: nextParkGeneration,
      ...(existingGuard?.requiresConfirmedEmergencyStop === undefined
        ? {}
        : {
            requiresConfirmedEmergencyStop:
              existingGuard.requiresConfirmedEmergencyStop,
          }),
    });
    // Intent-fence generation (SYMPH-399): stop-like pauses and watchdog
    // parks share one monotonic counter so a fenced verb can never act on
    // a park other than the one it was issued against.
    this.issueParkGenerations.set(issueId, nextParkGeneration);
  }

  private nextParkGenerationForJournalKey(issueId: string): number {
    return this.isIssueParked(issueId)
      ? (this.issueParkGenerations.get(issueId) ?? this.parkSequence + 1)
      : this.parkSequence + 1;
  }

  private clearResumeRequirement(issueId: string): void {
    this.state.resumeRequired.delete(issueId);
    delete this.state.resumeRequiredMarks[issueId];
    this.resumeRequiredGuards.delete(issueId);
  }

  private clearResumedIssueLifecycleState(issueId: string): void {
    this.state.completed.delete(issueId);
    this.state.failed.delete(issueId);
    // Resume starts a fresh failure lifecycle, not a queue-anchor lifecycle.
    // Anchors clear only by unanchor, terminal consumption, or declared expiry.
    // A resumed issue starts a fresh park/failure lifecycle. Keep the reset set
    // shared across poll admission and retry admission so fences, breakers, and
    // alert dedupe do not drift between the two dispatch paths.
    this.state.failureExhaustedIds.delete(issueId);
    this.signatureClusterRegistry.clearIssueFromCluster(issueId);
    this.resetBreakersForResumedIssue(issueId);
    this.issueParkGenerations.delete(issueId);
    this.triagedParkGenerations.delete(issueId);
    this.retryOnceGrants.delete(issueId);
    this.escalatedParkGenerations.delete(issueId);
    this.clearResumeRequirement(issueId);
  }

  private journalEntryTimestampMs(entry: DispatcherRunJournalEntry): number {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : this.now().getTime();
  }

  // -------------------------------------------------------------------------
  // Shared intent-verb layer (SYMPH-399 / SYMPH-408 carve-out "408a")
  // -------------------------------------------------------------------------

  /** First hostname label, mirroring the SYMPH-383 owner-host convention. */
  private intentHost(): string {
    const label = hostname().split(".")[0];
    return label === undefined || label === "" ? hostname() : label;
  }

  /** Actor identity for watchdog L2 (stuck-triage) intent writes. */
  private watchdogL2Actor(): IntentActor {
    // Omit session (leaseOwnerId) — the UUID is operationally meaningless
    // in attribution comments and adds noise without information (B-7).
    return {
      kind: "watchdog-l2",
      host: this.intentHost(),
    };
  }

  /**
   * Register a watchdog park (failure-exhausted family) in the intent-fence
   * generation map. Stop-like pauses get their generation through
   * recordIssueRequiresExplicitResume; this covers the failed-set parks
   * which never set resumeRequired live.
   */
  private recordWatchdogPark(issueId: string): number {
    this.parkSequence += 1;
    this.issueParkGenerations.set(issueId, this.parkSequence);
    return this.parkSequence;
  }

  private isIssueParked(issueId: string): boolean {
    return (
      this.state.resumeRequired.has(issueId) || this.state.failed.has(issueId)
    );
  }

  /**
   * Reducer for releasing a parked issue (the resume blocks in
   * isDispatchEligible apply the same set of clears). Cluster membership and
   * breakers reset together with the park or the resume deadlocks
   * (SYMPH-398).
   */
  private releaseParkedIssueState(issueId: string): void {
    this.clearResumeRequirement(issueId);
    this.state.failed.delete(issueId);
    this.state.failureExhaustedIds.delete(issueId);
    this.signatureClusterRegistry.clearIssueFromCluster(issueId);
    this.resetBreakersForResumedIssue(issueId);
    this.issueParkGenerations.delete(issueId);
    this.triagedParkGenerations.delete(issueId);
    this.retryOnceGrants.delete(issueId);
    this.escalatedParkGenerations.delete(issueId);
  }

  /**
   * Re-establish park state after an intent verb released the park but the
   * action could not proceed and the issue must stay parked (council R2).
   * releaseParkedIssueState dropped the park generation and the
   * failureExhaustedIds marker; without a fresh generation the re-park is
   * fence-dead — no future fenced intent can ever match, and stale-fence
   * protection is silently disabled for the issue. Mints a NEW generation
   * (same bump recordWatchdogPark performs) and restores the exhausted
   * marker for alert dedup.
   *
   * Deliberately does NOT re-register the issue in the signature cluster:
   * no NEW failure occurred on these paths — the budget/precondition check
   * merely refused the action. Re-park paths where a real failure fired
   * (e.g. retry_once_failed) record into the cluster themselves.
   */
  private reestablishParkAfterRelease(issueId: string): void {
    this.state.failureExhaustedIds.add(issueId);
    this.recordWatchdogPark(issueId);
  }

  /**
   * The shared intent-verb write primitive (SYMPH-399, carved out of
   * SYMPH-408). One journal-write path for operator, agents, and watchdog
   * L2 — never independent mutation paths. Semantics:
   *
   * - Idempotent: a verb that would not change state records a `no_op`;
   *   duplicate identical writes dedupe on the journal idempotency key.
   * - Fenced: `fence.expectedParkSeq` must match the issue's current park
   *   generation (the park-then-revise nonce pattern) or the write is
   *   `rejected_stale` and mutates nothing.
   * - Attributed: the actor is journaled AND rendered into the
   *   human-visible Linear comment ("by {kind}@{host}").
   * - Replay-convergent: applied intent events replay through
   *   recoverFromRunJournal, so park followed by release converges on
   *   released (SYMPH-368 regression).
   */
  async writeIntent(input: IntentWriteInput): Promise<IntentWriteOutput> {
    if (input.verb === "anchor" || input.verb === "unanchor") {
      return this.withAnchorMutationLock(input.issueId, () =>
        this.writeIntentUnlocked(input),
      );
    }
    return this.writeIntentUnlocked(input);
  }

  private async writeIntentUnlocked(
    input: IntentWriteInput,
  ): Promise<IntentWriteOutput> {
    const currentGen = this.issueParkGenerations.get(input.issueId) ?? null;

    // Idempotency-key format (SYMPH-422; keys are opaque equality tokens,
    // never parsed — schema_version is unaffected):
    //   applied:        intent:{verb}:{issueId}:{kind}@{host}[#{session}]:gen-{N}
    //   no_op:          intent:{verb}:{issueId}:{kind}@{host}[#{session}]:gen-{N}:no_op
    //   rejected_stale: intent:{verb}:{issueId}:{kind}@{host}[#{session}]:fence-{E}-vs-{N}
    // The actor discriminator keeps distinct actors' same-verb-same-generation
    // intents as separate journal entries (attribution + rationale survive)
    // while the same actor+session re-issuing identical writes still dedupes.
    const actorKey = formatIntentActorKey(input.actor);

    if (
      input.fence !== undefined &&
      input.fence.expectedParkSeq !== currentGen
    ) {
      const detail = `stale fence: expected park generation ${input.fence.expectedParkSeq}, current ${currentGen ?? "none"}`;
      const sequence = await this.recordIntentJournalEntry({
        input,
        status: "rejected_stale",
        detail,
        generation: currentGen,
        idempotencyKey: `intent:${input.verb}:${input.issueId}:${actorKey}:fence-${input.fence.expectedParkSeq}-vs-${currentGen ?? "none"}`,
      });
      return { status: "rejected_stale", detail, sequence };
    }

    const idempotencyContext = this.intentIdempotencyContext(input, currentGen);
    const application = await this.applyIntentVerb(input, currentGen);
    const generationAfter =
      this.issueParkGenerations.get(input.issueId) ?? currentGen;
    const appliedIdempotencyContext =
      input.verb === "anchor" || input.verb === "unanchor"
        ? idempotencyContext
        : `gen-${generationAfter ?? "none"}`;
    const journalTimestamp = this.now().toISOString();
    const sequence = await this.recordIntentJournalEntry({
      input,
      status: application.status,
      detail: application.detail,
      generation: generationAfter,
      timestamp: journalTimestamp,
      idempotencyKey:
        application.status === "no_op"
          ? `intent:${input.verb}:${input.issueId}:${actorKey}:${idempotencyContext}:no_op`
          : `intent:${input.verb}:${input.issueId}:${actorKey}:${appliedIdempotencyContext}`,
      ...(application.journalMetadata === undefined
        ? {}
        : { journalMetadata: application.journalMetadata }),
    });

    // Stamp the persistable mark with the intent entry's cursor (SYMPH-406):
    // park/halt set the mark inside applyIntentVerb before the journal write
    // existed, so the sequence is patched in here — matching what replay
    // reduces from the same entry.
    if (
      application.status === "applied" &&
      (input.verb === "park" || input.verb === "halt") &&
      sequence !== null
    ) {
      const standingMark = this.state.resumeRequiredMarks[input.issueId];
      if (standingMark !== undefined) {
        this.state.resumeRequiredMarks[input.issueId] = {
          ...standingMark,
          reason: `intent:${input.verb}:${input.reason.class}`,
          setBySequence: sequence,
        };
      }
    }

    if (application.status === "applied" && input.verb === "anchor") {
      const standingAnchor = this.state.issueAnchors[input.issueId];
      if (standingAnchor !== undefined && sequence !== null) {
        this.state.issueAnchors[input.issueId] = {
          ...standingAnchor,
          setBySequence: sequence,
        };
      }
      this.recordAnchorCursor(
        input.issueId,
        this.anchorCursorTimestampForIntent(input, journalTimestamp),
        sequence ?? undefined,
      );
    }

    if (application.status === "applied" && input.verb === "unanchor") {
      this.recordAnchorCursor(
        input.issueId,
        this.anchorCursorTimestampForIntent(input, journalTimestamp),
        sequence ?? undefined,
      );
    }

    if (application.status === "applied" && input.renderComment !== false) {
      try {
        await this.postComment?.(
          input.issueId,
          [
            `Intent applied: ${input.verb} — ${formatIntentAttribution(input.actor)}`,
            // reason.human can embed model rationale (stuck-triage verbs).
            // The journal keeps the raw text for audit; only this rendered
            // egress is sanitized, with the field-level cap pattern from
            // SYMPH-421 so deterministic text around it can't be truncated.
            `Reason: ${sanitizeForLinear(input.reason.human, { maxLen: 1500 })}`,
          ].join("\n"),
        );
      } catch {
        // Attribution comment is best-effort; the intent already applied.
      }
    }

    return {
      status: application.status,
      detail: application.detail,
      sequence,
      ...(application.stopRequest !== undefined
        ? { stopRequest: application.stopRequest }
        : {}),
      ...(application.retryEntry !== undefined
        ? { retryEntry: application.retryEntry }
        : {}),
    };
  }

  async ingestAnchorFieldEdit(input: {
    issueId: string;
    issueIdentifier: string;
    fieldName: string;
    value: string | null;
    editorEmail: string;
    editedAt: string;
  }): Promise<{
    status: "applied" | "no_op" | "rejected_stale" | "ignored" | "invalid";
    detail: string;
    sequence: number | null;
  }> {
    return this.withAnchorMutationLock(input.issueId, () =>
      this.ingestAnchorFieldEditLocked(input),
    );
  }

  private async withAnchorMutationLock<T>(
    issueId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.anchorMutationLocks.get(issueId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.anchorMutationLocks.set(issueId, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.anchorMutationLocks.get(issueId) === tail) {
        this.anchorMutationLocks.delete(issueId);
      }
    }
  }

  private async ingestAnchorFieldEditLocked(input: {
    issueId: string;
    issueIdentifier: string;
    fieldName: string;
    value: string | null;
    editorEmail: string;
    editedAt: string;
  }): Promise<{
    status: "applied" | "no_op" | "rejected_stale" | "ignored" | "invalid";
    detail: string;
    sequence: number | null;
  }> {
    const config = this.config.operatorAnchors ?? {
      operatorAllowlist: [],
      serviceAccounts: [],
      fieldName: null,
    };
    const editorEmail = normalizeAccountEmail(input.editorEmail);
    const configuredFieldName = config.fieldName;
    if (configuredFieldName === null) {
      return {
        status: "ignored",
        detail: "anchor field ingestion is not configured",
        sequence: null,
      };
    }
    if (
      normalizeAnchorFieldName(input.fieldName) !==
      normalizeAnchorFieldName(configuredFieldName)
    ) {
      return {
        status: "ignored",
        detail: `field "${input.fieldName}" is not configured for anchor ingestion`,
        sequence: null,
      };
    }
    if (config.serviceAccounts.includes(editorEmail)) {
      return {
        status: "ignored",
        detail: "service-account field edit is advisory only",
        sequence: null,
      };
    }
    if (!config.operatorAllowlist.includes(editorEmail)) {
      return {
        status: "ignored",
        detail: "editor is not allowlisted for operator anchors",
        sequence: null,
      };
    }

    const editedAtMs = Date.parse(input.editedAt);
    if (!Number.isFinite(editedAtMs)) {
      return {
        status: "invalid",
        detail: "anchor field edit must include a valid editedAt timestamp",
        sequence: null,
      };
    }
    this.getActiveIssueAnchor(input.issueId);
    const cursor = this.issueAnchorCursors.get(input.issueId);
    if (cursor !== undefined && editedAtMs <= cursor.atMs) {
      return {
        status: "rejected_stale",
        detail: `stale field edit at ${input.editedAt}; current anchor cursor is ${new Date(cursor.atMs).toISOString()}`,
        sequence: null,
      };
    }

    const actor: IntentActor = {
      kind: "operator",
      host: editorEmail,
      session: "linear-field-edit",
    };
    const parsed = parseAnchorFieldEditValue(input.value);
    if (parsed === null) {
      const detail =
        "anchor field value must be empty/unanchor, top until-merged, above <issue> until-merged, below <issue> until-merged, or use until <full ISO-8601 timestamp with timezone>";
      const sequence = await this.recordInvalidAnchorFieldEdit({
        input,
        actor,
        editorEmail,
        editedAtMs,
        detail,
      });
      return {
        status: "invalid",
        detail,
        sequence,
      };
    }

    if (parsed === "unanchor") {
      const result = await this.writeIntentUnlocked({
        verb: "unanchor",
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        actor,
        reason: {
          class: "linear_field_edit_unanchor",
          human: `Linear field "${input.fieldName}" cleared by ${editorEmail}`,
        },
        extraMetadata: { anchorEditedAt: input.editedAt },
      });
      this.recordAnchorCursorForNoOpFieldEdit(
        input.issueId,
        editedAtMs,
        result,
      );
      return {
        status: result.status,
        detail: result.detail,
        sequence: result.sequence,
      };
    }

    const placementValidation = validateAnchorPlacementForIssue(
      parsed.placement,
      input.issueIdentifier,
    );
    if (!placementValidation.valid) {
      const detail = formatInvalidAnchorPlacementDetail(
        placementValidation.placement,
        input.issueIdentifier,
        placementValidation.reason,
      );
      const sequence = await this.recordInvalidAnchorFieldEdit({
        input,
        actor,
        editorEmail,
        editedAtMs,
        detail,
      });
      return {
        status: "invalid",
        detail,
        sequence,
      };
    }

    const result = await this.writeIntentUnlocked({
      verb: "anchor",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      actor,
      reason: {
        class: "linear_field_edit_anchor",
        human: `Linear field "${input.fieldName}" set by ${editorEmail}`,
      },
      anchor: {
        ...parsed,
        source: "linear_field_edit",
        fieldName: input.fieldName,
        editorEmail,
      },
      extraMetadata: { anchorEditedAt: input.editedAt },
    });
    this.recordAnchorCursorForNoOpFieldEdit(input.issueId, editedAtMs, result);
    return {
      status: result.status,
      detail: result.detail,
      sequence: result.sequence,
    };
  }

  private async applyIntentVerb(
    input: {
      verb: IntentVerb;
      issueId: string;
      issueIdentifier: string;
      actor: IntentActor;
      reason: IntentReason;
      stage?: string | null;
      anchor?: AnchorIntentPayload;
      issueState?: string | null;
      grantSignature?: string | null;
    },
    currentGen: number | null,
  ): Promise<{
    status: "applied" | "no_op";
    detail: string;
    stopRequest?: StopRequest | null;
    /** The continuation scheduled by `resume` (mirrors halt's stopRequest). */
    retryEntry?: RetryEntry | null;
    /**
     * Resolved values the replay reducer needs verbatim (e.g. the rework
     * target and post-increment count), journaled alongside the intent so
     * replay never re-derives them from a config that may have drifted.
     */
    journalMetadata?: Record<string, unknown>;
  }> {
    const { issueId } = input;

    switch (input.verb) {
      case "anchor": {
        if (input.anchor === undefined) {
          return {
            status: "no_op",
            detail: "missing anchor placement and expiry",
          };
        }
        const placementValidation = validateAnchorPlacementForIssue(
          input.anchor.placement,
          input.issueIdentifier,
        );
        if (!placementValidation.valid) {
          return {
            status: "no_op",
            detail: formatInvalidAnchorPlacementDetail(
              placementValidation.placement,
              input.issueIdentifier,
              placementValidation.reason,
            ),
          };
        }
        const active = this.getActiveIssueAnchor(issueId);
        if (
          active !== null &&
          anchorPayloadMatchesRecord(input.anchor, active)
        ) {
          return { status: "no_op", detail: "anchor already active" };
        }
        this.state.issueAnchors[issueId] = {
          issueId,
          issueIdentifier: input.issueIdentifier,
          placement: input.anchor.placement,
          expiry: input.anchor.expiry,
          actor: {
            kind: input.actor.kind,
            host: input.actor.host,
            session: input.actor.session ?? null,
          },
          reason: { class: input.reason.class, human: input.reason.human },
          source: input.anchor.source,
          fieldName: input.anchor.fieldName ?? null,
          editorEmail: input.anchor.editorEmail ?? null,
          setAt: this.now().toISOString(),
          setBySequence: null,
        };
        return {
          status: "applied",
          detail: `anchored ${formatAnchorPlacement(input.anchor.placement)} ${formatAnchorExpiry(input.anchor.expiry)}`,
        };
      }

      case "unanchor": {
        const active = this.getActiveIssueAnchor(issueId);
        if (active === null) {
          return { status: "no_op", detail: "not anchored" };
        }
        delete this.state.issueAnchors[issueId];
        return { status: "applied", detail: "unanchored" };
      }

      case "park": {
        if (this.isIssueParked(issueId)) {
          return { status: "no_op", detail: "already parked" };
        }
        this.markIssueRequiresExplicitResume(issueId, input.issueState ?? null);
        return {
          status: "applied",
          detail: "parked; explicit resume required",
        };
      }

      case "release": {
        if (!this.isIssueParked(issueId)) {
          return { status: "no_op", detail: "not parked" };
        }
        this.releaseParkedIssueState(issueId);
        return { status: "applied", detail: "released" };
      }

      case "retry_once": {
        if (!this.isIssueParked(issueId)) {
          return { status: "no_op", detail: "not parked" };
        }
        this.releaseParkedIssueState(issueId);
        this.retryOnceGrants.set(issueId, {
          signature: input.grantSignature ?? null,
        });
        const stage = input.stage ?? null;
        if (stage !== null) {
          this.state.issueStages[issueId] = stage;
          this.clearStageFailureSignature(issueId, stage);
        }
        this.scheduleRetry(issueId, 1, {
          identifier: input.issueIdentifier,
          error: null,
          delayType: "continuation",
        });
        return {
          status: "applied",
          detail: `released for exactly one retry${stage === null ? "" : ` of stage "${stage}"`}`,
        };
      }

      case "rework_with_hint": {
        if (!this.isIssueParked(issueId)) {
          return { status: "no_op", detail: "not parked" };
        }
        const stage = input.stage ?? null;
        if (stage === null) {
          // Fail closed: no stage context means the park stands.
          return {
            status: "no_op",
            detail: "no stage context for rework_with_hint — park stands",
          };
        }
        // Pre-check: reworkGate() requires a valid onRework target. Verify the
        // path exists before releasing the park so a no-path result leaves the
        // issue cleanly parked with no state mutation.
        const stageDefinition = this.config.stages?.stages[stage];
        const reworkPath = stageDefinition?.transitions.onRework ?? null;
        if (reworkPath === null) {
          return {
            status: "no_op",
            detail: `no on_rework target for stage "${stage}" — park stands`,
          };
        }
        // Delegate to reworkGate() so the maxRework ceiling check, passedStages
        // splice, and count increment are performed by the same audited path
        // that all other rework calls use. This prevents an intent-path
        // rework_with_hint from bypassing a maxRework: 0 guard (SYMPH-399 P2).
        this.releaseParkedIssueState(issueId);
        // Set the parked stage so reworkGate() reads the correct current stage.
        this.state.issueStages[issueId] = stage;
        const reworkTarget = this.reworkGate(issueId);
        if (reworkTarget === "escalated") {
          // reworkGate already set failed and cleared terminal state; the
          // issue stays parked (failed). Journal as no_op so callers can
          // distinguish "budget exhausted" from a clean rework application.
          this.reestablishParkAfterRelease(issueId);
          return {
            status: "no_op",
            detail: `rework budget exhausted for stage "${stage}" — park stands`,
          };
        }
        if (reworkTarget === null) {
          // Should not happen given the pre-check above, but fail closed.
          this.state.failed.add(issueId);
          this.reestablishParkAfterRelease(issueId);
          return {
            status: "no_op",
            detail: `no on_rework target for stage "${stage}" — park stands`,
          };
        }
        // reworkGate set issueStages[issueId] = reworkTarget and incremented count.
        this.scheduleRetry(issueId, 1, {
          identifier: input.issueIdentifier,
          error: null,
          delayType: "continuation",
        });
        return {
          status: "applied",
          detail: `released for rework to stage "${reworkTarget}"`,
          // Journal the RESOLVED target and post-increment count so replay
          // restores them verbatim — a config edit between write and replay
          // must not change where the issue lands or grant an extra rework
          // beyond maxRework (council R2: codex #2 / pi #3).
          journalMetadata: {
            reworkTarget,
            reworkCount: this.state.issueReworkCounts[issueId] ?? 0,
          },
        };
      }

      case "escalate_human": {
        if (!this.isIssueParked(issueId)) {
          return { status: "no_op", detail: "not parked" };
        }
        // Idempotent per park generation (SYMPH-422 council P2): the park
        // stands after an applied escalation, so without this guard any
        // re-issue that slips past journal-key dedup (e.g. across a key
        // format migration, or from a second actor) applies again and
        // posts a duplicate escalation comment.
        if (
          this.escalatedParkGenerations.has(issueId) &&
          this.escalatedParkGenerations.get(issueId) === currentGen
        ) {
          return {
            status: "no_op",
            detail: `already escalated for park generation ${currentGen ?? "none"}`,
          };
        }
        this.escalatedParkGenerations.set(issueId, currentGen);
        // No state change: the park stands while a human is paged.
        return {
          status: "applied",
          detail: `escalated to human; park stands (generation ${currentGen ?? "none"})`,
        };
      }

      case "halt": {
        const runningEntry = this.state.running[issueId];
        if (runningEntry === undefined) {
          return { status: "no_op", detail: "not running" };
        }
        const stopRequest = await this.requestStop(
          runningEntry,
          true,
          "manual_stop",
        );
        return { status: "applied", detail: "halted", stopRequest };
      }

      case "resume": {
        // One continuation unit for a budget-paused run that never parked
        // (SYMPH-422: sync pause-triage continue). A standing park must go
        // through release/retry_once instead — their preconditions and
        // fence semantics own park clearing.
        if (this.isIssueParked(issueId)) {
          return {
            status: "no_op",
            detail: "parked — use release or retry_once to clear a park",
          };
        }
        if (issueId in this.state.running) {
          return { status: "no_op", detail: "already running" };
        }
        if (this.state.retryAttempts[issueId] !== undefined) {
          return { status: "no_op", detail: "retry already scheduled" };
        }
        const retryEntry = this.scheduleRetry(issueId, 1, {
          identifier: input.issueIdentifier,
          error: null,
          delayType: "continuation",
        });
        return {
          status: "applied",
          detail: "scheduled one continuation unit",
          retryEntry,
        };
      }
    }
  }

  private async recordIntentJournalEntry(args: {
    input: IntentWriteInput;
    status: "applied" | "no_op" | "rejected_stale";
    detail: string;
    generation: number | null;
    idempotencyKey: string;
    timestamp?: string;
    /** Resolved values from applyIntentVerb that replay reads back verbatim. */
    journalMetadata?: Record<string, unknown>;
  }): Promise<number | null> {
    const { input } = args;
    try {
      const entry = await this.recordRunJournalEntry({
        idempotencyKey: args.idempotencyKey,
        timestamp: args.timestamp ?? this.now().toISOString(),
        kind: "intent",
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        operation: "dispatcher",
        stage: input.stage ?? this.state.issueStages[input.issueId] ?? null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Intent ${input.verb} ${args.status} for ${input.issueIdentifier} ${formatIntentAttribution(input.actor)}: ${args.detail}`,
        metadata: {
          schema_version: INTENT_SCHEMA_VERSION,
          status: args.status,
          verb: input.verb,
          actor: {
            kind: input.actor.kind,
            host: input.actor.host,
            session: input.actor.session ?? null,
          },
          reason: { class: input.reason.class, human: input.reason.human },
          detail: args.detail,
          parkGeneration: args.generation,
          ...(input.fence === undefined
            ? {}
            : { fence: { expectedParkSeq: input.fence.expectedParkSeq } }),
          ...(input.hint === undefined || input.hint === null
            ? {}
            : { hint: input.hint }),
          ...(input.anchor === undefined
            ? {}
            : {
                anchor: {
                  placement: input.anchor.placement,
                  expiry: input.anchor.expiry,
                  source: input.anchor.source,
                  fieldName: input.anchor.fieldName ?? null,
                  editorEmail: input.anchor.editorEmail ?? null,
                },
              }),
          ...(input.issueState === undefined || input.issueState === null
            ? {}
            : { issueState: input.issueState }),
          ...(input.grantSignature === undefined ||
          input.grantSignature === null
            ? {}
            : { grantSignature: input.grantSignature }),
          ...(input.extraMetadata ?? {}),
          ...(args.journalMetadata ?? {}),
        },
      });
      return entry.sequence;
    } catch (error) {
      // The journal write is the audit trail, not the mutation: a failed
      // append must not crash the caller, but it must never be silent.
      console.warn(
        `[orchestrator] failed to journal intent ${input.verb} for ${input.issueIdentifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Journal a pipeline-scoped intent (pause/resume of the WHOLE pipeline,
   * SYMPH-408b). Pipeline pause/resume has no issue and no park generation,
   * so it cannot ride writeIntent — but it must still be a journal-attributed
   * intent entry recording the ACTUAL outcome: the caller journals `no_op`
   * for already-satisfied or infeasible requests before touching the view,
   * and `applied` only AFTER the control effect succeeded: either a Linear
   * halt-issue mutation or the runtime-local pause gate used when the Linear
   * halt view is degraded. The verb is namespaced (`pipeline_pause` /
   * `pipeline_resume`) so issue-verb replay reduction ignores these entries.
   *
   * Every request journals its own audit entry (the journal sequence is the
   * uniqueness discriminator); effect-level idempotency lives in the caller,
   * which records `no_op` when the pipeline is already in the requested
   * state. A null return (failed journal append) after a successful view
   * mutation is the caller's documented warn-only degraded mode.
   */
  async journalPipelineIntent(input: {
    action: "pause" | "resume" | "stop" | "dispatch_fence" | "dispatch_unfence";
    status: "applied" | "no_op";
    actor: IntentActor;
    reason: IntentReason;
    detail: string;
    metadata?: Record<string, unknown>;
  }): Promise<number | null> {
    const verb = `pipeline_${input.action}`;
    const actorKey = formatIntentActorKey(input.actor);
    const timestamp = this.now().toISOString();
    try {
      const entry = await this.recordRunJournalEntry({
        idempotencyKey: `intent:${verb}:${actorKey}:seq-${this.state.dispatcherRunJournal.length}`,
        timestamp,
        kind: "intent",
        issueId: PIPELINE_INTENT_ISSUE_ID,
        issueIdentifier: PIPELINE_INTENT_ISSUE_IDENTIFIER,
        operation: "dispatcher",
        stage: null,
        attempt: null,
        ownerId: this.leaseOwnerId,
        lease: null,
        summary: `Intent ${verb} ${input.status} ${formatIntentAttribution(input.actor)}: ${input.detail}`,
        metadata: {
          schema_version: INTENT_SCHEMA_VERSION,
          scope: "pipeline",
          status: input.status,
          verb,
          actor: {
            kind: input.actor.kind,
            host: input.actor.host,
            session: input.actor.session ?? null,
          },
          reason: { class: input.reason.class, human: input.reason.human },
          detail: input.detail,
          ...(input.metadata ?? {}),
        },
      });
      if (
        input.status === "applied" &&
        input.action === "pause" &&
        input.metadata?.local_pause === true
      ) {
        this.state.pipelinePause = this.buildPipelinePauseState({
          timestamp: entry.timestamp,
          reason: input.reason,
          actor: input.actor,
          haltViewMetadata: readMetadataRecord(entry.metadata, "halt_view"),
          sequence: entry.sequence,
        });
      }
      if (input.status === "applied" && input.action === "resume") {
        this.state.emergencyStop = null;
        this.state.pipelinePause = null;
      }
      if (input.status === "applied" && input.action === "dispatch_fence") {
        this.state.dispatchFence = readDispatchFenceMetadata(entry.metadata, {
          timestamp: entry.timestamp,
          sequence: entry.sequence,
        });
      }
      if (input.status === "applied" && input.action === "dispatch_unfence") {
        this.state.dispatchFence = null;
      }
      return entry.sequence;
    } catch (error) {
      this.applyDegradedPipelineIntentLiveEffect({
        action: input.action,
        status: input.status,
        actor: input.actor,
        reason: input.reason,
        timestamp,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      console.warn(
        `[orchestrator] failed to journal pipeline intent ${verb}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async setDispatchFence(input: {
    issueIdentifiers: readonly string[];
    source: DispatchFenceSource;
    actor: IntentActor;
    reason: IntentReason;
  }): Promise<IntentWriteResult> {
    const issueIdentifiers = normalizeDispatchFenceIdentifiers(
      input.issueIdentifiers,
    );
    if (issueIdentifiers.length === 0) {
      return {
        status: "no_op",
        detail: "dispatch fence requires at least one issue identifier",
        sequence: null,
      };
    }
    const active = this.state.dispatchFence;
    const sameFence =
      active !== null &&
      active.source === input.source &&
      arraysEqual(active.issueIdentifiers, issueIdentifiers);
    const detail = sameFence
      ? `dispatch fence already active for ${issueIdentifiers.join(", ")}`
      : `dispatch fence active for ${issueIdentifiers.join(", ")}`;
    const sequence = await this.journalPipelineIntent({
      action: "dispatch_fence",
      status: sameFence ? "no_op" : "applied",
      actor: input.actor,
      reason: input.reason,
      detail,
      metadata: {
        dispatchFence: {
          issueIdentifiers,
          source: input.source,
          clearing: "explicit",
        },
      },
    });
    return { status: sameFence ? "no_op" : "applied", detail, sequence };
  }

  async clearDispatchFence(input: {
    actor: IntentActor;
    reason: IntentReason;
  }): Promise<IntentWriteResult> {
    const active = this.state.dispatchFence;
    const detail =
      active === null
        ? "dispatch fence already clear"
        : `dispatch fence cleared for ${active.issueIdentifiers.join(", ")}`;
    const sequence = await this.journalPipelineIntent({
      action: "dispatch_unfence",
      status: active === null ? "no_op" : "applied",
      actor: input.actor,
      reason: input.reason,
      detail,
    });
    return { status: active === null ? "no_op" : "applied", detail, sequence };
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
    return (
      guard === undefined ||
      (guard.observedNonResumeState &&
        guard.requiresConfirmedEmergencyStop !== true)
    );
  }

  private resumeRequirementBlockVerdict(
    issueId: string,
    issueState: string,
    normalizedState: string,
  ): {
    reasonCode: string;
    remedy: string;
    details: Record<string, unknown>;
  } {
    const guard = this.resumeRequiredGuards.get(issueId);
    if (
      normalizedState === EXPLICIT_RESUME_STATE &&
      guard?.requiresConfirmedEmergencyStop === true
    ) {
      return {
        reasonCode: "emergency_stop_unconfirmed_kill",
        remedy:
          "confirm no interrupted process remains, then clear the park with an explicit release intent",
        details: {
          issueState,
          pausedAt: guard.pausedAt,
          parkSeq: guard.parkSeq,
          requiresConfirmedEmergencyStop: true,
        },
      };
    }
    return {
      reasonCode: "requires_explicit_resume",
      remedy: "transition the issue into Resume (Todo alone is skipped)",
      details: { issueState },
    };
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
        summary: result.summary ?? null,
        ...(result.status === undefined ? {} : { status: result.status }),
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
      summary: summarizeContinuousFeedbackCheckpoint(
        status,
        runningEntry.identifier,
        result.summary ?? null,
        result.findings.length,
      ),
      metadata: {
        event: input.event,
        status,
        continuousFeedbackStatusVersion: 2,
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

  private blockForEmergencyStop(candidateCount: number): true | null {
    const emergencyStop = this.state.emergencyStop;
    if (emergencyStop === null) {
      return null;
    }
    this.recordDispatchVerdict({
      issueId: PIPELINE_VERDICT_SCOPE_ID,
      issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
      disposition: "halt",
      reasonCode: "emergency_stop",
      remedy:
        "Run pipeline resume after triaging killed-mid-run tickets and clearing the halt issue.",
      details: {
        since: emergencyStop.since,
        reason: emergencyStop.reason,
        actor: emergencyStop.actor,
        interruptedIssues: emergencyStop.interruptedIssues,
      },
    });
    this.trackDispatchStarvation(candidateCount, 0);
    return true;
  }

  private blockForPipelinePause(candidateCount: number): true | null {
    const pipelinePause = this.state.pipelinePause;
    if (pipelinePause === null) {
      return null;
    }
    this.recordDispatchVerdict({
      issueId: PIPELINE_VERDICT_SCOPE_ID,
      issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
      disposition: "halt",
      reasonCode: "runtime_pipeline_pause",
      remedy:
        "Run pipeline resume after verifying the halt view and clearing the pause.",
      details: {
        since: pipelinePause.since,
        reason: pipelinePause.reason,
        actor: pipelinePause.actor,
        haltView: pipelinePause.haltView,
      },
    });
    this.trackDispatchStarvation(candidateCount, 0);
    return true;
  }

  private recoverEmergencyStopIntent(entry: DispatcherRunJournalEntry): void {
    const reason = readMetadataRecord(entry.metadata, "reason");
    const actor = readMetadataRecord(entry.metadata, "actor");
    const interruptedIssues = readInterruptedIssues(entry.metadata);
    this.state.emergencyStop = {
      active: true,
      since: entry.timestamp,
      reason: readRecordString(reason, "human") ?? "emergency stop",
      actor: {
        kind: readRecordString(actor, "kind") ?? "operator",
        host: readRecordString(actor, "host") ?? "unknown",
        session: readRecordString(actor, "session"),
      },
      setBySequence: entry.sequence,
      interruptedIssues,
    };
    for (const issue of interruptedIssues) {
      if (!this.state.resumeRequired.has(issue.issueId)) {
        this.markIssueRequiresExplicitResume(
          issue.issueId,
          null,
          entry.timestamp,
          {
            reason: "killed_mid_run_unconfirmed",
            setBySequence: entry.sequence,
          },
        );
      }
      this.requireEmergencyStopProcessCleanup(issue.issueId, {
        setBySequence: entry.sequence,
        since: entry.timestamp,
      });
    }
  }

  private recoverPipelinePauseIntent(entry: DispatcherRunJournalEntry): void {
    if (readMetadataBoolean(entry.metadata, "local_pause") !== true) {
      return;
    }
    this.state.pipelinePause = this.buildPipelinePauseStateFromJournal({
      entry,
      sequence: entry.sequence,
    });
  }

  private recoverDispatchFenceIntent(entry: DispatcherRunJournalEntry): void {
    const verb = readMetadataString(entry.metadata, "verb");
    if (verb === "pipeline_dispatch_unfence") {
      this.state.dispatchFence = null;
      return;
    }
    const fence = readDispatchFenceMetadata(entry.metadata, {
      timestamp: entry.timestamp,
      sequence: entry.sequence,
    });
    if (fence !== null) {
      this.state.dispatchFence = fence;
    }
  }

  private applyDegradedPipelineIntentLiveEffect(input: {
    action: "pause" | "resume" | "stop" | "dispatch_fence" | "dispatch_unfence";
    status: "applied" | "no_op";
    actor: IntentActor;
    reason: IntentReason;
    metadata?: Record<string, unknown>;
    timestamp: string;
  }): void {
    if (input.status !== "applied") {
      return;
    }
    if (input.action === "resume") {
      this.state.emergencyStop = null;
      this.state.pipelinePause = null;
      return;
    }
    if (input.action === "pause" && input.metadata?.local_pause === true) {
      this.state.pipelinePause = this.buildPipelinePauseState({
        timestamp: input.timestamp,
        reason: input.reason,
        actor: input.actor,
        haltViewMetadata: readMetadataRecord(input.metadata, "halt_view"),
        sequence: null,
      });
      return;
    }
    if (input.action === "dispatch_fence") {
      const metadata = {
        ...(input.metadata ?? {}),
        actor: {
          kind: input.actor.kind,
          host: input.actor.host,
          session: input.actor.session ?? null,
        },
        reason: {
          class: input.reason.class,
          human: input.reason.human,
        },
      };
      this.state.dispatchFence = readDispatchFenceMetadata(metadata, {
        timestamp: input.timestamp,
        sequence: null,
      });
      return;
    }
    if (input.action === "dispatch_unfence") {
      this.state.dispatchFence = null;
    }
  }

  private buildPipelinePauseStateFromJournal(input: {
    entry: DispatcherRunJournalEntry;
    sequence: number | null;
  }): PipelinePauseState {
    const reason = readMetadataRecord(input.entry.metadata, "reason");
    const actor = readMetadataRecord(input.entry.metadata, "actor");
    const actorKind = readRecordString(actor, "kind");
    return this.buildPipelinePauseState({
      timestamp: input.entry.timestamp,
      reason: {
        class: readRecordString(reason, "class") ?? "operator_pipeline_pause",
        human: readRecordString(reason, "human") ?? "pipeline pause requested",
      },
      actor: {
        kind: isIntentActorKind(actorKind) ? actorKind : "operator",
        host: readRecordString(actor, "host") ?? "unknown",
        session: readRecordString(actor, "session"),
      },
      haltViewMetadata: readMetadataRecord(input.entry.metadata, "halt_view"),
      sequence: input.sequence,
    });
  }

  private buildPipelinePauseState(input: {
    timestamp: string;
    reason: IntentReason;
    actor: IntentActor;
    haltViewMetadata: Record<string, unknown> | null;
    sequence: number | null;
  }): PipelinePauseState {
    const haltView = input.haltViewMetadata;
    const status = readRecordString(haltView, "status");
    return {
      active: true,
      since: input.timestamp,
      reason: input.reason.human,
      actor: {
        kind: input.actor.kind,
        host: input.actor.host,
        session: input.actor.session ?? null,
      },
      setBySequence: input.sequence,
      haltView: {
        status:
          status === "created" || status === "already_paused"
            ? status
            : "uncertain",
        issueIdentifier: readRecordString(haltView, "issue_identifier"),
        issueTitle: readRecordString(haltView, "issue_title"),
        errorMessage: readRecordString(haltView, "error_message"),
      },
    };
  }

  private toEmergencyStopInterruptedIssue(
    runningEntry: RunningEntry,
  ): PipelineEmergencyStopState["interruptedIssues"][number] {
    return {
      issueId: runningEntry.issue.id,
      issueIdentifier: runningEntry.identifier,
      stage: this.state.issueStages[runningEntry.issue.id] ?? null,
      attempt: runningEntry.retryAttempt,
      codexAppServerPid: runningEntry.codexAppServerPid,
      codexAppServerIdentity: runningEntry.codexAppServerIdentity,
    };
  }

  private buildEmergencyStopState(input: {
    actor: IntentActor;
    reason: IntentReason;
    interruptedIssues: PipelineEmergencyStopState["interruptedIssues"];
    sequence: number | null;
    timestamp: string;
  }): PipelineEmergencyStopState {
    return {
      active: true,
      since: input.timestamp,
      reason: input.reason.human,
      actor: {
        kind: input.actor.kind,
        host: input.actor.host,
        session: input.actor.session ?? null,
      },
      setBySequence: input.sequence,
      interruptedIssues: input.interruptedIssues,
    };
  }

  async requestEmergencyStop(input: {
    actor: IntentActor;
    reason: IntentReason;
  }): Promise<EmergencyStopResult> {
    const alreadyActive = this.state.emergencyStop !== null;
    const interruptedIssues = Object.values(this.state.running).map((entry) =>
      this.toEmergencyStopInterruptedIssue(entry),
    );
    const status =
      alreadyActive && interruptedIssues.length === 0 ? "no_op" : "applied";
    const detail =
      status === "applied"
        ? `emergency stop applied; ${interruptedIssues.length} in-flight issue(s) marked killed-mid-run`
        : "emergency stop already active; no in-flight issues";
    const sequence = await this.journalPipelineIntent({
      action: "stop",
      status,
      actor: input.actor,
      reason: input.reason,
      detail,
      metadata: { interruptedIssues },
    });

    if (status === "applied") {
      this.state.emergencyStop = this.buildEmergencyStopState({
        actor: input.actor,
        reason: input.reason,
        interruptedIssues,
        sequence,
        timestamp: this.now().toISOString(),
      });
    }

    const stopRequests: StopRequest[] = [];
    for (const runningEntry of Object.values(this.state.running)) {
      stopRequests.push(
        await this.requestStop(runningEntry, false, "emergency_stop", {
          emergencyStopSourceSequence: sequence,
        }),
      );
    }

    this.blockForEmergencyStop(interruptedIssues.length);
    return {
      status,
      detail,
      sequence,
      interruptedIssues,
      stopRequests,
    };
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
    const journaledSequence = this.commitRunJournalEntrySync({
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
          sequence: journaledSequence,
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
   * Synchronously commit a visibility journal entry to the
   * in-memory journal, then hand the disk write to the ordered flush queue
   * fire-and-forget. Callable from sync paths (isDispatchEligible) — the
   * in-memory commit happens before any await, so overlapping appends can
   * never compute the same sequence from a stale journal. Verdict entries
   * and restart-visibility entries never carry a lease, so no lease
   * bookkeeping is needed.
   */
  private commitRunJournalEntrySync(
    entry: Omit<DispatcherRunJournalEntry, "sequence">,
  ): number | null {
    const result = appendDispatcherRunJournalEntry(
      this.state.dispatcherRunJournal,
      entry,
      this.burnedRunJournalSequence + 1,
    );
    if (!result.appended) {
      return null;
    }
    this.state.dispatcherRunJournal = result.journal;
    this.flushRunJournalEntryToDisk(result.entry).catch((error) => {
      console.warn(
        "[orchestrator] Failed to persist journal entry:",
        {
          kind: entry.kind,
          issueIdentifier: entry.issueIdentifier,
        },
        error,
      );
    });
    return result.entry.sequence;
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
    this.commitRunJournalEntrySync({
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

  /**
   * Restart-rehydrated active work visibility (SYMPH-455). A replayed
   * `right_sizing` entry proves the issue already dispatched before this
   * process. If it later spawns work again without a new rework cycle, emit a
   * distinct journal-backed pickup event. Same-process stage continuations do
   * not pass through the replay marker and remain silent.
   */
  private recordExistingActiveResumeIfNeeded(input: {
    issue: Issue;
    stageName: string | null;
    attempt: number | null;
    reworkCount: number;
  }): void {
    if (!this.replayedDispatchedIssueIds.has(input.issue.id)) {
      return;
    }
    if (input.reworkCount > 0) {
      this.replayedDispatchedIssueIds.delete(input.issue.id);
      return;
    }

    const sequence = this.commitRunJournalEntrySync({
      idempotencyKey: `resumed_existing_active:${input.issue.id}:${input.stageName ?? "no-stage"}:${formatAttemptKey(input.attempt)}:${this.nextRunJournalSequence()}`,
      timestamp: this.now().toISOString(),
      kind: "resumed_existing_active",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      operation: "dispatcher",
      stage: input.stageName,
      attempt: input.attempt,
      ownerId: this.leaseOwnerId,
      lease: null,
      summary: `Resumed existing active Pipeline work for ${input.issue.identifier} after journal replay.`,
      metadata: {
        schema_version: 1,
        status: "completed",
        source: "restart_replay",
        resume_reason: "prior_dispatch_replayed",
        rework_count: input.reworkCount,
      },
    });
    this.replayedDispatchedIssueIds.delete(input.issue.id);

    try {
      this.onExistingActiveResumed?.({
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        issueTitle: input.issue.title,
        issueUrl: input.issue.url ?? null,
        stageName: input.stageName,
        attempt: input.attempt,
        reworkCount: input.reworkCount,
        sequence,
      });
    } catch {
      // Notification failures are always swallowed.
    }
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

  private async recordDispatchComparatorSafetyEvent(input: {
    decisionId: string;
    summary: string;
    reason: string;
    findingKinds: string[];
    details: Record<string, unknown>;
    observedDecision: string;
    observedRationale: string;
  }): Promise<void> {
    try {
      await this.recordDispatcherDecisionEvent({
        decisionId: input.decisionId,
        category: "admission",
        classifier: DISPATCH_COMPARATOR_VERSION,
        issueId: PIPELINE_VERDICT_SCOPE_ID,
        issueIdentifier: PIPELINE_VERDICT_SCOPE_IDENTIFIER,
        operation: "dispatcher",
        stage: null,
        attempt: null,
        summary: input.summary,
        context: {
          reason: input.reason,
          triggerHits: [],
          findingKinds: input.findingKinds,
          files: [],
          workerIds: [],
          details: input.details,
        },
        expectedOutcome: {
          decision: "dispatch_only_from_computed_order",
          classification: "positive",
          rationale:
            "Dispatch admission must fail closed when computed-order safety is unverifiable.",
          costWeight: "high",
        },
        observedOutcome: {
          decision: input.observedDecision,
          classification: "positive",
          rationale: input.observedRationale,
          costWeight: "high",
        },
      });
    } catch (error) {
      console.warn(
        `[orchestrator] failed to journal dispatch comparator safety event: ${formatWarningError(error)}`,
      );
    }
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
    const blocksWorkerAdmission =
      input.operation === "dispatcher" && input.kind === "admission";
    if (
      this.getActiveDispatcherLease(input.leaseId) !== null ||
      this.pendingDispatcherLeaseIds.has(input.leaseId) ||
      (blocksWorkerAdmission &&
        (this.hasBlockingDispatcherLease(input.issueId) ||
          this.pendingDispatcherLeaseIssueIds.has(input.issueId)))
    ) {
      return null;
    }

    // Bridge the check-to-commit window until recordRunJournalEntry promotes
    // the lease into state.dispatcherLeases. RuntimeHost normally serializes
    // poll ticks, but direct concurrent pollTick callers still rely on these
    // pending markers to keep worker admission single-lane. The finally below
    // must clear the markers even when journal persistence rejects, so retries
    // can reacquire the same lease after rollback.
    this.pendingDispatcherLeaseIds.add(input.leaseId);
    if (blocksWorkerAdmission) {
      this.pendingDispatcherLeaseIssueIds.add(input.issueId);
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

    try {
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
    } finally {
      this.pendingDispatcherLeaseIds.delete(input.leaseId);
      if (blocksWorkerAdmission) {
        this.pendingDispatcherLeaseIssueIds.delete(input.issueId);
      }
    }
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
      pendingStageSignal: PendingStageSignal | null;
    },
  ): Promise<void> {
    const parkGeneration = this.nextParkGenerationForJournalKey(issueId);
    const hardStopEntry = await this.recordRunJournalEntry({
      idempotencyKey: `hard_stop:${issueId}:${input.stageName ?? "no-stage"}:${formatAttemptKey(runningEntry.retryAttempt)}:${input.hardStop.trigger}:${input.hardStop.turnCount}:gen-${parkGeneration}`,
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
        billableTokens: input.hardStop.billableTokens ?? null,
        humanBlockOperation: input.hardStop.humanBlockOperation ?? null,
        humanBlockBlockers: input.hardStop.humanBlockBlockers ?? null,
        estimatedCostUsd: input.hardStop.estimatedCostUsd,
        issueState: runningEntry.issue.state,
        parkGeneration,
        passedStages: [...(this.state.issuePassedStages[issueId] ?? [])],
        ...pendingStageSignalMetadata(input.pendingStageSignal),
      },
    });

    if (input.pendingStageSignal !== null) {
      this.state.issuePendingStageSignals[issueId] = {
        ...input.pendingStageSignal,
        setBySequence: hardStopEntry.sequence,
      };
    }

    this.markIssueRequiresExplicitResume(
      issueId,
      runningEntry.issue.state,
      null,
      {
        reason: resumeRequiredReasonForHardStop(input.hardStop),
        setBySequence: hardStopEntry.sequence,
        parkGeneration,
      },
    );

    const comment = [
      `Hard stop outcome: ${input.hardStop.outcome}`,
      `Trigger: ${input.hardStop.trigger}`,
      // Field-level caps on untrusted fields: the composed body must stay
      // under the choke-point cap so long worker text can never truncate the
      // deterministic resume instruction below (SYMPH-421/SYMPH-629).
      `Reason: ${sanitizeForLinear(input.hardStop.reason, { maxLen: HARD_STOP_COMMENT_UNTRUSTED_FIELD_MAX_LEN })}`,
      ...(input.hardStop.humanBlockBlockers === undefined ||
      input.hardStop.humanBlockBlockers === null
        ? []
        : [
            `Blockers: ${sanitizeForLinear(input.hardStop.humanBlockBlockers, { maxLen: HARD_STOP_COMMENT_UNTRUSTED_FIELD_MAX_LEN })}`,
          ]),
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
    const parkGeneration = this.nextParkGenerationForJournalKey(issueId);
    const operatorInputEntry = await this.recordRunJournalEntry({
      idempotencyKey: `operator_input_required:${issueId}:${input.stageName ?? "no-stage"}:${formatAttemptKey(runningEntry.retryAttempt)}:gen-${parkGeneration}`,
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
        parkGeneration,
      },
    });

    this.markIssueRequiresExplicitResume(
      issueId,
      runningEntry.issue.state,
      null,
      {
        reason: "operator_input_required",
        setBySequence: operatorInputEntry.sequence,
        parkGeneration,
      },
    );

    const comment = [
      "Headless Codex requested operator input during the worker turn.",
      // Field-level cap so the resume instruction below survives the
      // choke-point cap regardless of reason length (SYMPH-421).
      `Reason: ${sanitizeForLinear(input.reason, { maxLen: 1500 })}`,
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
        // Finding titles/details are authored by the cheap feedback-lane
        // model; the wider cap keeps multi-finding lists intact while the
        // fence/link/secret neutralization still applies (SYMPH-421).
        sanitizeForLinear(
          formatContinuousFeedbackComment({
            issueIdentifier: runningEntry.identifier,
            stageName,
            findings: openFindings,
          }),
          { maxLen: 6000 },
        ),
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

  private admitRetryResumeRequirement(
    issue: Issue,
    retryEntry: RetryEntry,
  ): boolean {
    const normalizedState = normalizeIssueState(issue.state);
    this.observeResumeRequiredState(issue.id, normalizedState);

    if (!this.state.resumeRequired.has(issue.id)) {
      return true;
    }

    if (this.canConsumeResumeRequirement(issue.id, normalizedState)) {
      this.clearResumedIssueLifecycleState(issue.id);
      return true;
    }

    this.recordDispatchVerdict({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      disposition: "skip",
      reasonCode: "requires_explicit_resume",
      remedy: "transition the issue into Resume (Todo alone is skipped)",
      attempt: retryEntry.attempt,
      details: { issueState: issue.state, retryAttempt: retryEntry.attempt },
    });
    return false;
  }

  private async enforceMergeCandidateDispatchBarrier(
    issue: Issue,
    stageName: string | null,
  ): Promise<boolean> {
    if (stageName !== "merge") {
      return false;
    }
    const passedStages = this.state.issuePassedStages[issue.id] ?? [];
    if (!passedStages.includes("review")) {
      return false;
    }
    const candidate = this.findCanonicalMergeCandidate(issue.id);
    if (candidate === null) {
      await this.parkMergeCandidateInvariantFailure({
        issue,
        stageName,
        reasonCode: "missing_canonical_review_gate_result",
        detail:
          "issue is in merge with review marked passed but no canonical review_gate_result plus merge_candidate state exists",
      });
      return true;
    }

    const actuatorConfig = this.config.mergeActuator;
    if (
      actuatorConfig?.enabled === true &&
      this.getMergeActuatorLiveState !== undefined &&
      this.mergeActuatorSideEffects !== undefined
    ) {
      return await this.runLiveMergeActuator(
        issue,
        stageName,
        candidate,
        actuatorConfig,
      );
    }

    // Actuator disabled or unwired: refuse to advance/dispatch merge — never
    // fall through to a legacy merge worker (SYMPH-735 default-off behavior).
    await this.parkMergeCandidateInvariantFailure({
      issue,
      stageName,
      reasonCode: "merge_actuator_unwired",
      detail: `candidate ${candidate.candidateId} is available, but live merge-stage dispatch has no configured orchestrator actuator and must not fall through to the legacy merge worker`,
      reviewResultPath: candidate.reviewResultPath,
    });
    return true;
  }

  /**
   * Run one bounded merge-actuator cycle against live GitHub/tracker state and
   * map its outcome onto orchestrator state (SYMPH-735). Only reached when the
   * actuator is enabled in config AND the live-state + side-effect providers are
   * wired. The bounded recovery (countable evidence, replay-stable ceilings,
   * parking) lives entirely in `runMergeActuatorCycle`; this method only acquires
   * a per-cycle lease and translates the result:
   * - parked  -> operator-visible invariant-failure park (with the blocker)
   * - retry   -> a deferral continuation re-poll (the coordinator owns the bound,
   *              so this must NOT participate in scheduleRetry's failure ceiling)
   * - actuated-> tracker_done completes the issue; mark_ready/enqueue/poll re-poll;
   *              stale/timeout/blocked park.
   */
  private async runLiveMergeActuator(
    issue: Issue,
    stageName: string | null,
    candidate: MergeCandidateRecord,
    actuatorConfig: NonNullable<ResolvedWorkflowConfig["mergeActuator"]>,
  ): Promise<boolean> {
    const fetchLiveState = this.getMergeActuatorLiveState;
    const sideEffects = this.mergeActuatorSideEffects;
    if (fetchLiveState === undefined || sideEffects === undefined) {
      // Defensive — the caller already checked; keep the barrier fail-closed.
      await this.parkMergeCandidateInvariantFailure({
        issue,
        stageName,
        reasonCode: "merge_actuator_unwired",
        detail: `candidate ${candidate.candidateId} merge actuator enabled but live-state/side-effect providers are not wired`,
        reviewResultPath: candidate.reviewResultPath,
      });
      return true;
    }

    // A fresh lease per cycle: the lease id embeds the candidate's last journal
    // sequence, which advances as the coordinator appends evidence, so each poll
    // gets a distinct lease id — exactly what keeps the coordinator's countable
    // evidence (live_state_failed / failed / draft_wait) replay-stable.
    const leaseId = createDispatcherLeaseId({
      operation: "dispatcher",
      issueId: issue.id,
      stage: "merge",
      attempt: null,
      suffix: `merge-actuator-${candidate.cursorRange.lastSequence}`,
    });
    const lease = await this.acquireDispatcherLease({
      leaseId,
      idempotencyKey: `${leaseId}:started`,
      kind: "dispatch_verdict",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: "merge",
      attempt: null,
      summary: `Merge actuator lease acquired for ${issue.identifier}.`,
      metadata: { candidate_id: candidate.candidateId },
    });
    if (lease === null) {
      // A concurrent lease holds the candidate; retry on the next poll.
      return true;
    }

    const result = await runMergeActuatorCycle({
      candidate,
      journal: this.state.dispatcherRunJournal,
      lease,
      ownerId: this.leaseOwnerId,
      now: this.now(),
      // Derived from the durable journal by the coordinator (replay-stable).
      enqueuedAtMs: null,
      maxWaitMs: actuatorConfig.maxWaitMs,
      limits: {
        maxLiveStateFailures: actuatorConfig.maxLiveStateFailures,
        maxSideEffectFailures: actuatorConfig.maxSideEffectFailures,
        maxDraftWaitObservations: actuatorConfig.maxDraftWaitObservations,
        maxPendingChecksWaitObservations:
          actuatorConfig.maxPendingChecksWaitObservations,
        maxUnknownMergeabilityWaitObservations:
          actuatorConfig.maxUnknownMergeabilityWaitObservations,
      },
      // Per-workflow actuator auto-merge permission (SYMPH-754), default-CLOSED.
      // When false, an enqueue-ready candidate yields a terminal `blocked`
      // decision (reason auto_merge_permission_denied) the actuated branch below
      // parks for an operator — so enabling the actuator for a new product cannot
      // silently auto-merge without an explicit grant.
      autoMergePermission: actuatorConfig.autoMerge,
      fetchLiveState: () => fetchLiveState(candidate),
      appendActuation: (entry) => this.recordRunJournalEntry(entry),
      sideEffects,
    });

    await this.completeDispatcherLease({
      leaseId,
      idempotencyKey: `${leaseId}:completed:${result.outcome}`,
      kind: "dispatch_verdict",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      operation: "dispatcher",
      stage: "merge",
      attempt: null,
      summary: `Merge actuator ${result.outcome} for ${issue.identifier}.`,
      metadata: {
        candidate_id: candidate.candidateId,
        outcome: result.outcome,
      },
    });

    if (result.outcome === "parked") {
      const blocker = result.blocker;
      await this.parkMergeCandidateInvariantFailure({
        issue,
        stageName,
        reasonCode: blocker.reason,
        detail: `merge actuator parked candidate ${candidate.candidateId} (PR #${blocker.prNumber}, reviewed head ${blocker.reviewedHeadSha}) after ${blocker.attempts} attempts: ${blocker.lastErrorOrStateSummary}. Next: ${blocker.nextOperatorAction}`,
        reviewResultPath: candidate.reviewResultPath,
      });
      return true;
    }

    if (result.outcome === "retry") {
      // The coordinator owns the failure/wait bound (journal-counted); this is a
      // pure re-poll on the merge-actuator backoff (SYMPH-753), its attempt index
      // derived from the durable journal so the cadence is replay-stable.
      // deferral:true keeps it out of scheduleRetry's failure ceiling and novelty
      // short-circuit, so repeated same-reason polls never falsely park a
      // candidate the coordinator is still bounding.
      this.scheduleRetry(
        issue.id,
        mergeActuatorPollAttempt(
          this.state.dispatcherRunJournal,
          candidate.candidateId,
        ),
        {
          identifier: issue.identifier,
          error: result.reason,
          delayType: "merge_actuator_poll",
          deferral: true,
        },
      );
      return true;
    }

    // Map the actuated cycle by the candidate's re-reduced, DURABLE status (not
    // the single-cycle decision). This is replay-stable and resolves the
    // crash-recovery case where a terminal action (e.g. tracker_done) was
    // journaled but the issue was not yet completed: on replay the decision is a
    // noop (side_effect_already_journaled), yet the status is already merged, so
    // we complete instead of re-polling forever (council R1: Codex P2 / Pi P1).
    const updated = this.findCanonicalMergeCandidate(issue.id) ?? candidate;
    if (updated.status === "merged") {
      this.state.completed.add(issue.id);
      this.releaseClaim(issue.id);
      this.clearTerminalIssueRuntimeState(issue.id);
      return true;
    }
    if (updated.status === "blocked" || updated.status === "stale") {
      // Terminal non-mergeable state (incl. timeout/stale/side-effect-exhausted)
      // — park for an operator instead of looping.
      await this.parkMergeCandidateInvariantFailure({
        issue,
        stageName,
        reasonCode: updated.blockedReason ?? updated.status,
        detail: `merge actuator parked candidate ${candidate.candidateId}: ${updated.blockedReason ?? updated.status}`,
        reviewResultPath: candidate.reviewResultPath,
      });
      return true;
    }

    if (result.run.decision.action === "blocked") {
      // A `blocked` decision that the coordinator did NOT convert to a bounded
      // wait (failing_checks, missing_required_review, merged_without_durable_proof,
      // or a non-green-terminal merge_state_*) journals NO actuation row, so the
      // candidate status is unchanged and the status checks above miss it. It is a
      // terminal not-mergeable-now state that will not self-resolve under the
      // actuator's control, so park for an operator rather than re-polling forever
      // — the coordinator appends no countable evidence for it, so a deferral
      // re-poll would loop unbounded (council R2: Codex). The transient
      // pending_checks_pre_enqueue / mergeability_unknown blocked decisions are
      // intercepted earlier as bounded retry/parked outcomes (SYMPH-752/755) and
      // never reach here. Matches the pre-fix / #562 behavior of parking blocked
      // decisions.
      await this.parkMergeCandidateInvariantFailure({
        issue,
        stageName,
        reasonCode: result.run.decision.reason,
        // SYMPH-766: the late-rework reconciliation reasons get an accurate,
        // operator-facing detail (never "not mergeable" for an already-merged
        // PR); other blocked reasons keep the generic not-mergeable detail.
        detail:
          mergeReworkParkDetail(
            result.run.decision.reason,
            candidate.prNumber,
          ) ??
          `merge actuator candidate ${candidate.candidateId} is not mergeable: ${result.run.decision.blockers.join(", ") || result.run.decision.reason}`,
        reviewResultPath: candidate.reviewResultPath,
      });
      return true;
    }

    // candidate / ready_marked / merge_queue_pending / superseded — still in
    // progress; re-poll next cycle on the merge-actuator backoff (SYMPH-753),
    // with the attempt index derived from the durable journal (replay-stable).
    // The coordinator owns the failure/wait bound (it returns "parked" on
    // exhaustion), so deferral:true keeps this re-poll out of scheduleRetry's own
    // failure ceiling and novelty short-circuit.
    this.scheduleRetry(
      issue.id,
      mergeActuatorPollAttempt(
        this.state.dispatcherRunJournal,
        candidate.candidateId,
      ),
      {
        identifier: issue.identifier,
        error: result.run.decision.reason,
        delayType: "merge_actuator_poll",
        deferral: true,
      },
    );
    return true;
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
  ): Promise<DispatchIssueResult> {
    const stagesConfig = this.config.stages;
    let stage: StageDefinition | null = null;
    let stageName: string | null = null;
    const attemptKey = formatAttemptKey(attempt);
    const pendingStageSignal = this.state.issuePendingStageSignals[issue.id];
    if (pendingStageSignal !== undefined) {
      const pendingRunningEntry = createPendingRunningEntry({
        issue,
        identifier: issue.identifier,
        attempt: pendingStageSignal.attempt,
        agentMessage: pendingStageSignal.agentMessage,
      });
      try {
        await this.consumePendingStageSignal(
          issue.id,
          pendingRunningEntry,
          pendingStageSignal,
        );
      } catch (error) {
        console.warn(
          `[orchestrator] Failed to consume pending stage signal for ${issue.identifier}; will retry on a later dispatch tick: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        dispatched: false,
        rightSizingDecision: null,
        disposition: "pending_stage_signal",
        reasonCode: "pending_stage_signal",
      };
    }

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
        } else {
          // No tracker write fires (linearState null or no updateIssueState
          // callback): journal synthetic terminal evidence (council R2) so
          // replay still clears the counters this completion erased live.
          this.journalTerminalEvidence(issue.id, issue.identifier, stageName);
        }
        return {
          dispatched: false,
          rightSizingDecision: null,
          disposition: "terminal_stage",
          reasonCode: "terminal_stage",
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
            disposition: "gate_lease_unavailable",
            reasonCode: "gate_lease_unavailable",
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
            disposition: "prototype_gate",
            reasonCode: "prototype_gate",
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
            disposition: "undecorrelated_gate",
            reasonCode: "undecorrelated_gate",
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
          disposition: "gate_started",
          reasonCode: "gate_started",
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
        const parkContext = this.captureWatchdogParkContext(
          issue.id,
          "breaker",
          stageName,
          null,
          null,
        );
        parkContext.issueDescription = issue.description;
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
          breakerEntry === null
            ? undefined
            : {
                failure_signature: breakerEntry.signature,
                failure_class:
                  this.signatureClusterRegistry
                    .getClusters()
                    .get(breakerEntry.signature)?.errorClass ?? "unknown",
              },
          parkContext,
        );
        console.log(
          `[orchestrator] ${issue.identifier}: parked at dispatch — circuit breaker open for stage "${stageName}"`,
        );
        return {
          dispatched: false,
          rightSizingDecision: null,
          disposition: "circuit_breaker_open",
          reasonCode: "circuit_breaker_open",
        };
      }
    }

    if (await this.enforceMergeCandidateDispatchBarrier(issue, stageName)) {
      return {
        dispatched: false,
        rightSizingDecision: null,
        disposition: "merge_candidate_barrier",
        reasonCode: "merge_candidate_barrier",
      };
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
      sameFamilyTripwire:
        (this.state.issueReviewFailureStreaks[issue.id]?.count ?? 0) >=
        SAME_FAMILY_REASONING_TRIPWIRE_COUNT,
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
        disposition: "lease_unavailable",
        reasonCode: "lease_unavailable",
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
        reasoningEffort: {
          configuredEffort:
            rightSizingDecision.reasoningEffort.configuredEffort,
          selectedEffort: rightSizingDecision.reasoningEffort.selectedEffort,
          escalated: rightSizingDecision.reasoningEffort.escalated,
          reason: rightSizingDecision.reasoningEffort.reason,
          stageEligible: rightSizingDecision.reasoningEffort.stageEligible,
          riskPredicateTriggers:
            rightSizingDecision.reasoningEffort.riskPredicateTriggers,
          matchedPaths: rightSizingDecision.reasoningEffort.matchedPaths,
          sameFamilyTripwire:
            rightSizingDecision.reasoningEffort.sameFamilyTripwire,
        },
      },
    });

    // Freeze a canonical AC snapshot at admission for issues that skip the
    // investigate AC gate (SYMPH-765). The AC gate (SYMPH-374) only freezes a
    // snapshot when an issue EXITS the initial stage, so a first dispatch to any
    // other stage (fast-track / direct-to-implement) never passes through it,
    // leaving the spec-fidelity judge a null rubric it must score as `rework` —
    // the SYMPH-759 canary false positive. The ticket author owns intent
    // (SYMPH-374's authorship chain), so the ticket-description AC section is a
    // tamper-safe canonical rubric: the implement worker cannot edit it the way
    // it edits the workpad. When the ticket carries no AC section, journal an
    // explicit `skipped` marker so spec-fidelity reports a precise stage-skipped
    // reason and stays non-gating, instead of emitting a generic
    // "no acceptance criteria" rework that parks a healthy merge.
    const skipsAcGate =
      this.config.acGate.enabled &&
      this.config.stages !== null &&
      stageName !== null &&
      stageName !== this.config.stages.initialStage;
    if (
      isFirstDispatch &&
      skipsAcGate &&
      stageName !== null &&
      this.state.issueAcSnapshots[issue.id] === undefined
      // Intentionally NOT guarded on issueStageSkippedAcGateReason (council R1,
      // Codex P1 / Opus): clearTerminalIssueRuntimeState clears
      // issueFirstDispatchedAt + issueAcSnapshots on terminal, but the journal is
      // append-only so a prior lifecycle's `ac_gate` skip row survives. Guarding
      // on the latest-skip lookup would block a fresh first-dispatch (isFirstDispatch
      // is true again) from freezing newly-added ticket AC, leaving review exit to
      // go non-gating off the stale skip. The freeze runs once per lifecycle
      // (isFirstDispatch), and its fresh `ac_gate` row supersedes any stale skip
      // because issueStageSkippedAcGateReason reads the latest row.
    ) {
      const ticketAcceptanceCriteria = extractAcceptanceCriteria(
        issue.description ?? null,
      );
      if (ticketAcceptanceCriteria !== null) {
        this.state.issueAcSnapshots[issue.id] = ticketAcceptanceCriteria;
      }
      try {
        await this.recordRunJournalEntry(
          ticketAcceptanceCriteria !== null
            ? {
                idempotencyKey: `ac_gate:${issue.id}:${stageName}:admission:${this.now().toISOString()}`,
                timestamp: this.now().toISOString(),
                kind: "ac_gate",
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                operation: "dispatcher",
                stage: stageName,
                attempt,
                ownerId: this.leaseOwnerId,
                lease: null,
                summary: `Froze ticket-description AC snapshot for ${issue.identifier} at admission (skips investigate gate).`,
                metadata: {
                  status: "completed",
                  verdict: "pass",
                  source: "ticket_admission",
                  acceptanceCriteria: ticketAcceptanceCriteria,
                  feedback: null,
                },
              }
            : {
                idempotencyKey: `ac_gate:${issue.id}:${stageName}:admission-skip:${this.now().toISOString()}`,
                timestamp: this.now().toISOString(),
                kind: "ac_gate",
                issueId: issue.id,
                issueIdentifier: issue.identifier,
                operation: "dispatcher",
                stage: stageName,
                attempt,
                ownerId: this.leaseOwnerId,
                lease: null,
                summary: `No canonical AC for ${issue.identifier}; spec-fidelity non-gating (skips investigate gate, ticket has no AC section).`,
                metadata: {
                  status: "skipped",
                  verdict: "non_gating",
                  source: "ticket_admission",
                  reason: "no_canonical_ac_stage_skipped",
                  acceptanceCriteria: null,
                },
              },
        );
      } catch (error) {
        // Audit best-effort, mirroring the AC gate write: the live process keeps
        // the in-state snapshot (judge correctness over audit purity) while a
        // failed journal write only forfeits restart rehydration.
        console.warn(
          `[orchestrator] admission AC snapshot journal write failed for ${issue.identifier}; snapshot will not survive restart: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

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
            skipsAcGate,
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
          reasoningEffort: rightSizingDecision.reasoningEffort,
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
          reasoningEffort: rightSizingDecision.reasoningEffort,
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
      this.recordExistingActiveResumeIfNeeded({
        issue,
        stageName,
        attempt,
        reworkCount,
      });
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
          reasoningEffort: rightSizingDecision.reasoningEffort,
        },
      });
      return {
        dispatched: true,
        rightSizingDecision,
        disposition: "dispatched",
        reasonCode: "dispatched",
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
        disposition: "spawn_failed",
        reasonCode: "spawn_failed",
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
    options: { emergencyStopSourceSequence?: number | null } = {},
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
        ...(reason === "emergency_stop"
          ? {
              sourceSequence: options.emergencyStopSourceSequence ?? null,
              codexAppServerPid: runningEntry.codexAppServerPid,
              codexAppServerIdentity: runningEntry.codexAppServerIdentity,
            }
          : {}),
      },
    });

    if (lease !== null) {
      if (
        reason === "manual_stop" ||
        reason === "inactive_state" ||
        reason === "emergency_stop"
      ) {
        const pausedAt = this.now().toISOString();
        this.recordIssueRequiresExplicitResume(
          runningEntry.issue.id,
          runningEntry.issue.state,
          pausedAt,
          {
            reason: reason === "emergency_stop" ? "killed_mid_run" : reason,
            setBySequence: lease.lastJournalSequence,
          },
        );
        if (reason === "emergency_stop") {
          this.requireEmergencyStopProcessCleanup(runningEntry.issue.id, {
            setBySequence: lease.lastJournalSequence,
            since: pausedAt,
          });
        }
      }
      const signalDeliveryResult = await this.stopRunningIssue?.({
        issueId: runningEntry.issue.id,
        runningEntry,
        cleanupWorkspace,
        reason,
      });
      const emergencyStopTerminationConfirmed =
        reason === "emergency_stop"
          ? isEmergencyStopTerminationConfirmed(signalDeliveryResult)
          : null;
      if (
        signalDeliveryResult === null ||
        isStopSignalDelivery(signalDeliveryResult)
      ) {
        stopRequest.signalDelivery = signalDeliveryResult;
      }
      if (
        reason === "emergency_stop" &&
        emergencyStopTerminationConfirmed === true
      ) {
        this.confirmEmergencyStopProcessCleanup(runningEntry.issue.id);
      }
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
          ...(reason === "emergency_stop"
            ? {
                sourceSequence: options.emergencyStopSourceSequence ?? null,
                codexAppServerPid: runningEntry.codexAppServerPid,
                codexAppServerIdentity: runningEntry.codexAppServerIdentity,
                emergencyStopTerminationConfirmed,
                signalDelivery: stopRequest.signalDelivery ?? null,
              }
            : {}),
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
    let clusterJournalSequence: number | null = null;
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
      clusterJournalSequence = this.commitRunJournalEntrySync({
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
          journalSequence: clusterJournalSequence,
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
      delayType: "continuation" | "failure" | "merge_actuator_poll";
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
      // Ordering invariant: clearTerminalIssueRuntimeState MUST run before
      // recordFailureExhausted (which calls recordWatchdogPark). The clear
      // deletes issuePassedStages[issueId] and issueStages[issueId] so that
      // clearIssueFromCluster runs first; recordWatchdogPark then writes the
      // fresh park generation into the now-cleared slot. Reversing this order
      // would cause the park-generation write to be immediately overwritten
      // by the clear (B-4 invariant, council R1).
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

      // retry_once grant (SYMPH-399): the single triage-authorized retry is
      // exempt from the novelty short-circuit, but a failure that recurs
      // with the SAME signature goes straight back to park with NO second
      // triage. The grant is consumed on its first post-grant failure
      // either way; a genuinely novel failure re-enters the normal ladder.
      const retryOnceGrant = this.retryOnceGrants.get(issueId);
      if (retryOnceGrant !== undefined) {
        this.retryOnceGrants.delete(issueId);
        if (
          retryOnceGrant.signature !== null &&
          incoming.signature === retryOnceGrant.signature &&
          incoming.class !== "transient"
        ) {
          const parkReason = `retry_once failed with identical signature ${incoming.signature} (${incoming.class}) — parking, no second triage`;
          const parkedTitle =
            input.issueTitle ??
            this.state.running[issueId]?.issue.title ??
            input.identifier ??
            issueId;
          this.state.failed.add(issueId);
          this.releaseClaim(issueId);
          const parkContext = this.captureWatchdogParkContext(
            issueId,
            "retry_once_failed",
            stage,
            input.error,
            attempt,
          );
          // Ordering invariant: clearTerminalIssueRuntimeState MUST run before
          // recordFailureExhausted (which calls recordWatchdogPark). See the
          // comment on the max-retry path above for the full rationale (B-4).
          this.clearTerminalIssueRuntimeState(issueId);
          // Re-register this failure in the signature cluster (council R2):
          // the retry_once intent's releaseParkedIssueState cleared the
          // issue's cluster membership, and the early return below skips the
          // shared recordFailureInCluster call at the bottom of this method —
          // without this the systemic count permanently loses the issue.
          // Recorded AFTER the terminal-state clear so the clear cannot erase
          // the membership (same ordering as the spec-failure path).
          this.recordFailureInCluster(
            issueId,
            input.identifier ?? issueId,
            incoming,
            stage,
          );
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
            parkContext,
          );
          return null;
        }
      }

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
        const parkContext = this.captureWatchdogParkContext(
          issueId,
          "novelty",
          stage,
          input.error,
          attempt,
        );
        // Ordering invariant: clearTerminalIssueRuntimeState MUST run before
        // recordFailureExhausted (which calls recordWatchdogPark). See the
        // comment on the max-retry path above for the full rationale (B-4).
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
          parkContext,
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

    let delayMs: number;
    if (input.delayType === "continuation") {
      delayMs = CONTINUATION_RETRY_DELAY_MS;
    } else if (input.delayType === "merge_actuator_poll") {
      // Orchestrator-side merge-actuator re-poll backoff (SYMPH-753). `attempt`
      // is the journal-derived poll observation count for the candidate
      // (replay-stable), so the cadence is restored after restart rather than
      // resetting to the first rung.
      delayMs = computeMergeActuatorPollDelayMs(attempt);
    } else {
      delayMs = computeFailureRetryDelayMs(
        attempt,
        this.config.agent.maxRetryBackoffMs,
      );
    }
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

  /**
   * Drop a retry-only candidate that can no longer be dispatched: an issue with
   * a pending retry timer that has left the active candidate set. Shared by the
   * onRetryTimer rate-gate reconcile (SYMPH-773) and its post-fetch "issue gone
   * from candidates" path so both dispose identically — mark failed, release the
   * claim (which cancels the retry timer and deletes the entry), clear terminal
   * runtime state, and fire the drop callback.
   */
  private dropDepartedRetryCandidate(
    issueId: string,
    identifier: string,
    title: string | null,
    url: string | null,
  ): void {
    this.state.failed.add(issueId);
    this.releaseClaim(issueId);
    this.clearTerminalIssueRuntimeState(issueId);
    this.onIssueDropped?.({
      issueId,
      identifier,
      title,
      url,
      reason: "issue no longer in candidate list",
    });
  }

  private intentIdempotencyContext(
    input: {
      verb: IntentVerb;
      issueId: string;
      anchor?: AnchorIntentPayload;
    },
    currentGen: number | null,
  ): string {
    if (input.verb === "anchor") {
      return `anchor-${this.anchorCursorContext(input.issueId)}-${hashAnchorPayload(input.anchor)}`;
    }
    if (input.verb === "unanchor") {
      this.getActiveIssueAnchor(input.issueId);
      return `anchor-${this.anchorCursorContext(input.issueId)}`;
    }
    return `gen-${currentGen ?? "none"}`;
  }

  private anchorCursorContext(issueId: string): string {
    return String(this.issueAnchorCursors.get(issueId)?.generation ?? "none");
  }

  private getActiveIssueAnchor(issueId: string): IssueAnchorRecord | null {
    const anchor = this.state.issueAnchors[issueId];
    if (anchor === undefined) {
      return null;
    }
    // Lazy expiry is a read-model cleanup, not an operator edit; it must not
    // advance the Linear field-edit cursor used for stale-webhook rejection.
    if (this.isAnchorExpired(anchor)) {
      delete this.state.issueAnchors[issueId];
      return null;
    }
    return anchor;
  }

  private isAnchorExpired(anchor: IssueAnchorRecord): boolean {
    return isIssueAnchorExpired(anchor, {
      completedIssueIds: this.state.completed,
      now: this.now(),
    });
  }

  private applyAnchorJournalEntry(entry: DispatcherRunJournalEntry): void {
    const anchor = parseAnchorMetadata(entry.metadata.anchor);
    if (anchor === null) {
      return;
    }
    const actor = parseIntentMetadataActor(entry.metadata.actor);
    const reason = parseIntentMetadataReason(entry.metadata.reason);
    const record: IssueAnchorRecord = {
      issueId: entry.issueId,
      issueIdentifier: entry.issueIdentifier,
      placement: anchor.placement,
      expiry: anchor.expiry,
      actor,
      reason,
      source: anchor.source,
      fieldName: anchor.fieldName ?? null,
      editorEmail: anchor.editorEmail ?? null,
      setAt: entry.timestamp,
      setBySequence: entry.sequence,
    };
    if (this.isAnchorExpired(record)) {
      delete this.state.issueAnchors[entry.issueId];
      this.recordAnchorCursorFromJournalEntry(entry);
      return;
    }
    this.state.issueAnchors[entry.issueId] = record;
    this.recordAnchorCursorFromJournalEntry(entry);
  }

  private recordAnchorCursorFromJournalEntry(
    entry: DispatcherRunJournalEntry,
  ): void {
    const timestampMs =
      parseAnchorCursorTimestamp(entry.metadata.anchorEditedAt) ??
      Date.parse(entry.timestamp);
    this.recordAnchorCursor(
      entry.issueId,
      Number.isFinite(timestampMs) ? timestampMs : this.now().getTime(),
      entry.sequence,
    );
  }

  private anchorCursorTimestampForIntent(
    input: {
      extraMetadata?: Record<string, unknown>;
    },
    journalTimestamp?: string,
  ): number {
    const parsedJournalTimestamp =
      journalTimestamp === undefined
        ? Number.NaN
        : Date.parse(journalTimestamp);
    return (
      parseAnchorCursorTimestamp(input.extraMetadata?.anchorEditedAt) ??
      (Number.isFinite(parsedJournalTimestamp)
        ? parsedJournalTimestamp
        : null) ??
      this.now().getTime()
    );
  }

  private recordAnchorCursor(
    issueId: string,
    atMs: number,
    generationHint?: number,
  ): void {
    const generation = Math.max(
      this.anchorCursorSequence + 1,
      generationHint ?? 0,
    );
    this.anchorCursorSequence = generation;
    this.issueAnchorCursors.set(issueId, { generation, atMs });
  }

  private recordAnchorCursorForNoOpFieldEdit(
    issueId: string,
    editedAtMs: number,
    result: Pick<IntentWriteResult, "status" | "sequence">,
  ): void {
    if (result.status !== "no_op") {
      return;
    }
    this.recordAnchorCursor(issueId, editedAtMs, result.sequence ?? undefined);
  }

  private async recordInvalidAnchorFieldEdit(args: {
    input: {
      issueId: string;
      issueIdentifier: string;
      fieldName: string;
      editedAt: string;
    };
    actor: IntentActor;
    editorEmail: string;
    editedAtMs: number;
    detail: string;
  }): Promise<number | null> {
    const actorKey = formatIntentActorKey(args.actor);
    const journalInput: IntentWriteInput = {
      verb: "anchor",
      issueId: args.input.issueId,
      issueIdentifier: args.input.issueIdentifier,
      actor: args.actor,
      reason: {
        class: "linear_field_edit_anchor_invalid",
        human: `Linear field "${args.input.fieldName}" rejected by ${args.editorEmail}`,
      },
      renderComment: false,
      extraMetadata: {
        anchorEditedAt: args.input.editedAt,
        anchorFieldEditStatus: "invalid",
        fieldName: args.input.fieldName,
        editorEmail: args.editorEmail,
      },
    };
    const sequence = await this.recordIntentJournalEntry({
      input: journalInput,
      status: "no_op",
      detail: args.detail,
      generation: this.issueParkGenerations.get(args.input.issueId) ?? null,
      idempotencyKey: `intent:anchor:${args.input.issueId}:${actorKey}:field-edit-invalid:${args.input.editedAt}`,
    });
    this.recordAnchorCursor(
      args.input.issueId,
      args.editedAtMs,
      sequence ?? undefined,
    );
    return sequence;
  }
}

export function sortIssuesForDispatch(issues: readonly Issue[]): Issue[] {
  return sortIssuesForDispatchByPriorityFifo(issues);
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

/**
 * Delay for the Nth orchestrator-side merge-actuator re-poll (SYMPH-753).
 * `attempt` is 1-based (the prior poll/wait observation count for the
 * candidate, derived from the durable journal). Walks the
 * {@link MERGE_ACTUATOR_POLL_BACKOFF_MS} ladder and holds at the last (capped)
 * rung for any further attempt; a non-positive attempt floors to the first rung.
 */
export function computeMergeActuatorPollDelayMs(attempt: number): number {
  const lastIndex = MERGE_ACTUATOR_POLL_BACKOFF_MS.length - 1;
  const index = Math.min(Math.max(attempt, 1) - 1, lastIndex);
  // index is clamped to [0, lastIndex]; the ladder is a non-empty const.
  return MERGE_ACTUATOR_POLL_BACKOFF_MS[index] as number;
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

function resumeRequiredReasonForHardStop(hardStop: HardStopDecision): string {
  if (hardStop.trigger !== "worker_reported_block") {
    return `hard_stop:${hardStop.trigger}`;
  }

  switch (hardStop.humanBlockOperation) {
    case "pr_creation":
      return "human_blocked:pr_creation_denied";
    case "auto_merge":
      return "human_blocked:auto_merge_denied";
    case "gate_bypass":
      return "human_blocked:gate_bypass_denied";
    default:
      return "human_blocked:mode_permission_denied";
  }
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

function createDefaultLeaseOwnerId(): string {
  return `orchestrator-core:${hostname()}:${process.pid}`;
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
  if (metadata.aggregate === "error") {
    return "failed";
  }
  return null;
}

function toGateAggregate(value: unknown): "pass" | "fail" | "error" | null {
  return value === "pass" || value === "fail" || value === "error"
    ? value
    : null;
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

function readContinuousFeedbackStateRecord(
  value: unknown,
): Record<string, ContinuousFeedbackIssueState> {
  if (!isRecord(value)) {
    return {};
  }

  const feedback: Record<string, ContinuousFeedbackIssueState> = {};
  for (const [issueId, rawState] of Object.entries(value)) {
    if (!isRecord(rawState)) {
      continue;
    }
    const summary =
      typeof rawState.summary === "string" ? rawState.summary : null;
    const rawStatus = rawState.status;
    const parsedStatus = toContinuousFeedbackStatus(rawStatus);
    const status = projectContinuousFeedbackStatus(parsedStatus, summary, {
      allowLegacySummaryProjection: false,
    });
    if (parsedStatus === null && rawStatus !== undefined) {
      console.warn(
        `[orchestrator] Recovered continuous-feedback checkpoint state for ${issueId} with corrupt status ${JSON.stringify(rawStatus)} as pass.`,
      );
    }
    feedback[issueId] = {
      ...(clonePlain(rawState) as unknown as ContinuousFeedbackIssueState),
      status: status ?? "pass",
      summary,
    };
  }
  return feedback;
}

function toContinuousFeedbackEvent(
  value: unknown,
): ContinuousFeedbackEvent | null {
  return value === "commit" || value === "diff" || value === "checkpoint"
    ? value
    : null;
}

function toContinuousFeedbackLane(
  value: unknown,
): ContinuousFeedbackLane | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.runner !== "string" ||
    typeof value.role !== "string" ||
    (value.model !== null && typeof value.model !== "string")
  ) {
    return null;
  }

  return {
    runner: value.runner,
    model: value.model,
    role: value.role,
  };
}

function toContinuousFeedbackStatus(
  value: unknown,
): ContinuousFeedbackStatus | null {
  return value === "pass" || value === "finding" || value === "unavailable"
    ? value
    : null;
}

function projectContinuousFeedbackStatus(
  status: ContinuousFeedbackStatus | null,
  summary: string | null,
  options: { allowLegacySummaryProjection: boolean },
): ContinuousFeedbackStatus | null {
  if (
    options.allowLegacySummaryProjection &&
    status === "pass" &&
    summary !== null &&
    summary
      .trim()
      .toLowerCase()
      .startsWith(
        `${CONTINUOUS_FEEDBACK_PROVIDER_FAILURE_SUMMARY_PREFIX.toLowerCase()} `,
      )
  ) {
    return "unavailable";
  }
  return status;
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

type ParsedAnchorFieldEdit =
  | "unanchor"
  | Pick<AnchorIntentPayload, "placement" | "expiry">;

function parseAnchorFieldEditValue(
  value: string | null,
): ParsedAnchorFieldEdit | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || trimmed.toLowerCase() === "unanchor") {
    return "unanchor";
  }

  const tokens = trimmed.split(/\s+/);
  const placementKind = tokens[0]?.toLowerCase();
  let placement: IssueAnchorPlacement;
  let expiryStart = 1;
  if (placementKind === "top") {
    placement = { kind: "top" };
  } else if (placementKind === "above" || placementKind === "below") {
    const issueIdentifier = tokens[1];
    if (issueIdentifier === undefined || issueIdentifier.trim() === "") {
      return null;
    }
    placement = { kind: placementKind, issueIdentifier };
    expiryStart = 2;
  } else {
    return null;
  }

  const expiryToken = tokens[expiryStart]?.toLowerCase();
  if (expiryToken === "until-merged") {
    if (tokens.length !== expiryStart + 1) {
      return null;
    }
    return { placement, expiry: { kind: "until_merged" } };
  }
  if (expiryToken === "until") {
    const rawDate = tokens.slice(expiryStart + 1).join(" ");
    const parsed = parseAnchorUntilTimestamp(rawDate);
    if (parsed === null) {
      return null;
    }
    return {
      placement,
      expiry: { kind: "until_date", at: parsed },
    };
  }
  return null;
}

function normalizeAnchorFieldName(value: string): string {
  return value.trim().toLowerCase();
}

function parseAnchorCursorTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hashAnchorPayload(anchor: AnchorIntentPayload | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalAnchorPayload(anchor)))
    .digest("hex")
    .slice(0, 16);
}

type CanonicalAnchorPayloadSource = Pick<
  IssueAnchorRecord,
  "placement" | "expiry" | "source" | "fieldName" | "editorEmail"
>;

function canonicalAnchorPayload(
  anchor: AnchorIntentPayload | CanonicalAnchorPayloadSource | undefined,
): Record<string, unknown> {
  if (anchor === undefined) {
    return { missing: true };
  }
  return {
    placement: anchor.placement,
    expiry: anchor.expiry,
    source: anchor.source,
    fieldName: anchor.fieldName ?? null,
    editorEmail:
      anchor.editorEmail === undefined || anchor.editorEmail === null
        ? null
        : normalizeAccountEmail(anchor.editorEmail),
  };
}

function anchorPayloadMatchesRecord(
  payload: AnchorIntentPayload,
  record: IssueAnchorRecord,
): boolean {
  return (
    anchorPlacementsEqual(payload.placement, record.placement) &&
    anchorExpiriesEqual(payload.expiry, record.expiry) &&
    payload.source === record.source &&
    (payload.fieldName ?? null) === record.fieldName &&
    normalizeNullableEmail(payload.editorEmail) ===
      normalizeNullableEmail(record.editorEmail)
  );
}

function anchorPlacementsEqual(
  left: IssueAnchorPlacement,
  right: IssueAnchorPlacement,
): boolean {
  switch (left.kind) {
    case "top":
      return right.kind === "top";
    case "above":
    case "below":
      return (
        right.kind === left.kind &&
        normalizeIssueIdentifier(left.issueIdentifier) ===
          normalizeIssueIdentifier(right.issueIdentifier)
      );
  }
}

function anchorExpiriesEqual(
  left: IssueAnchorExpiry,
  right: IssueAnchorExpiry,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "until_merged" || right.kind === "until_merged") {
    return true;
  }
  return left.at === right.at;
}

function normalizeNullableEmail(
  value: string | null | undefined,
): string | null {
  return value === undefined || value === null
    ? null
    : normalizeAccountEmail(value);
}

function formatAnchorPlacement(placement: IssueAnchorPlacement): string {
  if (placement.kind === "top") {
    return "at top";
  }
  return `${placement.kind} ${placement.issueIdentifier}`;
}

function formatAnchorExpiry(expiry: IssueAnchorExpiry): string {
  return expiry.kind === "until_merged" ? "until merged" : `until ${expiry.at}`;
}

function parseAnchorMetadata(value: unknown): AnchorIntentPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const placement = parseAnchorPlacementMetadata(value.placement);
  const expiry = parseAnchorExpiryMetadata(value.expiry);
  const source = value.source;
  if (
    placement === null ||
    expiry === null ||
    (source !== "symphonyctl" &&
      source !== "api" &&
      source !== "linear_field_edit")
  ) {
    return null;
  }
  return {
    placement,
    expiry,
    source,
    fieldName: typeof value.fieldName === "string" ? value.fieldName : null,
    editorEmail:
      typeof value.editorEmail === "string" ? value.editorEmail : null,
  };
}

function parseAnchorPlacementMetadata(
  value: unknown,
): IssueAnchorPlacement | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "top") {
    return { kind: "top" };
  }
  if (
    (value.kind === "above" || value.kind === "below") &&
    typeof value.issueIdentifier === "string" &&
    value.issueIdentifier.trim() !== ""
  ) {
    return {
      kind: value.kind,
      issueIdentifier: value.issueIdentifier,
    };
  }
  return null;
}

function parseAnchorExpiryMetadata(value: unknown): IssueAnchorExpiry | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "until_merged") {
    return { kind: "until_merged" };
  }
  if (
    value.kind === "until_date" &&
    typeof value.at === "string" &&
    !Number.isNaN(Date.parse(value.at))
  ) {
    return { kind: "until_date", at: new Date(value.at).toISOString() };
  }
  return null;
}

function parseIntentMetadataActor(value: unknown): IssueAnchorRecord["actor"] {
  if (!isRecord(value)) {
    return { kind: "unknown", host: "unknown", session: null };
  }
  return {
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    host: typeof value.host === "string" ? value.host : "unknown",
    session: typeof value.session === "string" ? value.session : null,
  };
}

function parseIntentMetadataReason(
  value: unknown,
): IssueAnchorRecord["reason"] {
  if (!isRecord(value)) {
    return { class: "unknown", human: "unknown" };
  }
  return {
    class: typeof value.class === "string" ? value.class : "unknown",
    human: typeof value.human === "string" ? value.human : "unknown",
  };
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

function extractReviewGateResultPath(
  message: string | null | undefined,
): string | null {
  if (message === null || message === undefined) {
    return null;
  }
  const markerStart = message.indexOf(REVIEW_GATE_RESULT_PATH_PREFIX);
  if (markerStart === -1) {
    return null;
  }
  const valueStart = markerStart + REVIEW_GATE_RESULT_PATH_PREFIX.length;
  const markerEnd = message.indexOf(REVIEW_GATE_RESULT_PATH_SUFFIX, valueStart);
  if (markerEnd === -1) {
    return null;
  }
  const rawPath = message.slice(valueStart, markerEnd);
  if (rawPath.includes("\r") || rawPath.includes("\n")) {
    return null;
  }
  const path = rawPath.trim();
  return path === "" ? null : path;
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
  if (isServiceShutdownAbortReason(reason)) {
    return "restart_interrupted";
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

export const SERVICE_SHUTDOWN_ABORT_REASON =
  "Shutdown: aborting running workers.";

function isServiceShutdownAbortReason(reason: string | undefined): boolean {
  if (reason === undefined) {
    return false;
  }
  return reason.trim() === SERVICE_SHUTDOWN_ABORT_REASON;
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

function isStopReason(value: unknown): value is StopReason {
  return (
    value === "terminal_state" ||
    value === "inactive_state" ||
    value === "stall_timeout" ||
    value === "manual_stop" ||
    value === "emergency_stop"
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

function readMetadataNumber(
  metadata: Record<string, unknown> | null,
  key: string,
): number | null {
  if (metadata === null) {
    return null;
  }
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readMetadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string,
): boolean | null {
  if (metadata === null) {
    return null;
  }
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

function collectOperatorIntentSamples(
  journal: DispatcherRunJournal,
  sinceSequence = 0,
): Array<Record<string, unknown>> {
  return journal.flatMap((entry) => {
    if (
      entry.sequence <= sinceSequence ||
      entry.kind !== "intent" ||
      readMetadataString(entry.metadata, "status") !== "applied"
    ) {
      return [];
    }
    const actor = entry.metadata.actor;
    const actorKind =
      typeof actor === "object" &&
      actor !== null &&
      !Array.isArray(actor) &&
      typeof (actor as { kind?: unknown }).kind === "string"
        ? (actor as { kind: string }).kind
        : null;
    if (actorKind !== "operator") {
      return [];
    }
    return [
      {
        sequence: entry.sequence,
        issue_id: entry.issueId,
        issue_identifier: entry.issueIdentifier,
        verb: readMetadataString(entry.metadata, "verb") ?? "unknown",
        stage: entry.stage,
      },
    ];
  });
}

function readMetadataRecord(
  metadata: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = metadata[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDispatchFenceMetadata(
  metadata: Record<string, unknown>,
  source: { timestamp: string; sequence: number | null },
): DispatchFenceState | null {
  const fence = readMetadataRecord(metadata, "dispatchFence");
  if (fence === null) {
    return null;
  }
  const issueIdentifiers = normalizeDispatchFenceIdentifiers(
    readStringArray(fence.issueIdentifiers),
  );
  if (issueIdentifiers.length === 0) {
    return null;
  }
  const fenceSource = readRecordString(fence, "source");
  if (fenceSource !== "symphonyctl" && fenceSource !== "api") {
    return null;
  }
  const actor = readMetadataRecord(metadata, "actor");
  const reason = readMetadataRecord(metadata, "reason");
  return {
    active: true,
    issueIdentifiers,
    source: fenceSource,
    actor: {
      kind: readRecordString(actor, "kind") ?? "operator",
      host: readRecordString(actor, "host") ?? "unknown",
      session: readRecordString(actor, "session"),
    },
    reason: {
      class: readRecordString(reason, "class") ?? "operator_dispatch_fence",
      human: readRecordString(reason, "human") ?? "dispatch fence requested",
    },
    setAt: source.timestamp,
    setBySequence: source.sequence,
    clearing: "explicit",
  };
}

function normalizeDispatchFenceIdentifiers(
  issueIdentifiers: readonly string[],
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const identifier of issueIdentifiers) {
    const value = normalizeIssueIdentifier(identifier);
    if (value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readRecordString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readInterruptedIssues(
  metadata: Record<string, unknown>,
): PipelineEmergencyStopState["interruptedIssues"] {
  const value = metadata.interruptedIssues;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const issueId = record.issueId;
    const issueIdentifier = record.issueIdentifier;
    if (typeof issueId !== "string" || typeof issueIdentifier !== "string") {
      return [];
    }
    const stage = record.stage;
    const attempt = record.attempt;
    const codexAppServerPid = record.codexAppServerPid;
    const codexAppServerIdentity = readProcessIdentityMetadata(
      record.codexAppServerIdentity,
    );
    return [
      {
        issueId,
        issueIdentifier,
        stage: typeof stage === "string" ? stage : null,
        attempt:
          typeof attempt === "number" && Number.isFinite(attempt)
            ? attempt
            : null,
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

function collectQuietDeathOutcomes(
  journal: DispatcherRunJournal,
  sinceSequence = 0,
): Array<Record<string, unknown>> {
  return journal.flatMap((entry) =>
    entry.sequence > sinceSequence && entry.kind === "failure_exhausted"
      ? [
          {
            sequence: entry.sequence,
            issue_id: entry.issueId,
            issue_identifier: entry.issueIdentifier,
            reason: readMetadataString(entry.metadata, "reason"),
            failure_signature: readMetadataString(
              entry.metadata,
              "failure_signature",
            ),
            failure_class: readMetadataString(entry.metadata, "failure_class"),
          },
        ]
      : [],
  );
}

function collectUrgentReopenOutcomes(
  journal: DispatcherRunJournal,
  sinceSequence = 0,
  operatorIntentSamples = collectOperatorIntentSamples(journal, sinceSequence),
): Array<Record<string, unknown>> {
  const deathSequencesByIssue = new Map<string, number[]>();
  for (const entry of journal) {
    if (entry.kind !== "failure_exhausted") {
      continue;
    }
    const sequences = deathSequencesByIssue.get(entry.issueId) ?? [];
    sequences.push(entry.sequence);
    deathSequencesByIssue.set(entry.issueId, sequences);
  }

  // The observed baseline outcome is the operator reopen in this window; the
  // failure it reopens can legitimately predate the window.
  return operatorIntentSamples.flatMap((sample) => {
    const issueId = typeof sample.issue_id === "string" ? sample.issue_id : "";
    const sequence =
      typeof sample.sequence === "number" ? sample.sequence : Number.NaN;
    const verb = typeof sample.verb === "string" ? sample.verb : "";
    if (
      !["release", "retry_once", "rework_with_hint", "resume"].includes(verb)
    ) {
      return [];
    }
    const reopenedAfter = (deathSequencesByIssue.get(issueId) ?? [])
      .filter((deathSequence) => deathSequence < sequence)
      .at(-1);
    return reopenedAfter === undefined
      ? []
      : [{ ...sample, reopened_after_sequence: reopenedAfter }];
  });
}

function collectDeliveryOutcomes(
  journal: DispatcherRunJournal,
  sinceSequence = 0,
): Array<Record<string, unknown>> {
  const historyByIssue = new Map<
    string,
    Array<{ sequence: number; stageRecord: StageRecord }>
  >();
  for (const entry of journal) {
    if (
      entry.sequence <= sinceSequence ||
      entry.kind !== "stage_record" ||
      readMetadataString(entry.metadata, "status") !== "completed"
    ) {
      continue;
    }
    const stageRecord = toStageRecordFromMetadata(entry.metadata);
    if (stageRecord === null) {
      continue;
    }
    const history = historyByIssue.get(entry.issueId) ?? [];
    history.push({ sequence: entry.sequence, stageRecord });
    historyByIssue.set(entry.issueId, history);
  }

  const previousTerminalSequenceByIssue = new Map<string, number>();
  return journal.flatMap((entry) => {
    if (
      entry.sequence <= sinceSequence ||
      entry.kind !== "tracker_write" ||
      !entry.idempotencyKey.includes(":terminal:") ||
      !entry.idempotencyKey.endsWith(":completed")
    ) {
      return [];
    }
    const previousTerminalSequence =
      previousTerminalSequenceByIssue.get(entry.issueId) ?? sinceSequence;
    previousTerminalSequenceByIssue.set(entry.issueId, entry.sequence);
    const history = (historyByIssue.get(entry.issueId) ?? []).filter(
      (stageEntry) =>
        stageEntry.sequence > previousTerminalSequence &&
        stageEntry.sequence <= entry.sequence,
    );
    const totalTokens = history.reduce(
      (sum, { stageRecord }) => sum + stageRecord.totalTokens,
      0,
    );
    const turns = history.reduce(
      (sum, { stageRecord }) => sum + stageRecord.turns,
      0,
    );
    return [
      {
        sequence: entry.sequence,
        issue_id: entry.issueId,
        issue_identifier: entry.issueIdentifier,
        terminal_stage: entry.stage,
        delivered_at: entry.timestamp,
        spend: {
          scope: "baseline_window",
          since_sequence: sinceSequence,
          total_tokens: totalTokens,
          turns,
          stages: history.length,
        },
      },
    ];
  });
}

function countUniqueComputedOrderExclusionIssues(
  computedOrder: ComputedDispatchOrderSnapshot | null | undefined,
): number | null {
  if (computedOrder === null || computedOrder === undefined) {
    return null;
  }
  return new Set(
    computedOrder.exclusions.map((exclusion) => exclusion.issue_id),
  ).size;
}

function resolveQueueBaselineOutcomeWindow(journal: DispatcherRunJournal): {
  sinceSequence: number;
  asOfSequence: number;
  scannedEntryCount: number;
  anchor: "previous_queue_baseline" | "current_tail_first_sample";
} {
  const previousBaseline = journal.findLast(
    (entry) => entry.kind === "queue_baseline",
  );
  const asOfSequence = readJournalTailSequence(journal);
  const sinceSequence = previousBaseline?.sequence ?? asOfSequence;
  return {
    sinceSequence,
    asOfSequence,
    scannedEntryCount: journal.filter((entry) => entry.sequence > sinceSequence)
      .length,
    anchor:
      previousBaseline === undefined
        ? "current_tail_first_sample"
        : "previous_queue_baseline",
  };
}

function readJournalTailSequence(journal: DispatcherRunJournal): number {
  return journal.reduce((tail, entry) => Math.max(tail, entry.sequence), 0);
}

function formatWarningError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function formatBoundedWarningError(error: unknown): string {
  const formatted = formatWarningError(error);
  return formatted.length > 1_000
    ? `${formatted.slice(0, 1_000)}...`
    : formatted;
}

function createDispatchComparatorFailureSnapshot(input: {
  generatedAt: Date;
  warning: string;
}): ComputedDispatchOrderSnapshot {
  return {
    comparator_version: DISPATCH_COMPARATOR_VERSION,
    generated_at: input.generatedAt.toISOString(),
    status: "linearized",
    positions: [],
    exclusions: [],
    advisory_warnings: [],
    would_have_been_excluded_by_advisory_edges: [],
    hard_cycle: null,
    hard_cycles: [],
    hard_cycle_omitted_count: 0,
    superseded_native_hard_blockers: [],
    warnings: [input.warning],
  };
}

function createPendingStageSignal(
  stageName: string | null,
  agentMessage: string | undefined,
  attempt: number | null,
  setBySequence: number | null = null,
): PendingStageSignal | null {
  if (agentMessage === undefined) {
    return null;
  }
  const failureSignal = parseFailureSignal(agentMessage);
  if (failureSignal !== null) {
    return {
      signal: "failure",
      stageName,
      attempt,
      agentMessage,
      failureClass: failureSignal.failureClass,
      setBySequence,
    };
  }
  if (containsStageCompleteSignal(agentMessage)) {
    return {
      signal: "complete",
      stageName,
      attempt,
      agentMessage,
      failureClass: null,
      setBySequence,
    };
  }
  return null;
}

function pendingStageSignalMetadata(
  pending: PendingStageSignal | null,
): Record<string, unknown> {
  if (pending === null) {
    return {};
  }
  return {
    pendingStageSignal: pending.signal,
    pendingStageName: pending.stageName,
    pendingAttempt: pending.attempt,
    pendingAgentMessage: pending.agentMessage,
    pendingFailureClass: pending.failureClass,
  };
}

function readPendingStageSignalMetadata(
  entry: DispatcherRunJournalEntry,
): PendingStageSignal | null {
  const signal = readMetadataString(entry.metadata, "pendingStageSignal");
  if (signal !== "complete" && signal !== "failure") {
    return null;
  }
  const agentMessage = readMetadataString(
    entry.metadata,
    "pendingAgentMessage",
  );
  if (agentMessage === null) {
    return null;
  }
  const stageName = readMetadataString(entry.metadata, "pendingStageName");
  const attempt = readMetadataNumber(entry.metadata, "pendingAttempt");
  const failureClass = readMetadataString(
    entry.metadata,
    "pendingFailureClass",
  );
  if (signal === "failure") {
    if (!isFailureClass(failureClass)) {
      console.warn(
        `[orchestrator] pending stage signal recovery dropped failure signal for ${entry.issueIdentifier}: missing or invalid failure class in journal sequence ${entry.sequence}.`,
      );
      return null;
    }
    return {
      signal,
      stageName,
      attempt: attempt ?? entry.attempt,
      agentMessage,
      failureClass,
      setBySequence: entry.sequence,
    };
  }
  return {
    signal,
    stageName,
    attempt: attempt ?? entry.attempt,
    agentMessage,
    failureClass: null,
    setBySequence: entry.sequence,
  };
}

function isFailureClass(value: string | null): value is FailureClass {
  return (
    value !== null && (FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

// Public state clone only. Private orchestrator cursors/registries that live
// outside OrchestratorState must be snapshotted by the caller; pending-stage
// rollback does that explicitly for anchor cursors and park generations.
function cloneOrchestratorState(state: OrchestratorState): OrchestratorState {
  return {
    pollIntervalMs: state.pollIntervalMs,
    maxConcurrentAgents: state.maxConcurrentAgents,
    running: cloneRecord(state.running, cloneRunningEntry),
    claimed: new Set(state.claimed),
    retryAttempts: cloneRecord(state.retryAttempts, cloneRetryEntry),
    completed: new Set(state.completed),
    failed: new Set(state.failed),
    resumeRequired: new Set(state.resumeRequired),
    resumeRequiredMarks: clonePlain(state.resumeRequiredMarks),
    issueAnchors: clonePlain(state.issueAnchors),
    dispatchFence: clonePlain(state.dispatchFence),
    computedDispatchOrder: clonePlain(state.computedDispatchOrder),
    emergencyStop: clonePlain(state.emergencyStop),
    pipelinePause: clonePlain(state.pipelinePause),
    codexTotals: clonePlain(state.codexTotals),
    codexRateLimits: clonePlain(state.codexRateLimits),
    codexRateLimitsObservedAt: state.codexRateLimitsObservedAt,
    rateLimitAdmission: clonePlain(state.rateLimitAdmission),
    issueStages: clonePlain(state.issueStages),
    issuePendingStageSignals: clonePlain(state.issuePendingStageSignals),
    issueBudgetEscalations: clonePlain(state.issueBudgetEscalations),
    issuePauseTriageResumes: clonePlain(state.issuePauseTriageResumes),
    issueReworkCounts: clonePlain(state.issueReworkCounts),
    issuePassedStages: clonePlain(state.issuePassedStages),
    issueFirstDispatchedAt: clonePlain(state.issueFirstDispatchedAt),
    issueExecutionHistory: clonePlain(state.issueExecutionHistory),
    issueRightSizingDecisions: clonePlain(state.issueRightSizingDecisions),
    issueAcSnapshots: clonePlain(state.issueAcSnapshots),
    decorrelatedGateOutcomes: clonePlain(state.decorrelatedGateOutcomes),
    loopTraceJournal: clonePlain(state.loopTraceJournal),
    continuousFeedback: clonePlain(state.continuousFeedback),
    dispatcherRunJournal: clonePlain(state.dispatcherRunJournal),
    dispatcherLeases: clonePlain(state.dispatcherLeases),
    managerRunJournal: clonePlain(state.managerRunJournal),
    managerRuns: clonePlain(state.managerRuns),
    issueFailureSignatures: clonePlain(state.issueFailureSignatures),
    issueDispositions: clonePlain(state.issueDispositions),
    issueReviewFailureStreaks: clonePlain(state.issueReviewFailureStreaks),
    issueReviewInfrastructureStalls: clonePlain(
      state.issueReviewInfrastructureStalls,
    ),
    failureExhaustedIds: new Set(state.failureExhaustedIds),
  };
}

function restoreOrchestratorState(
  target: OrchestratorState,
  snapshot: OrchestratorState,
): void {
  target.pollIntervalMs = snapshot.pollIntervalMs;
  target.maxConcurrentAgents = snapshot.maxConcurrentAgents;
  target.running = snapshot.running;
  target.claimed = snapshot.claimed;
  target.retryAttempts = snapshot.retryAttempts;
  target.completed = snapshot.completed;
  target.failed = snapshot.failed;
  target.resumeRequired = snapshot.resumeRequired;
  target.resumeRequiredMarks = snapshot.resumeRequiredMarks;
  target.issueAnchors = snapshot.issueAnchors;
  target.dispatchFence = snapshot.dispatchFence;
  target.computedDispatchOrder = snapshot.computedDispatchOrder;
  target.emergencyStop = snapshot.emergencyStop;
  target.pipelinePause = snapshot.pipelinePause;
  target.codexTotals = snapshot.codexTotals;
  target.codexRateLimits = snapshot.codexRateLimits;
  target.codexRateLimitsObservedAt = snapshot.codexRateLimitsObservedAt;
  target.rateLimitAdmission = snapshot.rateLimitAdmission;
  target.issueStages = snapshot.issueStages;
  target.issuePendingStageSignals = snapshot.issuePendingStageSignals;
  target.issueBudgetEscalations = snapshot.issueBudgetEscalations;
  target.issuePauseTriageResumes = snapshot.issuePauseTriageResumes;
  target.issueReworkCounts = snapshot.issueReworkCounts;
  target.issuePassedStages = snapshot.issuePassedStages;
  target.issueFirstDispatchedAt = snapshot.issueFirstDispatchedAt;
  target.issueExecutionHistory = snapshot.issueExecutionHistory;
  target.issueRightSizingDecisions = snapshot.issueRightSizingDecisions;
  target.issueAcSnapshots = snapshot.issueAcSnapshots;
  target.decorrelatedGateOutcomes = snapshot.decorrelatedGateOutcomes;
  target.loopTraceJournal = snapshot.loopTraceJournal;
  target.continuousFeedback = snapshot.continuousFeedback;
  target.dispatcherRunJournal = snapshot.dispatcherRunJournal;
  target.dispatcherLeases = snapshot.dispatcherLeases;
  target.managerRunJournal = snapshot.managerRunJournal;
  target.managerRuns = snapshot.managerRuns;
  target.issueFailureSignatures = snapshot.issueFailureSignatures;
  target.issueDispositions = snapshot.issueDispositions;
  target.issueReviewFailureStreaks = snapshot.issueReviewFailureStreaks;
  target.issueReviewInfrastructureStalls =
    snapshot.issueReviewInfrastructureStalls;
  target.failureExhaustedIds = snapshot.failureExhaustedIds;
}

function cloneRunningEntry(entry: RunningEntry): RunningEntry {
  const { workerHandle, monitorHandle, ...cloneable } = entry;
  return {
    ...clonePlain(cloneable),
    workerHandle,
    monitorHandle,
  };
}

function cloneRetryEntry(entry: RetryEntry): RetryEntry {
  const { timerHandle, ...cloneable } = entry;
  return {
    ...clonePlain(cloneable),
    timerHandle,
  };
}

function cloneExecutionHistoryMap(
  source: Map<string, ExecutionHistory>,
): Map<string, ExecutionHistory> {
  return new Map(
    [...source.entries()].map(([issueId, history]) => [
      issueId,
      clonePlain(history),
    ]),
  );
}

function cloneResumeRequiredGuards(
  source: Map<string, ResumeRequiredGuard>,
): Map<string, ResumeRequiredGuard> {
  return new Map(
    [...source.entries()].map(([issueId, guard]) => [
      issueId,
      clonePlain(guard),
    ]),
  );
}

function cloneRecord<T>(
  record: Record<string, T>,
  cloneValue: (value: T) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, cloneValue(value)]),
  ) as Record<string, T>;
}

function clonePlain<T>(value: T): T {
  // Rollback snapshots intentionally require state payloads to stay structured-
  // cloneable. Worker, monitor, and timer handles are excluded by their typed
  // clone helpers and reattached by reference.
  return structuredClone(value);
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) {
    target.set(key, value);
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readRecordOr<T>(value: unknown, fallback: T): T {
  return isRecord(value) ? (clonePlain(value) as T) : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function restoreStringSet(target: Set<string>, value: unknown): void {
  target.clear();
  for (const entry of readStringArray(value)) {
    target.add(entry);
  }
}

function restoreStringStringMap(
  target: Map<string, string>,
  value: unknown,
): void {
  target.clear();
  for (const [key, entryValue] of readEntryPairs(value)) {
    if (typeof entryValue === "string") {
      target.set(key, entryValue);
    }
  }
}

function restoreStringNumberMap(
  target: Map<string, number>,
  value: unknown,
): void {
  target.clear();
  for (const [key, entryValue] of readEntryPairs(value)) {
    if (typeof entryValue === "number") {
      target.set(key, entryValue);
    }
  }
}

function restoreStringNullableNumberMap(
  target: Map<string, number | null>,
  value: unknown,
): void {
  target.clear();
  for (const [key, entryValue] of readEntryPairs(value)) {
    if (entryValue === null || typeof entryValue === "number") {
      target.set(key, entryValue);
    }
  }
}

function restoreStringRecordMap<T>(
  target: Map<string, T>,
  value: unknown,
): void {
  target.clear();
  for (const [key, entryValue] of readEntryPairs(value)) {
    if (isRecord(entryValue)) {
      target.set(key, clonePlain(entryValue) as T);
    }
  }
}

function readEntryPairs(value: unknown): Array<[string, unknown]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): Array<[string, unknown]> => {
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string"
    ) {
      return [[entry[0], entry[1]]];
    }
    return [];
  });
}

function createPendingRunningEntry(input: {
  issue: Issue;
  identifier: string;
  attempt: number | null;
  agentMessage: string;
}): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    issue: input.issue,
    identifier: input.identifier,
    retryAttempt: normalizeRetryAttempt(input.attempt),
    startedAt: formatEasternTimestamp(new Date(0)),
    workerHandle: null,
    monitorHandle: null,
    failureReason: null,
    lastCodexMessage: input.agentMessage,
    lastCodexTimestamp: null,
    turnCount: 0,
  };
}

function createReplayIssue(issueId: string, issueIdentifier: string): Issue {
  return {
    id: issueId,
    identifier: issueIdentifier,
    title: issueIdentifier,
    description: null,
    priority: null,
    state: "",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Mark reason for an intent-driven park/halt (SYMPH-406): the verb plus the
 * journaled intent reason class, e.g. "intent:park:manual_stop".
 */
function formatIntentMarkReason(
  verb: string,
  metadata: Record<string, unknown>,
): string {
  const reason = metadata.reason;
  const reasonClass =
    typeof reason === "object" &&
    reason !== null &&
    typeof (reason as { class?: unknown }).class === "string"
      ? (reason as { class: string }).class
      : null;
  return reasonClass === null
    ? `intent:${verb}`
    : `intent:${verb}:${reasonClass}`;
}

/**
 * Reconstruct a StageRecord from a journaled stage_record entry's metadata
 * (SYMPH-401). Returns null for malformed/legacy entries — replay tolerates
 * the gap (spend under-counts rather than crashing recovery).
 */
function toStageRecordFromMetadata(
  metadata: Record<string, unknown>,
): StageRecord | null {
  const stageName = readMetadataString(metadata, "stageName");
  const durationMs = readMetadataNumber(metadata, "durationMs");
  const totalTokens = readMetadataNumber(metadata, "totalTokens");
  const turns = readMetadataNumber(metadata, "turns");
  const outcome = readMetadataString(metadata, "outcome");
  if (
    stageName === null ||
    durationMs === null ||
    totalTokens === null ||
    turns === null ||
    outcome === null
  ) {
    return null;
  }
  const rateLimitWindows = readStageRateLimitTelemetry(metadata);
  const usageEventCadence = readStageUsageEventCadence(metadata);
  const completedAt = readMetadataString(metadata, "completedAt");
  return {
    stageName,
    ...(completedAt === null ? {} : { completedAt }),
    durationMs,
    totalTokens,
    inputTokens: readMetadataNumber(metadata, "inputTokens") ?? 0,
    outputTokens: readMetadataNumber(metadata, "outputTokens") ?? 0,
    cacheReadTokens: readMetadataNumber(metadata, "cacheReadTokens") ?? 0,
    cacheWriteTokens: readMetadataNumber(metadata, "cacheWriteTokens") ?? 0,
    compactions: readMetadataNumber(metadata, "compactions") ?? 0,
    ...(rateLimitWindows === undefined ? {} : { rateLimitWindows }),
    ...(usageEventCadence === undefined ? {} : { usageEventCadence }),
    turns,
    outcome,
  };
}

function cloneRateLimitTelemetry(
  value: StageRecord["rateLimitWindows"],
): NonNullable<StageRecord["rateLimitWindows"]> {
  return {
    primary:
      value?.primary === null || value?.primary === undefined
        ? null
        : { ...value.primary },
    secondary:
      value?.secondary === null || value?.secondary === undefined
        ? null
        : { ...value.secondary },
  };
}

function buildStageUsageEventCadence(
  runningEntry: RunningEntry,
): NonNullable<StageRecord["usageEventCadence"]> {
  return {
    observedCount: runningEntry.tokenTelemetryObservedCount,
    retainedCount: runningEntry.tokenTelemetry.length,
    truncated:
      runningEntry.tokenTelemetryObservedCount >
      runningEntry.tokenTelemetry.length,
    maxTotalTokensDelta: runningEntry.tokenTelemetry.reduce(
      (max, entry) => Math.max(max, entry.totalTokensDelta),
      0,
    ),
  };
}

function readStageRateLimitTelemetry(
  metadata: Record<string, unknown>,
): StageRecord["rateLimitWindows"] {
  const windows = readMetadataRecord(metadata, "rateLimitWindows");
  if (windows === null) {
    return undefined;
  }
  return {
    primary: readStageRateLimitWindow(windows.primary),
    secondary: readStageRateLimitWindow(windows.secondary),
  };
}

function readStageRateLimitWindow(
  value: unknown,
): NonNullable<StageRecord["rateLimitWindows"]>["primary"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const startPercent = readMetadataNumber(record, "startPercent");
  const latestPercent = readMetadataNumber(record, "latestPercent");
  if (startPercent === null || latestPercent === null) {
    return null;
  }
  return {
    startPercent,
    latestPercent,
    lastResetsAt: readMetadataNumber(record, "lastResetsAt"),
  };
}

function readStageUsageEventCadence(
  metadata: Record<string, unknown>,
): StageRecord["usageEventCadence"] {
  const cadence = readMetadataRecord(metadata, "usageEventCadence");
  if (cadence === null) {
    return undefined;
  }
  const observedCount = readMetadataNumber(cadence, "observedCount");
  const retainedCount = readMetadataNumber(cadence, "retainedCount");
  const truncated = readMetadataBoolean(cadence, "truncated");
  const maxTotalTokensDelta = readMetadataNumber(
    cadence,
    "maxTotalTokensDelta",
  );
  if (
    observedCount === null ||
    retainedCount === null ||
    truncated === null ||
    maxTotalTokensDelta === null
  ) {
    return undefined;
  }
  return {
    observedCount,
    retainedCount,
    truncated,
    maxTotalTokensDelta,
  };
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

export function isStopSignalDelivery(
  value: unknown,
): value is StopSignalDelivery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StopSignalDelivery>;
  return (
    isStopSignalDeliveryStatus(candidate.status) &&
    isStopReason(candidate.reason) &&
    isValidTimestamp(candidate.attemptedAt) &&
    (typeof candidate.workspacePath === "string" ||
      candidate.workspacePath === null) &&
    Array.isArray(candidate.attempts) &&
    candidate.attempts.every(isStopSignalDeliveryAttempt) &&
    isStopSignalDeliveryStatusConsistent(
      candidate.status,
      candidate.attempts,
      candidate.warning,
    ) &&
    (typeof candidate.warning === "string" || candidate.warning === null)
  );
}

function isEmergencyStopTerminationConfirmed(value: unknown): boolean {
  if (!isStopSignalDelivery(value)) {
    return false;
  }
  return (
    (value.status === "delivered" &&
      value.attempts.length > 0 &&
      value.attempts.every(
        (attempt) =>
          attempt.sigkill !== "failed" &&
          (attempt.sigterm === "delivered" || attempt.sigkill === "delivered"),
      )) ||
    (value.status === "already_exited" &&
      value.attempts.length > 0 &&
      value.attempts.every(
        (attempt) =>
          attempt.sigterm === "already_exited" ||
          attempt.sigkill === "already_exited",
      ))
  );
}

function isStopSignalDeliveryStatus(
  value: unknown,
): value is StopSignalDeliveryStatus {
  return (
    value === "not_attempted" ||
    value === "already_exited" ||
    value === "delivered" ||
    value === "partial" ||
    value === "failed"
  );
}

function isValidTimestamp(value: unknown): value is string {
  // Intentionally Date.parse-permissive for persisted/runtime telemetry
  // compatibility; producers still emit Date#toISOString.
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStopSignalDeliveryAttempt(
  value: unknown,
): value is StopSignalDeliveryAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StopSignalDeliveryAttempt>;
  if (
    !isSignalTargetId(candidate.pid) ||
    !(
      candidate.processGroupId === null ||
      isSignalTargetId(candidate.processGroupId)
    ) ||
    !isAttemptedStopSignalStatus(candidate.sigterm) ||
    !isStopSignalStatus(candidate.sigkill)
  ) {
    return false;
  }
  return candidate.sigterm === "delivered" ||
    candidate.sigterm === "already_exited"
    ? true
    : candidate.sigkill !== "not_attempted";
}

function isSignalTargetId(value: unknown): value is number {
  // Signal telemetry only accepts process targets that are safe to address:
  // pid 1 is the system init/launchd target and pid 0 has process-group
  // semantics, so both are invalid proof targets.
  return Number.isInteger(value) && Number(value) > 1;
}

function isAttemptedStopSignalStatus(
  value: unknown,
): value is Exclude<StopSignalStatus, "not_attempted"> {
  return (
    value === "delivered" || value === "already_exited" || value === "failed"
  );
}

function isStopSignalStatus(value: unknown): value is StopSignalStatus {
  return (
    value === "delivered" ||
    value === "already_exited" ||
    value === "failed" ||
    value === "not_attempted"
  );
}

function isStopSignalDeliveryStatusConsistent(
  status: StopSignalDeliveryStatus,
  attempts: StopSignalDeliveryAttempt[],
  warning: StopSignalDelivery["warning"] | undefined,
): boolean {
  if (attempts.length === 0) {
    return (
      status === "not_attempted" ||
      (status === "failed" && typeof warning === "string")
    );
  }
  return status === deriveAttemptedStopSignalDeliveryStatus(attempts);
}

export function deriveAttemptedStopSignalDeliveryStatus(
  attempts: readonly StopSignalDeliveryAttempt[],
): Exclude<StopSignalDeliveryStatus, "not_attempted"> | null {
  // Empty attempts do not distinguish "not attempted" from "failed before
  // attempts were recorded"; callers must choose that transport status from
  // their warning/context and only use this helper for attempted targets.
  if (attempts.length === 0) {
    return null;
  }
  const failedAttempts = getFailedStopSignalDeliveryAttempts(attempts);
  if (failedAttempts.length === 0) {
    return attempts.some(
      (attempt) =>
        attempt.sigterm === "delivered" || attempt.sigkill === "delivered",
    )
      ? "delivered"
      : "already_exited";
  }
  return failedAttempts.length === attempts.length ? "failed" : "partial";
}

export function getFailedStopSignalDeliveryAttempts(
  attempts: readonly StopSignalDeliveryAttempt[],
): StopSignalDeliveryAttempt[] {
  return attempts.filter((attempt) => attempt.sigkill === "failed");
}

function isReviewSubstrateDegradationMessage(
  text: string | null | undefined,
): boolean {
  return (
    text !== null &&
    text !== undefined &&
    REVIEW_SUBSTRATE_DEGRADATION_REGEX.test(text)
  );
}

function extractReviewSubstrateDegradedLanes(
  text: string | null | undefined,
): string[] {
  if (text === null || text === undefined) {
    return [];
  }
  const lanes = new Set<string>();
  const lowerText = text.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const match = findNextReviewSubstrateDegradationPrefix(
      lowerText,
      searchFrom,
    );
    if (match === null) {
      break;
    }
    let laneStart = match.index + match.prefix.length;
    while (
      laneStart < text.length &&
      isReviewSubstrateLanePadding(text.charCodeAt(laneStart))
    ) {
      laneStart += 1;
    }
    let laneEnd = laneStart;
    while (
      laneEnd < text.length &&
      !isReviewSubstrateLaneDelimiter(text.charCodeAt(laneEnd))
    ) {
      laneEnd += 1;
    }
    const lane = trimReviewSubstrateLane(text.slice(laneStart, laneEnd));
    if (lane !== "") {
      lanes.add(lane);
    }
    searchFrom = Math.max(laneEnd, match.index + 1);
  }
  return [...lanes].sort();
}

function findNextReviewSubstrateDegradationPrefix(
  lowerText: string,
  searchFrom: number,
): { index: number; prefix: string } | null {
  let best: { index: number; prefix: string } | null = null;
  for (const prefix of REVIEW_SUBSTRATE_DEGRADATION_PREFIXES) {
    const index = lowerText.indexOf(prefix, searchFrom);
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, prefix };
    }
  }
  return best;
}

function isReviewSubstrateLaneDelimiter(charCode: number): boolean {
  return (
    charCode === 9 ||
    charCode === 10 ||
    charCode === 11 ||
    charCode === 12 ||
    charCode === 13 ||
    charCode === 32 ||
    charCode === 44 ||
    charCode === 59
  );
}

function isReviewSubstrateLanePadding(charCode: number): boolean {
  return charCode === 9 || charCode === 32;
}

function trimReviewSubstrateLane(value: string): string {
  let end = value.length;
  while (end > 0) {
    const charCode = value.charCodeAt(end - 1);
    if (charCode !== 46) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

function hashReviewInfrastructureSignature(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 7);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function computeRateLimitDeferredUntil(input: {
  violations: ReadonlyArray<{ window: "primary" | "secondary" }>;
  primary: ReturnType<typeof evaluateWindowHeadroom>;
  secondary: ReturnType<typeof evaluateWindowHeadroom>;
  jitterMs: number;
}): string | null {
  let latestResetMs: number | null = null;
  for (const violation of input.violations) {
    const headroom =
      violation.window === "primary" ? input.primary : input.secondary;
    if (headroom === null || headroom.expired || headroom.resetsAt === null) {
      return null;
    }
    const resetMs = headroom.resetsAt * 1000;
    latestResetMs =
      latestResetMs === null ? resetMs : Math.max(latestResetMs, resetMs);
  }
  return latestResetMs === null
    ? null
    : new Date(latestResetMs + input.jitterMs).toISOString();
}

function computeRateLimitAdmissionCapacity(input: {
  expectedUnitBurnPct: number;
  primary: {
    headroom: ReturnType<typeof evaluateWindowHeadroom>;
    floorPct: number;
  } | null;
  secondary: {
    headroom: ReturnType<typeof evaluateWindowHeadroom>;
    floorPct: number;
  } | null;
}): number | null {
  const capacities: number[] = [];
  for (const window of [input.primary, input.secondary]) {
    if (window === null) {
      continue;
    }
    const headroom = window.headroom;
    if (headroom === null || headroom.expired) {
      continue;
    }
    const spendableHeadroomPct = Math.max(
      0,
      headroom.remainingPercent - window.floorPct,
    );
    capacities.push(
      Math.max(0, Math.floor(spendableHeadroomPct / input.expectedUnitBurnPct)),
    );
  }
  return capacities.length === 0 ? null : Math.min(...capacities);
}

function summarizeContinuousFeedbackCheckpoint(
  status: ContinuousFeedbackStatus,
  issueIdentifier: string,
  providerSummary: string | null,
  findingCount: number,
): string {
  switch (status) {
    case "pass":
      return `Continuous feedback passed for ${issueIdentifier}.`;
    case "finding":
      return `Continuous feedback found ${findingCount} issue(s) for ${issueIdentifier}.`;
    case "unavailable": {
      const detail =
        providerSummary === null || providerSummary.trim() === ""
          ? ""
          : ` ${providerSummary.trim()}`;
      return `Continuous feedback unavailable for ${issueIdentifier}.${detail}`;
    }
  }
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
