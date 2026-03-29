/**
 * Reusable placeholder shown inside sections that require 7+ days of data
 * when the report is in cold-start mode (data_span_days < 7).
 * Rebuilt with v5 inline styles (SYMPH-205).
 */

export interface ColdStartPlaceholderProps {
  /** Minimum days needed for this section to render fully */
  requiredDays: number;
  /** Current data span in days */
  currentDays: number;
}

export default function ColdStartPlaceholder({
  requiredDays,
  currentDays,
}: ColdStartPlaceholderProps) {
  const remaining = requiredDays - currentDays;
  return (
    <div
      className="cold-start-placeholder"
      style={{
        background: "var(--surface)",
        border: "var(--border-width) dashed var(--border)",
        borderRadius: "var(--border-radius)",
        padding: "var(--spacing-section-gap)",
        textAlign: "center",
        color: "var(--text-secondary)",
      }}
    >
      <div
        style={{
          fontSize: "24px",
          marginBottom: "var(--spacing-element)",
          lineHeight: "32px",
        }}
      >
        📊
      </div>
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: "14px",
          color: "var(--text)",
          marginBottom: "var(--spacing-element)",
          lineHeight: "18px",
        }}
      >
        Collecting data&hellip;
      </div>
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--text-secondary)",
          lineHeight: "16px",
        }}
      >
        This section requires at least {requiredDays} days of data.{" "}
        {remaining > 0 && (
          <>
            {remaining} more {remaining === 1 ? "day" : "days"} needed.
          </>
        )}
      </div>
    </div>
  );
}
