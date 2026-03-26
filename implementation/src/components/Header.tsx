import type { HeaderProps } from "../types.ts";

export default function Header({ title, lastUpdated, version }: HeaderProps) {
  return (
    <header
      style={{
        width: "100%",
        maxWidth: 1440,
        height: 120,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 32px",
        backgroundColor: "#FFFFFF",
        borderBottom: "1px solid #E2E8F0",
      }}
    >
      <h1
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 28,
          fontWeight: 700,
          color: "#0F172A",
          margin: 0,
        }}
      >
        {title}
      </h1>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 14,
            color: "#64748B",
          }}
        >
          {`Last updated: ${lastUpdated}`}
        </span>
        <span
          style={{
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: 13,
            color: "#64748B",
            backgroundColor: "#F8FAFC",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          {`v${version}`}
        </span>
      </div>
    </header>
  );
}
