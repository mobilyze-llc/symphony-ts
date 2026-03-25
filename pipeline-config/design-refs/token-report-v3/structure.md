# Design Structure: token-report-v3

**Artboard**: Token Report v2 — Mar 24, 2026 (1440×2871)
**Font families**: DM Sans, JetBrains Mono, System Sans-Serif
**Exported**: 2026-03-25

## Sections

| Section | Dimensions | Children |
|---------|-----------|----------|
| Header | 1440×155 | 2 |
| Executive Summary | 1440×268 | 2 |
| Efficiency Scorecard | 1440×274 | 2 |
| Per-Stage Utilization Trend | 1440×364 | 2 |
| Inflection Attribution | 1440×168 | 1 |
| Per-Ticket Cost Trend | 1440×342 | 2 |
| Outlier Analysis | 1440×494 | 3 |
| Issue Leaderboard | 1440×395 | 7 |
| Stage Efficiency | 1440×290 | 2 |
| Footer | 1440×121 | 2 |

## Implementation Contract

Each `.jsx` file in `sections/` begins with a `STRUCTURAL CONTRACT` comment. This is a compact summary of the design's structural requirements.

Rules for implementors:
1. **Match direct children count.** If the comment says "3 direct children", the component must render 3 top-level elements.
2. **Include all labels.** Every string in the "Labels:" line must appear in the implementation. These are headings, column names, stat names. Use as-is — don't rename.
3. **Match patterns.** "5 siblings × 2 children" means 5 repeated groups of 2 elements each. Implement all 5, not a subset.
4. **Render data gaps as placeholders.** If the data model lacks a field the design shows, render the label with "—" or 0. Document the gap in the PR description. Never omit designed structure.
