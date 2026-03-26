import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
import {
  ChartSection,
  DataTable,
  Footer,
  Header,
  MetricsPanel,
} from "./components/index.ts";
import { fixtureData } from "./data/fixture.ts";

// ─── Section ordering ───

describe("Section ordering", () => {
  it("renders all 5 sections in correct order: header → metrics → table → chart → footer", () => {
    const html = renderToString(<App />);
    const headerIdx = html.indexOf("Agent Performance Dashboard");
    const metricsIdx = html.indexOf("Total Tasks");
    const tableIdx = html.indexOf("Agent Overview");
    const chartIdx = html.indexOf("Performance Over Time");
    const footerIdx = html.indexOf("Powered by");

    expect(headerIdx).toBeGreaterThan(-1);
    expect(metricsIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(-1);
    expect(chartIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(-1);

    expect(headerIdx).toBeLessThan(metricsIdx);
    expect(metricsIdx).toBeLessThan(tableIdx);
    expect(tableIdx).toBeLessThan(chartIdx);
    expect(chartIdx).toBeLessThan(footerIdx);
  });
});

// ─── Typography hierarchy ───

describe("Typography hierarchy", () => {
  it("heading fontSize (28) > subheading fontSize (18) > body fontSize (14)", () => {
    const html = renderToString(<App />);
    // Heading: 28px in header h1
    expect(html).toContain("font-size:28px");
    // Subheading: 18px in section h2
    expect(html).toContain("font-size:18px");
    // Body: 14px in various spans
    expect(html).toContain("font-size:14px");
  });

  it("uses Inter font family", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Inter");
  });

  it("uses monospace font family for code values", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Courier New");
  });
});

// ─── Dynamic props ───

describe("Dynamic props", () => {
  it("renders different data when given different props", () => {
    const defaultHtml = renderToString(<App />);
    const customHtml = renderToString(
      <App
        header={{
          title: "Custom Dashboard Title",
          lastUpdated: "2026-01-01 00:00",
          version: "9.9.9",
        }}
      />,
    );

    expect(defaultHtml).toContain("Agent Performance Dashboard");
    expect(defaultHtml).not.toContain("Custom Dashboard Title");

    expect(customHtml).toContain("Custom Dashboard Title");
    expect(customHtml).not.toContain("Agent Performance Dashboard");
    expect(customHtml).toContain("v9.9.9");
  });

  it("renders custom metrics data", () => {
    const html = renderToString(
      <App
        metricsPanel={{
          metrics: [
            { label: "Custom Metric", value: "999", delta: "+50%", trend: "up" as const },
          ],
        }}
      />,
    );
    expect(html).toContain("Custom Metric");
    expect(html).toContain("999");
  });
});

// ─── Content completeness ───

describe("Content completeness", () => {
  it("renders all static labels", () => {
    const html = renderToString(<App />);
    // Header area
    expect(html).toContain("Last updated:");
    // Metric labels
    expect(html).toContain("Total Tasks");
    expect(html).toContain("Avg Response");
    expect(html).toContain("Success Rate");
    expect(html).toContain("Active Agents");
    // Table headers
    expect(html).toContain("Agent");
    expect(html).toContain("Status");
    expect(html).toContain("Tasks");
    expect(html).toContain("Tokens");
    expect(html).toContain("Cost");
    expect(html).toContain("Last Run");
    expect(html).toContain("Trend");
    // Footer
    expect(html).toContain("Powered by");
  });

  it("renders all dynamic fixture values", () => {
    const html = renderToString(<App />);
    // Header
    expect(html).toContain("Agent Performance Dashboard");
    expect(html).toContain("2026-03-26 09:15");
    expect(html).toContain("v1.2.0");
    // Metrics
    expect(html).toContain("1,284");
    expect(html).toContain("94.7%");
    // Agents
    expect(html).toContain("claude-code");
    expect(html).toContain("gemini-pro");
    expect(html).toContain("codex-agent");
    expect(html).toContain("symphony-orchestrator");
    expect(html).toContain("review-bot");
    // Footer
    expect(html).toContain("Symphony");
    expect(html).toContain("2026");
  });
});

// ─── SVG chart presence ───

describe("SVG chart presence", () => {
  it("chart section renders SVG with path elements", () => {
    const html = renderToString(
      <ChartSection {...fixtureData.chartSection} />,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    expect(html).toContain("Performance multi-line chart");
  });

  it("data table renders sparkline polylines", () => {
    const html = renderToString(<DataTable {...fixtureData.dataTable} />);
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
  });

  it("chart section renders all 3 series in legend", () => {
    const html = renderToString(
      <ChartSection {...fixtureData.chartSection} />,
    );
    expect(html).toContain("claude-code");
    expect(html).toContain("gemini-pro");
    expect(html).toContain("symphony-orchestrator");
  });
});

// ─── Individual component tests ───

describe("Header", () => {
  it("renders title and metadata", () => {
    const html = renderToString(
      <Header title="Test Title" lastUpdated="2026-01-01" version="2.0.0" />,
    );
    expect(html).toContain("Test Title");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("v2.0.0");
  });
});

describe("MetricsPanel", () => {
  it("renders trend indicators", () => {
    const html = renderToString(
      <MetricsPanel
        metrics={[
          { label: "Up Metric", value: "100", delta: "+10%", trend: "up" },
          { label: "Down Metric", value: "50", delta: "-5%", trend: "down" },
          { label: "Flat Metric", value: "75", delta: "0%", trend: "flat" },
        ]}
      />,
    );
    expect(html).toContain("▲");
    expect(html).toContain("▼");
    expect(html).toContain("—");
    expect(html).toContain("#10B981"); // up color
    expect(html).toContain("#EF4444"); // down color
  });
});

describe("DataTable", () => {
  it("renders agent rows with status dots", () => {
    const html = renderToString(<DataTable {...fixtureData.dataTable} />);
    expect(html).toContain("claude-code");
    expect(html).toContain("342");
    expect(html).toContain("$18.20");
    // Status dot colors
    expect(html).toContain("#10B981"); // active
    expect(html).toContain("#EF4444"); // error
    expect(html).toContain("#64748B"); // idle
  });

  it("shows sort indicator on active column", () => {
    const html = renderToString(
      <DataTable {...fixtureData.dataTable} sortColumn="tasks" sortDirection="desc" />,
    );
    expect(html).toContain("↓");
  });
});

describe("Footer", () => {
  it("renders brand and year", () => {
    const html = renderToString(<Footer brand="TestBrand" year="2030" />);
    expect(html).toContain("TestBrand");
    expect(html).toContain("2030");
    expect(html).toContain("Powered by");
  });
});
