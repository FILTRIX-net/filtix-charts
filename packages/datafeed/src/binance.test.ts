import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BINANCE_INTERVALS, createBinanceProvider } from './binance';

type FetchCall = { url: string; init?: RequestInit };

const kline = (time: number, revision = 7) => [
  time,
  '10.00',
  '12.00',
  '9.00',
  '11.00',
  '3.50',
  time + 59_999,
  '40.00',
  revision,
  '1.00',
  '2.00',
  '20.00',
];

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as Response;
}

class SocketFixture {
  static latest: SocketFixture | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly url: string;
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    SocketFixture.latest = this;
  }

  close() {
    this.closeCalls += 1;
  }

  open() {
    this.onopen?.(new Event('open'));
  }

  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
  }

  error() {
    this.onerror?.(new Event('error'));
  }

  closeEvent() {
    this.onclose?.({} as CloseEvent);
  }
}

beforeEach(() => {
  SocketFixture.latest = undefined;
});

describe('createBinanceProvider', () => {
  it('exposes the bounded monotonic public provider', () => {
    const provider = createBinanceProvider();
    expect(provider.id).toBe('binance');
    expect(provider.revisionMode).toBe('monotonic');
    expect(provider.maxPageSize).toBe(1000);
    expect(BINANCE_INTERVALS).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });

  it('builds exact public REST parameters and maps the Binance kline tuple', async () => {
    const calls: FetchCall[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return response([kline(60_000, 42), kline(90_000, 43)]);
    });
    const provider = createBinanceProvider({
      restUrl: 'https://rest.test',
      fetch: fetch as typeof globalThis.fetch,
    });
    const page = await provider.getHistory(
      { symbol: 'BTCUSDT', interval: '1m', before: 120_000, limit: 2 },
      new AbortController().signal,
    );

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v3/klines');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: 'BTCUSDT',
      interval: '1m',
      limit: '2',
      endTime: '119999',
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect((page.bars[0] as { time: number }).time).toBe(60_000);
    expect(page.bars[0]).toMatchObject({ open: 10, high: 12, low: 9, close: 11, volume: 3.5, revision: 42 });
    expect(page.exhausted).toBe(false);
  });

  it('maps an inclusive from cursor and marks a short page exhausted', async () => {
    let called = '';
    const fetch = vi.fn(async (url: string) => {
      called = url;
      return response([kline(60_000)]);
    });
    const provider = createBinanceProvider({
      restUrl: 'https://rest.test/',
      fetch: fetch as typeof globalThis.fetch,
    });
    const page = await provider.getHistory(
      { symbol: 'ETHUSDT', interval: '5m', from: 60_000, limit: 2 },
      new AbortController().signal,
    );
    expect(new URL(called).searchParams.get('startTime')).toBe('60000');
    expect(new URL(called).searchParams.has('endTime')).toBe(false);
    expect(page.exhausted).toBe(true);
  });

  it('forwards AbortSignal to fetch and does not issue an aborted request', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => response([]));
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    const controller = new AbortController();
    await provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, controller.signal);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, aborted.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid query parameters before calling fetch', async () => {
    const fetch = vi.fn(async (_url: string) => response([]));
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    const signal = new AbortController().signal;
    await expect(
      provider.getHistory({ symbol: 'btc/usdt', interval: '1m', limit: 1 }, signal),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '2m', limit: 1 }, signal),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1001 }, signal),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1, from: 1, before: 2 }, signal),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'empty price',
      () => {
        const row = kline(0);
        row[1] = '';
        return row;
      },
    ],
    [
      'nonnumeric price',
      () => {
        const row = kline(0);
        row[1] = 'wat';
        return row;
      },
    ],
    [
      'infinite price',
      () => {
        const row = kline(0);
        row[1] = 'Infinity';
        return row;
      },
    ],
    [
      'invalid time',
      () => {
        const row = kline(0);
        row[0] = 1.5;
        return row;
      },
    ],
    [
      'invalid trade revision',
      () => {
        const row = kline(0);
        row[8] = -1;
        return row;
      },
    ],
    [
      'invalid OHLC ordering',
      () => {
        const row = kline(0);
        row[2] = '8';
        return row;
      },
    ],
  ])('rejects %s in a REST kline', async (_name, makeRow) => {
    const fetch = vi.fn(async (_url: string) => response([makeRow()]));
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'MALFORMED_HISTORY',
      retryable: false,
    });
  });

  it('rejects non-increasing and boundary-violating history pages atomically', async () => {
    const fetch = vi.fn(async (_url: string) => response([kline(120_000), kline(60_000)]));
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 2 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MALFORMED_HISTORY' });

    fetch.mockResolvedValue(response([kline(60_000)]));
    await expect(
      provider.getHistory(
        { symbol: 'BTCUSDT', interval: '1m', before: 60_000, limit: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_HISTORY' });
  });

  it('enters Retry-After cooldown for rate limits and rejects during cooldown without fetching', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string) =>
      response({ code: -1003, msg: 'too many requests' }, 429, { 'Retry-After': '3' }),
    );
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    const signal = new AbortController().signal;
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, signal),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true, retryAfterMs: 3000 });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, signal),
    ).rejects.toMatchObject({ code: 'COOLDOWN', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, signal),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each([400, 401, 403])('does not mark permanent HTTP %s as retryable', async (status) => {
    const fetch = vi.fn(async (_url: string) => response({ msg: 'bad request' }, status));
    const provider = createBinanceProvider({ fetch: fetch as typeof globalThis.fetch });
    await expect(
      provider.getHistory({ symbol: 'BTCUSDT', interval: '1m', limit: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', retryable: false });
  });

  it('creates no transport at factory time and subscribes to the exact lowercase stream', () => {
    const factory = vi.fn((url: string) => new SocketFixture(url) as unknown as WebSocket);
    const provider = createBinanceProvider({ streamUrl: 'wss://stream.test/', webSocketFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const onOpen = vi.fn();
    const unsubscribe = provider.subscribe(
      { symbol: 'BTCUSDT', interval: '1m' },
      {
        onOpen,
        onBar: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
      },
    );
    expect(factory).toHaveBeenCalledWith('wss://stream.test/ws/btcusdt@kline_1m');
    SocketFixture.latest?.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('filters unrelated stream events and emits a validated matching candle', () => {
    const onBar = vi.fn();
    const onError = vi.fn();
    const provider = createBinanceProvider({
      webSocketFactory: (url) => new SocketFixture(url) as unknown as WebSocket,
    });
    provider.subscribe(
      { symbol: 'BTCUSDT', interval: '1m' },
      { onOpen: vi.fn(), onBar, onError, onClose: vi.fn() },
    );
    const socket = SocketFixture.latest;
    socket?.message({ e: 'trade', s: 'BTCUSDT' });
    socket?.message({ e: 'kline', s: 'ETHUSDT', k: { i: '1m' } });
    socket?.message({
      e: 'kline',
      s: 'BTCUSDT',
      k: {
        ...kline(60_000).reduce<Record<string, unknown>>((o, v, i) => ((o[String(i)] = v), o), {}),
        i: '1m',
        t: 60_000,
        o: '10',
        h: '12',
        l: '9',
        c: '11',
        v: '3.5',
        n: 9,
      },
    });
    expect(onBar).toHaveBeenCalledTimes(1);
    expect(onBar.mock.calls[0]?.[0]).toMatchObject({ time: 60_000, revision: 9, close: 11 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports malformed matching stream candles and server shutdown once', () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const provider = createBinanceProvider({
      webSocketFactory: (url) => new SocketFixture(url) as unknown as WebSocket,
    });
    provider.subscribe(
      { symbol: 'BTCUSDT', interval: '1m' },
      { onOpen: vi.fn(), onBar: vi.fn(), onError, onClose },
    );
    const socket = SocketFixture.latest;
    socket?.message({
      e: 'kline',
      s: 'BTCUSDT',
      k: { i: '1m', t: 60_000, o: '', h: '12', l: '9', c: '11', v: '3', n: 9 },
    });
    socket?.message({
      e: 'kline',
      s: 'BTCUSDT',
      k: { t: 60_000, o: '10', h: '12', l: '9', c: '11', v: '3', n: 9 },
    });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MALFORMED_STREAM', retryable: false }),
    );
    socket?.message({ e: 'serverShutdown' });
    socket?.closeEvent();
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[2]?.[0]).toMatchObject({ code: 'SERVER_SHUTDOWN', retryable: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes listeners before closing so callbacks cannot arrive after unsubscribe', () => {
    const onOpen = vi.fn();
    const onBar = vi.fn();
    const onClose = vi.fn();
    const provider = createBinanceProvider({
      webSocketFactory: (url) => new SocketFixture(url) as unknown as WebSocket,
    });
    const unsubscribe = provider.subscribe(
      { symbol: 'BTCUSDT', interval: '1m' },
      { onOpen, onBar, onError: vi.fn(), onClose },
    );
    const socket = SocketFixture.latest;
    unsubscribe();
    socket?.open();
    socket?.message({
      e: 'kline',
      s: 'BTCUSDT',
      k: { i: '1m', t: 60_000, o: '10', h: '12', l: '9', c: '11', v: '3', n: 9 },
    });
    socket?.closeEvent();
    expect(socket?.closeCalls).toBe(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onBar).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('detaches listeners before fatal transport close and keeps them detached on later unsubscribe', () => {
    const handlers = { onOpen: vi.fn(), onBar: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
    const provider = createBinanceProvider({
      webSocketFactory: (url) => new SocketFixture(url) as unknown as WebSocket,
    });
    const unsubscribe = provider.subscribe({ symbol: 'BTCUSDT', interval: '1m' }, handlers);
    const socket = SocketFixture.latest;
    socket?.error();
    expect(socket?.onopen).toBeNull();
    expect(socket?.onmessage).toBeNull();
    expect(socket?.onerror).toBeNull();
    expect(socket?.onclose).toBeNull();
    unsubscribe();
    expect(socket?.closeCalls).toBe(1);
  });

  it('detaches listeners after a natural socket close before unsubscribe', () => {
    const handlers = { onOpen: vi.fn(), onBar: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
    const provider = createBinanceProvider({
      webSocketFactory: (url) => new SocketFixture(url) as unknown as WebSocket,
    });
    const unsubscribe = provider.subscribe({ symbol: 'BTCUSDT', interval: '1m' }, handlers);
    const socket = SocketFixture.latest;
    socket?.closeEvent();
    unsubscribe();
    expect(socket?.onopen).toBeNull();
    expect(socket?.onmessage).toBeNull();
    expect(socket?.onerror).toBeNull();
    expect(socket?.onclose).toBeNull();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
