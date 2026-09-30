import type { MarketBar, MarketDataProvider, MarketQuery, MarketStreamHandlers } from '@filtrix.net/datafeed';

// An explicitly synthetic, wall-clock-authoritative source. Timer delivery never
// defines history: materializing a snapshot includes bars missed while hidden.
const durations: Record<string, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };
const prices: Record<string, number> = { BTCUSDT: 64_000, ETHUSDT: 3_200, SOLUSDT: 145 };
export function createFixtureProvider() {
  const startedAt = Date.now();
  const origin = Math.floor(startedAt / 3_600_000) * 3_600_000;
  let connected = true;
  let gated = false;
  let delayMs = 12;
  let holdNext = false;
  let lateResolve: (() => void) | null = null;
  let lateFinished: (() => void) | null = null;
  let activeRequests = 0;
  let requests = 0;
  let deliveries = 0;
  let tailDeliveries = 0;
  let subscriptions = 0;
  let lateStream: { query: MarketQuery; handlers: MarketStreamHandlers } | null = null;
  let maxActiveRequests = 0;
  let maxActiveSubscriptions = 0;
  const corrections = new Map<string, Map<number, MarketBar>>();
  const streams = new Set<{ query: MarketQuery; handlers: MarketStreamHandlers; stop(): void }>();
  const key = (q: MarketQuery) => q.symbol + '/' + q.interval;
  function barAt(q: MarketQuery, time: number, now: number): MarketBar {
    const corrected = corrections.get(key(q))?.get(time);
    if (corrected) return { ...corrected };
    const duration = durations[q.interval]!;
    const index = (time - origin) / duration;
    const base = prices[q.symbol]!;
    const open = base * (1 + 0.025 * Math.sin(index * 0.31));
    const finalClose = base * (1 + 0.025 * Math.sin((index + 1) * 0.31));
    const fraction = Math.min(1, Math.max(0, (Math.floor(now / 250) * 250 - time) / duration));
    const close = open + (finalClose - open) * fraction;
    return {
      time,
      open,
      high: Math.max(open, close) + base * 0.003 * fraction,
      low: Math.min(open, close) - base * 0.002 * fraction,
      close,
      volume: (800 + (Math.abs(index) % 97) * 13) * fraction,
      revision: Math.round((fraction * duration) / 250),
    };
  }
  function history(q: MarketQuery, now = Date.now()): MarketBar[] {
    const duration = durations[q.interval];
    if (!duration || !prices[q.symbol]) throw new Error('Unsupported fixture market');
    const end = Math.floor(now / duration) * duration;
    const first = origin - 1_000 * duration;
    const bars: MarketBar[] = [];
    for (let time = first; time <= end; time += duration) bars.push(barAt(q, time, now));
    return bars;
  }
  const provider: MarketDataProvider = {
    id: 'filtix-synthetic-clock-v1',
    revisionMode: 'monotonic',
    maxPageSize: 500,
    async getHistory(request, signal) {
      requests++;
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      let ignoreAbort = holdNext;
      try {
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            lateResolve = resolve;
          });
        }
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted && !ignoreAbort) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (!ignoreAbort) signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, delayMs);
        });
        if (!connected)
          throw { code: 'OFFLINE', message: 'Synthetic connection interrupted', retryable: true };
        let bars = history(request);
        if (request.before !== undefined) bars = bars.filter((b) => b.time < request.before!);
        if (request.from !== undefined) bars = bars.filter((b) => b.time >= request.from!);
        const page = request.from !== undefined ? bars.slice(0, request.limit) : bars.slice(-request.limit);
        return { bars: page, exhausted: page.length === bars.length };
      } finally {
        activeRequests--;
        if (ignoreAbort) {
          const done = lateFinished;
          lateFinished = null;
          done?.();
        }
      }
    },
    subscribe(query, handlers) {
      subscriptions++;
      let alive = true;
      const entry = { query: { ...query }, handlers, stop: () => {} };
      const stop = () => {
        if (!alive) return;
        alive = false;
        clearInterval(timer);
        clearTimeout(openTimer);
        streams.delete(entry);
        lateStream = { query: { ...query }, handlers };
      };
      entry.stop = stop;
      const openTimer = setTimeout(() => {
        if (!alive) return;
        if (connected) handlers.onOpen();
        else
          handlers.onError({ code: 'OFFLINE', message: 'Synthetic connection interrupted', retryable: true });
      }, 0);
      const timer = setInterval(() => {
        if (!connected || gated || !alive) return;
        const now = Date.now();
        const duration = durations[query.interval]!;
        const time = Math.floor(now / duration) * duration;
        // Publish the final previous candle before the evolving tail. This is a
        // realistic late finalization, and exercises historical update handling.
        handlers.onBar(barAt(query, time - duration, now));
        if (!alive) return;
        handlers.onBar(barAt(query, time, now));
        deliveries += 2;
        tailDeliveries++;
      }, 250);
      streams.add(entry);
      maxActiveSubscriptions = Math.max(maxActiveSubscriptions, streams.size);
      return stop;
    },
  };
  return {
    provider,
    holdNextHistory() {
      if (lateResolve || holdNext) throw Error('Only one delayed fixture request');
      holdNext = true;
    },
    async releaseLateHistory() {
      const pending = lateResolve;
      lateResolve = null;
      if (!pending) return false;
      const completed = new Promise<void>((resolve) => {
        lateFinished = resolve;
      });
      pending();
      await completed;
      return true;
    },
    clearFaults() {
      lateStream = null;
      holdNext = false;
      const pending = lateResolve;
      lateResolve = null;
      pending?.();
    },
    deliverLate() {
      if (!lateStream) return null;
      const stale = lateStream;
      lateStream = null;
      const bar = history(stale.query).at(-1)!;
      stale.handlers.onBar(bar);
      stale.handlers.onOpen();
      stale.handlers.onClose();
      return { query: stale.query, time: bar.time };
    },
    startedAt,
    origin,
    history,
    stats: () => ({
      activeRequests,
      activeSubscriptions: streams.size,
      requests,
      subscriptions,
      deliveries,
      tailDeliveries,
      maxActiveRequests,
      maxActiveSubscriptions,
      connected,
      gated,
      now: Date.now(),
    }),
    setConnected(value: boolean) {
      connected = value;
      if (!value) for (const stream of [...streams]) stream.handlers.onClose();
    },
    gate(value: boolean) {
      gated = value;
    },
    setDelay(ms: number) {
      delayMs = ms;
    },
    correct(query: MarketQuery, time: number, emit = true) {
      let market = corrections.get(key(query));
      if (!market) {
        market = new Map();
        corrections.set(key(query), market);
      }
      if (market.size >= 32 && !market.has(time)) throw new Error('Fixture correction cap reached');
      const old = barAt(query, time, Date.now());
      const close = old.close * 1.007;
      const bar = { ...old, close, high: Math.max(old.high, close), revision: (old.revision ?? 0) + 100_000 };
      market.set(time, bar);
      if (emit)
        for (const stream of [...streams])
          if (key(stream.query) === key(query)) stream.handlers.onBar({ ...bar });
      return { ...bar };
    },
    flush(query: MarketQuery) {
      const now = Date.now();
      for (const stream of [...streams])
        if (key(stream.query) === key(query)) {
          const duration = durations[query.interval]!;
          const time = Math.floor(now / duration) * duration;
          stream.handlers.onBar(barAt(query, time - duration, now));
          stream.handlers.onBar(barAt(query, time, now));
        }
      return now;
    },
  };
}
