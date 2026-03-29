import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-dashboard.html", () => {
  const htmlPath = resolve(
    import.meta.dirname,
    "../../.symphony/reports/mobile-dashboard.html",
  );
  const html = readFileSync(htmlPath, "utf-8");

  it("is a valid HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes viewport meta with viewport-fit=cover", () => {
    expect(html).toContain("viewport-fit=cover");
  });

  it("loads Inter and JetBrains Mono from Google Fonts", () => {
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("Inter");
    expect(html).toContain("JetBrains+Mono");
  });

  it("respects safe-area-inset CSS environment variables", () => {
    expect(html).toContain("env(safe-area-inset-top)");
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain("env(safe-area-inset-left)");
    expect(html).toContain("env(safe-area-inset-right)");
  });

  it("auto-connects using window.location.hostname and localStorage port", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("window.location.hostname");
    expect(scriptSection).toContain("symphony_port");
    expect(scriptSection).toContain("4321");
    // No port overlay blocking the UI
    expect(html).not.toContain('id="port-overlay"');
  });

  it("includes pipeline home screen elements", () => {
    // Status bar counts
    expect(html).toContain("count-running");
    expect(html).toContain("count-retrying");
    expect(html).toContain("count-completed");
    expect(html).toContain("count-failed");
    // Issue card rendering
    expect(html).toContain("issue-card");
    expect(html).toContain("issue-title");
    // Retry section
    expect(html).toContain("retry-card");
  });

  it("includes issue detail screen elements", () => {
    // Stage breakdown bar
    expect(html).toContain("stage-bar");
    expect(html).toContain("stage-bar-segment");
    // Live metrics
    expect(html).toContain("metrics-grid");
    expect(html).toContain("metric-card");
    // Activity feed
    expect(html).toContain("activity-section");
    expect(html).toContain("activity-item");
    // Linear deep link with workspace slug
    expect(html).toContain("linear.app/mobilyze-llc/issue");
    // No bare linear.app/issue/ without workspace
    expect(html).not.toMatch(/linear\.app\/issue\//);
  });

  it("includes reports tab", () => {
    expect(html).toContain("screen-reports");
    expect(html).toContain("reports-content");
    expect(html).toContain("report-item");
  });

  it("uses SSE EventSource for live updates", () => {
    expect(html).toContain("EventSource");
    expect(html).toContain("/api/v1/events");
  });

  it("uses dark theme with Linear-inspired colors", () => {
    expect(html).toContain("color-scheme: dark");
    // Linear accent purple
    expect(html).toContain("#5e6ad2");
  });

  it("has hold-to-confirm for destructive stop action (2 seconds)", () => {
    expect(html).toContain("hold-btn");
    expect(html).toContain("hold-to-confirm");
    // 2 second hold duration
    expect(html).toMatch(
      /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*2000\s*\)/s,
    );
  });

  it("has CORS-compatible Access-Control-Allow-Origin: * pattern noted", () => {
    // The dashboard connects to servers that set CORS: *, it does not set its own
    // Verify it does not hardcode a specific origin
    expect(html).not.toContain("Access-Control-Allow-Origin");
  });

  it("does not hardcode localhost in connection logic", () => {
    // Auto-connect uses window.location.hostname, not hardcoded localhost
    const scriptSection = html.slice(html.indexOf("<script>"));
    // Ensure no hardcoded fetch URLs to localhost
    expect(scriptSection).not.toMatch(/fetch\s*\(\s*['"]https?:\/\/localhost/);
    expect(scriptSection).not.toMatch(
      /fetch\s*\(\s*['"]https?:\/\/127\.0\.0\.1/,
    );
    // EventSource should use baseUrl variable, not hardcoded
    expect(scriptSection).toContain("${baseUrl}/api/v1/events");
  });

  it("includes 4-tab navigation bar (pipeline, queue, deploy, reports)", () => {
    expect(html).toContain('data-tab="pipeline"');
    expect(html).toContain('data-tab="queue"');
    expect(html).toContain('data-tab="deploy"');
    expect(html).toContain('data-tab="reports"');
    expect(html).toContain("tab-bar");
  });

  it("includes queue screen with sections for alerts, in-queue, merged, rejected", () => {
    expect(html).toContain("screen-queue");
    expect(html).toContain("queue-content");
    expect(html).toContain("queue-badge-alert");
    expect(html).toContain("queue-badge-queued");
    expect(html).toContain("queue-badge-merged");
    expect(html).toContain("queue-badge-rejected");
  });

  it("fetches queue data from /api/v1/github/queue", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("/api/v1/github/queue");
    // Uses recently_merged field
    expect(scriptSection).toContain("recently_merged");
  });

  it("includes deploy screen with preview, version display, and output", () => {
    expect(html).toContain("screen-deploy");
    expect(html).toContain("deploy-content");
    expect(html).toContain("deploy-version-card");
    expect(html).toContain("deploy-output");
    expect(html).toContain("deploy-status-banner");
  });

  it("fetches deploy preview from POST /api/v1/deploy/preview", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("/api/v1/deploy/preview");
    expect(scriptSection).toContain("method: 'POST'");
  });

  it("shows warning when issues are running during deploy", () => {
    expect(html).toContain("deploy-warning");
    expect(html).toContain("running_issues_count");
  });

  it("executes deploy via POST fetch with ReadableStream", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("deploy_output");
    expect(scriptSection).toContain("deploy_complete");
    expect(scriptSection).toContain("/api/v1/deploy");
    // Uses fetch POST, not EventSource for deploy
    expect(scriptSection).toMatch(/fetch\(`\$\{baseUrl\}\/api\/v1\/deploy`.*method.*POST/s);
    expect(scriptSection).not.toMatch(/new EventSource.*deploy/);
  });

  it("includes stop confirmation bottom sheet", () => {
    expect(html).toContain("stop-sheet");
    expect(html).toContain("bottom-sheet");
    expect(html).toContain("stop-checklist");
    expect(html).toContain("stop-sheet-btn");
  });

  it("stop bottom sheet uses hold-to-confirm pattern", () => {
    expect(html).toContain("Hold to Confirm Stop");
    expect(html).toContain("wireHoldToConfirm");
  });

  it("stop shows simple success/failure result without data.steps", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("stop-check-icon");
    expect(scriptSection).toContain("success");
    expect(scriptSection).toContain("failed");
    // No fake data.steps array
    expect(scriptSection).not.toContain("data.steps");
  });

  it("deploy uses hold-to-confirm pattern", () => {
    expect(html).toContain("deploy-btn");
    expect(html).toContain("Hold to Deploy");
  });

  it("never deploys without showing preview first", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("preview has not loaded");
  });

  it("never auto-retries a failed stop action", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).not.toMatch(/stopIssue.*retry/i);
  });

  it("handles queue/deploy 404 gracefully", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("resp.status === 404");
  });

  it("includes parent spec link rendering in detail views", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("Parent Spec");
    expect(scriptSection).toContain("parent_url");
  });

  it("report links use port 8090 on the current host", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("8090");
    expect(scriptSection).toMatch(/window\.location\.hostname.*8090|8090.*window\.location\.hostname/s);
  });
});
