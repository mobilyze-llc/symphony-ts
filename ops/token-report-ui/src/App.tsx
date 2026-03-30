import {
  ColdStartBanner,
  EfficiencyScorecard,
  ExecutiveSummary,
  IssueLeaderboard,
  OutlierAnalysis,
  PerProductBreakdown,
  PerStageTrend,
  PerTicketCostTrend,
  PipelineHealth,
  ReportFooter,
  ReportHeader,
  StageEfficiency,
  reportCSS,
} from "./components/index.ts";
import analysisData from "./data/analysis.json";
import type {
  AnalysisData,
  DailySeries,
  Inflection,
  Outlier,
} from "./types.ts";

const data = analysisData as AnalysisData;
const isColdStart = data.cold_start === true && data.data_span_days < 7;

/** Normalize inflections/outliers from the dual union shape. */
function normalizeInflections(raw: AnalysisData["inflections"]): Inflection[] {
  if (Array.isArray(raw)) return raw;
  return raw?.items ?? [];
}

function normalizeOutliers(raw: AnalysisData["outliers"]): Outlier[] {
  if (Array.isArray(raw)) return raw;
  return raw?.items ?? [];
}

/**
 * Build the DailySeries for EfficiencyScorecard sparklines.
 * Ported from renderHtml(): prefers MetricWithTrend.series on each scorecard
 * metric (populated by buildDailyMetricSeries()), falling back to the
 * top-level daily_series object for backward compatibility.
 */
function buildScorecardSeries(
  sc: AnalysisData["efficiency_scorecard"],
  fallback?: DailySeries,
): DailySeries {
  return {
    cacheEff: sc.cache_efficiency?.series ?? fallback?.cacheEff,
    outputRatio: sc.output_ratio?.series ?? fallback?.outputRatio,
    wastedCtx: sc.wasted_context?.series ?? fallback?.wastedCtx,
    tokPerTurn: sc.tokens_per_turn?.series ?? fallback?.tokPerTurn,
    firstPass: sc.first_pass_rate?.series ?? fallback?.firstPass,
    failureRate: fallback?.failureRate,
  };
}

export default function App() {
  const es = data.executive_summary;
  const sc = data.efficiency_scorecard;
  const inflections = normalizeInflections(data.inflections);
  const outliers = normalizeOutliers(data.outliers);

  // Compute derived ExecutiveSummary props from raw analysis.json
  const totalTokens = es.total_tokens.value;
  const tokensPerIssueMedian = data.per_ticket_trend.median;
  const tokensPerIssueMean = data.per_ticket_trend.mean;
  const uniqueIssues = es.unique_issues.value;
  const cacheHitRate = sc.cache_efficiency.current ?? 0;

  // Cache delta: percentage point difference (SYMPH-189)
  const cacheWow =
    sc.cache_efficiency.trend_7d != null
      ? Math.round(sc.cache_efficiency.current - sc.cache_efficiency.trend_7d)
      : null;

  // Build series from MetricWithTrend.series, falling back to daily_series (SYMPH-175)
  const series = buildScorecardSeries(sc, data.daily_series);

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: report CSS is a static build-time string, not user input */}
      <style dangerouslySetInnerHTML={{ __html: reportCSS }} />
      <ReportHeader
        today={data.analyzed_at.slice(0, 10)}
        recordCount={data.record_count}
        dataSpanDays={data.data_span_days}
      />
      {isColdStart && (
        <ColdStartBanner
          dataSpanDays={data.data_span_days}
          message={data.message}
        />
      )}
      <ExecutiveSummary
        totalTokens={totalTokens}
        tokensDelta={es.total_tokens.wow_delta_pct ?? null}
        tokensPerIssueMedian={tokensPerIssueMedian}
        tokensPerIssueMean={tokensPerIssueMean}
        tokPerIssueWow={data.per_ticket_trend.wow_delta_pct ?? null}
        uniqueIssues={uniqueIssues}
        cacheHitRate={cacheHitRate}
        cacheWow={cacheWow}
      />
      <EfficiencyScorecard
        scorecard={sc}
        series={series}
        coldStart={isColdStart}
      />
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      <PerTicketCostTrend
        perTicket={data.per_ticket_trend}
        perTicketSeries={data.per_ticket_series}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      <OutlierAnalysis
        outliers={outliers}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      <IssueLeaderboard leaderboard={data.leaderboard ?? []} />
      <PipelineHealth failureRate={sc.failure_rate} />
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        failureRateCurrent={sc.failure_rate?.current}
      />
      <PerProductBreakdown perProduct={data.per_product} />
      <ReportFooter />
    </>
  );
}
