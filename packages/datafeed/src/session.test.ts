import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFeedSession, getFeedSessionResourceSnapshot } from './session';
import type {
  FeedChange,
  FeedFailure,
  FeedSessionOptions,
  FeedState,
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from './types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function bar(time: number, revision: number, close = revision): MarketBar {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 1, revision };
}

class FakeProvider implements MarketDataProvider {
  readonly id = 'fake';
  readonly revisionMode: 'monotonic' | 'arrival';
  readonly maxPageSize: number;
  readonly history: Array<{
    request: HistoryRequest;
    signal: AbortSignal;
    result: Deferred<HistoryPage>;
  }> = [];
  readonly streams: Array<{
    query: MarketQuery;
    handlers: MarketStreamHandlers;
    unsubscribed: boolean;
  }> = [];

  constructor(revisionMode: 'monotonic' | 'arrival' = 'monotonic', maxPageSize = 1000) {
    this.revisionMode = revisionMode;
    this.maxPageSize = maxPageSize;
  }

  getHistory(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> {
    const result = deferred<HistoryPage>();
    this.history.push({ request: { ...request }, signal, result });
    return result.promise;
  }

  subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void {
    const stream = { query: { ...query }, handlers, unsubscribed: false };
    this.streams.push(stream);
    return () => {
      stream.unsubscribed = true;
    };
  }
}

function setup(
  provider = new FakeProvider(),
  options: Omit<FeedSessionOptions, 'provider' | 'onChange' | 'onState'> = {},
): {
  provider: FakeProvider;
  feed: ReturnType<typeof createFeedSession>;
  changes: FeedChange[];
  states: FeedState[];
} {
  const changes: FeedChange[] = [];
  const states: FeedState[] = [];
  const feed = createFeedSession({
    provider,
    onChange: (change) => changes.push(change),
    onState: (state) => states.push(state),
    ...options,
  });
  return { provider, feed, changes, states };
}

const btc = { symbol: 'BTCUSDT', interval: '1m' };

describe('read-only feed resource snapshots', () => {
  test('observes pending latest data and actual request ownership without invoking callbacks', async () => {
    const { feed, provider, changes, states } = setup(new FakeProvider(), { mode: 'latest' });
    try {
      expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
        destroyed: false,
        mode: 'latest',
        query: null,
        status: 'idle',
        retainedBars: 0,
        pendingBarEntries: 0,
        activeConnection: false,
        pendingRequest: false,
        requestTimer: false,
        staleTimer: false,
        retryTimer: false,
        laneKind: null,
      });
      const loading = feed.load(btc);
      provider.streams[0]!.handlers.onBar(bar(5, 1));
      provider.streams[0]!.handlers.onBar(bar(6, 1));
      const callbacks = [changes.length, states.length];
      const observed = getFeedSessionResourceSnapshot(feed);
      expect(observed).toMatchObject({
        query: btc,
        status: 'loading',
        mode: 'latest',
        retainedBars: 0,
        bufferedBars: 1,
        correctionBars: 0,
        pendingBarEntries: 1,
        activeConnection: true,
        buffering: true,
        laneKind: 'initial',
        pendingRequest: true,
        requestTimer: true,
      });
      (observed.query as MarketQuery).symbol = 'MUTATED';
      expect(getFeedSessionResourceSnapshot(feed).query).toEqual(btc);
      expect([changes.length, states.length]).toEqual(callbacks);
      provider.history[0]!.result.resolve({ bars: [bar(4, 1)], exhausted: true });
      await loading;
      expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
        retainedBars: 1,
        bufferedBars: 0,
        correctionBars: 0,
        pendingBarEntries: 0,
        status: 'live',
        buffering: false,
        pendingRequest: false,
        requestTimer: false,
        laneKind: null,
        activeConnection: true,
        staleTimer: true,
      });
    } finally {
      feed.destroy();
    }
    expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
      destroyed: true,
      status: 'destroyed',
      retainedBars: 1,
      activeConnection: false,
      bufferedBars: 0,
      correctionBars: 0,
      pendingBarEntries: 0,
      pendingRequest: false,
      staleTimer: false,
      retryTimer: false,
      requestTimer: false,
      laneKind: null,
    });
    expect(() => getFeedSessionResourceSnapshot({} as never)).toThrow(/createFeedSession/);
  });

  test.each(['history', 'latest'] as const)(
    'counts real %s recovery buffers and correction entries',
    async (mode) => {
      vi.useFakeTimers();
      const { feed, provider } = setup(new FakeProvider(), { mode, reconnectBaseMs: 1, reconnectMaxMs: 1 });
      try {
        const loading = feed.load(btc);
        provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
        await loading;
        provider.streams[0]!.handlers.onClose();
        expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
          retainedBars: 1,
          activeConnection: false,
          retryTimer: true,
        });
        await vi.advanceTimersByTimeAsync(1);
        provider.streams[1]!.handlers.onBar(bar(6, 1));
        feed.applyCorrections([bar(5, 3, 30)]);
        expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
          mode,
          laneKind: 'recovery',
          pendingRequest: true,
          requestTimer: true,
          retainedBars: 1,
          bufferedBars: 1,
          correctionBars: mode === 'history' ? 1 : 0,
          pendingBarEntries: mode === 'history' ? 2 : 1,
        });
        feed.destroy();
        expect(provider.history[1]!.signal.aborted).toBe(true);
        expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
          destroyed: true,
          retainedBars: 1,
          bufferedBars: 0,
          correctionBars: 0,
          pendingBarEntries: 0,
          activeConnection: false,
          pendingRequest: false,
          requestTimer: false,
          staleTimer: false,
          retryTimer: false,
          laneKind: null,
        });
        expect(vi.getTimerCount()).toBe(0);
        // The canceled provider promise can remain unresolved; it is no longer a session-owned request.
        provider.history[1]!.result.resolve({ bars: [bar(6, 1)], exhausted: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(getFeedSessionResourceSnapshot(feed).activeConnection).toBe(false);
      } finally {
        feed.destroy();
      }
    },
  );

  test('distinguishes request timeout, scheduled retry and current replacement request', async () => {
    vi.useFakeTimers();
    const { feed, provider } = setup(new FakeProvider(), {
      mode: 'latest',
      requestTimeoutMs: 5,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    try {
      const loading = feed.load(btc);
      expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
        pendingRequest: true,
        requestTimer: true,
        retryTimer: false,
      });
      await vi.advanceTimersByTimeAsync(5);
      await loading;
      expect(provider.history[0]!.signal.aborted).toBe(true);
      expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
        pendingRequest: false,
        requestTimer: false,
        retryTimer: true,
        activeConnection: false,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(provider.history).toHaveLength(2);
      expect(getFeedSessionResourceSnapshot(feed)).toMatchObject({
        pendingRequest: true,
        requestTimer: true,
        retryTimer: false,
        activeConnection: true,
      });
    } finally {
      feed.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded latest feed mode', () => {
  test.each(['initialLimit', 'pageSize', 'maxBars'] as const)(
    'rejects a non-1 latest %s before provider work while accepting explicit 1',
    (name) => {
      const provider = new FakeProvider();
      expect(() => createFeedSession({ provider, mode: 'latest', onChange() {}, [name]: 2 })).toThrow(
        /INVALID_OPTIONS/,
      );
      expect(provider.history).toHaveLength(0);
      expect(provider.streams).toHaveLength(0);
      const feed = createFeedSession({ provider, mode: 'latest', onChange() {}, [name]: 1 });
      feed.destroy();
    },
  );

  test('keeps default and explicit history multi-bar behavior', async () => {
    for (const mode of [undefined, 'history'] as const) {
      const { feed, provider } = setup(new FakeProvider(), { mode });
      const loading = feed.load(btc);
      expect(provider.history[0]!.request.limit).toBeGreaterThan(1);
      provider.history[0]!.result.resolve({ bars: [bar(1, 1), bar(2, 1)], exhausted: true });
      await loading;
      expect(feed.getData()).toHaveLength(2);
      feed.destroy();
    }
  });

  test('reconciles an empty history and a synchronous subscribe bar into one baseline', async () => {
    class ImmediateProvider extends FakeProvider {
      override subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void {
        const unsubscribe = super.subscribe(query, handlers);
        handlers.onBar(bar(9, 1));
        return unsubscribe;
      }
    }
    const { feed, provider, changes } = setup(new ImmediateProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    expect(provider.history[0]!.request).toEqual({ ...btc, limit: 1 });
    provider.history[0]!.result.resolve({ bars: [], exhausted: false });
    await loading;
    expect(feed.getData()).toEqual([bar(9, 1)]);
    expect(feed.getState()).toMatchObject({ status: 'live', bars: 1, hasMore: false });
    expect(changes.filter((change) => change.type === 'update')).toHaveLength(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(9, 1)], reason: 'initial' });
    await feed.loadMore();
    expect(provider.history).toHaveLength(1);
    feed.destroy();
  });

  test('settles a genuinely empty latest bootstrap without paging or a live update', async () => {
    const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [], exhausted: false });
    await loading;
    expect(feed.getData()).toEqual([]);
    expect(feed.getState()).toMatchObject({ status: 'live', bars: 0, hasMore: false });
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [], reason: 'initial' });
    expect(changes.filter((change) => change.type === 'update')).toHaveLength(0);
    await feed.loadMore();
    expect(provider.history).toHaveLength(1);
    feed.destroy();
  });

  test('reconciles newest time, equal-time revisions and defensive ownership before live', async () => {
    const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    const pending = bar(11, 2, 20);
    provider.streams[0]!.handlers.onBar(pending);
    provider.streams[0]!.handlers.onBar(bar(10, 99, 99));
    provider.streams[0]!.handlers.onBar(bar(11, 1, 5));
    provider.history[0]!.result.resolve({ bars: [bar(11, 1, 10)], exhausted: false });
    await loading;
    pending.close = 999;
    expect(feed.getData()).toEqual([bar(11, 2, 20)]);
    const snapshot = feed.getData() as MarketBar[];
    snapshot[0]!.close = 999;
    expect(feed.getBar(11)?.close).toBe(20);
    expect(changes.filter((change) => change.type === 'update')).toHaveLength(0);
    expect(feed.getState().hasMore).toBe(false);
    feed.destroy();
  });

  test('reads latest history exhausted once and fences a query switch inside that getter', async () => {
    const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    let reads = 0;
    let switched: Promise<void> | null = null;
    provider.history[0]!.result.resolve({
      bars: [bar(1, 1)],
      get exhausted() {
        reads++;
        switched = feed.load({ symbol: 'ETHUSDT', interval: '1m' });
        return true;
      },
    });
    await loading;
    expect(reads).toBe(1);
    expect(changes.some((change) => change.type === 'reset' && change.bars[0]?.time === 1)).toBe(false);
    expect(provider.history[1]!.request).toEqual({ symbol: 'ETHUSDT', interval: '1m', limit: 1 });
    provider.history[1]!.result.resolve({ bars: [bar(2, 1)], exhausted: true });
    await switched;
    expect(feed.getData()).toEqual([bar(2, 1)]);
    feed.destroy();
  });

  test('arrival ordering replaces at equal time, but never moves the latest tail backward', async () => {
    const provider = new FakeProvider('arrival');
    const { feed } = setup(provider, { mode: 'latest' });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [{ ...bar(5, 1), revision: undefined }], exhausted: true });
    await loading;
    const arrival = (time: number, close: number): MarketBar => ({
      time,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    });
    provider.streams[0]!.handlers.onBar(arrival(5, 10));
    provider.streams[0]!.handlers.onBar(arrival(5, 11));
    provider.streams[0]!.handlers.onBar(arrival(4, 100));
    expect(feed.getData()).toEqual([arrival(5, 11)]);
    feed.destroy();
  });

  test('correction keeps the singleton baseline and revision high-water for later live bars', async () => {
    const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
    await loading;
    feed.applyCorrections([bar(5, 10, 10)]);
    provider.streams[0]!.handlers.onBar(bar(5, 9, 9));
    expect(feed.getData()).toEqual([bar(5, 10, 10)]);
    provider.streams[0]!.handlers.onBar(bar(5, 11, 11));
    expect(feed.getData()).toEqual([bar(5, 11, 11)]);
    expect(
      changes.filter((change) => change.type === 'reset' && change.reason === 'correction'),
    ).toHaveLength(1);
    expect(feed.getState()).toMatchObject({ bars: 1, hasMore: false });
    feed.destroy();
  });

  test('reconnect reconciliation keeps a same-time explicit correction above stale history and stream revisions', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    feed.applyCorrections([bar(5, 3, 30)]);
    provider.streams[1]!.handlers.onBar(bar(5, 2, 20));
    provider.history[1]!.result.resolve({ bars: [bar(5, 1, 10)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()).toEqual([bar(5, 3, 30)]);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(5, 3, 30)], reason: 'reconnect' });
    expect(feed.getState().hasMore).toBe(false);
    feed.destroy();
  });

  test('bounds pending candidates, retained bars and revision high-water through 100k buffered and live updates', async () => {
    const provider = new FakeProvider();
    const feed = createFeedSession({ provider, mode: 'latest', onChange() {} });
    const originalSet = Map.prototype.set;
    let largestPending = 0;
    let largestHighWater = 0;
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      const result = originalSet.call(this, key, value);
      if (typeof key === 'number' && key >= 1_000_000 && key <= 1_200_000) {
        if (typeof value === 'object' && value !== null && 'bar' in value && 'sequence' in value)
          largestPending = Math.max(largestPending, this.size);
        if (typeof value === 'number') largestHighWater = Math.max(largestHighWater, this.size);
      }
      return result;
    } as typeof Map.prototype.set;
    try {
      const loading = feed.load(btc);
      for (let index = 1; index <= 100_000; index++)
        provider.streams[0]!.handlers.onBar(bar(1_000_000 + index, index));
      expect(largestPending).toBeLessThanOrEqual(1);
      provider.history[0]!.result.resolve({ bars: [bar(1_000_000, 0)], exhausted: false });
      await loading;
      expect(feed.getData()).toEqual([bar(1_100_000, 100_000)]);
      for (let index = 1; index <= 100_000; index++)
        provider.streams[0]!.handlers.onBar(bar(1_100_000 + index, index));
      expect(feed.getData()).toEqual([bar(1_200_000, 100_000)]);
      expect(feed.getState()).toMatchObject({ status: 'live', bars: 1, hasMore: false, error: null });
      expect(largestHighWater).toBeLessThanOrEqual(1);
      await feed.loadMore();
      expect(provider.history).toHaveLength(1);
    } finally {
      Map.prototype.set = originalSet;
      feed.destroy();
    }
  });

  test('reconnects with one cursor-free request and a reconnect baseline, ignoring old callbacks', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: false });
    await loading;
    const old = provider.streams[0]!.handlers;
    old.onClose();
    old.onBar(bar(99, 99));
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.history[1]!.request).toEqual({ ...btc, limit: 1 });
    provider.history[1]!.result.resolve({ bars: [bar(8, 1)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()).toEqual([bar(8, 1)]);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(8, 1)], reason: 'reconnect' });
    expect(feed.getState().hasMore).toBe(false);
    feed.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('automatic reconnect after an empty baseline still emits reconnect', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.history[1]!.request).toEqual({ ...btc, limit: 1 });
    provider.history[1]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(2, 1)], reason: 'reconnect' });
    feed.destroy();
  });

  test('recovers from a timed-out latest request and a later stale watchdog without a forward page', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      requestTimeoutMs: 5,
      staleAfterMs: 5,
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    await vi.advanceTimersByTimeAsync(5);
    await loading;
    expect(provider.history[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.history[1]!.request).toEqual({ ...btc, limit: 1 });
    provider.history[1]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(2, 1)], reason: 'reconnect' });
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.history[2]!.request).toEqual({ ...btc, limit: 1 });
    provider.history[2]!.result.resolve({ bars: [bar(3, 1)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()).toEqual([bar(3, 1)]);
    expect(feed.getState()).toMatchObject({ status: 'live', hasMore: false });
    feed.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('fences a latest stream bar whose getter destroys the session during validation', async () => {
    const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    const input = bar(2, 2);
    Object.defineProperty(input, 'close', {
      get() {
        feed.destroy();
        return 2;
      },
    });
    const before = changes.filter((change) => change.type === 'update').length;
    provider.streams[0]!.handlers.onBar(input);
    expect(feed.getState().status).toBe('destroyed');
    expect(changes.filter((change) => change.type === 'update')).toHaveLength(before);
  });

  test('returns a synchronous subscribe-close lease and can retry a rejected bootstrap', async () => {
    vi.useFakeTimers();
    class ClosingProvider extends FakeProvider {
      override subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void {
        const unsubscribe = super.subscribe(query, handlers);
        handlers.onBar(bar(1, 1));
        handlers.onClose();
        return unsubscribe;
      }
    }
    const { feed, provider } = setup(new ClosingProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    await feed.load(btc);
    expect(provider.streams[0]!.unsubscribed).toBe(true);
    expect(provider.history).toHaveLength(0);
    feed.destroy();

    const retried = setup(new FakeProvider(), { mode: 'latest' });
    const loading = retried.feed.load(btc);
    retried.provider.history[0]!.result.reject({ code: 'OFFLINE', message: 'retry', retryable: true });
    await loading;
    const retry = retried.feed.retry();
    expect(retried.provider.history[1]!.request).toEqual({ ...btc, limit: 1 });
    retried.provider.history[1]!.result.resolve({ bars: [bar(3, 1)], exhausted: false });
    await retry;
    expect(retried.feed.getData()).toEqual([bar(3, 1)]);
    retried.feed.destroy();
  });

  test.each(['history', 'latest'] as const)(
    'fences %s corrections when a validating getter destroys or switches the query',
    async (mode) => {
      for (const reentry of ['destroy', 'switch'] as const) {
        const { feed, provider, changes } = setup(new FakeProvider(), { mode });
        const loading = feed.load(btc);
        provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
        await loading;
        const original = bar(1, 2);
        let switched: Promise<void> | null = null;
        let once = false;
        Object.defineProperty(original, 'close', {
          get() {
            if (!once) {
              once = true;
              if (reentry === 'destroy') feed.destroy();
              else switched = feed.load({ symbol: 'ETHUSDT', interval: '1m' });
            }
            return 2;
          },
        });
        const before = changes.filter(
          (change) => change.type === 'reset' && change.reason === 'correction',
        ).length;
        expect(() => feed.applyCorrections([original])).not.toThrow();
        expect(
          changes.filter((change) => change.type === 'reset' && change.reason === 'correction'),
        ).toHaveLength(before);
        if (switched) {
          provider.history[1]!.result.resolve({ bars: [bar(2, 1)], exhausted: true });
          await switched;
          expect(feed.getData()).toEqual([bar(2, 1)]);
          feed.destroy();
        } else expect(feed.getState().status).toBe('destroyed');
      }
    },
  );
});

describe('C1 reviewer R1 and R2 regressions', () => {
  test.each(['buffered', 'equal-time', 'append'] as const)(
    'uses one captured revision policy during latest %s receipt after validation',
    async (path) => {
      for (const action of ['switch', 'destroy', 'throw'] as const) {
        vi.useFakeTimers();
        const { feed, provider, changes } = setup(new FakeProvider(), {
          mode: 'latest',
          reconnectBaseMs: 1,
          reconnectMaxMs: 1,
        });
        try {
          const loading = feed.load(btc);
          provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
          await loading;
          let stream = provider.streams[0]!.handlers;
          if (path === 'buffered') {
            stream.onClose();
            await vi.advanceTimersByTimeAsync(1);
            stream = provider.streams[1]!.handlers;
            stream.onBar(bar(6, 1));
          }
          let reads = 0;
          Object.defineProperty(provider, 'revisionMode', {
            configurable: true,
            get() {
              reads++;
              if (reads === 2) {
                if (action === 'switch') void feed.load({ symbol: 'ETHUSDT', interval: '1m' });
                else if (action === 'destroy') feed.destroy();
                else throw new Error('revision policy getter failed');
              }
              return 'monotonic';
            },
          });
          const incoming = path === 'append' ? bar(6, 2) : bar(path === 'buffered' ? 6 : 5, 2);
          const before = changes.filter((change) => change.type === 'update').length;
          expect(() => stream.onBar(incoming)).not.toThrow();
          expect(reads).toBe(1);
          if (path === 'buffered') {
            Object.defineProperty(provider, 'revisionMode', { configurable: true, value: 'monotonic' });
            provider.history[1]!.result.resolve({ bars: [bar(5, 1)], exhausted: false });
            await vi.advanceTimersByTimeAsync(0);
            expect(feed.getData()).toEqual([bar(6, 2)]);
            expect(changes.filter((change) => change.type === 'update')).toHaveLength(before);
          } else {
            expect(feed.getData()).toEqual([incoming]);
            expect(changes.filter((change) => change.type === 'update')).toHaveLength(before + 1);
          }
          expect(feed.getState()).toMatchObject({ status: 'live', query: btc });
        } finally {
          feed.destroy();
          Object.defineProperty(provider, 'revisionMode', { configurable: true, value: 'monotonic' });
        }
      }
    },
  );

  test.each(['history', 'latest'] as const)(
    'uses a captured revision policy through %s correction publication',
    async (mode) => {
      for (const action of ['switch', 'destroy', 'throw'] as const) {
        const { feed, provider, changes } = setup(new FakeProvider(), { mode });
        try {
          const loading = feed.load(btc);
          provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
          await loading;
          let reads = 0;
          Object.defineProperty(provider, 'revisionMode', {
            configurable: true,
            get() {
              reads++;
              if (reads === 2) {
                if (action === 'switch') void feed.load({ symbol: 'ETHUSDT', interval: '1m' });
                else if (action === 'destroy') feed.destroy();
                else throw new Error('revision policy getter failed');
              }
              return 'monotonic';
            },
          });
          const before = changes.filter(
            (change) => change.type === 'reset' && change.reason === 'correction',
          ).length;
          expect(() => feed.applyCorrections([bar(5, 2, 20)])).not.toThrow();
          expect(reads).toBe(1);
          expect(feed.getData()).toEqual([bar(5, 2, 20)]);
          expect(
            changes.filter((change) => change.type === 'reset' && change.reason === 'correction'),
          ).toHaveLength(before + 1);
          expect(feed.getState()).toMatchObject({ status: 'live', query: btc });
        } finally {
          feed.destroy();
          Object.defineProperty(provider, 'revisionMode', { configurable: true, value: 'monotonic' });
        }
      }
    },
  );

  test('does not publish when the first revision-policy read switches, destroys or throws', async () => {
    for (const action of ['switch', 'destroy', 'throw'] as const) {
      const { feed, provider, changes } = setup(new FakeProvider(), { mode: 'latest' });
      const loading = feed.load(btc);
      provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
      await loading;
      let reads = 0;
      Object.defineProperty(provider, 'revisionMode', {
        configurable: true,
        get() {
          reads++;
          if (action === 'switch') void feed.load({ symbol: 'ETHUSDT', interval: '1m' });
          else if (action === 'destroy') feed.destroy();
          else throw new Error('revision policy getter failed');
          return 'monotonic';
        },
      });
      const before = changes.filter((change) => change.type === 'update').length;
      expect(() => provider.streams[0]!.handlers.onBar(bar(6, 2))).not.toThrow();
      expect(reads).toBe(1);
      expect(changes.filter((change) => change.type === 'update')).toHaveLength(before);
      if (action === 'switch')
        expect(feed.getState()).toMatchObject({ query: { symbol: 'ETHUSDT' }, bars: 0 });
      if (action === 'destroy') expect(feed.getState().status).toBe('destroyed');
      if (action === 'throw') expect(feed.getState()).toMatchObject({ status: 'error', bars: 1 });
      Object.defineProperty(provider, 'revisionMode', { configurable: true, value: 'monotonic' });
      feed.destroy();
    }
  });

  test.each(['live-correction', 'correction-live'] as const)(
    'retains at most one total pending bar in %s recovery order for equal and different times',
    async (order) => {
      for (const sameTime of [true, false]) {
        vi.useFakeTimers();
        const provider = new FakeProvider();
        const { feed } = setup(provider, { mode: 'latest', reconnectBaseMs: 1, reconnectMaxMs: 1 });
        const originalSet = Map.prototype.set;
        const pendingMaps = new Set<Map<unknown, unknown>>();
        let peakPending = 0;
        Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
          const result = originalSet.call(this, key, value);
          if (
            typeof key === 'number' &&
            (key === 5 || key === 6) &&
            typeof value === 'object' &&
            value !== null &&
            'bar' in value &&
            'sequence' in value
          ) {
            pendingMaps.add(this);
            peakPending = Math.max(
              peakPending,
              [...pendingMaps].reduce((count, map) => count + map.size, 0),
            );
          }
          return result;
        } as typeof Map.prototype.set;
        try {
          const loading = feed.load(btc);
          provider.history[0]!.result.resolve({ bars: [bar(5, 1)], exhausted: true });
          await loading;
          provider.streams[0]!.handlers.onClose();
          await vi.advanceTimersByTimeAsync(1);
          const live = () => provider.streams[1]!.handlers.onBar(bar(sameTime ? 5 : 6, 3, 30));
          const correction = () => feed.applyCorrections([bar(5, 2, 20)]);
          if (order === 'live-correction') {
            live();
            correction();
          } else {
            correction();
            live();
          }
          const expected =
            sameTime && order === 'live-correction' ? bar(5, 2, 20) : bar(sameTime ? 5 : 6, 3, 30);
          provider.history[1]!.result.resolve({ bars: [bar(5, 1, 10)], exhausted: false });
          await vi.advanceTimersByTimeAsync(0);
          expect(feed.getData()).toEqual([expected]);
          expect(peakPending).toBeLessThanOrEqual(1);
          expect(feed.getState().hasMore).toBe(false);
        } finally {
          Map.prototype.set = originalSet;
          feed.destroy();
        }
      }
    },
  );

  test('replays a lower-revision correction after history before rejecting a later ordinary candidate', async () => {
    vi.useFakeTimers();
    const { feed, provider } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(5, 10, 10)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    feed.applyCorrections([bar(5, 2, 20)]);
    provider.streams[1]!.handlers.onBar(bar(5, 5, 30));
    provider.history[1]!.result.resolve({ bars: [bar(5, 12, 100)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()).toEqual([bar(5, 2, 20)]);
    provider.streams[1]!.handlers.onBar(bar(5, 11, 110));
    expect(feed.getData()).toEqual([bar(5, 2, 20)]);
    provider.streams[1]!.handlers.onBar(bar(5, 13, 130));
    expect(feed.getData()).toEqual([bar(5, 13, 130)]);
    feed.destroy();
  });
});

describe('C1 latest reconnect freshness', () => {
  test('empty reconnects clear the visible baseline while retaining the time and revision fence', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(100, 8)], exhausted: true });
    await loading;
    for (let index = 1; index <= 2; index++) {
      provider.streams[index - 1]!.handlers.onClose();
      await vi.advanceTimersByTimeAsync(1);
      provider.history[index]!.result.resolve({ bars: [], exhausted: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(changes.at(-1)).toEqual({ type: 'reset', bars: [], reason: 'reconnect' });
      expect(feed.getState()).toMatchObject({ status: 'live', bars: 0, hasMore: false });
      provider.streams[index]!.handlers.onBar(bar(90, 9));
      provider.streams[index]!.handlers.onBar(bar(100, 8));
      expect(feed.getData()).toEqual([]);
      expect(() => feed.applyCorrections([bar(100, 10)])).toThrow(/INVALID_CORRECTION/);
    }
    provider.streams[2]!.handlers.onBar(bar(100, 9));
    expect(feed.getData()).toEqual([bar(100, 9)]);
    feed.destroy();
  });

  test('rejected older history and duplicate live candidates do not make a reconnect fresh', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(100, 8)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.streams[1]!.handlers.onBar(bar(100, 8));
    provider.history[1]!.result.resolve({ bars: [bar(90, 12)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [], reason: 'reconnect' });
    provider.streams[1]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.history[2]!.result.resolve({ bars: [bar(100, 2, 20)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(100, 2, 20)], reason: 'reconnect' });
    provider.streams[2]!.handlers.onBar(bar(100, 8, 80));
    expect(feed.getData()).toEqual([bar(100, 2, 20)]);
    provider.streams[2]!.handlers.onBar(bar(100, 9, 90));
    expect(feed.getData()).toEqual([bar(100, 9, 90)]);
    feed.destroy();
  });

  test('same-value returned history is fresh, and only a correction made during recovery is fresh', async () => {
    vi.useFakeTimers();
    const { feed, provider, changes } = setup(new FakeProvider(), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(100, 8)], exhausted: true });
    await loading;
    feed.applyCorrections([bar(100, 2, 20)]);
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.history[1]!.result.resolve({ bars: [], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [], reason: 'reconnect' });
    provider.streams[1]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.history[2]!.result.resolve({ bars: [bar(100, 2, 20)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(100, 2, 20)], reason: 'reconnect' });
    provider.streams[2]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    feed.applyCorrections([bar(100, 1, 10)]);
    provider.history[3]!.result.resolve({ bars: [], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual({ type: 'reset', bars: [bar(100, 1, 10)], reason: 'reconnect' });
    feed.destroy();
  });

  test('arrival mode keeps the time floor after an empty reconnect and fresh load resets it', async () => {
    vi.useFakeTimers();
    const arrival = (time: number, close: number): MarketBar => ({
      time,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    });
    const { feed, provider } = setup(new FakeProvider('arrival'), {
      mode: 'latest',
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [arrival(100, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.history[1]!.result.resolve({ bars: [], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()).toEqual([]);
    provider.streams[1]!.handlers.onBar(arrival(90, 1));
    expect(feed.getData()).toEqual([]);
    provider.streams[1]!.handlers.onBar(arrival(100, 20));
    expect(feed.getData()).toEqual([arrival(100, 20)]);
    const fresh = feed.load({ symbol: 'ETHUSDT', interval: '1m' });
    provider.history[2]!.result.resolve({ bars: [arrival(1, 1)], exhausted: true });
    await fresh;
    expect(feed.getData()).toEqual([arrival(1, 1)]);
    feed.destroy();
  });
});

describe('createFeedSession', () => {
  test('subscribes before history and reconciles a newer buffered revision', async () => {
    const { provider, feed, changes } = setup();

    const loading = feed.load(btc);
    expect(provider.streams).toHaveLength(1);
    provider.streams[0]!.handlers.onBar(bar(60_000, 3));
    provider.history[0]!.result.resolve({ bars: [bar(60_000, 2)], exhausted: true });
    await loading;

    expect(feed.getData()).toEqual([bar(60_000, 3)]);
    expect(feed.getState()).toMatchObject({ status: 'live', loadingMore: false, hasMore: false });
    expect(changes.map((change) => change.type)).toEqual(['reset', 'reset']);
    feed.destroy();
  });

  test('settles superseded loads and ignores old responses and stream events', async () => {
    const { provider, feed } = setup();
    const first = feed.load(btc);
    const oldStream = provider.streams[0]!;
    const second = feed.load({ symbol: 'ETHUSDT', interval: '5m' });

    await first;
    expect(provider.history[0]!.signal.aborted).toBe(true);
    oldStream.handlers.onBar(bar(1, 99));
    provider.history[0]!.result.resolve({ bars: [bar(1, 98)], exhausted: true });
    provider.history[1]!.result.resolve({ bars: [bar(2, 1)], exhausted: true });
    await second;

    expect(feed.getState().query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
    expect(feed.getData()).toEqual([bar(2, 1)]);
    feed.destroy();
  });

  test('a timed out request settles even when the provider ignores abort', async () => {
    vi.useFakeTimers();
    const { provider, feed } = setup(new FakeProvider(), {
      requestTimeoutMs: 25,
      reconnectBaseMs: 100,
      reconnectMaxMs: 100,
    });

    const loading = feed.load(btc);
    await vi.advanceTimersByTimeAsync(25);
    await loading;

    expect(provider.history[0]!.signal.aborted).toBe(true);
    expect(feed.getState()).toMatchObject({ status: 'reconnecting', retryCount: 1 });
    feed.destroy();
  });

  test('uses an independent revision high-water across authoritative corrections', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(60_000, 100)], exhausted: true });
    await loading;

    feed.applyCorrections([bar(60_000, 1, 50)]);
    provider.streams[0]!.handlers.onBar(bar(60_000, 99, 99));
    expect(feed.getData()[0]).toEqual(bar(60_000, 1, 50));
    provider.streams[0]!.handlers.onBar(bar(60_000, 101, 101));

    expect(feed.getData()[0]).toEqual(bar(60_000, 101, 101));
    expect(changes.at(-2)).toMatchObject({ type: 'reset', reason: 'correction' });
    expect(changes.at(-1)).toEqual({ type: 'update', bar: bar(60_000, 101, 101) });
    feed.destroy();
  });

  test('backfill preserves live changes accepted while its request is pending', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({
      bars: [bar(120_000, 1), bar(180_000, 1)],
      exhausted: false,
    });
    await loading;

    const paging = feed.loadMore();
    expect(provider.history[1]!.request).toMatchObject({ before: 120_000 });
    provider.streams[0]!.handlers.onBar(bar(120_000, 2, 20));
    provider.history[1]!.result.resolve({ bars: [bar(60_000, 1)], exhausted: true });
    await paging;

    expect(feed.getData()).toEqual([bar(60_000, 1), bar(120_000, 2, 20), bar(180_000, 1)]);
    expect(changes.at(-1)).toMatchObject({ type: 'reset', reason: 'backfill' });
    feed.destroy();
  });

  test('coalesces concurrent loadMore calls into one history request', async () => {
    const { provider, feed } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await loading;

    const first = feed.loadMore();
    const second = feed.loadMore();
    expect(provider.history).toHaveLength(2);
    provider.history[1]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await Promise.all([first, second]);
    expect(feed.getData().map((item) => item.time)).toEqual([1, 2]);
    feed.destroy();
  });

  test('recovers forward through multiple pages and merges the reconnect buffer', async () => {
    vi.useFakeTimers();
    const { provider, feed, changes } = setup(new FakeProvider(), {
      pageSize: 2,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1), bar(2, 1)], exhausted: true });
    await loading;

    provider.streams[0]!.handlers.onClose();
    provider.streams[0]!.handlers.onError({ code: 'DUPLICATE', message: 'late', retryable: true });
    expect(feed.getState().retryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(provider.streams).toHaveLength(2);
    expect(provider.history[1]!.request).toMatchObject({ from: 2, limit: 2 });
    provider.streams[1]!.handlers.onBar(bar(3, 3));
    provider.history[1]!.result.resolve({ bars: [bar(2, 2), bar(3, 2)], exhausted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.history[2]!.request).toMatchObject({ from: 4, limit: 2 });
    provider.history[2]!.result.resolve({ bars: [bar(4, 1)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(feed.getData()).toEqual([bar(1, 1), bar(2, 2), bar(3, 3), bar(4, 1)]);
    expect(feed.getState()).toMatchObject({ status: 'live', retryCount: 0 });
    expect(changes.at(-1)).toMatchObject({ type: 'reset', reason: 'reconnect' });
    feed.destroy();
  });

  test('uses Retry-After as the minimum reconnect delay', async () => {
    vi.useFakeTimers();
    const { provider, feed } = setup(new FakeProvider(), {
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;

    provider.streams[0]!.handlers.onError({
      code: 'RATE_LIMIT',
      message: 'slow down',
      retryable: true,
      retryAfterMs: 50,
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(provider.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.streams).toHaveLength(2);
    feed.destroy();
  });

  test('stops after retry exhaustion and allows a manual fresh retry', async () => {
    vi.useFakeTimers();
    const { provider, feed, changes } = setup(new FakeProvider(), {
      maxRetries: 1,
      reconnectBaseMs: 5,
      reconnectMaxMs: 5,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(5);
    provider.streams[1]!.handlers.onClose();
    expect(feed.getState()).toMatchObject({ status: 'error', retryCount: 1 });

    const retrying = feed.retry();
    expect(changes.at(-1)).toMatchObject({ type: 'reset', reason: 'initial', bars: [] });
    provider.history.at(-1)!.result.resolve({ bars: [bar(10, 1)], exhausted: true });
    await retrying;
    expect(feed.getData()).toEqual([bar(10, 1)]);
    feed.destroy();
  });

  test('marks a silent connection stale and begins one recovery', async () => {
    vi.useFakeTimers();
    const { provider, feed, states } = setup(new FakeProvider(), {
      staleAfterMs: 20,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;

    await vi.advanceTimersByTimeAsync(20);
    expect(states.some((state) => state.status === 'stale')).toBe(true);
    expect(feed.getState()).toMatchObject({ status: 'reconnecting', retryCount: 1 });
    feed.destroy();
  });

  test('does not let a reentrant state listener apply an old-query live bar to the replacement query', async () => {
    const provider = new FakeProvider();
    let replacement: Promise<void> | null = null;
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange() {},
      onState(state) {
        if (state.query?.symbol === 'BTCUSDT' && state.lastUpdateAt !== null && !replacement) {
          replacement = feed.load({ symbol: 'ETHUSDT', interval: '5m' });
        }
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;

    provider.streams[0]!.handlers.onBar(bar(2, 2));
    expect(feed.getState().query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
    expect(feed.getData()).toEqual([]);
    provider.history[1]!.result.resolve({ bars: [bar(10, 1)], exhausted: true });
    await replacement;
    feed.destroy();
  });
  test('preserves an explicit correction made while recovery is pending', async () => {
    vi.useFakeTimers();
    const { provider, feed } = setup(new FakeProvider(), {
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1), bar(2, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);

    feed.applyCorrections([bar(1, 100, 100)]);
    provider.history[1]!.result.resolve({ bars: [bar(2, 2)], exhausted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.getData()[0]).toEqual(bar(1, 100, 100));

    provider.streams[1]!.handlers.onBar(bar(1, 99, 99));
    expect(feed.getData()[0]).toEqual(bar(1, 100, 100));
    feed.destroy();
  });

  test('does not let reentrant loadMore state observers cancel the replacement query', async () => {
    const provider = new FakeProvider();
    let replacement: Promise<void> | null = null;
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange() {},
      onState(state) {
        if (state.loadingMore && !replacement) {
          replacement = feed.load({ symbol: 'ETHUSDT', interval: '5m' });
        }
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    expect(provider.history).toHaveLength(2);
    expect(provider.history[1]!.signal.aborted).toBe(false);
    provider.history[1]!.result.resolve({ bars: [bar(500, 1)], exhausted: true });
    await Promise.all([paging, replacement]);
    expect(feed.getState()).toMatchObject({
      status: 'live',
      query: { symbol: 'ETHUSDT', interval: '5m' },
    });
    expect(feed.getData()).toEqual([bar(500, 1)]);
    feed.destroy();
  });

  test('keeps a newly inserted live bar newer than an overlapping backfill page', async () => {
    const { provider, feed } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    provider.streams[0]!.handlers.onBar(bar(60, 10, 10));
    provider.history[1]!.result.resolve({ bars: [bar(60, 1, 1)], exhausted: true });
    await paging;

    expect(feed.getData()).toEqual([bar(60, 10, 10), bar(120, 1)]);
    feed.destroy();
  });

  test('ignores a backfill page when a bar getter replaces the query during validation', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    let replacement: Promise<void> | null = null;
    const input = bar(60, 1);
    Object.defineProperty(input, 'time', {
      enumerable: true,
      get() {
        replacement ??= feed.load({ symbol: 'ETHUSDT', interval: '5m' });
        return 60;
      },
    });
    provider.history[1]!.result.resolve({ bars: [input], exhausted: true });
    await paging;

    expect(replacement).not.toBeNull();
    expect(feed.getData()).toEqual([]);
    expect(feed.getState()).toMatchObject({ status: 'loading', bars: 0, hasMore: true });
    expect(changes.filter((change) => change.type === 'reset' && change.reason === 'backfill')).toHaveLength(
      0,
    );
    provider.history[2]!.result.resolve({ bars: [bar(500, 1)], exhausted: true });
    await replacement;
    expect(feed.getData()).toEqual([bar(500, 1)]);
    feed.destroy();
  });

  test('ignores a backfill page when its exhausted getter replaces the query', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    let replacement: Promise<void> | null = null;
    let reads = 0;
    provider.history[1]!.result.resolve({
      bars: [bar(60, 1)],
      get exhausted() {
        reads += 1;
        if (reads === 2) replacement = feed.load({ symbol: 'ETHUSDT', interval: '5m' });
        return true;
      },
    });
    await paging;

    expect(reads).toBe(2);
    expect(replacement).not.toBeNull();
    expect(feed.getData()).toEqual([]);
    expect(feed.getState()).toMatchObject({ status: 'loading', bars: 0, hasMore: true });
    expect(changes.filter((change) => change.type === 'reset' && change.reason === 'backfill')).toHaveLength(
      0,
    );
    provider.history[2]!.result.resolve({ bars: [bar(500, 1)], exhausted: true });
    await replacement;
    expect(feed.getData()).toEqual([bar(500, 1)]);
    feed.destroy();
  });

  test('does not install a reconnect timer after a reentrant observer destroys the session', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange() {},
      onState(state) {
        if (state.status === 'reconnecting') feed.destroy();
      },
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    expect(vi.getTimerCount()).toBe(1);

    provider.streams[0]!.handlers.onClose();
    expect(feed.getState().status).toBe('destroyed');
    expect(vi.getTimerCount()).toBe(0);
  });
  test('stops notifications after an update observer destroys the session', async () => {
    const provider = new FakeProvider();
    const statuses: string[] = [];
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'update') feed.destroy();
      },
      onState(state) {
        statuses.push(state.status);
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: false });
    await loading;

    provider.streams[0]!.handlers.onBar(bar(2, 1));
    expect(statuses.filter((status) => status === 'destroyed')).toHaveLength(1);
  });

  test('sets hasMore false when a live append fills maxBars', async () => {
    const { provider, feed } = setup(new FakeProvider(), { maxBars: 2 });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: false });
    await loading;

    provider.streams[0]!.handlers.onBar(bar(2, 1));
    expect(feed.getState()).toMatchObject({ bars: 2, hasMore: false });
    feed.destroy();
  });

  test('keeps a healthy stream usable after a permanent backfill transport failure', async () => {
    const { provider, feed } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    provider.history[1]!.result.reject({
      code: 'BAD_REQUEST',
      message: 'page rejected',
      retryable: false,
    } satisfies FeedFailure);
    await paging;
    expect(feed.getState()).toMatchObject({
      status: 'live',
      loadingMore: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(provider.streams[0]!.unsubscribed).toBe(false);

    const retriedPage = feed.loadMore();
    expect(provider.history).toHaveLength(3);
    provider.history[2]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await retriedPage;
    feed.destroy();
  });

  test('does not create a cooldown timer after a retry observer destroys the session', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    let destroyOnLoading = false;
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange() {},
      onState(state) {
        if (destroyOnLoading && state.status === 'loading') feed.destroy();
      },
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onError({
      code: 'RATE_LIMIT',
      message: 'wait',
      retryable: true,
      retryAfterMs: 50,
    });
    destroyOnLoading = true;

    await feed.retry();
    expect(feed.getState().status).toBe('destroyed');
    expect(vi.getTimerCount()).toBe(0);
  });
  test('filters overlapping backfill rows before applying remaining capacity', async () => {
    const { provider, feed } = setup(new FakeProvider(), { maxBars: 3 });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    provider.streams[0]!.handlers.onBar(bar(60, 10, 10));
    provider.history[1]!.result.resolve({
      bars: [bar(30, 1), bar(60, 1)],
      exhausted: true,
    });
    await paging;

    expect(feed.getData()).toEqual([bar(30, 1), bar(60, 10, 10), bar(120, 1)]);
    expect(feed.getState()).toMatchObject({ bars: 3, hasMore: false });
    feed.destroy();
  });

  test('keeps the newest unseen older bar without raising high-water for an overlapping row', async () => {
    const { provider, feed } = setup(new FakeProvider(), { maxBars: 3 });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    provider.streams[0]!.handlers.onBar(bar(60, 10, 10));
    provider.history[1]!.result.resolve({
      bars: [bar(10, 1), bar(30, 1), bar(60, 99, 99)],
      exhausted: false,
    });
    await paging;
    provider.streams[0]!.handlers.onBar(bar(60, 11, 11));

    expect(feed.getData()).toEqual([bar(30, 1), bar(60, 11, 11), bar(120, 1)]);
    expect(feed.getState()).toMatchObject({ bars: 3, hasMore: false });
    feed.destroy();
  });

  test('rejects an invalid backfill page without changing loaded bars', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(120, 1)], exhausted: false });
    await loading;

    const paging = feed.loadMore();
    provider.history[1]!.result.resolve({ bars: [bar(60, 1), bar(30, 1)], exhausted: true });
    await paging;

    expect(feed.getData()).toEqual([bar(120, 1)]);
    expect(feed.getState()).toMatchObject({ status: 'error', error: { code: 'INVALID_HISTORY' } });
    expect(changes.filter((change) => change.type === 'reset' && change.reason === 'backfill')).toHaveLength(
      0,
    );
    feed.destroy();
  });

  test('stops after a fresh-reset observer destroys the session', async () => {
    const provider = new FakeProvider();
    const statuses: string[] = [];
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'reset' && change.bars.length === 0) feed.destroy();
      },
      onState(state) {
        statuses.push(state.status);
      },
    });

    await feed.load(btc);
    expect(statuses.filter((status) => status === 'destroyed')).toHaveLength(1);
    expect(provider.streams).toHaveLength(0);
  });

  test('stops after a reconciliation-reset observer destroys the session', async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    const statuses: string[] = [];
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'reset' && change.bars.length > 0) feed.destroy();
      },
      onState(state) {
        statuses.push(state.status);
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;

    expect(statuses.filter((status) => status === 'destroyed')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stops after a backfill-reset observer destroys the session', async () => {
    const provider = new FakeProvider();
    const statuses: string[] = [];
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'reset' && change.reason === 'backfill') feed.destroy();
      },
      onState(state) {
        statuses.push(state.status);
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await loading;
    const paging = feed.loadMore();
    provider.history[1]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await paging;

    expect(statuses.filter((status) => status === 'destroyed')).toHaveLength(1);
  });

  test('stops after a correction-reset observer destroys the session', async () => {
    const provider = new FakeProvider();
    const statuses: string[] = [];
    let feed!: ReturnType<typeof createFeedSession>;
    feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'reset' && change.reason === 'correction') feed.destroy();
      },
      onState(state) {
        statuses.push(state.status);
      },
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    feed.applyCorrections([bar(1, 2)]);

    expect(statuses.filter((status) => status === 'destroyed')).toHaveLength(1);
  });
  test('settles empty initial history as live and exhausted', async () => {
    const { provider, feed } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [], exhausted: true });
    await loading;
    expect(feed.getData()).toEqual([]);
    expect(feed.getState()).toMatchObject({ status: 'live', hasMore: false });
    feed.destroy();
  });

  test('rejects malformed history atomically and reports a permanent error', async () => {
    const { provider, feed, changes } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({
      bars: [bar(2, 1), bar(1, 1)],
      exhausted: true,
    });
    await loading;

    expect(feed.getData()).toEqual([]);
    expect(feed.getState()).toMatchObject({ status: 'error', error: { code: 'INVALID_HISTORY' } });
    expect(changes).toHaveLength(1);
  });

  test('isolates callback and snapshot mutation from owned data', async () => {
    const provider = new FakeProvider();
    const feed = createFeedSession({
      provider,
      onChange(change) {
        if (change.type === 'reset') {
          (change.bars as MarketBar[]).splice(0);
        } else {
          change.bar.close = -100;
        }
        throw new Error('observer failure');
      },
      onState(state) {
        if (state.query) state.query.symbol = 'MUTATED';
        if (state.error) state.error.message = 'MUTATED';
        throw new Error('observer failure');
      },
    });
    const query = { ...btc };
    const loading = feed.load(query);
    query.symbol = 'MUTATED';
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    const snapshot = feed.getData() as MarketBar[];
    snapshot[0]!.close = -1;
    snapshot.push(bar(2, 2));
    const state = feed.getState();
    state.query!.symbol = 'MUTATED';

    provider.streams[0]!.handlers.onBar(bar(1, 2, 20));
    expect(feed.getData()).toEqual([bar(1, 2, 20)]);
    expect(feed.getState().query).toEqual(btc);
    feed.destroy();
  });

  test.each([
    ['provider maxPageSize', { providerMax: 0 }],
    ['fractional maxBars', { maxBars: 1.5 }],
    ['zero maxBufferedBars', { maxBufferedBars: 0 }],
    ['oversized maxRecoveryPages', { maxRecoveryPages: 1001 }],
    ['negative maxRetries', { maxRetries: -1 }],
    ['zero requestTimeoutMs', { requestTimeoutMs: 0 }],
    ['initialLimit above provider maximum', { initialLimit: 11 }],
    ['reconnect base above maximum', { reconnectBaseMs: 20, reconnectMaxMs: 10 }],
  ])('rejects invalid options before provider side effects: %s', (_name, values) => {
    const { providerMax = 10, ...options } = values as Record<string, number> & {
      providerMax?: number;
    };
    const provider = new FakeProvider('monotonic', providerMax);
    expect(() => createFeedSession({ provider, onChange() {}, ...options })).toThrowError(/INVALID_OPTIONS/);
    expect(provider.history).toHaveLength(0);
    expect(provider.streams).toHaveLength(0);
  });

  test('enforces buffer and live capacity bounds as explicit permanent errors', async () => {
    const buffered = setup(new FakeProvider(), { maxBars: 2, maxBufferedBars: 1 });
    const loading = buffered.feed.load(btc);
    buffered.provider.streams[0]!.handlers.onBar(bar(1, 1));
    buffered.provider.streams[0]!.handlers.onBar(bar(2, 1));
    await loading;
    expect(buffered.feed.getState()).toMatchObject({
      status: 'error',
      error: { code: 'BUFFER_LIMIT', retryable: false },
    });
    expect(buffered.provider.streams[0]!.unsubscribed).toBe(true);

    const live = setup(new FakeProvider(), { maxBars: 1 });
    const loaded = live.feed.load(btc);
    live.provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loaded;
    live.provider.streams[0]!.handlers.onBar(bar(2, 1));
    expect(live.feed.getState()).toMatchObject({
      status: 'error',
      error: { code: 'LIMIT', retryable: false },
    });
  });

  test('fails bounded recovery that cannot prove exhaustion', async () => {
    vi.useFakeTimers();
    const { provider, feed } = setup(new FakeProvider(), {
      pageSize: 1,
      maxRecoveryPages: 1,
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await loading;
    provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    provider.history[1]!.result.resolve({ bars: [bar(1, 2)], exhausted: false });
    await vi.runAllTimersAsync();
    expect(feed.getState()).toMatchObject({
      status: 'error',
      error: { code: 'RECOVERY_LIMIT', retryable: false },
    });
  });

  test('destroy synchronously clears a pending history timeout', async () => {
    vi.useFakeTimers();
    const { feed } = setup(new FakeProvider(), { requestTimeoutMs: 100 });
    const loading = feed.load(btc);
    expect(vi.getTimerCount()).toBe(1);
    feed.destroy();
    expect(vi.getTimerCount()).toBe(0);
    await loading;
  });
  test('destroy settles pending work and rejects later calls', async () => {
    const initial = setup();
    const initialLoad = initial.feed.load(btc);
    initial.feed.destroy();
    await initialLoad;
    initial.provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    initial.provider.streams[0]!.handlers.onBar(bar(2, 2));
    expect(initial.feed.getState().status).toBe('destroyed');
    expect(() => initial.feed.getData()).toThrowError(/DESTROYED/);
    await expect(initial.feed.load(btc)).rejects.toThrowError(/DESTROYED/);
    await expect(initial.feed.load({ symbol: '', interval: '' })).rejects.toThrowError(/DESTROYED/);
    expect(() => initial.feed.destroy()).not.toThrow();

    const paging = setup();
    const loaded = paging.feed.load(btc);
    paging.provider.history[0]!.result.resolve({ bars: [bar(2, 1)], exhausted: false });
    await loaded;
    const loadMore = paging.feed.loadMore();
    paging.feed.destroy();
    await loadMore;
    expect(paging.provider.history[1]!.signal.aborted).toBe(true);

    vi.useFakeTimers();
    const recovery = setup(new FakeProvider(), { reconnectBaseMs: 1, reconnectMaxMs: 1 });
    const recoveryLoad = recovery.feed.load(btc);
    recovery.provider.history[0]!.result.resolve({ bars: [bar(1, 1)], exhausted: true });
    await recoveryLoad;
    recovery.provider.streams[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(1);
    recovery.feed.destroy();
    expect(recovery.provider.history[1]!.signal.aborted).toBe(true);
  });
});

describe('indexed exact bar lookup', () => {
  test('returns defensive copies of live updates and corrections, and null after reload', async () => {
    const { provider, feed } = setup();
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({ bars: [bar(1, 1), bar(2, 2)], exhausted: true });
    await loading;
    expect(feed.getBar(3)).toBeNull();
    const first = feed.getBar(1)!;
    first.close = 999;
    expect(feed.getBar(1)?.close).toBe(1);
    provider.streams[0]!.handlers.onBar(bar(1, 3));
    expect(feed.getBar(1)?.close).toBe(3);
    feed.applyCorrections([bar(1, 4)]);
    expect(feed.getBar(1)?.close).toBe(4);
    const next = feed.load({ symbol: 'ETHUSDT', interval: '1m' });
    expect(feed.getBar(1)).toBeNull();
    provider.history[1]!.result.resolve({ bars: [bar(5, 5)], exhausted: true });
    await next;
    expect(feed.getBar(5)?.time).toBe(5);
    feed.destroy();
    expect(() => feed.getBar(5)).toThrow();
  });
  test('rejects invalid lookup time and finds endpoints in a large sorted set', async () => {
    const { provider, feed } = setup(new FakeProvider('monotonic', 10000), {
      initialLimit: 8192,
      maxBars: 20000,
    });
    const loading = feed.load(btc);
    provider.history[0]!.result.resolve({
      bars: Array.from({ length: 8192 }, (_, i) => bar(i + 1, 1)),
      exhausted: true,
    });
    await loading;
    expect(feed.getBar(1)?.time).toBe(1);
    expect(feed.getBar(8192)?.time).toBe(8192);
    expect(feed.getBar(0)).toBeNull();
    expect(feed.getBar(Number.NaN)).toBeNull();
    feed.destroy();
  });
});
