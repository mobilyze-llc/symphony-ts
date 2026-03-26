import type { DashboardProps } from "../types.ts";

export const fixtureData: DashboardProps = {
  header: {
    title: "Agent Performance Dashboard",
    lastUpdated: "2026-03-26 09:15",
    version: "1.2.0",
  },
  metricsPanel: {
    metrics: [
      { label: "Total Tasks", value: "1,284", delta: "+12%", trend: "up" },
      { label: "Avg Response", value: "1.2s", delta: "-8%", trend: "down" },
      { label: "Success Rate", value: "94.7%", delta: "+2.1%", trend: "up" },
      { label: "Active Agents", value: "7", delta: "0%", trend: "flat" },
    ],
  },
  dataTable: {
    agents: [
      {
        name: "claude-code",
        status: "active",
        tasks: 342,
        tokens: "2.4M",
        cost: "$18.20",
        lastRun: "2 min ago",
        sparkData: [40, 55, 48, 62, 58, 72, 68],
      },
      {
        name: "gemini-pro",
        status: "active",
        tasks: 289,
        tokens: "1.8M",
        cost: "$12.50",
        lastRun: "5 min ago",
        sparkData: [30, 42, 38, 45, 50, 48, 55],
      },
      {
        name: "codex-agent",
        status: "idle",
        tasks: 156,
        tokens: "890K",
        cost: "$6.40",
        lastRun: "1 hr ago",
        sparkData: [25, 30, 28, 22, 18, 15, 12],
      },
      {
        name: "symphony-orchestrator",
        status: "active",
        tasks: 497,
        tokens: "3.1M",
        cost: "$22.80",
        lastRun: "30 sec ago",
        sparkData: [50, 65, 72, 68, 80, 85, 90],
      },
      {
        name: "review-bot",
        status: "error",
        tasks: 0,
        tokens: "0",
        cost: "$0.00",
        lastRun: "3 hr ago",
        sparkData: [45, 42, 38, 30, 5, 0, 0],
      },
    ],
    sortColumn: "tasks",
    sortDirection: "desc",
  },
  chartSection: {
    title: "Performance Over Time",
    subtitle: "Token usage and task completion trends (last 7 days)",
    series: [
      {
        name: "claude-code",
        color: "#1E40AF",
        data: [40, 55, 48, 62, 58, 72, 68],
      },
      {
        name: "gemini-pro",
        color: "#6366F1",
        data: [30, 42, 38, 45, 50, 48, 55],
      },
      {
        name: "symphony-orchestrator",
        color: "#10B981",
        data: [50, 65, 72, 68, 80, 85, 90],
      },
    ],
    xLabels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    yMax: 100,
  },
  footer: {
    brand: "Symphony",
    year: "2026",
  },
};
