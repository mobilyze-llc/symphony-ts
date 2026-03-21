import { describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import { renderDashboardHtml } from "../../src/observability/dashboard-render.js";

function createBaseRow(): RuntimeSnapshot["running"][0] {
  return {
    issue_id: "issue-1",
    issue_identifier: "ABC-123",
    state: "In Progress",
    pipeline_stage: "implement",
    activity_summary: null,
    session_id: null,
    turn_count: 5,
    last_event: null,
    last_message: null,
    started_at: "2026-03-06T09:58:00.000Z",
    last_event_at: null,
    stage_duration_seconds: 360,
    tokens_per_turn: 400,
    tokens: {
      input_tokens: 1000,
      output_tokens: 1000,
      total_tokens: 2000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    },
    total_pipeline_tokens: 2000,
    execution_history: [],
    turn_history: [],
    health: "green",
    health_reason: null,
  };
}

function createBaseSnapshot(
  row: RuntimeSnapshot["running"][0],
): RuntimeSnapshot {
  return {
    generated_at: "2026-03-06T10:04:00.000Z",
    counts: { running: 1, retrying: 0 },
    running: [row],
    retrying: [],
    codex_totals: {
      input_tokens: 1000,
      output_tokens: 1000,
      total_tokens: 2000,
      seconds_running: 360,
    },
    rate_limits: { requestsRemaining: 10 },
  };
}

describe("dashboard-render Pipeline column", () => {
  it("shows pipeline time in Xm Ys format for multi-stage issues (first_dispatched_at != started_at)", () => {
    // Pipeline total: from first_dispatched_at (09:52:30) to generated_at (10:04:00) = 11m 30s
    const row: RuntimeSnapshot["running"][0] = {
      ...createBaseRow(),
      started_at: "2026-03-06T09:58:00.000Z",
      first_dispatched_at: "2026-03-06T09:52:30.000Z",
    };
    const snapshot = createBaseSnapshot(row);

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("<th>Pipeline</th>");
    expect(html).toContain("11m 30s");
  });

  it("shows dash for single-stage issues (first_dispatched_at == started_at)", () => {
    // first_dispatched_at equals started_at — single-stage, no pipeline overhead
    const row: RuntimeSnapshot["running"][0] = {
      ...createBaseRow(),
      started_at: "2026-03-06T09:58:00.000Z",
      first_dispatched_at: "2026-03-06T09:58:00.000Z",
    };
    const snapshot = createBaseSnapshot(row);

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("<th>Pipeline</th>");
    // Pipeline cell should show em dash for single-stage issues
    expect(html).toContain("\u2014");
    // Verify the pipeline cell contains — and not a time value
    // The pipeline td comes right after the runtime/turns td
    const pipelineCellPattern =
      /<td class="numeric">[\s\S]*?<\/td>\s*<td class="numeric">([^<]*?)<\/td>/;
    const match = html.match(pipelineCellPattern);
    expect(match).not.toBeNull();
    expect(match?.[1]?.trim()).toBe("\u2014");
  });

  it("shows dash when first_dispatched_at is absent (undefined)", () => {
    // When first_dispatched_at is not set, pipeline shows dash
    const row: RuntimeSnapshot["running"][0] = {
      ...createBaseRow(),
      started_at: "2026-03-06T09:58:00.000Z",
      // first_dispatched_at is intentionally omitted (optional field)
    };
    const snapshot = createBaseSnapshot(row);

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("<th>Pipeline</th>");
    expect(html).toContain("\u2014");
  });
});
