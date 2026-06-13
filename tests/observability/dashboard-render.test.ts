import { describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import { renderDashboardHtml } from "../../src/observability/dashboard-render.js";
import { getDisplayVersion } from "../../src/version.js";

const BASE_ROW: RuntimeSnapshot["running"][number] = {
  issue_id: "issue-1",
  issue_identifier: "SYMPH-47",
  issue_title: "Test issue title",
  state: "In Progress",
  pipeline_stage: "implement",
  activity_summary: "Working on it",
  session_id: "session-abc",
  turn_count: 3,
  last_event: "notification",
  last_message: "Working on it",
  started_at: "2026-03-21T10:00:00.000Z",
  first_dispatched_at: "2026-03-21T10:00:00.000Z",
  last_event_at: "2026-03-21T10:01:00.000Z",
  stage_duration_seconds: 60,
  tokens_per_turn: 500,
  tokens: {
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
    reasoning_tokens: 50,
  },
  total_pipeline_tokens: 1500,
  pipeline_tokens: {
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
  },
  execution_history: [],
  turn_history: [],
  recent_activity: [],
  last_tool_call: null,
  failure_reason: null,
  health: "green",
  health_reason: null,
  loop_trace_preview: {
    total_entries: 0,
    stored_entries: 0,
    truncated: false,
    entries: [],
  },
  rate_limit_window: null,
};

function buildSnapshot(
  rowOverrides: Partial<RuntimeSnapshot["running"][number]>,
): RuntimeSnapshot {
  return {
    generated_at: "2026-03-21T10:05:30.000Z",
    counts: { running: 1, retrying: 0, completed: 0, failed: 0 },
    running: [{ ...BASE_ROW, ...rowOverrides }],
    retrying: [],
    codex_totals: {
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      seconds_running: 330,
    },
    rate_limits: {},
    rate_limit_admission: null,
    explicit_resume_required: {},
    as_of_sequence: 0,
    counters: {},
    rate_limit_views: {
      runner_snapshot_file: null,
      gate: null,
      live_telemetry: null,
      disagreement: null,
    },
    deploy_drift: null,
    watchdog: { clusters: [], open_breakers: [] },
    components: {},
  };
}

describe("Dashboard Pipeline column", () => {
  it("shows 'Pipeline' column header in the running table", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("<th>Pipeline</th>");
  });

  it("shows elapsed pipeline time for multi-stage issues (first_dispatched_at earlier than started_at)", () => {
    // first_dispatched_at is 5m 30s before started_at
    // generated_at is 2026-03-21T10:05:30.000Z
    // first_dispatched_at is 2026-03-21T09:54:30.000Z → 11m 0s before generated_at
    const snapshot = buildSnapshot({
      started_at: "2026-03-21T10:00:00.000Z",
      first_dispatched_at: "2026-03-21T09:54:30.000Z",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // Pipeline time: from 09:54:30 to 10:05:30 = 11m 0s
    expect(html).toContain("11m 0s");
  });

  it("shows '—' in the Pipeline column for single-stage issues (first_dispatched_at equals started_at)", () => {
    const snapshot = buildSnapshot({
      started_at: "2026-03-21T10:00:00.000Z",
      first_dispatched_at: "2026-03-21T10:00:00.000Z",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // The Pipeline td should contain an em-dash (—)
    // Use a regex to check the Pipeline column td contains — and no time string pattern near it
    expect(html).toContain("—");
    // Verify: the Pipeline cell itself does NOT contain a "Xm Ys" pattern
    // We do this by checking the generated HTML around the runtime column
    // The runtime/turns column shows time since started_at; Pipeline should be —
    const pipelineCellMatch = html.match(
      /<td class="numeric">[^<]*<\/td>\s*<td class="numeric">([^<]*)<\/td>/,
    );
    expect(pipelineCellMatch).not.toBeNull();
    const pipelineContent: string | undefined = pipelineCellMatch?.[1];
    // The second numeric cell (Pipeline) should be —
    expect(pipelineContent?.trim()).toBe("—");
  });

  it("includes formatPipelineTime in client-side JavaScript", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });
    expect(html).toContain("formatPipelineTime");
  });

  it("renders computed dispatch order status and rationale", () => {
    const snapshot: RuntimeSnapshot = {
      ...buildSnapshot({}),
      computed_order: {
        comparator_version: "dispatch-comparator-v1",
        generated_at: "2026-06-13T12:00:00.000Z",
        status: "linearized",
        positions: [
          {
            position: 1,
            issue_id: "issue-1",
            issue_identifier: "SYMPH-485",
            priority: 1,
            created_at: "2026-06-13T00:00:00.000Z",
            rationale: ["priority 1", "operator_anchor top"],
          },
        ],
        exclusions: [
          {
            issue_id: "issue-2",
            issue_identifier: "SYMPH-486",
            blocker_issue_id: "issue-1",
            blocker_issue_identifier: "SYMPH-485",
            blocker_state: "In Progress",
            edge_trust: "operator_confirmed",
            source: "ticket_feature",
            reason: "Operator-confirmed blocked-by edge.",
          },
          {
            issue_id: "issue-2",
            issue_identifier: "SYMPH-486",
            blocker_issue_id: "issue-4",
            blocker_issue_identifier: "SYMPH-488",
            blocker_state: "In Progress",
            edge_trust: "operator_confirmed",
            source: "ticket_feature",
            reason: "Operator-confirmed blocked-by edge.",
          },
        ],
        advisory_warnings: [
          {
            issue_id: "issue-3",
            issue_identifier: "SYMPH-487",
            blocker_issue_id: "issue-1",
            blocker_issue_identifier: "SYMPH-485",
            blocker_state: "In Progress",
            reason: "Advisory blocked-by edge.",
          },
        ],
        would_have_been_excluded_by_advisory_edges: [],
        hard_cycle: null,
        warnings: [],
      },
    };

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });

    expect(html).toContain("Computed dispatch order");
    expect(html).toContain("Hard-excluded issues: 1");
    expect(html).toContain("Hard exclusion edges: 2");
    expect(html).toContain("dispatch-comparator-v1");
    expect(html).toContain("SYMPH-485");
    expect(html).toContain("SYMPH-486");
    expect(html).toContain("Operator-confirmed blocked-by edge.");
    expect(html).toContain("SYMPH-487");
    expect(html).toContain("Advisory blocked-by edge.");
    expect(html).toContain("operator_anchor top");
  });

  it("dashboard shows version in hero header", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain(getDisplayVersion());
    expect(html).toContain("Symphony Observability");
  });

  it("renders dispatcher decision-quality metrics and category table", () => {
    const snapshot: RuntimeSnapshot = {
      ...buildSnapshot({}),
      decision_quality: {
        total: 4,
        measured: 3,
        pending: 1,
        exactMatches: 2,
        corrected: 1,
        truePositive: 1,
        falsePositive: 1,
        falseNegative: 1,
        trueNegative: 0,
        unclassified: 0,
        costSensitiveRoutingMisses: 1,
        latestEventAt: "2026-06-08T12:24:00.000Z",
        categories: {
          right_sizing: {
            total: 1,
            measured: 0,
            pending: 1,
            exactMatches: 0,
            corrected: 0,
            truePositive: 0,
            falsePositive: 0,
            falseNegative: 0,
            trueNegative: 0,
            unclassified: 0,
            costSensitiveRoutingMisses: 0,
          },
          admission: {
            total: 2,
            measured: 2,
            pending: 0,
            exactMatches: 1,
            corrected: 1,
            truePositive: 1,
            falsePositive: 1,
            falseNegative: 0,
            trueNegative: 0,
            unclassified: 0,
            costSensitiveRoutingMisses: 0,
          },
          re_steer: {
            total: 0,
            measured: 0,
            pending: 0,
            exactMatches: 0,
            corrected: 0,
            truePositive: 0,
            falsePositive: 0,
            falseNegative: 0,
            trueNegative: 0,
            unclassified: 0,
            costSensitiveRoutingMisses: 0,
          },
          model_routing: {
            total: 1,
            measured: 1,
            pending: 0,
            exactMatches: 1,
            corrected: 0,
            truePositive: 0,
            falsePositive: 0,
            falseNegative: 1,
            trueNegative: 0,
            unclassified: 0,
            costSensitiveRoutingMisses: 1,
          },
        },
      },
    };

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });

    expect(html).toContain("Decision quality");
    expect(html).toContain("Measured decisions");
    expect(html).toContain("Routing misses");
    expect(html).toContain("model routing");
    expect(html).toContain("Latest decision: 2026-06-08T12:24:00.000Z");
    expect(html).toContain("renderDecisionQuality");
    expect(html).toContain("next.decision_quality");
  });

  it("renders manager-run lane state and closeout evidence", () => {
    const snapshot: RuntimeSnapshot = {
      ...buildSnapshot({}),
      manager_runs: [
        {
          run_id: "wave-2",
          manager_thread_id: "019ea8a6-bc42-72a3-ade0-72be7663232e",
          title: "Symphony Wave 2 manager run",
          started_at: "2026-06-08T13:00:00.000Z",
          counts: {
            active_lanes: 1,
            blocked_lanes: 1,
            degraded_lanes: 1,
            closed_lanes: 0,
            spawned_follow_ups: 1,
            missing_closeout_evidence: 1,
          },
          lanes: [
            {
              lane_id: "lane-mob-87",
              issue_identifier: "MOB-87",
              title: "Map manager-thread runs into Symphony run events",
              status: "degraded",
              worker_thread_id: "worker-thread-mob-87",
              last_heartbeat_at: "2026-06-08T13:05:00.000Z",
              blocked_by: [],
              degraded_reasons: ["stale_heartbeat"],
              pr_url: null,
              pr_status: null,
              validation_artifact_ids: ["artifact-mob-87-review-compensation"],
              review_gate_ids: ["gate-mob-87-review"],
              follow_up_issue_identifiers: ["SYMPH-262"],
            },
          ],
          follow_ups: [
            {
              issue_identifier: "SYMPH-262",
              title: "Backfill historical manager-run import CLI",
              parent_issue_identifier: "MOB-87",
              lane_id: "lane-mob-87",
              url: "https://linear.app/mobilyze-llc/issue/SYMPH-262/backfill-historical-manager-run-import-cli",
            },
          ],
          escalations: [],
          model_checks: [],
          missing_closeout_evidence: ["lane:lane-mob-87:pr"],
          closeout_ready: false,
        },
      ],
    };

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });

    expect(html).toContain("Manager runs");
    expect(html).toContain("Symphony Wave 2 manager run");
    expect(html).toContain("MOB-87");
    expect(html).toContain("Degraded 1");
    expect(html).toContain("SYMPH-262");
    expect(html).toContain("lane:lane-mob-87:pr");
    expect(html).toContain("renderManagerRuns");
    expect(html).toContain("next.manager_runs");
  });

  it("activity column shows last_tool_call when present", () => {
    const snapshot = buildSnapshot({
      last_tool_call: "Read model.ts",
      activity_summary: "Working on it",
      last_event: "notification",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("Read model.ts");
  });

  it("activity column falls back to activity_summary when last_tool_call is null", () => {
    const snapshot = buildSnapshot({
      last_tool_call: null,
      activity_summary: "Working on it",
      last_event: "notification",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("Working on it");
  });

  it("client-side JavaScript references last_tool_call for activity text", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });
    expect(html).toContain("row.last_tool_call");
  });

  it("detail panel shows failure reason prominently for failed_to_start", () => {
    const snapshot = buildSnapshot({
      failure_reason: "Worker process exited with code 1 before any turns",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // Failure reason displayed in the detail panel context section
    expect(html).toContain("Failure");
    expect(html).toContain(
      "Worker process exited with code 1 before any turns",
    );
    expect(html).toContain("context-health-red");
  });

  it("main table status column shows failure reason for failed_to_start", () => {
    const snapshot = buildSnapshot({
      failure_reason: "Sandbox initialization failed",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // Failure reason visible in the status column as a danger badge
    expect(html).toContain("state-badge-danger");
    expect(html).toContain("Sandbox initialization failed");
  });

  it("token breakdown renders cumulative pipeline token values", () => {
    const snapshot = buildSnapshot({
      pipeline_tokens: {
        input_tokens: 8_000,
        output_tokens: 3_500,
        total_tokens: 13_000,
        cache_read_tokens: 1_200,
        cache_write_tokens: 300,
      },
      total_pipeline_tokens: 13_000,
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("8,000");
    expect(html).toContain("3,500");
    expect(html).toContain("13,000");
    expect(html).toContain("1,200");
    expect(html).toContain("300");
  });

  it("token breakdown renders output caps and compaction churn", () => {
    const snapshot = buildSnapshot({
      output_caps: {
        tool_output_token_limit: 2_500,
        model_auto_compact_token_limit: 40_000,
      },
      churn: {
        compactions_per_stage: {
          investigate: 1,
          implement: 4,
        },
        current_stage_compactions: 4,
        max_healthy_compactions_per_stage: 3,
      },
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("Tool cap");
    expect(html).toContain("2,500");
    expect(html).toContain("Auto compact");
    expect(html).toContain("40,000");
    expect(html).toContain("Compactions");
  });

  it("detail panel renders rate-limit window usage when observed", () => {
    const snapshot = buildSnapshot({
      rate_limit_window: {
        primary: { start_pct: 39, latest_pct: 42.5, delta_pct: 3.5 },
        secondary: { start_pct: 97, latest_pct: 98, delta_pct: 1 },
      },
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("5h window");
    expect(html).toContain("39.0% → 42.5% (+3.5%)");
    expect(html).toContain("Weekly window");
    expect(html).toContain("97.0% → 98.0% (+1.0%)");
  });

  it("omits rate-limit window rows when no usage was observed", () => {
    const snapshot = buildSnapshot({ rate_limit_window: null });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).not.toContain("39.0% →");
  });

  it("renders the rate-limit admission floor status line", () => {
    const unconfigured = buildSnapshot({});
    expect(
      renderDashboardHtml(unconfigured, { liveUpdatesEnabled: false }),
    ).toContain("Dispatch headroom floor: not configured.");

    const blocked = {
      ...buildSnapshot({}),
      rate_limit_admission: {
        blocked: true,
        reason: "secondary window headroom 2.0% < 5% floor",
        evaluated_at: "2026-03-21T10:00:00.000Z",
        min_primary_headroom_pct: 10,
        min_secondary_headroom_pct: 5,
        primary_used_pct: 40,
        secondary_used_pct: 98,
      },
    };
    const blockedHtml = renderDashboardHtml(blocked, {
      liveUpdatesEnabled: false,
    });
    expect(blockedHtml).toContain(
      "Dispatch blocked: secondary window headroom 2.0% &lt; 5% floor",
    );

    const ok = {
      ...buildSnapshot({}),
      rate_limit_admission: {
        blocked: false,
        reason: null,
        evaluated_at: "2026-03-21T10:00:00.000Z",
        min_primary_headroom_pct: 10,
        min_secondary_headroom_pct: 5,
        primary_used_pct: 40,
        secondary_used_pct: 91.5,
      },
    };
    expect(renderDashboardHtml(ok, { liveUpdatesEnabled: false })).toContain(
      "Dispatch headroom floor: ok (5h window 40.0% used, weekly window 91.5% used).",
    );
  });

  it("detail panel renders compact loop trace entries without prompt bodies", () => {
    const snapshot = buildSnapshot({
      loop_trace_preview: {
        total_entries: 2,
        stored_entries: 2,
        truncated: false,
        entries: [
          {
            sequence: 1,
            at: "2026-03-21T10:00:15.000Z",
            kind: "prompt_summary",
            summary: "Dispatch prompt summarized for the implement stage",
            stage: "implement",
            attempt: 1,
            session_id: "session-abc",
            prompt: {
              chars: 1840,
              estimated_tokens: 460,
            },
            tool_action: null,
            file_delta: null,
            stage_transition: null,
            worker_exit: null,
          },
          {
            sequence: 2,
            at: "2026-03-21T10:01:00.000Z",
            kind: "tool_action",
            summary: "Read dashboard renderer and mobile dashboard",
            stage: "implement",
            attempt: 1,
            session_id: "session-abc",
            prompt: null,
            tool_action: {
              tool_name: "Read",
              context: "dashboard-render.ts",
              total_tokens: 1200,
            },
            file_delta: null,
            stage_transition: null,
            worker_exit: null,
          },
        ],
      },
    });

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain("Loop trace");
    expect(html).toContain("2 entries");
    expect(html).toContain("Dispatch prompt summarized");
    expect(html).toContain("prompt 1,840 chars, 460 est tokens");
    expect(html).toContain("tool Read");
  });

  it("detail panel renders empty and truncated loop trace preview states", () => {
    const emptyHtml = renderDashboardHtml(buildSnapshot({}), {
      liveUpdatesEnabled: false,
    });

    expect(emptyHtml).toContain("Loop trace");
    expect(emptyHtml).toContain("0 entries");
    expect(emptyHtml).toContain("No loop trace entries yet.");

    const truncatedHtml = renderDashboardHtml(
      buildSnapshot({
        loop_trace_preview: {
          total_entries: 31,
          stored_entries: 20,
          truncated: true,
          entries: [
            {
              sequence: 31,
              at: "2026-03-21T10:02:00.000Z",
              kind: "worker_exit",
              summary: "Worker exited after review failure",
              stage: null,
              attempt: null,
              session_id: null,
              prompt: null,
              tool_action: null,
              file_delta: null,
              stage_transition: null,
              worker_exit: {
                outcome: "abnormal",
                reason: "review failure",
                duration_ms: 12_000,
                turn_count: 2,
                total_tokens: 2048,
              },
            },
          ],
        },
      }),
      { liveUpdatesEnabled: false },
    );

    expect(truncatedHtml).toContain("31 entries · oldest entries archived");
    expect(truncatedHtml).toContain("Worker exited after review failure");
    expect(truncatedHtml).not.toContain("attempt null");
    expect(truncatedHtml).not.toContain("session null");
  });

  it("detail panel falls back to generic loop trace kind when omitted", () => {
    const snapshot = buildSnapshot({
      loop_trace_preview: {
        total_entries: 1,
        stored_entries: 1,
        truncated: false,
        entries: [
          {
            sequence: 1,
            at: "2026-03-21T10:00:15.000Z",
            kind: "" as RuntimeSnapshot["running"][number]["loop_trace_preview"]["entries"][number]["kind"],
            summary: "Trace event without a kind",
            stage: null,
            attempt: null,
            session_id: null,
            prompt: null,
            tool_action: null,
            file_delta: null,
            stage_transition: null,
            worker_exit: null,
          },
        ],
      },
    });

    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });

    expect(html).toContain(">event</span>");
    expect(html).toContain("Trace event without a kind");
  });
});
