# Changelog

## 0.12.0-beta.2 — in preparation

- Add optional `FILTRIX.NET` chart attribution, enabled by default and controlled by `ChartOptions.attribution`, with theme-aware placement and keyboard access.
- Add `exportImage({ watermark })` for per-image branding control. The default follows chart attribution; PNG dimensions and drawing primitives are preserved and the live canvas is unchanged.
- Use the SDK attribution in the Studio demo instead of separate page-only watermark markup.
- Correct source and issue links to the renamed `FILTRIX-net/filtrix-charts` repository. Previously published beta archives retain their original metadata and resolve through GitHub redirects.

## 0.12.0-beta.1 — 2026-09-30

- Correct the release identity to FILTRIX Charts by FILTRIX.NET and move all nine beta packages to `@filtrix.net/*`. Pre-beta local integrations must update dependencies and imports together. Add `FiltrixChart`/`FiltrixChartProps` while retaining deprecated React aliases and existing saved-data identifiers.
- License the source and all nine SDK packages under Apache-2.0, with exact internal prerelease peers, per-package READMEs and explicit archive inventories. The root workspace and example remain private.
- Add local packaging and publication checks for legal files, package metadata, archive contents and installed consumer identity; publication additionally requires the actual repository destination.
- Document standalone use, contribution and support expectations, release prerequisites and the proposed acquisition experiment.
- Add static campaign links from the demos to FILTRIX.NET and display the full beta version. No SDK analytics or main-product integration is added.

- Unify showcase and React-example headers, footer attribution, favicon and page metadata as FILTRIX Charts by FILTRIX.NET.
- Derive visible versions from application package metadata and preserve saved-data compatibility.

## 0.11.0 — 2026-09-28, private local release

- Add four persistent terminal slots with native 1/2/4 layouts, independent studies/drawings/panes, a shared alert monitor and explicit grid Save/Restore.
- Preserve parked alert state and validate complete workspace replacement before adoption, with separate borrowed and owned resource lifetimes.
- Add ready-member temporal synchronization and optional analysis event-cause filtering; chart history changes remain local to their cell.
- Add responsive grid controls and a saved React Grid view with StrictMode lifecycle coverage.
- Verify the private nine-package/45-member installation and fixed all-mode four-terminal workload on source `577d8d66`; the independent raw audit and ten final installed visual views pass. The [release report](docs/releases/v0.11.md) records observed cadence, resource and headless-browser limits, plus earlier failed attempts. Annotated local `v0.11.0` targets the source-qualified evidence commit `1e8418c`; the [four-stage audit](SOURCE-DISTRIBUTION.md#omitted-development-materials) records all tag targets.

## 0.10.0 — 2026-09-23

- Add persistent all-market crossing alerts through the headless store/monitor and native terminal editor, including once/repeat, pause/rearm and focused draft preservation.
- Share bounded latest-price feeds across exact queries with prospective 100/400/32 capacity checks and independent borrowed/owned resource cleanup.
- Save alerts in terminal workspace v5 and migrate exact v1–v4 saves without replaying historical crossings.
- Avoid redundant transport notifications and editor refreshes during steady streaming while preserving error/reconnect and crossing events.
- Verify nine private archives/42 members, 465 units, 36 focused three-engine alert browser cases, installed StrictMode, twelve visual frames and the unchanged 400-rule workload. Processing p95/p99 is 2.8/3.2 ms on the identified source; [release evidence and limits](docs/releases/v0.10.md) qualify cadence, resources and the earlier failed attempt.

## 0.9.0 — 2026-09-23

- Add Fibonacci retracements with per-level styling, three-anchor parallel channels and multiline text notes through the drawing API and native terminal toolbar.
- Add geometry locking, visibility, recoverable object selection and stable native settings with one validated Apply commit. Focused drafts survive streaming updates.
- Add transient OHLC Magnet for new anchors and handle edits, backed by indexed single-bar feed lookup.
- Write canonical drawing documents v2 and migrate exact historical v1 documents through a shared decoder. Terminal workspace remains v4; historical nested-v1 and current nested-v2 TypeScript shapes remain distinct.
- Reduce repeated timeline rebuilds, core range-tree work and temporary allocations during history ingestion. Keep atomic validation and tail replacement; avoid unused candle columns and intermediate indicator rollback snapshots.
- The clean installed 100k-row/200-drawing workload passes on measured source `cd17ca3`, including resource and stale-callback checks. All 813 browser cases pass; independent raw audit and installed visual review are accepted. See the [private release report](docs/releases/v0.9.md) for measured source identity and limitations.

## 0.8.1 — 2026-09-23

- Bound series titles to each pane's Canvas plot area, wrap or shorten complete titles, and show an exact `+N` omitted-title count when space is limited. Dense 320/390 px terminal views keep titles out of the price axis.
- Add optional `ChartOptions.legend` with `visible` (default `true`) and `maxRows` (default `2`, integer `1`–`4`). Partial `applyOptions` patches merge and copy values; invalid nested options reject atomically. Existing callers keep their behavior.
- Add the versioned quality runner with an explicit 12-full-checkpoint gate, actual three-engine sampled point payloads and separate target/observed cadence summaries. Keep historical runners and raw evidence intact.
- Align all eight private packages and the independent React consumer at 0.8.1. Installed eight-archive/32-member checks, clean source workload and actual visual inspection pass. The [release report](docs/releases/v0.8.1.md) records qualifications and approved independent reviews.

## 0.8.0 — 2026-09-13

- Preserve terminal price/volume/oscillator order when re-enabling volume or restoring a workspace, and handle synchronous study removal during pane reconstruction.

- Add atomic chart pane layout, committed synchronous notifications, shared measured geometry and adjacent resizing with cancelable pointer previews and keyboard alternatives.
- Add explicit terminal maximize, restore and reset controls with separate resize-target and saved-view selectors.
- Preserve native pane choices and focus during streaming; reuse unchanged option nodes and release removed entries.
- Add a host-sized responsive study editor with a wide rail, bounded narrow/short modes, keyed native fields and visible temporary price focus that stays out of saved state.
- Add workspace v4 with canonical semantic pane preferences, including hidden oscillators and disabled volume. Exact v1/v2/v3 migration preserves existing host storage keys.
- Preserve geometry-only resource ownership and strengthen nested mutation/presentation fencing. Functional checks (267 unit tests and 720 browser cases), the installed 100k/22-series layout workload, 291,492 ms mixed session and separate engine smoke pass; see the independently audited [release report](docs/releases/v0.8.md).

## 0.7.0 — 2026-09-12

- Add standalone batch and streaming MACD and Bollinger Bands with named outputs, exact warmup/gap behavior, defensive copies and atomic tail replacement.
- Add native fill-only band series with both boundaries in autoscale and crosshair snapshots, clipped dense rendering and no extra canvas.
- Add grouped MACD/Bollinger terminal studies and native calculation/style controls. Reserve at most eight stored studies, three combined RSI/MACD panes and twenty derived study series, including hidden instances.
- Add strict workspace v3 and migration of v1 and the exact historical v2 schema while preserving existing host storage keys.
- Update public package/declaration smoke and support the keyed workspace pack JSON emitted by npm 12. The installed 100k/22-series workload and 217,276 ms mixed session pass; see the [release report](docs/releases/v0.7.md).

## 0.6.0 — 2026-09-12

- Add configurable SMA, EMA and Wilder RSI instances to the optional terminal, with stable identities, per-instance styles and separate RSI panes. Support up to eight studies including three RSI; hidden instances retain settings and release chart resources.
- Add the keyboard-accessible Indicators editor and a four-study demonstration in the showcase and independent React application.
- Add workspace v2 with explicit v1 migration and compatible legacy EMA settings. Existing host storage keys continue to find older saved workspaces.
- Add a reproducible installed-package maximum-study workload and sustained consumer checks with independent numerical oracles and exact source/archive/build identity verification. The final100k/eight-study workload and227,817 ms consumer session pass. See the [release report](docs/releases/v0.6.md) for exact metrics and the explicitly scoped structural-DOM gate.
- Reuse a validated unchanged shared timeline during history replacement, preserving viewport and stream behavior. Maximum-scene synchronous rebuild p95 is487.4 ms on the measured desktop configuration.

## 0.5.0 — 2026-09-09

- Optional @filtix/terminal composes live feeds, candlesticks, volume, EMA and editable per-market drawings with explicit versioned workspace snapshots.
- Independent React consumer installs all eight private archives, supports StrictMode teardown and explicit Save/Restore, and separates public Binance from synthetic fixture mode.
- Generated drawing identities now use bounded bookkeeping across repeated add/remove cycles. Canonical supplied/restored numeric IDs advance the generator; the finite namespace reports DRAWING_ID_EXHAUSTED.
- Current-workspace readiness, persistent ingestion errors, reentrant callbacks, exact market identity and drawing-tool reset have regression coverage.
- Accepted a real 60-minute desktop session with native background recovery, full candle/volume/EMA checks, bounded resource observations and verified teardown. See the [v0.5 release report](docs/releases/v0.5.md) for exact evidence and limitations.

Earlier accepted releases: [0.4.0](docs/releases/v0.4.md), [0.3.0](docs/releases/v0.3.md), [0.2.0](docs/releases/v0.2.md), [0.1.0](docs/RELEASE.md).
