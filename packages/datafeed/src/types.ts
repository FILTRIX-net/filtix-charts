export interface MarketQuery {
  symbol: string;
  interval: string;
}
export interface MarketBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  revision?: number;
}
export interface FeedFailure {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
export interface HistoryRequest extends MarketQuery {
  limit: number;
  before?: number;
  from?: number;
}
export interface HistoryPage {
  bars: readonly MarketBar[];
  exhausted: boolean;
}
export interface MarketStreamHandlers {
  onOpen(): void;
  onBar(bar: MarketBar): void;
  onError(error: FeedFailure): void;
  onClose(): void;
}
export interface MarketDataProvider {
  readonly id: string;
  readonly revisionMode: 'monotonic' | 'arrival';
  readonly maxPageSize: number;
  getHistory(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPage>;
  subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void;
}
export type FeedStatus = 'idle' | 'loading' | 'live' | 'stale' | 'reconnecting' | 'error' | 'destroyed';
export interface FeedState {
  status: FeedStatus;
  query: MarketQuery | null;
  bars: number;
  loadingMore: boolean;
  hasMore: boolean;
  lastUpdateAt: number | null;
  retryCount: number;
  error: FeedFailure | null;
}
export type FeedChange =
  | { type: 'reset'; bars: readonly MarketBar[]; reason: 'initial' | 'backfill' | 'reconnect' | 'correction' }
  | { type: 'update'; bar: MarketBar };
export interface FeedSessionOptions {
  provider: MarketDataProvider;
  onChange(change: FeedChange): void;
  onState?(state: FeedState): void;
  mode?: 'history' | 'latest';
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
export interface FeedSession {
  load(query: MarketQuery): Promise<void>;
  loadMore(): Promise<void>;
  retry(): Promise<void>;
  applyCorrections(bars: readonly MarketBar[]): void;
  getData(): readonly MarketBar[];
  getBar(time: number): MarketBar | null;
  getState(): FeedState;
  destroy(): void;
}
export interface BinanceProviderOptions {
  restUrl?: string;
  streamUrl?: string;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string) => WebSocket;
}
