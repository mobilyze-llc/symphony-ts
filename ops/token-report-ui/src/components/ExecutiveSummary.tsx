import { round } from "../lib/chart-utils.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface ExecutiveSummaryProps {
  totalTokens: number;
  tokensDelta: number | null;
  tokensPerIssueMedian: number;
  tokensPerIssueMean: number;
  tokPerIssueWow: number | null;
  uniqueIssues: number;
  issuesDelta?: number | null;
  cacheHitRate: number;
  cacheWow: number | null;
}

/** Determine if a delta is favorable (tokens/cost going down = good, cache going up = good). */
function isFavorable(
  delta: number | null,
  invertSign?: boolean,
): boolean | null {
  if (delta == null || delta === 0) return null;
  if (invertSign) return delta > 0;
  return delta < 0;
}

function DeltaBadge({
  text,
  favorable,
}: {
  text: string;
  favorable: boolean | null;
}) {
  if (favorable == null) {
    return (
      <div
        style={{
          boxSizing: "border-box" as const,
          color: "#FFFFFF59",
          flexShrink: 0,
          fontFamily: '"JetBrains Mono", system-ui, sans-serif',
          fontSize: "12px",
          lineHeight: "16px",
        }}
      >
        {text}
      </div>
    );
  }

  const color = favorable ? "#34D399" : "#F59E0B";
  const arrowPath = favorable ? "M6 2 L10 7 L2 7 Z" : "M6 10 L10 5 L2 5 Z";

  return (
    <div
      style={{
        alignItems: "center",
        boxSizing: "border-box" as const,
        display: "flex",
        gap: "6px",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <path d={arrowPath} fill={color} />
      </svg>
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
        {text}
      </div>
    </div>
  );
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
  paddingBlock: "24px",
  paddingInline: "24px",
};

const labelStyle: React.CSSProperties = {
  boxSizing: "border-box",
  color: "#FFFFFF66",
  fontFamily: '"DM Sans", system-ui, sans-serif',
  fontSize: "12px",
  lineHeight: "16px",
};

const valueStyle: React.CSSProperties = {
  boxSizing: "border-box",
  color: "#F0F0F2",
  fontFamily: '"DM Sans", system-ui, sans-serif',
  fontSize: "32px",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: "40px",
};

export default function ExecutiveSummary({
  totalTokens,
  tokensDelta,
  tokensPerIssueMedian,
  tokensPerIssueMean,
  tokPerIssueWow,
  uniqueIssues,
  issuesDelta,
  cacheHitRate,
  cacheWow,
}: ExecutiveSummaryProps) {
  const tokensDeltaText =
    tokensDelta != null
      ? `${tokensDelta > 0 ? "+" : ""}${round(tokensDelta, 1)}% vs 7d avg`
      : null;
  const tokWowText =
    tokPerIssueWow != null
      ? `${tokPerIssueWow > 0 ? "+" : ""}${round(tokPerIssueWow, 1)}% WoW`
      : null;
  const issuesDeltaText =
    issuesDelta != null
      ? `${issuesDelta > 0 ? "+" : ""}${issuesDelta} vs 7d avg`
      : null;
  const cacheWowText =
    cacheWow != null
      ? `${cacheWow > 0 ? "+" : ""}${round(cacheWow, 1)}pp WoW`
      : null;

  return (
    <div
      style={{
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "20px",
        MozOsxFontSmoothing: "grayscale",
        order: 1,
        paddingBlock: "32px",
        paddingInline: "64px",
        WebkitFontSmoothing: "antialiased",
        width: "1440px",
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
        Executive Summary
      </div>
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          gap: "20px",
        }}
      >
        <div style={cardStyle}>
          <div style={labelStyle}>Total Tokens Today</div>
          <div style={valueStyle}>{fmtNum(totalTokens)}</div>
          {tokensDeltaText && (
            <DeltaBadge
              text={tokensDeltaText}
              favorable={isFavorable(tokensDelta)}
            />
          )}
        </div>

        <div style={cardStyle}>
          <div style={labelStyle}>Issues Processed</div>
          <div style={valueStyle}>{fmtNum(uniqueIssues)}</div>
          <DeltaBadge text={issuesDeltaText ?? "\u2014"} favorable={null} />
        </div>

        <div style={cardStyle}>
          <div style={labelStyle}>Tokens / Issue</div>
          <div style={valueStyle}>{fmtNum(tokensPerIssueMedian)}</div>
          {tokWowText && (
            <DeltaBadge
              text={tokWowText}
              favorable={isFavorable(tokPerIssueWow)}
            />
          )}
          <div
            style={{
              boxSizing: "border-box" as const,
              color: "#FFFFFF40",
              fontFamily: '"JetBrains Mono", system-ui, sans-serif',
              fontSize: "10px",
              lineHeight: "12px",
            }}
          >
            median &middot; mean {fmtNum(tokensPerIssueMean)}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={labelStyle}>Cache Hit Rate</div>
          <div style={valueStyle}>{round(cacheHitRate, 1)}%</div>
          {cacheWowText && (
            <DeltaBadge
              text={cacheWowText}
              favorable={isFavorable(cacheWow, true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
