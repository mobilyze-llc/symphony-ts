/**
 * Section 3: Per-Stage Utilization Trend
 * Rebuilt from v5 per-stage-utilization-trend.jsx inline styles.
 */
import type { Inflection, StageTrend } from "../types.ts";
import ColdStartPlaceholder from "./ColdStartPlaceholder.tsx";
import InflectionAttribution from "./InflectionAttribution.tsx";
import { MultiLineChart } from "./chartUtils.tsx";
import type { ConfigChange } from "./chartUtils.tsx";

export interface PerStageTrendProps {
  perStageTrend: Record<string, StageTrend>;
  configChanges?: ConfigChange[];
  inflections?: Inflection[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function PerStageTrend({
  perStageTrend,
  configChanges,
  inflections,
  coldStart,
  dataSpanDays,
}: PerStageTrendProps) {
  const trend = perStageTrend ?? {};
  // spec-gen exclusion: filter stage_name === "spec-gen" from trend data
  const filteredTrend: Record<string, StageTrend> = {};
  for (const [stage, val] of Object.entries(trend)) {
    if (stage !== "spec-gen") {
      filteredTrend[stage] = val;
    }
  }
  const infl = Array.isArray(inflections) ? inflections : [];

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
        order: 3,
        paddingBlock: "32px",
        paddingInline: "64px",
        WebkitFontSmoothing: "antialiased",
        width: "1440px",
      }}
    >
      <div style={{ boxSizing: "border-box" as const, display: "flex", flexDirection: "column" as const, gap: "4px" }}>
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
          Per-Stage Utilization Trend
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
          30-day avg tokens per stage execution
        </div>
      </div>

      {coldStart ? (
        <ColdStartPlaceholder
          requiredDays={7}
          currentDays={dataSpanDays ?? 0}
        />
      ) : (
        <>
          <div
            style={{
              backgroundColor: "#FFFFFF08",
              borderColor: "#FFFFFF0F",
              borderRadius: "12px",
              borderStyle: "solid" as const,
              borderWidth: "1px",
              boxSizing: "border-box" as const,
              padding: "24px",
              overflowX: "auto" as const,
            }}
          >
            <MultiLineChart
              stageData={filteredTrend}
              configChanges={configChanges}
            />
          </div>
          {infl.length > 0 && (
            <div
              style={{
                boxSizing: "border-box" as const,
                display: "flex",
                flexDirection: "column" as const,
                gap: "16px",
              }}
            >
              {infl.map((inf) => (
                <InflectionAttribution
                  key={`${inf.date}-${inf.metric}`}
                  inflection={inf}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
