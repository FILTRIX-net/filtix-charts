import { createChart } from '@filtrix.net/charts';
import {
  createFeedSession,
  type MarketBar,
  type MarketQuery,
  type HistoryPage,
  type HistoryRequest,
  type MarketDataProvider,
  type MarketStreamHandlers,
  type FeedStatus,
} from '@filtrix.net/datafeed';

const start = Date.UTC(2026, 8, 1);
const sources = new Map<string, MarketBar[]>();
function source(symbol: string) {
  if (!sources.has(symbol))
    sources.set(
      symbol,
      Array.from({ length: 200 }, (_, i) => ({
        time: start + i * 60000,
        open: symbol === 'ETHUSDT' ? 200 : 100,
        high: symbol === 'ETHUSDT' ? 202 : 102,
        low: symbol === 'ETHUSDT' ? 199 : 99,
        close: symbol === 'ETHUSDT' ? 201 : 101,
        volume: 10,
        revision: 10,
      })),
    );
  return sources.get(symbol)!;
}
const handlers = new Set<MarketStreamHandlers>();
let obsolete: MarketStreamHandlers | undefined;
let hold = false;
let held: { request: HistoryRequest; resolve: (page: HistoryPage) => void } | undefined;
let pendingHeld: Promise<void> | undefined;
function history(request: HistoryRequest): HistoryPage {
  let bars = source(request.symbol).filter(
    (bar) =>
      (request.before === undefined || bar.time < request.before) &&
      (request.from === undefined || bar.time >= request.from),
  );
  bars = request.from === undefined ? bars.slice(-request.limit) : bars.slice(0, request.limit);
  return { bars: bars.map((bar) => ({ ...bar })), exhausted: bars.length < request.limit };
}
const provider: MarketDataProvider = {
  id: 'deterministic-browser-fixture',
  revisionMode: 'monotonic',
  maxPageSize: 1000,
  getHistory(request) {
    if (hold) {
      hold = false;
      return new Promise<HistoryPage>((resolve) => {
        held = { request: { ...request }, resolve };
      });
    }
    return Promise.resolve(history(request));
  },
  subscribe(_query: MarketQuery, listener: MarketStreamHandlers) {
    handlers.add(listener);
    if (hold) obsolete = listener;
    queueMicrotask(() => {
      if (handlers.has(listener)) listener.onOpen();
    });
    return () => {
      handlers.delete(listener);
    };
  },
};
const chart = createChart(document.getElementById('feed-chart')!, { autoSize: true });
const price = chart.addSeries('candlestick', { id: 'feed-price' });
const pane = chart.addPane({ id: 'feed-volume', weight: 0.28 });
const volume = chart.addSeries('histogram', { paneId: pane.id });
const statuses: FeedStatus[] = [];
let notifications = 0;
const feed = createFeedSession({
  provider,
  initialLimit: 40,
  pageSize: 40,
  staleAfterMs: 60000,
  requestTimeoutMs: 2000,
  reconnectBaseMs: 10,
  reconnectMaxMs: 20,
  maxRetries: 2,
  onChange(change) {
    notifications++;
    if (change.type === 'reset') {
      price.setData(change.bars);
      volume.setData(change.bars.map((bar) => ({ time: bar.time, value: bar.volume })));
    } else {
      price.update(change.bar);
      volume.update({ time: change.bar.time, value: change.bar.volume });
    }
  },
  onState(state) {
    notifications++;
    statuses.push(state.status);
  },
});
const api = {
  chart,
  price,
  volume,
  feed,
  notificationCount: () => notifications,
  emitLiveVolume(value: number) {
    const bar = source(feed.getState().query!.symbol).at(-1)!;
    const next = { ...bar, volume: value, revision: bar.revision! + 1 };
    for (const listener of [...handlers]) listener.onBar(next);
  },
  statuses,
  beginHeldLoad() {
    hold = true;
    pendingHeld = feed.load({ symbol: 'BTCUSDT', interval: '1m' });
  },
  async releaseHeld() {
    held?.resolve(history(held.request));
    held = undefined;
    await pendingHeld;
  },
  emitObsolete() {
    obsolete?.onBar({ ...source('BTCUSDT').at(-1)!, high: 1000, close: 999, revision: 999 });
  },
  missBarsAndReconnect(count: number) {
    const symbol = feed.getState().query!.symbol;
    for (const listener of [...handlers]) listener.onClose();
    const bars = source(symbol);
    for (let i = 0; i < count; i++) {
      const last = bars.at(-1)!;
      bars.push({ ...last, time: last.time + 60000 });
    }
  },
  latestSource() {
    const { revision: _revision, ...bar } = source(feed.getState().query!.symbol).at(-1)!;
    return bar;
  },
  activeSubscriptions: () => handlers.size,
  destroy() {
    feed.destroy();
    chart.destroy();
  },
};
declare global {
  interface Window {
    feedTestApi: typeof api;
  }
}
window.feedTestApi = api;
