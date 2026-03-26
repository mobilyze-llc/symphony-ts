export default function Footer({ brand, year }) {
  return (
    <footer
      style={{
        width: "100%",
        maxWidth: 1440,
        height: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 32px",
        borderTop: "1px solid #E2E8F0",
      }}
    >
      <span
        style={{
          fontFamily: "Inter",
          fontSize: 12,
          color: "#64748B",
        }}
      >
        Powered by {brand} &copy; {year}
      </span>
    </footer>
  );
}
