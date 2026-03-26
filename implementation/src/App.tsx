import {
  ChartSection,
  DataTable,
  Footer,
  Header,
  MetricsPanel,
} from "./components/index.ts";
import { fixtureData } from "./data/fixture.ts";
import type { DashboardProps } from "./types.ts";

export default function App(props?: Partial<DashboardProps>) {
  const data: DashboardProps = {
    header: props?.header ?? fixtureData.header,
    metricsPanel: props?.metricsPanel ?? fixtureData.metricsPanel,
    dataTable: props?.dataTable ?? fixtureData.dataTable,
    chartSection: props?.chartSection ?? fixtureData.chartSection,
    footer: props?.footer ?? fixtureData.footer,
  };

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 1440,
        margin: "0 auto",
        backgroundColor: "#F8FAFC",
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <Header {...data.header} />
      <MetricsPanel {...data.metricsPanel} />
      <DataTable {...data.dataTable} />
      <ChartSection {...data.chartSection} />
      <Footer {...data.footer} />
    </div>
  );
}
