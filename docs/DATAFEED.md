# FILTRIX Datafeed

`@filtrix.net/datafeed` is an optional, transport-independent controller plus a public Binance Spot adapter. It does not depend on the chart renderer. Importing or constructing it does not open a connection.

## Connect a chart

```ts
import { createChart } from '@filtrix.net/charts';
import { createBinanceProvider, createFeedSession } from '@filtrix.net/datafeed';

const chart = createChart(host, { autoSize: true, timeDomain: 'utc-ms' });
const candles = chart.addSeries('candlestick');
const feed = createFeedSession({
  provider: createBinanceProvider(),
  onChange(change) {
    if (change.type === 'reset') candles.setData(change.bars);
    else candles.update(change.bar);
  },
  onState(state) {
    statusLabel.textContent = state.status;
    // state.error carries a code, message, retryable and optional retryAfterMs.
  },
});
await feed.load({ symbol: 'BTCUSDT', interval: '1m' });
chart.scrollToLatest();

const unsubscribe = chart.subscribeVisibleRangeChange((range) => {
  const state = feed.getState();
  if (range.from < 30 && state.status === 'live' && state.hasMore && !state.loadingMore) void feed.loadMore();
});

// On unmount, release both independent owners.
unsubscribe();
feed.destroy();
chart.destroy();
```

Keep the series handles when handling reset events. `setData` preserves the chart's timestamp anchor during prepend; restoring an old logical range afterwards would move the view to different candles. A reset may also clear the old instrument or deliver authoritative corrections. Tail events use `update` and do not copy the entire history.

The showcase at `/market.html` demonstrates BTC/ETH/SOL, six intervals, price and volume, automatic left-edge paging, explicit connection states, reload, themes and PNG export. It displays source failures without replacing real quotes with synthetic data. The original studio uses labelled synthetic fixtures.

## Session behavior

- `load(query)` replaces the query, cancels obsolete work, emits an empty reset and subscribes before loading history. Old callbacks cannot change the new query.
- `loadMore()` pages before the oldest candle, coalesces simultaneous calls and leaves accepted data usable on a paging failure.
- Lost or silent connections trigger bounded retries and history reconciliation from the last known candle. An empty initial history also settles.
- `retry()` reloads the latest history for the current query, discarding accumulated backfill. Provider cooldowns still apply.
- `applyCorrections(bars)` atomically replaces existing loaded candles. It cannot insert unobserved historical slots.
- `getData()` and `getState()` return owned snapshots. Use incremental callbacks for hot paths.
- `destroy()` cancels requests, timers and subscriptions. It is idempotent; only `getState()` and repeated `destroy()` remain valid afterwards.

Operational network errors appear in state and settle asynchronous methods. Invalid programmer input rejects `load` or throws from synchronous methods. Listener exceptions are isolated. Each public method cancelled by newer work settles even if a provider ignores its abort signal.

Limits are explicit: default 100,000 retained bars, 2,000 buffered candle times, 100 recovery pages, five retries, 15-second history timeout and stale threshold. Reaching a consistency/resource limit stops the session with an error instead of presenting incomplete recovery as live. See the [complete contract](DATAFEED-CONTRACT.md) and [binding design](../SOURCE-DISTRIBUTION.md#omitted-development-materials) for bounds and ordering.

## Provide another source

Implement `MarketDataProvider`: an ID, revision mode, maximum page size, abortable `getHistory` and an owned `subscribe` cleanup function. Supply strictly ascending, unique UTC-millisecond bars with valid OHLC and nonnegative volume. `before` is exclusive and `from` inclusive; they cannot coexist. An exhausted page means no more history in that request direction.

With `revisionMode: 'monotonic'`, every bar needs a nonnegative safe-integer per-candle revision. Ordinary messages must exceed the revision high-water mark, including after an authoritative correction. With `'arrival'`, all revisions must be absent and ordinary messages use arrival order. Source-specific session calendars, adjusted equities and corporate actions belong in a separately defined provider contract.

## Binance transport

The defaults are the public market-data-only hosts `https://data-api.binance.vision` and `wss://data-stream.binance.vision`. Supported intervals are 1m, 5m, 15m, 1h, 4h and 1d. The adapter maps REST/stream kline trade counts to candle revisions, validates messages, respects 429/418 Retry-After cooldowns and leaves connection recovery to the session.

The provider accepts optional REST/stream URL overrides and injected fetch/WebSocket factories for a host proxy or deterministic tests. Default globals are resolved only when used. Public source reachability depends on the user's network and location.

Protocol sources: [Binance public hosts](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md), [REST](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md).

## Latest-only monitoring

createFeedSession accepts mode:'history' (default) or mode:'latest'. Latest mode is intended for consumers such as price alerts that need current observations without retained chart history. It retains at most one visible bar and one buffered candidate, always reports hasMore:false, and loadMore() performs no request. initialLimit, pageSize and maxBars must be omitted or exactly1. Existing history-mode behavior is unchanged.

Latest initial/reconnect/correction resets establish baselines. If a reconnect has no eligible fresh sample, its reset is empty; a cached pre-gap close is not presented as a newly observed baseline. The monotonic timestamp/revision high-water still fences old updates. Providers remain borrowed and each feed owns only its subscription, pending work and timers.
