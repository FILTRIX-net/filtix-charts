# FILTRIX Charts API

This guide describes the current development API. See the [beta guide](OPEN-SOURCE-BETA.md) for published package availability and exact installation versions. The [base engine contract](API-CONTRACT.md) and extension guides below describe the public interfaces.

## Create and dispose

```ts
import { createChart } from '@filtrix.net/charts';

const chart = createChart(document.querySelector('#chart')!, {
  theme: 'dark',
  timeDomain: 'utc-ms',
  autoSize: true,
  locale: 'en-US',
  timeZone: 'UTC',
});

const price = chart.addSeries('candlestick', {
  title: 'BTC / USD',
  upColor: '#6ad5a0',
  downColor: '#ed858c',
  pricePrecision: 2,
});

price.setData([
  { time: Date.UTC(2026, 8, 1), open: 100, high: 105, low: 98, close: 103, volume: 340 },
  { time: Date.UTC(2026, 8, 2), open: 103, high: 108, low: 102, close: 107, volume: 420 },
]);
chart.fitContent();

// On host unmount:
chart.destroy();
```

The host must have a CSS width and height. The chart owns only the nodes it creates inside that host. Module imports do not access the DOM. Mounting requires a browser with Canvas 2D, Pointer Events, ResizeObserver, requestAnimationFrame and Intl.

Repeated destroy/unsubscribe is harmless. Other calls through destroyed/removed handles throw a ChartError. Destroy cancels queued frames, detaches input/resize observers and resolves outstanding whenIdle promises.

## Attribution and PNG export

Available in `0.12.0-beta.2`; see the beta guide for installation.

Charts show a small `FILTRIX.NET` link by default. `ChartOptions.attribution` controls it at creation and through `applyOptions`. It follows the chart theme and stays inside the first visible pane; a pane too small to fit the link hides it until space is available. The link is keyboard accessible and opens `https://filtrix.net/` in a new tab. Displaying it sends no analytics or network requests.

```ts
const chart = createChart(host, { attribution: false });
chart.applyOptions({ attribution: true });

const branded = await chart.exportImage();
const unbranded = await chart.exportImage({ watermark: false });
const explicitlyBranded = await chart.exportImage({ watermark: true });
```

`exportImage(options?: ChartExportOptions)` returns a PNG `Blob`. Its optional boolean `watermark` draws a subtle `FILTRIX.NET` mark on the exported image only. When omitted, it follows the chart's `attribution` setting. A per-export override never changes the live chart or later exports. Image dimensions, device-pixel ratio and custom drawing primitives are preserved; exporting does not paint into the live canvas. Unknown export keys, non-object options and non-boolean values reject with `INVALID_OPTIONS`.

The React adapter accepts `attribution` in its existing `options` prop. Terminal consumers can configure their exposed chart with `terminal.chart.applyOptions({ attribution: false })` and export through `terminal.chart.exportImage({ watermark: false })`. This is chart-instance configuration, not part of a saved terminal workspace. For grid charts, apply it to each mounted terminal returned by `grid.getTerminal(cellId)` and reapply when a cell creates a new chart.

Attribution is optional and can be disabled without a fee. License-notice obligations remain governed by [Apache-2.0](../LICENSE); this feature introduces no additional license term.

## Series and panes

Series types: `candlestick`, `ohlc`, `line`, `area`, `histogram`, `band`. Candle/OHLC records use open/high/low/close and optional nonnegative volume. Line, area and histogram records use `{time,value}`. Band records use `{time,lower,upper}` with finite ordered boundaries (`lower <= upper`). A record with only `time` represents whitespace.

A default pane has id `price`. Extra panes share the ordered time union but have independent vertical scales.

```ts
const volumePane = chart.addPane({ id: 'volume', weight: 1 });
const volume = chart.addSeries('histogram', {
  paneId: volumePane.id,
  color: '#436359',
  pricePrecision: 0,
});
volume.setData([{ time: Date.UTC(2026, 8, 1), value: 340 }]);
volumePane.applyOptions({ weight: 1.5 });
volumePane.remove(); // also invalidates its series
```

Linear prices may be zero or negative. Log panes require every loaded value on that scale to be positive; a rejected mode/data change preserves the prior state. Histogram scales include zero in linear mode. Series and pane IDs are immutable.

### Boundary bands

A band fills the region between two values on the same pane. It shares the chart's time axis, autoscale, clipping and PNG export. Both boundaries contribute to its scale and must be positive in a log pane. The band has no boundary strokes; add ordinary line series when independent upper/lower styles are needed.

```ts
const envelope = chart.addSeries('band', {
  color: '#7aa2f7',
  fillOpacity: 0.12,
  connectGaps: false,
});
envelope.setData([
  { time: Date.UTC(2026, 8, 1), lower: 98, upper: 106 },
  { time: Date.UTC(2026, 8, 2), lower: 99, upper: 108 },
]);
```

`fillOpacity` accepts finite values from 0 to 1 and defaults to 0.14 in the chart engine. Zero leaves the series and its data in place. Band fills render before ordinary price/line strokes. Whitespace and missing timestamps break the fill unless `connectGaps` is enabled. Crosshair snapshots return the original `BandPoint` with both boundaries. A band has no scalar legend value or price annotation: `lastValueVisible` and `priceLineVisible` default to false, and enabling either throws `INVALID_OPTIONS` without changing the series.

## Canvas legend

`ChartOptions.legend` accepts `ChartLegendOptions`: `visible` defaults to `true`; `maxRows` defaults to `2` and accepts integers from1 through4. Partial patches preserve omitted fields and copy caller options. Invalid nested objects, fields or values reject the complete chart patch before mutation.

```ts
chart.applyOptions({ legend: { maxRows: 1 } });
chart.applyOptions({ legend: { visible: false } });
```

Titles follow series insertion order and retain their colors. The scene canvas measures and wraps them inside each pane, shortens long titles with an ellipsis and shows `+N` for omitted titles. Rows respect the configured limit, pane height and a normal quarter-height budget, with one row allowed when its full height fits. Very small panes suppress the legend and recover on resize. The complete study list remains available in terminal controls. Legends appear in PNG exports; crosshair-only motion still uses the independent overlay.

## Pane layout

`getPaneLayout()` returns ordered committed preferences, including the built-in `price` pane while it exists. Generic charts retain the legacy ability to remove any pane, including price; snapshots contain only existing panes. Weights are shares of the space remaining after minimum heights; defaults are weight 1 and minimum 48 CSS px. Both values must be positive finite numbers. When minimum heights cannot fit, the engine compresses the displayed heights proportionally without rewriting the saved preferences.

```ts
chart.applyPaneLayout({
  panes: [
    { id: 'price', weight: 3, minHeight: 120 },
    { id: 'volume', weight: 1, minHeight: 48 },
  ],
});
const savedLayout = chart.getPaneLayout();
if (chart.canResizePane('price', 8)) chart.resizePane('price', 8); // Same actual-neighbor limits.
chart.applyPaneLayout({ maximizedPaneId: 'price' });
chart.applyPaneLayout({ maximizedPaneId: null });
chart.applyPaneLayout(savedLayout);
const unsubscribe = chart.subscribePaneLayoutChange((layout, meta) => {
  // Synchronous committed snapshot. meta.cause is api or interaction.
  console.log(layout.maximizedPaneId, meta.revision);
});
```

A patch may omit panes and fields; omitted values stay unchanged. Validate the whole batch before changing geometry. Unknown/duplicate IDs, unknown fields, invalid numbers and nonexistent maximize targets reject atomically. Explicit null restores all panes; explicit undefined is invalid. Effective no-ops emit no event. Existing pane-handle layout updates use the same commit path. The event is synchronous and separate from the deferred range/crosshair subscriptions. Getters never expose a drag preview. Reentrant layout changes stop delivery of an older layout revision, and observer errors are isolated.

Resize affects the next physical neighbor, or the previous one when the selected pane is last. It preserves the pair's combined weight and other pane heights at the current host size. There is no movement when maximized, when only one pane exists, or when minima consume all available height. Maximize changes geometry only: suppressed panes retain their data and resources while their geometry/scale is zero/null. Streaming updates continue. Range and follow-latest remain unchanged. Primitive projections omit zero-height panes; custom canvas primitives must honor these projections when drawing pane content.

`canResizePane(id, deltaCssPixels)` checks whether the same committed resize candidate would change preferences at the current chart size. It uses actual adjacent panes and representable weight limits, returns false for no movement, and rejects invalid IDs or nonfinite deltas consistently with `resizePane`. It does not mutate state, cancel a drag preview, notify observers or touch data/resources. Custom controls can use it to enable their corresponding resize action.

Separators support mouse and touch pointer capture, ArrowUp/Down (8px), Shift+Arrow (32px), and Home/End at attainable limits. Escape, pointer cancellation, blur, host resize or a valid authoritative layout/membership change cancels a preview. Invalid commands and ordinary data updates leave a preview intact. Only successful release commits it. Separators sit outside the chart image/primitive interaction root and use labelled separator semantics.

The pure `measurePaneLayout(layout, chartHeight)` export predicts ordered pane rectangles using the same normalized geometry as rendering. Pass full chart CSS height, including the time axis. Its `MeasuredChartPaneLayout` result contains `plotHeight` and `panes` with `id`, `top` and `height`. This is useful for a responsive presenter before applying its effective view; it allocates no chart or DOM.

## Data ownership and time

Input arrays/records are copied; returned data and event snapshots cannot mutate source storage. Values remain double precision. Label precision/tick formatting never alters stored values. The chart performs no split adjustment, feed fetching, currency conversion, or telemetry.

Intraday time is an integer UTC millisecond value, not seconds. The chart does not infer units. Daily data can instead select `timeDomain: 'business-date'` and use valid `YYYY-MM-DD` strings. Domains cannot be mixed on one chart. Daily labels remain calendar dates across display timezones.

`setData` requires strictly ascending unique timestamps. It validates the full replacement before swapping the data. Missing sessions are compacted on a logical time axis; no artificial candles are inserted.

`update` replaces the current newest timestamp or appends a later timestamp. It rejects a timestamp earlier than that series' newest point. If a new point is earlier than another series' newest chart time, its timestamp must already exist on the shared timeline. Historical corrections or prepends use `setData`.

```ts
price.update({ time: Date.UTC(2026, 8, 2), open: 103, high: 110, low: 102, close: 109 });
price.update({ time: Date.UTC(2026, 8, 3), open: 109, high: 111, low: 106, close: 107 });
```

Invalid values, impossible OHLC, bad dates, NaN and infinity fail atomically. Rendering coalesces intermediate visual states; the model still accepts every valid update.

## Navigation and events

Visible ranges use fractional logical indices in the shared timestamp union. `fitContent()` fits loaded history. `setVisibleRange({from,to})` clamps safely to loaded data. `scrollToLatest()` returns to the newest bar. When browsing history, new bars do not move the viewport.

Time/price coordinate conversions return null outside their plot/data domain. Crosshair values come from original points and preserve whitespace; they do not expose display-aggregation values.

```ts
const off = chart.subscribeCrosshairMove((event) => {
  const originalPoint = event.points[price.id];
  console.log(event.time, originalPoint);
});
chart.setVisibleRange({ from: 0, to: 100 });
off();
```

Crosshair and visible-range notifications coalesce to their final immutable snapshot per animation frame, in subscription order. Use `whenIdle()` in tests when queued drawing must finish. It means drawing submission is complete, not that the monitor has presented the pixels.

Mouse/trackpad: drag to pan and wheel to zoom around the cursor. Touch uses pointer gestures; chart gestures are contained inside the plot. Keyboard shortcuts are scoped to the focusable chart: arrows pan or move an active cursor, +/- zoom, Home fits, End follows latest, Escape cancels.

Canvas charts need accompanying text/data for assistive technology. The showcase demonstrates an explicit latest-data table, visible focus, labelled controls and a chart summary. It does not announce every streaming tick.

## Customization and export

Chart themes are `dark`, `light` or a partial ChartTheme. Theme tokens include background, text, mutedText, grid, border, crosshair, up, down, accent, fontFamily and fontSize. Options patches preserve the current data and viewport.

Series options include color/upColor/downColor, lineWidth, title, pricePrecision, tickSize, lastValueVisible, priceLineVisible, connectGaps and fillOpacity for boundary bands. By default, lines/areas/bands preserve whitespace gaps.

```ts
chart.applyOptions({ theme: { grid: '#25302b', fontSize: 11 } });
price.applyOptions({ upColor: '#7dbfa3', downColor: '#d68b96' });
const png = await chart.exportImage(); // Promise<Blob>, image/png, cursor excluded
```

Exports contain the visible chart/axes, excluding surrounding application controls and the transient cursor. Duration diagnostics are opt-in: `getDiagnostics()` returns drawing counts, point/series counts and recent library work durations; it does not report FPS or network latency. With diagnostics disabled, timing probes are skipped and duration fields are zero; inexpensive structural counters and framePending remain available.

## Indicators

Application integrations use the root `@filtrix.net/indicators` exports below. The `@filtrix.net/indicators/internal` subpath is reserved for the terminal package and may change with private cohort updates.

```ts
import { ema, createIndicator } from '@filtrix.net/indicators';
const values = history.map((p) => ({ time: p.time, value: p.close }));
const average = chart.addSeries('line', { color: '#d7bb7b' });
average.setData(ema(values, 20));

const live = createIndicator('ema', 20);
live.setData(values);
average.update(live.update({ time: next.time, value: next.close }));
```

SMA/EMA accept positive integer periods. RSI requires an integer period of at least 2. All output arrays preserve input timestamps and length; warm-up values are whitespace. Gaps reset the contiguous window.

SMA seeds after one full window. EMA seeds with that window's SMA, then uses alpha `2/(period+1)`. RSI uses Wilder smoothing seeded from a full period of price changes. Flat input returns 50, gains without loss 100, losses without gain 0.

Streaming indicators restore pre-tail state before replacing a current value. Repeated replacements must equal a fresh batch calculation. SMA/EMA/RSI initialization is linear; their append and tail replacement are constant-time.

### MACD and Bollinger Bands

The additive multi-output APIs return named arrays of `IndicatorPoint`. Each array retains every input timestamp, including whitespace during warm-up and gaps.

```ts
import { macd, bollingerBands, createMacd, createBollingerBands } from '@filtrix.net/indicators';

const momentum = macd(values, { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
// momentum.macd, momentum.signal, momentum.histogram
const envelope = bollingerBands(values, { period: 20, multiplier: 2 });
// envelope.middle, envelope.upper, envelope.lower

const liveMacd = createMacd({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
const liveBands = createBollingerBands({ period: 20, multiplier: 2 });
liveMacd.setData(values);
liveBands.setData(values);
const momentumFrame = liveMacd.update({ time: next.time, value: next.close });
const bandFrame = liveBands.update({ time: next.time, value: next.close });
// Frames contain named individual points. getData() returns copied named arrays.
```

MACD independently SMA-seeds its fast and slow price EMAs, then subtracts slow from fast. Its signal EMA starts from finite MACD points and uses its own SMA seed. The histogram is MACD minus signal; it remains whitespace until the signal is ready. With 12/26/9 periods, MACD first appears on the 26th contiguous input and signal/histogram on the 34th. These warm-up rules apply again after a gap.

Bollinger Bands use a rolling arithmetic mean and **population** standard deviation, with upper/lower equal to mean plus/minus `multiplier * standardDeviation`. The first value appears after one complete window. Constant input produces coincident boundaries. The calculation uses a centered, scaled deviation aggregate to preserve narrow spreads around large prices and representable bands at very small/large magnitudes. Bollinger initialization is O(n log period), append/tail replacement is O(log period), and its calculation window is O(period). MACD initializes in O(n) and updates in O(1). The named output histories are O(n), as required by getData; neither tail path scans retained history.

The math package requires safe integer periods: MACD fast >= 1, slow > fast and signal >= 1; Bollinger period >= 2. Its multiplier must be finite and positive. These standalone APIs do not impose the terminal's smaller UI/resource limits. Option fields are exact and calculation fields are required. Batch transforms infer the time domain as the existing indicators do; streaming factories accept an optional second `'utc-ms' | 'business-date'` argument.

Inputs, options and returned results do not share mutable records with calculation state. All named outputs commit together. Invalid input or an unrepresentable calculation (`INDICATOR_OVERFLOW`) preserves the previous state, including after an attempted same-timestamp replacement; a later valid update can recover.

The optional `@filtrix.net/terminal` package manages these outputs as one configurable study, including the oscillator pane, histogram colors, boundary lines and fill. See the [terminal contract](TERMINAL-CONTRACT.md) and [v0.7 design](../SOURCE-DISTRIBUTION.md#omitted-development-materials) for study defaults and resource limits. The current terminal writes workspace v5 with saved pane layout and alerts, and accepts exact v1–v4 migrations.

## React

```tsx
import { useRef } from 'react';
import { FiltrixChart, type ChartApi } from '@filtrix.net/react';

export function MarketChart() {
  const api = useRef<ChartApi | null>(null);
  return (
    <FiltrixChart
      ref={api}
      style={{ height: 420 }}
      options={{ theme: 'dark' }}
      onReady={(chart) => {
        chart.addSeries('candlestick').setData(history);
        chart.fitContent();
      }}
    />
  );
}
```

The adapter handles create/destroy and React StrictMode remounts. Options patches do not recreate the chart. `onReady` receives the created API; use that argument for initialization. The forwarded ref is set during the effect lifecycle and cleared on unmount. Feed updates belong in the imperative API, avoiding React updates per frame. React is a peer dependency, outside the chart engine.

## Formatting, gaps and performance scope

A pane uses the first nonempty attached series in insertion order for axis/crosshair price formatting. Set that series' pricePrecision and/or tickSize to define the pane's label policy; individual last-value labels retain each series' own configuration. Formatting never changes stored values.

Both explicit whitespace and timestamps missing from a series on the shared union break line/area/band paths by default. connectGaps opts into bridging. Options patches merge specified fields; undefined fields are ignored. Theme-token patches merge with the active theme, while choosing a named theme selects that preset. To resume automatic following, enable followLatest and call scrollToLatest.

Dense candles use indexed OHLC ranges per display bin. Dense histogram sums preserve representable cancellation; genuinely unrepresentable bin totals saturate to ±Number.MAX_VALUE for display while source snapshots remain unchanged. Histogram autoscale and dense sums scan visible originals; they are O(visible rows), and are a different workload from the single-candle timing gate. Bands use indexed extrema from both boundaries and keep independent gap runs. History replacement refreshes numeric-run indexes; changing timestamp keys can require a shared-union rebuild and sort. Equal-key replacements reuse shared timestamps and preserve the viewport. Tail updates avoid a full-history rebuild, with ordinary amortized buffer growth at capacity boundaries. A benchmark of one candle series is not a performance claim for every series/pane combination.

## Errors across packages

Use the exported isChartError guard and error.code when sharing handling across independently bundled packages:

```ts
import { isChartError } from '@filtrix.net/charts';

try {
  price.update(nextPoint);
} catch (error) {
  if (isChartError(error)) console.error(error.code, error.message);
  else throw error;
}
```

Each self-contained bundle owns its ChartError constructor, so cross-package instanceof identity is not guaranteed. The guard also accepts a serialized error envelope with matching name, code and message fields. See the [package identity decision](../SOURCE-DISTRIBUTION.md#omitted-development-materials).

## Drawing tools and extensions

The optional @filtrix.net/drawings package adds trend lines, price levels, rectangles, measurements, Fibonacci retracements, parallel channels and text notes with bounded undo/redo. Canonical drawing documents use version 2 and the shared decoder migrates historical version 1. Layer snapping is optional; the terminal uses indexed OHLC lookup and a native object editor. See the [drawing guide](DRAWINGS.md) and [advanced tools, limits and migration](DRAWING-TOOLS.md). Custom overlays use ChartApi.attachPrimitive with an immutable projection snapshot; see [primitive integration](PRIMITIVES.md). Existing scene/cursor behavior remains independently scheduled.

## Linked analysis and replay

The optional @filtrix.net/analysis package provides semantic-time viewport/cursor synchronization, exact-common-baseline comparison and deterministic whole-bar replay. The additive ChartApi controls expose loaded time ranges, controlled vertical cursors and mutation-time origin/revision metadata. See the [analysis integration guide](ANALYSIS.md) and [chart control contract](CHART-SYNC-CONTRACT.md).

## Price alerts

@filtrix.net/alerts provides a headless persisted rule store and grouped latest-feed monitor. @filtrix.net/terminal integrates all-market native controls, onAlert, getAlerts/getAlertState and workspace v5. Each supplied store/monitor is borrowed independently; owned defaults require no additional feeds while empty. See [crossing semantics, limits and ownership](ALERTS.md).

## Saved terminal grids

`createTerminalGrid` from `@filtrix.net/terminal` composes one, two or four visible terminals in four persistent slots. Each slot retains its own market, studies, drawings, panes and alerts. Hidden slots release chart resources while their armed alerts remain monitored. Viewport and cursor synchronization are separate opt-ins; readiness and event-cause filtering keep history updates local. Grid workspace version1 nests the terminal documents and stores layout, active cell and synchronization preferences. See the [grid methods, persistence and ownership contract](TERMINAL-CONTRACT.md#saved-terminal-grids) and the independent React example's Grid view.
