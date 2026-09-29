# FILTIX Charts v0.1.0

Status: v0.1.0 local release. Functional and reference gates passed. Packages remain private.

## Delivered

Four independently usable packages provide the original Canvas 2D chart engine, validated typed-array storage and scales, batch/incremental SMA/EMA/Wilder RSI, and the React lifecycle adapter. Charts include candles, OHLC, line, area and histogram, synchronized panes, linear/log scales, exact-source crosshair snapshots, keyboard/pointer/touch navigation, themes, live tail updates and PNG export.

The [studio](../README.md) demonstrates these through deterministic synthetic data, timeframe aggregation, working controls, a data table and copyable integration code. [API documentation](API.md) describes integration, time domains, validation, lifecycle and configuration.

## Verification

- 49 unit tests in 7 files passed after the final histogram arithmetic fix.
- 69 browser acceptance scenarios passed across Chrome, Firefox and WebKit, including WebKit DPR 2.
- Strict TypeScript, formatting, all four ESM/declaration builds, production showcase build, built NodeNext consumer, actual React SSR rendering and the no-runtime-import package check passed.
- Visual inspection covered dark/light desktop, mobile, dense/sparse plots, gaps, empty states, flat negative OHLC and DPR 2.
- Independent reviews covered core, indicators, chart behavior, React/studio, package boundaries and benchmark methodology. Final independent result/document review passed; see [REVIEW.md](../SOURCE-DISTRIBUTION.md#omitted-development-materials).
- GitHub Actions is defined locally; no remote CI execution is claimed.

The chart bundle includes its own core and has no external runtime imports: **41,008 bytes raw / 14,132 bytes gzip (level 9)**. The approved limits are 180 KiB / 50 KiB. Indicators, React, the demo and source maps are outside this budget.

## Reference measurement

The reproducible [methodology](PERFORMANCE.md) separates construction, ingest, library drawing work and completed drawing submission. Ten fresh-page runs follow a separate warm-up for every timed scenario; navigation lasts 30 seconds per run and the stream lasts 60 seconds at 10 Hz per run.

Source under measurement: commit `86a7211`, including histogram correction `628b951`. The result records built-package and fixture SHA-256 hashes.

The local profile was frozen before timing: Intel Core i7-11700 (16 logical CPUs), NVIDIA GeForce RTX 4060 through ANGLE/D3D11, Windows build 10.0.26200, Chrome 152.0.7977.83, 1440 × 900 CSS pixels, DPR 1, local Consolas at 11 px. Active power-scheme GUID: `381b4222-f694-41f0-9685-ff5bb260df2e`. The localized scheme label has console-decoding loss in the raw artifact; the GUID is intact. The effective Windows power-mode overlay is unavailable and is not inferred.

The [raw reference result](../SOURCE-DISTRIBUTION.md#omitted-development-materials) completed at 2026-09-08T22:22:51Z, with `mode: reference`, `status: complete`, qualification true, no qualification blockers, and all 12 timing/correctness gates passing. [The profile](../SOURCE-DISTRIBUTION.md#omitted-development-materials) was frozen before timing. The earlier [smoke result](../SOURCE-DISTRIBUTION.md#omitted-development-materials) is retained separately and is not reference evidence.

All values below are milliseconds. Load percentiles use ten independent measured pages; with ten observations, nearest-rank p95 and p99 equal the maximum.

| Candlestick load            | Construction median / p95 | Ingest median / p95 | Ingest to submission median / p95 |
| --------------------------- | ------------------------- | ------------------- | --------------------------------- |
| 1,000 rows, ordinary view   | 17.3 / 30.7               | 3.4 / 5.0           | 13.1 / 20.0                       |
| 10,000 rows, ordinary view  | 17.7 / 35.0               | 8.5 / 11.1          | 16.8 / 21.2                       |
| 100,000 rows, ordinary view | 18.6 / 27.5               | 31.2 / 37.3         | 39.8 / 46.1                       |

The 10k ingest/submission p95 targets are 25/75 ms; the 100k targets are 150/250 ms. All pass. Empty construction and data load are separate intervals; they are not summed into the ingest metric.

| Interaction                              | Samples | Median | p95  | p99  | Maximum |
| ---------------------------------------- | ------- | ------ | ---- | ---- | ------- |
| Navigation: library work                 | 17,993  | 1.9    | 2.6  | 3.0  | 4.3     |
| Navigation: submission latency           | 17,993  | 16.7   | 17.3 | 17.9 | 54.5    |
| 10 Hz stream: update to submission       | 6,000   | 2.2    | 3.1  | 3.6  | 20.5    |
| 10 Hz stream: library work               | 6,000   | 1.7    | 2.5  | 2.9  | 4.2     |
| Burst of 100 appends: submission latency | 10      | 16.6   | 19.2 | 19.2 | 19.2    |

Navigation work passes the 8/16 ms p95/p99 targets. Stream latency passes 32/50 ms. Bursts pass 50 ms p95. The latency maximum is retained even when it is above a percentile target; no observation was trimmed.

Pooled event percentiles do not replace independent runs. The run-level figures below are also present in the raw artifact:

| Run | Navigation events | Navigation work p95 / p99 | Stream events | Stream latency p95 / p99 |
| --- | ----------------- | ------------------------- | ------------- | ------------------------ |
| 1   | 1,798             | 2.6 / 3.0                 | 600           | 3.0 / 3.5                |
| 2   | 1,801             | 2.5 / 3.0                 | 600           | 3.0 / 3.5                |
| 3   | 1,800             | 2.7 / 3.2                 | 600           | 3.0 / 3.4                |
| 4   | 1,801             | 2.6 / 3.0                 | 600           | 2.9 / 3.5                |
| 5   | 1,798             | 2.7 / 3.0                 | 600           | 3.1 / 3.7                |
| 6   | 1,801             | 2.6 / 3.0                 | 600           | 3.1 / 3.5                |
| 7   | 1,797             | 2.5 / 2.9                 | 600           | 3.2 / 18.6               |
| 8   | 1,797             | 2.6 / 3.0                 | 600           | 3.0 / 3.5                |
| 9   | 1,800             | 2.5 / 2.9                 | 600           | 3.1 / 3.8                |
| 10  | 1,800             | 2.6 / 3.1                 | 600           | 3.1 / 3.7                |

Every stream accepted 600 updates, retained the expected final 100,075 bars, matched the canonical final candle, and kept every accepted tail visible. Every burst retained 100 appends and the correct final candle with at most one pending frame and one scene draw. Thirty create/load/destroy cycles left zero owned canvases. Browser user-agent memory measurement was unavailable because this harness is not cross-origin isolated; no heap-leak claim is made from the canvas count.

Additional ten-run diagnostic scenarios are not gated against the single-candle interaction budgets:

| Scenario                                               | Median | p95 / maximum |
| ------------------------------------------------------ | ------ | ------------- |
| Dense 100k: ingest                                     | 33.3   | 35.6          |
| Dense 100k: ingest to submission                       | 44.4   | 46.4          |
| Flat 1k: ingest to submission                          | 12.5   | 19.9          |
| Negative-price 1k: ingest to submission                | 13.2   | 21.4          |
| Gapped 1k: ingest to submission                        | 12.5   | 20.2          |
| Practical candles + volume + EMA: complete scenario    | 213.0  | 236.4         |
| Practical: adding volume and EMA after the candle load | 124.3  | 131.8         |

The practical complete-scenario interval includes fixture preparation, chart construction and indicator/series setup. It must not be compared with the narrower ordinary ingest interval.

Measured charts bundle SHA-256: `47eee820f669d69da9c57a841236db30e3398456357b8ad8d1ad35aa4f6015ed`. The artifact additionally records indicator, generator and fixture hashes. Power identity remained stable and all recorded foreground/visibility conditions passed. The no-concurrent-heavy-jobs condition was observed by the operator, not automatically proven by the harness.

Local tarballs are available in `dist/packages/` for all four packages. Each contains package metadata, its ESM build, declarations and source map; the chart archive is 56,009 bytes. Recreate them after building with `npm pack --workspaces --pack-destination dist/packages` (create the directory first).

## Boundaries

This is a local v0.1 foundation with the scope approved in the [specification](../SOURCE-DISTRIBUTION.md#omitted-development-materials). Performance applies to the recorded workstation and single-candlestick scene. The practical candles/volume/EMA scene is measured separately. Dense histogram bins preserve representable signed sums; totals outside finite double precision saturate to ±Number.MAX_VALUE for display. Histogram rendering scans visible source rows; line/area history replacement and multi-series timeline rebuilds have different costs. A million-bar workload and GPU rendering are future experiments.

Submission timings do not measure physical monitor presentation or establish a universal frame rate. No equivalent competitor benchmark has been run. Memory APIs that the browser does not support remain explicitly unavailable; owned resource cleanup has separate observable checks.

The React adapter was exercised with React 19.2.8 and StrictMode. The BFCache test exercises a synthetic persisted page-transition branch and does not establish browser admission into the actual back/forward cache.

There is no external market feed, order execution, drawing-tool suite, plugin ecosystem or telemetry in this release. Packages were not published, and no open-source license policy is chosen. Integration into the existing FILTIX application is separate from this library workspace.

## Traceability

Specifications, API contracts, ADRs, review fixes and coherent implementation commits are local to branch `feat/v0.1`. [WORKLOG.md](../SOURCE-DISTRIBUTION.md#omitted-development-materials) records contributors, checks and milestones.
