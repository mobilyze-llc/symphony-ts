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

export const LOOP_TRACE_EVENT_KINDS = [
  "session_start",
  "prompt_summary",
  "tool_action",
  "file_delta",
  // Reserved for later dispatcher phases; readers should tolerate absence.
  "test_result",
  "feedback_event",
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
  stageTransition?: LoopTraceStageTransition;
  workerExit?: LoopTraceWorkerExit;
}

export type LoopTraceJournal = LoopTraceEntry[];

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
  turnCount: number;
  totalStageInputTokens: number;
  totalStageOutputTokens: number;
  totalStageTotalTokens: number;
  totalStageCacheReadTokens: number;
  totalStageCacheWriteTokens: number;
  turnHistory: TurnHistoryEntry[];
  recentActivity: RecentActivityEntry[];
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

export interface RightSizingSignals {
  explicitModeHint: RightSizingMode | null;
  declaredScopeFiles: string[];
  changedFiles: string[];
  impactSurface: RightSizingImpactSurface;
  highRiskFiles: string[];
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
  signals: RightSizingSignals;
  modelRouting: RightSizingModelRouting;
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
  turns: number;
  outcome: string;
}

export type ExecutionHistory = StageRecord[];

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Record<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Record<string, RetryEntry>;
  completed: Set<string>;
  failed: Set<string>;
  codexTotals: CodexTotals;
  codexRateLimits: CodexRateLimits;
  issueStages: Record<string, string>;
  issueReworkCounts: Record<string, number>;
  issuePassedStages: Record<string, string[]>;
  issueFirstDispatchedAt: Record<string, string>;
  issueExecutionHistory: Record<string, ExecutionHistory>;
  loopTraceJournal: Record<string, LoopTraceJournal>;
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
    turnCount: 0,
    totalStageInputTokens: 0,
    totalStageOutputTokens: 0,
    totalStageTotalTokens: 0,
    totalStageCacheReadTokens: 0,
    totalStageCacheWriteTokens: 0,
    turnHistory: [],
    recentActivity: [],
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
    issueStages: {},
    issueReworkCounts: {},
    issuePassedStages: {},
    issueFirstDispatchedAt: {},
    issueExecutionHistory: {},
    loopTraceJournal: {},
  };
}
