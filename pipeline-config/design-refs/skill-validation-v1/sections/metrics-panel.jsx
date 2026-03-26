export default function MetricsPanel({ metrics }) {
  const trendIcon = (trend) =>
    trend === "up" ? "▲" : trend === "down" ? "▼" : "—";
  const trendColor = (trend) =>
    trend === "up" ? "#10B981" : trend === "down" ? "#EF4444" : "#64748B";

  return (
    <section
      style={{
        width: "100%",
        maxWidth: 1440,
        minHeight: 280,
        padding: "32px",
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 24,
      }}
    >
      {metrics.map((m, i) => (
        <div
          key={i}
          style={{
            backgroundColor: "#FFFFFF",
            border: "1px solid #E2E8F0",
            borderRadius: 8,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: "Inter",
              fontSize: 14,
              fontWeight: 400,
              color: "#64748B",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {m.label}
          </span>
          <span
            style={{
              fontFamily: "Inter",
              fontSize: 28,
              fontWeight: 700,
              color: "#0F172A",
            }}
          >
            {m.value}
          </span>
          <span
            style={{
              fontFamily: "Inter",
              fontSize: 14,
              fontWeight: 400,
              color: trendColor(m.trend),
            }}
          >
            {trendIcon(m.trend)} {m.delta}
          </span>
        </div>
      ))}
    </section>
  );
}
