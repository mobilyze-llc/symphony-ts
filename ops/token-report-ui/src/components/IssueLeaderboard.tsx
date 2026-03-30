import type { LeaderboardEntry } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface IssueLeaderboardProps {
  leaderboard: LeaderboardEntry[];
}

const gridColumns = "120px 1fr 120px 40px";

const headerCellStyle: React.CSSProperties = {
  boxSizing: "border-box",
  color: "#FFFFFF59",
  fontFamily: '"DM Sans", system-ui, sans-serif',
  fontSize: "10px",
  letterSpacing: "0.05em",
  lineHeight: "12px",
  textTransform: "uppercase",
};

const headerCellRightStyle: React.CSSProperties = {
  ...headerCellStyle,
  textAlign: "right",
};

const dataCellStyle: React.CSSProperties = {
  boxSizing: "border-box",
  color: "#F0F0F2",
  fontFamily: '"DM Sans", system-ui, sans-serif',
  fontSize: "12px",
  lineHeight: "16px",
};

const numCellStyle: React.CSSProperties = {
  boxSizing: "border-box",
  color: "#FFFFFF66",
  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
  fontSize: "12px",
  lineHeight: "16px",
  textAlign: "right",
};

const totalCellStyle: React.CSSProperties = {
  ...numCellStyle,
  color: "#F0F0F2",
  fontWeight: 600,
};

export default function IssueLeaderboard({
  leaderboard,
}: IssueLeaderboardProps) {
  const items = Array.isArray(leaderboard) ? leaderboard.slice(0, 25) : [];

  return (
    <div
      style={{
        boxSizing: "border-box" as const,
        display: "flex",
        flexDirection: "column" as const,
        fontSynthesis: "none",
        gap: "16px",
        MozOsxFontSmoothing: "grayscale",
        order: 7,
        paddingBlock: "32px",
        paddingInline: "64px",
        WebkitFontSmoothing: "antialiased",
        width: "1440px",
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
        Issue Leaderboard
      </div>

      {items.length === 0 ? (
        <div
          style={{
            color: "#FFFFFF59",
            fontFamily: '"DM Sans", system-ui, sans-serif',
            fontSize: "12px",
            lineHeight: "16px",
          }}
        >
          No issues processed yet
        </div>
      ) : (
        <div
          style={{
            backgroundColor: "#FFFFFF08",
            borderColor: "#FFFFFF0F",
            borderRadius: "12px",
            borderStyle: "solid" as const,
            borderWidth: "1px",
            boxSizing: "border-box" as const,
            display: "flex",
            flexDirection: "column" as const,
            overflow: "hidden" as const,
          }}
        >
          <div
            style={{
              backgroundColor: "#FFFFFF08",
              boxSizing: "border-box" as const,
              display: "grid",
              gap: "16px",
              gridTemplateColumns: gridColumns,
              paddingBlock: "12px",
              paddingInline: "24px",
            }}
          >
            <div style={headerCellStyle}>Issue</div>
            <div style={headerCellStyle}>Title</div>
            <div style={headerCellRightStyle}>Total</div>
            <div style={headerCellStyle} />
          </div>

          {items.map((item) => (
            <div
              key={item.identifier}
              style={{
                borderTopColor: "#FFFFFF0F",
                borderTopStyle: "solid" as const,
                borderTopWidth: "1px",
                boxSizing: "border-box" as const,
                display: "grid",
                gap: "16px",
                gridTemplateColumns: gridColumns,
                paddingBlock: "16px",
                paddingInline: "24px",
              }}
            >
              <div
                style={{
                  boxSizing: "border-box" as const,
                  color: "#60A5FA",
                  fontFamily: '"JetBrains Mono", system-ui, sans-serif',
                  fontSize: "12px",
                  lineHeight: "16px",
                }}
              >
                {item.linear_url ? (
                  <a
                    href={item.linear_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#60A5FA", textDecoration: "none" }}
                  >
                    {item.identifier}
                  </a>
                ) : (
                  item.identifier
                )}
              </div>
              <div style={dataCellStyle}>{item.title}</div>
              <div style={totalCellStyle}>{fmtNum(item.tokens)}</div>
              <div style={{ boxSizing: "border-box" as const }}>
                {item.linear_url ? (
                  <a
                    href={item.linear_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: "#FFFFFF59",
                      textDecoration: "none",
                      fontSize: "12px",
                    }}
                  >
                    ↗
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
