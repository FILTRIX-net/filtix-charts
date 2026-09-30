import { createChart, type ChartApi, type SeriesHandle, type CrosshairEvent } from '@filtrix.net/charts';
import { makeCandles } from './fixtures';
const data = makeCandles(500);
const chart = createChart(document.getElementById('host')!, { diagnostics: true });
const series = chart.addSeries('candlestick');
series.setData(data);
chart.fitContent();
const testApi = { chart, series, data, createChart, makeCandles, crosshair: null as CrosshairEvent | null };
chart.subscribeCrosshairMove((e) => {
  testApi.crosshair = e;
});
declare global {
  interface Window {
    testApi: typeof testApi;
  }
}
window.testApi = testApi;
