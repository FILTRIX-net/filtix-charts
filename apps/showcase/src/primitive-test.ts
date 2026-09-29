import { createChart } from '@filtix/charts';
import { makeCandles } from './fixtures';

const chart = createChart(document.getElementById('host')!, { diagnostics: true });
const series = chart.addSeries('candlestick');
const data = makeCandles(500);
series.setData(data);
chart.fitContent();
const testApi = { chart, series, data, createChart };
declare global {
  interface Window {
    primitiveTestApi: typeof testApi;
  }
}
window.primitiveTestApi = testApi;
