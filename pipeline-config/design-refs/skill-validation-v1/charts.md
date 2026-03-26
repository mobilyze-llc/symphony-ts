# Charts

## Multi-Line Chart (chart-section)
- Type: SVG multi-line chart
- Series: 3 agent performance lines
- Data points: 7 per series (one per day label)
- X-axis: date labels (xLabels prop)
- Y-axis: 0 to yMax
- Each series: { name, color, data: number[] }
- Render as SVG `<path>` elements with stroke color from series

## Inline Sparklines (data-table)
- Type: SVG inline sparkline
- One per table row
- Data: `agents[].sparkData` (array of 7 numbers)
- Render as `<polyline>` in small SVG (80×24)
- Stroke: #6366F1
- No axes, no labels
