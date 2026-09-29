import type {
  FeedFailure,
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from './types';

export const BINANCE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

const DEFAULT_REST_URL = 'https://data-api.binance.vision';
const DEFAULT_STREAM_URL = 'wss://data-stream.binance.vision';
const SYMBOL_PATTERN = /^[A-Z0-9]{3,20}$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_PATTERN = /^\d+$/;

type BinanceResponse = Response & { json(): Promise<unknown> };
type FetchLike = typeof globalThis.fetch;
type WebSocketFactory = (url: string) => WebSocket;

class BinanceFeedError extends Error implements FeedFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = 'BinanceFeedError';
    this.code = code;
    this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function failure(code: string, message: string, retryable: boolean, retryAfterMs?: number): BinanceFeedError {
  return new BinanceFeedError(code, message, retryable, retryAfterMs);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function validateSymbol(symbol: string): void {
  if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) {
    throw failure('INVALID_QUERY', 'Symbol must contain only 3–20 uppercase letters or digits.', false);
  }
}

function validateInterval(interval: string): void {
  if (typeof interval !== 'string' || !(BINANCE_INTERVALS as readonly string[]).includes(interval)) {
    throw failure('INVALID_QUERY', `Unsupported Binance interval: ${String(interval)}`, false);
  }
}

function validateTime(value: unknown, label: string): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!INTEGER_PATTERN.test(text))
    throw failure('MALFORMED_HISTORY', `${label} must be an integer UTC millisecond value.`, false);
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw failure('MALFORMED_HISTORY', `${label} is outside the safe integer range.`, false);
  }
  return result;
}

function parseDecimal(value: unknown, label: string, allowZero = true): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!text || !DECIMAL_PATTERN.test(text))
    throw failure('MALFORMED_HISTORY', `${label} must be a decimal number.`, false);
  const result = Number(text);
  if (!Number.isFinite(result) || (!allowZero && result <= 0) || result < 0) {
    throw failure('MALFORMED_HISTORY', `${label} must be a finite nonnegative number.`, false);
  }
  return result;
}

function parseRevision(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!INTEGER_PATTERN.test(text))
    throw failure('MALFORMED_HISTORY', 'Trade count must be a nonnegative integer.', false);
  const result = Number(text);
  if (!Number.isSafeInteger(result))
    throw failure('MALFORMED_HISTORY', 'Trade count is outside the safe integer range.', false);
  return result;
}

function parseBar(row: unknown, source: 'history' | 'stream'): MarketBar {
  try {
    if (!Array.isArray(row) || row.length < 9) {
      throw failure(
        source === 'history' ? 'MALFORMED_HISTORY' : 'MALFORMED_STREAM',
        'Kline payload is incomplete.',
        false,
      );
    }
    const time = validateTime(row[0], 'Open time');
    const open = parseDecimal(row[1], 'Open price');
    const high = parseDecimal(row[2], 'High price');
    const low = parseDecimal(row[3], 'Low price');
    const close = parseDecimal(row[4], 'Close price');
    const volume = parseDecimal(row[5], 'Volume');
    const revision = parseRevision(row[8]);
    if (high < low || high < open || high < close || low > open || low > close) {
      throw failure(
        source === 'history' ? 'MALFORMED_HISTORY' : 'MALFORMED_STREAM',
        'OHLC values are inconsistent.',
        false,
      );
    }
    return { time, open, high, low, close, volume, revision };
  } catch (error) {
    if (source === 'stream' && error instanceof BinanceFeedError && error.code === 'MALFORMED_HISTORY') {
      throw failure('MALFORMED_STREAM', error.message, false);
    }
    throw error;
  }
}

function streamBar(payload: Record<string, unknown>, symbol: string, interval: string): MarketBar {
  const kline = payload.k;
  if (!kline || typeof kline !== 'object' || Array.isArray(kline)) {
    throw failure('MALFORMED_STREAM', 'Matching kline event has no kline object.', false);
  }
  const k = kline as Record<string, unknown>;
  if (k.s !== undefined && k.s !== symbol) {
    throw failure('MALFORMED_STREAM', 'Matching kline symbol is inconsistent.', false);
  }
  if (k.i !== interval) {
    throw failure('MALFORMED_STREAM', 'Matching kline interval is inconsistent.', false);
  }
  return parseBar([k.t, k.o, k.h, k.l, k.c, k.v, undefined, undefined, k.n], 'stream');
}

function endpoint(base: string, path: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    throw failure('INVALID_CONFIG', `Invalid Binance endpoint: ${base}`, false);
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'msg' in body && typeof body.msg === 'string') return body.msg;
  return fallback;
}

function callback<T extends (...args: never[]) => void>(fn: T, ...args: Parameters<T>): void {
  try {
    fn(...args);
  } catch {
    // Consumer exceptions must not break transport cleanup or delivery.
  }
}

export function createBinanceProvider(
  options: {
    restUrl?: string;
    streamUrl?: string;
    fetch?: FetchLike;
    webSocketFactory?: WebSocketFactory;
  } = {},
): MarketDataProvider {
  let cooldownUntil = 0;
  const restUrl = options.restUrl ?? DEFAULT_REST_URL;
  const streamUrl = options.streamUrl ?? DEFAULT_STREAM_URL;

  const getHistory = async (request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage> => {
    validateSymbol(request.symbol);
    validateInterval(request.interval);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw failure('INVALID_QUERY', 'History limit must be an integer from 1 through 1000.', false);
    }
    if (request.before !== undefined && request.from !== undefined) {
      throw failure('INVALID_QUERY', 'History request cannot contain both before and from.', false);
    }
    if (signal.aborted) throw abortError();
    const before = request.before === undefined ? undefined : validateTime(request.before, 'before');
    const from = request.from === undefined ? undefined : validateTime(request.from, 'from');
    if (before === 0) throw failure('INVALID_QUERY', 'before must be greater than zero.', false);
    if (Date.now() < cooldownUntil) {
      throw failure('COOLDOWN', 'Binance rate-limit cooldown is active.', true, cooldownUntil - Date.now());
    }
    const url = new URL(endpoint(restUrl, '/api/v3/klines'));
    url.searchParams.set('symbol', request.symbol);
    url.searchParams.set('interval', request.interval);
    url.searchParams.set('limit', String(request.limit));
    if (before !== undefined) url.searchParams.set('endTime', String(before - 1));
    if (from !== undefined) url.searchParams.set('startTime', String(from));

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function')
      throw failure('CONFIG_ERROR', 'Fetch is unavailable in this environment.', false);
    let result: BinanceResponse;
    try {
      result = (await fetchImpl(url.toString(), { method: 'GET', signal })) as BinanceResponse;
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw failure(
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Binance request failed.',
        true,
      );
    }
    if (result.status === 429 || result.status === 418) {
      const retryMs = retryAfterMs(result.headers);
      if (retryMs !== undefined) cooldownUntil = Math.max(cooldownUntil, Date.now() + retryMs);
      let body: unknown;
      try {
        body = await result.json();
      } catch {
        body = undefined;
      }
      throw failure('RATE_LIMIT', messageFromBody(body, `Binance HTTP ${result.status}`), true, retryMs);
    }
    if (!result.ok) {
      let body: unknown;
      try {
        body = await result.json();
      } catch {
        body = undefined;
      }
      throw failure(
        'HTTP_ERROR',
        messageFromBody(body, `Binance HTTP ${result.status}`),
        result.status >= 500,
      );
    }
    let body: unknown;
    try {
      body = await result.json();
    } catch {
      throw failure('MALFORMED_HISTORY', 'Binance returned invalid JSON.', false);
    }
    if (!Array.isArray(body))
      throw failure('MALFORMED_HISTORY', 'Binance history response is not an array.', false);
    const bars = body.map((row) => parseBar(row, 'history'));
    for (let index = 1; index < bars.length; index += 1) {
      const previous = bars[index - 1];
      const current = bars[index];
      if (!previous || !current || current.time <= previous.time) {
        throw failure('MALFORMED_HISTORY', 'History bars must be strictly increasing and unique.', false);
      }
    }
    if (before !== undefined && bars.some((bar) => bar.time >= before)) {
      throw failure('MALFORMED_HISTORY', 'History bars violate the exclusive before boundary.', false);
    }
    if (from !== undefined && bars.some((bar) => bar.time < from)) {
      throw failure('MALFORMED_HISTORY', 'History bars violate the inclusive from boundary.', false);
    }
    return { bars, exhausted: bars.length < request.limit };
  };

  const subscribe = (query: MarketQuery, handlers: MarketStreamHandlers): (() => void) => {
    validateSymbol(query.symbol);
    validateInterval(query.interval);
    const factory =
      options.webSocketFactory ??
      ((url: string) => {
        if (typeof globalThis.WebSocket !== 'function')
          throw failure('CONFIG_ERROR', 'WebSocket is unavailable in this environment.', false);
        return new globalThis.WebSocket(url);
      });
    const url = endpoint(streamUrl, `/ws/${query.symbol.toLowerCase()}@kline_${query.interval}`);
    let socket: WebSocket | undefined;
    let closed = false;
    let closeDelivered = false;
    let transportErrorDelivered = false;
    const detach = () => {
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    };
    const onClose = () => {
      if (closeDelivered) return;
      closeDelivered = true;
      closed = true;
      detach();
      callback(handlers.onClose);
    };
    const onError = (error: FeedFailure) => {
      if (
        closed ||
        (transportErrorDelivered && (error.code === 'STREAM_ERROR' || error.code === 'SERVER_SHUTDOWN'))
      )
        return;
      if (error.code === 'STREAM_ERROR' || error.code === 'SERVER_SHUTDOWN') transportErrorDelivered = true;
      callback(handlers.onError, {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      });
    };
    const closeTransport = () => {
      if (closed) return;
      detach();
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      onClose();
    };
    try {
      socket = factory(url);
    } catch (error) {
      onError(
        error instanceof BinanceFeedError
          ? error
          : failure('CONFIG_ERROR', 'Unable to create WebSocket.', false),
      );
      onClose();
      return () => undefined;
    }
    socket.onopen = () => {
      if (!closed) callback(handlers.onOpen);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (closed) return;
      let payload: unknown;
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        onError(failure('MALFORMED_STREAM', 'Binance sent invalid JSON.', false));
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        onError(failure('MALFORMED_STREAM', 'Binance sent an invalid stream event.', false));
        return;
      }
      const eventPayload = payload as Record<string, unknown>;
      if (eventPayload.e === 'serverShutdown') {
        onError(failure('SERVER_SHUTDOWN', 'Binance requested server shutdown.', true));
        closeTransport();
        return;
      }
      if (eventPayload.e !== 'kline') return;
      if (eventPayload.s !== query.symbol) return;
      const klinePayload = eventPayload.k;
      if (!klinePayload || typeof klinePayload !== 'object' || Array.isArray(klinePayload)) {
        onError(failure('MALFORMED_STREAM', 'Matching kline event has no kline object.', false));
        return;
      }
      const interval = (klinePayload as Record<string, unknown>).i;
      if (interval === undefined) {
        onError(failure('MALFORMED_STREAM', 'Matching kline event has no interval.', false));
        return;
      }
      if (interval !== query.interval) return;
      try {
        callback(handlers.onBar, streamBar(eventPayload, query.symbol, query.interval));
      } catch (error) {
        onError(
          error instanceof BinanceFeedError
            ? error
            : failure('MALFORMED_STREAM', 'Matching stream candle is invalid.', false),
        );
      }
    };
    socket.onerror = () => {
      onError(failure('STREAM_ERROR', 'Binance WebSocket failed.', true));
      closeTransport();
    };
    socket.onclose = () => onClose();
    return () => {
      if (closed) {
        detach();
        return;
      }
      closed = true;
      detach();
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    };
  };

  return { id: 'binance', revisionMode: 'monotonic', maxPageSize: 1000, getHistory, subscribe };
}
