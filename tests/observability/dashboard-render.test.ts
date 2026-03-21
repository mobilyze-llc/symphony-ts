import { describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  renderDashboardHtml,
} from "../../src/observability/dashboard-render.js";

function createBaseSnapshot(): RuntimeSnapshot {
  return {
    generated_at: "2026-03-06T10:04:00.000Z",
    counts: {
      running: 1,
      retrying: 0,
    },
    running: [
      {
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
        first_dispatched_at: "2026-03-06T09:58:00.000Z",
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
      },
    ],
    retrying: [],
    codex_totals: {
      input_tokens: 1000,
      output_tokens: 1000,
      total_tokens: 2000,
      seconds_running: 360,
    },
    rate_limits: {
      requestsRemaining: 10,
    },
  };
}

describe("dashboard-render Pipeline column", () => {
  it("shows pipeline time in Xm Ys format for multi-stage issues (first_dispatched_at != started_at)", () => {
    // first_dispatched_at is 5m 30s before started_at
    // pipeline total: from first_dispatched_at (09:52:30) to generated_at (10:04:00) = 11m 30s
    const snapshot: RuntimeSnapshot = {
      ...createBaseSnapshot(),
      running: [
        {
          ...createBaseSnapshot().running[0]!,
          started_at: "2026-03-06T09:58:00.000Z",
          first_dispatched_at: "2026-03-06T09:52:30.000Z",
        },
      ],
    };

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("<th>Pipeline</th>");
    expect(html).toContain("11m 30s");
  });

  it("shows dash for single-stage issues (first_dispatched_at == started_at)", () => {
    // first_dispatched_at equals started_at — single-stage, no pipeline overhead
    const snapshot: RuntimeSnapshot = {
      ...createBaseSnapshot(),
      running: [
        {
          ...createBaseSnapshot().running[0]!,
          started_at: "2026-03-06T09:58:00.000Z",
          first_dispatched_at: "2026-03-06T09:58:00.000Z",
        },
      ],
    };

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("<th>Pipeline</th>");
    // The Pipeline cell should contain the em dash, not a time string
    // We verify the em dash appears (—) and that the pattern "Xm Ys" does not appear
    // in the pipeline cell context.
    expect(html).toContain("\u2014");
    // Confirm no pipeline time is rendered by checking that 6m 0s or similar doesn't appear
    // The runtime cell would show time from started_at but Pipeline should show —
    const pipelineCellMatch = html.match(
      /<td class="numeric">[^<]*?<\/td>\s*<td class="numeric">([^<]*?)<\/td>/,
    );
    expect(pipelineCellMatch).not.toBeNull();
    // The pipeline cell value should be the em dash, not a time
    expect(pipelineCellMatch?.[1]?.trim()).toBe("\u2014");
  });
});
