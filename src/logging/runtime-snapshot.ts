import { parseRateLimitSnapshot } from "../codex/rate-limits.js";
import {
  DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
} from "../config/defaults.js";
import type {
  CodexRateLimits,
  CodexTotals,
  ContinuousFeedbackIssueState,
  DecorrelatedGateOutcome,
  DispatcherDecisionQualitySummary,
  DispatcherOperation,
  DispatcherRunJournal,
  DispatcherRunJournalEntry,
  DispatcherRunJournalEventKind,
  IssueDispositionRecord,
  OrchestratorState,
  RecentActivityEntry,
  SessionRateLimitTelemetry,
  SessionRateLimitWindowTelemetry,
  StageRecord,
  TurnHistoryEntry,
} from "../domain/model.js";
import type { ComponentStatus } from "../observability/component-status.js";
import type { DeployDriftStatus } from "../observability/deploy-drift.js";
import { PIPELINE_VERDICT_SCOPE_ID } from "../orchestrator/core.js";
import {
  evaluateDispatcherDecisionQuality,
  extractDispatcherDecisionEvents,
} from "../orchestrator/decision-quality.js";
import type { WatchdogRegistrySnapshot } from "../orchestrator/signature-cluster.js";
import { formatEasternTimestamp } from "./format-timestamp.js";
import {
  type LoopTraceJournalPreviewResponse,
  buildLoopTraceJournalPreview,
} from "./loop-trace.js";
import { getAggregateSecondsRunning } from "./session-metrics.js";

export type HealthStatus = "green" | "yellow" | "red";

export interface RuntimeSnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  state: string;
  pipeline_stage: string | null;
  activity_summary: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  first_dispatched_at: string;
  last_event_at: string | null;
  stage_duration_seconds: number;
  tokens_per_turn: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  };
  output_caps?: RuntimeSnapshotOutputCaps;
  churn?: RuntimeSnapshotChurn;
  rework_count?: number;
  rate_limit_window: RuntimeSnapshotRateLimitWindowUsage | null;
  total_pipeline_tokens: number;
  pipeline_tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  execution_history: StageRecord[];
  continuous_feedback?: RuntimeSnapshotContinuousFeedback | null;
  turn_history: TurnHistoryEntry[];
  recent_activity: RecentActivityEntry[];
  last_tool_call: string | null;
  failure_reason: string | null;
  health: HealthStatus;
  health_reason: string | null;
  loop_trace_preview: LoopTraceJournalPreviewResponse;
}

export interface RuntimeSnapshotOutputCaps {
  tool_output_token_limit: number;
  model_auto_compact_token_limit: number;
}

export interface RuntimeSnapshotChurn {
  compactions_per_stage: Record<string, number>;
  current_stage_compactions: number;
  max_healthy_compactions_per_stage: number;
}

export interface RuntimeSnapshotRateLimitWindowRow {
  start_pct: number;
  latest_pct: number;
  delta_pct: number;
}

export interface RuntimeSnapshotRateLimitWindowUsage {
  primary: RuntimeSnapshotRateLimitWindowRow | null;
  secondary: RuntimeSnapshotRateLimitWindowRow | null;
}

export interface RuntimeSnapshotRateLimitAdmission {
  blocked: boolean;
  reason: string | null;
  evaluated_at: string;
  min_primary_headroom_pct: number | null;
  min_secondary_headroom_pct: number | null;
  primary_used_pct: number | null;
  secondary_used_pct: number | null;
}

export interface RuntimeSnapshotContinuousFeedback {
  status: "pass" | "finding";
  last_event: "commit" | "diff" | "checkpoint";
  last_checked_at: string;
  reviewer_lane: {
    runner: string;
    model: string | null;
    role: string;
  };
  worker_lane: {
    runner: string;
    model: string | null;
    role: string;
  };
  findings: Array<{
    signature: string;
    title: string;
    detail: string;
    severity: "info" | "warning" | "blocking";
    file: string | null;
    line: number | null;
    occurrences: number;
    status: "open" | "resolved" | "bounced" | "suppressed";
    first_seen_at: string;
    last_seen_at: string;
  }>;
}

export interface RuntimeSnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RuntimeSnapshotDecorrelatedGateOutcome {
  issue_id: string;
  issue_identifier: string;
  gate_stage: string | null;
  mode: "prototype" | "thin" | "full";
  status: "passed" | "failed" | "blocked" | "skipped_prototype";
  aggregate: "pass" | "fail" | "error" | null;
  checked_at: string;
  worker_lane: {
    runner: string;
    model: string | null;
    role: string;
    stage_name: string | null;
  };
  reviewer_lanes: Array<{
    runner: string;
    model: string | null;
    role: string;
    stage_name: string | null;
  }>;
  verifier_separated: boolean;
  authoritative: boolean;
  rework_target: string | null;
  summary: string;
}

export interface RuntimeSnapshotManagerLaneRow {
  lane_id: string;
  issue_identifier: string;
  title: string;
  status: "active" | "blocked" | "degraded" | "closed";
  worker_thread_id: string;
  last_heartbeat_at: string | null;
  blocked_by: string[];
  degraded_reasons: string[];
  pr_url: string | null;
  pr_status: "draft" | "open" | "merged" | "closed" | null;
  validation_artifact_ids: string[];
  review_gate_ids: string[];
  follow_up_issue_identifiers: string[];
}

export interface RuntimeSnapshotManagerRun {
  run_id: string;
  manager_thread_id: string | null;
  title: string | null;
  started_at: string | null;
  counts: {
    active_lanes: number;
    blocked_lanes: number;
    degraded_lanes: number;
    closed_lanes: number;
    spawned_follow_ups: number;
    missing_closeout_evidence: number;
  };
  lanes: RuntimeSnapshotManagerLaneRow[];
  follow_ups: Array<{
    issue_identifier: string;
    title: string;
    parent_issue_identifier: string | null;
    lane_id: string | null;
    url: string | null;
  }>;
  escalations: Array<{
    lane_id: string | null;
    kind: string;
    severity: "warning" | "critical";
    message: string;
    raised_at: string;
  }>;
  model_checks: Array<{
    reason: "ambiguity" | "decision_quality_check";
    lane_id: string | null;
    question: string;
    requested_at: string;
  }>;
  missing_closeout_evidence: string[];
  closeout_ready: boolean;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    completed: number;
    failed: number;
  };
  running: RuntimeSnapshotRunningRow[];
  retrying: RuntimeSnapshotRetryRow[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: CodexRateLimits;
  rate_limit_admission: RuntimeSnapshotRateLimitAdmission | null;
  decorrelated_gates?: RuntimeSnapshotDecorrelatedGateOutcome[];
  decision_quality?: DispatcherDecisionQualitySummary;
  manager_runs?: RuntimeSnapshotManagerRun[];
  /**
   * Last dispatch verdict per issue id (SYMPH-405), sourced from the
   * orchestrator's in-memory last-verdict map. Every key is a real issue
   * id; pipeline-wide gate state lives in `dispatch_gate`.
   */
  dispositions?: Record<string, RuntimeSnapshotDisposition>;
  /**
   * Pipeline-wide dispatch gate/halt state (the synthetic "__dispatch__"
   * verdict scope, e.g. the global rate-limit admission floor), surfaced
   * separately so disposition consumers never meet a fake issue id.
   */
  dispatch_gate?: RuntimeSnapshotDisposition | null;
  /**
   * Issues parked behind a requires-explicit-resume mark (SYMPH-406), with
   * the reason and the journal sequence (event cursor) that set the mark.
   * The 2026-06-11 frozen-queue diagnosis collapses to this one read.
   */
  explicit_resume_required: Record<string, RuntimeSnapshotExplicitResumeMark>;
  /**
   * Journal cursor as of this snapshot (SYMPH-407): the sequence of the last
   * committed dispatcher-run journal entry. Pair with
   * GET /api/v1/state/delta?since_seq=N for cursor-forward reads.
   */
  as_of_sequence: number;
  /**
   * Per-issue durable counters (SYMPH-401), rendered next to dispositions
   * and marks: escalation-ladder step, triage-authorized resumes, rework
   * rounds, and cumulative token spend. Only issues with any non-zero
   * counter appear.
   */
  counters: Record<string, RuntimeSnapshotIssueCounters>;
  /**
   * Dual rate-limit views (SYMPH-407 / the SYMPH-338 6%-vs-98% lesson):
   * BOTH trackers side by side with their sources, plus an explicit
   * disagreement marker when they diverge.
   */
  rate_limit_views: RuntimeSnapshotRateLimitViews;
  /** Running commit vs origin/main (SYMPH-407); null until captured. */
  deploy_drift: DeployDriftStatus | null;
  /**
   * Watchdog cluster/breaker summary (SYMPH-398 machinery) with journal
   * cursors pointing at the latest transition entries.
   */
  watchdog: RuntimeSnapshotWatchdog;
  /**
   * Council v2 review state (SYMPH-451), reduced from dispatcher journal
   * events. Only scalar/safe metadata is projected: no reviewer prose,
   * prompts, diff hunks, paths, or evidence payloads.
   */
  council_reviews?: Record<string, RuntimeSnapshotCouncilReview>;
  /**
   * Fail-open component visibility (SYMPH-407 scope 5): every fail-open
   * element reports {enabled, degraded_reason?}.
   */
  components: Record<string, ComponentStatus>;
}

export interface RuntimeSnapshotIssueCounters {
  escalation_steps: number;
  triage_resumes: number;
  rework_count: number;
  spend: {
    total_tokens: number;
    completed_stage_tokens: number;
    live_stage_tokens: number;
  };
}

export interface RuntimeSnapshotRateLimitViewWindowPcts {
  primary_used_pct: number | null;
  secondary_used_pct: number | null;
}

export interface RuntimeSnapshotRateLimitRunnerFileView
  extends RuntimeSnapshotRateLimitViewWindowPcts {
  /** Provenance: the persisted runner snapshot file. */
  source: string;
  observed_at: string;
  rate_limits: Record<string, unknown>;
}

export interface RuntimeSnapshotRateLimitGateView
  extends RuntimeSnapshotRateLimitViewWindowPcts {
  /** Provenance: the dispatch admission gate's last evaluation. */
  source: string;
  evaluated_at: string;
  blocked: boolean;
  reason: string | null;
}

export interface RuntimeSnapshotRateLimitLiveView
  extends RuntimeSnapshotRateLimitViewWindowPcts {
  /** Provenance: in-memory telemetry from the runner event stream. */
  source: string;
}

export interface RuntimeSnapshotRateLimitViews {
  runner_snapshot_file: RuntimeSnapshotRateLimitRunnerFileView | null;
  gate: RuntimeSnapshotRateLimitGateView | null;
  live_telemetry: RuntimeSnapshotRateLimitLiveView | null;
  /**
   * True when the runner-file and gate views both report a primary or
   * secondary percentage and any pair differs by more than 1 percentage
   * point; null when either view is missing the comparison.
   */
  disagreement: boolean | null;
}

export interface RuntimeSnapshotWatchdogCluster {
  signature: string;
  error_class: string;
  cluster_size: number;
  member_issue_identifiers: string[];
  last_alert_size: number;
  /** Journal sequence of the latest cluster_transition for this signature. */
  last_transition_sequence: number | null;
}

export interface RuntimeSnapshotWatchdogBreaker {
  stage_name: string;
  signature: string;
  opened_at: string;
  opened_for_issue_ids: string[];
  /** Journal sequence of the latest breaker_transition for this stage. */
  last_transition_sequence: number | null;
}

export interface RuntimeSnapshotWatchdog {
  clusters: RuntimeSnapshotWatchdogCluster[];
  open_breakers: RuntimeSnapshotWatchdogBreaker[];
}

export interface RuntimeSnapshotCouncilReviewLane {
  lane_id: string;
  lane_agent: string | null;
  lane_role: string | null;
  lane_model: string | null;
  lane_state: string | null;
  lane_verdict: string | null;
  independent_reviewer: boolean | null;
  parse_status: string | null;
  degraded_reason: string | null;
  finding_count: number | null;
}

export interface RuntimeSnapshotCouncilReview {
  issue_id: string;
  issue_identifier: string;
  status:
    | "not_started"
    | "in_progress"
    | "passed"
    | "failed"
    | "degraded"
    | "escalated"
    | "unavailable";
  availability: "available" | "unavailable";
  current_round: number | null;
  last_round: number | null;
  routing_mode: string | null;
  decorrelation_basis: {
    repo: string | null;
    pr_number: number | null;
    base_ref: string | null;
    head_ref: string | null;
    base_sha: string | null;
    head_sha: string | null;
  };
  author_family: string | null;
  fixer_family: string | null;
  bundle_hash: string | null;
  reviewed_head_sha: string | null;
  lanes: RuntimeSnapshotCouncilReviewLane[];
  verdict: string | null;
  finding_counts_by_disposition: Record<string, number>;
  escalation: {
    predicate: string;
    reason: string | null;
    sequence: number;
  } | null;
  degraded: {
    status: "ok" | "degraded" | "malformed";
    reasons: string[];
    malformed_lane_count: number;
  };
  next_action: string;
  cursor_range: {
    first_sequence: number | null;
    last_sequence: number | null;
  };
}

/**
 * Host-supplied enrichment for snapshot sections whose source of truth
 * lives outside OrchestratorState (registry internals, files, git, config).
 * Everything remains composed into the ONE snapshot document — enrichment
 * is plumbing, not a second source of truth.
 */
export interface RuntimeSnapshotEnrichment {
  /** Authoritative journal cursor (accounts for burned sequences). */
  asOfSequence?: number;
  components?: Record<string, ComponentStatus>;
  deployDrift?: DeployDriftStatus | null;
  rateLimitFile?: {
    path: string;
    observedAt: string;
    rateLimits: Record<string, unknown>;
  } | null;
  watchdog?: WatchdogRegistrySnapshot | null;
  codexCaps?: {
    toolOutputTokenLimit: number;
    modelAutoCompactTokenLimit: number;
    maxHealthyCompactionsPerStage: number;
  };
}

export interface RuntimeSnapshotExplicitResumeMark {
  reason: string;
  set_by_sequence: number | null;
  since: string;
}

export interface RuntimeSnapshotDisposition {
  disposition: "admit" | "skip" | "gate" | "halt";
  reason_code: string;
  remedy: string | null;
  since: string;
}

export function buildRuntimeSnapshot(
  state: OrchestratorState,
  options?: {
    now?: Date;
    enrichment?: RuntimeSnapshotEnrichment;
  },
): RuntimeSnapshot {
  const now = options?.now ?? new Date();
  const enrichment = options?.enrichment;
  const codexCaps = {
    toolOutputTokenLimit:
      enrichment?.codexCaps?.toolOutputTokenLimit ??
      DEFAULT_CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    modelAutoCompactTokenLimit:
      enrichment?.codexCaps?.modelAutoCompactTokenLimit ??
      DEFAULT_CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    maxHealthyCompactionsPerStage:
      enrichment?.codexCaps?.maxHealthyCompactionsPerStage ??
      DEFAULT_CODEX_MAX_HEALTHY_COMPACTIONS_PER_STAGE,
  };

  const running = Object.values(state.running)
    .slice()
    .sort((left, right) =>
      left.identifier.localeCompare(right.identifier, "en"),
    )
    .map((entry) => {
      const reworkCount = state.issueReworkCounts[entry.issue.id] ?? 0;
      const startedAtMs = Date.parse(entry.startedAt);
      const stageDurationSeconds = Number.isFinite(startedAtMs)
        ? Math.max(0, (now.getTime() - startedAtMs) / 1000)
        : 0;
      const tokensPerTurn =
        entry.turnCount > 0 ? entry.totalStageTotalTokens / entry.turnCount : 0;
      const executionHistory =
        state.issueExecutionHistory[entry.issue.id] ?? [];
      const continuousFeedback = state.continuousFeedback[entry.issue.id];
      const completedStageTokens = executionHistory.reduce(
        (sum, stage) => sum + stage.totalTokens,
        0,
      );
      const totalPipelineTokens =
        completedStageTokens + entry.totalStageTotalTokens;
      const pipelineInputTokens =
        executionHistory.reduce(
          (sum, stage) => sum + (stage.inputTokens ?? 0),
          0,
        ) + entry.totalStageInputTokens;
      const pipelineOutputTokens =
        executionHistory.reduce(
          (sum, stage) => sum + (stage.outputTokens ?? 0),
          0,
        ) + entry.totalStageOutputTokens;
      const pipelineCacheReadTokens =
        executionHistory.reduce(
          (sum, stage) => sum + (stage.cacheReadTokens ?? 0),
          0,
        ) + entry.totalStageCacheReadTokens;
      const pipelineCacheWriteTokens =
        executionHistory.reduce(
          (sum, stage) => sum + (stage.cacheWriteTokens ?? 0),
          0,
        ) + entry.totalStageCacheWriteTokens;
      const pipelineStage = state.issueStages[entry.issue.id] ?? null;
      const compactionsPerStage = buildCompactionsPerStage(
        executionHistory,
        pipelineStage,
        entry.totalStageCompactions ?? 0,
      );
      const { health, health_reason } = classifyHealth(
        entry.lastCodexTimestamp,
        tokensPerTurn,
        entry.totalStageCompactions ?? 0,
        codexCaps.maxHealthyCompactionsPerStage,
        now,
        pipelineStage,
      );
      const row: RuntimeSnapshotRunningRow = {
        issue_id: entry.issue.id,
        issue_identifier: entry.identifier,
        issue_title: entry.issue.title,
        state: entry.issue.state,
        pipeline_stage: pipelineStage,
        activity_summary: entry.lastCodexMessage,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        started_at: entry.startedAt,
        first_dispatched_at:
          state.issueFirstDispatchedAt[entry.issue.id] ?? entry.startedAt,
        last_event_at:
          entry.lastCodexTimestamp !== null
            ? formatEasternTimestamp(new Date(entry.lastCodexTimestamp))
            : null,
        stage_duration_seconds: stageDurationSeconds,
        tokens_per_turn: tokensPerTurn,
        tokens: {
          input_tokens: entry.totalStageInputTokens,
          output_tokens: entry.totalStageOutputTokens,
          total_tokens: entry.totalStageTotalTokens,
          cache_read_tokens: entry.totalStageCacheReadTokens,
          cache_write_tokens: entry.totalStageCacheWriteTokens,
          reasoning_tokens: entry.codexReasoningTokens,
        },
        total_pipeline_tokens: totalPipelineTokens,
        pipeline_tokens: {
          input_tokens: pipelineInputTokens,
          output_tokens: pipelineOutputTokens,
          total_tokens: totalPipelineTokens,
          cache_read_tokens: pipelineCacheReadTokens,
          cache_write_tokens: pipelineCacheWriteTokens,
        },
        output_caps: {
          tool_output_token_limit: codexCaps.toolOutputTokenLimit,
          model_auto_compact_token_limit: codexCaps.modelAutoCompactTokenLimit,
        },
        churn: {
          compactions_per_stage: compactionsPerStage,
          current_stage_compactions: entry.totalStageCompactions ?? 0,
          max_healthy_compactions_per_stage:
            codexCaps.maxHealthyCompactionsPerStage,
        },
        rate_limit_window: toSnapshotRateLimitWindowUsage(
          entry.rateLimitWindows,
        ),
        execution_history: executionHistory,
        continuous_feedback:
          continuousFeedback === undefined
            ? null
            : toSnapshotContinuousFeedback(continuousFeedback),
        turn_history: entry.turnHistory,
        recent_activity: entry.recentActivity,
        last_tool_call: deriveLastToolCall(entry.recentActivity),
        failure_reason: entry.failureReason ?? null,
        health,
        health_reason,
        loop_trace_preview: buildLoopTraceJournalPreview(
          state.loopTraceJournal[entry.issue.id] ?? [],
        ),
      };
      if (reworkCount > 0) {
        row.rework_count = reworkCount;
      }
      return row;
    });

  const retrying = Object.values(state.retryAttempts)
    .slice()
    .sort((left, right) => left.dueAtMs - right.dueAtMs)
    .map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: formatEasternTimestamp(new Date(entry.dueAtMs)),
      error: entry.error,
    }));

  return {
    generated_at: formatEasternTimestamp(now),
    counts: {
      running: running.length,
      retrying: retrying.length,
      completed: state.completed.size,
      failed: state.failed.size,
    },
    running,
    retrying,
    codex_totals: toSnapshotCodexTotals(
      state.codexTotals,
      getAggregateSecondsRunning(state, now),
    ),
    rate_limits: state.codexRateLimits,
    rate_limit_admission:
      state.rateLimitAdmission === null
        ? null
        : {
            blocked: state.rateLimitAdmission.blocked,
            reason: state.rateLimitAdmission.reason,
            evaluated_at: state.rateLimitAdmission.evaluatedAt,
            min_primary_headroom_pct:
              state.rateLimitAdmission.minPrimaryHeadroomPct,
            min_secondary_headroom_pct:
              state.rateLimitAdmission.minSecondaryHeadroomPct,
            primary_used_pct: state.rateLimitAdmission.primaryUsedPercent,
            secondary_used_pct: state.rateLimitAdmission.secondaryUsedPercent,
          },
    decorrelated_gates: buildDecorrelatedGateSnapshots(state),
    decision_quality: evaluateDispatcherDecisionQuality(
      extractDispatcherDecisionEvents(state.dispatcherRunJournal),
    ),
    manager_runs: buildManagerRunSnapshots(state),
    dispositions: buildDispositionSnapshots(state),
    dispatch_gate: buildDispatchGateSnapshot(state),
    explicit_resume_required: buildExplicitResumeMarks(state, now),
    as_of_sequence:
      enrichment?.asOfSequence ??
      state.dispatcherRunJournal.at(-1)?.sequence ??
      0,
    counters: buildIssueCounters(state),
    rate_limit_views: buildRateLimitViews(state, enrichment),
    deploy_drift: enrichment?.deployDrift ?? null,
    watchdog: buildWatchdogSection(state, enrichment?.watchdog ?? null),
    council_reviews: buildCouncilReviewSnapshots(state),
    components: enrichment?.components ?? {},
  };
}

const REVIEW_JOURNAL_EVENT_KINDS = new Set<DispatcherRunJournalEventKind>([
  "review_round",
  "fix_round",
  "review_rework",
  "review_lane",
  "review_finding",
  "review_synthesis",
  "review_escalation",
  "review_gate_result",
]);

const REVIEW_RELEVANT_STAGES = new Set([
  "review",
  "review_gate",
  "merge",
  "done",
]);

function buildCouncilReviewSnapshots(
  state: OrchestratorState,
): Record<string, RuntimeSnapshotCouncilReview> {
  const issueIdentifiers = buildIssueIdentifierMap(state);
  const issueIds = new Set<string>();

  for (const entry of state.dispatcherRunJournal) {
    if (REVIEW_JOURNAL_EVENT_KINDS.has(entry.kind)) {
      issueIds.add(entry.issueId);
      issueIdentifiers.set(entry.issueId, entry.issueIdentifier);
    }
  }
  for (const [issueId, stage] of Object.entries(state.issueStages)) {
    if (REVIEW_RELEVANT_STAGES.has(stage)) {
      issueIds.add(issueId);
    }
  }
  for (const [issueId, passedStages] of Object.entries(
    state.issuePassedStages,
  )) {
    if (passedStages.some((stage) => REVIEW_RELEVANT_STAGES.has(stage))) {
      issueIds.add(issueId);
    }
  }

  const reviews: Record<string, RuntimeSnapshotCouncilReview> = {};
  for (const issueId of [...issueIds].sort((left, right) =>
    (issueIdentifiers.get(left) ?? left).localeCompare(
      issueIdentifiers.get(right) ?? right,
      "en",
    ),
  )) {
    const entries = state.dispatcherRunJournal
      .filter(
        (entry) =>
          entry.issueId === issueId &&
          REVIEW_JOURNAL_EVENT_KINDS.has(entry.kind),
      )
      .sort((left, right) => left.sequence - right.sequence);
    reviews[issueId] =
      entries.length === 0
        ? emptyCouncilReviewSnapshot(
            issueId,
            issueIdentifiers.get(issueId) ?? issueId,
          )
        : reduceCouncilReviewEntries(
            issueId,
            issueIdentifiers.get(issueId) ??
              entries.at(-1)?.issueIdentifier ??
              issueId,
            entries,
          );
  }

  return reviews;
}

function buildIssueIdentifierMap(
  state: OrchestratorState,
): Map<string, string> {
  const identifiers = new Map<string, string>();
  for (const entry of Object.values(state.running)) {
    identifiers.set(entry.issue.id, entry.identifier);
  }
  for (const retry of Object.values(state.retryAttempts)) {
    if (retry.identifier !== null) {
      identifiers.set(retry.issueId, retry.identifier);
    }
  }
  return identifiers;
}

function emptyCouncilReviewSnapshot(
  issueId: string,
  issueIdentifier: string,
): RuntimeSnapshotCouncilReview {
  return {
    issue_id: issueId,
    issue_identifier: issueIdentifier,
    status: "not_started",
    availability: "unavailable",
    current_round: null,
    last_round: null,
    routing_mode: null,
    decorrelation_basis: {
      repo: null,
      pr_number: null,
      base_ref: null,
      head_ref: null,
      base_sha: null,
      head_sha: null,
    },
    author_family: null,
    fixer_family: null,
    bundle_hash: null,
    reviewed_head_sha: null,
    lanes: [],
    verdict: null,
    finding_counts_by_disposition: {},
    escalation: null,
    degraded: {
      status: "ok",
      reasons: [],
      malformed_lane_count: 0,
    },
    next_action: "await_review_events",
    cursor_range: {
      first_sequence: null,
      last_sequence: null,
    },
  };
}

function reduceCouncilReviewEntries(
  issueId: string,
  issueIdentifier: string,
  entries: DispatcherRunJournalEntry[],
): RuntimeSnapshotCouncilReview {
  const currentRound = entries.reduce<number | null>(
    (round, entry) => latestNumber(round, entry.metadata.round),
    null,
  );
  const lastCompletedRound = entries.reduce<number | null>(
    (round, entry) =>
      entry.kind === "review_gate_result"
        ? latestNumber(round, entry.metadata.round)
        : round,
    null,
  );
  const stateRound = currentRound ?? lastCompletedRound;
  const stateEntries =
    stateRound === null
      ? entries
      : entries.filter(
          (entry) => numberFieldOrNull(entry.metadata.round) === stateRound,
        );
  const lanes = new Map<string, RuntimeSnapshotCouncilReviewLane>();
  const findingDispositionByFingerprint = new Map<string, string>();
  const degradedReasons = new Set<string>();
  let malformedLaneCount = 0;
  let escalation: RuntimeSnapshotCouncilReview["escalation"] = null;
  let gateVerdict: string | null = null;
  let routingMode: string | null = null;
  let repo: string | null = null;
  let prNumber: number | null = null;
  let baseRef: string | null = null;
  let headRef: string | null = null;
  let baseSha: string | null = null;
  let headSha: string | null = null;
  let bundleHash: string | null = null;
  let reviewedHeadSha: string | null = null;
  let authorFamily: string | null = null;
  let fixerFamily: string | null = null;

  for (const entry of stateEntries) {
    const metadata = entry.metadata;
    routingMode = latestString(routingMode, metadata.routing_mode);
    repo = latestString(repo, metadata.repo);
    prNumber = latestNumber(prNumber, metadata.pr_number);
    baseRef = latestString(baseRef, metadata.base_ref);
    headRef = latestString(headRef, metadata.head_ref);
    baseSha = latestString(baseSha, metadata.base_sha);
    headSha = latestString(headSha, metadata.head_sha);
    bundleHash = latestString(bundleHash, metadata.bundle_hash);
    reviewedHeadSha = latestString(reviewedHeadSha, metadata.reviewed_head_sha);
    authorFamily = latestString(authorFamily, metadata.author_family);
    fixerFamily = latestString(fixerFamily, metadata.fixer_family);

    if (entry.kind === "review_lane") {
      const parseStatus = stringField(metadata.parse_status);
      const degradedReason = stringField(metadata.degraded_reason);
      if (degradedReason !== null) {
        degradedReasons.add(degradedReason);
      }
      if (parseStatus !== null && parseStatus !== "ok") {
        malformedLaneCount += 1;
      }
      const laneId = stringField(metadata.lane_id);
      if (laneId !== null) {
        lanes.set(laneId, {
          lane_id: laneId,
          lane_agent: stringField(metadata.lane_agent),
          lane_role: stringField(metadata.lane_role),
          lane_model: stringField(metadata.lane_model),
          lane_state: stringField(metadata.lane_state),
          lane_verdict: stringField(metadata.lane_verdict),
          independent_reviewer: booleanField(metadata.independent_reviewer),
          parse_status: parseStatus,
          degraded_reason: degradedReason,
          finding_count: numberFieldOrNull(metadata.finding_count),
        });
      }
    } else if (entry.kind === "review_finding") {
      const disposition =
        stringField(metadata.finding_disposition) ?? "unknown";
      const fingerprint =
        stringField(metadata.finding_fingerprint) ??
        `sequence:${entry.sequence}`;
      findingDispositionByFingerprint.set(fingerprint, disposition);
    } else if (entry.kind === "review_escalation") {
      const reason = stringField(metadata.escalation_reason);
      escalation = {
        predicate: reason ?? "review_escalation",
        reason,
        sequence: entry.sequence,
      };
      for (const condition of stringArrayField(metadata.degraded_conditions)) {
        degradedReasons.add(condition);
      }
    } else if (entry.kind === "review_gate_result") {
      gateVerdict = latestString(gateVerdict, metadata.gate_verdict);
      const degradedCount = numberFieldOrNull(
        metadata.degraded_condition_count,
      );
      if (degradedCount !== null && degradedCount > 0) {
        degradedReasons.add("degraded_review_substrate");
      }
      reviewedHeadSha =
        stringField(metadata.reviewed_head_sha) ??
        stringField(metadata.head_sha) ??
        reviewedHeadSha;
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const disposition of findingDispositionByFingerprint.values()) {
    findingCounts[disposition] = (findingCounts[disposition] ?? 0) + 1;
  }

  const degradedStatus =
    malformedLaneCount > 0
      ? "malformed"
      : degradedReasons.size > 0
        ? "degraded"
        : "ok";
  const status = councilReviewStatus({
    gateVerdict,
    escalation,
    degradedStatus,
    entries,
  });

  return {
    issue_id: issueId,
    issue_identifier: issueIdentifier,
    status,
    availability: "available",
    current_round: currentRound,
    last_round: lastCompletedRound,
    routing_mode: routingMode,
    decorrelation_basis: {
      repo,
      pr_number: prNumber,
      base_ref: baseRef,
      head_ref: headRef,
      base_sha: baseSha,
      head_sha: headSha,
    },
    author_family: authorFamily,
    fixer_family: fixerFamily,
    bundle_hash: bundleHash,
    reviewed_head_sha: reviewedHeadSha ?? headSha,
    lanes: [...lanes.values()].sort((left, right) =>
      left.lane_id.localeCompare(right.lane_id, "en"),
    ),
    verdict: gateVerdict,
    finding_counts_by_disposition: Object.fromEntries(
      Object.entries(findingCounts).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
    escalation,
    degraded: {
      status: degradedStatus,
      reasons: [...degradedReasons].sort(),
      malformed_lane_count: malformedLaneCount,
    },
    next_action: councilReviewNextAction(status, gateVerdict),
    cursor_range: {
      first_sequence: entries[0]?.sequence ?? null,
      last_sequence: entries.at(-1)?.sequence ?? null,
    },
  };
}

function councilReviewStatus(input: {
  gateVerdict: string | null;
  escalation: RuntimeSnapshotCouncilReview["escalation"];
  degradedStatus: RuntimeSnapshotCouncilReview["degraded"]["status"];
  entries: DispatcherRunJournalEntry[];
}): RuntimeSnapshotCouncilReview["status"] {
  // A degraded substrate takes precedence over escalation because the
  // escalation record is itself evidence that review signals need inspection.
  if (input.degradedStatus !== "ok") {
    return "degraded";
  }
  if (input.escalation !== null) {
    return "escalated";
  }
  if (input.gateVerdict === "pass") {
    return "passed";
  }
  if (input.gateVerdict === "fail" || input.gateVerdict === "error") {
    return "failed";
  }
  return input.entries.some((entry) => entry.kind === "review_round")
    ? "in_progress"
    : "unavailable";
}

function councilReviewNextAction(
  status: RuntimeSnapshotCouncilReview["status"],
  gateVerdict: string | null,
): string {
  if (status === "passed") {
    return "continue_pipeline";
  }
  if (status === "failed" || status === "escalated") {
    return "rework_required";
  }
  if (status === "degraded" || status === "unavailable") {
    return "inspect_review_substrate";
  }
  if (status === "in_progress" && gateVerdict === null) {
    return "await_review_gate_result";
  }
  return "inspect_review_result";
}

function latestString(current: string | null, value: unknown): string | null {
  return typeof value === "string" ? value : current;
}

function latestNumber(current: number | null, value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : current;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberFieldOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Per-issue durable counters (SYMPH-401) rendered coherently with
 * dispositions and explicit-resume marks: one map keyed by issue id, only
 * issues with any non-zero counter included. Spend is the sum of journaled
 * stage_record history plus the live in-flight stage.
 */
function buildIssueCounters(
  state: OrchestratorState,
): Record<string, RuntimeSnapshotIssueCounters> {
  const issueIds = new Set<string>([
    ...Object.keys(state.issueBudgetEscalations),
    ...Object.keys(state.issuePauseTriageResumes),
    ...Object.keys(state.issueReworkCounts),
    ...Object.keys(state.issueExecutionHistory),
    ...Object.values(state.running).map((entry) => entry.issue.id),
  ]);

  const counters: Record<string, RuntimeSnapshotIssueCounters> = {};
  for (const issueId of issueIds) {
    const completedStageTokens = (
      state.issueExecutionHistory[issueId] ?? []
    ).reduce((sum, stage) => sum + stage.totalTokens, 0);
    const liveStageTokens = state.running[issueId]?.totalStageTotalTokens ?? 0;
    const entry: RuntimeSnapshotIssueCounters = {
      escalation_steps: state.issueBudgetEscalations[issueId] ?? 0,
      triage_resumes: state.issuePauseTriageResumes[issueId] ?? 0,
      rework_count: state.issueReworkCounts[issueId] ?? 0,
      spend: {
        total_tokens: completedStageTokens + liveStageTokens,
        completed_stage_tokens: completedStageTokens,
        live_stage_tokens: liveStageTokens,
      },
    };
    if (
      entry.escalation_steps > 0 ||
      entry.triage_resumes > 0 ||
      entry.rework_count > 0 ||
      entry.spend.total_tokens > 0
    ) {
      counters[issueId] = entry;
    }
  }
  return counters;
}

const RATE_VIEW_DISAGREEMENT_THRESHOLD_PCT = 1;

function buildRateLimitViews(
  state: OrchestratorState,
  enrichment: RuntimeSnapshotEnrichment | undefined,
): RuntimeSnapshotRateLimitViews {
  const file = enrichment?.rateLimitFile ?? null;
  let runnerSnapshotFile: RuntimeSnapshotRateLimitRunnerFileView | null = null;
  if (file !== null) {
    const parsed = parseRateLimitSnapshot(file.rateLimits);
    runnerSnapshotFile = {
      source: file.path,
      observed_at: file.observedAt,
      rate_limits: file.rateLimits,
      primary_used_pct: parsed?.primary?.usedPercent ?? null,
      secondary_used_pct: parsed?.secondary?.usedPercent ?? null,
    };
  }

  const admission = state.rateLimitAdmission;
  const gate: RuntimeSnapshotRateLimitGateView | null =
    admission === null
      ? null
      : {
          source: "dispatch admission gate (rate_limit_admission evaluation)",
          evaluated_at: admission.evaluatedAt,
          blocked: admission.blocked,
          reason: admission.reason,
          primary_used_pct: admission.primaryUsedPercent,
          secondary_used_pct: admission.secondaryUsedPercent,
        };

  let liveTelemetry: RuntimeSnapshotRateLimitLiveView | null = null;
  const liveParsed = parseRateLimitSnapshot(state.codexRateLimits);
  if (liveParsed !== null) {
    liveTelemetry = {
      source: "in-memory runner telemetry (orchestrator state)",
      primary_used_pct: liveParsed.primary?.usedPercent ?? null,
      secondary_used_pct: liveParsed.secondary?.usedPercent ?? null,
    };
  }

  return {
    runner_snapshot_file: runnerSnapshotFile,
    gate,
    live_telemetry: liveTelemetry,
    disagreement: computeRateViewDisagreement(runnerSnapshotFile, gate),
  };
}

function computeRateViewDisagreement(
  file: RuntimeSnapshotRateLimitViewWindowPcts | null,
  gate: RuntimeSnapshotRateLimitViewWindowPcts | null,
): boolean | null {
  if (file === null || gate === null) {
    return null;
  }
  const pairs: Array<[number | null, number | null]> = [
    [file.primary_used_pct, gate.primary_used_pct],
    [file.secondary_used_pct, gate.secondary_used_pct],
  ];
  const comparable = pairs.filter(
    (pair): pair is [number, number] => pair[0] !== null && pair[1] !== null,
  );
  if (comparable.length === 0) {
    return null;
  }
  return comparable.some(
    ([left, right]) =>
      Math.abs(left - right) > RATE_VIEW_DISAGREEMENT_THRESHOLD_PCT,
  );
}

function buildWatchdogSection(
  state: OrchestratorState,
  registry: WatchdogRegistrySnapshot | null,
): RuntimeSnapshotWatchdog {
  // Latest transition cursor per signature / per stage from the journal —
  // the cursor an agent feeds into since_seq to fetch the exact slice.
  const clusterCursors = new Map<string, number>();
  const breakerCursors = new Map<string, number>();
  for (const entry of state.dispatcherRunJournal) {
    if (entry.kind === "cluster_transition") {
      const signature = entry.metadata.signature;
      if (typeof signature === "string") {
        clusterCursors.set(signature, entry.sequence);
      }
    } else if (entry.kind === "breaker_transition") {
      const stage = entry.metadata.stage;
      if (typeof stage === "string") {
        breakerCursors.set(stage, entry.sequence);
      }
    }
  }

  return {
    clusters: (registry?.clusters ?? []).map((cluster) => ({
      ...cluster,
      last_transition_sequence: clusterCursors.get(cluster.signature) ?? null,
    })),
    open_breakers: (registry?.openBreakers ?? []).map((breaker) => ({
      ...breaker,
      last_transition_sequence: breakerCursors.get(breaker.stage_name) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cursor-forward delta reads (SYMPH-407 scope 6)
// ---------------------------------------------------------------------------

export const STATE_DELTA_DEFAULT_LIMIT = 100;
export const STATE_DELTA_MAX_LIMIT = 500;

/**
 * Whitelisted scalar/count metadata projected onto delta entries. Raw journal
 * metadata is an untyped bag that can carry suppressed egress content
 * (cluster_transition `details.normalizedText`/`members` hold raw agent
 * output the notifier and watchdog filer deliberately redact) — only these
 * known-safe scalar fields ever cross the delta endpoint.
 *
 * Review metadata follows the same contract: array-valued fields such as
 * `review_rework.metadata.introduced_in`,
 * `review_synthesis.metadata.finding_fingerprints`,
 * `review_escalation.metadata.degraded_conditions`, `related_paths`, and
 * `evidence_locations` remain raw-journal-only. Operator surfaces use bounded
 * scalar/count projections like `rework_finding_count`,
 * `blocking_finding_count`, and `degraded_condition_count`.
 */
export interface StateDeltaEntryMetadata {
  status?: string;
  verb?: string;
  disposition?: string;
  signature?: string;
  transition?: string;
  scope?: string;
  step?: string;
  resumesUsed?: number;
  actor_kind?: string;
  actor_id?: string;
  source?: string;
  contract_version?: string;
  repo?: string;
  base_ref?: string;
  head_ref?: string;
  base_sha?: string;
  head_sha?: string;
  previous_head_sha?: string;
  bundle_hash?: string;
  routing_mode?: string;
  round?: number;
  pr_number?: number;
  started_at?: string;
  completed_at?: string;
  gate_verdict?: string;
  escalation_reason?: string;
  lane_id?: string;
  lane_agent?: string;
  lane_role?: string;
  lane_model?: string;
  lane_state?: string;
  lane_verdict?: string;
  independent_reviewer?: boolean;
  degraded_reason?: string;
  parse_status?: string;
  finding_fingerprint?: string;
  finding_severity?: string;
  emitted_severity?: string;
  finding_disposition?: string;
  repeat_of?: string;
  introduced_in?: string;
  family?: string;
  category?: string;
  narrowing_status?: string;
  narrowing_rationale?: string;
  resume_reason?: string;
  rework_count?: number;
  lane_count?: number;
  finding_count?: number;
  blocking_finding_count?: number;
  degraded_condition_count?: number;
  wall_time_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  confidence?: number;
  fixed_symptom_count?: number;
  remaining_symptom_count?: number;
  rework_finding_count?: number;
  fix_round?: number;
}

/**
 * Redacted egress projection of a dispatcher journal entry — same
 * field-projection discipline as the loop_trace_preview shape. Never a
 * raw `DispatcherRunJournalEntry` passthrough.
 */
export interface StateDeltaEntry {
  sequence: number;
  timestamp: string;
  kind: DispatcherRunJournalEventKind;
  issueId: string;
  issueIdentifier: string;
  operation: DispatcherOperation;
  stage: string | null;
  attempt: number | null;
  summary: string;
  metadata: StateDeltaEntryMetadata;
}

export interface StateDeltaResponse {
  /** The cursor the caller supplied. */
  since_seq: number;
  /** Current journal cursor — feed back as the next since_seq. */
  as_of_sequence: number;
  count: number;
  /** True when more entries exist beyond `entries` (page was capped). */
  truncated: boolean;
  entries: StateDeltaEntry[];
}

const STATE_DELTA_METADATA_STRING_FIELDS = [
  "status",
  "verb",
  "disposition",
  "signature",
  "transition",
  "scope",
  "step",
  "actor_kind",
  "actor_id",
  "source",
  "contract_version",
  "repo",
  "base_ref",
  "head_ref",
  "base_sha",
  "head_sha",
  "previous_head_sha",
  "bundle_hash",
  "routing_mode",
  "started_at",
  "completed_at",
  "gate_verdict",
  "escalation_reason",
  "lane_id",
  "lane_agent",
  "lane_role",
  "lane_model",
  "lane_state",
  "lane_verdict",
  "degraded_reason",
  "parse_status",
  "finding_fingerprint",
  "finding_severity",
  "emitted_severity",
  "finding_disposition",
  "repeat_of",
  "introduced_in",
  "family",
  "category",
  "narrowing_status",
  "narrowing_rationale",
  "resume_reason",
] as const;

const STATE_DELTA_METADATA_NUMBER_FIELDS = [
  "resumesUsed",
  "round",
  "rework_count",
  "pr_number",
  "lane_count",
  "finding_count",
  "blocking_finding_count",
  "degraded_condition_count",
  "wall_time_ms",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "confidence",
  "fixed_symptom_count",
  "remaining_symptom_count",
  "rework_finding_count",
  "fix_round",
] as const;

const STATE_DELTA_METADATA_BOOLEAN_FIELDS = ["independent_reviewer"] as const;

function projectStateDeltaMetadata(
  metadata: Record<string, unknown>,
): StateDeltaEntryMetadata {
  const projected: StateDeltaEntryMetadata = {};
  for (const field of STATE_DELTA_METADATA_STRING_FIELDS) {
    const value = metadata[field];
    if (typeof value === "string") {
      projected[field] = value;
    }
  }
  for (const field of STATE_DELTA_METADATA_NUMBER_FIELDS) {
    const value = metadata[field];
    if (typeof value === "number") {
      projected[field] = value;
    }
  }
  for (const field of STATE_DELTA_METADATA_BOOLEAN_FIELDS) {
    const value = metadata[field];
    if (typeof value === "boolean") {
      projected[field] = value;
    }
  }
  return projected;
}

function toStateDeltaEntry(entry: DispatcherRunJournalEntry): StateDeltaEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    kind: entry.kind,
    issueId: entry.issueId,
    issueIdentifier: entry.issueIdentifier,
    operation: entry.operation,
    stage: entry.stage,
    attempt: entry.attempt,
    summary: entry.summary,
    metadata: projectStateDeltaMetadata(entry.metadata),
  };
}

/**
 * Journal-backed deltas between two cursors: every committed entry with
 * sequence > since_seq, ascending, capped at `limit`. The journal is the
 * single source of truth — this is a windowed read of the same entries the
 * snapshot reducers consume.
 */
export function buildStateDelta(
  journal: DispatcherRunJournal,
  input: { sinceSeq: number; limit?: number; asOfSequence?: number },
): StateDeltaResponse {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? STATE_DELTA_DEFAULT_LIMIT, STATE_DELTA_MAX_LIMIT),
  );
  const matching = journal
    .filter((entry) => entry.sequence > input.sinceSeq)
    .sort((left, right) => left.sequence - right.sequence);
  const entries = matching.slice(0, limit);
  return {
    since_seq: input.sinceSeq,
    as_of_sequence:
      input.asOfSequence ?? journal.at(-1)?.sequence ?? input.sinceSeq,
    count: entries.length,
    truncated: matching.length > entries.length,
    entries: entries.map(toStateDeltaEntry),
  };
}

function buildExplicitResumeMarks(
  state: OrchestratorState,
  now: Date,
): Record<string, RuntimeSnapshotExplicitResumeMark> {
  const marks: Record<string, RuntimeSnapshotExplicitResumeMark> = {};
  for (const issueId of state.resumeRequired) {
    const mark = state.resumeRequiredMarks[issueId];
    if (mark === undefined) {
      // Canary: every resumeRequired entry should carry a mark record
      // (recordIssueRequiresExplicitResume writes both together). A missing
      // mark means a writer bypassed the mark surface — degrade to the
      // snapshot's own timestamp rather than a blank `since`.
      console.warn(
        `[runtime-snapshot] issue ${issueId} is in resumeRequired without a mark record — degraded explicit_resume_required entry`,
      );
    }
    marks[issueId] = {
      reason: mark?.reason ?? "stop_like_pause",
      set_by_sequence: mark?.setBySequence ?? null,
      since: mark?.since ?? now.toISOString(),
    };
  }
  return marks;
}

function buildDispositionSnapshots(
  state: OrchestratorState,
): Record<string, RuntimeSnapshotDisposition> {
  const dispositions: Record<string, RuntimeSnapshotDisposition> = {};
  for (const [issueId, record] of Object.entries(state.issueDispositions)) {
    if (issueId === PIPELINE_VERDICT_SCOPE_ID) {
      continue;
    }
    dispositions[issueId] = toSnapshotDisposition(record);
  }
  return dispositions;
}

function buildDispatchGateSnapshot(
  state: OrchestratorState,
): RuntimeSnapshotDisposition | null {
  const record = state.issueDispositions[PIPELINE_VERDICT_SCOPE_ID];
  return record === undefined ? null : toSnapshotDisposition(record);
}

function toSnapshotDisposition(
  record: IssueDispositionRecord,
): RuntimeSnapshotDisposition {
  return {
    disposition: record.disposition,
    reason_code: record.reasonCode,
    remedy: record.remedy,
    since: record.since,
  };
}

function toSnapshotRateLimitWindowUsage(
  windows: SessionRateLimitTelemetry,
): RuntimeSnapshotRateLimitWindowUsage | null {
  if (windows.primary === null && windows.secondary === null) {
    return null;
  }

  return {
    primary: toSnapshotRateLimitWindowRow(windows.primary),
    secondary: toSnapshotRateLimitWindowRow(windows.secondary),
  };
}

function toSnapshotRateLimitWindowRow(
  window: SessionRateLimitWindowTelemetry | null,
): RuntimeSnapshotRateLimitWindowRow | null {
  if (window === null) {
    return null;
  }

  return {
    start_pct: window.startPercent,
    latest_pct: window.latestPercent,
    delta_pct: Math.max(0, window.latestPercent - window.startPercent),
  };
}

function buildDecorrelatedGateSnapshots(
  state: OrchestratorState,
): RuntimeSnapshotDecorrelatedGateOutcome[] {
  return Object.values(state.decorrelatedGateOutcomes)
    .flat()
    .sort((left, right) =>
      left.checkedAt === right.checkedAt
        ? left.issueIdentifier.localeCompare(right.issueIdentifier, "en")
        : left.checkedAt.localeCompare(right.checkedAt),
    )
    .map(toSnapshotDecorrelatedGateOutcome);
}

function toSnapshotDecorrelatedGateOutcome(
  outcome: DecorrelatedGateOutcome,
): RuntimeSnapshotDecorrelatedGateOutcome {
  return {
    issue_id: outcome.issueId,
    issue_identifier: outcome.issueIdentifier,
    gate_stage: outcome.gateStage,
    mode: outcome.mode,
    status: outcome.status,
    aggregate: outcome.aggregate,
    checked_at: outcome.checkedAt,
    worker_lane: {
      runner: outcome.workerLane.runner,
      model: outcome.workerLane.model,
      role: outcome.workerLane.role,
      stage_name: outcome.workerLane.stageName,
    },
    reviewer_lanes: outcome.reviewerLanes.map((lane) => ({
      runner: lane.runner,
      model: lane.model,
      role: lane.role,
      stage_name: lane.stageName,
    })),
    verifier_separated: outcome.verifierSeparated,
    authoritative: outcome.authoritative,
    rework_target: outcome.reworkTarget,
    summary: outcome.summary,
  };
}

function buildManagerRunSnapshots(
  state: OrchestratorState,
): RuntimeSnapshotManagerRun[] {
  return Object.values(state.managerRuns)
    .slice()
    .sort((left, right) => left.runId.localeCompare(right.runId, "en"))
    .map((run) => {
      const lanes = Object.values(run.lanes)
        .slice()
        .sort((left, right) =>
          left.issueIdentifier.localeCompare(right.issueIdentifier, "en"),
        )
        .map((lane) => ({
          lane_id: lane.laneId,
          issue_identifier: lane.issueIdentifier,
          title: lane.title,
          status: lane.status,
          worker_thread_id: lane.workerThreadId,
          last_heartbeat_at: lane.lastHeartbeatAt,
          blocked_by: lane.blockedBy,
          degraded_reasons: lane.degradedReasons,
          pr_url: lane.prUrl,
          pr_status: lane.prStatus,
          validation_artifact_ids: lane.validationArtifactIds,
          review_gate_ids: lane.reviewGateIds,
          follow_up_issue_identifiers: lane.followUpIssueIdentifiers,
        }));
      return {
        run_id: run.runId,
        manager_thread_id: run.managerThreadId,
        title: run.title,
        started_at: run.startedAt,
        counts: {
          active_lanes: lanes.filter((lane) => lane.status === "active").length,
          blocked_lanes: lanes.filter((lane) => lane.status === "blocked")
            .length,
          degraded_lanes: lanes.filter((lane) => lane.status === "degraded")
            .length,
          closed_lanes: lanes.filter((lane) => lane.status === "closed").length,
          spawned_follow_ups: Object.keys(run.followUps).length,
          missing_closeout_evidence: run.closeout.missingEvidence.length,
        },
        lanes,
        follow_ups: Object.values(run.followUps)
          .slice()
          .sort((left, right) =>
            left.issueIdentifier.localeCompare(right.issueIdentifier, "en"),
          )
          .map((followUp) => ({
            issue_identifier: followUp.issueIdentifier,
            title: followUp.title,
            parent_issue_identifier: followUp.parentIssueIdentifier,
            lane_id: followUp.laneId,
            url: followUp.url,
          })),
        escalations: run.escalations.map((escalation) => ({
          lane_id: escalation.laneId,
          kind: escalation.kind,
          severity: escalation.severity,
          message: escalation.message,
          raised_at: escalation.raisedAt,
        })),
        model_checks: run.modelCallPolicy.pendingChecks.map((check) => ({
          reason: check.reason,
          lane_id: check.laneId,
          question: check.question,
          requested_at: check.requestedAt,
        })),
        missing_closeout_evidence: run.closeout.missingEvidence,
        closeout_ready: run.closeout.ready,
      };
    });
}

function toSnapshotContinuousFeedback(
  feedback: ContinuousFeedbackIssueState,
): RuntimeSnapshotContinuousFeedback {
  return {
    status: feedback.status,
    last_event: feedback.lastEvent,
    last_checked_at: feedback.lastCheckedAt,
    reviewer_lane: { ...feedback.reviewerLane },
    worker_lane: { ...feedback.workerLane },
    findings: feedback.findings.map((finding) => ({
      signature: finding.signature,
      title: finding.title,
      detail: finding.detail,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      occurrences: finding.occurrences,
      status: finding.status,
      first_seen_at: finding.firstSeenAt,
      last_seen_at: finding.lastSeenAt,
    })),
  };
}

function deriveLastToolCall(
  recentActivity: RecentActivityEntry[],
): string | null {
  if (recentActivity.length === 0) return null;
  const last = recentActivity[recentActivity.length - 1];
  if (last === undefined) return null;
  return last.context ? `${last.toolName} ${last.context}` : last.toolName;
}

function toSnapshotCodexTotals(
  totals: CodexTotals,
  secondsRunning: number,
): RuntimeSnapshot["codex_totals"] {
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.totalTokens,
    seconds_running: secondsRunning,
  };
}

/** Per-stage default stall thresholds in seconds. */
export const STAGE_STALL_THRESHOLDS: Record<string, number> = {
  investigate: 600,
  implement: 480,
  review: 600,
  merge: 300,
};

const DEFAULT_STALL_THRESHOLD_SECONDS = 480;
const HIGH_TOKEN_BURN_THRESHOLD = 20_000;

export function getStallThreshold(stageName: string | null): number {
  if (stageName !== null && stageName in STAGE_STALL_THRESHOLDS) {
    return STAGE_STALL_THRESHOLDS[stageName] ?? DEFAULT_STALL_THRESHOLD_SECONDS;
  }
  return DEFAULT_STALL_THRESHOLD_SECONDS;
}

function classifyHealth(
  lastEventAt: string | null,
  tokensPerTurn: number,
  currentStageCompactions: number,
  maxHealthyCompactionsPerStage: number,
  now: Date,
  stageName: string | null,
): { health: HealthStatus; health_reason: string | null } {
  if (lastEventAt !== null) {
    const lastEventMs = Date.parse(lastEventAt);
    if (Number.isFinite(lastEventMs)) {
      const secondsSinceEvent = (now.getTime() - lastEventMs) / 1000;
      const threshold = getStallThreshold(stageName);
      const stageLabel = stageName ?? "unknown";

      if (secondsSinceEvent > threshold * 0.8) {
        return {
          health: "red",
          health_reason: `stalled: no activity for ${Math.floor(secondsSinceEvent)}s (${stageLabel} stage, threshold ${threshold}s)`,
        };
      }
      if (secondsSinceEvent > threshold * 0.5) {
        return {
          health: "yellow",
          health_reason: `slow: no activity for ${Math.floor(secondsSinceEvent)}s (${stageLabel} stage, threshold ${threshold}s)`,
        };
      }
    }
  }

  const yellowReasons: string[] = [];
  if (tokensPerTurn > HIGH_TOKEN_BURN_THRESHOLD) {
    yellowReasons.push(
      `high token burn: ${Math.round(tokensPerTurn).toLocaleString("en-US")} tokens/turn`,
    );
  }

  if (currentStageCompactions > maxHealthyCompactionsPerStage) {
    const stageLabel = stageName ?? "unknown";
    yellowReasons.push(
      `high compaction churn: ${currentStageCompactions.toLocaleString("en-US")} compactions in ${stageLabel} stage (threshold ${maxHealthyCompactionsPerStage.toLocaleString("en-US")})`,
    );
  }

  if (yellowReasons.length > 0) {
    return {
      health: "yellow",
      health_reason: yellowReasons.join("; "),
    };
  }

  return { health: "green", health_reason: null };
}

function buildCompactionsPerStage(
  executionHistory: StageRecord[],
  currentStage: string | null,
  currentStageCompactions: number,
): Record<string, number> {
  const compactionsPerStage: Record<string, number> = {};
  for (const record of executionHistory) {
    addCompactions(
      compactionsPerStage,
      record.stageName,
      record.compactions ?? 0,
    );
  }
  addCompactions(
    compactionsPerStage,
    currentStage ?? "unknown",
    currentStageCompactions,
  );
  return compactionsPerStage;
}

function addCompactions(
  compactionsPerStage: Record<string, number>,
  stageName: string,
  compactions: number,
): void {
  if (!Number.isFinite(compactions) || compactions <= 0) {
    return;
  }
  compactionsPerStage[stageName] =
    (compactionsPerStage[stageName] ?? 0) + Math.floor(compactions);
}
