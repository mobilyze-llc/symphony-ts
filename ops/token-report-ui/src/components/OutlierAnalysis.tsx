/**
 * Section 5: Outlier Analysis
 * Converted from design reference OutlierAnalysis.jsx.
 *
 * Note: Design ref used issue_identifier/issue_title/total_tokens/hypothesis.
 * analysis.json uses issue/tokens/reason. Adapted to actual data shape.
 */
import type { Outlier } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface OutlierAnalysisProps {
  outliers: Outlier[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function OutlierAnalysis({
  outliers,
  coldStart,
  dataSpanDays,
}: OutlierAnalysisProps) {
  const items = Array.isArray(outliers) ? outliers : [];

  if (coldStart) {
    return (
      <section>
        <h2>Outlier Analysis</h2>
        <div
          className="cold-start-placeholder"
          style={{
            background: "var(--bg-card)",
            border: "1px dashed var(--border)",
            borderRadius: "6px",
            padding: "24px",
            textAlign: "center",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ fontSize: "1.5rem", marginBottom: "8px" }}>📊</div>
          <div style={{ fontWeight: 500, marginBottom: "4px" }}>
            Collecting data&hellip;
          </div>
          <div style={{ fontSize: "0.85rem" }}>
            Outlier detection requires at least 7 days of data.{" "}
            {dataSpanDays != null && 7 - dataSpanDays > 0 && (
              <>
                {7 - dataSpanDays} more{" "}
                {7 - dataSpanDays === 1 ? "day" : "days"} needed.
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section>
        <h2>Outlier Analysis</h2>
        <p style={{ color: "var(--text-muted)" }}>
          No outliers detected (&gt;2&sigma; threshold)
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Outlier Analysis</h2>
      {items.map((o) => (
        <div className="outlier-card" key={o.issue}>
          <div className="outlier-title">
            <a
              href={`https://linear.app/issue/${o.issue}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {o.issue}
            </a>{" "}
            &mdash; {o.stage} &mdash; {fmtNum(o.tokens)} tokens (z={o.z_score})
          </div>
          <div className="outlier-hypothesis">
            {o.reason ?? "No hypothesis available"}
          </div>
        </div>
      ))}
    </section>
  );
}
