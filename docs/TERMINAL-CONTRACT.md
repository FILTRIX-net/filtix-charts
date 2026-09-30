# Embedding the FILTRIX terminal

@filtrix.net/terminal is an optional framework-independent composition of charts, datafeed, drawings, indicators, analysis and alerts. The current development candidate is 0.12.0-beta.1. Its distribution status and prerequisites are in the [beta guide](OPEN-SOURCE-BETA.md); it has not been announced as published. Importing the package in Node/SSR does not create DOM, transport or timers; createTerminal and createTerminalGrid run in a browser.

## Install the beta packages

Generate the Apache-2.0 local beta cohort in this repository:

```sh
npm run build
npm run pack:local
npm run check:consumer
```

The last command verifies and builds the included independent React application. To install the same cohort in another application, run the following command from that application's directory. This example assumes your application is beside a checkout named filtrix-charts; adjust the relative archive directory for your layout. React is needed by @filtrix.net/react, while @filtrix.net/terminal itself has no React dependency.

```sh
npm install ../filtrix-charts/dist/packages/filtrix.net-core-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-charts-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-indicators-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-react-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-datafeed-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-drawings-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-analysis-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-alerts-0.12.0-beta.1.tgz ../filtrix-charts/dist/packages/filtrix.net-terminal-0.12.0-beta.1.tgz react@19.2.8 react-dom@19.2.8
```

Use a browser ESM bundler such as the one in the [working React example](../examples/react-terminal/README.md). Keep all FILTRIX peer packages in the same exact 0.12.0-beta.1 cohort. For a framework-independent terminal-only application, charts, datafeed, drawings, indicators, analysis, alerts and terminal are sufficient; core and the React adapter remain separately usable packages. No registry publication is required.

## Mount and dispose

```ts
import { createTerminal } from '@filtrix.net/terminal';
import { createBinanceProvider } from '@filtrix.net/datafeed';
const terminal = createTerminal(host, {
  provider: createBinanceProvider(),
  query: { symbol: 'BTCUSDT', interval: '1m' },
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  intervals: ['1m', '5m', '1h'],
  settings: { theme: 'dark', volume: true },
  studies: [
    { kind: 'ema', period: 20, color: '#c27a50' },
    { kind: 'sma', period: 200, color: '#c7ef57' },
    { kind: 'bollinger', period: 20, multiplier: 2, fillOpacity: 0.12 },
    { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    { kind: 'rsi', period: 14, color: '#a8a0dc' },
  ],
  onState(state) {
    const ready = !state.destroyed && state.error === null && state.feed.status === 'live';
    // Reflect state.feed.status and state.error in your host UI.
  },
});
// The host must have width and height (for example, height: 570px).
await terminal.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
terminal.destroy(); // Safe to repeat; call on unmount.
```

Provider identity and UTC-millisecond time domain are fixed for an instance. Change providers by destroying and remounting. Catalogs default to the initial query only; supplied catalogs must contain it, with unique nonblank strings and at most 32 symbol/interval combinations. setMarket on the current query does nothing. A settled promise means a load attempt finished, not necessarily live data: inspect both terminal error and feed state.

In React, mount inside an effect and return destroy as cleanup. Keep streaming data outside React state; pass only coarse status to your app state. The [independent React application](../examples/react-terminal/README.md) demonstrates this with StrictMode and installs actual archives using its own lockfile, with no source aliases. Its root is outside the workspace package glob.

## Data and studies

The terminal owns candles, optional volume, and a global ordered set of SMA, EMA, RSI, MACD and Bollinger instances. SMA/EMA and Bollinger overlay price. Each visible RSI or MACD owns a separate linear autoscaled pane; all three MACD outputs share its pane. RSI does not force an axis range of 0..100. Bollinger owns three lines and one boundary fill on the price pane.

History, backfill, reconnection resets and historical corrections rebuild visible studies from the same authoritative close history as price. Tail appends/revisions increment each visible calculator once and update its fixed outputs without reading retained history. Warm-up values remain whitespace: SMA/EMA/Bollinger need period input prices, RSI needs period+1, MACD needs slowPeriod and signal/histogram need slowPeriod+signalPeriod-1. See the [indicator API](API.md#macd-and-bollinger-bands) for seeding and population-variance definitions.

### Manage individual instances

```ts
const id = terminal.addStudy({ kind: 'ema', period: 50, color: '#66b9c7' });
terminal.updateStudy(id, { period: 80, lineWidth: 3 });
terminal.updateStudy(id, { visible: false });
const studies = terminal.getStudies(); // Defensive ordered snapshot.
terminal.removeStudy(id); // true once; false if already absent.
```

Exported types include `TerminalStudyKind`, `TerminalStudyOptions`, `TerminalStudy`, and `TerminalStudyPatch`. Options and resolved descriptors are discriminated unions. Named variants are `TerminalSingleStudyOptions`, `TerminalMacdStudyOptions`, `TerminalBollingerStudyOptions` and their resolved `TerminalSingleStudy`, `TerminalMacdStudy`, `TerminalBollingerStudy` forms. Host code reading descriptors should narrow by `kind`: MACD has fast/slow/signal periods, while the other variants have `period`. A previous host loop that reads `study.period` unconditionally needs this branch when upgrading its TypeScript types.

`addStudy` returns a stable opaque ID. `updateStudy` accepts only mutable fields belonging to that instance's kind; changing kind or ID requires a new instance. Updating an absent well-formed ID throws; removing one returns false. Lookup IDs must be `terminal-ema` or canonical `study-N` strings with N a positive safe integer: malformed, non-string, unsafe and noncanonical IDs throw TypeError. Treat generated IDs as opaque even though validation restricts their shape. Effective no-op patches do not rebuild or notify.

| Kind      | Required calculation fields          | Optional style fields and defaults                                               |
| --------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| sma       | period                               | color #c7ef57                                                                    |
| ema       | period                               | color #c27a50                                                                    |
| rsi       | period                               | color #a8a0dc                                                                    |
| macd      | fastPeriod, slowPeriod, signalPeriod | color #7aa2f7, signalColor #e0af68, positiveColor #73c991, negativeColor #ef7c8e |
| bollinger | period, multiplier                   | color #c7ef57, upperColor/lowerColor/fillColor #7aa2f7, fillOpacity 0.12         |

All kinds also accept `lineWidth` (default 2) and `visible` (default true). `color` styles the single line, MACD line or Bollinger middle line. One width applies to a group's lines, not histogram bar width. MACD histogram values >= 0 use positiveColor; negative values use negativeColor. Bollinger boundaries have independent colors and its fill stays between them, with gaps preserved. New groups show one legend title and a last-value axis label for the primary MACD or middle line; secondary outputs remain available in crosshair snapshots without overlapping extra axis labels. Group price lines are disabled.

All terminal periods are integers 2..500; MACD requires fastPeriod < slowPeriod and an independently valid signalPeriod. The Bollinger multiplier is finite, greater than 0 and at most 10; fractions are allowed. Fill opacity is finite 0..1. Colors are exactly #RRGGBB, normalized lowercase; widths are integers 1..4. These calculation fields are required by add/constructor APIs. The editor offers defaults SMA20, EMA20, RSI14, MACD12/26/9 and Bollinger20x2.

Unknown and foreign-kind fields, explicit undefined/null, nonfinite numbers, coercible strings and inherited required fields are rejected. Updates validate the complete merged candidate atomically: for example, changing MACD12/26 to30/40 requires one patch containing both periods; changing fast to30 alone rejects without altering the study.

```ts
const macdId = terminal.addStudy({ kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
terminal.updateStudy(macdId, { fastPeriod: 30, slowPeriod: 40, signalColor: '#e0af68' });
const bandsId = terminal.addStudy({ kind: 'bollinger', period: 20, multiplier: 2 });
terminal.updateStudy(bandsId, { fillOpacity: 0 }); // Retains the fill handle and its reservation.
```

### Resource limits and lifetime

| Stored kind | Study-series reservation | Oscillator-pane reservation |
| ----------- | ------------------------ | --------------------------- |
| SMA / EMA   | 1                        | 0                           |
| RSI         | 1                        | 1                           |
| MACD        | 3                        | 1                           |
| Bollinger   | 4                        | 0                           |

All three caps apply together: **8 stored instances, 3 combined RSI/MACD pane reservations, and 20 study-series reservations**. Hidden and legacy instances count. A Bollinger fill counts even when its opacity is zero. Price and optional volume add two base series and panes, giving a maximum of 22 terminal-owned series and 5 panes. Caller-owned chart resources are outside these terminal caps.

A cap violation rejects before side effects and never evicts another study. Hiding releases all actual output handles, calculator/history and oscillator pane while retaining its configuration and full reservation; showing hydrates current data. Removal releases the configuration too. Style changes do not read history or recalculate; calculation changes rebuild only the affected visible group. Hidden edits allocate no chart resources. Oscillator panes are linear/autoscaled, use weight 0.30 and minHeight 72, and follow visible registry order.

IDs survive parameter edits, market switches and workspace restore. Generic IDs are terminal-local; treat their spelling as opaque. Successful restores advance a bounded monotonic allocator, so new IDs are not reused during that terminal lifetime. At safe-integer namespace exhaustion, addStudy fails atomically. Restoring existing identities is still allowed.

### Compatibility with the v0.5 EMA setting

Omitting constructor studies preserves the old default EMA 20; settings.emaPeriod:null starts without it. Supplying studies, even [], replaces that default. Do not combine explicit studies with an explicitly present settings.emaPeriod; the constructor rejects ambiguous input before DOM or provider activity.

The reserved terminal-ema instance is the sole source for the compatible getSettings().emaPeriod value: its period when visible, otherwise null. Ordinary EMA instances do not affect that value. applySettings({emaPeriod:20}) creates or updates/enables the reserved instance; it preserves an existing instance's color/width. applySettings({emaPeriod:null}) removes only that reserved instance. The legacy toolbar shortcut and the study editor share this state. Creating the reserved instance at the 8-instance cap rejects the whole settings patch before any theme/volume change.

TerminalState includes studies; each effective committed study mutation publishes one coherent defensive settings/study snapshot. Validation failures, no-ops, unknown removals and work superseded before commit do not publish a mutation notification. If onState synchronously removes a newly committed study or destroys the terminal, the method still returns its committed result normally. Work superseded before commit throws Terminal mutation was superseded without publishing a composition error. Chart/runtime composition failures prevent ready status and remain visible until a successful full canonical repair; unrelated UI or style changes do not clear them.

loadMore loads older history. retry explicitly restarts from latest initial history and discards backfill; do not call it automatically on every focus event. The existing feed session watchdog handles ordinary disconnect/stale recovery, including forward gaps and the overlap at the previous tail. Older server corrections require a provider event or explicit applyCorrections delivery; the forward-recovery algorithm cannot discover arbitrary changes before its requested range.

feed options are the existing FeedSessionOptions without provider/onChange/onState and are constructor-only. Defaults include a 100,000-bar cap; reaching the cap stops with a visible error. This is bounded fail-closed retention, not rolling eviction or unlimited history. Choose limits appropriate to the application and listen for limit/retry/stale states. maxBufferedBars and recovery/request/retry limits remain enforced by the datafeed package.

## Saved pane layout

Use terminal layout APIs for preferences that should survive study visibility, market changes and workspace Save/Restore. The canonical array always contains price, volume (even when disabled), then every stored RSI/MACD pane in registry order, including hidden studies. Removing a study removes its entry; adding an oscillator initializes its defaults. Showing or recreating an oscillator restores its saved preference. Caller-owned chart panes are excluded.

```ts
terminal.applyLayout({
  panes: [{ id: 'price', weight: 2, minHeight: 160 }],
  studiesOpen: true,
});
const layout = terminal.getLayout();
terminal.applyLayout({ maximizedPaneId: 'price' });
terminal.applyLayout({ maximizedPaneId: null }); // Restore saved proportions.
terminal.resetLayout(); // Restore defaults and close the study editor.
```

Maximize requires a currently visible terminal pane; check the corresponding study's visibility before using an oscillator entry. Hiding/removing its target clears maximize in the same state commit. The public types are `TerminalPaneId`, `TerminalPaneLayout`, `TerminalLayout` and `TerminalLayoutPatch`. `TerminalOptions.layout` accepts an initial patch; `TerminalState.layout` is the defensive committed snapshot. Discover generated pane IDs through `getLayout` rather than predicting the study allocator.

| Pane                 | Default weight | Default minimum CSS px |
| -------------------- | -------------- | ---------------------- |
| price                | 1              | 160                    |
| terminal-volume-pane | 0.26           | 64                     |
| stored RSI/MACD pane | 0.30           | 72                     |

Terminal weights are positive finite numbers. Minimum heights are integers from 24 to 2048; patches merge by exact existing semantic ID. Unknown/duplicate IDs, inherited required fields, unknown fields, symbols, explicit undefined/null (except nullable maximize), invalid numbers and foreign maximize targets reject before mutation. Reset affects hidden entries too, closes the editor and clears maximize; it preserves study settings, drawings, market, data, theme, visible range and follow-latest. Geometry changes keep study/series/calculator resources alive and do not read history or rebuild indicators.

Each effective terminal layout commit emits one coherent `onState` notification; no-ops, invalid candidates, previews and measured host resizing do not. A successful native separator release updates canonical state synchronously, so a workspace read immediately afterward sees it. `onState` is the coherent terminal boundary: a low-level chart observer during terminal synchronization may see the prior terminal snapshot and may supersede the operation.

The mutable `terminal.chart` offers lower-level effective layout edits. Changed owned weights and terminal-valid changed minima/maximize are adopted; unchanged effective fields are not copied back. Generic chart minima outside the terminal range or a caller-pane maximize remain effective-only until the next terminal reconciliation. Use `TerminalApi.applyLayout` for unambiguous saved intent, especially when a temporary editor price focus already has the same effective maximize target. A physical neighbor may belong to the caller, and resizing can adjust its opposite weight; terminal reset/persistence never serializes or resets it. Chart-wide maximize suppresses caller panes visually while retaining their options/resources.

## Responsive study editor

The editor uses the terminal host's dimensions. At host width >= 900 px it occupies a right rail; narrower hosts use a bounded lower region or, in short bodies, a contained bottom sheet. Toolbar/footer chrome and editor content scroll internally rather than overflowing the host. Fields remain keyed native controls across these placements, preserving focus, drafts and selection during streaming. Opening/closing moves focus predictably; the panel has a persistent close action.

With the editor open, supported hosts of at least 320 × 360 px preserve at least 96 CSS px of actual unobscured price plot unless the user explicitly maximizes another pane. If ordinary pane allocation cannot provide that space, the presenter temporarily focuses price and displays “Price focused while editing.” Canonical `maximizedPaneId` stays null; `chart.getPaneLayout()` reports the effective price focus. The action “Close editor and restore panes” closes the editor and returns to saved proportions. More space or closing the editor restores normal geometry automatically. Smaller/zero hosts stay finite, contained and recoverable; a readable plot height cannot be guaranteed when the host is physically too small.

The Resize pane chooser selects the target of Grow/Shrink/Maximize without changing the view. This transient choice starts at price and is not saved. A separate View chooser reflects the saved maximize choice, including All panes; its null option explains temporary price focus while editing. Grow/Shrink shares the engine's adjacent-pair resize path and queries `canResizePane` with its +8/-8 CSS px intent. The selector contains only visible terminal-owned targets, but an actual caller-owned neighbor participates in resizing. Buttons disable when the shared engine candidate cannot move, including representable weight endpoints. Native Restore/Reset buttons and separator drag/key input stay separate from drawing and chart navigation. These controls do not require a specific framework or external storage.

## Workspace storage

```ts
const key = 'my-app:terminal:v1:binance'; // Separate app/provider/user scopes as needed.
let mounted: typeof terminal | null = terminal;

function reportPersistence(message: string) {
  console.info(message); // Replace with your host UI status.
}

function saveWorkspace() {
  const instance = mounted;
  if (!instance || instance.getState().destroyed) return;
  try {
    localStorage.setItem(key, JSON.stringify(instance.getWorkspace()));
    reportPersistence('Workspace saved');
  } catch (error) {
    reportPersistence('Save failed: ' + String(error));
  }
}

async function restoreWorkspace() {
  const instance = mounted;
  if (!instance || instance.getState().destroyed) return;
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return;
    await instance.restoreWorkspace(JSON.parse(saved));
    if (mounted !== instance || instance.getState().destroyed) return;
    const state = instance.getState();
    reportPersistence(state.error ?? 'Workspace restored; feed is ' + state.feed.status);
  } catch (error) {
    if (mounted === instance && !instance.getState().destroyed) {
      reportPersistence('Restore failed: ' + String(error));
    }
  }
}

function unmount() {
  const instance = mounted;
  mounted = null;
  instance?.destroy();
}
```

Storage is host-owned and explicit. The library never accesses localStorage. Handle unavailable storage, parse failures and restore errors in your UI, and fence asynchronous results to the still-current mounted instance.

getWorkspace writes schema filtix-terminal, version 5. Documents include providerId, query, global settings (theme/followLatest/volume), ordered studies, required canonical layout (panes/maximizedPaneId/studiesOpen) markets containing per-query filtix-drawings version 2 documents, and the persisted all-market alerts document. Drawing documents store all seven types, visibility, geometry locking and type-specific settings. emaPeriod is not persisted in v2/v3/v4/v5. Layout contains no pixels, viewport, editor placement, focus, drafts or drag preview. They contain no bar history, provider configuration, URLs, secrets or credentials. Saved alerts contain thresholds and last-trigger prices/timestamps. Provider identity and all catalog entries must match the mounted instance. The active market must be included. The whole document is validated before settings, drawings or market are changed; malformed/unknown/duplicate/oversized data rejects atomically. Each market has at most 200 drawings. The active store has at most 100 undo steps; switching creates a fresh undo stack so one market cannot resurrect another market's drawings.

restoreWorkspace accepts strict v1, v2, v3, v4 and v5 documents. V1 non-null emaPeriod migrates to one visible reserved EMA with the original period/default style; null migrates to no studies. V2 first validates the exact old SMA/EMA/RSI document shape and limits, then preserves identities, order and styles in v5. A document labelled v2 containing MACD or Bollinger is invalid. V3 requires every stored calculation/style field for its kind; missing styles are not silently filled. A v2/v3/v4/v5 settings.emaPeriod field is rejected. Old v1/v2/v3 documents reject a layout field, then migrate to a complete default layout, including hidden oscillator entries and disabled volume. V4 requires complete layout membership once each, every required field and a visible maximize target; entry order is normalized by semantic ID.

Query, global settings and per-market drawings are preserved during migration. The complete document, including every study, resource reservation and drawing, validates before transport aborts, provider activity, ID allocation or chart changes. A late invalid entry cannot partially adopt earlier ones or consume IDs. Use explicit `TerminalWorkspaceV1`, `TerminalWorkspaceV2`, `TerminalWorkspaceV3` and `TerminalWorkspaceV4` for frozen historical types with nested drawing version 1. `TerminalWorkspaceV4WithDrawingsV2` freezes historical v4 with nested drawing version 2. `TerminalWorkspace` is current v5 with nested drawing version 2 and alerts. Historical v1–v4 migrate with an empty alert document using the mounted store scope; exact old envelopes reject the v5-only alerts field. The shared drawing decoder migrates old nested documents before adoption. Layout and drawings validate before cancelling an in-progress separator preview.

Keep existing host storage keys when upgrading so old saves remain discoverable. Restore migrates in memory; the next explicit Save writes v5 to that key. Pre-v0.10 packages cannot read workspace v5. Pre-v0.8 libraries cannot read workspace v4; v0.8.x packages also cannot read its new nested drawing-v2 documents. The example's v1 suffix is retained for storage-key continuity, not the serialized schema version.

The toolbar includes Fibonacci, Channel and Note tools plus transient OHLC Magnet. Objects opens a bounded native editor for every saved drawing, including hidden/locked ones. A validated Apply commits the complete draft once, while streaming preserves focused drafts. Fill settings apply to rectangles, measurements, channels and notes. See the [advanced drawing guide](DRAWING-TOOLS.md) for exact limits, snapping and migration.

getDrawings returns the current pure DrawingStore for advanced editing. Reacquire it after a market switch or workspace restore; old stores no longer control the terminal. The caller owns subscriptions it adds to those stores. The terminal removes its own subscriptions/layer on switch. getWorkspace/getStudies/getSettings/getState/getLayout return defensive snapshots; after destroy these remain readable, retaining only bounded final document/state/settings snapshots. Price/study histories, live transports, active undo stacks and DOM resources are released. getData returns a defensive price snapshot while mounted and throws after destroy. getAlerts returns the current store reference; getAlertState returns its monitor snapshot. Owned alert resources are destroyed; supplied borrowed resources survive and can continue changing independently of the terminal's final workspace. Apart from these alert accessors, the five cached getters and idempotent destroy, synchronous terminal methods throw after destruction and Promise-returning methods reject; the exposed chart follows its own lifecycle contract.

## Styling and ownership

Controls expose labels for instrument, interval, theme, volume, legacy EMA, individual studies and drawing tools. The study panel exposes each kind's calculation and style fields, including MACD fast/slow/signal periods and histogram colors, Bollinger multiplier/boundary colors/fill opacity, plus width, visibility and removal. Keyed rows preserve native focus and drafts during streaming; explicit programmatic changes and restores take precedence. Invalid edits retain committed settings and display an inline error. At capacity, Add is disabled. The panel can scroll vertically; controls wrap according to the host container width, including a narrow embed inside a wide page. The chart automatically observes host size changes; give its host a nonzero CSS width and height. Styles are scoped to the terminal root. CSS variables include --filtix-terminal-bg, --filtix-terminal-panel, --filtix-terminal-text, --filtix-terminal-muted, --filtix-terminal-accent, --filtix-terminal-copper, --filtix-terminal-border and --filtix-terminal-font. Override on the owned root with a host-qualified selector such as #my-chart [data-filtix-terminal]. Chart canvas appearance can be adjusted with terminal.chart.applyOptions({theme:{...}}); applying terminal theme settings later reapplies its theme.

Terminal-owned chart series use stable IDs: terminal-price for candles, terminal-volume for volume and terminal-ema for the reserved legacy EMA. An ordinary single-output study uses terminal-${study.id}. MACD uses terminal-${study.id}-macd, -signal and -histogram; Bollinger uses terminal-${study.id}-middle, -upper, -lower and -fill. A visible RSI or MACD pane uses terminal-${study.id}-pane. Use the returned study ID as an uninterpreted suffix to associate crosshair points or pane coordinates with getStudies() descriptors. Band crosshair records contain both lower and upper bounds. Hidden studies have no chart series or oscillator pane.

The readonly chart property exposes the full, mutable ChartApi. It enables advanced navigation, crosshair subscriptions, diagnostics and exportImage; readonly prevents replacing the property, not calling chart mutations. Do not destroy it or remove terminal-owned series/panes. Use the terminal study APIs for their data/calculation/lifetime and terminal layout APIs for canonical geometry preferences. Let terminal.destroy own their lifetime. Additional caller subscriptions must be removed by their owner. The terminal appends/removes only its own DOM root; sibling host contents remain caller-owned.

The generated drawing-N namespace uses an internal bounded integer cursor. Accepted canonical supplied/restored IDs advance the cursor, so generated numbers may skip gaps. IDs are opaque. After the finite 80-character namespace is exhausted, auto-add throws ChartError with code DRAWING_ID_EXHAUSTED atomically; valid custom IDs still work. Undo never rewinds generated identities.

## Local verification

From the repository root: npm run build, npm run pack:local, npm run check:consumer. The latter verifies nine archives and all 45 members, actual copied installation paths, strict types, production build and SSR imports. Charts, indicators and alerts each include their internal entry (seven members per archive); the other six archives each contain four members. These private entries do not change the supported public ChartApi or SeriesHandle contract. Start the consumer with npm run dev in examples/react-terminal. At http://127.0.0.1:5195/ the consumer uses public Binance Spot; http://127.0.0.1:5195/?source=fixture uses explicitly synthetic wall-clock data. The root showcase terminal is at http://127.0.0.1:5173/terminal.html and uses the live provider. These commands build and verify the library locally.

The v0.7 multi-output workload separately measures the maximum 100k-row scene and a real elapsed installed-consumer session. See the [performance methodology](PERFORMANCE.md) for exact compositions, budgets and commands. The preserved v0.6 study workload describes its own earlier composition. The historical v0.5 native one-hour evidence qualifies its recorded three-series workload; it is not reused as evidence for the new maximum-study scene. Viewport testing and desktop smoke do not establish physical phone/laptop performance.

The chart scene has a bounded Canvas legend. Configure it through `terminal.chart.applyOptions({ legend: { visible: true, maxRows: 2 } })`; defaults are visible and two rows, with an allowed row limit from1 to4. Titles wrap/shorten within the plot and an exact `+N` count identifies omitted titles. The complete Indicators list remains reachable. This chart preference is transient and does not alter the strict terminal workspace v5 schema.

## Price alerts

Alerts opens a native editor for rules across the entire configured market catalog. Rules monitor their saved queries independently of the displayed chart. Use getAlerts(), getAlertState() and onAlert; alerts.store/monitor can each be supplied independently as borrowed resources. Empty stores create no monitoring feeds. See [price alert semantics, limits, persistence and ownership](ALERTS.md).

## Saved terminal grids

```ts
import { createTerminalGrid } from '@filtrix.net/terminal';

const grid = createTerminalGrid(host, {
  provider,
  query: { symbol: 'BTCUSDT', interval: '1m' },
  symbols: ['BTCUSDT', 'ETHUSDT'],
  intervals: ['1m', '5m'],
  layout: 2,
  onAlert(cellId, event) {
    console.log(cellId, event.query, event.price, event.occurrence);
  },
});

await grid.getTerminal('cell-2')!.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
grid.setSync({ viewport: true, crosshair: true, crosshairMatch: 'nearest' });
const saved = grid.getWorkspace();
await grid.setLayout(1);
// Hidden cell-2 retains its workspace and continues monitoring armed alerts.
await grid.restoreWorkspace(saved);
grid.destroy();
```

Four slots, `cell-1` through `cell-4`, persist for the grid's lifetime. Layout1,2 or4 displays that many slots from the start of the list. Each visible slot is a complete terminal with its own query, studies, drawings, settings and panes. A hidden slot has no chart or chart feed; its live alert store remains attached to the shared monitor. Reducing layout saves removed cells and preserves retained terminal identities. Expanding recreates only the newly visible cells. If the active cell becomes hidden, `cell-1` becomes active. Defaults are layout1, active cell-1 and synchronization off.

| Method | Behavior |
| --- | --- |
| `getState()` | Defensive grid/cell snapshots and aggregate alert-monitor state |
| `getTerminal(cellId)` | Current visible `TerminalApi`, or null when hidden/destroyed; invalid IDs reject |
| `setLayout(1\|2\|4)` | Promise for a validated composition change |
| `setActiveCell(cellId)` | Selects a visible cell without moving its viewport |
| `setSync(patch)` | Updates viewport/crosshair preferences and exact/nearest matching |
| `getWorkspace()` | Canonical four-slot document, including current alerts from hidden cells |
| `restoreWorkspace(value)` | Validates and prepares a complete replacement before adoption |
| `destroy()` | Idempotent cleanup; final state/workspace remain readable |

Reacquire terminal references after expansion or restore. Retired instances stay destroyed. A newer layout/restore or destruction may supersede an outstanding operation; handle its rejected Promise and read the current grid before updating host UI. After grid destruction, synchronous mutations throw and asynchronous mutations reject.

The grid toolbar exposes native layout, active-cell and synchronization controls. Pointer/focus selects a cell while preserving editor focus. At host widths of at least800 CSS pixels, layouts2/4 use two columns; narrower hosts stack cells. Each terminal reserves at least360 CSS pixels vertically and the grid scrolls internally as needed. Saved layout means visible cell count, independently of responsive CSS columns. Give the host a nonzero width and height.

### Temporal synchronization

Viewport and crosshair linking are independent opt-ins. A cell joins only when its current query has usable, nonempty chart data. Empty or loading replacement histories do not become authority; retained usable data may stay linked during reconnect. When membership or effective preferences change, the active ready cell initializes the group. If it is not ready, the first ready cell is provisional authority. Selection alone does not rebuild the group or jump ranges.

Linked navigation uses loaded timestamps rather than logical indices. Exact cursors hide where a target timestamp is missing; nearest cursors use a real target timestamp and that instrument's own values. A narrower target resolves available loaded boundaries, so numerical range equality is not guaranteed across sparse histories. Initial alignment is separate from later event propagation. Only interaction/API events propagate in a grid: history hydration, backfill and data-driven follow-latest movement remain local. This uses the optional analysis [cause filter](ANALYSIS.md), whose standalone omitted-option behavior remains unchanged.

### Grid persistence and ownership

The strict document envelope is `schema: 'filtix-terminal-grid'`, version1, providerId, layout, activeCellId, sync and exactly four cells. Each cell holds its canonical terminal workspace. Nested historical terminal/drawing documents migrate through their existing decoders. Unknown keys, missing or duplicate cells/scopes and incompatible catalogs reject before adoption. Pixel sizes, viewport/cursor state, editor drafts, bar histories and provider credentials are not saved.

Storage is explicit and host-owned. The React Grid view uses `filtix:terminal-grid:v1:<providerId>` separately from the single-terminal key. Save writes the current workspace once; streaming does not autosave. Invalid JSON or invalid documents show an error without replacing the mounted grid. Preparation/decode failure preserves old terminal identities and subscriptions. A later network failure belongs to the adopted configuration and does not revert valid saved preferences. A once alert triggered while hidden keeps its status and occurrence count through Save, restore and remount; saved occurrences are not replayed as new events.

The provider is always borrowed. By default the grid owns one monitor and four stores. Supply `alerts.monitor` to borrow a compatible monitor; supply `alerts.stores` as the exact complete four-cell record to borrow stores with distinct scopes. These ownership choices are independent. Grid leases retain all four stores, including parked cells; visible history feeds are separate from grouped latest alert feeds.

Whole-grid restore may replace supplied stores with new grid-owned stores. The original borrowed objects survive without being rewritten or destroyed, but references to them no longer edit the replaced slots. Reacquire `getAlerts()` from a current visible terminal. An external lease on an old same-scope store prevents replacement and causes rejection before adoption; the grid cannot release another owner's lease. Limits remain100 rules/store,400 distinct attached rules/monitor and32 armed exact queries, including externally attached stores. Destroy releases grid/terminal leases and synchronization, chart, control and observer resources, and destroys only owned stores/monitor. Borrowed resources remain usable.
