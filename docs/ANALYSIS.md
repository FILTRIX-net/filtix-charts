# Synchronized analysis and historical replay

The optional @filtix/analysis package exports createChartSync, buildIndexedComparison and createHistoryReplay. Package imports, buildIndexedComparison and createHistoryReplay construction are safe during server rendering. createChartSync requires live chart instances mounted in the browser.

## Link charts by time

```ts
import { createChartSync } from '@filtix/analysis';

const linked = createChartSync([bitcoinChart, ethereumChart], {
  viewport: true,
  crosshair: true,
  crosshairMatch: 'exact',
});
// Either member can lead native pan/zoom/cursor input.
// Remove only the group's subscriptions on teardown:
linked.destroy();
```

Use at least two distinct live charts with the same time domain and one active group per chart. The first chart initializes available target viewports. Changes then synchronize semantic loaded timestamps, including across histories with different missing bars. The group does not copy logical indices, manufacture data or modify the source chart to match a narrower target.

The optional `causes` list selects which later events may lead the group. Use `causes: ['interaction', 'api']` to link navigation and programmatic changes while keeping data-driven viewport movement local. Omission preserves synchronization of all three causes (`interaction`, `api`, `data`). The list is validated and copied at construction. An empty list disables later propagation but preserves initial alignment from the first chart. This filter applies to both viewport and crosshair events; it does not replace the origin and revision fences.

A target interval selects its first loaded timestamp at/after the requested start and last at/before the requested end. No overlap leaves the target unchanged. A one-point interval expands toward an available neighbor to keep a usable logical span; a one-point entire history remains valid. These are loaded-bar boundaries, not elapsed-time interpolation. To align every grid position across missing bars, supply a common timeline with explicit whitespace points.

Exact cursor matching hides a target cursor where that timestamp is absent. Optional nearest matching resolves to an actual loaded timestamp, with ties going to the earlier date/time; business dates use calendar-day distance. It does not invent an interpolated price. Programmatic cursors are vertical-only and expose actual series values. Native pointer input restores the usual full cursor.

destroy is idempotent and does not destroy charts or reset viewports. It leaves the last mirrored cursor until the next native/programmatic cursor update. A member destroyed independently is detached from propagation; remaining peers continue. Normal charts have an immutable time domain. A structurally supplied member that later reports a different domain is also detached. Failed setup removes successful subscriptions.

## Semantic chart controls

```ts
const origin = {};
const before = chart.getChangeRevision();
const applied = chart.setVisibleTimeRange({ from: startTime, to: endTime }, { origin });
chart.setCrosshairTime(selectedTime, { origin, match: 'nearest' });
const off = chart.subscribeVisibleRangeChange((logicalRange, meta) => {
  console.log(meta.cause, meta.revision, meta.origin === origin);
});
```

ChartApi.timeDomain is readonly. getVisibleTimeRange returns loaded boundaries or null when no loaded timestamp falls inside the visible interval. Inputs are validated before mutation. A resolved offscreen controlled time may be returned while its cursor is hidden; retained time anchors reproject when the viewport or loaded data changes. Passing null clears the cursor. Exports omit it.

Subscriptions accept a second metadata argument while existing one-argument callbacks remain compatible. cause distinguishes interaction, api and data changes. revision is assigned at the causative synchronous mutation, not when a queued frame finally emits it. Coalescing keeps revision/cause/origin from the same effective channel change; no-ops do not replace pending metadata. Origin objects retain identity.

The synchronization helper captures a membership revision fence and owns a private origin token. Thus old queued events cannot overturn first-chart initialization, and asynchronous notifications of mirrored changes cannot bounce between charts. A synchronous boolean reentrancy guard would not cover rAF notifications.

## Compare from a common baseline

```ts
import { buildIndexedComparison } from '@filtix/analysis';

const indexed = buildIndexedComparison(
  [
    { id: 'BTC', points: bitcoinCloses },
    { id: 'ETH', points: ethereumCloses },
  ],
  { baseValue: 100 },
);
for (const asset of indexed) {
  chart.addSeries('line', { id: asset.id }).setData(asset.points);
  console.log(asset.baseline.time, asset.baseline.value);
}
```

Input timestamps must be strictly increasing and unique. Present prices and baseValue must be finite and positive; whitespace is preserved. Each ID uses 1–80 ASCII letters/digits/\_/-. The default domain is utc-ms; business-date can be specified.

Without baselineTime, the earliest timestamp with a present price in every asset is selected. An explicit baseline must exist in all assets. No common present timestamp is an error. The result retains each asset's timestamps/gaps and reports its raw baseline value. Values are normalized to baseValue times price/baseline; invalid or unrepresentable results fail atomically. There is no carry-forward, interpolation or price adjustment.

Data before an explicitly later baseline stay in the result. Applications control their disclosure window; pass only already revealed histories during replay.

## Reveal complete bars

```ts
import { createHistoryReplay } from '@filtix/analysis';

const replay = createHistoryReplay({
  bars: historicalCandles,
  barsPerSecond: 4,
  onChange(change) {
    if (change.type === 'reset') {
      candles.setData(change.bars);
      // Rebuild volume and indicators from this revealed prefix too.
    } else {
      for (const bar of change.bars) candles.update(bar);
    }
  },
  onState(state) {
    renderPlaybackControls(state);
  },
});
replay.seek(120); // Revealed count, not an array index. Always pauses.
replay.play();
replay.pause();
replay.step(); // Reveal one complete bar and pause.
replay.setSpeed(16);
replay.destroy();
```

History is copied and validated at construction; construction starts no timer and emits no callback. Position ranges from zero to the total count. Empty history is ended; other histories initially pause at zero. getData exposes only an owned copy of the revealed prefix. Step supports a positive safe integer count; seek supports any valid revealed count and emits one reset.

Playback reveals one complete historical candle per scheduled timeout, in source order. Speed ranges from 0.25 to 64 bars per second, default4. Delayed timers do not catch up wall-clock gaps. There is no invented intrabar path, order simulation or strategy backtest. At the end, play does nothing until seeking earlier.

Pause, seek, speed changes and destroy invalidate stale scheduled callbacks. Callback exceptions are isolated; reentrant changes cancel stale subsequent notifications and scheduling. Append events contain only newly revealed bars; reset events contain the complete revealed prefix. onChange precedes onState for the same committed state. Event/getter data cannot change internal history. Destroy is idempotent and emits nothing; getters remain usable with status destroyed, while later mutations reject.

The original /analysis.html screen composes a fixed synthetic hourly BTC master clock with sparse ETH/SOL histories by timestamp cutoff. It rebuilds price/volume/EMA/comparison series on seek and never feeds future bars into them. A version1 browser-local workspace stores fixture identity, position, speed, themes and view settings/ranges; full validation precedes application, and loading always pauses. Writes are explicit Save actions. The live market and editable study remain separate screens.

See [exact analysis types](ANALYSIS-CONTRACT.md), [chart control contract](CHART-SYNC-CONTRACT.md) and the [design](../SOURCE-DISTRIBUTION.md#omitted-development-materials).
