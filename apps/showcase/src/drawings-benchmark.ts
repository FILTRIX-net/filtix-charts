// This harness deliberately imports the built packages, not Vite source aliases.
import { createChart, type ChartApi, type SeriesHandle } from '../../../packages/charts/dist/index.js';
import {
  createDrawingLayer,
  createDrawingStore,
  type DrawingLayer,
  type DrawingStore,
} from '../../../packages/drawings/dist/index.js';
import { makeCandles } from './fixtures';

const host = document.querySelector<HTMLElement>('#host')!;
const rows = 100_000;
const visibleBars = 1_000;
const corridor = { first: 49_500, last: 49_889, navigationFromMin: 49_000, navigationFromMax: 49_400 };
let chart: ChartApi | null = null;
let series: SeriesHandle | null = null;
let layer: DrawingLayer | null = null;
let store: DrawingStore | null = null;
const data = makeCandles(rows, { seed: 303, price: 100, step: 60_000 });

function priceAt(index: number) {
  return data[index]!.close;
}

function populateDrawings(next: DrawingStore) {
  const types = ['trend-line', 'horizontal-line', 'rectangle', 'measure'] as const;
  for (let i = 0; i < 200; i++) {
    const type = types[i % types.length]!;
    const first = corridor.first + ((i * 7) % 350);
    const second = Math.min(corridor.last, first + 1 + (i % 40));
    const points =
      type === 'horizontal-line'
        ? [{ time: data[first]!.time, price: priceAt(first) }]
        : [
            { time: data[first]!.time, price: priceAt(first) },
            { time: data[second]!.time, price: priceAt(second) },
          ];
    next.add({ id: `bench-${i}`, type, points, style: { color: i % 2 ? '#c7ee92' : '#80b8ff' } });
  }
}

function visibleDrawingCount() {
  if (!chart || !store) throw new Error('Benchmark is not prepared');
  return store
    .list()
    .filter((drawing) =>
      drawing.points.every(
        (point) =>
          chart!.timeToCoordinate(point.time) !== null &&
          chart!.priceToCoordinate(point.price, drawing.paneId) !== null,
      ),
    ).length;
}

async function prepare() {
  dispose();
  chart = createChart(host, { diagnostics: true, followLatest: false, maxPixelRatio: 1 });
  series = chart.addSeries('candlestick');
  series.setData(data);
  store = createDrawingStore({ maxDrawings: 200, maxHistory: 0 });
  populateDrawings(store);
  layer = createDrawingLayer(chart, { store });
  chart.setVisibleRange({
    from: corridor.navigationFromMin,
    to: corridor.navigationFromMin + visibleBars - 1,
  });
  await chart.whenIdle();
  return state();
}

function state() {
  if (!chart || !store) throw new Error('Benchmark is not prepared');
  return {
    modelCount: store.list().length,
    visibleDrawingCount: visibleDrawingCount(),
    canvases: host.querySelectorAll('canvas').length,
    diagnostics: chart.getDiagnostics(),
    range: chart.getVisibleRange(),
  };
}

async function navigate(durationMs: number) {
  if (!chart || !store) throw new Error('Benchmark is not prepared');
  const workMs: number[] = [];
  const rawLatencyMs: number[] = [];
  const samples: Array<{
    from: number;
    mutationMs: number;
    renderMs: number;
    rawLatencyMs: number;
    primitiveDraws: number;
    sceneDraws: number;
    visibleDrawingCount: number;
  }> = [];
  const started = performance.now();
  let step = 0;
  while (performance.now() - started < durationMs) {
    const fraction = (Math.sin(step / 7) + 1) / 2;
    const from = Math.round(
      corridor.navigationFromMin + fraction * (corridor.navigationFromMax - corridor.navigationFromMin),
    );
    const previous = chart.getDiagnostics();
    const before = performance.now();
    chart.setVisibleRange({ from, to: from + visibleBars - 1 });
    const mutationMs = performance.now() - before;
    await chart.whenIdle();
    const rawLatency = performance.now() - before;
    const diagnostics = chart.getDiagnostics();
    const renderMs = diagnostics.lastRenderMs;
    workMs.push(mutationMs + renderMs);
    rawLatencyMs.push(rawLatency);
    samples.push({
      from,
      mutationMs,
      renderMs,
      rawLatencyMs: rawLatency,
      primitiveDraws: diagnostics.primitiveDraws - previous.primitiveDraws,
      sceneDraws: diagnostics.sceneDraws - previous.sceneDraws,
      visibleDrawingCount: visibleDrawingCount(),
    });
    step++;
  }
  return {
    durationMs: performance.now() - started,
    steps: step,
    workMs,
    rawLatencyMs,
    samples,
    modelCount: store.list().length,
    diagnostics: chart.getDiagnostics(),
  };
}

function dispose() {
  layer?.destroy();
  layer = null;
  chart?.destroy();
  chart = null;
  series = null;
  store = null;
}

const drawingsBenchmarkApi = {
  prepare,
  navigate,
  state,
  dispose: () => {
    dispose();
    return { canvases: host.querySelectorAll('canvas').length };
  },
  environment: () => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    dataRows: rows,
    drawings: 200,
    types: ['trend-line', 'horizontal-line', 'rectangle', 'measure'],
    corridor,
  }),
};

declare global {
  interface Window {
    drawingsBenchmarkApi: typeof drawingsBenchmarkApi;
  }
}
window.drawingsBenchmarkApi = drawingsBenchmarkApi;
