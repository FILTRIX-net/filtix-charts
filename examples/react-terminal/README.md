# FILTRIX Charts — independent React terminal consumer

This application sits outside the root workspace glob. The beta candidate installs all nine local 0.12.0-beta.1 archives with its own lockfile and resolves package exports from copied package files, with no source aliases. React mounts the framework-independent terminal in an effect and destroys it in cleanup. StrictMode exercises the initial mount, cleanup, and remount. See the [beta status](../../docs/OPEN-SOURCE-BETA.md) for licensing and publication prerequisites.

## Build and run

From the repository root, build and verify the Apache-2.0 beta cohort:

```sh
npm run build
npm run pack:local
npm run check:consumer
cd examples/react-terminal
npm run dev
```

Open http://127.0.0.1:5195. The default source is public Binance Spot. Use `/?source=fixture` for explicitly labelled synthetic data reconstructed from elapsed wall time. The consumer check installs the actual archives, verifies the exact beta archive inventory including READMEs and licenses, checks TypeScript without aliases, builds the application, and verifies SSR imports.

The archives are generated locally in `dist/packages`; this example makes no public-package publication claim. See the [terminal integration contract](../../docs/TERMINAL-CONTRACT.md) for ownership, styling, readiness, workspace validation, and data recovery.

## Studies and pane layout

The initial view uses EMA 20, SMA 200, Bollinger Bands 20×2, MACD 12/26/9, and RSI 14. Open Indicators to add, configure, hide, or remove instances. MACD exposes line, signal, and positive/negative histogram styles. Bollinger exposes middle, upper, lower, fill color, and fill opacity.

After mounting from the installed `@filtrix.net/terminal` archive, hosts use the public API to edit studies and canonical pane preferences:

```ts
const momentum = terminal.addStudy({
  kind: 'macd',
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
});
terminal.updateStudy(momentum, { signalPeriod: 7, lineWidth: 3 });
terminal.applyLayout({
  panes: [
    { id: 'price', weight: 1.1 },
    { id: 'terminal-volume-pane', weight: 0.16 },
  ],
});
const preferences = terminal.getLayout();
terminal.applyLayout({ maximizedPaneId: 'price' });
terminal.applyLayout({ maximizedPaneId: null });
terminal.resetLayout();
```

Returned study IDs are opaque identities local to the terminal instance. Pane IDs are semantic identities, including `price`, `terminal-volume-pane`, and `terminal-<study-id>-pane` for RSI/MACD. Stored preferences retain hidden volume and oscillator entries. The native Resize pane selector chooses Grow/Shrink/Maximize's target; the separate View selector commits the maximized view. The chart separators support pointer and keyboard resizing. The saved layout contains preferences, not viewport pixels, editor focus, or drag previews.

The simultaneous limits remain eight stored instances, three combined RSI/MACD oscillator panes, and twenty reserved study series. Hidden instances still reserve capacity. SMA, EMA, and RSI cost one series; MACD costs three; Bollinger costs four because its fill remains reserved even when `fillOpacity` is zero.

Give the host a responsive width and a real height. This example uses `width: auto`, `height: 570px`, and `min-height: 360px`, increasing the host height on narrow screens for editor capacity. The terminal's internal editor layout responds to its host rectangle. At an actual 320×360 CSS-pixel host, opening the editor keeps at least 96 CSS pixels of price plot visible unless the user explicitly maximizes another pane. Smaller hosts remain finite and recover when resized, but cannot guarantee that price-plot floor.

## Save, restore, and migration

Save and Restore are explicit host actions:

```ts
localStorage.setItem(storageKey, JSON.stringify(terminal.getWorkspace()));
await terminal.restoreWorkspace(JSON.parse(localStorage.getItem(storageKey)!));
```

Workspace writes produce strict v5 documents with complete canonical layout, provider identity, active query, global settings, ordered studies, per-market drawing documents v2 and the persisted all-market alerts document. Fibonacci, channels and notes are available in the toolbar; Objects can recover hidden/locked drawings, and Magnet is transient. See the [advanced drawing guide](../../docs/DRAWING-TOOLS.md). Restore accepts exact historical v1, scalar-kind v2, multi-output v3, both nested-v1 and nested-v2 v4 documents, and current v5 documents. V1–v3 migrate to default layout; v4/v5 restore saved pane preferences. V1–v4 migrate with an empty alert document using the current store scope. Existing `filtrix-charts:terminal:v1:<source>` storage keys stay unchanged so older saves remain discoverable. Bar history, provider configuration/URLs, credentials, viewport pixels and transient editor drafts are excluded; alert thresholds and last-trigger prices/timestamps are persisted. Source/provider namespaces remain separate, and the host catches storage or parse failures while ignoring asynchronous results from a replaced terminal instance.

From the repository root, the v0.11 installed grid workload is `npm run benchmark:grid -- --mode=all`, after the reviewed source commit, build, pack and consumer installation. It requires the clean nine-archive/42-member cohort and records four-terminal performance, a separate complete 256-row correctness pass and a separate 400-rule/32-query admission check under benchmark-results/v0.11. See the [performance methodology and acceptance status](../../docs/PERFORMANCE.md). Historical `benchmark:alerts` and `benchmark:drawing-tools` require their matching v0.10/0.10.0 and v0.9/0.9.0 checkouts and installed cohorts. These synthetic desktop checks do not establish physical-device, live-market or trading qualification.

Dense Canvas legends now wrap inside each pane and show an exact omitted-title count. Hosts can configure `terminal.chart.applyOptions({ legend: { visible: true, maxRows: 2 } })`; maxRows accepts1–4 and defaults2. The Indicators panel keeps the complete study list available.

The Alerts panel monitors saved markets independently of the displayed chart. Rules are included in workspace v5. The isolated ?test&alerts route is reserved for the installed-package workload; see [alert integration](../../docs/ALERTS.md). See the [performance methodology](../../docs/PERFORMANCE.md) for release acceptance status and evidence.
