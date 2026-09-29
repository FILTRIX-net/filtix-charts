import { createChart, measurePaneLayout } from '@filtix/charts';
import { createDrawingLayer } from '@filtix/drawings';
const host = document.getElementById('host')!;
const chart = createChart(host, { diagnostics: true });
const price = chart.addSeries('line', { paneId: 'price', title: 'Price' });
const volumePane = chart.addPane({ id: 'volume', weight: 0.26, minHeight: 64 });
const volume = chart.addSeries('histogram', { paneId: 'volume', title: 'Volume' });
const oscillatorPane = chart.addPane({ id: 'oscillator', weight: 0.3, minHeight: 72 });
const oscillator = chart.addSeries('line', { paneId: 'oscillator', title: 'Oscillator' });
price.setData([
  { time: 1, value: 10 },
  { time: 2, value: 12 },
  { time: 3, value: 11 },
]);
volume.setData([
  { time: 1, value: 8 },
  { time: 2, value: 10 },
  { time: 3, value: 7 },
]);
oscillator.setData([
  { time: 1, value: 40 },
  { time: 2, value: 60 },
  { time: 3, value: 50 },
]);
chart.fitContent();
const testApi = {
  chart,
  price,
  volume,
  oscillator,
  volumePane,
  oscillatorPane,
  host,
  measurePaneLayout,
  createChart,
  createDrawingLayer,
};
declare global {
  interface Window {
    paneLayoutTestApi: typeof testApi;
  }
}
window.paneLayoutTestApi = testApi;
