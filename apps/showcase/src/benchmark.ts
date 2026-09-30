// Benchmarks consume the built, self-contained chart package.
import { createChart, type ChartApi, type SeriesHandle } from '../../../packages/charts/dist/index.js';
import type { CandlePoint } from '@filtrix.net/core';
import { makeCandles, closeValues } from './fixtures';
import { ema } from '../../../packages/indicators/dist/index.js';

type MatrixFixture = 'flat' | 'negative' | 'gaps';
type Condition = { elapsedMs: number; visibility: DocumentVisibilityState; focused: boolean };

let chart: ChartApi | undefined,
  series: SeriesHandle | undefined,
  data: CandlePoint[] = [];
const host = document.querySelector<HTMLElement>('#host')!;
const benchmarkFont = {
  localFamily: 'Consolas',
  chartFamily: '"FILTRIX Benchmark Consolas"',
  sizePx: 11,
} as const;
let benchmarkFontLoaded = false;
let benchmarkFontError: string | null = null;
const fixture = (count: number) => makeCandles(count, { seed: 73, price: 100, step: 60_000 });

function matrixFixture(kind: MatrixFixture, count = 1_000): CandlePoint[] {
  const start = Date.UTC(2026, 5, 1);
  if (kind === 'flat') {
    return Array.from({ length: count }, (_, i) => ({
      time: start + i * 60_000,
      open: 42,
      high: 42,
      low: 42,
      close: 42,
      volume: 100,
    }));
  }
  if (kind === 'negative') {
    return Array.from({ length: count }, (_, i) => {
      const open = -20 + Math.sin(i / 13) * 4;
      const close = open + Math.cos(i / 7) * 0.75;
      return {
        time: start + i * 60_000,
        open,
        high: Math.max(open, close) + 0.5,
        low: Math.min(open, close) - 0.5,
        close,
        volume: 100 + (i % 17),
      };
    });
  }
  return fixture(count).map((point, i) => ({
    ...point,
    time: Number(point.time) + Math.floor(i / 125) * 3_600_000,
  }));
}

async function prepareEnvironment() {
  try {
    const face = new FontFace('FILTRIX Benchmark Consolas', 'local("Consolas")');
    await face.load();
    document.fonts.add(face);
    const loaded = await document.fonts.load(benchmarkFont.sizePx + 'px ' + benchmarkFont.chartFamily);
    await document.fonts.ready;
    benchmarkFontLoaded = loaded.length > 0;
    benchmarkFontError = benchmarkFontLoaded ? null : 'The local font resolved no loaded face.';
  } catch (error) {
    benchmarkFontLoaded = false;
    benchmarkFontError = error instanceof Error ? error.message : String(error);
  }
  return {
    localFamily: benchmarkFont.localFamily,
    chartFamily: benchmarkFont.chartFamily,
    sizePx: benchmarkFont.sizePx,
    loaded: benchmarkFontLoaded,
    error: benchmarkFontError,
  };
}

function condition() {
  return { visibility: document.visibilityState, focused: document.hasFocus() };
}

function conditionTracker() {
  const started = performance.now();
  const observations: Condition[] = [];
  let samples = 0,
    allVisible = true,
    allFocused = true,
    previous = '';
  const sample = () => {
    const current = condition();
    samples++;
    allVisible &&= current.visibility === 'visible';
    allFocused &&= current.focused;
    const key = current.visibility + ':' + current.focused;
    if (key !== previous) {
      observations.push({ elapsedMs: performance.now() - started, ...current });
      previous = key;
    }
  };
  return {
    sample,
    result: () => ({ samples, allVisible, allFocused, observations }),
  };
}

async function loadData(next: CandlePoint[], dense = false) {
  chart?.destroy();
  data = next;
  const conditions = conditionTracker();
  conditions.sample();
  const coldStart = performance.now();
  chart = createChart(host, {
    theme: { fontFamily: benchmarkFont.chartFamily, fontSize: benchmarkFont.sizePx },
    diagnostics: true,
    followLatest: false,
    maxPixelRatio: 1,
  });
  series = chart.addSeries('candlestick');
  await chart.whenIdle();
  const constructionMs = performance.now() - coldStart;
  const start = performance.now();
  series.setData(data);
  const ingestMs = performance.now() - start;
  if (dense) chart.fitContent();
  else chart.setVisibleRange({ from: Math.max(0, data.length - 1_000), to: data.length - 1 });
  await chart.whenIdle();
  conditions.sample();
  return {
    constructionMs,
    ingestMs,
    settledMs: performance.now() - start,
    diagnostics: chart.getDiagnostics(),
    conditions: conditions.result(),
  };
}

async function load(count: number, dense = false) {
  return loadData(fixture(count), dense);
}

async function matrix(kind: MatrixFixture) {
  const points = matrixFixture(kind);
  return {
    kind,
    count: points.length,
    generator: 'deterministic benchmark matrix v1',
    sample: await loadData(points),
  };
}

async function navigation(durationMs: number) {
  if (!chart) throw new Error('Load first');
  const conditions = conditionTracker();
  conditions.sample();
  const start = performance.now();
  const work: number[] = [],
    settled: number[] = [];
  let steps = 0;
  while (performance.now() - start < durationMs) {
    const from = 20_000 + Math.sin(steps / 20) * 10_000;
    const before = performance.now();
    chart.setVisibleRange({ from, to: from + 999 });
    const mutationMs = performance.now() - before;
    await chart.whenIdle();
    settled.push(performance.now() - before);
    work.push(mutationMs + chart.getDiagnostics().lastRenderMs);
    conditions.sample();
    steps++;
  }
  return {
    work,
    settled,
    steps,
    durationMs: performance.now() - start,
    mode: 'public-API viewport navigation',
    conditions: conditions.result(),
  };
}

async function prepareLiveTail() {
  if (!chart) throw new Error('Load first');
  chart.applyOptions({ followLatest: true });
  chart.scrollToLatest();
  await chart.whenIdle();
}

async function stream(durationMs: number) {
  if (!chart || !series) throw new Error('Load first');
  await prepareLiveTail();
  const conditions = conditionTracker();
  conditions.sample();
  const start = performance.now();
  const updates: number[] = [],
    work: number[] = [],
    tailVisibleSamples: boolean[] = [],
    tailVisibilityFailures: Array<{
      update: number;
      coordinate: number | null;
      range: { from: number; to: number; newestIndex: number };
    }> = [];
  const initialLength = data.length;
  let last = data[data.length - 1]!;
  let appends = 0;
  const count = Math.floor(durationMs / 100);
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, start + (i + 1) * 100 - performance.now())),
    );
    const value = last.close + (i % 2 ? 0.01 : -0.01);
    last =
      i % 8 === 7
        ? {
            time: Number(last.time) + 60_000,
            open: last.close,
            high: Math.max(last.close, value),
            low: Math.min(last.close, value),
            close: value,
            volume: 1,
          }
        : {
            ...last,
            high: Math.max(last.high, value),
            low: Math.min(last.low, value),
            close: value,
            volume: (last.volume ?? 0) + 1,
          };
    if (i % 8 === 7) appends++;
    const before = performance.now();
    series.update(last);
    await chart.whenIdle();
    updates.push(performance.now() - before);
    work.push(chart.getDiagnostics().lastRenderMs);
    const range = chart.getVisibleRange();
    const coordinate = chart.timeToCoordinate(last.time);
    const newestIndex = initialLength + appends - 1;
    const tailVisible = coordinate !== null && range.from <= newestIndex && range.to >= newestIndex;
    tailVisibleSamples.push(tailVisible);
    if (!tailVisible)
      tailVisibilityFailures.push({ update: i + 1, coordinate, range: { ...range, newestIndex } });
    conditions.sample();
  }
  const measuredDurationMs = performance.now() - start;
  const actual = series.getData();
  return {
    updates,
    work,
    durationMs: measuredDurationMs,
    frequencyHz: 10,
    accepted: count,
    expectedAccepted: count,
    expectedLength: initialLength + appends,
    actualLength: actual.length,
    finalMatches: JSON.stringify(actual.at(-1)) === JSON.stringify(last),
    tailVisibleEveryUpdate: tailVisibleSamples.every(Boolean),
    tailVisibleSamples,
    tailVisibilityFailures,
    finalVisibleRange: chart.getVisibleRange(),
    finalTailCoordinate: chart.timeToCoordinate(last.time),
    conditions: conditions.result(),
  };
}

async function burst() {
  if (!chart || !series) throw new Error('Load first');
  await prepareLiveTail();
  const conditions = conditionTracker();
  conditions.sample();
  const last = data.at(-1) as CandlePoint;
  const count = data.length;
  const draws = chart.getDiagnostics().sceneDraws;
  const start = performance.now();
  let expected = last;
  for (let i = 1; i <= 100; i++) {
    expected = { ...last, time: Number(last.time) + i * 60_000 };
    series.update(expected);
  }
  const framePendingAfterDispatch = chart.getDiagnostics().framePending;
  await chart.whenIdle();
  const settledMs = performance.now() - start;
  const sceneDraws = chart.getDiagnostics().sceneDraws - draws;
  const actual = series.getData();
  const range = chart.getVisibleRange();
  const newestIndex = actual.length - 1;
  const finalTailCoordinate = chart.timeToCoordinate(expected.time);
  conditions.sample();
  return {
    settledMs,
    accepted: 100,
    length: actual.length,
    expectedLength: count + 100,
    finalMatches: JSON.stringify(actual.at(-1)) === JSON.stringify(expected),
    sceneDraws,
    framePendingAfterDispatch,
    pendingFramesAfterDispatch: framePendingAfterDispatch ? 1 : 0,
    finalTailCoordinate,
    finalTailVisible: finalTailCoordinate !== null && range.from <= newestIndex && range.to >= newestIndex,
    finalVisibleRange: range,
    conditions: conditions.result(),
  };
}
async function practical() {
  const conditions = conditionTracker();
  conditions.sample();
  const started = performance.now();
  const result = await load(100_000);
  if (!chart) throw new Error('Load first');
  const additionalSceneStarted = performance.now();
  const volumePane = chart.addPane({ id: 'volume', weight: 1 });
  const volume = chart.addSeries('histogram', { paneId: volumePane.id });
  volume.setData(data.map((point) => ({ time: point.time, value: point.volume ?? 0 })));
  const line = chart.addSeries('line', { color: '#b48d41' });
  line.setData(ema(closeValues(data), 20));
  await chart.whenIdle();
  conditions.sample();
  return {
    singleSeriesLoad: result,
    additionalSceneSettledMs: performance.now() - additionalSceneStarted,
    totalSettledMs: performance.now() - started,
    diagnostics: chart.getDiagnostics(),
    conditions: conditions.result(),
    note: 'Candles, volume, and EMA(20); diagnostic only, outside the single-series gates',
  };
}

async function memoryCycles() {
  const conditions = conditionTracker();
  for (let i = 0; i < 30; i++) {
    conditions.sample();
    const local = createChart(host);
    local.addSeries('candlestick').setData(fixture(1_000));
    local.destroy();
  }
  conditions.sample();
  return {
    ownedCanvases: host.querySelectorAll('canvas').length,
    userAgentMemory: 'unavailable (no cross-origin-isolated harness; not estimated)',
    conditions: conditions.result(),
  };
}

function environment() {
  const canvas = document.createElement('canvas'),
    gl = canvas.getContext('webgl');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  const fontCss = benchmarkFont.sizePx + 'px ' + benchmarkFont.chartFamily;
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
    hardwareConcurrency: navigator.hardwareConcurrency,
    gpu: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    font: {
      localFamily: benchmarkFont.localFamily,
      chartFamily: benchmarkFont.chartFamily,
      sizePx: benchmarkFont.sizePx,
      css: fontCss,
      loaded: document.fonts.status === 'loaded' && benchmarkFontLoaded,
      available: benchmarkFontLoaded && document.fonts.check(fontCss),
      error: benchmarkFontError,
      source: 'FontFace local("Consolas"); explicit local system font, no network font',
    },
  };
}

const benchmarkApi = {
  prepareEnvironment,
  load,
  matrix,
  navigation,
  stream,
  burst,
  practical,
  memoryCycles,
  environment,
  condition,
  fixture,
  matrixFixture,
  destroy: () => chart?.destroy(),
};
declare global {
  interface Window {
    benchmarkApi: typeof benchmarkApi;
  }
}
window.benchmarkApi = benchmarkApi;

if (!new URLSearchParams(location.search).has('automated')) {
  const panel = document.createElement('section');
  panel.style.cssText =
    'position:fixed;left:20px;top:20px;z-index:3;width:310px;padding:22px;background:#14181cf5;color:#e5e9e7;border:1px solid #354238;border-radius:8px;font:12px/1.7 Consolas,monospace;box-shadow:0 10px 40px #0003';
  const heading = document.createElement('h1');
  heading.textContent = 'FILTRIX / BENCHMARK';
  heading.style.cssText = 'font-size:15px;color:#c7ee92;margin:0 0 12px';
  const description = document.createElement('p');
  description.textContent =
    'Measure 100,000 synthetic candles on your browser. These timings describe JavaScript work and render submission, not monitor latency.';
  const run = document.createElement('button');
  run.textContent = 'Run local sample →';
  run.style.cssText =
    'padding:9px 12px;color:#14181c;background:#c7ee92;border:0;border-radius:4px;cursor:pointer;font:inherit';
  const result = document.createElement('pre');
  result.style.cssText = 'white-space:pre-wrap;font:11px/1.8 Consolas,monospace';
  const link = document.createElement('a');
  link.href = '/';
  link.textContent = '← Back to workspace';
  link.style.cssText = 'display:block;margin-top:15px;color:#aebcad';
  run.addEventListener('click', async () => {
    run.disabled = true;
    try {
      const sample = await load(100_000);
      result.textContent =
        'Rows: 100,000\nSynchronous ingest: ' +
        sample.ingestMs.toFixed(2) +
        ' ms\nThrough submission: ' +
        sample.settledMs.toFixed(2) +
        ' ms\nDraw work: ' +
        sample.diagnostics.lastRenderMs.toFixed(2) +
        ' ms\n\nSingle sample · not a reference run\nUse npm run benchmark for the full suite.';
    } finally {
      run.disabled = false;
    }
  });
  panel.append(heading, description, run, result, link);
  document.body.append(panel);
  void load(10_000);
}
