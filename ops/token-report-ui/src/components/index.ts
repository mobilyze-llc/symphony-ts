/**
 * Barrel export for Token Report v2 React components.
 * Exports all 10 sections, chart utilities, design tokens, and CSS.
 */
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

export const designTokens = {
  bg: "#0F1117",
  surface: "#FFFFFF08",
  border: "#FFFFFF0F",
  text: "#F0F0F2",
  textSecondary: "#FFFFFF99",
  textTertiary: "#FFFFFF66",
  textMuted: "#FFFFFF59",
  textCaption: "#FFFFFF40",
  textBody: "#FFFFFF8C",
  accent: "#60A5FA",
  green: "#34D399",
  red: "#EF4444",
  yellow: "#F59E0B",
  purple: "#A78BFA",
  stageInvestigate: "#60A5FA",
  stageImplement: "#F59E0B",
  stageReview: "#A78BFA",
  stageMerge: "#34D399",
  sectionDivider: "#FFFFFF0F",
  inflectionImplementBg: "#F59E0B0F",
  inflectionImplementBorder: "#F59E0B26",
  inflectionReviewBg: "#A78BFA0F",
  inflectionReviewBorder: "#A78BFA26",
  fontHeading: '"DM Sans", system-ui, sans-serif',
  fontBody: '"DM Sans", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", system-ui, sans-serif',
  borderRadius: "12px",
  borderRadiusSmall: "8px",
  spacingSection: "64px",
  spacingSectionGap: "32px",
  spacingCard: "20px",
  spacingElement: "16px",
  spacingInner: "12px",
  spacingTight: "8px",
  spacingLabel: "4px",
};

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
