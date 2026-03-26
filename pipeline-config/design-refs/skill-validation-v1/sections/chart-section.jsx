export default function ChartSection({ title, subtitle, series, xLabels, yMax }) {
  const W = 1376;
  const H = 400;
  const PAD = { top: 40, right: 40, bottom: 60, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const toX = (i, count) => PAD.left + (i / (count - 1)) * plotW;
  const toY = (v) => PAD.top + plotH - (v / yMax) * plotH;

  const toPath = (data) =>
    data.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i, data.length)},${toY(v)}`).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => yMax * f);

  return (
    <section
      style={{
        width: "100%",
        maxWidth: 1440,
        minHeight: 520,
        padding: "0 32px 32px",
      }}
    >
      <h2
        style={{
          fontFamily: "Inter",
          fontSize: 18,
          fontWeight: 600,
          color: "#0F172A",
          marginBottom: 4,
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          style={{
            fontFamily: "Inter",
            fontSize: 14,
            color: "#64748B",
            marginBottom: 16,
          }}
        >
          {subtitle}
        </p>
      )}
      <div
        style={{
          backgroundColor: "#FFFFFF",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          padding: 24,
        }}
      >
        <svg
          width={W}
          height={H}
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Performance multi-line chart"
        >
          {/* Grid lines */}
          {gridLines.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                y1={toY(v)}
                x2={W - PAD.right}
                y2={toY(v)}
                stroke="#E2E8F0"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={toY(v) + 4}
                textAnchor="end"
                style={{ fontFamily: "Inter", fontSize: 11, fill: "#64748B" }}
              >
                {v}
              </text>
            </g>
          ))}

          {/* X-axis labels */}
          {xLabels.map((label, i) => (
            <text
              key={i}
              x={toX(i, xLabels.length)}
              y={H - PAD.bottom + 20}
              textAnchor="middle"
              style={{ fontFamily: "Inter", fontSize: 11, fill: "#64748B" }}
            >
              {label}
            </text>
          ))}

          {/* Series lines */}
          {series.map((s) => (
            <path
              key={s.name}
              d={toPath(s.data)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>

        {/* Legend */}
        <div
          style={{
            display: "flex",
            gap: 24,
            marginTop: 16,
            justifyContent: "center",
          }}
        >
          {series.map((s) => (
            <div
              key={s.name}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                style={{
                  width: 12,
                  height: 3,
                  backgroundColor: s.color,
                  borderRadius: 2,
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  fontFamily: "Inter",
                  fontSize: 13,
                  color: "#64748B",
                }}
              >
                {s.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
