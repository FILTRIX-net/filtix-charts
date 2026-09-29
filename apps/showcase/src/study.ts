import './study.css';
import { createChart, darkTheme, lightTheme, type CandlePoint, type LogicalRange } from '@filtix/charts';
import {
  createDrawingStore,
  createDrawingLayer,
  measureDrawing,
  type Drawing,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingLayerState,
  type DrawingTool,
} from '@filtix/drawings';
import { makeCandles } from './fixtures';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const layoutKey = 'filtix.charts.study.v1';
const dataset = 'btc-study-v1';
const candles = makeCandles(600, { seed: 73, price: 62400, start: Date.UTC(2026, 5, 1), step: 3600000 });
const loadedTimes = new Set(candles.map((point) => Number(point.time)));
const listeners = new AbortController();
const urls = new Set<string>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let disposed = false;
let theme: 'dark' | 'light' = 'dark';
let layer: DrawingLayer | null = null;
let layerState: DrawingLayerState = {
  tool: 'select',
  selectedId: null,
  drawingCount: 0,
  canUndo: false,
  canRedo: false,
  magnet: false,
};
const names: Record<string, string> = {
  'trend-line': 'Trend line',
  'horizontal-line': 'Price level',
  rectangle: 'Price zone',
  measure: 'Measurement',
  'fibonacci-retracement': 'Fibonacci retracement',
  'parallel-channel': 'Parallel channel',
  'text-note': 'Text note',
};
const marks: Record<string, string> = {
  'trend-line': '╱',
  'horizontal-line': '—',
  rectangle: '▱',
  measure: '↔',
  'fibonacci-retracement': '≡',
  'parallel-channel': '∥',
  'text-note': 'T',
};
const hints: Record<DrawingTool, string> = {
  select: 'Select an annotation or drag empty space to pan.',
  'trend-line': 'Click the first point, then the second. Escape cancels.',
  'horizontal-line': 'Click a price to place a level.',
  rectangle: 'Click two opposite corners. Escape cancels.',
  measure: 'Click two points to measure price and elapsed time.',
  'fibonacci-retracement': 'Click two points to define retracement levels. Escape cancels.',
  'parallel-channel': 'Click two points for the first rail, then the second rail. Escape cancels.',
  'text-note': 'Click to place a note.',
};
const text = (id: string, value: string) => {
  const target = el(id);
  if (target.textContent !== value) target.textContent = value;
};
const number = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const date = (value: number) => new Date(value).toISOString().slice(0, 16);
const chartTheme = () => ({
  ...(theme === 'dark' ? darkTheme : lightTheme),
  background: theme === 'dark' ? '#14181c' : '#fbfcf9',
  fontFamily: 'Consolas, monospace',
  fontSize: 10,
});
const chart = createChart(el('study-chart'), {
  autoSize: true,
  theme: chartTheme(),
  timeDomain: 'utc-ms',
  followLatest: false,
  ariaLabel:
    'Editable Bitcoin sample study. Drawing tools above; annotations and anchor fields beside the chart. Arrow keys pan; Escape cancels drawing.',
});
const price = chart.addSeries('candlestick', { id: 'study-candles', pricePrecision: 2 });
price.setData(candles);
const volumePane = chart.addPane({ id: 'study-volume', weight: 0.25 });
chart
  .addSeries('histogram', { paneId: volumePane.id })
  .setData(candles.map((point) => ({ time: point.time, value: point.volume ?? 0 })));
chart.setVisibleRange({ from: 350, to: 550 });
const store = createDrawingStore();
store.add({
  id: 'sample-trend',
  type: 'trend-line',
  points: [
    { time: candles[370]!.time, price: candles[370]!.low },
    { time: candles[500]!.time, price: candles[500]!.low },
  ],
  style: { color: '#96aee8', lineWidth: 2 },
});
store.add({
  id: 'sample-level',
  type: 'horizontal-line',
  points: [{ time: candles[450]!.time, price: candles[450]!.close }],
  style: { color: '#6ab58e', lineWidth: 1.5 },
});
store.add({
  id: 'sample-zone',
  type: 'rectangle',
  points: [
    { time: candles[430]!.time, price: candles[430]!.high },
    { time: candles[475]!.time, price: candles[475]!.low },
  ],
  style: { color: '#d5ac66', lineWidth: 1.5, fillOpacity: 0.08 },
});

function showError(error: unknown) {
  if (disposed) return;
  text('study-error', error instanceof Error ? error.message : String(error));
  el('study-error').hidden = false;
}
function run(action: () => void, message?: string) {
  if (disposed) return;
  try {
    action();
    el('study-error').hidden = true;
    if (message) text('study-message', message);
  } catch (error) {
    showError(error);
    renderInspector();
  }
}
function selected(): Drawing | null {
  return layerState.selectedId ? store.get(layerState.selectedId) : null;
}
function renderTools(state: DrawingLayerState) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))
    button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool));
  el<HTMLButtonElement>('study-undo').disabled = !state.canUndo;
  el<HTMLButtonElement>('study-redo').disabled = !state.canRedo;
  el<HTMLButtonElement>('study-clear').disabled = state.drawingCount === 0;
  text('study-count', state.drawingCount + (state.drawingCount === 1 ? ' annotation' : ' annotations'));
  text('study-hint', hints[state.tool]);
}
function renderList() {
  const drawings = store.list();
  const list = el('study-list');
  const focusedId = list.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.studyDrawing
    : undefined;
  const fragment = document.createDocumentFragment();
  for (const drawing of drawings) {
    const button = document.createElement('button');
    button.className = 'study-drawing';
    button.dataset.studyDrawing = drawing.id;
    button.setAttribute('aria-pressed', String(drawing.id === layerState.selectedId));
    const mark = document.createElement('span');
    mark.className = 'study-drawing-mark';
    mark.style.color = drawing.style.color;
    mark.textContent = marks[drawing.type]!;
    const label = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = names[drawing.type]!;
    const detail = document.createElement('small');
    detail.textContent =
      drawing.type === 'horizontal-line'
        ? number(drawing.points[0]!.price) + ' USD'
        : date(Number(drawing.points[0]!.time)).replace('T', ' ');
    label.append(title, detail);
    const arrow = document.createElement('span');
    arrow.className = 'study-drawing-arrow';
    arrow.textContent = '↗';
    button.append(mark, label, arrow);
    fragment.append(button);
  }
  list.replaceChildren(fragment);
  if (focusedId) {
    const focused = [...list.querySelectorAll<HTMLButtonElement>('[data-study-drawing]')].find(
      (button) => button.dataset.studyDrawing === focusedId,
    );
    focused?.focus({ preventScroll: true });
  }
  el('study-list-empty').hidden = drawings.length > 0;
}
function renderInspector() {
  const drawing = selected();
  el('study-inspector').hidden = !drawing;
  if (!drawing) return;
  text('study-selection-title', names[drawing.type]!);
  el<HTMLInputElement>('study-color').value = drawing.style.color.slice(0, 7);
  const width = el<HTMLSelectElement>('study-width');
  const widthValue = String(drawing.style.lineWidth);
  if (![...width.options].some((option) => option.value === widthValue))
    width.add(new Option(widthValue + ' px', widthValue));
  width.value = widthValue;
  el('study-second-anchor').hidden = drawing.points.length < 2;
  for (const [index, suffix] of ['a', 'b'].entries()) {
    const point = drawing.points[index];
    if (!point) continue;
    el<HTMLInputElement>('study-price-' + suffix).value = String(Math.round(point.price * 100) / 100);
    el<HTMLInputElement>('study-time-' + suffix).value = date(Number(point.time));
  }
  el('study-time-a').closest('label')!.hidden = drawing.type === 'horizontal-line';
  const measurement = measureDrawing(drawing);
  text(
    'study-measurement',
    measurement
      ? (measurement.priceChange === null
          ? '—'
          : (measurement.priceChange >= 0 ? '+' : '') + number(measurement.priceChange)) +
          ' USD · ' +
          (measurement.percentChange === null
            ? '—'
            : (measurement.percentChange >= 0 ? '+' : '') + number(measurement.percentChange) + '%') +
          ' · ' +
          number(measurement.elapsedMs / 3600000) +
          ' h'
      : 'A fixed price level across the visible pane.',
  );
}
layer = createDrawingLayer(chart, {
  store,
  style: { color: '#96aee8', lineWidth: 2 },
  onState(state) {
    if (disposed) return;
    const selectionChanged = state.selectedId !== layerState.selectedId;
    layerState = state;
    renderTools(state);
    if (selectionChanged) {
      renderList();
      renderInspector();
    }
  },
});
layerState = layer.getState();
const offStore = store.subscribe(() => {
  if (!disposed) {
    renderList();
    renderInspector();
  }
});
renderTools(layerState);
renderList();
renderInspector();
function renderCandle(point: CandlePoint) {
  text('study-candle-time', date(Number(point.time)).replace('T', ' '));
  for (const key of ['open', 'high', 'low', 'close'] as const) text('study-' + key, number(point[key]));
}
renderCandle(candles.at(-1)!);
const offCrosshair = chart.subscribeCrosshairMove((event) => {
  const point = event.points['study-candles'];
  renderCandle(point && 'open' in point ? point : candles.at(-1)!);
});
const on = <K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  event: K,
  callback: (event: HTMLElementEventMap[K]) => void,
) => target.addEventListener(event, callback, { signal: listeners.signal });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))
  on(button, 'click', () => run(() => layer!.setTool(button.dataset.tool as DrawingTool)));
on(el('study-list'), 'click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-study-drawing]');
  if (button) run(() => layer!.select(button.dataset.studyDrawing!));
});
on(el('study-undo'), 'click', () =>
  run(() => {
    store.undo();
  }, 'Previous edit restored.'),
);
on(el('study-redo'), 'click', () =>
  run(() => {
    store.redo();
  }, 'Edit reapplied.'),
);
on(el('study-clear'), 'click', () => run(() => store.clear(), 'Annotations cleared. Undo restores them.'));
on(el('study-delete'), 'click', () =>
  run(() => {
    const drawing = selected();
    if (drawing) store.remove(drawing.id);
  }, 'Annotation removed.'),
);
on(el('study-fit'), 'click', () => run(() => chart.fitContent()));
on(el('study-color'), 'change', () =>
  run(() => {
    const drawing = selected();
    if (!drawing) return;
    store.update(drawing.id, { style: { color: el<HTMLInputElement>('study-color').value } });
  }, 'Color updated.'),
);
on(el('study-width'), 'change', () =>
  run(() => {
    const drawing = selected();
    if (!drawing) return;
    store.update(drawing.id, { style: { lineWidth: Number(el<HTMLSelectElement>('study-width').value) } });
  }, 'Line width updated.'),
);
for (const [index, suffix] of ['a', 'b'].entries()) {
  on(el('study-price-' + suffix), 'change', () =>
    run(() => {
      const drawing = selected();
      if (!drawing?.points[index]) return;
      const value = el<HTMLInputElement>('study-price-' + suffix).valueAsNumber;
      if (!Number.isFinite(value)) throw new Error('Enter a finite price.');
      const points = drawing.points.map((point) => ({ ...point }));
      points[index]!.price = value;
      store.update(drawing.id, { points });
    }, 'Anchor updated.'),
  );
  on(el('study-time-' + suffix), 'change', () =>
    run(() => {
      const drawing = selected();
      if (!drawing?.points[index]) return;
      const value = Date.parse(el<HTMLInputElement>('study-time-' + suffix).value + 'Z');
      if (!loadedTimes.has(value)) throw new Error('Choose an hourly UTC time within this sample history.');
      const points = drawing.points.map((point) => ({ ...point }));
      points[index]!.time = value;
      store.update(drawing.id, { points });
    }, 'Anchor updated.'),
  );
}
function setTheme(next: 'dark' | 'light') {
  theme = next;
  document.documentElement.dataset.theme = theme;
  chart.applyOptions({ theme: chartTheme() });
  el('study-theme').setAttribute(
    'aria-label',
    'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme',
  );
}
on(el('study-theme'), 'click', () => run(() => setTheme(theme === 'dark' ? 'light' : 'dark')));
interface StudyLayout {
  schema: 'filtix-study';
  version: 1;
  dataset: typeof dataset;
  theme: 'dark' | 'light';
  range: LogicalRange;
  drawings: DrawingDocument;
}
function validateLayout(value: unknown): StudyLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid study layout.');
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !['schema', 'version', 'dataset', 'theme', 'range', 'drawings'].includes(key),
    ) ||
    item.schema !== 'filtix-study' ||
    item.version !== 1 ||
    item.dataset !== dataset
  )
    throw new Error('Unsupported study layout version or sample dataset.');
  if (item.theme !== 'dark' && item.theme !== 'light') throw new Error('Invalid layout theme.');
  if (!item.range || typeof item.range !== 'object' || Array.isArray(item.range))
    throw new Error('Invalid layout viewport.');
  const range = item.range as Record<string, unknown>;
  if (
    Object.keys(range).some((key) => key !== 'from' && key !== 'to') ||
    typeof range.from !== 'number' ||
    typeof range.to !== 'number' ||
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to) ||
    range.from < 0 ||
    range.to <= range.from ||
    range.to > candles.length - 1
  )
    throw new Error('Layout viewport is outside the sample history.');
  const candidate = createDrawingStore({ timeDomain: 'utc-ms', maxHistory: 0 });
  candidate.restore(item.drawings);
  return {
    schema: 'filtix-study',
    version: 1,
    dataset,
    theme: item.theme,
    range: { from: range.from, to: range.to },
    drawings: candidate.toJSON(),
  };
}
on(el('study-save'), 'click', () =>
  run(() => {
    const layout: StudyLayout = {
      schema: 'filtix-study',
      version: 1,
      dataset,
      theme,
      range: chart.getVisibleRange(),
      drawings: store.toJSON(),
    };
    localStorage.setItem(layoutKey, JSON.stringify(layout));
  }, 'Layout saved in this browser.'),
);
on(el('study-load'), 'click', () =>
  run(() => {
    const saved = localStorage.getItem(layoutKey);
    if (!saved) throw new Error('No saved layout yet. Save a study first.');
    if (saved.length > 1000000) throw new Error('Saved layout is too large.');
    const layout = validateLayout(JSON.parse(saved));
    layer!.setTool('select');
    layer!.select(null);
    setTheme(layout.theme);
    chart.setVisibleRange(layout.range);
    store.restore(layout.drawings);
  }, 'Saved layout restored.'),
);
on(el('study-export'), 'click', async () => {
  try {
    const blob = await chart.exportImage();
    if (disposed) return;
    const url = URL.createObjectURL(blob);
    urls.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'FILTIX-study.png';
    link.click();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
      timers.delete(timer);
    }, 1000);
    timers.add(timer);
  } catch (error) {
    showError(error);
  }
});
function destroy() {
  if (disposed) return;
  disposed = true;
  listeners.abort();
  offStore();
  offCrosshair();
  layer!.destroy();
  chart.destroy();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) destroy();
});
