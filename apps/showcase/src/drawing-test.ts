import { createChart, type PrimitiveHost } from '@filtrix.net/charts';
import { createDrawingLayer, createDrawingStore } from '@filtrix.net/drawings';
import { makeCandles } from './fixtures';
const chart = createChart(document.getElementById('host')!, { diagnostics: true });
const data = makeCandles(100);
const series = chart.addSeries('candlestick');
series.setData(data);
chart.fitContent();
let notices = 0;
const layer = createDrawingLayer(chart, { onState: () => notices++ });
const drawingApi = {
  chart,
  data,
  series,
  layer,
  createDrawingLayer,
  createDrawingStore,
  createChart,
  notices: () => notices,
  projection: () => {
    let result!: ReturnType<PrimitiveHost['getProjection']>;
    const detach = chart.attachPrimitive({
      draw() {},
      attach(host) {
        result = host.getProjection();
      },
    });
    detach();
    return result;
  },
};
declare global {
  interface Window {
    drawingApi: typeof drawingApi;
  }
}
window.drawingApi = drawingApi;
