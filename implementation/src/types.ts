export interface HeaderProps {
  title: string;
  lastUpdated: string;
  version: string;
}

export interface Metric {
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down" | "flat";
}

export interface MetricsPanelProps {
  metrics: Metric[];
}

export interface Agent {
  name: string;
  status: "active" | "idle" | "error";
  tasks: number;
  tokens: string;
  cost: string;
  lastRun: string;
  sparkData: number[];
}

export interface DataTableProps {
  agents: Agent[];
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
}

export interface Series {
  name: string;
  color: string;
  data: number[];
}

export interface ChartSectionProps {
  title: string;
  subtitle?: string;
  series: Series[];
  xLabels: string[];
  yMax: number;
}

export interface FooterProps {
  brand: string;
  year: string;
}

export interface DashboardProps {
  header: HeaderProps;
  metricsPanel: MetricsPanelProps;
  dataTable: DataTableProps;
  chartSection: ChartSectionProps;
  footer: FooterProps;
}
