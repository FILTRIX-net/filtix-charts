import './analysis.css';
import {
  createChart,
  darkTheme,
  lightTheme,
  type CandlePoint,
  type TimeRange,
  type SeriesHandle,
} from '@filtrix.net/charts';
import {
  buildIndexedComparison,
  createChartSync,
  createHistoryReplay,
  type ChartSync,
  type ReplayChange,
  type ReplayState,
} from '@filtrix.net/analysis';
import { createIndicator } from '@filtrix.net/indicators';
import { makeCandles } from './fixtures';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const assets = ['btc', 'eth', 'sol'] as const;
type Asset = (typeof assets)[number];
const storageKey = 'filtix.charts.analysis.v1';
const dataset = 'linked-hourly-v1';
const start = Date.UTC(2026, 5, 1);
const hour = 3600000;
const fixture: Record<Asset, CandlePoint[]> = {
  btc: makeCandles(720, { seed: 73, price: 62400, start, step: hour }),
  eth: makeCandles(720, { seed: 112, price: 3280, start, step: hour }).filter(
    (_, i) => i === 0 || i % 17 !== 0,
  ),
  sol: makeCandles(720, { seed: 38, price: 145, start, step: hour }).filter(
    (_, i) => i === 0 || i % 11 !== 0,
  ),
};
const masterTimes = new Set(fixture.btc.map((bar) => Number(bar.time)));
for (const asset of assets)
  if (fixture[asset].some((bar) => !masterTimes.has(Number(bar.time))))
    throw new Error('Sample asset is outside the master clock.');
const byTime = Object.fromEntries(
  assets.map((asset) => [asset, new Map(fixture[asset].map((bar) => [Number(bar.time), bar]))]),
) as Record<Asset, Map<number, CandlePoint>>;
let shown: Record<Asset, CandlePoint[]> = { btc: [], eth: [], sol: [] };
let shownByTime: Record<Asset, Map<number, CandlePoint>> = { btc: new Map(), eth: new Map(), sol: new Map() };
let basePrices: Record<Asset, number> | null = null;
let baselineTime: number | null = null;
let inspectedTime: number | null = null;
let theme: 'dark' | 'light' = 'dark';
let sync: ChartSync | null = null;
let disposed = false;
const listeners = new AbortController();
const workspaceOrigin = {};
const format = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (time: number) => new Date(time).toISOString().slice(0, 16).replace('T', ' ');
const text = (id: string, value: string) => {
  if (el(id).textContent !== value) el(id).textContent = value;
};
const palette = () => ({
  ...(theme === 'dark' ? darkTheme : lightTheme),
  background: theme === 'dark' ? '#14181c' : '#fbfcf9',
  fontFamily: 'Consolas, monospace',
  fontSize: 10,
});
const charts = ['btc', 'eth', 'comparison'].map((name) =>
  createChart(el('analysis-' + name + '-chart'), {
    autoSize: true,
    followLatest: false,
    timeDomain: 'utc-ms',
    theme: palette(),
    ariaLabel:
      name === 'comparison'
        ? 'Indexed Bitcoin Ethereum Solana comparison. Only revealed historical data.'
        : name.toUpperCase() + ' historical price. Arrow keys pan; linked charts share loaded dates.',
  }),
);
const btc = charts[0]!.addSeries('candlestick', { id: 'btc', pricePrecision: 2 });
const ema = charts[0]!.addSeries('line', {
  id: 'ema',
  color: '#d5ac66',
  lineWidth: 1.5,
  pricePrecision: 2,
  lastValueVisible: false,
  priceLineVisible: false,
});
const volumePane = charts[0]!.addPane({ id: 'volume', weight: 0.22 });
const volume = charts[0]!.addSeries('histogram', {
  id: 'volume',
  paneId: volumePane.id,
  lastValueVisible: false,
  priceLineVisible: false,
});
const eth = charts[1]!.addSeries('candlestick', {
  id: 'eth',
  upColor: '#96aee8',
  downColor: '#b77c94',
  pricePrecision: 2,
});
const colors: Record<Asset, string> = { btc: '#c7ee92', eth: '#96aee8', sol: '#d5ac66' };
const indexed = Object.fromEntries(
  assets.map((asset) => [
    asset,
    charts[2]!.addSeries('line', {
      id: asset,
      color: colors[asset],
      lineWidth: 1.7,
      pricePrecision: 2,
      lastValueVisible: false,
      priceLineVisible: false,
    }),
  ]),
) as Record<Asset, SeriesHandle>;
const indicator = createIndicator('ema', 20);
function reconnectSync() {
  sync?.destroy();
  sync = null;
  if (!disposed && el<HTMLInputElement>('analysis-sync').checked) sync = createChartSync(charts);
}
function updateQuotes() {
  for (const asset of assets) {
    const bar = inspectedTime === null ? shown[asset].at(-1) : shownByTime[asset].get(inspectedTime);
    if (asset !== 'sol') {
      text('analysis-' + asset + '-price', bar ? format(bar.close) : '—');
      text('analysis-' + asset + '-time', bar ? date(Number(bar.time)) + ' UTC' : 'No bar at this time');
    }
    text(
      'analysis-' + asset + '-index',
      bar && basePrices ? format((100 * bar.close) / basePrices[asset]) : '—',
    );
  }
}
function follow() {
  if (!el<HTMLInputElement>('analysis-follow').checked) return;
  for (const chart of charts) {
    const count = chart === charts[1] ? shown.eth.length : shown.btc.length;
    chart.setVisibleRange({ from: Math.max(0, count - 120), to: Math.max(1, count - 1) });
  }
}
function resetComparison() {
  if (!shown.btc.length) {
    for (const asset of assets) indexed[asset].setData([]);
    basePrices = null;
    baselineTime = null;
    text('analysis-base', 'Reveal history to establish a common baseline.');
    return;
  }
  const result = buildIndexedComparison(
    assets.map((id) => ({ id, points: shown[id].map((bar) => ({ time: bar.time, value: bar.close })) })),
  );
  basePrices = {} as Record<Asset, number>;
  for (const item of result) {
    indexed[item.id as Asset].setData(item.points);
    basePrices[item.id as Asset] = item.baseline.value;
  }
  baselineTime = Number(result[0]!.baseline.time);
  text('analysis-base', '100 at ' + date(baselineTime) + ' UTC · Exact common baseline');
}
function updateIndex(asset: Asset, bar: CandlePoint) {
  if (!basePrices || baselineTime === null) return;
  const points = [{ time: baselineTime, value: basePrices[asset] }];
  if (Number(bar.time) !== baselineTime) points.push({ time: Number(bar.time), value: bar.close });
  const normalized = buildIndexedComparison([{ id: asset, points }], { baselineTime })[0]!.points.at(-1)!;
  indexed[asset].update(normalized);
}
function applyReplay(change: ReplayChange) {
  if (disposed) return;
  if (change.type === 'reset') {
    sync?.destroy();
    sync = null;
    inspectedTime = null;
    for (const chart of charts) chart.setCrosshairTime(null, { origin: workspaceOrigin });
    const cutoff = change.bars.at(-1)?.time;
    shown = {
      btc: change.bars.map((bar) => ({ ...bar })),
      eth: cutoff === undefined ? [] : fixture.eth.filter((bar) => Number(bar.time) <= Number(cutoff)),
      sol: cutoff === undefined ? [] : fixture.sol.filter((bar) => Number(bar.time) <= Number(cutoff)),
    };
    shownByTime = Object.fromEntries(
      assets.map((asset) => [asset, new Map(shown[asset].map((bar) => [Number(bar.time), bar]))]),
    ) as Record<Asset, Map<number, CandlePoint>>;
    btc.setData(shown.btc);
    eth.setData(shown.eth);
    volume.setData(shown.btc.map((bar) => ({ time: bar.time, value: bar.volume ?? 0 })));
    indicator.setData(shown.btc.map((bar) => ({ time: bar.time, value: bar.close })));
    ema.setData(indicator.getData());
    resetComparison();
    follow();
    reconnectSync();
  } else {
    for (const bar of change.bars) {
      for (const asset of assets) {
        const next = asset === 'btc' ? bar : byTime[asset].get(Number(bar.time));
        if (!next) continue;
        shown[asset].push(next);
        shownByTime[asset].set(Number(next.time), next);
        if (asset === 'btc') {
          btc.update(next);
          volume.update({ time: next.time, value: next.volume ?? 0 });
          ema.update(indicator.update({ time: next.time, value: next.close }));
        } else if (asset === 'eth') eth.update(next);
        if (basePrices) updateIndex(asset, next);
      }
      if (!basePrices) resetComparison();
    }
    follow();
  }
  updateQuotes();
}
function renderState(state: ReplayState) {
  if (disposed) return;
  text('analysis-position', String(state.position));
  text(
    'analysis-status',
    state.status === 'playing' ? 'Playing' : state.status === 'ended' ? 'End of history' : 'Paused',
  );
  text(
    'analysis-time',
    state.position ? date(Number(fixture.btc[state.position - 1]!.time)) + ' UTC' : 'Before the first bar',
  );
  text('analysis-play', state.status === 'playing' ? 'Ⅱ Pause' : '▶ Play');
  el<HTMLButtonElement>('analysis-play').disabled = state.position === state.total;
  el<HTMLButtonElement>('analysis-step').disabled = state.position === state.total;
  el<HTMLInputElement>('analysis-seek').value = String(state.position);
  el<HTMLInputElement>('analysis-seek').setAttribute(
    'aria-valuetext',
    state.position + ' of ' + state.total + ' bars revealed',
  );
  const speed = el<HTMLSelectElement>('analysis-speed');
  const value = String(state.barsPerSecond);
  if (![...speed.options].some((option) => option.value === value))
    speed.add(new Option(value + ' bars/s', value));
  speed.value = value;
}
const replay = createHistoryReplay({
  bars: fixture.btc,
  barsPerSecond: 4,
  onChange: applyReplay,
  onState: renderState,
});
const offs = charts.map((chart) =>
  chart.subscribeCrosshairMove((event, meta) => {
    if (disposed || meta.origin) return;
    inspectedTime = event.time === null ? null : Number(event.time);
    updateQuotes();
  }),
);
function error(reason: unknown) {
  if (disposed) return;
  text('analysis-error', reason instanceof Error ? reason.message : String(reason));
  el('analysis-error').hidden = false;
}
function run(action: () => void, message?: string) {
  if (disposed) return;
  try {
    action();
    el('analysis-error').hidden = true;
    if (message) text('analysis-message', message);
  } catch (reason) {
    error(reason);
  }
}
const on = <K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  event: K,
  callback: (event: HTMLElementEventMap[K]) => void,
) => target.addEventListener(event, callback, { signal: listeners.signal });
on(el('analysis-play'), 'click', () =>
  run(() => {
    replay.getState().status === 'playing' ? replay.pause() : replay.play();
  }),
);
on(el('analysis-step'), 'click', () => run(() => replay.step(), 'One complete historical bar revealed.'));
on(el('analysis-reset'), 'click', () =>
  run(() => replay.seek(0), 'Returned to the beginning. No bars revealed.'),
);
on(el('analysis-seek'), 'change', () =>
  run(
    () => replay.seek(Number(el<HTMLInputElement>('analysis-seek').value)),
    'History position changed. Playback is paused.',
  ),
);
on(el('analysis-speed'), 'change', () =>
  run(() => replay.setSpeed(Number(el<HTMLSelectElement>('analysis-speed').value))),
);
on(el('analysis-sync'), 'change', () => run(reconnectSync));
on(el('analysis-follow'), 'change', () => run(follow));
function setTheme(next: 'dark' | 'light') {
  theme = next;
  document.documentElement.dataset.theme = next;
  for (const chart of charts) chart.applyOptions({ theme: palette() });
  indexed.btc.applyOptions({ color: next === 'dark' ? '#c7ee92' : '#52742d' });
  el('analysis-theme').setAttribute(
    'aria-label',
    'Switch to ' + (next === 'dark' ? 'light' : 'dark') + ' theme',
  );
}
on(el('analysis-theme'), 'click', () => run(() => setTheme(theme === 'dark' ? 'light' : 'dark')));
interface Workspace {
  schema: 'filtix-analysis';
  version: 1;
  dataset: typeof dataset;
  position: number;
  speed: number;
  theme: 'dark' | 'light';
  sync: boolean;
  follow: boolean;
  ranges: readonly (TimeRange | null)[];
}
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid analysis workspace.');
  return value as Record<string, unknown>;
}
function validateWorkspace(value: unknown): Workspace {
  const item = record(value, [
    'schema',
    'version',
    'dataset',
    'position',
    'speed',
    'theme',
    'sync',
    'follow',
    'ranges',
  ]);
  if (item.schema !== 'filtix-analysis' || item.version !== 1 || item.dataset !== dataset)
    throw new Error('Unsupported workspace version or sample dataset.');
  if (
    typeof item.position !== 'number' ||
    !Number.isInteger(item.position) ||
    item.position < 0 ||
    item.position > fixture.btc.length
  )
    throw new Error('Invalid revealed history position.');
  if (typeof item.speed !== 'number' || !Number.isFinite(item.speed) || item.speed < 0.25 || item.speed > 64)
    throw new Error('Invalid replay speed.');
  if (item.theme !== 'dark' && item.theme !== 'light') throw new Error('Invalid workspace theme.');
  if (typeof item.sync !== 'boolean' || typeof item.follow !== 'boolean')
    throw new Error('Invalid view settings.');
  if (!Array.isArray(item.ranges) || item.ranges.length !== charts.length)
    throw new Error('Invalid chart viewports.');
  const cutoff = item.position ? Number(fixture.btc[item.position - 1]!.time) : null;
  const ranges = item.ranges.map((range, index): TimeRange | null => {
    if (range === null) return null;
    const checked = record(range, ['from', 'to']);
    if (
      cutoff === null ||
      typeof checked.from !== 'number' ||
      typeof checked.to !== 'number' ||
      !masterTimes.has(checked.from) ||
      !masterTimes.has(checked.to) ||
      checked.from > checked.to ||
      checked.to > cutoff
    )
      throw new Error('Workspace viewport is outside revealed history.');
    const source = index === 1 ? byTime.eth : byTime.btc;
    if (!source.has(checked.from) || !source.has(checked.to))
      throw new Error('Workspace viewport needs loaded boundary times.');
    return { from: checked.from, to: checked.to };
  });
  return {
    schema: 'filtix-analysis',
    version: 1,
    dataset,
    position: item.position,
    speed: item.speed,
    theme: item.theme,
    sync: item.sync,
    follow: item.follow,
    ranges,
  };
}
on(el('analysis-save'), 'click', () =>
  run(() => {
    const state = replay.getState();
    const value: Workspace = {
      schema: 'filtix-analysis',
      version: 1,
      dataset,
      position: state.position,
      speed: state.barsPerSecond,
      theme,
      sync: el<HTMLInputElement>('analysis-sync').checked,
      follow: el<HTMLInputElement>('analysis-follow').checked,
      ranges: charts.map((chart) => chart.getVisibleTimeRange()),
    };
    localStorage.setItem(storageKey, JSON.stringify(value));
  }, 'Workspace saved in this browser.'),
);
on(el('analysis-load'), 'click', () =>
  run(() => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) throw new Error('No saved workspace yet. Save your analysis first.');
    if (saved.length > 100000) throw new Error('Saved workspace is too large.');
    const value = validateWorkspace(JSON.parse(saved));
    sync?.destroy();
    sync = null;
    el<HTMLInputElement>('analysis-sync').checked = false;
    el<HTMLInputElement>('analysis-follow').checked = false;
    replay.seek(value.position);
    replay.setSpeed(value.speed);
    setTheme(value.theme);
    value.ranges.forEach((range, index) => {
      if (range) charts[index]!.setVisibleTimeRange(range, { origin: workspaceOrigin });
    });
    el<HTMLInputElement>('analysis-sync').checked = value.sync;
    el<HTMLInputElement>('analysis-follow').checked = value.follow;
    reconnectSync();
  }, 'Saved workspace restored. Playback is paused.'),
);
function destroy() {
  if (disposed) return;
  disposed = true;
  listeners.abort();
  sync?.destroy();
  sync = null;
  replay.destroy();
  for (const off of offs) off();
  for (const chart of charts) chart.destroy();
}
window.addEventListener('pagehide', (event) => {
  if (event.persisted) replay.pause();
  else destroy();
});
replay.seek(120);
const analysisTestApi = {
  snapshot: () => ({
    state: replay.getState(),
    series: {
      btc: btc.getData(),
      eth: eth.getData(),
      ema: ema.getData(),
      volume: volume.getData(),
      btcIndex: indexed.btc.getData(),
      ethIndex: indexed.eth.getData(),
      solIndex: indexed.sol.getData(),
    },
    ranges: charts.map((chart) => chart.getVisibleTimeRange()),
  }),
  setRange: (index: number, range: TimeRange) => charts[index]!.setVisibleTimeRange(range),
  idle: async () => {
    for (let pass = 0; pass < 3; pass++) await Promise.all(charts.map((chart) => chart.whenIdle()));
  },
  destroy,
};
declare global {
  interface Window {
    analysisTestApi?: typeof analysisTestApi;
  }
}
if (new URLSearchParams(location.search).has('test')) window.analysisTestApi = analysisTestApi;
