import type { ErrorSignatureClass } from "../errors/signature.js";

export const ORCHESTRATOR_ISSUE_STATUSES = [
  "unclaimed",
  "claimed",
  "running",
  "retry_queued",
  "released",
] as const;

export type OrchestratorIssueStatus =
  (typeof ORCHESTRATOR_ISSUE_STATUSES)[number];

export const RUN_ATTEMPT_PHASES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
] as const;

export type RunAttemptPhase = (typeof RUN_ATTEMPT_PHASES)[number];

export const ORCHESTRATOR_EVENTS = [
  "poll_tick",
  "poll_tick_completed",
  "worker_exit_normal",
  "worker_exit_paused",
  "worker_exit_abnormal",
  "stage_completed",
  "codex_update_event",
  "retry_timer_fired",
  "reconciliation_state_refresh",
  "stall_timeout",
  "shutdown_complete",
] as const;

export type OrchestratorEvent = (typeof ORCHESTRATOR_EVENTS)[number];

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: string;
  status: RunAttemptPhase;
  error?: string;
}

export interface TurnHistoryEntry {
  turnNumber: number;
  timestamp: string;
  message: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  event: string | null;
}

export interface RecentActivityEntry {
  timestamp: string;
  toolName: string;
  context: string | null;
  totalTokens?: number;
}

export interface TokenTelemetryEntry {
  timestamp: string;
  event: string;
  sessionId: string | null;
  turnId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensDelta: number;
  outputTokensDelta: number;
  totalTokensDelta: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  noCacheTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokensDelta: number;
  cacheWriteTokensDelta: number;
  noCacheTokensDelta: number;
  reasoningTokensDelta: number;
}

export interface CodexSessionLogEntry {
  label: string;
  path: string;
  url: string | null;
  bytes?: number;
}

export const LOOP_TRACE_EVENT_KINDS = [
  "session_start",
  "prompt_summary",
  "tool_action",
  "file_delta",
  // Reserved for later dispatcher phases; readers should tolerate absence.
  "test_result",
  "feedback_event",
  "continuous_feedback",
  "stage_transition",
  "gate_result",
  "escalation",
  "worker_exit",
] as const;

export type LoopTraceEventKind = (typeof LOOP_TRACE_EVENT_KINDS)[number];

export interface LoopTracePromptSummary {
  chars: number;
  estimatedTokens: number | null;
}

export interface LoopTraceToolAction {
  toolName: string;
  context: string | null;
  totalTokens: number | null;
}

export interface LoopTraceFileDelta {
  files: string[];
}

export interface LoopTraceStageTransition {
  from: string | null;
  to: string | null;
  status: string;
}

export interface LoopTraceWorkerExit {
  outcome: "normal" | "abnormal";
  reason: string | null;
  durationMs: number;
  turnCount: number;
  totalTokens: number;
}

export interface LoopTraceContinuousFeedback {
  event: "commit" | "diff" | "checkpoint";
  status: "pass" | "finding";
  reviewerRunner: string;
  reviewerModel: string | null;
  findingSignatures: string[];
}

export interface LoopTraceEntry {
  sequence: number;
  timestamp: string;
  kind: LoopTraceEventKind;
  issueId: string;
  issueIdentifier: string;
  stage: string | null;
  attempt: number | null;
  sessionId: string | null;
  summary: string;
  prompt?: LoopTracePromptSummary;
  toolAction?: LoopTraceToolAction;
  fileDelta?: LoopTraceFileDelta;
  continuousFeedback?: LoopTraceContinuousFeedback;
  stageTransition?: LoopTraceStageTransition;
  workerExit?: LoopTraceWorkerExit;
}

export type LoopTraceJournal = LoopTraceEntry[];

export const DISPATCHER_RUN_JOURNAL_EVENT_KINDS = [
  "admission",
  "right_sizing",
  "dispatcher_decision",
  "supervision_finding",
  "re_steer_request",
  "gate_started",
  "gate_result",
  "tracker_write",
  "hard_stop_trigger",
  "budget_escalation",
  "pause_triage",
  "failure_exhausted",
  "ac_gate",
  "spec_fidelity",
  "operator_input_required",
  "continuous_feedback",
  "dispatch_verdict",
  "breaker_transition",
  "cluster_transition",
  // Shared intent-verb layer (SYMPH-399 / SYMPH-408 carve-out): idempotent,
  // fenced, attributed journal writes that operator/agents/watchdog-L2 all
  // mutate through. metadata carries schema_version, verb, status, actor.
  "intent",
  // Watchdog L2 stuck-ticket triage verdicts (SYMPH-399; the kind reserved
  // by SYMPH-405's verdict-event vocabulary).
  "triage_verdict",
  // Per-stage token/turn record appended at worker exit (SYMPH-401):
  // replayed into issueExecutionHistory so per-issue cumulative spend
  // survives restarts without a bespoke persistence store.
  "stage_record",
  // Durable consumption marker for a terminal stage signal that arrived
  // together with a budget hard stop (SYMPH-440).
  "pending_stage_signal",
] as const;

// ---------------------------------------------------------------------------
// Dispatch verdict events (SYMPH-405)
// ---------------------------------------------------------------------------

export const VERDICT_DISPOSITIONS = ["admit", "skip", "gate", "halt"] as const;

export type VerdictDisposition = (typeof VERDICT_DISPOSITIONS)[number];

export const VERDICT_ACTOR_KINDS = [
  "operator",
  "watchdog-l1",
  "watchdog-l2",
  "pipeline-worker",
  "interactive-agent",
  "dispatcher",
] as const;

export type VerdictActorKind = (typeof VERDICT_ACTOR_KINDS)[number];

/**
 * Attribution object carried on every verdict-class journal event
 * (SYMPH-405 amendment 4): every human-visible rendering of a state change
 * includes "by {kind}@{host}".
 */
export interface VerdictActor {
  kind: VerdictActorKind;
  host: string;
  session?: string;
}

/**
 * Last dispatch verdict per issue (SYMPH-405). Sourced from the in-memory
 * last-verdict map and surfaced in the /api/v1/state payload so an operator
 * can see WHY an issue is not dispatching without grepping the journal.
 */
export interface IssueDispositionRecord {
  disposition: VerdictDisposition;
  reasonCode: string;
  remedy: string | null;
  since: string;
}

export type DispatcherRunJournalEventKind =
  (typeof DISPATCHER_RUN_JOURNAL_EVENT_KINDS)[number];

export const DISPATCHER_OPERATIONS = [
  "dispatcher",
  "supervisor",
  "feedback_lane",
  "tracker_write",
  "gate",
] as const;

export type DispatcherOperation = (typeof DISPATCHER_OPERATIONS)[number];

export type DispatcherLeaseStatus = "active" | "completed" | "expired";

export interface DispatcherLease {
  leaseId: string;
  issueId: string;
  issueIdentifier: string;
  operation: DispatcherOperation;
  ownerId: string;
  status: DispatcherLeaseStatus;
  acquiredAt: string;
  expiresAt: string;
  completedAt: string | null;
  stage: string | null;
  attempt: number | null;
  lastJournalSequence: number;
}

export interface DispatcherRunJournalEntry {
  sequence: number;
  idempotencyKey: string;
  timestamp: string;
  kind: DispatcherRunJournalEventKind;
  issueId: string;
  issueIdentifier: string;
  operation: DispatcherOperation;
  stage: string | null;
  attempt: number | null;
  ownerId: string | null;
  lease: DispatcherLease | null;
  summary: string;
  metadata: Record<string, unknown>;
}

export type DispatcherRunJournal = DispatcherRunJournalEntry[];

export const DISPATCHER_DECISION_CATEGORIES = [
  "right_sizing",
  "admission",
  "re_steer",
  "model_routing",
] as const;

export type DispatcherDecisionCategory =
  (typeof DISPATCHER_DECISION_CATEGORIES)[number];

export const DISPATCHER_DECISION_CLASSIFICATIONS = [
  "positive",
  "negative",
] as const;

export type DispatcherDecisionClassification =
  (typeof DISPATCHER_DECISION_CLASSIFICATIONS)[number];

export const DISPATCHER_DECISION_COST_WEIGHTS = [
  "low",
  "medium",
  "high",
] as const;

export type DispatcherDecisionCostWeight =
  (typeof DISPATCHER_DECISION_COST_WEIGHTS)[number];

export interface DispatcherDecisionOutcome {
  decision: string;
  classification: DispatcherDecisionClassification | null;
  rationale: string;
  costWeight: DispatcherDecisionCostWeight | null;
}

export interface DispatcherDecisionCorrection {
  outcome: DispatcherDecisionOutcome;
  source: "operator" | "meta_eval" | "runtime";
  recordedAt: string;
  note: string | null;
}

export interface DispatcherDecisionContext {
  reason: string;
  triggerHits: string[];
  findingKinds: string[];
  files: string[];
  workerIds: string[];
  details: Record<string, unknown>;
}

export interface DispatcherDecisionEvent {
  decisionId: string;
  category: DispatcherDecisionCategory;
  classifier: string | null;
  issueId: string;
  issueIdentifier: string;
  operation: DispatcherOperation;
  stage: string | null;
  attempt: number | null;
  timestamp: string;
  context: DispatcherDecisionContext;
  expectedOutcome: DispatcherDecisionOutcome;
  observedOutcome: DispatcherDecisionOutcome | null;
  operatorCorrection: DispatcherDecisionCorrection | null;
}

export interface DispatcherDecisionQualityBucket {
  total: number;
  measured: number;
  pending: number;
  exactMatches: number;
  corrected: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  unclassified: number;
  costSensitiveRoutingMisses: number;
}

export type DispatcherDecisionQualityCategorySummary = Record<
  DispatcherDecisionCategory,
  DispatcherDecisionQualityBucket
>;

export interface DispatcherDecisionQualitySummary
  extends DispatcherDecisionQualityBucket {
  latestEventAt: string | null;
  categories: DispatcherDecisionQualityCategorySummary;
}

export const MANAGER_RUN_EVENT_TYPES = [
  "manager_run_started",
  "worker_lane_admitted",
  "issue_linked",
  "pr_linked",
  "dependency_declared",
  "dependency_unblocked",
  "review_gate_started",
  "review_gate_result",
  "validation_artifact_added",
  "follow_up_spawned",
  "ownership_lease_acquired",
  "ownership_lease_released",
  "heartbeat_recorded",
  "escalation_raised",
  "terminal_condition_reported",
  "model_check_requested",
] as const;

export type ManagerRunEventType = (typeof MANAGER_RUN_EVENT_TYPES)[number];

export type ManagerWorkerLaneStatus =
  | "active"
  | "blocked"
  | "degraded"
  | "closed";

export type ManagerReviewGateStatus =
  | "started"
  | "passed"
  | "failed"
  | "degraded";

export type ManagerModelCheckReason = "ambiguity" | "decision_quality_check";

interface ManagerRunJournalBaseEntry {
  sequence: number;
  idempotencyKey: string;
  timestamp: string;
  runId: string;
  sourceSessionId: string | null;
  summary: string;
}

export interface ManagerRunStartedEntry extends ManagerRunJournalBaseEntry {
  type: "manager_run_started";
  managerThreadId: string;
  title: string;
}

export interface ManagerWorkerLaneAdmittedEntry
  extends ManagerRunJournalBaseEntry {
  type: "worker_lane_admitted";
  laneId: string;
  workerThreadId: string;
  issueIdentifier: string;
  title: string;
}

export interface ManagerIssueLinkedEntry extends ManagerRunJournalBaseEntry {
  type: "issue_linked";
  laneId: string;
  issueId: string | null;
  issueIdentifier: string;
  url: string | null;
}

export interface ManagerPrLinkedEntry extends ManagerRunJournalBaseEntry {
  type: "pr_linked";
  laneId: string;
  prNumber: number | null;
  url: string;
  status: "draft" | "open" | "merged" | "closed";
}

export interface ManagerDependencyDeclaredEntry
  extends ManagerRunJournalBaseEntry {
  type: "dependency_declared";
  laneId: string;
  dependencyId: string;
  dependsOnLaneId: string | null;
  dependsOnIssueIdentifier: string | null;
  reason: string;
}

export interface ManagerDependencyUnblockedEntry
  extends ManagerRunJournalBaseEntry {
  type: "dependency_unblocked";
  dependencyId: string;
}

export interface ManagerReviewGateStartedEntry
  extends ManagerRunJournalBaseEntry {
  type: "review_gate_started";
  laneId: string;
  gateId: string;
  reviewer: string;
}

export interface ManagerReviewGateResultEntry
  extends ManagerRunJournalBaseEntry {
  type: "review_gate_result";
  laneId: string;
  gateId: string;
  status: Exclude<ManagerReviewGateStatus, "started">;
  evidenceArtifactId: string | null;
  compensationRequired: boolean;
}

export interface ManagerValidationArtifactAddedEntry
  extends ManagerRunJournalBaseEntry {
  type: "validation_artifact_added";
  laneId: string | null;
  artifactId: string;
  kind:
    | "test"
    | "build"
    | "lint"
    | "typecheck"
    | "review_compensation"
    | "report"
    | "other";
  label: string;
  url: string | null;
}

export interface ManagerFollowUpSpawnedEntry
  extends ManagerRunJournalBaseEntry {
  type: "follow_up_spawned";
  laneId: string | null;
  issueIdentifier: string;
  title: string;
  parentIssueIdentifier: string | null;
  url: string | null;
}

export interface ManagerOwnershipLeaseAcquiredEntry
  extends ManagerRunJournalBaseEntry {
  type: "ownership_lease_acquired";
  leaseId: string;
  laneId: string;
  ownerThreadId: string;
  expiresAt: string;
}

export interface ManagerOwnershipLeaseReleasedEntry
  extends ManagerRunJournalBaseEntry {
  type: "ownership_lease_released";
  leaseId: string;
  outcome: "completed" | "expired" | "transferred";
}

export interface ManagerHeartbeatRecordedEntry
  extends ManagerRunJournalBaseEntry {
  type: "heartbeat_recorded";
  laneId: string;
  workerThreadId: string;
  status: "active" | "blocked" | "degraded" | "closing";
  note: string | null;
}

export interface ManagerEscalationRaisedEntry
  extends ManagerRunJournalBaseEntry {
  type: "escalation_raised";
  laneId: string | null;
  kind:
    | "stale_worker"
    | "missing_evidence"
    | "review_gate_degraded"
    | "dependency_blocked"
    | "ownership_conflict";
  severity: "warning" | "critical";
  message: string;
}

export interface ManagerTerminalConditionReportedEntry
  extends ManagerRunJournalBaseEntry {
  type: "terminal_condition_reported";
  laneId: string | null;
  condition: "lane_closed" | "manager_closeout";
  requiredEvidence: string[];
  providedEvidence: string[];
}

export interface ManagerModelCheckRequestedEntry
  extends ManagerRunJournalBaseEntry {
  type: "model_check_requested";
  reason: ManagerModelCheckReason;
  laneId: string | null;
  question: string;
}

export type ManagerRunJournalEntry =
  | ManagerRunStartedEntry
  | ManagerWorkerLaneAdmittedEntry
  | ManagerIssueLinkedEntry
  | ManagerPrLinkedEntry
  | ManagerDependencyDeclaredEntry
  | ManagerDependencyUnblockedEntry
  | ManagerReviewGateStartedEntry
  | ManagerReviewGateResultEntry
  | ManagerValidationArtifactAddedEntry
  | ManagerFollowUpSpawnedEntry
  | ManagerOwnershipLeaseAcquiredEntry
  | ManagerOwnershipLeaseReleasedEntry
  | ManagerHeartbeatRecordedEntry
  | ManagerEscalationRaisedEntry
  | ManagerTerminalConditionReportedEntry
  | ManagerModelCheckRequestedEntry;

export type ManagerRunJournal = ManagerRunJournalEntry[];

export interface ManagerRunDependencyState {
  dependencyId: string;
  laneId: string;
  dependsOnLaneId: string | null;
  dependsOnIssueIdentifier: string | null;
  reason: string;
  unblocked: boolean;
}

export interface ManagerRunReviewGateState {
  gateId: string;
  laneId: string;
  reviewer: string | null;
  status: ManagerReviewGateStatus;
  evidenceArtifactId: string | null;
  compensationRequired: boolean;
  compensated: boolean;
}

export interface ManagerRunValidationArtifactState {
  artifactId: string;
  laneId: string | null;
  kind: ManagerValidationArtifactAddedEntry["kind"];
  label: string;
  url: string | null;
}

export interface ManagerRunFollowUpState {
  issueIdentifier: string;
  title: string;
  parentIssueIdentifier: string | null;
  laneId: string | null;
  url: string | null;
}

export interface ManagerRunOwnershipLeaseState {
  leaseId: string;
  laneId: string;
  ownerThreadId: string;
  status: "active" | "completed" | "expired" | "transferred";
  expiresAt: string;
}

export interface ManagerRunEscalationState {
  laneId: string | null;
  kind: ManagerEscalationRaisedEntry["kind"];
  severity: ManagerEscalationRaisedEntry["severity"];
  message: string;
  raisedAt: string;
}

export interface ManagerRunModelCheckState {
  reason: ManagerModelCheckReason;
  laneId: string | null;
  question: string;
  requestedAt: string;
}

export interface ManagerRunLaneState {
  laneId: string;
  workerThreadId: string;
  issueIdentifier: string;
  title: string;
  status: ManagerWorkerLaneStatus;
  blockedBy: string[];
  degradedReasons: string[];
  lastHeartbeatAt: string | null;
  prUrl: string | null;
  prStatus: "draft" | "open" | "merged" | "closed" | null;
  validationArtifactIds: string[];
  reviewGateIds: string[];
  followUpIssueIdentifiers: string[];
}

export interface ManagerRunCloseoutState {
  ready: boolean;
  missingEvidence: string[];
}

export interface ManagerRunState {
  runId: string;
  managerThreadId: string | null;
  title: string | null;
  startedAt: string | null;
  lanes: Record<string, ManagerRunLaneState>;
  dependencies: Record<string, ManagerRunDependencyState>;
  reviewGates: Record<string, ManagerRunReviewGateState>;
  validationArtifacts: Record<string, ManagerRunValidationArtifactState>;
  followUps: Record<string, ManagerRunFollowUpState>;
  ownershipLeases: Record<string, ManagerRunOwnershipLeaseState>;
  escalations: ManagerRunEscalationState[];
  modelCallPolicy: {
    ledgerIsSourceOfTruth: true;
    allowedReasons: ManagerModelCheckReason[];
    pendingChecks: ManagerRunModelCheckState[];
  };
  closeout: ManagerRunCloseoutState;
  journal: ManagerRunJournal;
}

export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  codexCacheReadTokens: number;
  codexCacheWriteTokens: number;
  codexNoCacheTokens: number;
  codexReasoningTokens: number;
  codexTotalInputTokens: number;
  codexTotalOutputTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  lastReportedCacheReadTokens: number;
  lastReportedCacheWriteTokens: number;
  lastReportedNoCacheTokens: number;
  lastReportedReasoningTokens: number;
  turnCount: number;
  totalStageInputTokens: number;
  totalStageOutputTokens: number;
  totalStageTotalTokens: number;
  totalStageCacheReadTokens: number;
  totalStageCacheWriteTokens: number;
  totalStageCompactions?: number;
  turnHistory: TurnHistoryEntry[];
  recentActivity: RecentActivityEntry[];
  tokenTelemetry: TokenTelemetryEntry[];
  tokenTelemetryObservedCount: number;
  codexSessionLogs: CodexSessionLogEntry[];
  rateLimitWindows: SessionRateLimitTelemetry;
}

/**
 * Per-stage view of the Codex rate-limit windows: usage at stage start,
 * latest observation, and the burn between them (SYMPH-333). Baselines
 * re-anchor when a window resets mid-stage.
 */
export interface SessionRateLimitWindowTelemetry {
  startPercent: number;
  latestPercent: number;
  lastResetsAt: number | null;
}

export interface SessionRateLimitTelemetry {
  primary: SessionRateLimitWindowTelemetry | null;
  secondary: SessionRateLimitWindowTelemetry | null;
}

export interface RetryEntry {
  issueId: string;
  identifier: string | null;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout> | null;
  error: string | null;
  delayType: "continuation" | "failure";
}

export const RIGHT_SIZING_MODES = ["prototype", "thin", "full"] as const;
export type RightSizingMode = (typeof RIGHT_SIZING_MODES)[number];

export const RIGHT_SIZING_IMPACT_SURFACES = [
  "narrow",
  "shared",
  "wide",
] as const;
export type RightSizingImpactSurface =
  (typeof RIGHT_SIZING_IMPACT_SURFACES)[number];

export const RIGHT_SIZING_BUDGETS = ["low", "medium", "high"] as const;
export type RightSizingBudget = (typeof RIGHT_SIZING_BUDGETS)[number];

export const COUNCIL_RISK_PREDICATE_TRIGGERS = [
  "high_risk_path",
  "journal_producer",
  "journal_replay_reducer",
  "dispatcher_event_vocabulary",
  "state_journal_projection",
] as const;

export type CouncilRiskPredicateTrigger =
  (typeof COUNCIL_RISK_PREDICATE_TRIGGERS)[number];

export interface CouncilRiskPredicateMatch {
  trigger: CouncilRiskPredicateTrigger;
  path: string;
  matchedPattern: string;
  rationale: string;
}

export interface CouncilRiskPredicateResult {
  triggerHits: CouncilRiskPredicateTrigger[];
  matchedPaths: string[];
  matches: CouncilRiskPredicateMatch[];
}

export interface RightSizingSignals {
  explicitModeHint: RightSizingMode | null;
  declaredScopeFiles: string[];
  changedFiles: string[];
  impactSurface: RightSizingImpactSurface;
  highRiskFiles: string[];
  riskPredicate: CouncilRiskPredicateResult;
  stageCount: number;
  gateCount: number;
  reviewerCount: number;
  humanGateCount: number;
  blockedByCount: number;
  retryCount: number;
  priority: number | null;
  labels: string[];
  plannedTurns: number;
  budget: RightSizingBudget;
}

export interface RightSizingModelRouting {
  allowed: boolean;
  reason: "not_needed" | "ambiguous_routing" | "risk_trigger";
}

export interface RightSizingDecision {
  classifier: "deterministic-v1";
  mode: RightSizingMode;
  stageName: string | null;
  reason: string;
  rationale: string[];
  triggerHits: string[];
  riskPredicate: CouncilRiskPredicateResult;
  signals: RightSizingSignals;
  modelRouting: RightSizingModelRouting;
}

export interface DecorrelatedGateLane {
  runner: string;
  model: string | null;
  role: string;
  stageName: string | null;
}

export type DecorrelatedGateStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "skipped_prototype";

export interface DecorrelatedGateOutcome {
  issueId: string;
  issueIdentifier: string;
  gateStage: string | null;
  mode: RightSizingMode;
  status: DecorrelatedGateStatus;
  aggregate: "pass" | "fail" | null;
  checkedAt: string;
  workerLane: DecorrelatedGateLane;
  reviewerLanes: DecorrelatedGateLane[];
  verifierSeparated: boolean;
  authoritative: boolean;
  reworkTarget: string | null;
  summary: string;
}

export type ContinuousFeedbackEvent = "commit" | "diff" | "checkpoint";
export type ContinuousFeedbackStatus = "pass" | "finding";
export type ContinuousFeedbackFindingSeverity = "info" | "warning" | "blocking";
export type ContinuousFeedbackFindingStatus =
  | "open"
  | "resolved"
  | "bounced"
  /**
   * Failed the injection-hygiene policy (SYMPH-378): no evidence grounding
   * and not a blocker. Journaled for measurement; never bounces or comments.
   */
  | "suppressed";

export interface ContinuousFeedbackLane {
  runner: string;
  model: string | null;
  role: string;
}

export interface ContinuousFeedbackFinding {
  signature: string;
  title: string;
  detail: string;
  severity: ContinuousFeedbackFindingSeverity;
  file: string | null;
  line: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  status: ContinuousFeedbackFindingStatus;
  reviewerLane: ContinuousFeedbackLane;
}

export interface ContinuousFeedbackIssueState {
  status: ContinuousFeedbackStatus;
  lastEvent: ContinuousFeedbackEvent;
  lastCheckedAt: string;
  reviewerLane: ContinuousFeedbackLane;
  workerLane: ContinuousFeedbackLane;
  findings: ContinuousFeedbackFinding[];
}

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  reasoningTokens: number;
  secondsRunning: number;
}

export type CodexRateLimits = Record<string, unknown> | null;

/**
 * Latest dispatcher admission decision under the rate-limit headroom floor
 * (SYMPH-333). null while the guard is unconfigured.
 */
export interface RateLimitAdmissionState {
  blocked: boolean;
  reason: string | null;
  evaluatedAt: string;
  minPrimaryHeadroomPct: number | null;
  minSecondaryHeadroomPct: number | null;
  primaryUsedPercent: number | null;
  secondaryUsedPercent: number | null;
}

export interface RunningEntry extends LiveSession {
  issue: Issue;
  identifier: string;
  retryAttempt: number | null;
  startedAt: string;
  workerHandle: unknown;
  monitorHandle: unknown;
  failureReason: string | null;
}

export interface StageRecord {
  stageName: string;
  durationMs: number;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  compactions?: number;
  turns: number;
  outcome: string;
}

export type ExecutionHistory = StageRecord[];

/**
 * Persistent description of a requires-explicit-resume mark (SYMPH-406).
 * Reduced from journal events on replay; never stored outside the journal.
 */
export interface ResumeRequiredMark {
  /** Why the issue is parked (e.g. "hard_stop:token_budget", "intent:park:manual_stop"). */
  reason: string;
  /** Journal sequence of the event that set the mark; null when unknown. */
  setBySequence: number | null;
  /** ISO timestamp the mark was recorded. */
  since: string;
}

interface PendingStageSignalBase {
  stageName: string | null;
  attempt: number | null;
  agentMessage: string;
  setBySequence: number | null;
}

export interface PendingStageCompletionSignal extends PendingStageSignalBase {
  signal: "complete";
  failureClass: null;
}

export interface PendingStageFailureSignal extends PendingStageSignalBase {
  signal: "failure";
  failureClass: FailureClass;
}

export type PendingStageSignal =
  | PendingStageCompletionSignal
  | PendingStageFailureSignal;

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Record<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Record<string, RetryEntry>;
  completed: Set<string>;
  failed: Set<string>;
  resumeRequired: Set<string>;
  /**
   * Why each issue in `resumeRequired` is parked (SYMPH-406): the reason
   * string and the journal sequence (event cursor) of the entry that set
   * the mark. Maintained by the same choke points that mutate
   * `resumeRequired` and surfaced in the /api/v1/state snapshot so an
   * operator never has to grep the journal to learn why an issue skips.
   */
  resumeRequiredMarks: Record<string, ResumeRequiredMark>;
  codexTotals: CodexTotals;
  codexRateLimits: CodexRateLimits;
  rateLimitAdmission: RateLimitAdmissionState | null;
  issueStages: Record<string, string>;
  issuePendingStageSignals: Record<string, PendingStageSignal>;
  issueBudgetEscalations: Record<string, number>;
  issuePauseTriageResumes: Record<string, number>;
  issueReworkCounts: Record<string, number>;
  issuePassedStages: Record<string, string[]>;
  issueFirstDispatchedAt: Record<string, string>;
  issueExecutionHistory: Record<string, ExecutionHistory>;
  issueRightSizingDecisions: Record<string, RightSizingDecision>;
  /**
   * Canonical AC rubric per issue, frozen from the investigate completion
   * message when the AC gate passes (SYMPH-374). Spec-fidelity judges and
   * implement prompts read this snapshot — never the mutable workpad.
   */
  issueAcSnapshots: Record<string, string>;
  decorrelatedGateOutcomes: Record<string, DecorrelatedGateOutcome[]>;
  loopTraceJournal: Record<string, LoopTraceJournal>;
  continuousFeedback: Record<string, ContinuousFeedbackIssueState>;
  dispatcherRunJournal: DispatcherRunJournal;
  dispatcherLeases: Record<string, DispatcherLease>;
  managerRunJournal: ManagerRunJournal;
  managerRuns: Record<string, ManagerRunState>;
  /**
   * Last failure signature recorded per issue+stage key (`${issueId}:${stage}`).
   * Used by the retry-without-novelty short-circuit (SYMPH-396): if the
   * incoming failure signature matches the stored one and the class is not
   * "transient", the issue is parked immediately instead of re-entering the
   * budget-escalation ladder.
   */
  issueFailureSignatures: Record<
    string,
    { signature: string; class: ErrorSignatureClass }
  >;
  /**
   * Last dispatch verdict per issue id (SYMPH-405), keyed by issue id (plus
   * the synthetic "__dispatch__" scope for pipeline-wide gates). Mirrors the
   * orchestrator's last-verdict dedup map and feeds the /api/v1/state
   * `dispositions` surface (real issue ids) plus the `dispatch_gate` field
   * (the synthetic scope).
   */
  issueDispositions: Record<string, IssueDispositionRecord>;
  /**
   * Consecutive review-failure streak per issue (SYMPH-402): the
   * criterion-aware review-failure signature and how many consecutive review
   * rounds have failed with it. Rework cycles (review → implement → review)
   * bypass the retry path, so the SYMPH-396 short-circuit never sees them —
   * this streak parks an issue loudly instead of letting it enter a third
   * rework round on the SAME failed pre-gate criterion.
   */
  issueReviewFailureStreaks: Record<
    string,
    { signature: string; count: number }
  >;
  /**
   * Consecutive review-gate infrastructure stalls per issue (SYMPH-441).
   * Review-stage substrate stalls are retried once as infrastructure; the
   * second consecutive substrate stall parks loudly instead of reworking code.
   */
  issueReviewInfrastructureStalls: Record<
    string,
    { signature: string; count: number; stalledLanes: string[] }
  >;
  /**
   * Issues for which a `failure_exhausted` alert has been fired in this
   * session (SYMPH-397). Used by runtime-host to suppress the redundant
   * `issue_failed` notification when the terminal path was already announced
   * via `failure_exhausted` (e.g. novelty short-circuit parks at attempt < maxRetries).
   */
  failureExhaustedIds: Set<string>;
}

export const FAILURE_CLASSES = [
  "verify",
  "review",
  "rebase",
  "spec",
  "infra",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureSignal {
  failureClass: FailureClass;
}

const STAGE_FAILED_REGEX =
  /\[STAGE_FAILED:\s*(verify|review|rebase|spec|infra)\s*\]/;

const STAGE_COMPLETE_REGEX = /(?:^|\n)[ \t]*\[STAGE_COMPLETE\]/;

/**
 * Detect the `[STAGE_COMPLETE]` signal at the start of any line in the
 * agent's final message. Workers emit the marker leading or trailing
 * (observed on the SYMPH-330 canary: "[STAGE_COMPLETE]  Investigation
 * workpad updated on …"), so an endsWith predicate silently missed real
 * completions (SYMPH-350). Line-anchoring (rather than match-anywhere)
 * exists because the stage prompts themselves quote the marker — a worker
 * echoing its instructions mid-prose ("I'll output [STAGE_COMPLETE] when
 * done") must not complete the stage.
 */
export function containsStageCompleteSignal(
  text: string | null | undefined,
): boolean {
  if (text === null || text === undefined) {
    return false;
  }
  return STAGE_COMPLETE_REGEX.test(text);
}

/**
 * Parse a `[STAGE_FAILED: class]` signal from agent output text.
 * Returns the parsed failure signal or null if no signal is found.
 */
export function parseFailureSignal(
  text: string | null | undefined,
): FailureSignal | null {
  if (text === null || text === undefined) {
    return null;
  }
  const match = STAGE_FAILED_REGEX.exec(text);
  if (match === null) {
    return null;
  }
  return { failureClass: match[1] as FailureClass };
}

export function normalizeIssueState(state: string): string {
  return state.trim().toLowerCase();
}

export function toWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export function toSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

export function createEmptyLiveSession(): LiveSession {
  return {
    sessionId: null,
    threadId: null,
    turnId: null,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    codexCacheReadTokens: 0,
    codexCacheWriteTokens: 0,
    codexNoCacheTokens: 0,
    codexReasoningTokens: 0,
    codexTotalInputTokens: 0,
    codexTotalOutputTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    lastReportedCacheReadTokens: 0,
    lastReportedCacheWriteTokens: 0,
    lastReportedNoCacheTokens: 0,
    lastReportedReasoningTokens: 0,
    turnCount: 0,
    totalStageInputTokens: 0,
    totalStageOutputTokens: 0,
    totalStageTotalTokens: 0,
    totalStageCacheReadTokens: 0,
    totalStageCacheWriteTokens: 0,
    totalStageCompactions: 0,
    turnHistory: [],
    recentActivity: [],
    tokenTelemetry: [],
    tokenTelemetryObservedCount: 0,
    codexSessionLogs: [],
    rateLimitWindows: {
      primary: null,
      secondary: null,
    },
  };
}

export function createInitialOrchestratorState(input: {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
}): OrchestratorState {
  return {
    pollIntervalMs: input.pollIntervalMs,
    maxConcurrentAgents: input.maxConcurrentAgents,
    running: {},
    claimed: new Set<string>(),
    retryAttempts: {},
    completed: new Set<string>(),
    failed: new Set<string>(),
    resumeRequired: new Set<string>(),
    resumeRequiredMarks: {},
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    },
    codexRateLimits: null,
    rateLimitAdmission: null,
    issueStages: {},
    issuePendingStageSignals: {},
    issueBudgetEscalations: {},
    issuePauseTriageResumes: {},
    issueReworkCounts: {},
    issuePassedStages: {},
    issueFirstDispatchedAt: {},
    issueExecutionHistory: {},
    issueRightSizingDecisions: {},
    issueAcSnapshots: {},
    decorrelatedGateOutcomes: {},
    loopTraceJournal: {},
    continuousFeedback: {},
    dispatcherRunJournal: [],
    dispatcherLeases: {},
    managerRunJournal: [],
    managerRuns: {},
    issueFailureSignatures: {},
    issueDispositions: {},
    issueReviewFailureStreaks: {},
    issueReviewInfrastructureStalls: {},
    failureExhaustedIds: new Set<string>(),
  };
}
