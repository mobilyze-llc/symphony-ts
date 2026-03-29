import type { FailureRate } from "../types.ts";
import { STAGE_ORDER, STAGE_COLORS, canonicalStage } from "./index.ts";

export interface PipelineHealthProps {
  failureRate: FailureRate;
}

export default function PipelineHealth({ failureRate }: PipelineHealthProps) {
  const current = failureRate?.current ?? {};
  const trend7d = failureRate?.trend_7d ?? {};
  const trend30d = failureRate?.trend_30d ?? {};

  // Build ordered stages from the canonical order, falling back to data keys
  const dataKeys = Object.keys(current);
  const stages = STAGE_ORDER.filter((s) =>
    dataKeys.some((k) => k.toLowerCase() === s.toLowerCase()),
  );
  // Add any extra stages not in our canonical list
  for (const k of dataKeys) {
    if (!stages.some((s) => s.toLowerCase() === k.toLowerCase())) {
      stages.push(canonicalStage(k));
    }
  }

  if (stages.length === 0) {
    return (
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          flexDirection: "column" as const,
          fontSynthesis: "none",
          gap: "20px",
          order: 9,
          paddingBlock: "32px",
          paddingInline: "64px",
          width: "1440px",
        }}
      >
        <div
          style={{
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.1em",
            lineHeight: "14px",
            textTransform: "uppercase" as const,
          }}
        >
          Pipeline Health
        </div>
        <div
          style={{
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "12px",
          }}
        >
          No failure rate data available.
        </div>
      </div>
    );
  }

  function findRate(obj: Record<string, number>, stage: string): number {
    const lower = stage.toLowerCase();
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === lower) return v;
    }
    return 0;
  }

  // Pre-compute per-stage current rates to avoid repeated linear scans
  const currentRates = new Map(stages.map((s) => [s, findRate(current, s)]));
  const totalRate = stages.reduce(
    (sum, s) => sum + (currentRates.get(s) ?? 0),
    0,
  );
  const totalRate30d = stages.reduce(
    (sum, s) => sum + findRate(trend30d, s),
    0,
  );

  let worstStage = stages[0];
  for (const s of stages) {
    if ((currentRates.get(s) ?? 0) > (currentRates.get(worstStage) ?? 0)) {
      worstStage = s;
    }
  }

  const worstCurrent = currentRates.get(worstStage) ?? 0;
  const worstShare =
    totalRate > 0 ? Math.round((worstCurrent / totalRate) * 100) : 0;
  const worst7d = findRate(trend7d, worstStage);
  const deltaPp = Math.round((worstCurrent - worst7d) * 10) / 10;
  const direction = deltaPp === 0 ? "flat" : deltaPp < 0 ? "down" : "up";
  const absDelta = Math.abs(deltaPp);

  const insight = `${worstStage} accounts for ${worstShare}% of all failures \u2014 ${direction === "flat" ? "flat vs 7d avg" : `${direction} ${absDelta}pp vs 7d avg`}`;

  // Insight callout color from worst stage
  const worstColor = STAGE_COLORS[worstStage] ?? "#FFFFFF";
  const insightBg = `${worstColor}0F`;
  const insightBorder = `${worstColor}26`;

  // Overall failure rate delta for badge
  const overallDelta = Math.round((totalRate - totalRate30d) * 10) / 10;
  const overallDeltaFavorable = overallDelta === 0 ? null : overallDelta < 0;
  const overallDeltaColor =
    overallDeltaFavorable === true
      ? "#34D399"
      : overallDeltaFavorable === false
        ? "#F59E0B"
        : "#FFFFFF59";
  const overallDeltaArrow =
    overallDeltaFavorable === true
      ? "M6 2 L10 7 L2 7 Z"
      : overallDeltaFavorable === false
        ? "M6 10 L10 5 L2 5 Z"
        : null;

  // 30d range text
  const range30dText = `30d: ${Math.round(totalRate30d * 10) / 10}% \u2192 ${Math.round(totalRate * 10) / 10}%`;

  // Max bar scale: design ref uses 4.46x multiplier for percentage
  // We compute bar width as percentage of the max stage rate, capped at 100%
  const maxRate = Math.max(
    ...stages.map((s) => currentRates.get(s) ?? 0),
    0.01,
  );

  return (
    <div
      style={{
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "20px",
        MozOsxFontSmoothing: "grayscale",
        order: 9,
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
          flexDirection: "column" as const,
          gap: "4px",
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
          Pipeline Health
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
          Where tickets get stuck
        </div>
      </div>

      <div
        style={{
          backgroundColor: "#FFFFFF08",
          borderColor: "#FFFFFF0F",
          borderRadius: "12px",
          borderStyle: "solid" as const,
          borderWidth: "1px",
          boxSizing: "border-box" as const,
          display: "flex",
          flexDirection: "column" as const,
          gap: "24px",
          paddingBlock: "24px",
          paddingInline: "24px",
        }}
      >
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
              flexDirection: "column" as const,
              gap: "8px",
            }}
          >
            <div
              style={{
                boxSizing: "border-box" as const,
                color: "#FFFFFF66",
                fontFamily: '"DM Sans", system-ui, sans-serif',
                fontSize: "11px",
                lineHeight: "14px",
              }}
            >
              Failure Rate
            </div>
            <div
              style={{
                boxSizing: "border-box" as const,
                color: "#EF4444",
                fontFamily: '"DM Sans", system-ui, sans-serif',
                fontSize: "32px",
                fontWeight: 700,
                letterSpacing: "-0.02em",
                lineHeight: "40px",
              }}
            >
              {Math.round(totalRate * 10) / 10}%
            </div>
            <div
              style={{
                alignItems: "center",
                boxSizing: "border-box" as const,
                display: "flex",
                gap: "6px",
              }}
            >
              {overallDeltaArrow && (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  xmlns="http://www.w3.org/2000/svg"
                  style={{ flexShrink: 0 }}
                >
                  <path d={overallDeltaArrow} fill={overallDeltaColor} />
                </svg>
              )}
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: overallDeltaColor,
                  flexShrink: 0,
                  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                  fontSize: "12px",
                  lineHeight: "16px",
                }}
              >
                {overallDelta > 0 ? "+" : ""}
                {Math.abs(overallDelta)}pp
              </div>
            </div>
            <div
              style={{
                boxSizing: "border-box" as const,
                color: "#FFFFFF40",
                fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                fontSize: "10px",
                lineHeight: "12px",
              }}
            >
              {range30dText}
            </div>
          </div>

          <div
            style={{
              borderLeftColor: "#FFFFFF0F",
              borderLeftStyle: "solid" as const,
              borderLeftWidth: "1px",
              boxSizing: "border-box" as const,
              display: "flex",
              flexBasis: "0%",
              flexDirection: "column" as const,
              flexGrow: 1,
              flexShrink: 1,
              gap: "12px",
              paddingLeft: "24px",
            }}
          >
            {stages.map((stage) => {
              const rate = currentRates.get(stage) ?? 0;
              const ratePct = Math.round(rate * 10) / 10;
              const barWidth = `${Math.round((rate / maxRate) * 100)}%`;
              const stageColor = STAGE_COLORS[stage] ?? "#FFFFFF59";
              const rateDisplay = `${ratePct}%`;

              return (
                <div
                  key={stage}
                  style={{
                    boxSizing: "border-box" as const,
                    display: "flex",
                    gap: "12px",
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      boxSizing: "border-box" as const,
                      display: "flex",
                      gap: "8px",
                      width: "140px",
                    }}
                  >
                    <div
                      style={{
                        backgroundColor: stageColor,
                        borderRadius: "50%",
                        boxSizing: "border-box" as const,
                        flexShrink: 0,
                        height: "6px",
                        width: "6px",
                      }}
                    />
                    <div
                      style={{
                        boxSizing: "border-box" as const,
                        color: "#FFFFFF80",
                        fontFamily: '"DM Sans", system-ui, sans-serif',
                        fontSize: "12px",
                        lineHeight: "16px",
                      }}
                    >
                      {stage}
                    </div>
                  </div>
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      color: "#F0F0F2",
                      fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                      fontSize: "13px",
                      fontWeight: 600,
                      lineHeight: "16px",
                      width: "60px",
                    }}
                  >
                    {rateDisplay}
                  </div>
                  <div
                    style={{
                      boxSizing: "border-box" as const,
                      display: "flex",
                      flexBasis: "0%",
                      flexGrow: 1,
                      flexShrink: 1,
                      position: "relative" as const,
                    }}
                  >
                    <div
                      style={{
                        backgroundColor: "#FFFFFF0F",
                        borderRadius: "4px",
                        boxSizing: "border-box" as const,
                        height: "16px",
                        overflow: "hidden" as const,
                        position: "relative" as const,
                        width: "100%",
                      }}
                    >
                      <div
                        style={{
                          backgroundColor: stageColor,
                          boxSizing: "border-box" as const,
                          height: "100%",
                          width: barWidth,
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div
        style={{
          backgroundColor: insightBg,
          borderColor: insightBorder,
          borderRadius: "8px",
          borderStyle: "solid" as const,
          borderWidth: "1px",
          boxSizing: "border-box" as const,
          color: "#FFFFFF80",
          fontFamily: '"DM Sans", system-ui, sans-serif',
          fontSize: "12px",
          lineHeight: "16px",
          paddingBlock: "12px",
          paddingInline: "16px",
        }}
      >
        {insight}
      </div>
    </div>
  );
}
