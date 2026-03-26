# Data Map

## Classification

### Static Labels
- "Agent Performance Dashboard" (header title area)
- "Total Tasks", "Avg Response", "Success Rate", "Active Agents" (metric labels)
- "Agent", "Status", "Tasks", "Tokens", "Cost", "Last Run", "Trend" (table headers)
- "Performance Over Time" (chart title)
- "Powered by" (footer)

### Dynamic Values (must be props)
- Header: `title`, `lastUpdated`, `version`
- Metrics: `metrics[].label`, `metrics[].value`, `metrics[].delta`, `metrics[].trend`
- Table: `agents[].name`, `agents[].status`, `agents[].tasks`, `agents[].tokens`, `agents[].cost`, `agents[].lastRun`, `agents[].sparkData`
- Chart: `series[].name`, `series[].color`, `series[].data`, `xLabels[]`, `yMax`
- Footer: `brand`, `year`

### Decorative
- Status indicator dots
- Trend arrows (▲ ▼)
- Sparkline charts in table rows
