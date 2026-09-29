import {
  createChart,
  type ChartApi,
  type CandlePoint,
  type SeriesHandle,
  type TimeRange,
  type ChartChangeMeta,
  type LogicalRange,
  type CrosshairEvent,
} from '../../../packages/charts/dist/index.js';
import {
  createChartSync,
  createHistoryReplay,
  buildIndexedComparison,
  type ChartSync,
  type ReplayChange,
} from '../../../packages/analysis/dist/index.js';
import { createIndicator } from '../../../packages/indicators/dist/index.js';
import { makeCandles } from './fixtures';

const rows = 100000,
  visible = 1000,
  seed = 404;
const data = makeCandles(rows, { seed, price: 100, step: 60000 });
const other = makeCandles(rows, { seed: 405, price: 300, step: 60000 }).filter(
  (_, i) => i === 0 || i % 5 !== 0,
);
type Probe = { calls: number; effective: number; mutationMs: number; callbackMs: number };
let charts: ChartApi[] = [],
  series: SeriesHandle[] = [],
  probes: Probe[] = [];
let sync: ChartSync | null = null;
const indicator = createIndicator('ema', 20);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const equalRange = (a: TimeRange | null, b: TimeRange | null) =>
  !!a && !!b && a.from === b.from && a.to === b.to;
function expectedRanges(from: number, to: number): TimeRange[] {
  let first = from,
    last = to;
  while (first > 0 && first % 5 === 0) first++;
  while (last > 0 && last % 5 === 0) last--;
  const full = { from: data[from]!.time, to: data[to]!.time };
  return [full, { from: data[first]!.time, to: data[last]!.time }, full];
}
const diagnostics = () => charts.map((chart) => chart.getDiagnostics());
const revisions = () => charts.map((chart) => chart.getChangeRevision());
const ranges = () => charts.map((chart) => chart.getVisibleTimeRange());
async function settle() {
  for (let pass = 0; pass < 8; pass++) {
    await Promise.all(charts.map((chart) => chart.whenIdle()));
    if (charts.every((chart) => !chart.getDiagnostics().framePending)) return pass + 1;
  }
  throw new Error('Synchronized scene did not settle within eight frame passes');
}
async function stableTurn() {
  const before = { revisions: revisions(), diagnostics: diagnostics() };
  await frame();
  await frame();
  const after = { revisions: revisions(), diagnostics: diagnostics() };
  return (
    before.revisions.every((value, i) => value === after.revisions[i]) &&
    before.diagnostics.every(
      (value, i) =>
        value.sceneDraws === after.diagnostics[i]!.sceneDraws &&
        value.overlayDraws === after.diagnostics[i]!.overlayDraws &&
        !after.diagnostics[i]!.framePending,
    )
  );
}
function dispose() {
  sync?.destroy();
  sync = null;
  for (const chart of charts) chart.destroy();
  charts = [];
  series = [];
  probes = [];
}
async function prepare() {
  dispose();
  charts = ['a', 'b', 'c'].map((id) =>
    createChart(document.getElementById(id)!, {
      diagnostics: true,
      followLatest: false,
      maxPixelRatio: 1,
      theme: { fontFamily: 'Consolas, monospace' },
    }),
  );
  series = [
    charts[0]!.addSeries('candlestick', { id: 'master' }),
    charts[0]!.addSeries('line', { id: 'ema', color: '#d5ac66', lastValueVisible: false }),
    charts[1]!.addSeries('candlestick', { id: 'sparse' }),
    charts[2]!.addSeries('line', { id: 'index-a', color: '#c7ee92', lastValueVisible: false }),
    charts[2]!.addSeries('line', { id: 'index-b', color: '#96aee8', lastValueVisible: false }),
  ];
  series[0]!.setData(data);
  series[2]!.setData(other);
  indicator.setData(data.map((bar) => ({ time: bar.time, value: bar.close })));
  series[1]!.setData(indicator.getData());
  const comparison = buildIndexedComparison([
    { id: 'a', points: data.map((bar) => ({ time: bar.time, value: bar.close })) },
    { id: 'b', points: other.map((bar) => ({ time: bar.time, value: bar.close })) },
  ]);
  series[3]!.setData(comparison[0]!.points);
  series[4]!.setData(comparison[1]!.points);
  charts[0]!.setVisibleRange({ from: 49000, to: 49999 });
  charts[1]!.setVisibleRange({ from: 100, to: 1099 });
  charts[2]!.setVisibleRange({ from: 200, to: 1199 });
  const initialTargets = ranges().slice(1);
  probes = charts.map(() => ({ calls: 0, effective: 0, mutationMs: 0, callbackMs: 0 }));
  // Public APIs are frozen. Each facade delegates to the same live chart;
  // instrumentation never replaces methods on the actual library object.
  charts = charts.map((chart, i): ChartApi => {
    const probe = probes[i]!;
    return {
      ...chart,
      get timeDomain() {
        return chart.timeDomain;
      },
      setVisibleTimeRange(range, meta) {
        const revision = chart.getChangeRevision(),
          before = performance.now();
        try {
          return chart.setVisibleTimeRange(range, meta);
        } finally {
          probe.mutationMs += performance.now() - before;
          probe.calls++;
          if (chart.getChangeRevision() !== revision) probe.effective++;
        }
      },
      subscribeVisibleRangeChange(callback) {
        return chart.subscribeVisibleRangeChange((range: LogicalRange, meta: ChartChangeMeta) => {
          const before = performance.now();
          try {
            callback(range, meta);
          } finally {
            probe.callbackMs += performance.now() - before;
          }
        });
      },
      subscribeCrosshairMove(callback) {
        return chart.subscribeCrosshairMove((event: CrosshairEvent, meta: ChartChangeMeta) => {
          const before = performance.now();
          try {
            callback(event, meta);
          } finally {
            probe.callbackMs += performance.now() - before;
          }
        });
      },
    };
  });
  sync = createChartSync(charts);
  await settle();
  const expected = expectedRanges(49000, 49999),
    applied = ranges();
  return {
    initialTargets,
    applied,
    expected,
    initialized:
      applied.every((range, i) => equalRange(range, expected[i]!)) &&
      initialTargets.every((range, i) => !equalRange(range, expected[i + 1]!)),
    stable: await stableTurn(),
    canvases: document.querySelectorAll('canvas').length,
    diagnostics: diagnostics(),
  };
}
async function navigate(durationMs: number) {
  const samples: Array<{
    from: number;
    requested: TimeRange[];
    actual: Array<TimeRange | null>;
    aligned: boolean;
    mutations: number[];
    effective: number[];
    mutationMs: number[];
    callbackMs: number[];
    sceneDraws: number[];
    renderMs: number[];
    revisions: number[];
    passes: number;
    workMs: number;
    rawLatencyMs: number;
  }> = [];
  const started = performance.now();
  for (let step = 0; performance.now() - started < durationMs; step++) {
    const from = 49100 + ((step * 13) % 390);
    const expected = expectedRanges(from, from + visible - 1);
    const beforeDiagnostics = diagnostics(),
      beforeProbes = probes.map((probe) => ({ ...probe }));
    const before = performance.now();
    charts[0]!.setVisibleTimeRange(expected[0]!);
    const passes = await settle(),
      rawLatencyMs = performance.now() - before;
    const afterDiagnostics = diagnostics();
    const mutationMs = probes.map((probe, i) => probe.mutationMs - beforeProbes[i]!.mutationMs);
    const callbackMs = probes.map((probe, i) => probe.callbackMs - beforeProbes[i]!.callbackMs);
    const draws = afterDiagnostics.map((value, i) => value.sceneDraws - beforeDiagnostics[i]!.sceneDraws);
    const renderMs = afterDiagnostics.map((value, i) => (draws[i] === 1 ? value.lastRenderMs : NaN));
    // Target setter work is inside the helper callback timing. Do not count it twice.
    const workMs =
      mutationMs[0]! +
      callbackMs.reduce((sum, value) => sum + value, 0) +
      renderMs.reduce((sum, value) => sum + value, 0);
    const actual = ranges();
    samples.push({
      from,
      requested: expected,
      actual,
      aligned: actual.every((range, i) => equalRange(range, expected[i]!)),
      mutations: probes.map((probe, i) => probe.calls - beforeProbes[i]!.calls),
      effective: probes.map((probe, i) => probe.effective - beforeProbes[i]!.effective),
      mutationMs,
      callbackMs,
      sceneDraws: draws,
      renderMs,
      revisions: revisions(),
      passes,
      workMs,
      rawLatencyMs,
    });
  }
  const elapsedMs = performance.now() - started;
  return { requestedDurationMs: durationMs, elapsedMs, samples, stable: await stableTurn() };
}
function normalized(bar: CandlePoint, baseline: CandlePoint, id: string) {
  const points = [{ time: baseline.time, value: baseline.close }];
  if (bar.time !== baseline.time) points.push({ time: bar.time, value: bar.close });
  return buildIndexedComparison([{ id, points }])[0]!.points.at(-1)!;
}
async function replayScenario() {
  sync?.destroy();
  sync = null;
  let callbacks = 0;
  let appMs = 0;
  const apply = (change: ReplayChange) => {
    const before = performance.now();
    callbacks++;
    try {
      if (change.type === 'reset') {
        const cutoff = change.bars.at(-1)?.time;
        const sparse = cutoff === undefined ? [] : other.filter((bar) => Number(bar.time) <= Number(cutoff));
        series[0]!.setData(change.bars);
        series[2]!.setData(sparse);
        indicator.setData(change.bars.map((bar) => ({ time: bar.time, value: bar.close })));
        series[1]!.setData(indicator.getData());
        if (!change.bars.length) {
          series[3]!.setData([]);
          series[4]!.setData([]);
        } else {
          const indexed = buildIndexedComparison([
            { id: 'a', points: change.bars.map((bar) => ({ time: bar.time, value: bar.close })) },
            { id: 'b', points: sparse.map((bar) => ({ time: bar.time, value: bar.close })) },
          ]);
          series[3]!.setData(indexed[0]!.points);
          series[4]!.setData(indexed[1]!.points);
        }
      } else {
        for (const bar of change.bars) {
          series[0]!.update(bar);
          series[1]!.update(indicator.update({ time: bar.time, value: bar.close }));
          series[3]!.update(normalized(bar, data[0]!, 'a'));
          const index = Math.round((Number(bar.time) - Number(data[0]!.time)) / 60000);
          if (index === 0 || index % 5 !== 0) {
            const sparseIndex = index - Math.floor(index / 5);
            const next = other[sparseIndex]!;
            series[2]!.update(next);
            series[4]!.update(normalized(next, other[0]!, 'b'));
          }
        }
      }
    } finally {
      appMs += performance.now() - before;
    }
  };
  const constructStarted = performance.now();
  const replay = createHistoryReplay({ bars: data, barsPerSecond: 64, onChange: apply });
  const constructorMs = performance.now() - constructStarted;
  function observedPrefix(position: number) {
    // Independent numeric oracle, evaluated only after timed work.
    const prefix = data.slice(0, position);
    const cutoff = position ? Number(data[position - 1]!.time) : -Infinity;
    const sparse = other.filter((bar) => Number(bar.time) <= cutoff);
    let seedSum = 0,
      current = 0;
    const emaExpected = prefix.map((bar, index) => {
      if (index < 20) seedSum += bar.close;
      if (index < 19) return { time: bar.time };
      current = index === 19 ? seedSum / 20 : (2 / 21) * bar.close + (19 / 21) * current;
      return { time: bar.time, value: current };
    });
    const expected = [
      prefix,
      emaExpected,
      sparse,
      prefix.map((bar) => ({ time: bar.time, value: (100 * bar.close) / data[0]!.close })),
      sparse.map((bar) => ({ time: bar.time, value: (100 * bar.close) / other[0]!.close })),
    ];
    // Snapshot once per oracle; never copy growing histories in the append loop.
    const snapshots = series.map((item) => item.getData());
    const seriesCorrect = snapshots.map(
      (points, seriesIndex) =>
        points.length === expected[seriesIndex]!.length &&
        points.every((point, pointIndex) => {
          const wanted = expected[seriesIndex]![pointIndex]!;
          const actualFields = Object.entries(point),
            wantedFields = Object.entries(wanted);
          return (
            actualFields.length === wantedFields.length &&
            wantedFields.every(([key, value]) => {
              const actual = actualFields.find(([field]) => field === key)?.[1];
              if (
                typeof actual !== 'number' ||
                typeof value !== 'number' ||
                !Number.isFinite(actual) ||
                !Number.isFinite(value)
              )
                return false;
              return key === 'value'
                ? Math.abs(actual - value) <= 1e-10 * Math.max(1, Math.abs(value))
                : actual === value;
            }) &&
            Number(point.time) <= cutoff
          );
        }),
    );
    return {
      position,
      counts: snapshots.map((points) => points.length),
      expectedCounts: expected.map((points) => points.length),
      seriesCorrect,
      correct: seriesCorrect.every(Boolean),
    };
  }
  try {
    replay.seek(0);
    await settle();
    const empty = observedPrefix(0);
    const appendMs: number[] = [],
      callbackBefore = callbacks,
      appBefore = appMs;
    for (let i = 0; i < 1000; i++) {
      const before = performance.now();
      replay.step();
      appendMs.push(performance.now() - before);
    }
    for (const chart of charts) chart.scrollToLatest();
    await settle();
    const appended = observedPrefix(1000),
      appendCallbackMs = appMs - appBefore;
    const appendCallbacks = callbacks - callbackBefore;
    const seekStarted = performance.now();
    replay.seek(37);
    const resetMs = performance.now() - seekStarted;
    for (const chart of charts) chart.scrollToLatest();
    await settle();
    const sought = observedPrefix(37);
    const playStart = replay.getState().position,
      playCallbacks = callbacks;
    const playStartedAt = performance.now();
    replay.play();
    while (replay.getState().position === playStart && performance.now() - playStartedAt < 2000)
      await delay(10);
    const playWaitMs = performance.now() - playStartedAt;
    replay.pause();
    await settle();
    const pausedState = replay.getState(),
      pausedCallbacks = callbacks;
    await delay(40);
    const pausedStable = callbacks === pausedCallbacks && replay.getState().position === pausedState.position;
    const pausedPrefix = observedPrefix(pausedState.position);
    replay.destroy();
    const destroyed = replay.getState(),
      destroyedCallbacks = callbacks;
    await delay(25);
    return {
      constructorMs,
      appendMs,
      appendCallbackMs,
      appendCallbacks,
      resetMs,
      empty,
      appended,
      sought,
      pausedPrefix,
      playStart,
      playWaitMs,
      playedForward: pausedState.position > playStart && callbacks > playCallbacks,
      pausedStable,
      destroyed,
      destroyedStable: callbacks === destroyedCallbacks,
      chartsStable: await stableTurn(),
    };
  } finally {
    replay.destroy();
  }
}
const analysisBenchmarkApi = {
  prepare,
  navigate,
  replay: replayScenario,
  dispose: () => {
    dispose();
    return { canvases: document.querySelectorAll('canvas').length };
  },
  environment: () => ({
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    userAgent: navigator.userAgent,
    visible: document.visibilityState,
    hardwareConcurrency: navigator.hardwareConcurrency,
    scene: {
      rows,
      sparseRows: other.length,
      visibleBars: visible,
      seed,
      otherSeed: 405,
      charts: 3,
      series: 5,
      emaPeriod: 20,
    },
  }),
};
declare global {
  interface Window {
    analysisBenchmarkApi: typeof analysisBenchmarkApi;
  }
}
window.analysisBenchmarkApi = analysisBenchmarkApi;
