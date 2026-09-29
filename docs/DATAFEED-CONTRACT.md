# FILTIX Datafeed v0.2 contract

Governing [spec](../SOURCE-DISTRIBUTION.md#omitted-development-materials). Public exports are additive and optional.

```ts
interface MarketQuery {
  symbol: string;
  interval: string;
}
interface MarketBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  revision?: number;
}
interface FeedFailure {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
interface HistoryRequest extends MarketQuery {
  limit: number;
  before?: number;
  from?: number;
}
interface HistoryPage {
  bars: readonly MarketBar[];
  exhausted: boolean;
}
interface MarketStreamHandlers {
  onOpen(): void;
  onBar(bar: MarketBar): void;
  onError(error: FeedFailure): void;
  onClose(): void;
}
interface MarketDataProvider {
  readonly id: string;
  readonly revisionMode: 'monotonic' | 'arrival';
  readonly maxPageSize: number;
  getHistory(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage>;
  subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void;
}
type FeedStatus = 'idle' | 'loading' | 'live' | 'stale' | 'reconnecting' | 'error' | 'destroyed';
interface FeedState {
  status: FeedStatus;
  query: MarketQuery | null;
  bars: number;
  loadingMore: boolean;
  hasMore: boolean;
  lastUpdateAt: number | null;
  retryCount: number;
  error: FeedFailure | null;
}
type FeedChange =
  | { type: 'reset'; bars: readonly MarketBar[]; reason: 'initial' | 'backfill' | 'reconnect' | 'correction' }
  | { type: 'update'; bar: MarketBar };
interface FeedSessionOptions {
  provider: MarketDataProvider;
  onChange(change: FeedChange): void;
  onState?(state: FeedState): void;
  initialLimit?: number;
  pageSize?: number;
  maxBars?: number;
  maxBufferedBars?: number;
  maxRecoveryPages?: number;
  staleAfterMs?: number;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxRetries?: number;
}
interface FeedSession {
  load(query: MarketQuery): Promise<void>;
  loadMore(): Promise<void>;
  retry(): Promise<void>;
  applyCorrections(bars: readonly MarketBar[]): void;
  getData(): readonly MarketBar[];
  getState(): FeedState;
  destroy(): void;
}
function createFeedSession(options: FeedSessionOptions): FeedSession;
interface BinanceProviderOptions {
  restUrl?: string;
  streamUrl?: string;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string) => WebSocket;
}
function createBinanceProvider(options?: BinanceProviderOptions): MarketDataProvider;
const BINANCE_INTERVALS: readonly string[];
```

Session methods reject invalid programmer input synchronously (applyCorrections) or through their returned Promise (load). Operational network failures are reported in FeedState and settle load/loadMore/retry without unhandled rejection. getData/getState are snapshots. Calls after destroy except repeated destroy/getState fail with DESTROYED (Promise rejection for asynchronous methods, throw for synchronous methods). A load emits an empty reset for the new query before history arrives, so prior instrument data cannot masquerade as the new instrument.

The adapter rejects failed history Promises with Error objects carrying FeedFailure fields. Stream callbacks use plain copied FeedFailure envelopes. No callbacks or requests occur on module import or factory construction.
