/**
 * InflectionAttribution — renders attribution details for a single inflection.
 * Displays each attribution entry (type + description) and an optional LLM insight.
 */
import type { Inflection } from "../types.ts";

export interface InflectionAttributionProps {
  inflection: Inflection;
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

  if (attrs.length === 0 && !inflection.llm_insight) {
    return null;
  }

  return (
    <div className="inflection-attributions">
      {attrs.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "6px 0 0 0",
          }}
        >
          {attrs.map((attr) => (
            <li
              key={`${attr.type}-${attr.description}`}
              style={{
                color: "var(--text-muted)",
                fontSize: "0.82rem",
                marginBottom: "2px",
              }}
            >
              <span
                style={{
                  color: "var(--accent)",
                  fontWeight: 600,
                  marginRight: "6px",
                }}
              >
                {typeLabel(attr.type)}:
              </span>
              {attr.description}
            </li>
          ))}
        </ul>
      )}
      {inflection.llm_insight ? (
        <div
          className="inflection-llm-insight"
          style={{
            marginTop: "6px",
            color: "var(--text-muted)",
            fontSize: "0.82rem",
          }}
        >
          {"💡"} {inflection.llm_insight}
        </div>
      ) : null}
    </div>
  );
}
