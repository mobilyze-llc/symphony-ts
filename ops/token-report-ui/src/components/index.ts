export { default as ColdStartBanner } from "./ColdStartBanner.tsx";
export { default as ColdStartPlaceholder } from "./ColdStartPlaceholder.tsx";
export { default as ReportHeader } from "./ReportHeader.tsx";
export { default as ExecutiveSummary } from "./ExecutiveSummary.tsx";
export { default as EfficiencyScorecard } from "./EfficiencyScorecard.tsx";
export { default as InflectionAttribution } from "./InflectionAttribution.tsx";
export { default as PerStageTrend } from "./PerStageTrend.tsx";
export { default as PerTicketCostTrend } from "./PerTicketCostTrend.tsx";
export { default as OutlierAnalysis } from "./OutlierAnalysis.tsx";
export { default as IssueLeaderboard } from "./IssueLeaderboard.tsx";
export { default as StageEfficiency } from "./StageEfficiency.tsx";
export { default as PipelineHealth } from "./PipelineHealth.tsx";
export { default as PerProductBreakdown } from "./PerProductBreakdown.tsx";
export { default as ReportFooter } from "./ReportFooter.tsx";
export { default as StageUtilizationChart } from "./StageUtilizationChart.tsx";
export { default as TicketCostChart } from "./TicketCostChart.tsx";
export { fmtNum, WowBadge, Sparkline, MultiLineChart } from "./chartUtils.tsx";

/** Canonical pipeline stage order matching the design ref. */
export const STAGE_ORDER = [
  "Investigate",
  "Implement",
  "Validate",
  "Review",
  "Merge",
];

/** Stage name → color mapping for pipeline visualizations. */
export const STAGE_COLORS: Record<string, string> = {
  Investigate: "#60A5FA",
  Implement: "#F59E0B",
  Validate: "#A78BFA",
  Review: "#A78BFA",
  Merge: "#34D399",
};

/** Normalize a stage name to canonical casing. */
export function canonicalStage(s: string): string {
  const lower = s.toLowerCase();
  for (const name of STAGE_ORDER) {
    if (name.toLowerCase() === lower) return name;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Case-insensitive key lookup in a Record. */
export function findByKey<T>(
  obj: Record<string, T>,
  key: string,
): T | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export const reportCSS = `
:root {
  /* Colors */
  --bg: #0F1117;
  --surface: #FFFFFF08;
  --border: #FFFFFF0F;
  --text: #F0F0F2;
  --text-secondary: #FFFFFF99;
  --text-tertiary: #FFFFFF66;
  --text-muted: #FFFFFF59;
  --text-caption: #FFFFFF40;
  --text-body: #FFFFFF8C;
  --accent: #60A5FA;
  --green: #34D399;
  --red: #EF4444;
  --yellow: #F59E0B;
  --purple: #A78BFA;
  --stage-investigate: #60A5FA;
  --stage-implement: #F59E0B;
  --stage-review: #A78BFA;
  --stage-merge: #34D399;
  --section-divider: #FFFFFF0F;
  --inflection-implement-bg: #F59E0B0F;
  --inflection-implement-border: #F59E0B26;
  --inflection-review-bg: #A78BFA0F;
  --inflection-review-border: #A78BFA26;

  /* Typography */
  --font-heading: "DM Sans", system-ui, sans-serif;
  --font-body: "DM Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", system-ui, sans-serif;

  /* Spacing */
  --spacing-section: 64px;
  --spacing-section-gap: 32px;
  --spacing-card: 20px;
  --spacing-element: 16px;
  --spacing-inner: 12px;
  --spacing-tight: 8px;
  --spacing-label: 4px;

  /* Borders */
  --border-radius: 12px;
  --border-radius-small: 8px;
  --border-width: 1px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}
h1 { color: var(--text); margin-bottom: 8px; font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; }
h2 {
  color: #F0F0F2;
  font-family: "DM Sans", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  line-height: 14px;
  margin: 0;
  padding-bottom: 0;
  border-bottom: none;
}
a { color: #60A5FA; text-decoration: none; }
a:hover { text-decoration: underline; }
`;
