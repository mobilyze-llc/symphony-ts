import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import { getDisplayVersion } from "../version.js";
import {
  escapeHtml,
  formatInteger,
  formatRuntimeAndTurns,
  formatRuntimeSeconds,
  prettyValue,
  runtimeSecondsFromStartedAt,
  stateBadgeClass,
} from "./dashboard-format.js";

export interface DashboardRenderOptions {
  liveUpdatesEnabled: boolean;
}

const DASHBOARD_STYLES = String.raw`
      :root {
        color-scheme: dark;
        --page: #111113;
        --page-soft: #161618;
        --page-deep: #0c0c0e;
        --card: rgba(28, 28, 32, 0.94);
        --card-muted: #1e1e22;
        --ink: #e8e8ec;
        --muted: #8e8ea0;
        --line: #2a2a30;
        --line-strong: #3a3a42;
        --accent: #10a37f;
        --accent-ink: #5fe0b8;
        --accent-soft: rgba(16, 163, 127, 0.12);
        --danger: #f87171;
        --danger-soft: rgba(248, 113, 113, 0.1);
        --warning: #fbbf24;
        --warning-soft: rgba(251, 191, 36, 0.1);
        --warning-line: rgba(251, 191, 36, 0.2);
        --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
        --shadow-lg: 0 20px 50px rgba(0, 0, 0, 0.4);
      }
      * {
        box-sizing: border-box;
      }
      html {
        background: var(--page);
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top, rgba(16, 163, 127, 0.08) 0%, rgba(16, 163, 127, 0) 30%),
          linear-gradient(180deg, var(--page-soft) 0%, var(--page) 24%, var(--page-deep) 100%);
        color: var(--ink);
        font-family: "Sohne", "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      a {
        color: var(--ink);
        text-decoration: none;
        transition: color 140ms ease;
      }
      a:hover {
        color: var(--accent);
      }
      button {
        appearance: none;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: white;
        border-radius: 999px;
        padding: 0.72rem 1.08rem;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        letter-spacing: -0.01em;
        box-shadow: 0 8px 20px rgba(16, 163, 127, 0.25);
        transition:
          transform 140ms ease,
          box-shadow 140ms ease,
          background 140ms ease,
          border-color 140ms ease;
      }
      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 24px rgba(16, 163, 127, 0.3);
      }
      .subtle-button {
        border: 1px solid var(--line-strong);
        background: rgba(255, 255, 255, 0.06);
        color: var(--muted);
        padding: 0.34rem 0.72rem;
        font-size: 0.82rem;
        letter-spacing: 0.01em;
        box-shadow: none;
      }
      .subtle-button:hover {
        transform: none;
        box-shadow: none;
        background: rgba(255, 255, 255, 0.1);
        border-color: var(--muted);
        color: var(--ink);
      }
      code,
      pre,
      .mono {
        font-family: "Sohne Mono", "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
      }
      .mono,
      .numeric {
        font-variant-numeric: tabular-nums slashed-zero;
        font-feature-settings: "tnum" 1, "zero" 1;
      }
      .app-shell {
        max-width: 1280px;
        margin: 0 auto;
        padding: 2rem 1rem 3.5rem;
      }
      .dashboard-shell {
        display: grid;
        gap: 1rem;
      }
      .hero-card,
      .section-card,
      .metric-card {
        background: var(--card);
        border: 1px solid var(--line);
        box-shadow: var(--shadow-sm);
        backdrop-filter: blur(18px);
      }
      .hero-card {
        border-radius: 28px;
        padding: clamp(1.25rem, 3vw, 2rem);
        box-shadow: var(--shadow-lg);
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 1.25rem;
        align-items: start;
      }
      .eyebrow {
        margin: 0;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.76rem;
        font-weight: 600;
      }
      .hero-title {
        margin: 0.35rem 0 0;
        font-size: clamp(2rem, 4vw, 3.3rem);
        line-height: 0.98;
        letter-spacing: -0.04em;
      }
      .hero-copy {
        margin: 0.75rem 0 0;
        max-width: 46rem;
        color: var(--muted);
        font-size: 1rem;
      }
      .status-stack {
        display: grid;
        justify-items: end;
        align-content: start;
        min-width: min(100%, 9rem);
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        min-height: 2rem;
        padding: 0.35rem 0.78rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.01em;
      }
      .status-badge-dot {
        width: 0.52rem;
        height: 0.52rem;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.9;
      }
      .status-badge-live {
        background: var(--accent-soft);
        border-color: rgba(16, 163, 127, 0.3);
        color: var(--accent-ink);
      }
      .metric-grid {
        display: grid;
        gap: 0.85rem;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .metric-card {
        border-radius: 22px;
        padding: 1rem 1.05rem 1.1rem;
      }
      .metric-label {
        margin: 0;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .metric-value {
        margin: 0.35rem 0 0;
        font-size: clamp(1.6rem, 2vw, 2.1rem);
        line-height: 1.05;
        letter-spacing: -0.03em;
      }
      .metric-detail {
        margin: 0.45rem 0 0;
        color: var(--muted);
        font-size: 0.88rem;
      }
      .section-card {
        border-radius: 24px;
        padding: 1.15rem;
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .section-title {
        margin: 0;
        font-size: 1.08rem;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      .section-copy {
        margin: 0.35rem 0 0;
        color: var(--muted);
        font-size: 0.94rem;
      }
      .table-wrap {
        overflow-x: auto;
        margin-top: 1rem;
      }
      .data-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
      }
      .data-table-running {
        table-layout: fixed;
        min-width: 980px;
      }
      .data-table th {
        padding: 0 0.5rem 0.75rem 0;
        text-align: left;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .data-table td {
        padding: 0.9rem 0.5rem 0.9rem 0;
        border-top: 1px solid var(--line);
        vertical-align: top;
        font-size: 0.94rem;
      }
      .issue-stack,
      .session-stack,
      .detail-stack,
      .token-stack {
        display: grid;
        gap: 0.24rem;
        min-width: 0;
      }
      .event-text {
        font-weight: 500;
        line-height: 1.45;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event-meta {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .state-badge {
        display: inline-flex;
        align-items: center;
        min-height: 1.85rem;
        padding: 0.3rem 0.68rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--ink);
        font-size: 0.8rem;
        font-weight: 600;
        line-height: 1;
      }
      .state-badge-active {
        background: var(--accent-soft);
        border-color: rgba(16, 163, 127, 0.3);
        color: var(--accent-ink);
      }
      .state-badge-warning {
        background: var(--warning-soft);
        border-color: var(--warning-line);
        color: var(--warning);
      }
      .state-badge-danger {
        background: var(--danger-soft);
        border-color: rgba(248, 113, 113, 0.2);
        color: var(--danger);
      }
      .health-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        min-height: 1.85rem;
        padding: 0.3rem 0.68rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--ink);
        font-size: 0.8rem;
        font-weight: 600;
        line-height: 1;
      }
      .health-badge-dot {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: var(--ink-muted);
      }
      .health-badge-green { background: var(--accent-soft); border-color: rgba(16, 163, 127, 0.3); color: var(--accent-ink); }
      .health-badge-green .health-badge-dot { background: var(--accent); }
      .health-badge-yellow { background: var(--warning-soft); border-color: var(--warning-line); color: var(--warning); }
      .health-badge-yellow .health-badge-dot { background: var(--warning); }
      .health-badge-red { background: var(--danger-soft); border-color: rgba(248, 113, 113, 0.2); color: var(--danger); }
      .health-badge-red .health-badge-dot { background: var(--danger); }
      .issue-id {
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .issue-title {
        font-size: 0.84rem;
        white-space: normal;
      }
      .muted {
        color: var(--muted);
      }
      .code-panel {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 18px;
        background: var(--page-deep);
        border: 1px solid var(--line);
        color: var(--ink);
        font-size: 0.9rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty-state {
        margin: 1rem 0 0;
        color: var(--muted);
      }
      .expand-toggle {
        border: 1px solid var(--line-strong);
        background: rgba(255, 255, 255, 0.06);
        color: var(--muted);
        border-radius: 4px;
        padding: 0.18rem 0.48rem;
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        box-shadow: none;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
        margin-top: 0.3rem;
      }
      .expand-toggle:hover {
        transform: none;
        box-shadow: none;
        background: rgba(255, 255, 255, 0.1);
        border-color: var(--muted);
        color: var(--ink);
      }
      .detail-row > td {
        padding: 0;
        border-top: none;
      }
      .detail-panel {
        padding: 1rem 1.25rem;
        background: var(--page-soft);
        border-top: 1px solid var(--line);
        border-bottom: 2px solid var(--line-strong);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
      }
      .detail-section {
        min-width: 0;
      }
      .detail-section-title {
        margin: 0 0 0.45rem;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted);
      }
      .detail-kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.12rem 0.75rem;
        font-size: 0.88rem;
      }
      .detail-kv-label {
        color: var(--muted);
        white-space: nowrap;
      }
      .detail-kv-value {
        font-variant-numeric: tabular-nums slashed-zero;
        font-feature-settings: "tnum" 1, "zero" 1;
      }
      .turn-timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: 0.84rem;
        max-height: 9rem;
        overflow-y: auto;
      }
      .turn-timeline li {
        display: grid;
        grid-template-columns: 5.5rem 1fr auto;
        gap: 0.3rem;
        padding: 0.22rem 0;
        border-top: 1px solid var(--line);
        align-items: baseline;
      }
      .turn-timeline li:first-child {
        border-top: none;
      }
      .turn-num {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .turn-msg {
        word-break: break-all;
        color: var(--ink);
      }
      .activity-time {
        color: var(--muted);
        font-size: 0.76rem;
        white-space: nowrap;
      }
      .exec-history-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.84rem;
      }
      .exec-history-table th {
        text-align: left;
        padding: 0 0.4rem 0.35rem 0;
        font-size: 0.74rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .exec-history-table td {
        padding: 0.2rem 0.4rem 0.2rem 0;
        border-top: 1px solid var(--line);
        vertical-align: top;
      }
      .loop-trace-list {
        display: grid;
        gap: 0.4rem;
        max-height: 11rem;
        overflow-y: auto;
      }
      .loop-trace-entry {
        display: grid;
        gap: 0.18rem;
        padding: 0.42rem 0;
        border-top: 1px solid var(--line);
      }
      .loop-trace-entry:first-child {
        border-top: none;
        padding-top: 0;
      }
      .loop-trace-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 0.55rem;
        color: var(--muted);
        font-size: 0.74rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      .loop-trace-kind {
        color: var(--accent-ink);
        font-weight: 700;
      }
      .loop-trace-summary {
        color: var(--ink);
        font-size: 0.84rem;
        line-height: 1.35;
        word-break: break-word;
      }
      @media (max-width: 860px) {
        .app-shell {
          padding: 1rem 0.85rem 2rem;
        }
        .hero-grid {
          grid-template-columns: 1fr;
        }
        .status-stack {
          justify-items: start;
        }
        .metric-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 560px) {
        .metric-grid {
          grid-template-columns: 1fr;
        }
        .section-card,
        .hero-card {
          border-radius: 20px;
          padding: 1rem;
        }
      }
      .context-section {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 1.25rem;
        align-items: baseline;
        margin-bottom: 0.75rem;
        padding-bottom: 0.6rem;
        border-bottom: 1px solid var(--line);
      }
      .context-item {
        display: inline-flex;
        align-items: baseline;
        gap: 0.4rem;
        font-size: 0.88rem;
      }
      .context-label {
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .context-value {
        color: var(--ink);
      }
      .context-health-red {
        color: var(--danger);
        font-size: 0.86rem;
      }
      .context-health-yellow {
        color: var(--warning);
        font-size: 0.86rem;
      }
      .stage-badge {
        display: inline-flex;
        align-items: center;
        padding: 0.18rem 0.5rem;
        border-radius: 999px;
        border: 1px solid rgba(16, 163, 127, 0.18);
        background: var(--accent-soft);
        color: var(--accent-ink);
        font-size: 0.78rem;
        font-weight: 600;
      }
      .manager-runs-grid {
        display: grid;
        gap: 0.85rem;
        margin-top: 1rem;
      }
      .manager-run-panel {
        display: grid;
        gap: 0.8rem;
        padding: 0.95rem;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.025);
      }
      .manager-run-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .manager-run-title h3 {
        margin: 0;
        font-size: 0.98rem;
      }
      .manager-lane-grid {
        display: grid;
        gap: 0.45rem;
      }
      .manager-lane-row {
        display: grid;
        grid-template-columns: minmax(8rem, 1fr) auto;
        gap: 0.55rem;
        padding: 0.55rem 0;
        border-top: 1px solid var(--line);
        align-items: start;
      }
      .manager-lane-row:first-child {
        border-top: none;
      }
      .manager-run-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
`;

export function renderDashboardHtml(
  snapshot: RuntimeSnapshot,
  options: DashboardRenderOptions,
): string {
  const initialRuntimeLabel = formatRuntimeSeconds(
    snapshot.codex_totals.seconds_running,
  );
  const totalTokensLabel = formatInteger(snapshot.codex_totals.total_tokens);
  const inputTokensLabel = formatInteger(snapshot.codex_totals.input_tokens);
  const outputTokensLabel = formatInteger(snapshot.codex_totals.output_tokens);
  const initialRateLimits = prettyValue(snapshot.rate_limits);
  const initialRateLimitAdmission = renderRateLimitAdmissionLabel(
    snapshot.rate_limit_admission,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Observability</title>
    <style>
${DASHBOARD_STYLES}
    </style>
  </head>
  <body>
    <main class="app-shell">
      <section class="dashboard-shell">
        <header class="hero-card">
          <div class="hero-grid">
            <div>
              <p class="eyebrow">Symphony Observability — v${getDisplayVersion()}</p>
              <h1 class="hero-title">Operations Dashboard</h1>
              <p class="hero-copy">
                Current state, retry pressure, token usage, and orchestration health for the active Symphony runtime.
              </p>
            </div>

            <div class="status-stack">
              <span id="live-status" class="status-badge${
                options.liveUpdatesEnabled ? " status-badge-live" : ""
              }">
                <span class="status-badge-dot"></span>
                <span>${options.liveUpdatesEnabled ? "Live" : "Offline"}</span>
              </span>
            </div>
          </div>
        </header>

        <section class="metric-grid">
          <article class="metric-card">
            <p class="metric-label">Running</p>
            <p id="metric-running" class="metric-value numeric">${snapshot.counts.running}</p>
            <p class="metric-detail">Active issue sessions in the current runtime.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Retrying</p>
            <p id="metric-retrying" class="metric-value numeric">${snapshot.counts.retrying}</p>
            <p class="metric-detail">Issues waiting for the next retry window.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Completed</p>
            <p id="metric-completed" class="metric-value numeric">${snapshot.counts.completed}</p>
            <p class="metric-detail">Issues that completed successfully.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Failed</p>
            <p id="metric-failed" class="metric-value numeric">${snapshot.counts.failed}</p>
            <p class="metric-detail">Issues whose final stage failed.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Total tokens</p>
            <p id="metric-total" class="metric-value numeric">${totalTokensLabel}</p>
            <p id="metric-total-detail" class="metric-detail numeric">In ${inputTokensLabel} / Out ${outputTokensLabel}</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Runtime</p>
            <p id="metric-runtime" class="metric-value numeric">${initialRuntimeLabel}</p>
            <p id="generated-at" class="metric-detail">Generated at ${escapeHtml(snapshot.generated_at)}</p>
          </article>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Decision quality</h2>
              <p class="section-copy">Measured dispatcher decisions, pending outcomes, and routing misses from the dispatcher journal.</p>
            </div>
          </div>

          <div id="decision-quality">${renderDecisionQuality(snapshot)}</div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Manager runs</h2>
              <p class="section-copy">Lane ledgers replayed as deterministic Symphony run state.</p>
            </div>
          </div>

          <div id="manager-runs" class="manager-runs-grid">${renderManagerRuns(snapshot)}</div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Anchors</h2>
              <p class="section-copy">Operator queue anchors with provenance and expiry.</p>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table" style="min-width: 760px;">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Placement</th>
                  <th>Expiry</th>
                  <th>Provenance</th>
                  <th>Sequence</th>
                </tr>
              </thead>
              <tbody id="anchor-rows">${renderAnchorRows(snapshot)}</tbody>
            </table>
          </div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Computed dispatch order</h2>
              <p class="section-copy">Deterministic comparator read-model with hard exclusions and advisory-edge visibility.</p>
            </div>
          </div>

          <div id="computed-order">${renderComputedOrder(snapshot)}</div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Rate limits</h2>
              <p class="section-copy">Latest upstream rate-limit snapshot, when available.</p>
            </div>
          </div>

          <p id="rate-limit-admission" class="section-copy">${escapeHtml(initialRateLimitAdmission)}</p>
          <pre id="rate-limits" class="code-panel">${escapeHtml(initialRateLimits)}</pre>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Running sessions</h2>
              <p class="section-copy">Active issues, last known agent activity, and token usage.</p>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table data-table-running">
              <colgroup>
                <col style="width: 12rem;" />
                <col style="width: 8rem;" />
                <col style="width: 7.5rem;" />
                <col style="width: 8.5rem;" />
                <col style="width: 7rem;" />
                <col />
                <col style="width: 10rem;" />
              </colgroup>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>State</th>
                  <th>Session</th>
                  <th>Runtime / turns</th>
                  <th>Pipeline</th>
                  <th>Codex update</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody id="running-rows">${renderRunningRows(snapshot)}</tbody>
            </table>
          </div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Retry queue</h2>
              <p class="section-copy">Issues waiting for the next retry window.</p>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table" style="min-width: 680px;">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Attempt</th>
                  <th>Due at</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody id="retry-rows">${renderRetryRows(snapshot)}</tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
    <script>
${renderDashboardClientScript(snapshot, options)}
    </script>
  </body>
</html>`;
}

function renderDashboardClientScript(
  snapshot: RuntimeSnapshot,
  options: DashboardRenderOptions,
): string {
  return `      window.__SYMPHONY_SNAPSHOT__ = ${JSON.stringify(snapshot)};
      window.__SYMPHONY_LIVE_UPDATES__ = ${JSON.stringify(
        options.liveUpdatesEnabled,
      )};
      (function () {
        const snapshot = window.__SYMPHONY_SNAPSHOT__;
        const liveUpdatesEnabled = window.__SYMPHONY_LIVE_UPDATES__ === true;

        function escapeHtml(value) {
          return String(value ?? '')
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        function formatInteger(value) {
          const number = Number(value);
          if (!Number.isFinite(number)) {
            return 'n/a';
          }
          return Math.trunc(number).toLocaleString('en-US');
        }

        function formatRuntimeSeconds(value) {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) {
            return '0m 0s';
          }
          const wholeSeconds = Math.max(0, Math.trunc(number));
          const mins = Math.floor(wholeSeconds / 60);
          const secs = wholeSeconds % 60;
          return mins + 'm ' + secs + 's';
        }

        function runtimeSecondsFromStartedAt(startedAt, generatedAt) {
          const start = Date.parse(startedAt);
          const generated = Date.parse(generatedAt);
          if (!Number.isFinite(start) || !Number.isFinite(generated) || generated < start) {
            return 0;
          }
          return (generated - start) / 1000;
        }

        function formatRuntimeAndTurns(row, generatedAt) {
          const runtime = formatRuntimeSeconds(runtimeSecondsFromStartedAt(row.started_at, generatedAt));
          if (Number.isInteger(row.turn_count) && row.turn_count > 0) {
            return runtime + ' / ' + row.turn_count;
          }
          return runtime;
        }

        function formatPipelineTime(row, generatedAt) {
          if (!row.first_dispatched_at || row.first_dispatched_at === row.started_at) {
            return '\u2014';
          }
          return formatRuntimeSeconds(runtimeSecondsFromStartedAt(row.first_dispatched_at, generatedAt));
        }

        function stateBadgeClass(state) {
          const normalized = String(state || '').toLowerCase();
          if (normalized.includes('progress') || normalized.includes('running') || normalized.includes('active')) {
            return 'state-badge state-badge-active';
          }
          if (normalized.includes('blocked') || normalized.includes('error') || normalized.includes('failed')) {
            return 'state-badge state-badge-danger';
          }
          if (normalized.includes('todo') || normalized.includes('queued') || normalized.includes('pending') || normalized.includes('retry')) {
            return 'state-badge state-badge-warning';
          }
          return 'state-badge';
        }

        function prettyValue(value) {
          if (value == null) {
            return 'n/a';
          }
          try {
            return JSON.stringify(value, null, 2);
          } catch (_error) {
            return String(value);
          }
        }

        function formatCompactTokens(tokens) {
          if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
          }
          if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'k';
          }
          return String(tokens);
        }

        function renderOutcomeLabel(outcome) {
          if (outcome === 'normal') return '<span style="color: var(--accent-ink)">normal</span>';
          if (outcome === 'failed_to_start') return '<span style="color: var(--danger)">failed to start</span>';
          if (outcome === 'timed_out') return '<span style="color: var(--warning)">timed out</span>';
          if (outcome === 'error') return '<span style="color: var(--danger)">error</span>';
          return escapeHtml(outcome);
        }

        function renderLoopTraceJournalPreview(trace) {
          var totalEntries = Number(trace && trace.total_entries) || 0;
          var entries = Array.isArray(trace && trace.entries) ? trace.entries : [];
          var empty = entries.length === 0
            ? '<div class="muted">No loop trace entries yet.</div>'
            : entries.map(renderLoopTraceEntry).join('');
          var countLabel = totalEntries === 1 ? '1 entry' : formatInteger(totalEntries) + ' entries';
          var truncatedLabel = trace && trace.truncated ? ' · oldest entries archived' : '';
          return '<div class="detail-section">' +
            '<p class="detail-section-title">Loop trace</p>' +
            '<div class="loop-trace-list">' +
            '<div class="muted">' + escapeHtml(countLabel + truncatedLabel) + '</div>' +
            empty +
            '</div></div>';
        }

        function renderLoopTraceEntry(entry) {
          var meta = ['#' + formatInteger(entry.sequence), entry.kind || 'event'];
          if (entry.stage) meta.push('stage ' + entry.stage);
          if (entry.attempt != null) meta.push('attempt ' + formatInteger(entry.attempt));
          if (entry.session_id) meta.push('session ' + entry.session_id);
          if (entry.prompt) {
            var tokenLabel = entry.prompt.estimated_tokens == null ? 'unknown tokens' : formatInteger(entry.prompt.estimated_tokens) + ' est tokens';
            meta.push('prompt ' + formatInteger(entry.prompt.chars) + ' chars, ' + tokenLabel);
          }
          if (entry.tool_action && entry.tool_action.tool_name) meta.push('tool ' + entry.tool_action.tool_name);
          if (entry.file_delta && Array.isArray(entry.file_delta.files) && entry.file_delta.files.length > 0) {
            meta.push(formatInteger(entry.file_delta.files.length) + ' files');
          }
          return '<div class="loop-trace-entry">' +
            '<div class="loop-trace-meta">' +
            meta.map(function (item, index) {
              var cls = index === 1 ? ' class="loop-trace-kind"' : '';
              return '<span' + cls + '>' + escapeHtml(item) + '</span>';
            }).join('') +
            '</div>' +
            '<div class="loop-trace-summary">' + escapeHtml(entry.summary || '') + '</div>' +
            '</div>';
        }

        function renderManagerRuns(next) {
          var runs = Array.isArray(next.manager_runs) ? next.manager_runs : [];
          if (runs.length === 0) {
            return '<p class="empty-state">No manager-run ledgers have been replayed.</p>';
          }
          return runs.map(function (run) {
            var counts = run.counts || {};
            var countTags = [
              ['Active', counts.active_lanes || 0, 'state-badge-active'],
              ['Blocked', counts.blocked_lanes || 0, 'state-badge-warning'],
              ['Degraded', counts.degraded_lanes || 0, 'state-badge-danger'],
              ['Follow-ups', counts.spawned_follow_ups || 0, 'state-badge'],
              ['Missing evidence', counts.missing_closeout_evidence || 0, counts.missing_closeout_evidence > 0 ? 'state-badge-danger' : 'state-badge-active']
            ].map(function (tag) {
              return '<span class="state-badge ' + tag[2] + '">' + escapeHtml(tag[0]) + ' ' + formatInteger(tag[1]) + '</span>';
            }).join('');
            var lanes = Array.isArray(run.lanes) ? run.lanes : [];
            var laneRows = lanes.length === 0
              ? '<p class="empty-state">No worker lanes admitted.</p>'
              : lanes.map(function (lane) {
                  var details = [];
                  if (lane.pr_url) details.push('PR ' + (lane.pr_status || 'linked'));
                  if (Array.isArray(lane.blocked_by) && lane.blocked_by.length > 0) details.push('blocked by ' + lane.blocked_by.join(', '));
                  if (Array.isArray(lane.degraded_reasons) && lane.degraded_reasons.length > 0) details.push(lane.degraded_reasons.join(', '));
                  if (Array.isArray(lane.follow_up_issue_identifiers) && lane.follow_up_issue_identifiers.length > 0) details.push('spawned ' + lane.follow_up_issue_identifiers.join(', '));
                  return '<div class="manager-lane-row">' +
                    '<div class="issue-stack"><span class="issue-id">' + escapeHtml(lane.issue_identifier) + '</span><span class="muted issue-title">' + escapeHtml(lane.title || '') + '</span><span class="muted event-meta">' + escapeHtml(details.join(' · ') || 'ledger clean') + '</span></div>' +
                    '<span class="' + stateBadgeClass(lane.status) + '">' + escapeHtml(lane.status) + '</span>' +
                    '</div>';
                }).join('');
            var missing = Array.isArray(run.missing_closeout_evidence) && run.missing_closeout_evidence.length > 0
              ? '<div class="manager-run-tags">' + run.missing_closeout_evidence.map(function (item) { return '<span class="state-badge state-badge-danger">' + escapeHtml(item) + '</span>'; }).join('') + '</div>'
              : '<span class="state-badge state-badge-active">Closeout ready</span>';
            return '<article class="manager-run-panel">' +
              '<div class="manager-run-title"><h3>' + escapeHtml(run.title || run.run_id) + '</h3><span class="mono muted">' + escapeHtml(run.manager_thread_id || run.run_id) + '</span></div>' +
              '<div class="manager-run-tags">' + countTags + '</div>' +
              '<div class="manager-lane-grid">' + laneRows + '</div>' +
              missing +
              '</article>';
          }).join('');
        }

        function renderDecisionQuality(next) {
          var summary = next.decision_quality;
          if (!summary || !summary.total) {
            return '<p class="empty-state">No measured dispatcher decisions yet.</p>';
          }
          var cards = [
            ['Measured decisions', summary.total, 'Journaled dispatcher decisions with a quality envelope.'],
            ['Measured outcomes', summary.measured, 'Decisions with observed outcomes or operator corrections.'],
            ['Pending outcomes', summary.pending, 'Decisions still waiting on a measured outcome.'],
            ['Exact matches', summary.exactMatches, 'Measured outcomes that still match the original dispatcher choice.'],
            ['False positives', summary.falsePositive, 'Interventions the later evidence says were too strong.'],
            ['False negatives', summary.falseNegative, 'Missed interventions later corrected by evidence or operators.'],
            ['Routing misses', summary.costSensitiveRoutingMisses, 'Stay-cheap routes later corrected to strong routing.'],
            ['Corrections', summary.corrected, 'Decisions with an explicit operator or meta-eval correction.']
          ].map(function (card) {
            return '<article class="metric-card"><p class="metric-label">' + escapeHtml(card[0]) + '</p><p class="metric-value numeric">' + formatInteger(card[1]) + '</p><p class="metric-detail">' + escapeHtml(card[2]) + '</p></article>';
          }).join('');
          var categories = ['right_sizing', 'admission', 're_steer', 'model_routing'];
          var rows = categories.map(function (category) {
            var bucket = summary.categories && summary.categories[category] ? summary.categories[category] : {};
            return '<tr>' +
              '<td>' + escapeHtml(category.replaceAll('_', ' ')) + '</td>' +
              '<td class="numeric">' + formatInteger(bucket.total || 0) + '</td>' +
              '<td class="numeric">' + formatInteger(bucket.measured || 0) + '</td>' +
              '<td class="numeric">' + formatInteger(bucket.falsePositive || 0) + '</td>' +
              '<td class="numeric">' + formatInteger(bucket.falseNegative || 0) + '</td>' +
              '<td class="numeric">' + formatInteger(bucket.costSensitiveRoutingMisses || 0) + '</td>' +
              '</tr>';
          }).join('');
          var latest = summary.latestEventAt ? '<p class="metric-detail">Latest decision: ' + escapeHtml(summary.latestEventAt) + '</p>' : '';
          return '<div class="metric-grid">' + cards + '</div>' +
            latest +
            '<div class="table-wrap"><table class="data-table" style="min-width: 640px;"><thead><tr><th>Category</th><th>Total</th><th>Measured</th><th>False positives</th><th>False negatives</th><th>Routing misses</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        }

        function renderDetailPanel(row, rowId) {
          var contextItems = [];
          if (row.pipeline_stage != null) {
            contextItems.push('<span class="context-item"><span class="context-label">Stage</span> <span class="stage-badge">' + escapeHtml(row.pipeline_stage) + '</span></span>');
          }
          if (row.activity_summary != null) {
            contextItems.push('<span class="context-item"><span class="context-label">Doing</span> <span class="context-value">' + escapeHtml(row.activity_summary) + '</span></span>');
          }
          if (row.health_reason != null) {
            var healthClass = row.health === 'red' ? 'context-health-red' : 'context-health-yellow';
            contextItems.push('<span class="context-item"><span class="context-label">Health</span> <span class="' + healthClass + '">' + escapeHtml(row.health_reason) + '</span></span>');
          }
          if (row.failure_reason != null) {
            contextItems.push('<span class="context-item"><span class="context-label">Failure</span> <span class="context-health-red">' + escapeHtml(row.failure_reason) + '</span></span>');
          }
          if (row.rework_count != null && row.rework_count > 0) {
            contextItems.push('<span class="context-item"><span class="context-label">Rework</span> <span class="state-badge state-badge-warning">\xD7' + formatInteger(row.rework_count) + '</span></span>');
          }
          var contextSection = contextItems.length > 0 ? '<div class="context-section">' + contextItems.join('') + '</div>' : '';

          var pt = row.pipeline_tokens || { input_tokens: 0, output_tokens: 0, total_tokens: row.total_pipeline_tokens, cache_read_tokens: 0, cache_write_tokens: 0 };
          var outputCaps = row.output_caps || {};
          var churn = row.churn || {};
          const tokenBreakdown =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Token breakdown</p>' +
            '<div class="detail-kv">' +
            '<span class="detail-kv-label">Input</span><span class="detail-kv-value numeric">' + formatInteger(pt.input_tokens) + '</span>' +
            '<span class="detail-kv-label">Output</span><span class="detail-kv-value numeric">' + formatInteger(pt.output_tokens) + '</span>' +
            '<span class="detail-kv-label">Total</span><span class="detail-kv-value numeric">' + formatInteger(pt.total_tokens) + '</span>' +
            '<span class="detail-kv-label">Cache read</span><span class="detail-kv-value numeric">' + formatInteger(pt.cache_read_tokens) + '</span>' +
            '<span class="detail-kv-label">Cache write</span><span class="detail-kv-value numeric">' + formatInteger(pt.cache_write_tokens) + '</span>' +
            '<span class="detail-kv-label">Reasoning</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.reasoning_tokens) + '</span>' +
            '<span class="detail-kv-label">Pipeline</span><span class="detail-kv-value numeric">' + formatInteger(row.total_pipeline_tokens) + '</span>' +
            '<span class="detail-kv-label">Tool cap</span><span class="detail-kv-value numeric">' + formatInteger(outputCaps.tool_output_token_limit) + '</span>' +
            '<span class="detail-kv-label">Auto compact</span><span class="detail-kv-value numeric">' + formatInteger(outputCaps.model_auto_compact_token_limit) + '</span>' +
            '<span class="detail-kv-label">Compactions</span><span class="detail-kv-value numeric">' + formatInteger(churn.current_stage_compactions) + '</span>' +
            rateLimitWindowKv(row.rate_limit_window) +
            '</div></div>';

          var displayActivity = (row.recent_activity || []).slice(-5);
          const recentActivityItems = (displayActivity.length === 0)
            ? (function () {
                if (row.pipeline_stage != null) {
                  var startMs = Date.parse(row.started_at);
                  var elapsedSecs = isFinite(startMs) ? Math.max(0, Math.floor((Date.now() - startMs) / 1000)) : 0;
                  var agoLabel = elapsedSecs < 60 ? elapsedSecs + 's ago' : Math.floor(elapsedSecs / 60) + 'm ago';
                  return '<li><span class="turn-num">' + escapeHtml(row.pipeline_stage) + '</span><span class="turn-msg muted">stage started</span><span class="activity-time">' + escapeHtml(agoLabel) + '</span></li>';
                }
                return '<li><span class="turn-num">\u2014</span><span class="turn-msg muted">Waiting for agent activity...</span><span></span></li>';
              })()
            : displayActivity.map(function (a) {
                var ago = '';
                if (a.timestamp) {
                  var diffMs = Date.now() - new Date(a.timestamp).getTime();
                  var secs = Math.max(0, Math.floor(diffMs / 1000));
                  ago = secs < 60 ? secs + 's ago' : Math.floor(secs / 60) + 'm ago';
                }
                var tokenLabel = (a.totalTokens != null && a.totalTokens > 0) ? ' \u00B7 ' + formatCompactTokens(a.totalTokens) : '';
                return '<li><span class="turn-num">' + escapeHtml(a.toolName) + '</span><span class="turn-msg" title="' + escapeHtml(a.context || '') + '">' + escapeHtml(a.context || '\u2014') + tokenLabel + '</span><span class="activity-time">' + escapeHtml(ago) + '</span></li>';
              }).join('');
          const recentActivity =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Recent activity</p>' +
            '<ul class="turn-timeline">' + recentActivityItems + '</ul>' +
            '</div>';

          const execRows = (!row.execution_history || row.execution_history.length === 0)
            ? '<tr><td colspan="6" class="muted">No completed stages.</td></tr>'
            : row.execution_history.map(function (s) {
                return '<tr><td>' + escapeHtml(s.stageName) + '</td><td class="numeric">' + formatInteger(s.turns) + '</td><td class="numeric">' + formatInteger(s.totalTokens) + '</td><td class="numeric">' + formatInteger(s.inputTokens || 0) + '</td><td class="numeric">' + formatInteger(s.outputTokens || 0) + '</td><td>' + renderOutcomeLabel(s.outcome) + '</td></tr>';
              }).join('');
          const executionHistory =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Execution history</p>' +
            '<table class="exec-history-table"><thead><tr><th>Stage</th><th>Turns</th><th>Tokens</th><th>In</th><th>Out</th><th>Outcome</th></tr></thead>' +
            '<tbody>' + execRows + '</tbody></table>' +
            '</div>';

          const loopTrace = renderLoopTraceJournalPreview(row.loop_trace_preview);

          return '<div class="detail-panel">' + contextSection + '<div class="detail-grid">' + tokenBreakdown + recentActivity + executionHistory + loopTrace + '</div></div>';
        }

        function rateLimitWindowKv(windows) {
          if (windows == null) {
            return '';
          }
          var renderOne = function (label, w) {
            if (w == null) {
              return '';
            }
            return '<span class="detail-kv-label">' + label + '</span><span class="detail-kv-value numeric">' + w.start_pct.toFixed(1) + '% → ' + w.latest_pct.toFixed(1) + '% (+' + w.delta_pct.toFixed(1) + '%)</span>';
          };
          return renderOne('5h window', windows.primary) + renderOne('Weekly window', windows.secondary);
        }

        function renderRunningRows(next) {
          if (!next.running || next.running.length === 0) {
            return '<tr><td colspan="7"><p class="empty-state">No active sessions.</p></td></tr>';
          }

          return next.running.map(function (row) {
            const detailId = 'detail-' + String(row.issue_identifier).replace(/[^a-zA-Z0-9]/g, '-');
            const sessionCell = row.session_id
              ? '<button type="button" class="subtle-button" data-label="Copy ID" data-copy="' + escapeHtml(row.session_id) + '" onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent = \\'Copied\\'; clearTimeout(this._copyTimer); this._copyTimer = setTimeout(() => { this.textContent = this.dataset.label }, 1200);">Copy ID</button>'
              : '<span class="muted">n/a</span>';

            const eventMeta = row.last_event
              ? escapeHtml(row.last_event) + (row.last_event_at ? ' · <span class="mono numeric">' + escapeHtml(row.last_event_at) + '</span>' : '')
              : 'n/a';

            const failureHtml = (row.failure_reason != null)
              ? '<span class="state-badge state-badge-danger" title="' + escapeHtml(row.failure_reason) + '">' + escapeHtml(row.failure_reason) + '</span>'
              : '';
            const reworkHtml = (row.rework_count != null && row.rework_count > 0)
              ? '<span class="state-badge state-badge-warning">Rework \xD7' + escapeHtml(row.rework_count) + '</span>'
              : '';
            const healthLabel = row.health === 'red' ? '\uD83D\uDD34 Red' : row.health === 'yellow' ? '\uD83D\uDFE1 Yellow' : '\uD83D\uDFE2 Green';
            const healthClass = 'health-badge health-badge-' + (row.health || 'green');
            const healthTitle = row.health_reason ? ' title="' + escapeHtml(row.health_reason) + '"' : '';
            const healthHtml = '<span class="' + healthClass + '"' + healthTitle + '><span class="health-badge-dot"></span>' + escapeHtml(healthLabel) + '</span>';
            const activityText = row.last_tool_call || row.activity_summary || row.last_event || 'n/a';
            const expandToggle = '<button type="button" class="expand-toggle" aria-expanded="false" data-detail="' + escapeHtml(detailId) + '" onclick="const d=document.getElementById(this.dataset.detail);const open=this.getAttribute(\\'aria-expanded\\')=== \\'true\\';d.style.display=open?\\'none\\':\\'table-row\\';this.setAttribute(\\'aria-expanded\\',String(!open));this.textContent=open?\\'\u25B6 Details\\':\\'\u25BC Details\\';">\u25B6 Details</button>';

            const detailRow = '<tr id="' + escapeHtml(detailId) + '" class="detail-row" style="display:none;"><td colspan="7">' + renderDetailPanel(row, detailId) + '</td></tr>';

            return '<tr class="session-row">' +
              '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(row.issue_identifier) + '</span><span class="muted issue-title">' + escapeHtml(row.issue_title) + '</span>' + expandToggle + '</div></td>' +
              '<td><div class="detail-stack"><span class="' + stateBadgeClass(row.state) + '">' + escapeHtml(row.state) + '</span>' + failureHtml + reworkHtml + healthHtml + '</div></td>' +
              '<td><div class="session-stack">' + sessionCell + '</div></td>' +
              '<td class="numeric">' + formatRuntimeAndTurns(row, next.generated_at) + '</td>' +
              '<td class="numeric">' + formatPipelineTime(row, next.generated_at) + '</td>' +
              '<td><div class="detail-stack"><span class="event-text" title="' + escapeHtml(activityText) + '">' + escapeHtml(activityText) + '</span><span class="muted event-meta">' + eventMeta + '</span></div></td>' +
              '<td><div class="token-stack numeric"><span>Total: ' + formatInteger(row.tokens && row.tokens.total_tokens) + '</span><span class="muted">In ' + formatInteger(row.tokens && row.tokens.input_tokens) + ' / Out ' + formatInteger(row.tokens && row.tokens.output_tokens) + '</span><span class="muted">' + formatInteger(row.tokens_per_turn) + ' / turn</span><span class="muted">Pipeline: ' + formatInteger(row.total_pipeline_tokens) + '</span></div></td>' +
              '</tr>' + detailRow;
          }).join('');
        }

        function renderRetryRows(next) {
          if (!next.retrying || next.retrying.length === 0) {
            return '<tr><td colspan="4"><p class="empty-state">No issues are currently backing off.</p></td></tr>';
          }

          return next.retrying.map(function (row) {
            return '<tr>' +
              '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(row.issue_identifier || row.issue_id) + '</span></div></td>' +
              '<td>' + escapeHtml(row.attempt) + '</td>' +
              '<td class="mono">' + escapeHtml(row.due_at || 'n/a') + '</td>' +
              '<td>' + escapeHtml(row.error || 'n/a') + '</td>' +
              '</tr>';
          }).join('');
        }

        function anchorPlacementLabel(placement) {
          if (!placement || placement.kind === 'top') {
            return 'top';
          }
          return String(placement.kind) + ' ' + String(placement.issue_identifier || '');
        }

        function anchorExpiryLabel(expiry) {
          if (!expiry || expiry.kind === 'until_merged') {
            return 'until merged';
          }
          return 'until ' + String(expiry.at || '');
        }

        function anchorProvenanceLabel(anchor) {
          var provenance = anchor && anchor.provenance ? anchor.provenance : {};
          var actor = provenance.actor || {};
          var actorLabel = String(actor.kind || 'unknown') + '@' + String(actor.host || 'unknown');
          if (actor.session) actorLabel += '#' + String(actor.session);
          var parts = [actorLabel, provenance.source || 'unknown'];
          if (provenance.editor_email) parts.push(provenance.editor_email);
          if (provenance.field_name) parts.push(provenance.field_name);
          if (provenance.reason && provenance.reason.human) parts.push(provenance.reason.human);
          return parts.join(' · ');
        }

        function renderComputedOrder(next) {
          var order = next.computed_order;
          if (!order) {
            return '<p class="empty-state">No computed dispatch order has been sampled yet.</p>';
          }
          var statusClass = order.status === 'hard_cycle' ? 'state-badge state-badge-danger' : 'state-badge state-badge-active';
          var status = '<p class="section-copy"><span class="' + statusClass + '">' + escapeHtml(order.status) + '</span> <span class="mono muted">' + escapeHtml(order.comparator_version || 'unknown') + '</span></p>';
          var cycle = order.hard_cycle
            ? '<p class="section-copy"><strong>Hard cycle:</strong> ' + escapeHtml((order.hard_cycle.issue_identifiers || []).join(' → ') || order.hard_cycle.reason || 'cycle detected') + '</p>'
            : '';
          var rows = Array.isArray(order.positions) && order.positions.length > 0
            ? order.positions.map(function (position) {
                var rationale = Array.isArray(position.rationale) ? position.rationale.join(' · ') : '';
                return '<tr>' +
                  '<td class="numeric">' + formatInteger(position.position) + '</td>' +
                  '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(position.issue_identifier || position.issue_id) + '</span></div></td>' +
                  '<td>' + escapeHtml(rationale) + '</td>' +
                  '</tr>';
              }).join('')
            : '<tr><td colspan="3"><p class="empty-state">No linearized positions.</p></td></tr>';
          var exclusions = Array.isArray(order.exclusions) ? order.exclusions.length : 0;
          var advisory = Array.isArray(order.advisory_warnings) ? order.advisory_warnings.length : 0;
          var wouldExclude = Array.isArray(order.would_have_been_excluded_by_advisory_edges) ? order.would_have_been_excluded_by_advisory_edges.length : 0;
          var summary = '<p class="section-copy">Hard exclusions: ' + formatInteger(exclusions) + ' · Advisory warnings: ' + formatInteger(advisory) + ' · Would-have-been advisory exclusions: ' + formatInteger(wouldExclude) + '</p>';
          var exclusionPanel = exclusions === 0
            ? ''
            : '<p class="detail-section-title">Hard exclusions</p><div class="table-wrap"><table class="data-table" style="min-width: 720px;"><thead><tr><th>Issue</th><th>Blocked by</th><th>Reason</th></tr></thead><tbody>' +
              order.exclusions.map(function (exclusion) {
                return '<tr><td>' + escapeHtml(exclusion.issue_identifier || exclusion.issue_id) + '</td><td>' + escapeHtml(exclusion.blocker_issue_identifier || exclusion.blocker_issue_id || 'unknown') + '</td><td>' + escapeHtml(exclusion.reason || '') + '</td></tr>';
              }).join('') +
              '</tbody></table></div>';
          var advisoryPanel = advisory === 0
            ? ''
            : '<p class="detail-section-title">Advisory warnings</p><div class="table-wrap"><table class="data-table" style="min-width: 720px;"><thead><tr><th>Issue</th><th>Advisory blocker</th><th>Reason</th></tr></thead><tbody>' +
              order.advisory_warnings.map(function (warning) {
                return '<tr><td>' + escapeHtml(warning.issue_identifier || warning.issue_id) + '</td><td>' + escapeHtml(warning.blocker_issue_identifier || warning.blocker_issue_id || 'unknown') + '</td><td>' + escapeHtml(warning.reason || '') + '</td></tr>';
              }).join('') +
              '</tbody></table></div>';
          return status + cycle + summary + exclusionPanel + advisoryPanel +
            '<div class="table-wrap"><table class="data-table" style="min-width: 720px;"><thead><tr><th>Position</th><th>Issue</th><th>Rationale</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
        }

        function renderAnchorRows(next) {
          var anchors = Array.isArray(next.anchors) ? next.anchors : [];
          if (anchors.length === 0) {
            return '<tr><td colspan="5"><p class="empty-state">No active anchors.</p></td></tr>';
          }
          return anchors.map(function (anchor) {
            return '<tr>' +
              '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(anchor.issue_identifier || anchor.issue_id) + '</span></div></td>' +
              '<td>' + escapeHtml(anchorPlacementLabel(anchor.placement)) + '</td>' +
              '<td>' + escapeHtml(anchorExpiryLabel(anchor.expiry)) + '</td>' +
              '<td><div class="detail-stack"><span>' + escapeHtml(anchorProvenanceLabel(anchor)) + '</span><span class="muted event-meta">' + escapeHtml(anchor.set_at || 'n/a') + '</span></div></td>' +
              '<td class="numeric">' + (anchor.set_by_sequence == null ? 'n/a' : formatInteger(anchor.set_by_sequence)) + '</td>' +
              '</tr>';
          }).join('');
        }

        function setStatus(text, live) {
          const element = document.getElementById('live-status');
          if (!element) return;
          element.className = live ? 'status-badge status-badge-live' : 'status-badge';
          const label = element.querySelector('span:last-child');
          if (label) {
            label.textContent = text;
          }
        }

        function render(next) {
          document.getElementById('generated-at').textContent = 'Generated at ' + next.generated_at;
          document.getElementById('metric-running').textContent = String(next.counts.running);
          document.getElementById('metric-retrying').textContent = String(next.counts.retrying);
          document.getElementById('metric-completed').textContent = String(next.counts.completed);
          document.getElementById('metric-failed').textContent = String(next.counts.failed);
          document.getElementById('metric-total').textContent = formatInteger(next.codex_totals.total_tokens);
          document.getElementById('metric-total-detail').textContent = 'In ' + formatInteger(next.codex_totals.input_tokens) + ' / Out ' + formatInteger(next.codex_totals.output_tokens);
          document.getElementById('metric-runtime').textContent = formatRuntimeSeconds(next.codex_totals.seconds_running);
          document.getElementById('decision-quality').innerHTML = renderDecisionQuality(next);
          document.getElementById('manager-runs').innerHTML = renderManagerRuns(next);
          document.getElementById('computed-order').innerHTML = renderComputedOrder(next);
          document.getElementById('anchor-rows').innerHTML = renderAnchorRows(next);
          // Preserve expand/collapse state before DOM replacement (SYMPH-37)
          var expandedIds = new Set();
          document.querySelectorAll('.expand-toggle[aria-expanded="true"]').forEach(function(btn) {
            expandedIds.add(btn.getAttribute('data-detail'));
          });
          document.getElementById('running-rows').innerHTML = renderRunningRows(next);
          // Restore expand state after DOM replacement
          expandedIds.forEach(function(detailId) {
            var btn = document.querySelector('.expand-toggle[data-detail="' + detailId + '"]');
            if (btn) {
              var d = document.getElementById(detailId);
              if (d) {
                d.style.display = 'table-row';
                btn.setAttribute('aria-expanded', 'true');
                btn.textContent = '\u25BC Details';
              }
            }
          });
          document.getElementById('retry-rows').innerHTML = renderRetryRows(next);
          document.getElementById('rate-limits').textContent = prettyValue(next.rate_limits);
          document.getElementById('rate-limit-admission').textContent = rateLimitAdmissionLabel(next.rate_limit_admission);
        }

        function rateLimitAdmissionLabel(admission) {
          if (admission == null) {
            return 'Dispatch headroom floor: not configured.';
          }
          if (admission.blocked) {
            return 'Dispatch blocked: ' + (admission.reason || 'rate-limit headroom below the configured floor.');
          }
          var parts = [];
          if (admission.primary_used_pct != null) {
            parts.push('5h window ' + admission.primary_used_pct.toFixed(1) + '% used');
          }
          if (admission.secondary_used_pct != null) {
            parts.push('weekly window ' + admission.secondary_used_pct.toFixed(1) + '% used');
          }
          return 'Dispatch headroom floor: ok' + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : ' (no snapshot observed yet)') + '.';
        }

        render(snapshot);
        if (!liveUpdatesEnabled || typeof window.EventSource !== 'function') {
          return;
        }

        const source = new window.EventSource('/api/v1/events');
        source.addEventListener('open', function () {
          setStatus('Live', true);
        });
        source.addEventListener('snapshot', function (event) {
          try {
            const next = JSON.parse(event.data);
            render(next);
            setStatus('Live', true);
          } catch (_error) {
            setStatus('Degraded', false);
          }
        });
        source.addEventListener('error', function () {
          setStatus('Reconnecting', false);
        });
      })();`;
}

function formatPipelineTime(
  firstDispatchedAt: string,
  startedAt: string,
  generatedAt: string,
): string {
  if (firstDispatchedAt === startedAt) {
    return "\u2014";
  }
  const seconds = runtimeSecondsFromStartedAt(firstDispatchedAt, generatedAt);
  return formatRuntimeSeconds(seconds);
}

function renderRunningRows(snapshot: RuntimeSnapshot): string {
  if (snapshot.running.length === 0) {
    return '<tr><td colspan="7"><p class="empty-state">No active sessions.</p></td></tr>';
  }
  return snapshot.running
    .map((row) => {
      const detailId = `detail-${row.issue_identifier.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const detailPanel = renderDetailPanel(row);
      return `
            <tr class="session-row">
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(row.issue_identifier)}</span>
                  <span class="muted issue-title">${escapeHtml(row.issue_title)}</span>
                  <button type="button" class="expand-toggle" aria-expanded="false" data-detail="${escapeHtml(detailId)}" onclick="const d=document.getElementById(this.dataset.detail);const open=this.getAttribute('aria-expanded')==='true';d.style.display=open?'none':'table-row';this.setAttribute('aria-expanded',String(!open));this.textContent=open?'\u25B6 Details':'\u25BC Details';">&#x25B6; Details</button>
                </div>
              </td>
              <td>
                <div class="detail-stack">
                  <span class="${stateBadgeClass(row.state)}">${escapeHtml(row.state)}</span>
                  ${row.failure_reason != null ? `<span class="state-badge state-badge-danger" title="${escapeHtml(row.failure_reason)}">${escapeHtml(row.failure_reason)}</span>` : ""}
                  ${row.rework_count !== undefined && row.rework_count > 0 ? `<span class="state-badge state-badge-warning">Rework ×${escapeHtml(row.rework_count)}</span>` : ""}
                  ${renderHealthBadge(row.health, row.health_reason)}
                </div>
              </td>
              <td>
                <div class="session-stack">
                  ${
                    row.session_id === null
                      ? '<span class="muted">n/a</span>'
                      : `<button type="button" class="subtle-button" data-label="Copy ID" data-copy="${escapeHtml(
                          row.session_id,
                        )}" onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent = 'Copied'; clearTimeout(this._copyTimer); this._copyTimer = setTimeout(() => { this.textContent = this.dataset.label }, 1200);">Copy ID</button>`
                  }
                </div>
              </td>
              <td class="numeric">${formatRuntimeAndTurns(
                row.started_at,
                row.turn_count,
                snapshot.generated_at,
              )}</td>
              <td class="numeric">${formatPipelineTime(
                row.first_dispatched_at,
                row.started_at,
                snapshot.generated_at,
              )}</td>
              <td>
                <div class="detail-stack">
                  <span class="event-text" title="${escapeHtml(
                    row.last_tool_call ??
                      row.activity_summary ??
                      row.last_event ??
                      "n/a",
                  )}">${escapeHtml(
                    row.last_tool_call ??
                      row.activity_summary ??
                      row.last_event ??
                      "n/a",
                  )}</span>
                  <span class="muted event-meta">${escapeHtml(
                    row.last_event ?? "n/a",
                  )}${
                    row.last_event_at === null
                      ? ""
                      : ` · <span class="mono numeric">${escapeHtml(
                          row.last_event_at,
                        )}</span>`
                  }</span>
                </div>
              </td>
              <td>
                <div class="token-stack numeric">
                  <span>Total: ${formatInteger(row.tokens.total_tokens)}</span>
                  <span class="muted">In ${formatInteger(
                    row.tokens.input_tokens,
                  )} / Out ${formatInteger(row.tokens.output_tokens)}</span>
                  <span class="muted">${formatInteger(row.tokens_per_turn)} / turn</span>
                  <span class="muted">Pipeline: ${formatInteger(row.total_pipeline_tokens)}</span>
                </div>
              </td>
            </tr>
            <tr id="${escapeHtml(detailId)}" class="detail-row" style="display:none;">
              <td colspan="7">${detailPanel}</td>
            </tr>`;
    })
    .join("");
}

function renderDecisionQuality(snapshot: RuntimeSnapshot): string {
  const summary = snapshot.decision_quality;
  if (summary === undefined || summary.total === 0) {
    return '<p class="empty-state">No measured dispatcher decisions yet.</p>';
  }

  const cards = [
    {
      label: "Measured decisions",
      value: summary.total,
      detail: "Journaled dispatcher decisions with a quality envelope.",
    },
    {
      label: "Measured outcomes",
      value: summary.measured,
      detail: "Decisions with observed outcomes or operator corrections.",
    },
    {
      label: "Pending outcomes",
      value: summary.pending,
      detail: "Decisions still waiting on a measured outcome.",
    },
    {
      label: "Exact matches",
      value: summary.exactMatches,
      detail: "Measured outcomes that still match the original choice.",
    },
    {
      label: "False positives",
      value: summary.falsePositive,
      detail: "Interventions later shown to be too strong.",
    },
    {
      label: "False negatives",
      value: summary.falseNegative,
      detail: "Missed interventions later corrected by evidence.",
    },
    {
      label: "Routing misses",
      value: summary.costSensitiveRoutingMisses,
      detail: "Cheap routes later corrected to stronger routing.",
    },
    {
      label: "Corrections",
      value: summary.corrected,
      detail: "Explicit operator or meta-eval corrections.",
    },
  ]
    .map(
      (card) => `
        <article class="metric-card">
          <p class="metric-label">${escapeHtml(card.label)}</p>
          <p class="metric-value numeric">${formatInteger(card.value)}</p>
          <p class="metric-detail">${escapeHtml(card.detail)}</p>
        </article>`,
    )
    .join("");

  const categoryRows = (
    ["right_sizing", "admission", "re_steer", "model_routing"] as const
  )
    .map((category) => {
      const bucket = summary.categories[category];
      return `
        <tr>
          <td>${escapeHtml(category.replaceAll("_", " "))}</td>
          <td class="numeric">${formatInteger(bucket.total)}</td>
          <td class="numeric">${formatInteger(bucket.measured)}</td>
          <td class="numeric">${formatInteger(bucket.falsePositive)}</td>
          <td class="numeric">${formatInteger(bucket.falseNegative)}</td>
          <td class="numeric">${formatInteger(bucket.costSensitiveRoutingMisses)}</td>
        </tr>`;
    })
    .join("");

  const latest =
    summary.latestEventAt === null
      ? ""
      : `<p class="metric-detail">Latest decision: ${escapeHtml(summary.latestEventAt)}</p>`;

  return `
    <div class="metric-grid">${cards}</div>
    ${latest}
    <div class="table-wrap">
      <table class="data-table" style="min-width: 640px;">
        <thead>
          <tr>
            <th>Category</th>
            <th>Total</th>
            <th>Measured</th>
            <th>False positives</th>
            <th>False negatives</th>
            <th>Routing misses</th>
          </tr>
        </thead>
        <tbody>${categoryRows}</tbody>
      </table>
    </div>`;
}

function renderManagerRuns(snapshot: RuntimeSnapshot): string {
  const managerRuns = snapshot.manager_runs ?? [];
  if (managerRuns.length === 0) {
    return '<p class="empty-state">No manager-run ledgers have been replayed.</p>';
  }

  return managerRuns
    .map((run) => {
      const tags = [
        {
          label: "Active",
          value: run.counts.active_lanes,
          className: "state-badge-active",
        },
        {
          label: "Blocked",
          value: run.counts.blocked_lanes,
          className: "state-badge-warning",
        },
        {
          label: "Degraded",
          value: run.counts.degraded_lanes,
          className: "state-badge-danger",
        },
        {
          label: "Follow-ups",
          value: run.counts.spawned_follow_ups,
          className: "",
        },
        {
          label: "Missing evidence",
          value: run.counts.missing_closeout_evidence,
          className:
            run.counts.missing_closeout_evidence > 0
              ? "state-badge-danger"
              : "state-badge-active",
        },
      ]
        .map(
          (tag) =>
            `<span class="state-badge ${tag.className}">${escapeHtml(tag.label)} ${formatInteger(tag.value)}</span>`,
        )
        .join("");

      const laneRows =
        run.lanes.length === 0
          ? '<p class="empty-state">No worker lanes admitted.</p>'
          : run.lanes
              .map((lane) => {
                const details: string[] = [];
                if (lane.pr_url !== null) {
                  details.push(`PR ${lane.pr_status ?? "linked"}`);
                }
                if (lane.blocked_by.length > 0) {
                  details.push(`blocked by ${lane.blocked_by.join(", ")}`);
                }
                if (lane.degraded_reasons.length > 0) {
                  details.push(lane.degraded_reasons.join(", "));
                }
                if (lane.follow_up_issue_identifiers.length > 0) {
                  details.push(
                    `spawned ${lane.follow_up_issue_identifiers.join(", ")}`,
                  );
                }
                return `
                  <div class="manager-lane-row">
                    <div class="issue-stack">
                      <span class="issue-id">${escapeHtml(lane.issue_identifier)}</span>
                      <span class="muted issue-title">${escapeHtml(lane.title)}</span>
                      <span class="muted event-meta">${escapeHtml(details.join(" · ") || "ledger clean")}</span>
                    </div>
                    <span class="${stateBadgeClass(lane.status)}">${escapeHtml(lane.status)}</span>
                  </div>`;
              })
              .join("");

      const missingEvidence =
        run.missing_closeout_evidence.length === 0
          ? '<span class="state-badge state-badge-active">Closeout ready</span>'
          : `<div class="manager-run-tags">${run.missing_closeout_evidence
              .map(
                (item) =>
                  `<span class="state-badge state-badge-danger">${escapeHtml(item)}</span>`,
              )
              .join("")}</div>`;

      return `
        <article class="manager-run-panel">
          <div class="manager-run-title">
            <h3>${escapeHtml(run.title ?? run.run_id)}</h3>
            <span class="mono muted">${escapeHtml(run.manager_thread_id ?? run.run_id)}</span>
          </div>
          <div class="manager-run-tags">${tags}</div>
          <div class="manager-lane-grid">${laneRows}</div>
          ${missingEvidence}
        </article>`;
    })
    .join("");
}

function renderDetailPanel(row: RuntimeSnapshot["running"][number]): string {
  const contextItems: string[] = [];

  if (row.pipeline_stage !== null) {
    contextItems.push(
      `<span class="context-item"><span class="context-label">Stage</span> <span class="stage-badge">${escapeHtml(row.pipeline_stage)}</span></span>`,
    );
  }

  if (row.activity_summary !== null) {
    contextItems.push(
      `<span class="context-item"><span class="context-label">Doing</span> <span class="context-value">${escapeHtml(row.activity_summary)}</span></span>`,
    );
  }

  if (row.health_reason !== null) {
    const healthClass =
      row.health === "red" ? "context-health-red" : "context-health-yellow";
    contextItems.push(
      `<span class="context-item"><span class="context-label">Health</span> <span class="${healthClass}">${escapeHtml(row.health_reason)}</span></span>`,
    );
  }

  if (row.failure_reason !== null && row.failure_reason !== undefined) {
    contextItems.push(
      `<span class="context-item"><span class="context-label">Failure</span> <span class="context-health-red">${escapeHtml(row.failure_reason)}</span></span>`,
    );
  }

  if (row.rework_count !== undefined && row.rework_count > 0) {
    contextItems.push(
      `<span class="context-item"><span class="context-label">Rework</span> <span class="state-badge state-badge-warning">\u00D7${formatInteger(row.rework_count)}</span></span>`,
    );
  }

  const contextSection =
    contextItems.length > 0
      ? `<div class="context-section">${contextItems.join("")}</div>`
      : "";

  const pt = row.pipeline_tokens ?? {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: row.total_pipeline_tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  const outputCaps = row.output_caps;
  const churn = row.churn;
  const tokenBreakdown = `
    <div class="detail-section">
      <p class="detail-section-title">Token breakdown</p>
      <div class="detail-kv">
        <span class="detail-kv-label">Input</span><span class="detail-kv-value numeric">${formatInteger(pt.input_tokens)}</span>
        <span class="detail-kv-label">Output</span><span class="detail-kv-value numeric">${formatInteger(pt.output_tokens)}</span>
        <span class="detail-kv-label">Total</span><span class="detail-kv-value numeric">${formatInteger(pt.total_tokens)}</span>
        <span class="detail-kv-label">Cache read</span><span class="detail-kv-value numeric">${formatInteger(pt.cache_read_tokens)}</span>
        <span class="detail-kv-label">Cache write</span><span class="detail-kv-value numeric">${formatInteger(pt.cache_write_tokens)}</span>
        <span class="detail-kv-label">Reasoning</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.reasoning_tokens)}</span>
        <span class="detail-kv-label">Pipeline</span><span class="detail-kv-value numeric">${formatInteger(row.total_pipeline_tokens)}</span>
        <span class="detail-kv-label">Tool cap</span><span class="detail-kv-value numeric">${formatInteger(outputCaps?.tool_output_token_limit ?? Number.NaN)}</span>
        <span class="detail-kv-label">Auto compact</span><span class="detail-kv-value numeric">${formatInteger(outputCaps?.model_auto_compact_token_limit ?? Number.NaN)}</span>
        <span class="detail-kv-label">Compactions</span><span class="detail-kv-value numeric">${formatInteger(churn?.current_stage_compactions ?? Number.NaN)}</span>
        ${renderRateLimitWindowKv(row.rate_limit_window)}
      </div>
    </div>`;

  const displayActivity = row.recent_activity.slice(-5);
  const recentActivityRows =
    displayActivity.length === 0
      ? (() => {
          // Fallback: show stage-level status when session is active but no tool calls yet
          if (row.pipeline_stage !== null) {
            const startMs = Date.parse(row.started_at);
            const elapsedSecs = Number.isFinite(startMs)
              ? Math.max(0, Math.floor((Date.now() - startMs) / 1000))
              : 0;
            const agoLabel =
              elapsedSecs < 60
                ? `${elapsedSecs}s ago`
                : `${Math.floor(elapsedSecs / 60)}m ago`;
            return `<li><span class="turn-num">${escapeHtml(row.pipeline_stage)}</span><span class="turn-msg muted">stage started</span><span class="activity-time">${escapeHtml(agoLabel)}</span></li>`;
          }
          return '<li><span class="turn-num">\u2014</span><span class="turn-msg muted">Waiting for agent activity...</span><span></span></li>';
        })()
      : displayActivity
          .map((a) => {
            const diffMs = Date.now() - new Date(a.timestamp).getTime();
            const secs = Math.max(0, Math.floor(diffMs / 1000));
            const ago =
              secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
            const tokenLabel =
              a.totalTokens !== undefined && a.totalTokens > 0
                ? ` \u00B7 ${formatCompactTokens(a.totalTokens)}`
                : "";
            return `<li><span class="turn-num">${escapeHtml(a.toolName)}</span><span class="turn-msg" title="${escapeHtml(a.context ?? "")}">${escapeHtml(a.context ?? "\u2014")}${tokenLabel}</span><span class="activity-time">${escapeHtml(ago)}</span></li>`;
          })
          .join("");

  const recentActivity = `
    <div class="detail-section">
      <p class="detail-section-title">Recent activity</p>
      <ul class="turn-timeline">${recentActivityRows}</ul>
    </div>`;

  const execHistoryRows =
    row.execution_history.length === 0
      ? `<tr><td colspan="6" class="muted">No completed stages.</td></tr>`
      : row.execution_history
          .map(
            (s) =>
              `<tr><td>${escapeHtml(s.stageName)}</td><td class="numeric">${formatInteger(s.turns)}</td><td class="numeric">${formatInteger(s.totalTokens)}</td><td class="numeric">${formatInteger(s.inputTokens ?? 0)}</td><td class="numeric">${formatInteger(s.outputTokens ?? 0)}</td><td>${renderOutcomeLabel(s.outcome)}</td></tr>`,
          )
          .join("");

  const executionHistory = `
    <div class="detail-section">
      <p class="detail-section-title">Execution history</p>
      <table class="exec-history-table">
        <thead><tr><th>Stage</th><th>Turns</th><th>Tokens</th><th>In</th><th>Out</th><th>Outcome</th></tr></thead>
        <tbody>${execHistoryRows}</tbody>
      </table>
    </div>`;

  const loopTrace = renderLoopTraceJournalPreview(row.loop_trace_preview);

  return `<div class="detail-panel">${contextSection}<div class="detail-grid">${tokenBreakdown}${recentActivity}${executionHistory}${loopTrace}</div></div>`;
}

function renderRateLimitAdmissionLabel(
  admission: RuntimeSnapshot["rate_limit_admission"],
): string {
  if (admission === null) {
    return "Dispatch headroom floor: not configured.";
  }
  if (admission.blocked) {
    return `Dispatch blocked: ${admission.reason ?? "rate-limit headroom below the configured floor."}`;
  }
  const parts: string[] = [];
  if (admission.primary_used_pct !== null) {
    parts.push(`5h window ${admission.primary_used_pct.toFixed(1)}% used`);
  }
  if (admission.secondary_used_pct !== null) {
    parts.push(
      `weekly window ${admission.secondary_used_pct.toFixed(1)}% used`,
    );
  }
  const detail =
    parts.length > 0 ? ` (${parts.join(", ")})` : " (no snapshot observed yet)";
  return `Dispatch headroom floor: ok${detail}.`;
}

function renderRateLimitWindowKv(
  windows: RuntimeSnapshot["running"][number]["rate_limit_window"],
): string {
  if (windows === null) {
    return "";
  }
  const renderOne = (
    label: string,
    window: {
      start_pct: number;
      latest_pct: number;
      delta_pct: number;
    } | null,
  ): string => {
    if (window === null) {
      return "";
    }
    return `<span class="detail-kv-label">${escapeHtml(label)}</span><span class="detail-kv-value numeric">${window.start_pct.toFixed(1)}% → ${window.latest_pct.toFixed(1)}% (+${window.delta_pct.toFixed(1)}%)</span>`;
  };
  return (
    renderOne("5h window", windows.primary) +
    renderOne("Weekly window", windows.secondary)
  );
}

function renderLoopTraceJournalPreview(
  trace: RuntimeSnapshot["running"][number]["loop_trace_preview"],
): string {
  const countLabel =
    trace.total_entries === 1
      ? "1 entry"
      : `${formatInteger(trace.total_entries)} entries`;
  const truncatedLabel = trace.truncated ? " · oldest entries archived" : "";
  const entries =
    trace.entries.length === 0
      ? '<div class="muted">No loop trace entries yet.</div>'
      : trace.entries.map(renderLoopTraceEntry).join("");

  return `
    <div class="detail-section">
      <p class="detail-section-title">Loop trace</p>
      <div class="loop-trace-list">
        <div class="muted">${escapeHtml(countLabel + truncatedLabel)}</div>
        ${entries}
      </div>
    </div>`;
}

function renderLoopTraceEntry(
  entry: RuntimeSnapshot["running"][number]["loop_trace_preview"]["entries"][number],
): string {
  const meta = [`#${formatInteger(entry.sequence)}`, entry.kind || "event"];
  if (entry.stage !== null) meta.push(`stage ${entry.stage}`);
  if (entry.attempt !== null)
    meta.push(`attempt ${formatInteger(entry.attempt)}`);
  if (entry.session_id !== null) meta.push(`session ${entry.session_id}`);
  if (entry.prompt !== null) {
    const tokenLabel =
      entry.prompt.estimated_tokens === null
        ? "unknown tokens"
        : `${formatInteger(entry.prompt.estimated_tokens)} est tokens`;
    meta.push(
      `prompt ${formatInteger(entry.prompt.chars)} chars, ${tokenLabel}`,
    );
  }
  if (entry.tool_action !== null) {
    meta.push(`tool ${entry.tool_action.tool_name}`);
  }
  if (entry.file_delta !== null && entry.file_delta.files.length > 0) {
    meta.push(`${formatInteger(entry.file_delta.files.length)} files`);
  }

  return `
    <div class="loop-trace-entry">
      <div class="loop-trace-meta">
        ${meta
          .map(
            (item, index) =>
              `<span${index === 1 ? ' class="loop-trace-kind"' : ""}>${escapeHtml(item)}</span>`,
          )
          .join("")}
      </div>
      <div class="loop-trace-summary">${escapeHtml(entry.summary)}</div>
    </div>`;
}

function renderRetryRows(snapshot: RuntimeSnapshot): string {
  return snapshot.retrying.length === 0
    ? '<tr><td colspan="4"><p class="empty-state">No issues are currently backing off.</p></td></tr>'
    : snapshot.retrying
        .map(
          (row) => `
            <tr>
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(row.issue_identifier ?? row.issue_id)}</span>
                </div>
              </td>
              <td>${row.attempt}</td>
              <td class="mono">${escapeHtml(row.due_at)}</td>
              <td>${escapeHtml(row.error ?? "n/a")}</td>
            </tr>`,
        )
        .join("");
}

function renderComputedOrder(snapshot: RuntimeSnapshot): string {
  const order = snapshot.computed_order;
  if (order === null || order === undefined) {
    return '<p class="empty-state">No computed dispatch order has been sampled yet.</p>';
  }
  const statusClass =
    order.status === "hard_cycle"
      ? "state-badge state-badge-danger"
      : "state-badge state-badge-active";
  const status = `<p class="section-copy"><span class="${statusClass}">${escapeHtml(
    order.status,
  )}</span> <span class="mono muted">${escapeHtml(
    order.comparator_version,
  )}</span></p>`;
  const cycle =
    order.hard_cycle === null
      ? ""
      : `<p class="section-copy"><strong>Hard cycle:</strong> ${escapeHtml(
          order.hard_cycle.issue_identifiers.join(" → ") ||
            order.hard_cycle.reason ||
            "cycle detected",
        )}</p>`;
  const summary = `<p class="section-copy">Hard exclusions: ${formatInteger(
    order.exclusions.length,
  )} · Advisory warnings: ${formatInteger(
    order.advisory_warnings.length,
  )} · Would-have-been advisory exclusions: ${formatInteger(
    order.would_have_been_excluded_by_advisory_edges.length,
  )}</p>`;
  const exclusionPanel =
    order.exclusions.length === 0
      ? ""
      : `<p class="detail-section-title">Hard exclusions</p>
          <div class="table-wrap">
            <table class="data-table" style="min-width: 720px;">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Blocked by</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>${order.exclusions
                .map(
                  (exclusion) => `
                  <tr>
                    <td>${escapeHtml(
                      exclusion.issue_identifier || exclusion.issue_id,
                    )}</td>
                    <td>${escapeHtml(
                      exclusion.blocker_issue_identifier ??
                        exclusion.blocker_issue_id ??
                        "unknown",
                    )}</td>
                    <td>${escapeHtml(exclusion.reason)}</td>
                  </tr>`,
                )
                .join("")}</tbody>
            </table>
          </div>`;
  const advisoryPanel =
    order.advisory_warnings.length === 0
      ? ""
      : `<p class="detail-section-title">Advisory warnings</p>
          <div class="table-wrap">
            <table class="data-table" style="min-width: 720px;">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Advisory blocker</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>${order.advisory_warnings
                .map(
                  (warning) => `
                  <tr>
                    <td>${escapeHtml(
                      warning.issue_identifier || warning.issue_id,
                    )}</td>
                    <td>${escapeHtml(
                      warning.blocker_issue_identifier ??
                        warning.blocker_issue_id ??
                        "unknown",
                    )}</td>
                    <td>${escapeHtml(warning.reason)}</td>
                  </tr>`,
                )
                .join("")}</tbody>
            </table>
          </div>`;
  const rows =
    order.positions.length === 0
      ? '<tr><td colspan="3"><p class="empty-state">No linearized positions.</p></td></tr>'
      : order.positions
          .map(
            (position) => `
            <tr>
              <td class="numeric">${formatInteger(position.position)}</td>
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(
                    position.issue_identifier || position.issue_id,
                  )}</span>
                </div>
              </td>
              <td>${escapeHtml(position.rationale.join(" · "))}</td>
            </tr>`,
          )
          .join("");
  return `${status}${cycle}${summary}${exclusionPanel}${advisoryPanel}
          <div class="table-wrap">
            <table class="data-table" style="min-width: 720px;">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Issue</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
}

function renderAnchorRows(snapshot: RuntimeSnapshot): string {
  const anchors = snapshot.anchors ?? [];
  return anchors.length === 0
    ? '<tr><td colspan="5"><p class="empty-state">No active anchors.</p></td></tr>'
    : anchors
        .map(
          (anchor) => `
            <tr>
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(anchor.issue_identifier)}</span>
                </div>
              </td>
              <td>${escapeHtml(formatAnchorPlacement(anchor.placement))}</td>
              <td>${escapeHtml(formatAnchorExpiry(anchor.expiry))}</td>
              <td>
                <div class="detail-stack">
                  <span>${escapeHtml(formatAnchorProvenance(anchor))}</span>
                  <span class="muted event-meta">${escapeHtml(anchor.set_at)}</span>
                </div>
              </td>
              <td class="numeric">${
                anchor.set_by_sequence === null
                  ? "n/a"
                  : formatInteger(anchor.set_by_sequence)
              }</td>
            </tr>`,
        )
        .join("");
}

function formatAnchorPlacement(
  placement: NonNullable<RuntimeSnapshot["anchors"]>[number]["placement"],
): string {
  return placement.kind === "top"
    ? "top"
    : `${placement.kind} ${placement.issue_identifier}`;
}

function formatAnchorExpiry(
  expiry: NonNullable<RuntimeSnapshot["anchors"]>[number]["expiry"],
): string {
  return expiry.kind === "until_merged" ? "until merged" : `until ${expiry.at}`;
}

function formatAnchorProvenance(
  anchor: NonNullable<RuntimeSnapshot["anchors"]>[number],
): string {
  const actor = anchor.provenance.actor;
  const actorLabel = `${actor.kind}@${actor.host}${
    actor.session === null ? "" : `#${actor.session}`
  }`;
  return [
    actorLabel,
    anchor.provenance.source,
    anchor.provenance.editor_email,
    anchor.provenance.field_name,
    anchor.provenance.reason.human,
  ]
    .filter((value): value is string => value !== null && value !== "")
    .join(" · ");
}

function renderHealthBadge(
  health: "green" | "yellow" | "red",
  healthReason: string | null,
): string {
  const label =
    health === "red"
      ? "🔴 Red"
      : health === "yellow"
        ? "🟡 Yellow"
        : "🟢 Green";
  const cssClass = `health-badge health-badge-${health}`;
  const title =
    healthReason !== null ? ` title="${escapeHtml(healthReason)}"` : "";
  return `<span class="${cssClass}"${title}><span class="health-badge-dot"></span>${escapeHtml(label)}</span>`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

function renderOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "normal":
      return '<span style="color: var(--accent-ink)">normal</span>';
    case "failed_to_start":
      return '<span style="color: var(--danger)">failed to start</span>';
    case "timed_out":
      return '<span style="color: var(--warning)">timed out</span>';
    case "error":
      return '<span style="color: var(--danger)">error</span>';
    default:
      return escapeHtml(outcome);
  }
}
