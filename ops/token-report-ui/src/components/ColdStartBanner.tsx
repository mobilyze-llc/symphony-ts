export interface ColdStartBannerProps {
  dataSpanDays: number;
  message?: string;
}

export default function ColdStartBanner({
  dataSpanDays,
  message,
}: ColdStartBannerProps) {
  return (
    <div
      className="cold-start-banner"
      style={{
        background: "rgba(245, 158, 11, 0.08)",
        border: "var(--border-width) solid var(--yellow)",
        borderRadius: "var(--border-radius)",
        padding: "var(--spacing-inner)",
        marginBottom: "var(--spacing-section-gap)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "14px",
          color: "var(--yellow)",
          fontWeight: 600,
          lineHeight: "18px",
          marginBottom: "var(--spacing-element)",
        }}
      >
        ⚠ Limited Data ({dataSpanDays} {dataSpanDays === 1 ? "day" : "days"})
      </div>
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "14px",
          color: "var(--text-secondary)",
          lineHeight: "18px",
        }}
      >
        {message ??
          "Trend charts, inflection detection, and outlier analysis require at least 7 days of data. These sections will show placeholder messaging until enough data has been collected."}
      </div>
    </div>
  );
}
