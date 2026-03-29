import type {
  EfficiencyScorecard as EfficiencyScorecardData,
  MetricWithTrend,
} from "../types.ts";
import { round } from "../lib/chart-utils.ts";
import { fmtNum } from "./chartUtils.tsx";

/**
 * Format a metric value as a percentage string.
 * Scorecard metrics are stored as raw percentages (72 = 72%).
 */
function formatPct(value: number): string {
  return `${round(value, 1)}%`;
}

export interface ScorecardSeries {
  cacheEff?: number[];
  outputRatio?: number[];
  wastedCtx?: number[];
  tokPerTurn?: number[];
  firstPass?: number[];
}

export interface EfficiencyScorecardProps {
  scorecard: EfficiencyScorecardData;
  series?: ScorecardSeries;
  coldStart?: boolean;
}

/**
 * Build range text: "30d: {formatPct(trend_30d)} -> {formatPct(current)}"
 */
function rangeText(
  metric: MetricWithTrend | undefined,
  isTokenCount?: boolean,
): string | null {
  if (!metric || metric.trend_30d == null || metric.current == null)
    return null;
  if (isTokenCount) {
    return `30d: ${fmtNum(metric.trend_30d)} \u2192 ${fmtNum(metric.current)}`;
  }
  return `30d: ${formatPct(metric.trend_30d)} \u2192 ${formatPct(metric.current)}`;
}

/**
 * Determine delta direction for a metric.
 * For most efficiency metrics: lower = better (wasted context, tokens/turn).
 * For cache efficiency, output ratio, first-pass rate: higher = better.
 * Returns: 'favorable' | 'declining' | null
 */
function getDeltaDirection(
  metric: MetricWithTrend | undefined,
  higherIsBetter: boolean,
): "favorable" | "declining" | null {
  if (!metric || metric.trend_7d == null) return null;
  const delta = metric.current - metric.trend_7d;
  if (delta === 0) return null;
  if (higherIsBetter) return delta > 0 ? "favorable" : "declining";
  return delta < 0 ? "favorable" : "declining";
}

function formatDelta(
  metric: MetricWithTrend | undefined,
  isTokenCount?: boolean,
): string | null {
  if (!metric || metric.trend_7d == null) return null;
  const delta = metric.current - metric.trend_7d;
  if (isTokenCount) {
    const pct = metric.trend_7d !== 0 ? (delta / metric.trend_7d) * 100 : 0;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${round(pct, 1)}%`;
  }
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${round(delta, 1)}pp`;
}

const cardStyle: React.CSSProperties = {
  backgroundColor: "#FFFFFF08",
  borderColor: "#FFFFFF0F",
  borderRadius: "12px",
  borderStyle: "solid",
  borderWidth: "1px",
  boxSizing: "border-box",
  display: "flex",
  flexBasis: "0%",
  flexDirection: "column",
  flexGrow: 1,
  flexShrink: 1,
  gap: "12px",
  paddingBlock: "20px",
  paddingInline: "20px",
};

export default function EfficiencyScorecard({
  scorecard,
  series,
  coldStart,
}: EfficiencyScorecardProps) {
  const sc = scorecard ?? ({} as Partial<EfficiencyScorecardData>);
  const s = series ?? {};

  const rows = [
    {
      name: "Cache Efficiency",
      metric: sc.cache_efficiency,
      value: `${round(sc.cache_efficiency?.current ?? 0, 1)}%`,
      sparkline: s.cacheEff,
      range: rangeText(sc.cache_efficiency),
      higherIsBetter: true,
      isTokenCount: false,
    },
    {
      name: "Output Ratio",
      metric: sc.output_ratio,
      value: `${round(sc.output_ratio?.current ?? 0, 1)}%`,
      sparkline: s.outputRatio,
      range: rangeText(sc.output_ratio),
      higherIsBetter: true,
      isTokenCount: false,
    },
    {
      name: "Wasted Context",
      metric: sc.wasted_context,
      value: `${round(sc.wasted_context?.current ?? 0, 1)}%`,
      sparkline: s.wastedCtx,
      range: rangeText(sc.wasted_context),
      higherIsBetter: false,
      isTokenCount: false,
    },
    {
      name: "Tokens / Turn",
      metric: sc.tokens_per_turn,
      value: fmtNum(sc.tokens_per_turn?.current ?? 0),
      sparkline: s.tokPerTurn,
      range: rangeText(sc.tokens_per_turn, true),
      higherIsBetter: false,
      isTokenCount: true,
    },
    {
      name: "First-Pass Rate",
      metric: sc.first_pass_rate,
      value: `${round(sc.first_pass_rate?.current ?? 0, 1)}%`,
      sparkline: s.firstPass,
      range: rangeText(sc.first_pass_rate),
      higherIsBetter: true,
      isTokenCount: false,
    },
  ];

  return (
    <div
      style={{
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "20px",
        MozOsxFontSmoothing: "grayscale",
        order: 2,
        paddingBlock: "32px",
        paddingInline: "64px",
        WebkitFontSmoothing: "antialiased",
        width: "1440px",
      }}
    >
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          gap: "12px",
        }}
      >
        <div
          style={{
            boxSizing: "border-box" as const,
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.1em",
            lineHeight: "14px",
            textTransform: "uppercase" as const,
          }}
        >
          Efficiency Scorecard
        </div>
        <div
          style={{
            boxSizing: "border-box" as const,
            color: "#FFFFFF40",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "11px",
            lineHeight: "14px",
          }}
        >
          Are your changes working?
        </div>
      </div>
      {coldStart && (
        <div
          style={{
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "11px",
            lineHeight: "14px",
            fontStyle: "italic",
          }}
        >
          Trend data unavailable &mdash; requires 7+ days of history
        </div>
      )}
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          gap: "16px",
        }}
      >
        {rows.map((row) => {
          const direction = getDeltaDirection(row.metric, row.higherIsBetter);
          const deltaText = formatDelta(row.metric, row.isTokenCount);
          const color =
            direction === "favorable"
              ? "#34D399"
              : direction === "declining"
                ? "#F59E0B"
                : "#FFFFFF59";
          const arrowPath =
            direction === "favorable"
              ? "M6 2 L10 7 L2 7 Z"
              : direction === "declining"
                ? "M6 10 L10 5 L2 5 Z"
                : null;

          return (
            <div key={row.name} style={cardStyle}>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#FFFFFF66",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "12px",
                  lineHeight: "16px",
                }}
              >
                {row.name}
              </div>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#F0F0F2",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "28px",
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  lineHeight: "36px",
                }}
              >
                {row.value}
              </div>
              {deltaText && (
                <div
                  style={{
                    alignItems: "center",
                    boxSizing: "border-box" as const,
                    display: "flex",
                    gap: "6px",
                  }}
                >
                  {arrowPath && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      xmlns="http://www.w3.org/2000/svg"
                      style={{ flexShrink: 0 }}
                    >
                      <path d={arrowPath} fill={color} />
                    </svg>
                  )}
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color,
                      flexShrink: 0,
                      fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                      fontSize: "12px",
                      lineHeight: "16px",
                    }}
                  >
                    {deltaText}
                  </div>
                </div>
              )}
              <svg
                width="100%"
                height="32"
                viewBox="0 0 200 32"
                xmlns="http://www.w3.org/2000/svg"
                style={{ overflow: "visible" as const }}
              >
                {row.sparkline && row.sparkline.length >= 2
                  ? (() => {
                      const vals = row.sparkline;
                      const minV = Math.min(...vals);
                      const maxV = Math.max(...vals);
                      const rangeV = maxV - minV || 1;
                      const pts = vals
                        .map((v, i) => {
                          const x = Math.round((i / (vals.length - 1)) * 200);
                          const y = Math.round(28 - ((v - minV) / rangeV) * 24);
                          return `${x},${y}`;
                        })
                        .join(" ");
                      return (
                        <polyline
                          points={pts}
                          stroke={color}
                          strokeWidth="1.5"
                          fill="none"
                          opacity="0.8"
                        />
                      );
                    })()
                  : null}
              </svg>
              {row.range && (
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#FFFFFF40",
                    fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                    fontSize: "10px",
                    lineHeight: "12px",
                  }}
                >
                  {row.range}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
