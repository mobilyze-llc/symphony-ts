/**
 * Section 5: Outlier Analysis
 * Rebuilt from v5 outlier-analysis.jsx inline styles.
 *
 * Per CH-1: DO NOT implement per-stage breakdown (the 5-column grid in the design ref).
 * Keep: multiplier badge with severity coloring, hypothesis box, 7d/30d averages.
 *
 * Severity badges:
 * - Red (multiplier >= 3x): bg #EF44441F, text #EF4444
 * - Amber (multiplier >= 2x): bg #F59E0B1F, text #F59E0B
 *
 * CSS round() in hypothesis lineHeight replaced with fixed value (per css-warnings.md).
 */
import type { Outlier } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface OutlierAnalysisProps {
  outliers: Outlier[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

function getSeverity(multiplier: number): { bg: string; text: string } {
  if (multiplier >= 3) return { bg: "#EF44441F", text: "#EF4444" };
  if (multiplier >= 2) return { bg: "#F59E0B1F", text: "#F59E0B" };
  return { bg: "#FFFFFF0F", text: "#FFFFFF80" };
}

export default function OutlierAnalysis({
  outliers,
  coldStart,
  dataSpanDays,
}: OutlierAnalysisProps) {
  const items = Array.isArray(outliers) ? outliers : [];

  if (coldStart) {
    return (
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          flexDirection: "column" as const,
          fontSynthesis: "none",
          gap: "20px",
          order: 6,
          paddingBlock: "32px",
          paddingInline: "64px",
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
          Outlier Analysis
        </div>
        <div
          style={{
            backgroundColor: "#FFFFFF08",
            borderColor: "#FFFFFF0F",
            borderRadius: "12px",
            borderStyle: "dashed" as const,
            borderWidth: "1px",
            boxSizing: "border-box" as const,
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "12px",
            lineHeight: "16px",
            paddingBlock: "24px",
            paddingInline: "24px",
            textAlign: "center" as const,
          }}
        >
          {dataSpanDays != null && 7 - dataSpanDays > 0
            ? `Outlier detection requires at least 7 days of data. ${7 - dataSpanDays} more ${7 - dataSpanDays === 1 ? "day" : "days"} needed.`
            : "Outlier detection requires at least 7 days of data."}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          flexDirection: "column" as const,
          fontSynthesis: "none",
          gap: "20px",
          order: 6,
          paddingBlock: "32px",
          paddingInline: "64px",
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
          Outlier Analysis
        </div>
        <div
          style={{
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "12px",
            lineHeight: "16px",
          }}
        >
          No statistical outliers detected
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "20px",
        MozOsxFontSmoothing: "grayscale",
        order: 6,
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
        Outlier Analysis
      </div>

      {items.map((o) => {
        const severity = getSeverity(o.multiplier);
        return (
          <div
            key={o.issue_identifier}
            style={{
              backgroundColor: "#FFFFFF08",
              borderColor: "#FFFFFF0F",
              borderRadius: "12px",
              borderStyle: "solid" as const,
              borderWidth: "1px",
              boxSizing: "border-box" as const,
              display: "flex",
              flexDirection: "column" as const,
              gap: "20px",
              paddingBlock: "24px",
              paddingInline: "24px",
            }}
          >
            {/* Issue header row */}
            <div
              style={{
                alignItems: "baseline",
                boxSizing: "border-box" as const,
                display: "flex",
                gap: "12px",
              }}
            >
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#60A5FA",
                  flexShrink: 0,
                  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                  fontSize: "14px",
                  fontWeight: 600,
                  lineHeight: "18px",
                }}
              >
                {o.linear_url ? (
                  <a
                    href={o.linear_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#60A5FA", textDecoration: "none" }}
                  >
                    {o.issue_identifier}
                  </a>
                ) : (
                  o.issue_identifier
                )}
              </div>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#F0F0F2",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "14px",
                  lineHeight: "18px",
                }}
              >
                {o.issue_title}
              </div>
              <div
                style={{
                  backgroundColor: severity.bg,
                  borderRadius: "4px",
                  boxSizing: "border-box" as const,
                  color: severity.text,
                  flexShrink: 0,
                  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                  fontSize: "11px",
                  fontWeight: 600,
                  lineHeight: "14px",
                  paddingBlock: "4px",
                  paddingInline: "8px",
                }}
              >
                {`${o.multiplier}x avg`}
              </div>
            </div>

            {/* Token total + averages */}
            <div style={{ boxSizing: "border-box" as const, display: "flex", gap: "32px" }}>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  display: "flex",
                  flexDirection: "column" as const,
                  gap: "4px",
                }}
              >
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#FFFFFF59",
                    fontFamily: '"DM Sans", system-ui, sans-serif',
                    fontSize: "10px",
                    letterSpacing: "0.05em",
                    lineHeight: "12px",
                    textTransform: "uppercase" as const,
                  }}
                >
                  Total
                </div>
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#F0F0F2",
                    fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                    fontSize: "18px",
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                    lineHeight: "24px",
                  }}
                >
                  {fmtNum(o.total_tokens)}
                </div>
              </div>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  display: "flex",
                  flexDirection: "column" as const,
                  gap: "4px",
                }}
              >
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#FFFFFF59",
                    fontFamily: '"DM Sans", system-ui, sans-serif',
                    fontSize: "10px",
                    letterSpacing: "0.05em",
                    lineHeight: "12px",
                    textTransform: "uppercase" as const,
                  }}
                >
                  7d Avg
                </div>
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#FFFFFF80",
                    fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                    fontSize: "18px",
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                    lineHeight: "24px",
                  }}
                >
                  {fmtNum(o.mean)}
                </div>
              </div>
            </div>

            {/* Hypothesis box */}
            <div
              style={{
                backgroundColor: "#FFFFFF08",
                borderRadius: "8px",
                boxSizing: "border-box" as const,
                display: "flex",
                flexDirection: "column" as const,
                gap: "8px",
                paddingBlock: "16px",
                paddingInline: "16px",
              }}
            >
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#FFFFFF59",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "10px",
                  letterSpacing: "0.05em",
                  lineHeight: "12px",
                  textTransform: "uppercase" as const,
                }}
              >
                Hypothesis
              </div>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#FFFFFF80",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "12px",
                  lineHeight: "18px",
                }}
              >
                {o.hypothesis ?? "No hypothesis available"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
