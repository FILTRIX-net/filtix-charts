import { createChart, type ChartApi, type ChartOptions, type ChartTime } from '@filtix/charts';
import { createChartSync } from '../../../packages/analysis/src/sync';
const charts: ChartApi[] = [];
function create(times: readonly ChartTime[], options: ChartOptions = {}) {
  const host = document.createElement('div');
  host.style.cssText = 'width:600px;height:300px';
  document.body.append(host);
  const chart = createChart(host, { diagnostics: true, followLatest: false, maxPixelRatio: 1, ...options });
  const series = chart.addSeries('line', { id: 'price-series' });
  series.setData(times.map((time, i) => ({ time, value: i + 1 })));
  chart.fitContent();
  charts.push(chart);
  return { chart, series, root: host.querySelector<HTMLElement>('[data-filtix-root]')! };
}
const times = Array.from({ length: 20 }, (_, i) => i * 1000);
const first = create(times),
  second = create(times.filter((_, i) => i % 2 === 0));
first.chart.setVisibleRange({ from: 3, to: 8 });
const syncTestApi = {
  a: first.chart,
  b: second.chart,
  first,
  second,
  create,
  createChartSync,
  async settle() {
    for (let i = 0; i < 3; i++) {
      await Promise.all(charts.map((chart) => chart.whenIdle()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  },
};
declare global {
  interface Window {
    syncTestApi: typeof syncTestApi;
  }
}
window.syncTestApi = syncTestApi;
