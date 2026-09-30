import './style.css';
import {
  createChart,
  darkTheme,
  lightTheme,
  type SeriesHandle,
  type PaneHandle,
  type SeriesType,
  type ChartTheme,
} from '@filtrix.net/charts';
import { createIndicator, type StreamingIndicator } from '@filtrix.net/indicators';
import type { CandlePoint } from '@filtrix.net/core';
import { makeCandles, aggregateCandles, closeValues, symbols } from './fixtures';
import { createDemoStream } from './demo-stream';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const format = (value: number, digits = 2) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const stamp = (time: number | string) => new Date(time).toISOString().slice(0, 16).replace('T', ' ');
let theme: 'dark' | 'light' = 'dark';
let selectedSymbol: (typeof symbols)[number] = symbols[0];
let factor = 1;
let seriesType: SeriesType = 'candlestick';
let raw = makeCandles(1600, { price: selectedSymbol.price, seed: selectedSymbol.seed });
let candles = aggregateCandles(raw, factor);
let upColor = '#6ad5a0',
  downColor = '#ed858c';
let streamTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let nextStreamPoint = createDemoStream(candles.at(-1)!, factor, selectedSymbol.seed);
let volumePane: PaneHandle | undefined, volume: SeriesHandle | undefined;
const indicatorKinds = new Set<'ema' | 'sma' | 'rsi'>(['ema']);
const overlays = new Map<
  string,
  { series: SeriesHandle; indicator: StreamingIndicator; pane?: PaneHandle }
>();
const chartTheme = (): Partial<ChartTheme> => ({
  ...(theme === 'dark' ? darkTheme : lightTheme),
  background: theme === 'dark' ? '#14181c' : '#fbfcf9',
  fontFamily: '"Cascadia Code","Consolas",monospace',
  fontSize: 10,
  up: upColor,
  down: downColor,
});
const chartAriaLabel =
  'Synthetic financial history. Drag to pan, scroll to zoom, or focus the chart and use arrow keys.';
const chart = createChart(element('chart'), {
  theme: chartTheme(),
  diagnostics: true,
  ariaLabel: chartAriaLabel,
});
chart.removePane('price');
const pricePane = chart.addPane({ id: 'main', weight: 4 });
let priceSeries: SeriesHandle;

function toast(message: string) {
  element('toast').textContent = message;
  element('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element('toast').hidden = true), 3200);
}
function candleData() {
  return seriesType === 'candlestick' || seriesType === 'ohlc' ? candles : closeValues(candles);
}
function updateLegend(point: CandlePoint) {
  element('legend-open').textContent = format(point.open);
  element('legend-high').textContent = format(point.high);
  element('legend-low').textContent = format(point.low);
  element('legend-close').textContent = format(point.close);
  element('legend-time').textContent = stamp(point.time);
}
function updateStats() {
  const last = candles[candles.length - 1]!,
    first = candles[0]!;
  const change = last.close - first.open,
    percent = (change / first.open) * 100;
  element('current-price').textContent = format(last.close);
  const changeEl = element('price-change');
  changeEl.textContent =
    (change >= 0 ? '+' : '') + format(change) + ' (' + (change >= 0 ? '+' : '') + format(percent) + '%)';
  changeEl.className = change >= 0 ? 'positive' : 'negative';
  element('period-high').textContent = format(Math.max(...candles.map((p) => p.high)));
  element('period-low').textContent = format(Math.min(...candles.map((p) => p.low)));
  updateLegend(last);
  updateDataTable();
}
function updateDataTable() {
  if (element('data-panel').hidden) return;
  element('data-rows').replaceChildren(
    ...candles
      .slice(-20)
      .reverse()
      .map((point) => {
        const row = document.createElement('tr');
        for (const value of [
          stamp(point.time),
          format(point.open),
          format(point.high),
          format(point.low),
          format(point.close),
          format(point.volume ?? 0, 0),
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        return row;
      }),
  );
}
function addIndicator(kind: 'ema' | 'sma' | 'rsi') {
  const period = kind === 'ema' ? 20 : kind === 'sma' ? 50 : 14;
  const indicator = createIndicator(kind, period);
  indicator.setData(closeValues(candles));
  const pane = kind === 'rsi' ? chart.addPane({ id: 'rsi', weight: 1.15 }) : undefined;
  const series = chart.addSeries('line', {
    id: kind,
    paneId: pane?.id ?? pricePane.id,
    title: kind.toUpperCase() + ' ' + period,
    color:
      kind === 'ema' ? (theme === 'dark' ? '#d7bb7b' : '#946b23') : kind === 'sma' ? '#92a9e9' : '#b7a1d9',
    lineWidth: 1.25,
    lastValueVisible: kind === 'rsi',
    priceLineVisible: false,
    pricePrecision: 2,
  });
  series.setData(indicator.getData());
  overlays.set(kind, { series, indicator, pane });
}
function refreshData(reset = true) {
  const range = chart.getVisibleRange();
  for (const value of overlays.values()) {
    value.series.remove();
    value.pane?.remove();
  }
  overlays.clear();
  volume?.remove();
  volume = undefined;
  volumePane?.remove();
  volumePane = undefined;
  priceSeries?.remove();
  priceSeries = chart.addSeries(seriesType, {
    id: 'instrument',
    paneId: pricePane.id,
    title: selectedSymbol.pair,
    color: upColor,
    upColor,
    downColor,
    lineWidth: 1.6,
    pricePrecision: 2,
  });
  priceSeries.setData(candleData());
  if (element<HTMLInputElement>('volume-toggle').checked) {
    volumePane = chart.addPane({ id: 'volume', weight: 1 });
    volume = chart.addSeries('histogram', {
      id: 'volume-bars',
      paneId: volumePane.id,
      title: 'Volume',
      color: theme === 'dark' ? '#436359' : '#96b6a3',
      pricePrecision: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.setData(candles.map((p) => ({ time: p.time, value: p.volume ?? 0 })));
  }
  for (const kind of indicatorKinds) addIndicator(kind);
  if (reset) {
    const count = Math.min(160, candles.length - 1);
    chart.setVisibleRange({ from: Math.max(0, candles.length - 1 - count), to: candles.length - 1 });
  } else chart.setVisibleRange(range);
  updateStats();
  updateCode();
}
function stopStream() {
  clearInterval(streamTimer);
  streamTimer = undefined;
  element('stream-toggle').setAttribute('aria-pressed', 'false');
  element('stream-toggle').querySelector('span:last-child')!.textContent = 'Start stream';
}
function tick() {
  const last = candles[candles.length - 1]!;
  const point = nextStreamPoint();
  if (point.time === last.time) candles[candles.length - 1] = point;
  else candles.push(point);
  priceSeries.update(
    seriesType === 'candlestick' || seriesType === 'ohlc' ? point : { time: point.time, value: point.close },
  );
  volume?.update({ time: point.time, value: point.volume ?? 0 });
  for (const entry of overlays.values())
    entry.series.update(entry.indicator.update({ time: point.time, value: point.close }));
  updateStats();
}
function applyTheme(next: 'dark' | 'light') {
  theme = next;
  document.documentElement.dataset.theme = theme;
  upColor = theme === 'dark' ? '#6ad5a0' : '#207b51';
  downColor = theme === 'dark' ? '#ed858c' : '#ba4f5b';
  chart.applyOptions({ theme: chartTheme() });
  element<HTMLInputElement>('up-color').value = upColor;
  element<HTMLInputElement>('down-color').value = downColor;
  element('up-color-value').textContent = upColor.toUpperCase();
  element('down-color-value').textContent = downColor.toUpperCase();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme]')) {
    const active = button.dataset.theme === theme;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const title = 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme';
  element('theme-toggle').setAttribute('aria-label', title);
  element('theme-toggle').title = title;
  refreshData(false);
}
function selectSymbol(id: string) {
  const symbol = symbols.find((s) => s.id === id);
  if (!symbol) return;
  stopStream();
  selectedSymbol = symbol;
  raw = makeCandles(1600, { price: symbol.price, seed: symbol.seed });
  candles = aggregateCandles(raw, factor);
  nextStreamPoint = createDemoStream(candles.at(-1)!, factor, selectedSymbol.seed);
  element('pair').textContent = symbol.pair;
  element('instrument-description').textContent = symbol.name;
  element('asset-tag').textContent = symbol.id === 'AAPL' ? 'EQUITY' : 'CRYPTO';
  element('legend-symbol').textContent = symbol.id + 'USD';
  const icon = element('instrument-icon');
  icon.textContent = symbol.id === 'BTC' ? '₿' : symbol.id === 'ETH' ? 'Ξ' : symbol.id === 'SOL' ? '◎' : 'A';
  icon.style.color = symbol.color;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-symbol]'))
    button.classList.toggle('selected', button.dataset.symbol === id);
  refreshData();
}
function buildMarketStrip() {
  for (const symbol of symbols) {
    const fixture = makeCandles(1600, { price: symbol.price, seed: symbol.seed });
    const first = fixture[0]!,
      last = fixture[fixture.length - 1]!;
    const pct = ((last.close - first.open) / first.open) * 100;
    const button = document.createElement('button');
    button.className = 'market-card' + (symbol.id === selectedSymbol.id ? ' selected' : '');
    button.dataset.symbol = symbol.id;
    button.setAttribute('aria-label', 'Show ' + symbol.pair + ' synthetic chart');
    const mark = document.createElement('span');
    mark.className = 'coin-mark';
    mark.style.color = symbol.color;
    mark.textContent =
      symbol.id === 'BTC' ? '₿' : symbol.id === 'ETH' ? 'Ξ' : symbol.id === 'SOL' ? '◎' : 'A';
    const copy = document.createElement('span');
    copy.className = 'market-card-copy';
    const name = document.createElement('strong');
    name.textContent = symbol.id + '/USD';
    const subtitle = document.createElement('small');
    subtitle.textContent = symbol.name;
    copy.append(name, subtitle);
    const numbers = document.createElement('span');
    numbers.className = 'market-card-data';
    const price = document.createElement('strong');
    price.textContent = format(last.close);
    const change = document.createElement('small');
    change.className = pct >= 0 ? 'positive' : 'negative';
    change.textContent = (pct >= 0 ? '+' : '') + format(pct) + '%';
    numbers.append(price, change);
    button.append(mark, copy, numbers);
    button.addEventListener('click', () => selectSymbol(symbol.id));
    element('market-strip').append(button);
  }
}
function showIntegration(show: boolean) {
  element('workspace-view').hidden = show;
  element('integration-view').hidden = !show;
  element('workspace-tab').classList.toggle('active', !show);
  element('api-tab').classList.toggle('active', show);
  if (show) updateCode();
}
function updateCode() {
  const volumeVisible = element<HTMLInputElement>('volume-toggle').checked;
  const priceData =
    seriesType === 'candlestick' || seriesType === 'ohlc'
      ? 'history'
      : 'history.map(p => ({ time: p.time, value: p.close }))';
  const priceUpdate =
    seriesType === 'candlestick' || seriesType === 'ohlc'
      ? 'point'
      : '{ time: point.time, value: point.close }';
  const lines = [
    "import { createChart } from '@filtrix.net/charts';",
    ...(indicatorKinds.size ? ["import { createIndicator } from '@filtrix.net/indicators';"] : []),
    '',
    '// history: sorted OHLC records; time is UTC milliseconds',
    'export function mountChart(host, history) {',
    '  const chart = createChart(host, {',
    '    theme: ' + JSON.stringify(chartTheme()) + ',',
    "    timeDomain: 'utc-ms',",
    '    autoSize: true,',
    '    diagnostics: true,',
    '    ariaLabel: ' + JSON.stringify(chartAriaLabel) + ',',
    '    crosshair: ' + element<HTMLInputElement>('crosshair-toggle').checked + ',',
    '    followLatest: ' + element<HTMLInputElement>('follow-toggle').checked + ',',
    '  });',
    "  chart.removePane('price');",
    "  chart.addPane({ id: 'main', weight: 4, scale: '" +
      (element<HTMLInputElement>('log-toggle').checked ? 'log' : 'linear') +
      "' });",
    "  const price = chart.addSeries('" + seriesType + "', {",
    "    id: 'instrument', paneId: 'main',",
    '    title: ' + JSON.stringify(selectedSymbol.pair) + ',',
    "    upColor: '" + upColor + "', downColor: '" + downColor + "', color: '" + upColor + "',",
    '    lineWidth: 1.6, pricePrecision: 2,',
    '  });',
    '  price.setData(' + priceData + ');',
  ];
  const updates = ['    price.update(' + priceUpdate + ');'];
  if (volumeVisible) {
    lines.push(
      '',
      "  chart.addPane({ id: 'volume', weight: 1 });",
      "  const volume = chart.addSeries('histogram', { id: 'volume-bars', title: 'Volume', paneId: 'volume', color: '" +
        (theme === 'dark' ? '#436359' : '#96b6a3') +
        "', pricePrecision: 0, lastValueVisible: false, priceLineVisible: false });",
      '  volume.setData(history.map(p => ({ time: p.time, value: p.volume ?? 0 })));',
    );
    updates.push('    volume.update({ time: point.time, value: point.volume ?? 0 });');
  }
  for (const kind of indicatorKinds) {
    const period = kind === 'ema' ? 20 : kind === 'sma' ? 50 : 14;
    const color =
      kind === 'ema' ? (theme === 'dark' ? '#d7bb7b' : '#946b23') : kind === 'sma' ? '#92a9e9' : '#b7a1d9';
    lines.push(
      '',
      '  const ' + kind + " = createIndicator('" + kind + "', " + period + ');',
      '  ' + kind + '.setData(history.map(p => ({ time: p.time, value: p.close })));',
    );
    if (kind === 'rsi') lines.push("  chart.addPane({ id: 'rsi', weight: 1.15 });");
    lines.push(
      '  const ' +
        kind +
        "Line = chart.addSeries('line', { id: '" +
        kind +
        "', title: '" +
        kind.toUpperCase() +
        ' ' +
        period +
        "', paneId: '" +
        (kind === 'rsi' ? 'rsi' : 'main') +
        "', color: '" +
        color +
        "', lineWidth: 1.25, pricePrecision: 2, lastValueVisible: " +
        (kind === 'rsi') +
        ', priceLineVisible: false });',
      '  ' + kind + 'Line.setData(' + kind + '.getData());',
    );
    updates.push(
      '    ' + kind + 'Line.update(' + kind + '.update({ time: point.time, value: point.close }));',
    );
  }
  lines.push(
    '',
    '  chart.setVisibleRange(' + JSON.stringify(chart.getVisibleRange()) + ');',
    '',
    '  // Accept an OHLC record to replace the tail or append one new bar.',
    '  function update(point) {',
    ...updates,
    '  }',
    '  return { chart, price, update, destroy: () => chart.destroy() };',
    '}',
  );
  element('integration-code').textContent = lines.join('\n');
}
chart.subscribeCrosshairMove((event) => {
  const point = event.points[priceSeries?.id];
  if (point && 'open' in point) updateLegend(point);
  else if (event.time !== null) {
    const point = candles.find((p) => p.time === event.time);
    if (point) updateLegend(point);
  } else if (candles.length) updateLegend(candles[candles.length - 1]!);
});
element('stream-toggle').addEventListener('click', () => {
  if (streamTimer) {
    stopStream();
    return;
  }
  element('stream-toggle').setAttribute('aria-pressed', 'true');
  element('stream-toggle').querySelector('span:last-child')!.textContent = 'Streaming';
  streamTimer = setInterval(tick, 750);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-interval]'))
  button.addEventListener('click', () => {
    stopStream();
    factor = Number(button.dataset.interval);
    candles = aggregateCandles(raw, factor);
    nextStreamPoint = createDemoStream(candles.at(-1)!, factor, selectedSymbol.seed);
    document
      .querySelectorAll('[data-interval]')
      .forEach((el) => el.classList.toggle('selected', el === button));
    element('interval-description').textContent =
      factor === 24 ? '1 day' : factor + ' hour' + (factor === 1 ? '' : 's');
    refreshData();
  });
element<HTMLSelectElement>('series-type').addEventListener('change', (event) => {
  seriesType = (event.target as HTMLSelectElement).value as SeriesType;
  refreshData(false);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-indicator]'))
  button.addEventListener('click', () => {
    const kind = button.dataset.indicator as 'ema' | 'sma' | 'rsi';
    if (indicatorKinds.has(kind)) indicatorKinds.delete(kind);
    else indicatorKinds.add(kind);
    button.classList.toggle('selected', indicatorKinds.has(kind));
    button.setAttribute('aria-pressed', String(indicatorKinds.has(kind)));
    refreshData(false);
  });
element('fit-chart').addEventListener('click', () => chart.fitContent());
element('latest-chart').addEventListener('click', () => chart.scrollToLatest());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-range]'))
  button.addEventListener('click', () => {
    if (button.dataset.range === 'all') chart.fitContent();
    else
      chart.setVisibleRange({
        from: Math.max(0, candles.length - 1 - Number(button.dataset.range)),
        to: candles.length - 1,
      });
    document.querySelectorAll('[data-range]').forEach((el) => el.classList.toggle('selected', el === button));
  });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme]'))
  button.addEventListener('click', () => applyTheme(button.dataset.theme as 'dark' | 'light'));
element('theme-toggle').addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));
for (const direction of ['up', 'down'])
  element<HTMLInputElement>(direction + '-color').addEventListener('input', (event) => {
    const color = (event.target as HTMLInputElement).value;
    if (direction === 'up') upColor = color;
    else downColor = color;
    element(direction + '-color-value').textContent = color.toUpperCase();
    priceSeries.applyOptions({ upColor, downColor, color: upColor });
    updateCode();
  });
element('volume-toggle').addEventListener('change', () => refreshData(false));
element<HTMLInputElement>('crosshair-toggle').addEventListener('change', (event) => {
  chart.applyOptions({ crosshair: (event.target as HTMLInputElement).checked });
  updateCode();
});
element<HTMLInputElement>('follow-toggle').addEventListener('change', (event) => {
  chart.applyOptions({ followLatest: (event.target as HTMLInputElement).checked });
  updateCode();
});
element<HTMLInputElement>('log-toggle').addEventListener('change', (event) => {
  try {
    pricePane.applyOptions({ scale: (event.target as HTMLInputElement).checked ? 'log' : 'linear' });
    updateCode();
  } catch (error) {
    (event.target as HTMLInputElement).checked = false;
    toast(String(error));
  }
});
element('export-chart').addEventListener('click', async () => {
  const button = element<HTMLButtonElement>('export-chart');
  button.disabled = true;
  try {
    const blob = await chart.exportImage();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'filtrix-' + selectedSymbol.id.toLowerCase() + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Chart exported as PNG.');
  } catch (error) {
    toast('Export failed: ' + String(error));
  } finally {
    button.disabled = false;
  }
});
element('table-toggle').addEventListener('click', () => {
  const panel = element('data-panel');
  panel.hidden = !panel.hidden;
  element('table-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  element('table-toggle').textContent = panel.hidden ? 'View accessible data table ↓' : 'Hide data table ↑';
  updateDataTable();
});
element('api-tab').addEventListener('click', () => showIntegration(true));
element('workspace-tab').addEventListener('click', () => showIntegration(false));
element('back-workspace').addEventListener('click', () => showIntegration(false));
element('open-code').addEventListener('click', () => showIntegration(true));
element('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(element('integration-code').textContent ?? '');
    toast('Integration code copied.');
  } catch {
    toast('Clipboard unavailable. Select and copy the code above.');
  }
});
const diagnosticsTimer = setInterval(() => {
  const metrics = chart.getDiagnostics();
  element('render-time').textContent = metrics.lastRenderMs.toFixed(2) + ' ms render';
  element('loaded-points').textContent = metrics.dataPoints.toLocaleString('en-US');
}, 1000);
window.addEventListener('pagehide', (event) => {
  stopStream();
  // Cached documents retain their chart and event handlers; the browser suspends their timers.
  if (event.persisted) return;
  clearTimeout(toastTimer);
  clearInterval(diagnosticsTimer);
  chart.destroy();
});
buildMarketStrip();
refreshData();
