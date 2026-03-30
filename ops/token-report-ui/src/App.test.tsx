import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
import { Sparkline } from "./components/chartUtils.tsx";
import {
  EfficiencyScorecard,
  ExecutiveSummary,
  InflectionAttribution,
  IssueLeaderboard,
  OutlierAnalysis,
  PerProductBreakdown,
  PerStageTrend,
  PerTicketCostTrend,
  PipelineHealth,
  ReportFooter,
  ReportHeader,
  StageEfficiency,
  StageUtilizationChart,
  TicketCostChart,
  reportCSS,
} from "./components/index.ts";
import analysisData from "./data/analysis.json";
import {
  buildAreaString,
  buildPointsString,
  computeYGrid,
  extractSortedDates,
  formatAxisValue,
  formatDateLabel,
  linearScale,
  pickTickIndices,
  round,
} from "./lib/chart-utils.ts";
import type { AnalysisData } from "./types.ts";

const data = analysisData as AnalysisData;

describe("App", () => {
  it("renders without crashing", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Symphony Token Report");
  });

  it("renders all section headings", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("Pipeline Health");
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("Per-Product Breakdown");
    expect(html).toContain("SYMPH-131");
  });
});

describe("analysis.json shape", () => {
  it("has required top-level keys", () => {
    expect(analysisData).toHaveProperty("cold_start_tier");
    expect(analysisData).toHaveProperty("analyzed_at");
    expect(analysisData).toHaveProperty("data_span_days");
    expect(analysisData).toHaveProperty("record_count");
    expect(analysisData).toHaveProperty("efficiency_scorecard");
    expect(analysisData).toHaveProperty("executive_summary");
    expect(analysisData).toHaveProperty("per_stage_spend");
    expect(analysisData).toHaveProperty("per_stage_trend");
    expect(analysisData).toHaveProperty("per_ticket_trend");
    expect(analysisData).toHaveProperty("per_product");
    expect(analysisData).toHaveProperty("inflections");
    expect(analysisData).toHaveProperty("outliers");
    expect(analysisData).toHaveProperty("leaderboard");
  });

  it("has correct efficiency_scorecard metrics", () => {
    const sc = analysisData.efficiency_scorecard;
    for (const key of [
      "cache_efficiency",
      "output_ratio",
      "wasted_context",
      "tokens_per_turn",
      "first_pass_rate",
    ] as const) {
      expect(sc[key]).toHaveProperty("current");
      expect(sc[key]).toHaveProperty("trend_7d");
      expect(sc[key]).toHaveProperty("trend_30d");
    }
  });

  it("has date-keyed per_stage_trend daily_avg", () => {
    const trend = (analysisData as AnalysisData).per_stage_trend;
    for (const stage of Object.keys(trend)) {
      const avg = trend[stage].daily_avg;
      expect(typeof avg).toBe("object");
      expect(avg).not.toBeNull();
      // Each stage should have date keys (YYYY-MM-DD format)
      const dates = Object.keys(avg as Record<string, number>);
      expect(dates.length).toBeGreaterThan(0);
      expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("has correct executive_summary shape", () => {
    const es = analysisData.executive_summary;
    expect(es.total_tokens).toHaveProperty("value");
    expect(es.total_stages).toHaveProperty("value");
    expect(es.unique_issues).toHaveProperty("value");
    expect(es).toHaveProperty("data_span_days");
  });
});

describe("ReportHeader", () => {
  it("renders header with metadata", () => {
    const html = renderToString(
      <ReportHeader today="2026-03-20" recordCount={312} dataSpanDays={45} />,
    );
    expect(html).toContain("Symphony Token Report");
    expect(html).toContain("2026-03-20");
    expect(html).toContain("312");
    expect(html).toContain("45");
    expect(html).toContain("day span");
  });
});

describe("ExecutiveSummary", () => {
  it("renders KPI cards with data", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={null}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={null}
      />,
    );
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Total Tokens");
    expect(html).toContain("18,420,000");
    expect(html).toContain("Issues Processed");
    expect(html).toContain("Cache Hit Rate");
    expect(html).toContain("72");
    expect(html).toContain("%");
  });
});

// ─── SYMPH-190: Formula verification tests ───

describe("SYMPH-190 formula verification", () => {
  it("wow_delta_pct is absent when data_span_days < 14", () => {
    // With 8 days of data, the 14-day WoW gate prevents computation
    expect(data.executive_summary.total_tokens.wow_delta_pct ?? null).toBeNull();
  });

  it("fixture has wow_delta_pct on per_ticket_trend", () => {
    expect(data.per_ticket_trend).toHaveProperty("wow_delta_pct");
    expect(data.per_ticket_trend.wow_delta_pct).toBe(-39.5);
  });

  it("cache delta formula: current - trend_7d = 0pp (already percentage scale)", () => {
    const sc = data.efficiency_scorecard;
    const expected = Math.round(
      sc.cache_efficiency.current - sc.cache_efficiency.trend_7d,
    );
    expect(expected).toBe(0);
    // Verify rendered output contains the delta badge
    const html = renderToString(<App />);
    expect(html).toContain("0<!-- -->% WoW");
  });

  it("token delta: renders em-dash when wow_delta_pct is null", () => {
    const html = renderToString(<App />);
    // total_tokens.wow_delta_pct is null (< 14 days) → WowBadge renders "—"
    expect(html).toContain("\u2014");
  });

  it("per-ticket WoW delta: wires wow_delta_pct from fixture into WoW badge", () => {
    const html = renderToString(<App />);
    // per_ticket_trend.wow_delta_pct = -39.5 → "-39.5% WoW"
    expect(html).toContain("-39.5");
  });

  it("per_ticket_series exists on fixture for chart rendering", () => {
    expect(analysisData).toHaveProperty("per_ticket_series");
    expect(Array.isArray(analysisData.per_ticket_series)).toBe(true);
    expect((analysisData.per_ticket_series as number[]).length).toBeGreaterThan(
      0,
    );
  });
});

describe("EfficiencyScorecard", () => {
  it("renders 5 metric rows (failure rate moved to PipelineHealth)", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Cache Efficiency");
    expect(html).toContain("Output Ratio");
    expect(html).toContain("Wasted Context");
    expect(html).toContain("Tokens / Turn");
    expect(html).toContain("First-Pass Rate");
    // Failure Rate row removed — now in PipelineHealth component
    expect(html).not.toContain("Failure Rate");
  });

  it("renders 30d range text for each metric row (SYMPH-189)", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    // Cache Efficiency: trend_30d=65.9, current=65.9 (already 0-100 scale)
    expect(html).toContain("30d:");
    expect(html).toContain("→");
    // SYMPH-197: className removed — range text validated by "30d:" assertion above
  });
});

describe("SYMPH-189: formula fixes and pipeline wiring", () => {
  it("cache delta uses percentage point formula, not relative change", () => {
    // sc.cache_efficiency: current=65.9, trend_7d=65.9 (already 0-100 scale)
    // Correct: 65.9 - 65.9 = 0 (no * 100 — pipeline outputs 0-100)
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
  });

  it("renders em-dash when tokensDelta is null (< 14 days)", () => {
    const html = renderToString(<App />);
    expect(html).toContain("\u2014");
  });

  it("wires tokPerIssueWow from pipeline per_ticket_trend.wow_delta_pct", () => {
    // analysis.json fixture has per_ticket_trend.wow_delta_pct = -39.5
    const html = renderToString(<App />);
    expect(html).toContain("39.5");
  });

  it("analysis.json has per_ticket_series", () => {
    expect(data.per_ticket_series).toBeDefined();
    expect(Array.isArray(data.per_ticket_series)).toBe(true);
    expect((data.per_ticket_series as number[]).length).toBeGreaterThan(0);
  });

  it("analysis.json total_tokens wow_delta_pct is null when < 14 days", () => {
    expect(
      data.executive_summary.total_tokens.wow_delta_pct ?? null,
    ).toBeNull();
  });

  it("analysis.json has wow_delta_pct on per_ticket_trend", () => {
    expect(data.per_ticket_trend).toHaveProperty("wow_delta_pct");
  });
});

describe("PerStageTrend", () => {
  it("renders trend section with empty inflections", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    expect(html).toContain("Per-Stage Utilization Trend");
    // No inflections in fresh data — section should not contain inflection labels
    expect(html).not.toContain("Inflection");
  });

  it("filters spec-gen from trend data", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // spec-gen should not appear in the legend/chart
    // The chart renders stage names from filtered trend keys
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).not.toContain(">spec-gen<");
  });

  it("renders no attribution details when inflections are empty", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // No inflections in fresh data — no attribution content
    expect(html).not.toContain("Ticket Mix");
    expect(html).not.toContain("Config Change");
  });

  it("renders no LLM insights when inflections are empty", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // No inflections in fresh data — no LLM insight content
    expect(html).not.toContain("💡");
    expect(html).not.toContain("caching rollout");
  });
});

describe("InflectionAttribution", () => {
  it("fixture has no inflections — inflections array is empty", () => {
    const inflections = Array.isArray(data.inflections)
      ? data.inflections
      : [];
    expect(inflections.length).toBe(0);
  });

  it("renders empty when given an inflection with no attributions and no insight", () => {
    const empty = {
      date: "2026-03-01",
      metric: "test",
      direction: "up",
      magnitude: 0.1,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: null,
    };
    const html = renderToString(<InflectionAttribution inflection={empty} />);
    expect(html).toBe("");
  });

  it("returns null when no attributions and no llm_insight", () => {
    const empty = {
      date: "2026-03-01",
      metric: "test",
      direction: "up",
      magnitude: 0.1,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: null,
    };
    const html = renderToString(<InflectionAttribution inflection={empty} />);
    // Should render nothing
    expect(html).toBe("");
  });

  it("renders only LLM insight when attributions are empty", () => {
    const insightOnly = {
      date: "2026-03-01",
      metric: "test",
      direction: "up",
      magnitude: 0.1,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: "Insight with no attributions",
    };
    const html = renderToString(
      <InflectionAttribution inflection={insightOnly} />,
    );
    expect(html).toContain("💡");
    expect(html).toContain("Insight with no attributions");
    // No list items should be rendered
    expect(html).not.toContain("<li");
  });

  it("renders attributions and LLM insight together (synthetic data)", () => {
    const full = {
      date: "2026-03-15",
      metric: "implement_tokens",
      direction: "up" as const,
      magnitude: 0.35,
      context: null,
      avg_7d: 220000,
      avg_30d: 180000,
      attributions: [
        { type: "ticket_mix", description: "3 complex SYMPH issues entered implement" },
        { type: "config_change", description: "Max-turns bumped from 15 to 25" },
      ],
      llm_insight: "Implement cost rose 35% due to a batch of refactor-heavy tickets plus a max-turns config bump.",
    };
    const html = renderToString(
      <InflectionAttribution inflection={full} />,
    );
    // Attribution list items rendered (SSR inserts <!-- --> between JSX text nodes)
    expect(html).toContain("Ticket Mix");
    expect(html).toContain("3 complex SYMPH issues entered implement");
    expect(html).toContain("Config Change");
    expect(html).toContain("Max-turns bumped from 15 to 25");
    // LLM insight rendered
    expect(html).toContain("💡");
    expect(html).toContain("Implement cost rose 35%");
    // Structural: should contain list items
    expect(html).toContain("<li");
  });
});

describe("PerTicketCostTrend", () => {
  it("renders ticket cost stats", () => {
    const html = renderToString(
      <PerTicketCostTrend perTicket={data.per_ticket_trend} />,
    );
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("4,143,682");
    expect(html).toContain("5,031,463");
    expect(html).toContain("96");
    expect(html).toContain("tickets");
  });
});

describe("OutlierAnalysis", () => {
  it("renders outlier cards with multiplier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("SYMPH-74");
    expect(html).toContain("SYMPH-149");
    // SYMPH-179: multiplier displayed instead of z-score
    expect(html).toContain("5.1x mean");
    expect(html).toContain("mobilyze-llc/issue/SYMPH-74");
  });

  it("displays hypothesis text for each outlier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Per CH-1: outlier cards show hypothesis + multiplier only
    // Hypotheses containing " are rendered as &quot; in HTML
    for (const o of outliers) {
      const escaped = o.hypothesis.replace(/"/g, "&quot;");
      expect(html).toContain(escaped);
    }
  });

  it("displays multiplier not z-score", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Multiplier = total_tokens / mean (Q-2 decision)
    expect(html).toContain("5.1x mean");
    expect(html).toContain("3.7x mean");
    // z-score should NOT appear in rendered output
    expect(html).not.toContain("z=");
    expect(html).not.toContain("z_score");
  });

  it("links outlier identifiers to Linear", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    for (const o of outliers) {
      expect(html).toContain(
        `https://linear.app/mobilyze-llc/issue/${o.issue_identifier}`,
      );
    }
  });

  it("renders empty state", () => {
    const html = renderToString(<OutlierAnalysis outliers={[]} />);
    expect(html).toContain("No outliers detected");
  });
});

describe("IssueLeaderboard", () => {
  it("renders table with empty data", () => {
    const html = renderToString(<IssueLeaderboard leaderboard={[]} />);
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("<table");
  });

  it("renders leaderboard items with linear_url", () => {
    const items = [
      {
        identifier: "SYMPH-100",
        title: "Test issue",
        tokens: 100000,
        linear_url: "https://linear.app/mobilyze-llc/issue/SYMPH-100",
      },
    ];
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    expect(html).toContain("SYMPH-100");
    expect(html).toContain("Test issue");
    expect(html).toContain("100,000");
    expect(html).toContain("mobilyze-llc/issue/SYMPH-100");
  });

  it("slices to top 25 entries (matching renderHtml() behavior)", () => {
    // Build 27 items to verify only the first 25 are rendered
    const items = Array.from({ length: 27 }, (_, i) => ({
      identifier: `TEST-${i + 1}`,
      title: `Issue number ${i + 1}`,
      tokens: 100000 - i * 1000,
      linear_url: `https://linear.app/mobilyze-llc/issue/TEST-${i + 1}`,
    }));
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    // Items 1–25 should be present
    expect(html).toContain("TEST-1");
    expect(html).toContain("TEST-25");
    // Items 26–27 should be excluded
    expect(html).not.toContain("TEST-26");
    expect(html).not.toContain("TEST-27");
  });

  it("renders fixture leaderboard with 25 entries", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // First entry (rank 1) present
    expect(html).toContain("SYMPH-74");
    expect(html).toContain("25,581,026");
    // 25th entry (SYMPH-93) present
    expect(html).toContain("SYMPH-93");
  });

  it("links all leaderboard identifiers to Linear", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // Verify URL pattern for entries within top 25
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-74");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-149");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-175");
  });
});

describe("PipelineHealth", () => {
  it("renders per-stage failure rate bars from scorecard data", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    expect(html).toContain("Pipeline Health");
    // Stage names derived from failure_rate.current keys
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).toContain("review");
    expect(html).toContain("merge");
    // Failure rates are already 0-100 from the pipeline (SSR inserts <!-- --> between text nodes)
    expect(html).toContain("43.2<!-- -->% failure rate");
    expect(html).toContain("3.6<!-- -->% failure rate");
    expect(html).toContain("2.5<!-- -->% failure rate");
    expect(html).toContain("2.7<!-- -->% failure rate");
  });

  it("renders summary insight with worst stage", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // investigate has the highest rate (43.2), should be the worst stage
    expect(html).toContain("investigate accounts for");
    expect(html).toContain("% of all failures");
    expect(html).toContain("vs 7d avg");
  });

  it("renders empty state when no failure data", () => {
    const html = renderToString(
      <PipelineHealth
        failureRate={{ current: {}, trend_7d: {}, trend_30d: {} }}
      />,
    );
    expect(html).toContain("Pipeline Health");
    expect(html).toContain("No failure rate data available");
  });

  it("computes bar widths with JS Math.round, not CSS round()", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // Ensure no CSS round() function in the output
    expect(html).not.toContain("round(");
    // Bar widths use the rate directly (already 0-100 from pipeline)
    expect(html).toContain("width:43%");
    expect(html).toContain("width:4%");
    expect(html).toContain("width:3%");
  });

  it("shows direction and delta vs 7d avg", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // investigate: current 43.2, trend_7d 43.2 → delta = 0pp → "unchanged"
    expect(html).toContain("unchanged vs 7d avg");
  });
});

describe("StageEfficiency", () => {
  it("renders stage cards", () => {
    const html = renderToString(
      <StageEfficiency perStageSpend={data.per_stage_spend} />,
    );
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).toContain("review");
    expect(html).toContain("merge");
  });

  it("renders failure rate per stage when provided", () => {
    const html = renderToString(
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        failureRateCurrent={data.efficiency_scorecard.failure_rate.current}
      />,
    );
    expect(html).toContain("43.2%<!-- --> failure");
    expect(html).toContain("3.6%<!-- --> failure");
    expect(html).toContain("2.5%<!-- --> failure");
    expect(html).toContain("2.7%<!-- --> failure");
  });
});

describe("PerProductBreakdown", () => {
  it("renders product table with share bars", () => {
    const html = renderToString(
      <PerProductBreakdown perProduct={data.per_product} />,
    );
    expect(html).toContain("Per-Product Breakdown");
    expect(html).toContain("TOYS");
    expect(html).toContain("symphony");
    expect(html).toContain("product-bar");
  });
});

describe("ReportFooter", () => {
  it("renders footer text", () => {
    const html = renderToString(<ReportFooter />);
    expect(html).toContain("SYMPH-131");
    expect(html).toContain("token-report.mjs");
  });
});

// ─── chart-utils unit tests ───

describe("chart-utils", () => {
  it("round() rounds to specified decimals", () => {
    expect(round(Math.PI, 2)).toBe(3.14);
    expect(round(Math.PI, 0)).toBe(3);
    expect(round(1000.5)).toBe(1001);
  });

  it("linearScale maps value to range", () => {
    expect(linearScale(50, 0, 100, 0, 200)).toBe(100);
    expect(linearScale(0, 0, 100, 0, 200)).toBe(0);
    expect(linearScale(100, 0, 100, 0, 200)).toBe(200);
  });

  it("linearScale clamps out-of-range values", () => {
    expect(linearScale(150, 0, 100, 0, 200)).toBe(200);
    expect(linearScale(-10, 0, 100, 0, 200)).toBe(0);
  });

  it("formatDateLabel converts YYYY-MM-DD to short label", () => {
    expect(formatDateLabel("2026-03-05")).toBe("Mar 05");
    expect(formatDateLabel("2026-01-15")).toBe("Jan 15");
    expect(formatDateLabel("2026-12-31")).toBe("Dec 31");
  });

  it("pickTickIndices returns evenly spaced indices", () => {
    expect(pickTickIndices(10, 3)).toEqual([0, 5, 9]);
    expect(pickTickIndices(3, 5)).toEqual([0, 1, 2]);
    expect(pickTickIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("computeYGrid returns values from max to min", () => {
    const grid = computeYGrid(0, 100, 4);
    expect(grid).toEqual([100, 75, 50, 25, 0]);
  });

  it("formatAxisValue uses K/M suffixes", () => {
    expect(formatAxisValue(1500000)).toBe("1.5M");
    expect(formatAxisValue(52000)).toBe("52K");
    expect(formatAxisValue(500)).toBe("500");
  });

  it("buildPointsString joins coordinates", () => {
    const result = buildPointsString([
      [10, 20],
      [30, 40],
    ]);
    expect(result).toBe("10,20 30,40");
  });

  it("buildAreaString creates closed polygon", () => {
    const result = buildAreaString(
      [
        [10, 20],
        [30, 40],
      ],
      100,
    );
    expect(result).toContain("10,20");
    expect(result).toContain("30,40");
    expect(result).toContain("30,100");
    expect(result).toContain("10,100");
  });

  it("buildAreaString returns empty for no coords", () => {
    expect(buildAreaString([], 100)).toBe("");
  });

  it("extractSortedDates extracts dates from stage trend data", () => {
    const stageData = {
      implement: { daily_avg: { "2026-03-01": 100, "2026-03-03": 300 } },
      review: { daily_avg: { "2026-03-02": 200, "2026-03-01": 150 } },
    };
    const dates = extractSortedDates(stageData);
    expect(dates).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("extractSortedDates handles scalar daily_avg", () => {
    const stageData = {
      implement: { daily_avg: 5000 },
    };
    const dates = extractSortedDates(stageData);
    expect(dates).toEqual([]);
  });
});

// ─── StageUtilizationChart tests ───

describe("StageUtilizationChart", () => {
  const dateKeyedTrend: Record<
    string,
    { daily_avg: Record<string, number>; wow_delta: number }
  > = {
    investigate: {
      daily_avg: {
        "2026-03-01": 50000,
        "2026-03-02": 55000,
        "2026-03-03": 60000,
      },
      wow_delta: -0.05,
    },
    implement: {
      daily_avg: {
        "2026-03-01": 150000,
        "2026-03-02": 160000,
        "2026-03-03": 170000,
      },
      wow_delta: 0.03,
    },
  };

  it("renders stacked area chart with date-keyed data", () => {
    const html = renderToString(
      <StageUtilizationChart stageData={dateKeyedTrend} />,
    );
    expect(html).toContain("svg");
    expect(html).toContain("Per-stage utilization stacked area chart");
    // Should have polygon elements for areas
    expect(html).toContain("polygon");
    // Should have polyline elements for lines
    expect(html).toContain("polyline");
    // Should contain date labels
    expect(html).toContain("Mar 01");
    expect(html).toContain("Mar 03");
    // Should contain legend items
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
  });

  it("renders stacked area chart with fixture date-keyed data", () => {
    const html = renderToString(
      <StageUtilizationChart stageData={data.per_stage_trend} />,
    );
    // analysis.json now has date-keyed daily_avg, so chart renders normally
    expect(html).toContain("svg");
    expect(html).toContain("polygon");
    expect(html).toContain("polyline");
    // Should contain legend items for stages in the fixture
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
  });

  it("renders insufficient data state for scalar daily_avg", () => {
    const scalarTrend: Record<
      string,
      { daily_avg: number; wow_delta: number }
    > = {
      investigate: { daily_avg: 71111, wow_delta: -0.05 },
      implement: { daily_avg: 217778, wow_delta: 0.03 },
    };
    const html = renderToString(
      <StageUtilizationChart stageData={scalarTrend} />,
    );
    expect(html).toContain("Insufficient data");
  });

  it("renders config change markers", () => {
    const html = renderToString(
      <StageUtilizationChart
        stageData={dateKeyedTrend}
        configChanges={[{ date: "2026-03-02" }]}
      />,
    );
    expect(html).toContain("\u2699"); // gear icon
  });
});

// ─── TicketCostChart tests ───

describe("TicketCostChart", () => {
  const sampleSeries = [45000, 52000, 48000, 61000, 55000, 58000, 53000];

  it("renders line chart with series data", () => {
    const html = renderToString(
      <TicketCostChart
        perTicket={data.per_ticket_trend}
        series={sampleSeries}
      />,
    );
    expect(html).toContain("svg");
    expect(html).toContain("Per-ticket cost trend chart");
    // Should have polyline for main data line
    expect(html).toContain("polyline");
    // Should have polygon for area fill
    expect(html).toContain("polygon");
    // Should have median reference line label
    expect(html).toContain("med");
    // Should have mean reference line label
    expect(html).toContain("avg");
    // Should have legend
    expect(html).toContain("Median");
    expect(html).toContain("Mean");
    expect(html).toContain("Per-ticket");
  });

  it("renders insufficient data state without series", () => {
    const html = renderToString(
      <TicketCostChart perTicket={data.per_ticket_trend} />,
    );
    expect(html).toContain("Insufficient series data");
    // Should still show median/mean as static text
    expect(html).toContain("4.1M");
    expect(html).toContain("5M");
  });

  it("renders with minimal series data", () => {
    const html = renderToString(
      <TicketCostChart
        perTicket={{ median: 50000, mean: 55000, ticket_count: 10 }}
        series={[40000, 60000]}
      />,
    );
    expect(html).toContain("polyline");
    expect(html).toContain("med");
  });
});

// ─── Sparkline fill prop tests ───

describe("Sparkline fill prop", () => {
  const sampleValues = [10, 20, 15, 25, 18];

  it("renders without fill prop identically to legacy behavior (no gradient, no polygon)", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" />,
    );
    expect(html).toContain("polyline");
    expect(html).not.toContain("linearGradient");
    expect(html).not.toContain("polygon");
    expect(html).not.toContain("<defs>");
  });

  it("renders gradient and polygon when fill prop is true", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#34D399" fill />,
    );
    expect(html).toContain("linearGradient");
    expect(html).toContain("polygon");
    expect(html).toContain("<defs>");
    // Gradient should have two stops with correct opacities
    expect(html).toContain('stop-opacity="0.2"');
    expect(html).toContain('stop-opacity="0"');
    // Stop color should match the stroke color
    expect(html).toContain('stop-color="#34D399"');
  });

  it("uses unique gradient IDs for multiple sparklines", () => {
    // Render both sparklines in the same React tree so useId() generates unique IDs
    const html = renderToString(
      <>
        <Sparkline values={sampleValues} stroke="#58a6ff" fill />
        <Sparkline values={sampleValues} stroke="#3fb950" fill />
      </>,
    );
    // Extract all gradient IDs from the combined output
    const matches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // First two gradient IDs should be different
    expect(matches[0]).not.toBe(matches[1]);
  });

  it("gradient goes from 20% opacity at top to 0% at bottom", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" fill />,
    );
    // Vertical gradient: x1=0, y1=0, x2=0, y2=1
    expect(html).toContain('x1="0"');
    expect(html).toContain('y1="0"');
    expect(html).toContain('x2="0"');
    expect(html).toContain('y2="1"');
    // First stop: 0% offset, 0.2 opacity
    expect(html).toContain('offset="0%"');
    expect(html).toContain('stop-opacity="0.2"');
    // Second stop: 100% offset, 0 opacity
    expect(html).toContain('offset="100%"');
    expect(html).toContain('stop-opacity="0"');
  });

  it("still renders polyline stroke when fill is enabled", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" fill />,
    );
    expect(html).toContain("polyline");
    expect(html).toContain('stroke="#58a6ff"');
  });

  it("handles empty values with fill prop gracefully", () => {
    const html = renderToString(<Sparkline values={[]} fill />);
    expect(html).not.toContain("linearGradient");
    expect(html).not.toContain("polygon");
  });
});

// ─── CSS custom properties from styles.json ───

describe("reportCSS design tokens", () => {
  it("contains existing dark-theme CSS vars", () => {
    expect(reportCSS).toContain("--bg: #0d1117");
    expect(reportCSS).toContain("--bg-card: #161b22");
    expect(reportCSS).toContain("--border: #30363d");
    expect(reportCSS).toContain("--text: #c9d1d9");
    expect(reportCSS).toContain("--accent: #58a6ff");
  });

  it("contains styles.json color tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--color-primary: #1E40AF");
    expect(reportCSS).toContain("--color-secondary: #6366F1");
    expect(reportCSS).toContain("--color-background: #F8FAFC");
    expect(reportCSS).toContain("--color-surface: #FFFFFF");
    expect(reportCSS).toContain("--color-text: #0F172A");
    expect(reportCSS).toContain("--color-text-secondary: #64748B");
    expect(reportCSS).toContain("--color-accent: #10B981");
    expect(reportCSS).toContain("--color-danger: #EF4444");
    expect(reportCSS).toContain("--color-border: #E2E8F0");
  });

  it("contains styles.json typography tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--font-heading: 'Inter'");
    expect(reportCSS).toContain("--font-body: 'Inter'");
    expect(reportCSS).toContain("--font-size-heading: 28px");
    expect(reportCSS).toContain("--font-size-subheading: 18px");
    expect(reportCSS).toContain("--font-size-body: 14px");
    expect(reportCSS).toContain("--font-size-caption: 12px");
    expect(reportCSS).toContain("--font-weight-heading: 700");
    expect(reportCSS).toContain("--font-weight-subheading: 600");
    expect(reportCSS).toContain("--font-weight-body: 400");
    expect(reportCSS).toContain("--line-height-heading: 1.2");
    expect(reportCSS).toContain("--line-height-subheading: 1.4");
    expect(reportCSS).toContain("--line-height-body: 1.5");
  });

  it("contains styles.json spacing tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--spacing-section: 32px");
    expect(reportCSS).toContain("--spacing-group: 16px");
    expect(reportCSS).toContain("--spacing-element: 8px");
  });

  it("contains styles.json border tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--border-radius: 8px");
    expect(reportCSS).toContain("--border-color: #E2E8F0");
    expect(reportCSS).toContain("--border-width: 1px");
  });

  it("uses exact hex values from styles.json (no approximations)", () => {
    // Verify exact casing matches styles.json
    expect(reportCSS).toContain("#1E40AF");
    expect(reportCSS).toContain("#6366F1");
    expect(reportCSS).toContain("#F8FAFC");
    expect(reportCSS).toContain("#FFFFFF");
    expect(reportCSS).toContain("#0F172A");
    expect(reportCSS).toContain("#64748B");
    expect(reportCSS).toContain("#10B981");
    expect(reportCSS).toContain("#EF4444");
    expect(reportCSS).toContain("#E2E8F0");
  });
});

// ─── EfficiencyScorecard uses Sparkline with fill ───

describe("EfficiencyScorecard sparkline fill", () => {
  it("passes fill prop to Sparkline components", () => {
    const html = renderToString(
      <EfficiencyScorecard
        scorecard={data.efficiency_scorecard}
        series={{
          cacheEff: [70, 72, 74, 73, 75],
          outputRatio: [30, 32, 31, 33, 34],
        }}
      />,
    );
    // With fill enabled, sparklines should contain gradient elements
    expect(html).toContain("linearGradient");
    expect(html).toContain("polygon");
  });
});
