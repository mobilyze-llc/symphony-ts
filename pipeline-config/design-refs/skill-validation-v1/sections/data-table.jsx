function Sparkline({ data }) {
  if (!data || data.length < 2) return null;
  const w = 80;
  const h = 24;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} xmlns="http://www.w3.org/2000/svg">
      <polyline
        points={points}
        fill="none"
        stroke="#6366F1"
        strokeWidth={1.5}
      />
    </svg>
  );
}

export default function DataTable({ agents, sortColumn, sortDirection }) {
  const statusColor = (s) =>
    s === "active" ? "#10B981" : s === "error" ? "#EF4444" : "#64748B";

  return (
    <section
      style={{
        width: "100%",
        maxWidth: 1440,
        minHeight: 600,
        padding: "0 32px 32px",
      }}
    >
      <h2
        style={{
          fontFamily: "Inter",
          fontSize: 18,
          fontWeight: 600,
          color: "#0F172A",
          marginBottom: 16,
        }}
      >
        Agent Overview
      </h2>
      <div
        style={{
          backgroundColor: "#FFFFFF",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: "Inter",
            fontSize: 14,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #E2E8F0" }}>
              {["Agent", "Status", "Tasks", "Tokens", "Cost", "Last Run", "Trend"].map(
                (col) => (
                  <th
                    key={col}
                    style={{
                      padding: "12px 16px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#64748B",
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {col}
                    {sortColumn === col.toLowerCase() && (sortDirection === "asc" ? " ↑" : " ↓")}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: "1px solid #E2E8F0",
                }}
              >
                <td
                  style={{
                    padding: "12px 16px",
                    fontFamily: "Mono",
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#0F172A",
                  }}
                >
                  {agent.name}
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: statusColor(agent.status),
                        display: "inline-block",
                      }}
                    />
                    <span style={{ color: "#0F172A", fontSize: 14 }}>
                      {agent.status}
                    </span>
                  </span>
                </td>
                <td style={{ padding: "12px 16px", color: "#0F172A" }}>
                  {agent.tasks}
                </td>
                <td
                  style={{
                    padding: "12px 16px",
                    fontFamily: "Mono",
                    fontSize: 13,
                    color: "#0F172A",
                  }}
                >
                  {agent.tokens}
                </td>
                <td style={{ padding: "12px 16px", color: "#0F172A" }}>
                  {agent.cost}
                </td>
                <td
                  style={{
                    padding: "12px 16px",
                    color: "#64748B",
                    fontSize: 13,
                  }}
                >
                  {agent.lastRun}
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <Sparkline data={agent.sparkData} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
