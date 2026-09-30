# FILTRIX Charts milestones

These milestones describe the historical implementation sequence. Historical development tags and raw measurements are not part of the public source history.

| Stage | Outcome                                                                            | Status                    |
| ----- | ---------------------------------------------------------------------------------- | ------------------------- |
| v0.1  | Original chart engine, indicators, React, studio, measured baseline                | Implemented |
| v0.2  | Real history/live data, backfill, reconnect and stale-response protection          | Implemented |
| v0.3  | Editable drawings, measurement, undo/redo, versioned saved layout                  | Implemented |
| v0.4  | Synchronized charts, asset comparison and deterministic history replay             | Implemented |
| v0.5  | Embeddable terminal, independent React installation, sustained recovery            | Implemented |
| v0.6  | Configurable SMA/EMA/RSI instances, workspace migration and measured maximum scene | Implemented |
| v0.7  | MACD, Bollinger Bands, grouped outputs and compatible workspace v3                 | Implemented |
| v0.8  | Transactional pane sizing, responsive study editing and saved layout/workspace v4  | Implemented |

| Next stage | Outcome                                                        | Status                                      |
| ---------- | -------------------------------------------------------------- | ------------------------------------------- |
| v0.8.1     | Bounded configurable legends and auditable acceptance evidence | Implemented |
| v0.9       | Fibonacci, channels, notes, OHLC magnet and object controls    | Implemented |
| v0.10      | Persistent all-market price alerts and native controls         | Implemented |
| v0.11      | Saved 1/2/4 full-terminal grid and optional synchronization    | Implemented |

The current `0.12.0-beta.1` source is public under Apache-2.0. npm publication and a hosted demo remain separate steps.

The first included provider is public Binance Spot with UTC 24/7 crypto data and BTCUSDT, ETHUSDT and SOLUSDT examples. Provider choice is independent of the rendering core. Exchange calendars and equities adjustments require a provider-specific contract.

Historical performance reports qualify their own workloads and source revisions. They do not establish performance of later releases or physical-device behavior.
