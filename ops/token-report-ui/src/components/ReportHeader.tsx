/**
 * Section 0: Report Header
 * Rebuilt from v5 header.jsx inline styles.
 */

export interface ReportHeaderProps {
  today: string;
  products?: string[];
}

export default function ReportHeader({
  today,
  products,
}: ReportHeaderProps) {
  const productList = products?.length
    ? products.join(", ")
    : "symphony, jony-agent, hs-data, hs-ui, hs-mobile, stickerlabs, household";

  return (
    <div
      style={{
        backgroundColor: "#0F1117",
        borderBottomColor: "#FFFFFF0F",
        borderBottomStyle: "solid" as const,
        borderBottomWidth: "1px",
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "12px",
        MozOsxFontSmoothing: "grayscale",
        order: 0,
        paddingBottom: "32px",
        paddingLeft: "64px",
        paddingRight: "64px",
        paddingTop: "48px",
        WebkitFontSmoothing: "antialiased",
        width: "1440px",
      }}
    >
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
            flexShrink: 0,
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "36px",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: "44px",
          }}
        >
          Token Intelligence Report
        </div>
        <div
          style={{
            boxSizing: "border-box" as const,
            color: "#FFFFFF59",
            flexShrink: 0,
            fontFamily: '"JetBrains Mono", system-ui, sans-serif',
            fontSize: "13px",
            lineHeight: "16px",
          }}
        >
          Generated {today}
        </div>
      </div>
      <div
        style={{
          boxSizing: "border-box" as const,
          color: "#FFFFFF66",
          fontFamily: '"DM Sans", system-ui, sans-serif',
          fontSize: "14px",
          letterSpacing: "0.01em",
          lineHeight: "18px",
        }}
      >
        Daily analysis across all products &mdash; {productList}
      </div>
    </div>
  );
}
