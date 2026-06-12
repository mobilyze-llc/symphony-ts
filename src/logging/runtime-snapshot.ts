import type {
  CodexRateLimits,
  CodexTotals,
  ContinuousFeedbackIssueState,
  DecorrelatedGateOutcome,
  DispatcherDecisionQualitySummary,
  IssueDispositionRecord,
  OrchestratorState,
  RecentActivityEntry,
  SessionRateLimitTelemetry,
  SessionRateLimitWindowTelemetry,
  StageRecord,
  TurnHistoryEntry,
} from "../domain/model.js";
import { PIPELINE_VERDICT_SCOPE_ID } from "../orchestrator/core.js";
import {
  evaluateDispatcherDecisionQuality,
  extractDispatcherDecisionEvents,
} from "../orchestrator/decision-quality.js";
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
  aggregate: "pass" | "fail" | null;
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
  explicit_resume_required?: Record<string, RuntimeSnapshotExplicitResumeMark>;
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
  },
): RuntimeSnapshot {
  const now = options?.now ?? new Date();

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
      const { health, health_reason } = classifyHealth(
        entry.lastCodexTimestamp,
        tokensPerTurn,
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
    explicit_resume_required: buildExplicitResumeMarks(state),
  };
}

function buildExplicitResumeMarks(
  state: OrchestratorState,
): Record<string, RuntimeSnapshotExplicitResumeMark> {
  const marks: Record<string, RuntimeSnapshotExplicitResumeMark> = {};
  for (const issueId of state.resumeRequired) {
    const mark = state.resumeRequiredMarks[issueId];
    marks[issueId] = {
      reason: mark?.reason ?? "stop_like_pause",
      set_by_sequence: mark?.setBySequence ?? null,
      since: mark?.since ?? "",
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

  if (tokensPerTurn > HIGH_TOKEN_BURN_THRESHOLD) {
    return {
      health: "yellow",
      health_reason: `high token burn: ${Math.round(tokensPerTurn).toLocaleString("en-US")} tokens/turn`,
    };
  }

  return { health: "green", health_reason: null };
}
