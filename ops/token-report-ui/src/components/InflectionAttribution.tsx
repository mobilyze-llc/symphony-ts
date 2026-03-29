/**
 * InflectionAttribution -- renders attribution details for a single inflection.
 * Rebuilt from v5 inflection-attribution.jsx inline styles.
 * Stage-colored cards: implement = bg #F59E0B0F / border #F59E0B26,
 * review = bg #A78BFA0F / border #A78BFA26.
 */
import type { Inflection } from "../types.ts";

export interface InflectionAttributionProps {
  inflection: Inflection;
}

const STAGE_THEME: Record<string, { bg: string; border: string }> = {
  implement: { bg: "#F59E0B0F", border: "#F59E0B26" },
  review: { bg: "#A78BFA0F", border: "#A78BFA26" },
  investigate: { bg: "#60A5FA0F", border: "#60A5FA26" },
  merge: { bg: "#34D3990F", border: "#34D39926" },
};

function getStageTheme(metric: string): { bg: string; border: string } {
  const lower = metric.toLowerCase();
  for (const [stage, theme] of Object.entries(STAGE_THEME)) {
    if (lower.includes(stage)) return theme;
  }
  return { bg: "#FFFFFF08", border: "#FFFFFF0F" };
}

/** Map attribution type to a display-friendly label. */
function typeLabel(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default function InflectionAttribution({
  inflection,
}: InflectionAttributionProps) {
  const attrs = inflection.attributions ?? [];
  const theme = getStageTheme(inflection.metric ?? "");

  // Build the summary line
  const sign = inflection.magnitude != null && inflection.magnitude < 0 ? "" : inflection.direction === "down" ? "-" : "+";
  const magnitudePct =
    inflection.magnitude != null
      ? `${sign}${Math.round(Math.abs(inflection.magnitude) * 100)}%`
      : "";
  const summaryLine = `${inflection.date} \u2014 ${inflection.metric ?? ""} avg ${magnitudePct}`;

  return (
    <div
      style={{
        backgroundColor: theme.bg,
        borderColor: theme.border,
        borderRadius: "12px",
        borderStyle: "solid" as const,
        borderWidth: "1px",
        boxSizing: "border-box" as const,
        display: "flex",
        gap: "32px",
        paddingBlock: "20px",
        paddingInline: "24px",
      }}
    >
      {/* Left: summary + inflection label */}
      <div
        style={{
          boxSizing: "border-box" as const,
          display: "flex",
          flexDirection: "column" as const,
          gap: "12px",
          width: "320px",
        }}
      >
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
          {summaryLine}
        </div>
        <div
          style={{
            boxSizing: "border-box" as const,
            color: "#FFFFFF40",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "10px",
            lineHeight: "12px",
            textTransform: "uppercase" as const,
          }}
        >
          inflection detected
        </div>
      </div>

      {/* Attribution cards */}
      {attrs.map((attr) => (
        <div
          key={`${attr.type}-${attr.description}`}
          style={{
            backgroundColor: "#FFFFFF08",
            borderRadius: "8px",
            boxSizing: "border-box" as const,
            display: "flex",
            flexBasis: "0%",
            flexDirection: "column" as const,
            flexGrow: 1,
            flexShrink: 1,
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
            {typeLabel(attr.type)}
          </div>
          <div
            style={{
              boxSizing: "border-box" as const,
              color: "#FFFFFF80",
              fontFamily: '"DM Sans", system-ui, sans-serif',
              fontSize: "12px",
              lineHeight: "16px",
            }}
          >
            {attr.description}
          </div>
        </div>
      ))}

      {/* LLM insight as an attribution card if present */}
      {inflection.llm_insight && (
        <div
          style={{
            backgroundColor: "#FFFFFF08",
            borderRadius: "8px",
            boxSizing: "border-box" as const,
            display: "flex",
            flexBasis: "0%",
            flexDirection: "column" as const,
            flexGrow: 1,
            flexShrink: 1,
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
            Attribution
          </div>
          <div
            style={{
              boxSizing: "border-box" as const,
              color: "#FFFFFF80",
              fontFamily: '"DM Sans", system-ui, sans-serif',
              fontSize: "12px",
              lineHeight: "16px",
            }}
          >
            {inflection.llm_insight}
          </div>
        </div>
      )}
    </div>
  );
}
