import type {
  CodexRateLimits,
  CodexTotals,
  OrchestratorState,
} from "../domain/model.js";
import { getAggregateSecondsRunning } from "./session-metrics.js";

export interface RuntimeSnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  pipeline_stage: string | null;
  activity_summary: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  stage_duration_seconds: number;
  tokens_per_turn: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  rework_count?: number;
}

export interface RuntimeSnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
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
        entry.turnCount > 0
          ? entry.totalStageTotalTokens / entry.turnCount
          : 0;
      const row: RuntimeSnapshotRunningRow = {
        issue_id: entry.issue.id,
        issue_identifier: entry.identifier,
        state: entry.issue.state,
        pipeline_stage: state.issueStages[entry.issue.id] ?? null,
        activity_summary: entry.lastCodexMessage,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        started_at: entry.startedAt,
        last_event_at: entry.lastCodexTimestamp,
        stage_duration_seconds: stageDurationSeconds,
        tokens_per_turn: tokensPerTurn,
        tokens: {
          input_tokens: entry.codexInputTokens,
          output_tokens: entry.codexOutputTokens,
          total_tokens: entry.codexTotalTokens,
        },
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
      due_at: new Date(entry.dueAtMs).toISOString(),
      error: entry.error,
    }));

  return {
    generated_at: now.toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    codex_totals: toSnapshotCodexTotals(
      state.codexTotals,
      getAggregateSecondsRunning(state, now),
    ),
    rate_limits: state.codexRateLimits,
  };
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
