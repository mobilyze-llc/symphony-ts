import type { PerStageStats, StageSpend } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";
import {
  STAGE_COLORS,
  STAGE_ORDER,
  canonicalStage,
  findByKey,
} from "./index.ts";

export interface StageEfficiencyProps {
  perStageSpend: Record<string, StageSpend>;
  stageSparklines?: Record<string, number[]>;
  perStageStats?: Record<string, PerStageStats>;
}

/**
 * Determine if a WoW delta is favorable (lower tokens = better for all stages).
 */
function getDeltaDirection(
  wow: number | undefined,
): "favorable" | "declining" | null {
  if (wow == null || wow === 0) return null;
  return wow < 0 ? "favorable" : "declining";
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
  gap: "16px",
  paddingBlock: "20px",
  paddingInline: "20px",
};

export default function StageEfficiency({
  perStageSpend,
  stageSparklines,
  perStageStats,
}: StageEfficiencyProps) {
  const spend = perStageSpend ?? {};
  const sparklines = stageSparklines ?? {};
  const stats = perStageStats ?? {};

  // Build ordered stage list
  const dataKeys = Object.keys(spend);
  const stages = STAGE_ORDER.filter((s) =>
    dataKeys.some((k) => k.toLowerCase() === s.toLowerCase()),
  );
  for (const k of dataKeys) {
    if (!stages.some((s) => s.toLowerCase() === k.toLowerCase())) {
      stages.push(canonicalStage(k));
    }
  }

  return (
    <div
      style={{
        backgroundColor: "#FFFFFF05",
        borderTopColor: "#FFFFFF0F",
        borderTopStyle: "solid" as const,
        borderTopWidth: "1px",
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "20px",
        MozOsxFontSmoothing: "grayscale",
        order: 8,
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
        Stage Efficiency
      </div>

      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          gap: "16px",
        }}
      >
        {stages.map((stage) => {
          const data = findByKey(spend, stage);
          const sparkData = findByKey(sparklines, stage);
          const stageStats = findByKey(stats, stage);
          const stageColor = STAGE_COLORS[stage] ?? "#FFFFFF59";

          // Compute avg tokens per execution
          const avgTokens =
            data && data.count > 0
              ? Math.round(data.total_tokens / data.count)
              : 0;

          // WoW delta -- from stage trend data if available
          // For now, compute from sparkline if available
          let wowDelta: number | undefined;
          if (sparkData && sparkData.length >= 2) {
            const recent = sparkData[sparkData.length - 1];
            const prior = sparkData[Math.max(0, sparkData.length - 8)];
            if (prior > 0) {
              wowDelta = ((recent - prior) / prior) * 100;
            }
          }

          const direction = getDeltaDirection(wowDelta);
          const deltaColor =
            direction === "favorable"
              ? "#34D399"
              : direction === "declining"
                ? "#F59E0B"
                : "#FFFFFF59";
          const deltaText =
            wowDelta != null
              ? `${wowDelta >= 0 ? "+" : ""}${Math.round(wowDelta * 10) / 10}%`
              : null;

          // Cache rate color: favorable (>= 50%) green, else default
          // cache_rate is stored as a percentage (e.g. 72 = 72%)
          const cacheRate = stageStats?.cache_rate;
          const cacheColor =
            cacheRate != null && cacheRate >= 50 ? "#34D399" : "#FFFFFF80";

          return (
            <div key={stage} style={cardStyle}>
              <div
                style={{
                  alignItems: "baseline",
                  boxSizing: "border-box" as const,
                  display: "flex",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    backgroundColor: stageColor,
                    borderRadius: "50%",
                    boxSizing: "border-box" as const,
                    flexShrink: 0,
                    height: "8px",
                    width: "8px",
                  }}
                />
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: "#F0F0F2",
                    fontFamily: '"DM Sans", system-ui, sans-serif',
                    fontSize: "14px",
                    fontWeight: 600,
                    lineHeight: "18px",
                  }}
                >
                  {stage}
                </div>
                {deltaText && (
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: deltaColor,
                      flexShrink: 0,
                      fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                      fontSize: "12px",
                      lineHeight: "16px",
                      marginLeft: "auto",
                    }}
                  >
                    {deltaText}
                  </div>
                )}
              </div>

              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#F0F0F2",
                  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                  fontSize: "24px",
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  lineHeight: "32px",
                }}
              >
                {fmtNum(avgTokens)}
              </div>
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#FFFFFF59",
                  fontFamily: '"DM Sans", system-ui, sans-serif',
                  fontSize: "11px",
                  lineHeight: "14px",
                }}
              >
                avg tokens
              </div>

              <svg
                aria-hidden="true"
                width="100%"
                height="32"
                viewBox="0 0 200 32"
                xmlns="http://www.w3.org/2000/svg"
                style={{ overflow: "visible" as const }}
              >
                {sparkData && sparkData.length >= 2
                  ? (() => {
                      const vals = sparkData;
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
                          stroke={stageColor}
                          strokeWidth="1.5"
                          fill="none"
                          opacity="0.8"
                        />
                      );
                    })()
                  : null}
              </svg>

              <div
                style={{
                  boxSizing: "border-box" as const,
                  display: "flex",
                  gap: "16px",
                }}
              >
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    display: "flex",
                    flexBasis: "0%",
                    flexDirection: "column" as const,
                    flexGrow: 1,
                    flexShrink: 1,
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: "#FFFFFF59",
                      fontFamily: '"DM Sans", system-ui, sans-serif',
                      fontSize: "10px",
                      lineHeight: "12px",
                    }}
                  >
                    Avg turns
                  </div>
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: "#FFFFFF80",
                      fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                      fontSize: "14px",
                      fontWeight: 600,
                      lineHeight: "18px",
                    }}
                  >
                    {stageStats?.avg_turns != null
                      ? Math.round(stageStats.avg_turns * 10) / 10
                      : "\u2014"}
                  </div>
                </div>
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    display: "flex",
                    flexBasis: "0%",
                    flexDirection: "column" as const,
                    flexGrow: 1,
                    flexShrink: 1,
                    gap: "4px",
                  }}
                >
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: "#FFFFFF59",
                      fontFamily: '"DM Sans", system-ui, sans-serif',
                      fontSize: "10px",
                      lineHeight: "12px",
                    }}
                  >
                    Cache rate
                  </div>
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: cacheColor,
                      fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                      fontSize: "14px",
                      fontWeight: 600,
                      lineHeight: "18px",
                    }}
                  >
                    {cacheRate != null ? `${Math.round(cacheRate)}%` : "\u2014"}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
