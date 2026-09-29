# Performance methodology

No number in the approved design is an achieved result by itself. Generated files in `benchmark-results/` label full qualifying reference measurements, shortened smoke measurements and nonqualifying full runs separately. Failed targets and raw observations remain in the artifact.

The first qualifying local result is [reference.json](../SOURCE-DISTRIBUTION.md#omitted-development-materials), completed on 2026-09-08 UTC. All approved timing/correctness gates passed. [RELEASE.md](RELEASE.md) reports the actual figures, independent-run variation, bundle limits and measurement boundaries.

## Reproduce

```powershell
npm run build
npm run build:demo
npm run benchmark
```

The default launches an installed, visible Google Chrome window with a 1440 x 900 CSS viewport and DPR 1. Keep that window in the foreground and avoid other CPU- or GPU-heavy jobs. A complete reference candidate includes ten 30-second navigation runs and ten 60-second 10 Hz streams, so allow roughly 15 minutes plus setup and the other scenarios.

Use `npm run benchmark -- --quick --headless` for a short, two-run smoke check. Headless and quick results are always labeled `smoke` and never qualify as the reference profile.

The runner first refuses to continue if its strict local preview port already responds. It then starts and readiness-checks its own Vite preview server, launches Chrome, and closes both on exit. An existing service cannot be mistaken for the built assets being measured.

## Host profile and qualification

Before any timing, the runner records CPU, logical CPU count, memory, GPU, Windows and Chrome builds, user agent, viewport, DPR, document visibility/focus, Node version, and the explicit chart font. The benchmark uses a locally resolved `Consolas` face at 11 px through `FontFace` and waits for `document.fonts.load()` and `document.fonts.ready`; no network font is used.

On Windows, `powercfg /getactivescheme` records the actual active power scheme before timing and again afterward. This is read-only; the runner never changes a system power setting. Windows does not expose the effective power-mode overlay through a documented read-only `powercfg` command, so the overlay is recorded as unavailable rather than guessed.

The first visible reference candidate whose required metadata is available creates `benchmark-results/reference-profile.json` before timing. Later runs compare CPU, GPU, OS, browser, viewport, DPR, font and power identity with that frozen profile. A mismatch preserves the original profile and labels the new run `nonqualifying`. Unknown required metadata, a power-profile change, a hidden or unfocused measurement, the wrong viewport/DPR, or an unavailable local font has the same result. Visibility and focus are sampled at every scenario boundary and throughout scheduled navigation, streaming and lifecycle work.

The no-concurrent-heavy-work requirement is an operator condition and is recorded as such because the runner cannot reliably prove it by inspecting processes.

## Fixtures and timing

All fixture data is generated before the timed `setData` section. The ordinary OHLCV series uses a fixed seed and configuration at 1k, 10k and 100k rows. SHA-256 fixture, generator and built-package hashes are saved in each result.

Every measured timing scenario has one separate fresh-page warm-up followed by ten independent fresh-page runs (two in quick smoke mode):

- Ordinary 1k, 10k and 100k candlestick loads with approximately 1,000 visible bars.
- A separate dense 100k full-history candlestick view.
- Deterministic flat-price, negative-price and timestamp-gap fixtures. These are correctness-matrix timings and have no release budget.
- Thirty seconds of public-API viewport navigation per measured run.
- Sixty seconds per measured run at 10 updates per second, mixing final-bar replacements and appends.
- A burst of 100 ordered appends dispatched in one task.
- A practical 100k scene with candles, volume and EMA(20) across two panes. Its timings are diagnostic and are not compared with the single-candlestick gates.

The lifecycle check remains a separate fresh-page correctness scenario: thirty create/load/destroy cycles followed by an owned-canvas count. Unsupported browser memory APIs are reported as unavailable, never as zero.

A live stream and burst explicitly enable `followLatest` and pin the viewport before timing. Every accepted streamed tail is checked after submission with both the newest logical index and `timeToCoordinate`. Each run retains its visibility samples, any visibility failures, accepted/final counts and canonical final-bar comparison. The single full-history correctness snapshot is taken only after the timed submission endpoint. Bursts additionally require no lost updates, a matching final bar, a visible final tail and at most one scene draw for the dispatched task.

## Results and recovery

Nearest-rank summaries report sample count, median, p95, p99 and maximum. Load, dense, matrix, burst and practical output retain every independent run. Navigation and streaming retain raw event arrays, per-run summaries and separate pooled raw arrays/summaries.

The runner writes `reference.partial.json` or `smoke.partial.json` before timings and refreshes it after each warm-up and measured run. If a long run fails, the partial artifact retains completed raw work and the error. A successful qualifying full run writes `reference.json`; a full profile or foreground mismatch writes a timestamped `nonqualifying-*.json`; a quick or headless run writes `smoke.json`.

Synchronous ingest measures `setData` entry to return. Settled load/update measures through completed drawing submission. `lastRenderMs` covers library-owned work. These timers do not measure physical monitor presentation and do not establish a universal frame rate.

## Reference targets

| Metric                                     | Target       |
| ------------------------------------------ | ------------ |
| 10k / 100k synchronous ingest p95          | 25 / 150 ms  |
| 10k / 100k ingest to render submission p95 | 75 / 250 ms  |
| Navigation library work p95 / p99          | 8 / 16 ms    |
| Stream update to submission p95 / p99      | 32 / 50 ms   |
| Burst to settled submission p95            | 50 ms        |
| Core + charts raw / gzip                   | 180 / 50 KiB |

The JSON budget booleans compare observations with these approved targets. A missed target remains visible with its raw data and must be profiled and resolved or documented in release notes; the runner does not relax the threshold.

Compression uses Node zlib gzip level 9 and reports exact bytes. Demo, indicators, React and source maps are excluded from the core chart bundle budget.

All timing gates apply to the single-candlestick scene. The practical multi-pane scene is not an equivalent competitor workload. Histogram work scans visible source rows, and line-series history replacement rebuilds runs, so single-candle results do not support broad claims about every series combination. No competitor comparison has been run.

## v0.4 synchronized analysis smoke

Build packages and the showcase, then run `npm run benchmark:analysis`. The separate runner owns port 5191 and writes `benchmark-results/v0.4/analysis-smoke.json`; earlier outputs are copied to timestamped files before replacement. This is an explicitly headless smoke workload, not the v0.1 qualified reference.

One fresh-page warm-up precedes ten independent 3-second navigation runs in installed Chrome, at 1440 × 900, DPR 1. Three charts render five series: 100,000 master candles with EMA20, an independent sparse candle history, and two normalized comparison lines. Navigation changes the source's semantic range every iteration and independently checks exact loaded endpoints on all three charts, one effective mutation and one scene draw per chart, and no subsequent bounce.

Combined navigation work is the source semantic setter plus instrumented synchronization callbacks plus one newly measured render per chart. Target setters run inside those callbacks and are counted once. The budget is p95 ≤16ms and p99 ≤24ms, both pooled and per run. Raw asynchronous latency is reported separately; it includes waits for scheduled frames. Correctness snapshots and settling oracles do not enter the library-work timer.

Each page then constructs a real 100k-bar replay controller, clears all five series, executes 1,000 one-bar steps with actual candle, EMA and indexed updates, seeks backward, proves paced playback advances, pauses and destroys it. Append submission measures controller and application callback work; it excludes subsequent coalesced drawing. Construction and reset timings are separate. Outside timed loops, independent numeric oracles validate all five revealed histories, including OHLCV fields, sparse timestamps, SMA-seeded EMA values, normalized values and the absence of future bars.

Raw samples, per-run and pooled nearest-rank summaries, browser errors, disposal, actual browser/host metadata and hashes of built packages plus every executed production script accompany the gates. A successful result requires browser closure and owned-preview termination. Nothing in this scene establishes physical display latency or a comparison with another library.

## v0.5 installed terminal sustained smoke

Build the packages, run npm run pack:local and npm run check:consumer, then run npm run test:soak. The default scenario requires at least 60 minutes of actual session time. npm run test:soak -- --minutes=2 runs a short preflight only. The native visibility harness targets installed Windows Chrome (FILTIX_CHROME_PATH can override the executable) and owns its preview on port 5195 and isolated browser profile.

The independent React application resolves copied archives from its own node_modules. Every attempt records all eight archive hashes, the eight installed package runtimes, every built application asset, the runner, consumer lockfile and exact installation record. All identities are checked again before success. Builds, reinstalls and changes to these files invalidate the candidate and require a new attempt. Timestamped artifacts preserve each attempt separately.

The clearly labelled synthetic provider reconstructs authoritative one-minute OHLCV data from elapsed wall time. Delivery runs every 250 ms while active; background history does not depend on delivery timers. The scenario starts with 500 candles, loads older history, changes settings, delivers a historical correction, disconnects for three minutes in an actually hidden tab, recovers without losing the loaded prefix, switches markets rapidly and injects deliberately obsolete history and stream callbacks. The stale-callback assertions run before restoration can repair a damaged state. A second native hidden disconnect lasts five and a half minutes after the session midpoint.

Each checkpoint compares every loaded OHLCV record with the authoritative source under a brief delivery gate. Full checkpoints also inspect the rendered candle, volume and EMA value at every loaded timestamp; ordinary sustained checkpoints inspect four rendered points while still comparing the entire source history. The EMA oracle uses its own SMA-seeded recurrence outside the library. Visible range and follow behavior are restored after inspection. The session continues with checkpoints roughly every 45 seconds and finishes with a full oracle after the elapsed-hour requirement is met. Hidden/visible events and wall-clock timestamps are retained.

Resource observations include DOM nodes/listeners, garbage-collected JavaScript heap, three owned chart canvases and provider request/subscription counters. Settled samples require one subscription and no more than one active request. Rapid cancellation may briefly leave several underlying ignored-abort promises unsettled; this is recorded rather than described as a one-request peak. First-to-final sampled growth budgets are 200 nodes, 20 listeners and 12 MiB retained heap. These workload bounds supplement constructor caps; they are not proof of zero allocation or unlimited-history retention.

After the hour, 24 Playwright-dispatched wheel inputs must change the visible range and settle. Their p95 automation-inclusive latency must stay below 150 ms. The runner separately retains 120 foreground requestAnimationFrame gaps. Neither metric is physical display latency. A 390 px viewport checks layout, theme/volume/EMA controls, drawing placement, keyboard navigation and Save/Restore. Six remounts exercise cleanup; final destruction requires zero canvases, zero active provider requests/subscriptions and verified termination of the owned browser and preview processes. PASS is written only after cleanup succeeds.

The [v0.5 release report](releases/v0.5.md) links exact attempts and independent audits. Public Binance connectivity is checked separately from the deterministic scenario. This workload qualifies only the recorded desktop sustained smoke; it does not establish physical phone/laptop performance, a universal frame rate or superiority to another library.

## v0.6 configurable study workload

This stage adds a separate maximum-study workload; v0.5 hour and single-candlestick timing claims do not qualify it. The binding scenario and budgets are in the [v0.6 specification](../SOURCE-DISTRIBUTION.md#omitted-development-materials). Implementation and measurements are complete. This section defines the acceptance methodology; the [v0.6 release report](releases/v0.6.md) records the accepted measurements and their scope.

From the repository root, run:

```sh
npm run build
npm run pack:local
npm run check:consumer
npm run benchmark:studies
```

The measurement requires committed candidate source and an installation record for that exact commit. If the first consumer installation changes its lockfile, commit the candidate and lockfile, then rerun check:consumer before measuring. Keep source files, archives and built assets fixed during the run.

Use the actual installed private terminal package with 100,000 retained candles, volume and 8 visible studies including 3 RSI. The resulting scene has 10 series and 5 panes with about 1,000 bars visible. Generate deterministic source data before timing. One warmup precedes 3 measured canonical rebuilds, including an older correction; nearest-rank p95 limits are 1,500 ms synchronous composition and 2,000 ms from composition start to settled rendering. Preserve each timing, configuration and actual rendered oracle.

Separately pace 100 same-tail replacements against100k rows and 100 appends starting at 99,900 rows interleaved with 100 replacements at 10 Hz. The workload does not cross the existing100k cap. Synchronous library work gates are p95<=16ms and p99<=32ms; update-to-settlement gates are p95<=50ms and p99<=100ms. Oracle extraction and fixture generation run outside these timing windows. At least 24 Playwright-dispatched wheel inputs must change the visible range with automation-inclusive p95<150ms. Record 120 foreground frame gaps as observations, without calling them physical display latency.

The installed React consumer also runs a real elapsed session>=120,000 ms at 8 studies / 3 RSI, with>=12 coherent checkpoints,>=300 actual tail deliveries, backfill, repeated-tail and older corrections, recovery, rapid market changes, save/restore, study visibility/parameter/style edits,25 add/remove cycles and6 remounts. Full checkpoints compare all retained OHLCV and every visible rendered study point against independent SMA/EMA/Wilder-RSI mathematics, including warmup whitespace. Full numerical checkpoints follow initial hydration, backfill, older correction, recovery, actual v1 migration, successful v2 restore, UI Save/Restore and the final state. Recovery gates ordinary delivery before disconnect and checks recovered data before any flush can repair it; only the current partial candle is aligned to its recorded source revision. Invalid v2 restore must leave workspace, data, drawings history and transport counters unchanged. Ordinary checkpoints sample rendered values and still compare the complete authoritative source. Inspect obsolete history and stream callbacks separately before a later reset can repair an incorrect state.

At settled checkpoints require one active subscription and at most one request. Before each resource observation, enumerate all authored element attributes, retaining only primitive counts, then collect garbage. Playwright action previews otherwise lazily materialize Blink Attr nodes only for interacted controls, making equivalent scenes incomparable. This preparation does not change or remount UI state. Screenshots use caret: initial so Playwright does not inject and leave empty inline-style attributes on inputs. A weak audit registry installed before mounting observes the React consumer and all terminal generations, including removed subtrees. The authoritative weak-retention gate covers authored structural light-DOM nodes reachable through ordinary childNodes, including Element, Text, Comment and other ordinary child nodes. Standalone Attr wrappers and all shadow-tree nodes are excluded from authoritative retention. Connected attribute counts and raw Blink DOM counts remain diagnostics. Discovery precedes a fixed sequence of three primitive-only renderer turns, each followed by GC, before the first weak-reference inspection. No ownership sample runs between those collections, and there is no retry-until-pass loop. Briefly gate fixture delivery and settle two frames before discovery; restore its prior gate afterward. Compare the same hydrated visible study configuration and viewport with the Indicators editor closed at first/final observations: no upward retained authored structural consumer/terminal node growth, no retained detached/outside-owned nodes, raw listener growth<=0 and retained heap delta<=12 MiB. Each destroyed terminal generation must retain zero tracked structural nodes after the fault fixture releases its deliberately held obsolete callback. Teardown records ownership before calling fixture.deliverLate(). That call consumes the deliberately held host slot and invokes its obsolete callbacks. The harness proves unchanged host DOM and transport counters immediately and after the 800 ms retry window, then requires a second delivery to return null. Only after that proof does it run the fixed collection protocol and assert zero retained structural nodes for the destroyed terminal generation. Deliberately retained removed Text/Element controls must fail and pass after release. Total Blink DOM counters remain diagnostic: native number-input editing followed by programmatic updates retains browser Editor undo Text nodes even on a plain HTML page, so those global counts do not identify library ownership. This explicitly replaces the original global-node gate; earlier failures remain failed. No post-edit phase rebase or native undo clearing is permitted. Final teardown requires zero owned canvases, requests and subscriptions, plus verified browser/preview closure. The heap limit is a growth gate for the bounded session, not an absolute 100k-memory limit. Headless desktop/viewport measurements do not qualify physical phones or native background recovery.

Timestamped raw attempts must preserve exact source, archive, installed runtime, built consumer and runner identities; check identities again at completion. Every failed correctness, timing or cleanup gate exits nonzero and remains failed in its artifact. Freeze candidate builds while measuring, serialize performance runs, and never substitute an older release result or silently relax a threshold.

The authoritative weak-retention gate covers authored structural light-DOM nodes reachable through ordinary childNodes, including Element, Text, Comment and other ordinary child nodes. Standalone Attr wrappers and all shadow-tree nodes are excluded from authoritative retention. Connected attribute counts and raw Blink DOM counts remain diagnostics. Standalone Attr wrappers are excluded: an Attr created and removed within the same synchronous task cannot be recovered from MutationObserver records. Connected attributes and total Blink counts remain diagnostic. Broad heap/listener checks supplement this documented limitation; no native DOM prototypes are intercepted.

## v0.7 multi-output study workload

The [v0.7 specification](../SOURCE-DISTRIBUTION.md#omitted-development-materials) defines a maximum composition with MACD and Bollinger. This section specifies its acceptance method. The [v0.7 release report](releases/v0.7.md) records the passing measured values and their exact candidate identity. Prior workload commands and evidence belong to their recorded source commits and package cohorts.

```sh
npm run build
npm run pack:local
npm run check:consumer
npm run benchmark:multi-output
node scripts/benchmark.mjs --quick --headless --output-dir=benchmark-results/v0.7
```

The new runner and oracle write timestamped attempts to benchmark-results/v0.7 and use eight actual private 0.7.0 archives installed into the independent React consumer. The clean committed source installation must match at both endpoints, including all 32 archive members, built assets and the runner. If installation changes the lockfile, commit it and repeat check:consumer before measurement. Preserve the old studies-benchmark, studies-oracle and studies-resources implementations and earlier raw evidence. The shared identity verifier checks stage/cohort agreement while retaining every source, archive, member and asset gate.

### Maximum scene and timing

Use 100,000 retained candles, volume, three MACDs (12/26/9, 5/35/5, 20/50/10), two Bollinger instances (periods 20 and 500), and EMA20/SMA200/EMA50. These eight studies reserve 20 output series; with price and volume, the scene has 22 series and five panes. Keep about 1,000 bars visible. One warmup precedes three measured older-correction rebuilds. Generate fixtures and extract correctness snapshots outside timing windows.

| Observation                                    | Acceptance limit     |
| ---------------------------------------------- | -------------------- |
| Synchronous canonical rebuild p95              | <= 1,500 ms          |
| Rebuild start to settled render p95            | <= 2,000 ms          |
| Synchronous tail p95 / p99                     | <= 16 ms / <= 32 ms  |
| Tail start to settled render p95 / p99         | <= 50 ms / <= 100 ms |
| 24 real wheel inputs, automation-inclusive p95 | < 150 ms             |

Tail work consists of 100 same-tail replacements at 100,000 rows, followed by 100 appends starting at 99,900 rows interleaved with 100 replacements at 10 Hz. Never exceed the 100,000-row cap. Keep each raw duration and use nearest-rank quantiles. Preserve 120 foreground frame-gap observations and available long-task observations; these do not measure physical display latency. Instrumented runtime regressions separately prove ordinary tails avoid feed/calculator full-history access, series setData and output recreation. A short duration alone does not prove this property.

At the 100,000-row checkpoints, compare the complete retained OHLCV history and hash with the independent authoritative source. Inspect at least 16 selected actual rendered timestamps across warmup boundaries, interior points and the tail. This is selected rendered-output sampling, not inspection of every crosshair point. The independent oracle separately seeds MACD price/signal EMAs and uses direct centered-window population deviation for Bollinger, checking every named line/histogram and both fill bounds. Production calculators cannot supply expected values. A deliberate incorrect-value probe must fail.

### Mixed session, editor and recovery

A separate installed-consumer session replaces one MACD with RSI14: two MACDs, one RSI, two Bollinger instances and three single-output studies. This gives 18 study series, 20 total series and five panes. Require at least 120,000 ms of real elapsed time, 12 coherent checkpoints, 300 actual tail deliveries, 25 add/remove/hide/show cycles and six complete terminal remounts. Compare every rendered output across the smaller 500–750-row fixture after initial hydration, backfill, older correction, recovery, strict v1/v2 migration, v3 restore, UI Save/Restore and final state. Inspect invalid restores and obsolete history/stream responses before a later repair. Preserve the loaded prefix through disconnect/catchup, and gate deliveries while taking coherent snapshots.

Native editor checks cover MACD calculation and sign-color fields, Bollinger multiplier/boundary/fill styles, opacity zero, focus during streaming, authoritative programmatic changes, and reachable controls at a 390 px viewport without page horizontal overflow. Hide/show/remove operations verify derived output/pane identity and ownership. A band fill uses the existing chart scene and adds no canvas. The terminal retains its separate drawing layer.

### Resource retention and cleanup

Reuse the exact [v0.6 structural resource protocol](#v06-configurable-study-workload): authored ordinary light-DOM childNodes only; standalone Attr wrappers and all shadow trees excluded; raw Blink and attribute counts diagnostic. Use the fixed three primitive-turn/GC sequence with no intermediate inspection, retry-until-pass or post-edit baseline rebase.

Compare equivalent initial/final composition and viewport with the editor closed. Require consumer/terminal structural growth <= 0, every settled outside/detached count zero, each disposed generation zero, listener growth <= 0 and retained heap delta <= 12 MiB. The heap limit measures session growth, not absolute memory at 100,000 rows.

Teardown records the held stale callback before delivery, consumes and invokes it once, and checks unchanged DOM/counters immediately and after 800 ms. The second delivery must return null. Then run the fixed GC protocol. All owned canvases, requests and subscriptions must reach zero, and browser/server closure must be verified before PASS. The previously stopped persistent demos stay stopped.

Keep every failed raw attempt, including partial identity, correctness, timing or cleanup failures, and exit nonzero. Serialize browser/performance work and freeze builds during measurement. The separate quick/headless engine smoke qualifies only its recorded single-candlestick workload. Neither workload establishes physical-device performance, another native one-hour recovery qualification, or superiority over a competitor.

## v0.8 terminal layout workload

The [v0.8 specification](../SOURCE-DISTRIBUTION.md#omitted-development-materials) retains the v0.7 maximum and mixed scenes and adds geometry work. This section defines acceptance; the measured v0.8 results and qualification limits are recorded in the [release report](releases/v0.8.md#installed-workload). The separate versioned runner is `npm run benchmark:layout`, with owned temporary port 5198 and timestamped outputs in benchmark-results/v0.8. Build, pack and run check:consumer first; the installed eight 0.8.0 archives, all 32 members, clean source, built assets and runners must match at both endpoints. Prior runners and raw artifacts remain unchanged.

At 100,000 rows with about 1,000 visible, retain the 22-series, five-pane maximum composition and its exact rebuild, tail and wheel gates above. Check complete source OHLCV/hash and at least 21 actual rendered timestamps with the independent multi-output oracle. Add 60 effective adjacent pair changes (price 1.1/0.9 and volume 0.16/0.36 alternating, pair total 1.26), 20 maximize/restore pairs covering price/volume/MACD, and 10 effective resets, each preceded by an untimed nondefault setup. Keep every synchronous and settled API duration; layout p95/p99 gates are 16/32 ms synchronous and 50/100 ms settled. No-ops, cancelled previews, fixture generation and oracle extraction are outside effective timing arrays. Compare saved preferences, resource identities, provider history counts, ranges and rendered output after the phases. Instrumented browser regressions separately prove no calculator/history rebuild or series/pane recreation.

The mixed 20-series, five-pane installed session retains at least 120,000 actual ms, 12 coherent checkpoints, 300 actual tail deliveries, 25 composition cycles and six remounts. Full 500–750-row output oracles follow history/backfill/correction/recovery, each explicit v1/v2/v3 migration, v4 restore, UI SaveRestore and final state. Constructed old documents omit layout; invalid v4 and obsolete callback assertions run before any repair. Add API/native keyboard/mouse/touch-emulated resizing, cancellation, external restore during preview, hidden/recreated pane preferences, maximize/reset and editor focus. Actual bounding boxes verify the 320 × 360 supported 96 px unobscured price floor and both-theme wide/narrow/short containment. Emulation is not physical-device qualification.

Use the unchanged authored-structural-weakref-v1 resource protocol described above: equivalent canonical composition/layout and closed editor, fixed three primitive-turn/GC sequence, no intermediate inspection or retry/rebase, structural node growth <= 0, listener growth <= 0, heap growth <= 12 MiB, outside/detached/disposed counts 0. Prove deliberately held obsolete callback ownership, consume/invoke once, unchanged immediately and after 800 ms, second delivery null, then fixed GC zero. Final canvases/requests/subscriptions 0 and verified browser/server closure are required before PASS. Ordinary streaming gates restore their prior value in finally. Preserve every failed/partial attempt. Keep prior persistent demos stopped and serialize build/browser/performance work.

Run the separate engine smoke as `node scripts/benchmark.mjs --quick --headless --output-dir=benchmark-results/v0.8`; it qualifies only its recorded single-candlestick headless scene and is not a replacement for the installed layout workload.

The v0.8 compact hidden-study check distinguishes retained pane membership from primitive visibility under temporary price focus. Before its full all-pane output oracle, the runner temporarily supplies a 960 px-high mobile host, requires effective focus to clear and verifies the actual five-pane projection. It runs the unchanged complete output/resource sample there, then restores the captured mobile inline style in finally and checks the returned state. The earlier 320 × 360 and 320 × 240 checks retain their actual compact geometry; no full five-pane rendering claim is made while the price-only view is effective.

The accepted clean 6925b5f all-mode run records layout synchronous p95/p99 0.8/0.9 ms and settled 26.7/28.1 ms across 110 effective changes. Its maximum-tail synchronous p95/p99 is 2.0/2.4 ms; the mixed session spans 291,492 ms with 315 deliveries, 29 checkpoints (17 full), six remounts, zero authored structural/listener growth and 1,029,976 bytes retained heap growth. These are the recorded headless desktop workload results, not a physical-device or native one-hour qualification. Maximum-tail cadence targets 10 Hz but actual dispatch gaps are 103–111 ms (about 9.2 Hz). The runner self-check currently accepts at least ten full checkpoints; the binding v0.8 requirement of at least twelve full checkpoints is independently enforced for this release against the seventeen actual full checkpoints.

## v0.8.1 quality workload

The preserved `npm run benchmark:quality` uses the actual eight-package 0.8.1 archive cohort, port 5201 and unique `layout-quality-*` files under `benchmark-results/v0.8.1`. It preserves all v0.8 maximum-scene, layout, stream, mixed-session, fixed-GC, stale-callback and cleanup gates above. Its mixed-session gate explicitly requires at least 12 full checkpoints. Three-engine coverage retains the actual eight sampled timestamp indices and complete source/study/point payloads for each engine, so an independent audit can recompute all 24 samples. Target cadence and actual dispatch gaps/rates are separate observations. Teardown records retain compared DOM/transport values as well as digests. Historical runners and evidence stay byte-identical.

The [official all-mode result](../SOURCE-DISTRIBUTION.md#omitted-development-materials) passes on clean measured source `d31e23965dd324e4192f1fb56a6d24248ed66a2f`. The headless synthetic maximum uses 100,000 rows, 22 series and five panes. It records 300 tail dispatches, 110 effective layout operations, and a 273,112 ms mixed session with 319 deliveries, 29 checkpoints (17 full), six remounts, zero authored DOM/listener growth and 1,024,540 bytes retained heap growth. Maximum tail dispatch targeted 10 Hz and observed about 9.36 Hz within each phase. The mixed session targeted 4 Hz delivery while active; its 1.168 Hz wall-session observation includes gated oracles and layout exercises. Those rates describe this run, not universal rendering rates.

The 100,000-row scene uses sampled rendered checks plus complete source OHLCV comparison; full 500–750-row mixed checkpoints are separately exhaustive over their loaded output. The [independent raw audit](../SOURCE-DISTRIBUTION.md#omitted-development-materials) approves all ten sections, including recalculation of the 24 actual three-engine samples, 11,084 rendered rows and 259,753 numerical comparisons. The separate [quick headless single-chart smoke](../SOURCE-DISTRIBUTION.md#omitted-development-materials) passes 12/12 budget checks and is nonreference. See the [v0.8.1 report](releases/v0.8.1.md) for source identity, visual evidence, failures and qualification limits. Neither run measures physical display presentation or a live market.

## v0.9 advanced drawing workload

The separate npm run benchmark:drawing-tools command targets the actual eight-package 0.9.0 archive cohort on port 5202. Build and pack the packages, install the independent React consumer, and commit the measured source before running it. The identity check requires the exact clean source, eight archives, all 35 copied members and the built consumer assets. Raw attempts and retained PNGs use unique paths under benchmark-results/v0.9. Only --mode=all is eligible for complete performance-workload acceptance; max and soak remain partial workloads. Committed source `cd17ca32c86621923f199a0168aabe92d6cd4314` passed the unchanged [official all-mode run](../SOURCE-DISTRIBUTION.md#omitted-development-materials). The separate full browser matrix passed 813/813, and the [independent final audit](../SOURCE-DISTRIBUTION.md#omitted-development-materials) approved the source and supplied installed evidence. The private local release tag records the later documentation/evidence closeout, without changing the measured product source; see the [release review](../SOURCE-DISTRIBUTION.md#omitted-development-materials).

The reference scene contains 100,000 OHLCV rows and approximately 1,000 visible bars, with price, volume, EMA20, SMA200, Bollinger20×2, MACD12/26/9 and RSI14: 12 series in four panes. Its 200 visible price-pane drawings comprise 30 each of trend, horizontal, rectangle, measure and Fibonacci, plus 25 channels and 25 notes. Fibonacci uses seven default levels and notes at most three lines; 32 levels and 20 lines are separate correctness cases.

After warmup, the workload measures three full scene and workspace restore samples, 100 effective drawing updates, 100 tail replacements, 100 appends from 99,900 to 100,000 rows interleaved with another 100 replacements, 240 semantic navigation samples and 24 real wheel inputs. Deterministic input preparation and oracle extraction stay outside timing. Mutation/navigation library work includes synchronous API work and newly submitted frame work; settled latency also includes waiting for completion. It does not represent physical display presentation. Nearest-rank p95/p99 summaries retain their raw samples.

| Operation                     | Binding budget                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Full scene and restore        | conservative full-operation work bound p95 ≤ 1,500 ms; settled p95 ≤ 2,000 ms |
| Drawing update and navigation | library work p95/p99 ≤ 16/32 ms; settled ≤ 50/100 ms                          |
| Tail update                   | synchronous p95/p99 ≤ 16/32 ms; settled ≤ 50/100 ms                           |
| Real wheel input              | automation-inclusive p95 < 150 ms                                             |

Full-scene and workspace-restore measurements retain exact synchronous API kickoff components separately. Their 1,500 ms gate uses `operationWorkUpperBoundMs = processingElapsedMs + sum(frames[].renderMs)`: elapsed time starts before construction and ends after all awaited initial/history/workspace processing, before the final idle drain; the frame sum includes every observed frame through that drain. This deliberately includes provider waits and can double-count rendering before the processing boundary. It is a conservative work bound, not exact CPU time. Initial history, each paged history round trip, workspace restoration and idle intervals remain visible in the raw record; no estimated wait is subtracted. The independent complete settled measurement retains its 2,000 ms budget. Prepared bars and drawing documents are generated outside the timer.

Maximum tail delivery targets 10 Hz; the mixed session targets 4 Hz while active and requires at least 120,000 ms, 300 actual tail deliveries and 12 coherent full checkpoints. Preserve target schedules, browser delivery times, dispatch times and checkpoint/lifecycle pauses. Geometry checks cover every saved object against independent expectations; provider OHLCV expectations are compared with actual terminal data. Submitted Canvas commands and retained raster images are distinct observations. Source hashing does not claim exhaustive study-output validation.

The mixed workload exercises all tools, visibility/locking and object recovery, style/level/text edits, undo/redo, Save/Restore, market isolation, corrections, resizing, 25 add/remove cycles and six remounts. Resource observations use equivalent 200-object composition, viewport, closed editor and cleared selection. Before both endpoint samples, the runner invokes and releases the fixture's deliberately saved obsolete provider callback, recording unchanged active-host HTML hashes and counters and a null second delivery. This removes the benchmark's own retained reference symmetrically; it does not clear product state or reset the weak tracker. The later final destroy creates a fresh obsolete callback for the separate immediate and delayed teardown assertions. The fixed authored-structural-weakref-v1 protocol performs exactly three collection turns, without retries or rebasing: structural and listener growth ≤ 0, retained heap delta ≤ 12 MiB, and no outside, detached or disposed owned nodes. Obsolete callbacks must leave observations unchanged immediately and after 800 ms, with a second delivery returning null. Final owned canvases, requests and subscriptions must be zero and both browser and server closed. Unrelated global Blink counters remain diagnostic.

On the committed source, the passing official all-mode record measured scene-work samples 1,179.2/1,272.1/1,279.3 ms (p95 1,279.3 ms) and settled p95 1,246.2 ms, with every recorded phase, checkpoint, resource and cleanup gate accepted. The mixed session ran 412,503 ms with 440 actual deliveries, 15 coherent mixed checkpoints, 25 add/remove cycles and six remounts. The scheduled target was 4 Hz, while reported browser delivery over its delivery window was 1.1924 Hz with 54 recorded pauses; this is not a sustained 4 Hz measurement. Authored structural/listener growth was zero; retained heap growth was 2,671,908 bytes; outside, detached and disposed owned-node counts were zero. The independent audit recalculated the timing and passed 393,566 assertions across 45 sections while checking the exact eight-archive/35-member/52-file installed cohort. Earlier official failures, including the `8f80faf` work-p95 1,717.3 ms run, remain linked in the [measured-attempt table](releases/v0.9.md#measured-attempts). This source-qualified pass establishes the benchmark result, not a physical-device or live-market performance claim.

## v0.10 alert workload

The installed alert workload uses nine private 0.10.0 archives with 42 verified members on exclusive port 5204. The fixed workload contains 400 rules across four stores and 32 monitored queries, 32 warmup batches, three measured phases of 3,125 batches × 32 accepted updates, and a separate mixed phase of at least 120 seconds with 25 rule cycles and six remounts. Every input/timing sample, intended and actual cadence, occurrence oracle and resource observation is retained.

Synchronous processing budgets are p95 ≤ 16 ms / p99 ≤ 32 ms. The callback limits of 50/100 ms apply to actual terminal alert callbacks, separately from batch settled latency. Activation must complete within 2,000 ms. Fixture input preparation and evidence copying occur outside the timing interval. Fixed three-GC endpoints permit at most 12 MiB retained heap growth and no structural/listener growth; final owned sessions, subscriptions, application timers and listeners must be zero. Private numeric snapshots supplement provider, DOM and heap observations. The runner probes/releases deliberately retained obsolete callbacks before both endpoint samples with equivalent rule composition and separately proves post-destroy cleanup.

Measured source ab5dde1e15961358ba050a9683cc13787d0c854a passes the [official all-mode workload](../SOURCE-DISTRIBUTION.md#omitted-development-materials). Processing p95/p99 is 2.8/3.2 ms; actual terminal callback latency is 17.300/20.900 ms; 32-query activation is 240.885 ms. All three phases deliver 100,000 updates and together match 253 store crossings and 64 terminal callbacks. The mixed session runs 416,812 ms with 3,000 batches, 25 rule cycles and six remounts. Owned DOM/listener growth is −40/0, retained heap change −735,244 bytes, and outside/detached/disposed owned counts are zero. Final owned-resource counts and provider requests/subscriptions are zero; browser and server are closed.

The endpoint rule documents are identical, but transient recent-event UI differs: the initial terminal has 20 recent rows and the final remount has none. Their 20 elements and 20 text nodes account for the net −40 observation. Net growth alone therefore cannot exclude 40 offsetting connected nodes; it is not proof of identical UI state. Separate detached/outside/disposed-generation checks, private/listener counts and post-destroy zeros provide the other resource observations.

Maximum target cadence is 100 batches/s; the three observed rates are 6.017, 99.990 and 99.968 batches/s. Mixed target cadence is 25 batches/s and its observed rate is 7.199. These rates include the surrounding dispatch/evidence workload and do not establish sustained target cadence across the entire run. This headless synthetic test does not measure physical display latency, live-market delivery or physical-device performance. Earlier v0.9 drawing measurements describe a different workload.

The first official candidate on 83cdd82 failed with partial sync p95/p99 of 109/140.6 ms. Its original failed evidence remains intact; the corrected source suppresses redundant unchanged transport notifications that repeatedly refreshed the native editor. Only the complete unchanged all-mode run above qualifies the corrected measurement. The [independent final audit](../SOURCE-DISTRIBUTION.md#omitted-development-materials) approves these source-qualified observations with the stated resource and cadence limits. See the [private release report](releases/v0.10.md) for verification and limitations.

Run npm run benchmark:alerts -- --mode=all only after the matching clean committed nine-archive consumer is installed and verified. Modes max and soak remain partial workloads.

## v0.11 four-terminal workload

This section preserves the fixed premeasurement methodology. The [accepted all-mode result](../SOURCE-DISTRIBUTION.md#omitted-development-materials) and [independent audit](../SOURCE-DISTRIBUTION.md#omitted-development-materials) bind source `577d8d66cdcedb33bc6d79dfc37022cfbe94e1be` to a clean committed nine-package 0.11.0 installation with 45 verified archive members and no workspace source aliases, on exclusive port 5205. Earlier 42-member cohorts retain their original inventories. The runner records browser/OS/CPU/display/visibility metadata and DPR 1. A 1600 × 1000 host displays four terminals in two columns with distinct A/1m, B/5m, C/1h and D/1m chart queries.

Each cell holds100,000 deterministic OHLCV rows (seed20260922), SMA200,EMA20,RSI14,MACD12/26/9,Bollinger20×2 and volume:12 series in four panes, including the native band fill. Fifty visible drawings per cell comprise eight horizontal lines and seven each of the other six types; Fibonacci uses seven levels and notes at most three lines. Each cell retains25 alerts:16 armed repeats across eight shared exact query keys, four armed once, three paused and two previously triggered once rules. This reference scene has200 drawings,100 rules and12 steady provider subscriptions: four chart histories plus eight latest alert feeds. The400-rule/32-query capacity pass is separate correctness evidence.

After one complete warmup, record three fresh constructions and three distinct restores. Fresh construction times public monitor creation, the public layout1 grid factory and its immediate restore of the prebuilt complete document. Actual public paging to100k, validation, staging, adoption and ingestion stay inside the measured completion interval. Page requests are recorded separately from feed identities. The monitor is harness-owned and borrowed by the grid; default stores and restored replacements are grid-owned. Separate controls check the default-owned-monitor branch and borrowed-store/provider survival.

The public restore Promise does not wait for hydration. Retain raw synchronous dispatch duration and restore-fulfillment time separately. The4,000ms construction/restore work gate uses a conservative elapsed upper bound through restore fulfillment and all four exact current100k histories/eight latest runtimes becoming ready. It includes asynchronous waits and incidental rendering, and is not synchronous CPU time. Add no render duration to that elapsed value. The6,000ms settled gate starts at the same instant and ends after current charts and callbacks settle.

| Operation | Samples and binding limits |
| --- | --- |
| Full construction / restore | Three of each; work upper-bound p95 ≤4,000ms, settled p95 ≤6,000ms |
| Tail replacement / append+replacement |100 four-cell batches of each; target40ms; library p95/p99 ≤32/64ms, settled ≤100/200ms |
| Semantic interaction |240 samples,60/cell:20 pan,20 zoom,10 drawing edits,10 pane edits; same budgets and target |
| Native wheel |24 effective inputs,6/cell; separate automation-inclusive p95 <200ms |
| Temporal synchronization |48 samples,12/cell, exact/nearest halves across intervals; same library/settled limits |
| Sustained mixed session | At least120 seconds; four chart plus eight monitor updates per intended40ms batch;10 park cycles,20 active changes,10 Save/Restore cycles,6 full remounts |

For tail, interaction and synchronization, library work is synchronous dispatch plus the elapsed duration of each newly submitted chart RAF callback exactly once. A callback affecting multiple charts is one receipt. Counter snapshots used for attribution are outside the callback timer. Actions are separated by chart/callback settling, while an independent target clock preserves actual dispatch, completion and missed cadence. Settled latency and automation-inclusive wheel time are separate observations. Hidden-tab measurements reject. These measurements describe browser JavaScript/Canvas work, not physical display presentation.

Maximum-scene correctness uses12 checkpoints: each measured construction/restore, replacement phase, append phase, interactions, exact half, nearest half and final soak. Every checkpoint hashes every OHLCV row per cell against the deterministic source and mutation prefix. Rendered outputs use exactly16 indices per cell:0,1,13,14,19,20,25,26,33,199,200,floor(N/2),N−4,N−3,N−2,N−1. All nine scalar study outputs, warmup missingness and native fill boundaries are checked at those768 total observations. All200 drawing documents/geometries and100 alert records are checked at every checkpoint. Full source hashes establish source equality; rendered100k study coverage remains sampled.

A separate256-row pass checks every row of all four cells at12 checkpoints, totaling12,288 rendered observations with all study outputs/fill. It exercises tail replacement,255→256 append, drawing/study/pane edits, market/interval changes, a parked once crossing/remount, Save/Restore, zero-size recovery and final mounted state. All fixture markets retain their50 drawings, and the parked alert status/count must remain identical across remount.

Equivalent resource endpoints use exactly three GC turns: structural/listener growth ≤0, retained heap growth ≤32MiB, and detached/disposed owned resources0. History retains at most100k rows/cell; latest feeds retain at most one bar and one pending bar entry, measured separately. Read-only owner snapshots expose actual connection/maps/requests/timers and inactive monitor entries; independent provider/global/DOM observations cover resources outside those owner references. Final grid-owned feeds, listeners, timers, observers and DOM must reach zero while borrowed resources remain usable. Raw failed attempts remain preserved and budgets are never rebased after measurement. Only a complete all-mode record with maximum, soak, full and capacity evidence can qualify final acceptance.

The accepted single installed run records construction/restore hydration p95 **3299.80/3890.60 ms** against 4000 ms, and settled p95 **3333.60/3917.00 ms** against 6000 ms. Replacement/append work p95/p99 is **22.40/23.10** and **22.30/27.40 ms**; interaction/exact-sync/nearest-sync work p95 is **6.10/12.10/11.50 ms**, each within the unchanged 32/64 ms work and 100/200 ms settled limits. Wheel automation-inclusive p95 is **161.17 ms** against its strict 200 ms limit. The independent audit recomputes these nearest-rank statistics from the raw action clocks; hydration is elapsed readiness, not callback CPU.

The session retains 12 maximum checkpoints with 768 sampled rendered rows, 12 separate full-256 checkpoints with 12,288 exhaustive rendered rows, all source hashes, drawings and alerts, and a separate 400-rule/32-query **correctness-only** capacity control. The mixed soak runs **120.395 seconds effective** across 879 batches, 46 pauses and 84 lifecycle observations. Its observed effective rate is **7.30096 Hz** against a nominal 25 Hz target; all 879 target dispatches are recorded as late. Actual replacement/append rates are 12.0054/11.9825 Hz. These observations must not be described as sustained 25 Hz delivery.

All 36 ready three-GC endpoints have matching physical pre/post ownership (108 GC turns, zero retries); the maximum equivalent mounted heap delta is 5,478,044 bytes, below 32 MiB. Final owned feeds, subscriptions, listeners, timers, observers, DOM and pending requests are zero, while borrowed resources remain usable. The [ten installed visual views](../SOURCE-DISTRIBUTION.md#omitted-development-materials) have separate [root](../SOURCE-DISTRIBUTION.md#omitted-development-materials) and [independent](../SOURCE-DISTRIBUTION.md#omitted-development-materials) reviews. At 390 px the bounded Price alerts overlay temporarily covers much of its cell's price chart; the study editor's 96 px unobscured-price guarantee does not apply to this separate overlay. Light-theme thin candles have lower apparent contrast; no formal contrast or touch-device certification was performed. This headless Chrome desktop run under concurrent host load establishes the fixed local gate, not universal latency or a causal optimizer gain. Historical failed attempts remain in the [release verification index](../SOURCE-DISTRIBUTION.md#omitted-development-materials).
