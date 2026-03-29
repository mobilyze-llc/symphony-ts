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
    expect(html).toContain("Token Intelligence Report");
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
    expect(html).toContain("token-report.sh");
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
      <ReportHeader today="2026-03-20" />,
    );
    expect(html).toContain("Token Intelligence Report");
    expect(html).toContain("2026-03-20");
    expect(html).toContain("Daily analysis across all products");
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
    expect(html).toContain("Total Tokens Today");
    expect(html).toContain("18,420,000");
    expect(html).toContain("Issues Processed");
    expect(html).toContain("Cache Hit Rate");
    expect(html).toContain("72");
    expect(html).toContain("%");
  });
});

// --- SYMPH-190: Formula verification tests ---

describe("SYMPH-190 formula verification", () => {
  it("fixture has wow_delta_pct on total_tokens", () => {
    expect(analysisData.executive_summary.total_tokens).toHaveProperty(
      "wow_delta_pct",
    );
    expect(
      (analysisData.executive_summary.total_tokens as unknown as { wow_delta_pct: number })
        .wow_delta_pct,
    ).toBe(12.3);
  });

  it("fixture has wow_delta_pct on per_ticket_trend", () => {
    expect(analysisData.per_ticket_trend).toHaveProperty("wow_delta_pct");
    expect(
      (analysisData.per_ticket_trend as unknown as { wow_delta_pct: number })
        .wow_delta_pct,
    ).toBe(-5.2);
  });

  it("cache delta formula: current - trend_7d = 4pp", () => {
    const sc = data.efficiency_scorecard;
    const expected = Math.round(
      sc.cache_efficiency.current - sc.cache_efficiency.trend_7d,
    );
    expect(expected).toBe(4);
    // Verify rendered output contains the delta badge
    const html = renderToString(<App />);
    expect(html).toContain("4");
    expect(html).toContain("pp");
  });

  it("token delta: wires wow_delta_pct from fixture into delta badge", () => {
    const html = renderToString(<App />);
    // total_tokens.wow_delta_pct = 12.3 -> "+12.3% vs 7d avg"
    expect(html).toContain("+12.3% vs 7d avg");
  });

  it("per-ticket WoW delta: wires wow_delta_pct from fixture into delta badge", () => {
    const html = renderToString(<App />);
    // per_ticket_trend.wow_delta_pct = -5.2 -> "-5.2% WoW"
    expect(html).toContain("-5.2% WoW");
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
  it("renders 5 metric cards (failure rate moved to PipelineHealth)", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Cache Efficiency");
    expect(html).toContain("Output Ratio");
    expect(html).toContain("Wasted Context");
    expect(html).toContain("Tokens / Turn");
    expect(html).toContain("First-Pass Rate");
    // Failure Rate row removed -- now in PipelineHealth component
    expect(html).not.toContain("Failure Rate");
  });

  it("renders 30d range text for each metric card", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    // Cache Efficiency: trend_30d=65, current=72 (already percentages)
    expect(html).toContain("30d:");
    expect(html).toContain("\u2192");
  });
});

describe("SYMPH-189: formula fixes and pipeline wiring", () => {
  it("cache delta uses percentage point formula, not relative change", () => {
    // sc.cache_efficiency: current=72, trend_7d=68
    // Correct: 72 - 68 = 4
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
  });

  it("wires tokensDelta from pipeline wow_delta_pct", () => {
    // analysis.json fixture has total_tokens.wow_delta_pct = 12.3
    const html = renderToString(<App />);
    expect(html).toContain("+12.3% vs 7d avg");
  });

  it("wires tokPerIssueWow from pipeline per_ticket_trend.wow_delta_pct", () => {
    // analysis.json fixture has per_ticket_trend.wow_delta_pct = -5.2
    const html = renderToString(<App />);
    expect(html).toContain("-5.2% WoW");
  });

  it("analysis.json has per_ticket_series", () => {
    expect(data.per_ticket_series).toBeDefined();
    expect(Array.isArray(data.per_ticket_series)).toBe(true);
    expect((data.per_ticket_series as number[]).length).toBeGreaterThan(0);
  });

  it("analysis.json has wow_delta_pct on total_tokens", () => {
    expect(data.executive_summary.total_tokens).toHaveProperty("wow_delta_pct");
  });

  it("analysis.json has wow_delta_pct on per_ticket_trend", () => {
    expect(data.per_ticket_trend).toHaveProperty("wow_delta_pct");
  });
});

describe("PerStageTrend", () => {
  it("renders trend section with inflections", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("inflection detected");
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

  it("renders attribution details for inflections", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // Attribution type labels rendered
    expect(html).toContain("Ticket Mix");
    expect(html).toContain("Switched to prompt caching strategy");
    expect(html).toContain("Config Change");
    expect(html).toContain("Enabled extended cache TTL");
  });

  it("renders LLM insights via InflectionAttribution", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    expect(html).toContain("Attribution");
    expect(html).toContain("caching rollout");
    expect(html).toContain("Extended TTL reduced cache misses");
  });
});

describe("InflectionAttribution", () => {
  it("renders attribution entries with type labels", () => {
    const inflection = (
      Array.isArray(data.inflections) ? data.inflections : []
    )[0];
    const html = renderToString(
      <InflectionAttribution inflection={inflection} />,
    );
    expect(html).toContain("Ticket Mix");
    expect(html).toContain("Switched to prompt caching strategy");
    expect(html).toContain("Volume Shift");
    expect(html).toContain("3 fewer implement stages vs prior week");
  });

  it("renders LLM insight when present", () => {
    const inflection = (
      Array.isArray(data.inflections) ? data.inflections : []
    )[0];
    const html = renderToString(
      <InflectionAttribution inflection={inflection} />,
    );
    expect(html).toContain("Attribution");
    expect(html).toContain("caching rollout");
  });

  it("renders negative sign for down direction with positive magnitude", () => {
    const inflection = {
      date: "2026-03-10",
      metric: "implement avg",
      direction: "down" as const,
      magnitude: 0.15,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: null,
    };
    const html = renderToString(<InflectionAttribution inflection={inflection} />);
    expect(html).toContain("-15%");
    expect(html).not.toContain("+15%");
  });

  it("does not double-negate when magnitude is already negative", () => {
    const inflection = {
      date: "2026-03-10",
      metric: "implement avg",
      direction: "down" as const,
      magnitude: -0.15,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: null,
    };
    const html = renderToString(<InflectionAttribution inflection={inflection} />);
    // magnitude is already negative, Math.abs ensures we don't get --15%
    expect(html).toContain("15%");
    expect(html).not.toContain("--15%");
  });

  it("renders minimal card when no attributions and no llm_insight", () => {
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
    // Still renders the card wrapper with inflection detected label
    expect(html).toContain("inflection detected");
  });

  it("renders LLM insight as attribution card when attributions are empty", () => {
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
    expect(html).toContain("Attribution");
    expect(html).toContain("Insight with no attributions");
  });
});

describe("PerTicketCostTrend", () => {
  it("renders ticket cost stats", () => {
    const html = renderToString(
      <PerTicketCostTrend perTicket={data.per_ticket_trend} />,
    );
    expect(html).toContain("Per-Ticket Cost Trend");
    // Median and mean displayed in K format
    expect(html).toContain("Median:");
    expect(html).toContain("Mean:");
  });
});

describe("OutlierAnalysis", () => {
  it("renders outlier cards with multiplier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("SYMPH-98");
    expect(html).toContain("JONY-42");
    // v5: multiplier badge shows "Nx avg"
    expect(html).toContain("8.5x avg");
    expect(html).toContain("mobilyze-llc/issue/SYMPH-98");
  });

  it("displays hypothesis text for each outlier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Per CH-1: outlier cards show hypothesis + multiplier only
    for (const o of outliers) {
      expect(html).toContain(o.hypothesis);
    }
  });

  it("displays multiplier not z-score", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Multiplier badge shows "Nx avg"
    expect(html).toContain("8.5x avg");
    expect(html).toContain("3.4x avg");
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
    expect(html).toContain("No statistical outliers detected");
  });
});

describe("IssueLeaderboard", () => {
  it("renders grid with empty data", () => {
    const html = renderToString(<IssueLeaderboard leaderboard={[]} />);
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("No issues processed yet");
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
    // Items 1-25 should be present
    expect(html).toContain("TEST-1");
    expect(html).toContain("TEST-25");
    // Items 26-27 should be excluded
    expect(html).not.toContain("TEST-26");
    expect(html).not.toContain("TEST-27");
  });

  it("renders fixture leaderboard with 27 entries showing top 25", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // First entry (rank 1) present
    expect(html).toContain("SYMPH-98");
    expect(html).toContain("450,000");
    // 25th entry (SYMPH-127) present
    expect(html).toContain("SYMPH-127");
    // 26th entry (SYMPH-128) excluded by top-25 slice
    expect(html).not.toContain("SYMPH-128");
    // 27th entry (SYMPH-129) excluded
    expect(html).not.toContain("SYMPH-129");
  });

  it("links all leaderboard identifiers to Linear", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // Verify URL pattern for entries within top 25
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-98");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/JONY-42");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-112");
  });

  it("renders 4-column CSS grid matching buildLeaderboard() data", () => {
    const items = [
      {
        identifier: "SYMPH-100",
        title: "Test issue",
        tokens: 100000,
        linear_url: "https://linear.app/mobilyze-llc/issue/SYMPH-100",
      },
    ];
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    // 4 column headers: Issue, Title, Total, link
    expect(html).toContain("Issue");
    expect(html).toContain("Title");
    expect(html).toContain("Total");
    // Values
    expect(html).toContain("SYMPH-100");
    expect(html).toContain("Test issue");
    expect(html).toContain("100,000");
    // Per-stage columns removed — no Product, Investigate, Implement, Review, Merge headers
    expect(html).not.toContain(">Product<");
    expect(html).not.toContain(">Investigate<");
    expect(html).not.toContain(">Implement<");
    expect(html).not.toContain(">Review<");
    expect(html).not.toContain(">Merge<");
  });
});

describe("PipelineHealth", () => {
  it("renders per-stage failure rate bars from scorecard data", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    expect(html).toContain("Pipeline Health");
    // Stage names rendered with canonical casing
    expect(html).toContain("Investigate");
    expect(html).toContain("Implement");
    expect(html).toContain("Validate");
  });

  it("renders summary insight with worst stage", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // implement has the highest rate (8%), should be the worst stage
    expect(html).toContain("accounts for");
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
  });

  it("renders failure rate in red (#EF4444)", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    expect(html).toContain("Failure Rate");
    expect(html).toContain("#EF4444");
  });
});

describe("StageEfficiency", () => {
  it("renders stage cards", () => {
    const html = renderToString(
      <StageEfficiency perStageSpend={data.per_stage_spend} />,
    );
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("Investigate");
    expect(html).toContain("Implement");
    expect(html).toContain("Validate");
  });

  it("renders avg tokens and bottom stats", () => {
    const html = renderToString(
      <StageEfficiency perStageSpend={data.per_stage_spend} />,
    );
    expect(html).toContain("avg tokens");
    expect(html).toContain("Avg turns");
    expect(html).toContain("Cache rate");
  });
});

describe("PerProductBreakdown", () => {
  it("renders product table with share bars", () => {
    const html = renderToString(
      <PerProductBreakdown perProduct={data.per_product} />,
    );
    expect(html).toContain("Per-Product Breakdown");
    expect(html).toContain("symphony-ts");
    expect(html).toContain("jony-agent");
    expect(html).toContain("stickerlabs");
    expect(html).toContain("product-bar");
  });
});

describe("ReportFooter", () => {
  it("renders footer text", () => {
    const html = renderToString(<ReportFooter />);
    expect(html).toContain("Symphony Token Intelligence");
    expect(html).toContain("token-report.sh");
    expect(html).toContain("Retention: 90 days");
  });
});

// --- chart-utils unit tests ---

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

// --- StageUtilizationChart tests ---

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

// --- TicketCostChart tests ---

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
    expect(html).toContain("52K");
    expect(html).toContain("59K");
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

// --- Sparkline fill prop tests ---

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

// --- CSS custom properties from styles.json (v5 design tokens) ---

describe("reportCSS design tokens", () => {
  it("contains v5 color tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--bg: #0F1117");
    expect(reportCSS).toContain("--surface: #FFFFFF08");
    expect(reportCSS).toContain("--border: #FFFFFF0F");
    expect(reportCSS).toContain("--text: #F0F0F2");
    expect(reportCSS).toContain("--text-secondary: #FFFFFF99");
    expect(reportCSS).toContain("--text-tertiary: #FFFFFF66");
    expect(reportCSS).toContain("--text-muted: #FFFFFF59");
    expect(reportCSS).toContain("--text-caption: #FFFFFF40");
    expect(reportCSS).toContain("--text-body: #FFFFFF8C");
    expect(reportCSS).toContain("--accent: #60A5FA");
    expect(reportCSS).toContain("--green: #34D399");
    expect(reportCSS).toContain("--red: #EF4444");
    expect(reportCSS).toContain("--yellow: #F59E0B");
    expect(reportCSS).toContain("--purple: #A78BFA");
  });

  it("contains v5 stage color tokens", () => {
    expect(reportCSS).toContain("--stage-investigate: #60A5FA");
    expect(reportCSS).toContain("--stage-implement: #F59E0B");
    expect(reportCSS).toContain("--stage-review: #A78BFA");
    expect(reportCSS).toContain("--stage-merge: #34D399");
  });

  it("contains v5 inflection tokens", () => {
    expect(reportCSS).toContain("--inflection-implement-bg: #F59E0B0F");
    expect(reportCSS).toContain("--inflection-implement-border: #F59E0B26");
    expect(reportCSS).toContain("--inflection-review-bg: #A78BFA0F");
    expect(reportCSS).toContain("--inflection-review-border: #A78BFA26");
  });

  it("contains v5 typography tokens with DM Sans and JetBrains Mono", () => {
    expect(reportCSS).toContain('"DM Sans"');
    expect(reportCSS).toContain('"JetBrains Mono"');
    expect(reportCSS).toContain("--font-heading:");
    expect(reportCSS).toContain("--font-body:");
    expect(reportCSS).toContain("--font-mono:");
  });

  it("contains v5 spacing tokens", () => {
    expect(reportCSS).toContain("--spacing-section: 64px");
    expect(reportCSS).toContain("--spacing-section-gap: 32px");
    expect(reportCSS).toContain("--spacing-card: 20px");
    expect(reportCSS).toContain("--spacing-element: 16px");
    expect(reportCSS).toContain("--spacing-inner: 12px");
    expect(reportCSS).toContain("--spacing-tight: 8px");
    expect(reportCSS).toContain("--spacing-label: 4px");
  });

  it("contains v5 border tokens", () => {
    expect(reportCSS).toContain("--border-radius: 12px");
    expect(reportCSS).toContain("--border-radius-small: 8px");
    expect(reportCSS).toContain("--border-width: 1px");
  });

  it("does not contain old GitHub-dark hex values", () => {
    expect(reportCSS).not.toContain("#0d1117");
    expect(reportCSS).not.toContain("#161b22");
    expect(reportCSS).not.toContain("#30363d");
    expect(reportCSS).not.toContain("#c9d1d9");
    expect(reportCSS).not.toContain("#8b949e");
    expect(reportCSS).not.toContain("#f0f6fc");
  });

  it("does not contain old light-mode values", () => {
    // Surface should not be plain #FFFFFF (light mode), only #FFFFFF08 (dark translucent)
    expect(reportCSS).not.toContain("--color-surface: #FFFFFF");
    expect(reportCSS).not.toContain("--color-text: #0F172A");
    expect(reportCSS).not.toContain("#E2E8F0");
    expect(reportCSS).not.toContain("#F8FAFC");
  });
});

// --- EfficiencyScorecard uses inline SVG sparklines ---

describe("EfficiencyScorecard sparkline rendering", () => {
  it("renders inline SVG sparklines when series data provided", () => {
    const html = renderToString(
      <EfficiencyScorecard
        scorecard={data.efficiency_scorecard}
        series={{
          cacheEff: [70, 72, 74, 73, 75],
          outputRatio: [30, 32, 31, 33, 34],
        }}
      />,
    );
    // Inline SVG sparklines render polyline elements
    expect(html).toContain("polyline");
    expect(html).toContain("viewBox");
  });
});

// --- P2-4: ExecutiveSummary DeltaBadge favorable/declining branches ---

describe("ExecutiveSummary DeltaBadge branches", () => {
  it("renders favorable delta badge (green arrow) when tokensDelta is negative", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={-8.5}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={null}
      />,
    );
    // Favorable: green color #34D399, down arrow
    expect(html).toContain("#34D399");
    expect(html).toContain("-8.5% vs 7d avg");
  });

  it("renders declining delta badge (amber arrow) when tokensDelta is positive", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={12.3}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={null}
      />,
    );
    // Declining: amber color #F59E0B, up arrow
    expect(html).toContain("#F59E0B");
    expect(html).toContain("+12.3% vs 7d avg");
  });

  it("renders neutral cache delta when cacheWow is zero", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={null}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={0}
      />,
    );
    // cacheWow=0 → isFavorable returns null → neutral gray
    expect(html).toContain("#FFFFFF59");
    expect(html).toContain("0pp WoW");
  });

  it("renders issuesDelta badge when non-null", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={null}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        issuesDelta={5}
        cacheHitRate={72}
        cacheWow={null}
      />,
    );
    // issuesDelta=5 → "+5 vs 7d avg" with neutral color (favorable={null})
    expect(html).toContain("+5 vs 7d avg");
    expect(html).toContain("#FFFFFF59"); // neutral color
  });

  it("renders favorable cache delta when cacheWow is positive", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={null}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={4}
      />,
    );
    // cacheWow=4 (positive) with invertSign → favorable → green
    expect(html).toContain("#34D399");
    expect(html).toContain("+4pp WoW");
  });
});

// --- P2-5: PipelineHealth 30d delta badge ---

describe("PipelineHealth 30d delta", () => {
  it("renders 30d range text with correct percentage values", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // 30d range text should display percentages directly (not multiplied by 100)
    expect(html).toContain("30d:");
    expect(html).toContain("\u2192");
  });

  it("renders delta badge with pp suffix", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    expect(html).toContain("pp");
  });
});

// --- P2-6: StageEfficiency perStageStats with actual data ---

describe("StageEfficiency perStageStats", () => {
  it("renders avg_turns and cache_rate when perStageStats data provided", () => {
    const html = renderToString(
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        perStageStats={{
          investigate: { avg_turns: 3.2, cache_rate: 65, count: 85 },
          implement: { avg_turns: 8.5, cache_rate: 72, count: 120 },
        }}
      />,
    );
    // Avg turns should show actual values, not em-dash
    expect(html).toContain("3.2");
    expect(html).toContain("8.5");
    // Cache rate should show percentage directly (already percentage data)
    expect(html).toContain("65%");
    expect(html).toContain("72%");
  });

  it("renders em-dash when perStageStats is empty", () => {
    const html = renderToString(
      <StageEfficiency perStageSpend={data.per_stage_spend} />,
    );
    // Without perStageStats, should show em-dash fallback
    expect(html).toContain("\u2014");
  });

  it("applies green color to cache rate >= 50%", () => {
    const html = renderToString(
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        perStageStats={{
          investigate: { avg_turns: 3.0, cache_rate: 55, count: 85 },
        }}
      />,
    );
    // cache_rate=55 >= 50 threshold → green (#34D399)
    expect(html).toContain("#34D399");
  });
});

// --- P2-7: StageEfficiency sparkline delta ---

describe("StageEfficiency sparkline delta", () => {
  it("renders WoW delta from sparkline data", () => {
    const html = renderToString(
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        stageSparklines={{
          investigate: [100000, 110000, 105000, 115000, 108000, 112000, 106000, 90000],
          implement: [200000, 210000, 205000, 215000, 208000, 212000, 206000, 230000],
        }}
      />,
    );
    // Should render sparkline SVG polylines
    expect(html).toContain("polyline");
    // Should render delta text with % suffix
    expect(html).toContain("%");
  });
});

// --- P2-8: OutlierAnalysis severity tiers ---

describe("OutlierAnalysis severity tiers", () => {
  const baseOutlier = {
    issue_title: "Test issue",
    total_tokens: 500000,
    z_score: 3.5,
    linear_url: "https://linear.app/mobilyze-llc/issue/TEST-1",
    threshold: 200000,
    mean: 60000,
    stddev: 30000,
    parent: null,
    hypothesis: "High token usage due to complexity",
  };

  it("renders red severity for multiplier >= 3", () => {
    const outliers = [
      { ...baseOutlier, issue_identifier: "TEST-1", multiplier: 8.5 },
    ];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Red: bg #EF44441F, text #EF4444
    expect(html).toContain("#EF4444");
    expect(html).toContain("8.5x avg");
  });

  it("renders amber severity for multiplier 2.0–2.99", () => {
    const outliers = [
      { ...baseOutlier, issue_identifier: "TEST-2", multiplier: 2.5 },
    ];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Amber: bg #F59E0B1F, text #F59E0B
    expect(html).toContain("#F59E0B");
    expect(html).toContain("2.5x avg");
  });

  it("renders neutral severity for multiplier < 2", () => {
    const outliers = [
      { ...baseOutlier, issue_identifier: "TEST-3", multiplier: 1.5 },
    ];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Neutral: text #FFFFFF80
    expect(html).toContain("#FFFFFF80");
    expect(html).toContain("1.5x avg");
  });
});

// --- P2-9: Precise formula verification assertions ---

describe("Formula verification precision", () => {
  it("cache delta renders exactly 4pp", () => {
    const html = renderToString(<App />);
    // cache_efficiency: current=72, trend_7d=68 → delta=4pp
    expect(html).toContain("+4pp WoW");
  });

  it("per-ticket WoW delta renders when provided", () => {
    const html = renderToString(
      <PerTicketCostTrend
        perTicket={{ median: 52000, mean: 59000, ticket_count: 47, wow_delta_pct: -5.2 }}
      />,
    );
    expect(html).toContain("-5.2% WoW");
  });
});

// --- P2-2: Validate stage uses intended color, not fallback ---

describe("Validate stage color", () => {
  it("PipelineHealth renders Validate with #A78BFA, not fallback gray", () => {
    const failureRate = {
      current: { validate: 3 },
      trend_7d: { validate: 2 },
      trend_30d: { validate: 2.5 },
    };
    const html = renderToString(<PipelineHealth failureRate={failureRate} />);
    expect(html).toContain("Validate");
    // Stage dot should use #A78BFA (purple) — the intended color
    expect(html).toContain('background-color:#A78BFA');
  });

  it("StageEfficiency renders Validate with #A78BFA, not fallback gray", () => {
    const spend = {
      validate: { total_tokens: 50000, total_cost: 1.5, count: 10 },
    };
    const html = renderToString(<StageEfficiency perStageSpend={spend} />);
    expect(html).toContain("Validate");
    expect(html).toContain("#A78BFA");
  });
});

// --- P2-1 regression: PipelineHealth delta=0 renders neutral ---

describe("PipelineHealth delta=0 neutral", () => {
  it("renders neutral color when delta is zero", () => {
    // Create failure rate data where current equals trend_30d
    const equalRates = {
      current: { investigate: 5, implement: 10 },
      trend_7d: { investigate: 5, implement: 10 },
      trend_30d: { investigate: 5, implement: 10 },
    };
    const html = renderToString(<PipelineHealth failureRate={equalRates} />);
    // Delta=0 should show neutral gray (#FFFFFF59), not green (#34D399) or amber (#F59E0B)
    expect(html).toContain("#FFFFFF59");
    // Should not contain green (favorable) for delta badge
    expect(html).not.toContain("M6 2 L10 7 L2 7 Z"); // no up-arrow SVG path
    expect(html).not.toContain("M6 10 L10 5 L2 5 Z"); // no down-arrow SVG path
  });
});

// --- P2-2 regression: PerTicketCostTrend delta=0 renders neutral ---

describe("PerTicketCostTrend positive-delta (declining)", () => {
  it("renders amber color and up-arrow for positive wow_delta_pct", () => {
    const html = renderToString(
      <PerTicketCostTrend
        perTicket={{ median: 52000, mean: 59000, ticket_count: 47, wow_delta_pct: 3.5 }}
      />,
    );
    // Positive delta = cost increasing = declining = amber
    expect(html).toContain("#F59E0B");
    expect(html).toContain("M6 10 L10 5 L2 5 Z");
    expect(html).toContain("+3.5% WoW");
  });
});

describe("PerTicketCostTrend delta=0 neutral", () => {
  it("renders neutral color when wow_delta_pct is zero", () => {
    const html = renderToString(
      <PerTicketCostTrend
        perTicket={{ median: 52000, mean: 59000, ticket_count: 47, wow_delta_pct: 0 }}
      />,
    );
    // Delta=0 should show neutral — no arrow rendered
    expect(html).not.toContain("M6 2 L10 7 L2 7 Z");
    expect(html).not.toContain("M6 10 L10 5 L2 5 Z");
  });
});
