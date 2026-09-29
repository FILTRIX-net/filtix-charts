import './market.css';
import { createChart, darkTheme, lightTheme, type ChartTheme, type CandlePoint } from '@filtix/charts';
import {
  createFeedSession,
  createBinanceProvider,
  type MarketBar,
  type FeedState,
  type FeedStatus,
} from '@filtix/datafeed';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const symbols: Record<string, { name: string; mark: string }> = {
  BTCUSDT: { name: 'Bitcoin', mark: '₿' },
  ETHUSDT: { name: 'Ethereum', mark: 'Ξ' },
  SOLUSDT: { name: 'Solana', mark: '◎' },
};
let theme: 'dark' | 'light' = 'dark';
let symbol = 'BTCUSDT';
let interval = '1m';
let disposed = false;
let firstData = true;
let latest: MarketBar | undefined;
let oldest: number | undefined;
let lastStatus: FeedStatus | undefined;
let lastReceived: number | null = null;
let pageLoaded = false;
let inspectingCandle = false;
let offRange: () => void = () => {};
const objectUrls = new Set<string>();
const revokeTimers = new Set<ReturnType<typeof setTimeout>>();
const themeOptions = (): Partial<ChartTheme> => ({
  ...(theme === 'dark' ? darkTheme : lightTheme),
  background: theme === 'dark' ? '#14181c' : '#fbfcf9',
  fontFamily: 'Consolas, monospace',
  fontSize: 10,
});
const chart = createChart(element('market-chart'), {
  theme: themeOptions(),
  timeDomain: 'utc-ms',
  autoSize: true,
  followLatest: true,
  ariaLabel: 'Binance Spot price and volume. Drag to pan, scroll to zoom, use arrows while focused.',
});
const price = chart.addSeries('candlestick', { id: 'market-candles', pricePrecision: 2 });
const volumePane = chart.addPane({ id: 'volume', weight: 0.28 });
const volume = chart.addSeries('histogram', {
  id: 'market-volume-series',
  paneId: volumePane.id,
  pricePrecision: 2,
});
const numeric = (value: number) =>
  value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeLabel = (time: number) => new Date(time).toISOString().slice(0, 16).replace('T', ' ');
function setText(id: string, text: string) {
  const target = element(id);
  if (target.textContent !== text) target.textContent = text;
}
function renderCandle(bar: CandlePoint) {
  setText('market-candle-time', timeLabel(Number(bar.time)));
  setText('market-open', numeric(bar.open));
  setText('market-high', numeric(bar.high));
  setText('market-low', numeric(bar.low));
  setText('market-close', numeric(bar.close));
  setText('market-volume', numeric(bar.volume ?? 0));
}
const labels: Record<FeedStatus, string> = {
  idle: 'Ready',
  loading: 'Loading',
  live: 'Live',
  stale: 'Stale',
  reconnecting: 'Reconnecting',
  error: 'Unavailable',
  destroyed: 'Closed',
};
const descriptions: Record<FeedStatus, string> = {
  idle: 'Select an instrument to start.',
  loading: 'History and stream are synchronizing.',
  live: 'Receiving public spot-market candles.',
  stale: 'No recent stream message. Prices may be out of date.',
  reconnecting: 'Restoring the connection and checking missed candles.',
  error: 'The source is unavailable. You can reload or choose another instrument.',
  destroyed: 'This chart connection has closed.',
};
function renderState(state: FeedState) {
  if (disposed) return;
  lastReceived = state.lastUpdateAt;
  if (state.status !== lastStatus) {
    lastStatus = state.status;
    element('market-connection').dataset.status = state.status;
    setText('market-status', labels[state.status]);
    setText('market-status-detail', descriptions[state.status]);
  }
  setText('market-bars', state.bars.toLocaleString('en-US') + ' candles');
  const history = element<HTMLButtonElement>('market-history');
  history.disabled =
    state.loadingMore || !state.hasMore || state.status === 'loading' || state.status === 'reconnecting';
  history.textContent = state.loadingMore
    ? 'Loading older…'
    : state.hasMore
      ? 'Load older'
      : 'History loaded';
  element<HTMLButtonElement>('market-export').disabled = state.bars === 0;
  element<HTMLButtonElement>('market-retry').disabled =
    state.status === 'loading' || state.status === 'reconnecting';
  const error = element('market-error');
  error.hidden = !state.error;
  if (state.error) setText('market-error', state.error.message);
  const empty = element('market-empty');
  empty.hidden = state.bars > 0;
  if (!state.bars) {
    const title = empty.querySelector('strong')!;
    const detail = empty.querySelector('p')!;
    title.textContent =
      state.status === 'error'
        ? 'Market data unavailable'
        : state.status === 'live'
          ? 'No candles available'
          : 'Connecting to the market';
    detail.textContent =
      state.error?.message ??
      (state.status === 'live'
        ? 'Try another instrument or interval.'
        : 'Loading public Binance Spot candles');
    (empty.querySelector('.market-loader') as HTMLElement).hidden =
      state.status === 'error' || state.status === 'live';
  }
}
const feed = createFeedSession({
  provider: createBinanceProvider(),
  initialLimit: 500,
  pageSize: 500,
  onChange(change) {
    if (disposed) return;
    if (change.type === 'reset') {
      price.setData(change.bars);
      volume.setData(change.bars.map((bar) => ({ time: bar.time, value: bar.volume })));
      latest = change.bars.at(-1);
      oldest = change.bars.at(0)?.time;
      if (!change.bars.length) {
        inspectingCandle = false;
        firstData = true;
        pageLoaded = false;
        setText('market-price', '—');
        setText('market-candle-time', 'Waiting for history');
        for (const id of ['open', 'high', 'low', 'close', 'volume']) setText('market-' + id, '—');
      } else {
        pageLoaded = true;
        if (firstData) {
          firstData = false;
          chart.setVisibleRange({ from: Math.max(0, change.bars.length - 120), to: change.bars.length + 5 });
        }
      }
      setText('market-oldest', oldest === undefined ? '—' : timeLabel(oldest).slice(0, 10));
    } else {
      price.update(change.bar);
      volume.update({ time: change.bar.time, value: change.bar.volume });
      latest = change.bar;
    }
    if (latest) {
      setText('market-price', numeric(latest.close));
      if (!inspectingCandle) renderCandle(latest);
    }
  },
  onState: renderState,
});
async function loadSelection() {
  firstData = true;
  pageLoaded = false;
  setText('market-title', symbols[symbol]!.name);
  setText('market-symbol-mark', symbols[symbol]!.mark);
  setText('market-source', 'Binance Spot · ' + symbol);
  try {
    await feed.load({ symbol, interval });
  } catch (error) {
    setText('market-error', error instanceof Error ? error.message : String(error));
    element('market-error').hidden = false;
  }
}
offRange = chart.subscribeVisibleRangeChange((range) => {
  const state = feed.getState();
  if (pageLoaded && range.from < 35 && state.status === 'live' && state.hasMore && !state.loadingMore)
    void feed.loadMore();
});
const offCrosshair = chart.subscribeCrosshairMove((event) => {
  const point = event.points['market-candles'];
  inspectingCandle = Boolean(point && 'open' in point);
  if (point && 'open' in point) renderCandle(point);
  else if (latest) renderCandle(latest);
});
element<HTMLSelectElement>('market-symbol').addEventListener('change', (event) => {
  symbol = (event.target as HTMLSelectElement).value;
  void loadSelection();
});
element<HTMLSelectElement>('market-interval').addEventListener('change', (event) => {
  interval = (event.target as HTMLSelectElement).value;
  void loadSelection();
});
element('market-latest').addEventListener('click', () => {
  chart.applyOptions({ followLatest: true });
  chart.scrollToLatest();
});
element('market-fit').addEventListener('click', () => chart.fitContent());
element('market-history').addEventListener('click', () => void feed.loadMore());
element('market-retry').addEventListener('click', () => void feed.retry());
element('market-theme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  chart.applyOptions({ theme: themeOptions() });
  element('market-theme').setAttribute(
    'aria-label',
    'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme',
  );
});
element('market-export').addEventListener('click', async () => {
  try {
    const blob = await chart.exportImage();
    if (disposed) return;
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'FILTIX-' + symbol + '-' + interval + '.png';
    link.click();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
      revokeTimers.delete(timer);
    }, 1000);
    revokeTimers.add(timer);
  } catch (error) {
    if (disposed) return;
    setText('market-error', error instanceof Error ? error.message : String(error));
    element('market-error').hidden = false;
  }
});
const receiptTimer = setInterval(() => {
  setText(
    'market-received',
    lastReceived === null ? '—' : new Date(lastReceived).toISOString().slice(11, 19),
  );
}, 1000);
function destroy() {
  if (disposed) return;
  disposed = true;
  clearInterval(receiptTimer);
  for (const timer of revokeTimers) clearTimeout(timer);
  revokeTimers.clear();
  offRange();
  offCrosshair();
  feed.destroy();
  chart.destroy();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) destroy();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !disposed) void feed.retry();
});
void loadSelection();
