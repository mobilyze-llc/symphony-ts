import { round } from "../lib/chart-utils.ts";
import type { PerTicketTrend } from "../types.ts";
import ColdStartPlaceholder from "./ColdStartPlaceholder.tsx";
import { Sparkline } from "./chartUtils.tsx";

function formatK(n: number): string {
  if (n >= 1000) return `${round(n / 1000, 1)}K`;
  return String(round(n, 0));
}

export interface PerTicketCostTrendProps {
  perTicket: PerTicketTrend;
  perTicketSeries?: number[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function PerTicketCostTrend({
  perTicket,
  perTicketSeries,
  coldStart,
  dataSpanDays,
}: PerTicketCostTrendProps) {
  const pt = perTicket ?? ({} as Partial<PerTicketTrend>);

  const wowDelta = pt.wow_delta_pct;
  const deltaFavorable =
    wowDelta != null && wowDelta !== 0 ? wowDelta < 0 : null;
  const deltaColor =
    deltaFavorable === true
      ? "#34D399"
      : deltaFavorable === false
        ? "#F59E0B"
        : "#FFFFFF59";
  const deltaArrow =
    deltaFavorable === true
      ? "M6 2 L10 7 L2 7 Z"
      : deltaFavorable === false
        ? "M6 10 L10 5 L2 5 Z"
        : null;
  const deltaText =
    wowDelta != null
      ? `${wowDelta >= 0 ? "+" : ""}${round(wowDelta, 1)}% WoW`
      : null;

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
        order: 5,
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
          Per-Ticket Cost Trend
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
          30-day rolling median total tokens per ticket
        </div>
      </div>

      {coldStart ? (
        <ColdStartPlaceholder
          requiredDays={7}
          currentDays={dataSpanDays ?? 0}
        />
      ) : (
        <>
          <Sparkline
            values={perTicketSeries}
            width={1260}
            height={160}
            stroke="#60A5FA"
            strokeWidth={2}
            fill
          />
          <div
            style={{
              alignItems: "baseline",
              boxSizing: "border-box" as const,
              display: "flex",
              gap: "16px",
            }}
          >
            <div
              style={{
                boxSizing: "border-box" as const,
                color: "#F0F0F2",
                fontFamily: '"DM Sans", system-ui, sans-serif',
                fontSize: "16px",
                fontWeight: 600,
                lineHeight: "20px",
              }}
            >
              Median: {formatK(pt.median ?? 0)}/ticket
            </div>
            <div
              style={{
                boxSizing: "border-box" as const,
                color: "#FFFFFF66",
                fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                fontSize: "13px",
                lineHeight: "16px",
              }}
            >
              Mean: {formatK(pt.mean ?? 0)}
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
                {deltaArrow && (
                  <svg
                    aria-hidden="true"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    xmlns="http://www.w3.org/2000/svg"
                    style={{ flexShrink: 0 }}
                  >
                    <path d={deltaArrow} fill={deltaColor} />
                  </svg>
                )}
                <div
                  style={{
                    boxSizing: "border-box" as const,
                    color: deltaColor,
                    flexShrink: 0,
                    fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                    fontSize: "13px",
                    lineHeight: "16px",
                  }}
                >
                  {deltaText}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
