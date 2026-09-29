import type {
  FeedChange,
  FeedFailure,
  FeedSession,
  FeedSessionOptions,
  FeedState,
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketQuery,
  MarketStreamHandlers,
} from './types';

const CANCELLED = Symbol('cancelled');
const MAX_TIME_MS = 86_400_000;

/** @internal Unsupported read-only diagnostic; this is not a stable application API. */
export interface FeedSessionResourceSnapshot {
  readonly destroyed: boolean;
  readonly mode: 'history' | 'latest';
  readonly query: MarketQuery | null;
  readonly status: FeedState['status'];
  readonly retainedBars: number;
  readonly bufferedBars: number;
  readonly correctionBars: number;
  readonly pendingBarEntries: number;
  readonly activeConnection: boolean;
  readonly buffering: boolean;
  readonly laneKind: 'initial' | 'backfill' | 'recovery' | null;
  readonly pendingRequest: boolean;
  readonly staleTimer: boolean;
  readonly retryTimer: boolean;
  readonly requestTimer: boolean;
}

const resourceSnapshots = new WeakMap<FeedSession, () => FeedSessionResourceSnapshot>();

/** @internal Reads actual current ownership, including a destroyed session's final snapshot. */
export function getFeedSessionResourceSnapshot(session: FeedSession): FeedSessionResourceSnapshot {
  const read = resourceSnapshots.get(session);
  if (!read) throw programmerError('INVALID_SESSION', 'Expected a session created by createFeedSession');
  return read();
}

type LaneKind = 'initial' | 'backfill' | 'recovery';
type Timer = ReturnType<typeof setTimeout>;

interface ResolvedOptions {
  mode: 'history' | 'latest';
  initialLimit: number;
  pageSize: number;
  maxBars: number;
  maxBufferedBars: number;
  maxRecoveryPages: number;
  staleAfterMs: number;
  requestTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxRetries: number;
}

interface Lane {
  id: number;
  epoch: number;
  kind: LaneKind;
  controller: AbortController | null;
  timer: Timer | null;
  cancelled: Promise<typeof CANCELLED>;
  cancel(): void;
}

interface BufferedBar {
  bar: MarketBar;
  sequence: number;
}

interface Connection {
  epoch: number;
  id: number;
  active: boolean;
  failed: boolean;
  buffering: boolean;
  buffer: Map<number, BufferedBar>;
  corrections: Map<number, BufferedBar>;
  latestCorrectionSequence: number | null;
  unsubscribe(): void;
}

class FeedException extends Error {
  readonly failure: FeedFailure;

  constructor(failure: FeedFailure) {
    super(`${failure.code}: ${failure.message}`);
    this.name = 'FeedException';
    this.failure = failure;
  }
}

function copyBar(bar: MarketBar): MarketBar {
  return { ...bar };
}

function copyFailure(failure: FeedFailure | null): FeedFailure | null {
  return failure ? { ...failure } : null;
}

function copyQuery(query: MarketQuery | null): MarketQuery | null {
  return query ? { ...query } : null;
}

function failure(code: string, message: string, retryable: boolean, retryAfterMs?: number): FeedFailure {
  return retryAfterMs === undefined
    ? { code, message, retryable }
    : { code, message, retryable, retryAfterMs };
}

function programmerError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function normalizeFailure(error: unknown, code = 'NETWORK'): FeedFailure {
  if (error instanceof FeedException) return { ...error.failure };
  if (typeof error === 'object' && error !== null) {
    const source = error as Partial<FeedFailure> & { message?: unknown };
    if (
      typeof source.code === 'string' &&
      typeof source.message === 'string' &&
      typeof source.retryable === 'boolean'
    ) {
      const retryAfterMs =
        Number.isInteger(source.retryAfterMs) && (source.retryAfterMs as number) >= 0
          ? (source.retryAfterMs as number)
          : undefined;
      return failure(source.code, source.message, source.retryable, retryAfterMs);
    }
    if (error instanceof Error) return failure(code, error.message, true);
  }
  return failure(code, String(error), true);
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw programmerError('INVALID_OPTIONS', `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function resolveOptions(options: FeedSessionOptions): ResolvedOptions {
  if (!options || typeof options !== 'object') {
    throw programmerError('INVALID_OPTIONS', 'options are required');
  }
  if (!options.provider || typeof options.provider !== 'object') {
    throw programmerError('INVALID_OPTIONS', 'provider is required');
  }
  if (typeof options.onChange !== 'function') {
    throw programmerError('INVALID_OPTIONS', 'onChange must be a function');
  }
  if (options.onState !== undefined && typeof options.onState !== 'function') {
    throw programmerError('INVALID_OPTIONS', 'onState must be a function');
  }
  if (options.provider.revisionMode !== 'monotonic' && options.provider.revisionMode !== 'arrival') {
    throw programmerError('INVALID_OPTIONS', 'provider revisionMode is invalid');
  }
  const mode = options.mode ?? 'history';
  if (mode !== 'history' && mode !== 'latest') {
    throw programmerError('INVALID_OPTIONS', 'mode must be history or latest');
  }
  if (mode === 'latest') {
    for (const name of ['initialLimit', 'pageSize', 'maxBars'] as const) {
      if (options[name] !== undefined && options[name] !== 1) {
        throw programmerError('INVALID_OPTIONS', `${name} must be 1 in latest mode`);
      }
    }
  }

  const providerLimit = boundedInteger('provider.maxPageSize', options.provider.maxPageSize, 1, 10_000);
  const maxBars = boundedInteger(
    'maxBars',
    options.maxBars ?? (mode === 'latest' ? 1 : 100_000),
    1,
    1_000_000,
  );
  const pageMaximum = Math.min(providerLimit, maxBars);
  const initialLimit = boundedInteger(
    'initialLimit',
    options.initialLimit ?? (mode === 'latest' ? 1 : Math.min(500, pageMaximum)),
    1,
    pageMaximum,
  );
  const pageSize = boundedInteger(
    'pageSize',
    options.pageSize ?? (mode === 'latest' ? 1 : Math.min(500, pageMaximum)),
    1,
    pageMaximum,
  );
  const reconnectBaseMs = boundedInteger('reconnectBaseMs', options.reconnectBaseMs ?? 1_000, 1, MAX_TIME_MS);
  const reconnectMaxMs = boundedInteger('reconnectMaxMs', options.reconnectMaxMs ?? 30_000, 1, MAX_TIME_MS);
  if (reconnectBaseMs > reconnectMaxMs) {
    throw programmerError('INVALID_OPTIONS', 'reconnectBaseMs must not exceed reconnectMaxMs');
  }

  return {
    mode,
    initialLimit,
    pageSize,
    maxBars,
    maxBufferedBars: boundedInteger('maxBufferedBars', options.maxBufferedBars ?? 2_000, 1, 100_000),
    maxRecoveryPages: boundedInteger('maxRecoveryPages', options.maxRecoveryPages ?? 100, 1, 1_000),
    staleAfterMs: boundedInteger('staleAfterMs', options.staleAfterMs ?? 15_000, 1, MAX_TIME_MS),
    requestTimeoutMs: boundedInteger('requestTimeoutMs', options.requestTimeoutMs ?? 15_000, 1, MAX_TIME_MS),
    reconnectBaseMs,
    reconnectMaxMs,
    maxRetries: boundedInteger('maxRetries', options.maxRetries ?? 5, 0, 100),
  };
}

function validateQuery(query: MarketQuery): MarketQuery {
  if (
    !query ||
    typeof query !== 'object' ||
    typeof query.symbol !== 'string' ||
    query.symbol.trim() === '' ||
    typeof query.interval !== 'string' ||
    query.interval.trim() === ''
  ) {
    throw programmerError('INVALID_QUERY', 'symbol and interval must be non-empty strings');
  }
  return { symbol: query.symbol, interval: query.interval };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateBar(bar: MarketBar, revisionMode: 'monotonic' | 'arrival'): MarketBar {
  if (!bar || typeof bar !== 'object' || !Number.isSafeInteger(bar.time)) {
    throw new FeedException(failure('INVALID_HISTORY', 'bar time must be a safe integer', false));
  }
  if (
    !isFiniteNumber(bar.open) ||
    !isFiniteNumber(bar.high) ||
    !isFiniteNumber(bar.low) ||
    !isFiniteNumber(bar.close) ||
    !isFiniteNumber(bar.volume) ||
    bar.volume < 0 ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high)
  ) {
    throw new FeedException(failure('INVALID_HISTORY', 'bar OHLCV values are invalid', false));
  }
  if (revisionMode === 'monotonic') {
    if (!Number.isSafeInteger(bar.revision) || (bar.revision as number) < 0) {
      throw new FeedException(
        failure('INVALID_HISTORY', 'monotonic provider bars require a valid revision', false),
      );
    }
  } else if (bar.revision !== undefined) {
    throw new FeedException(failure('INVALID_HISTORY', 'arrival provider bars must omit revision', false));
  }
  return copyBar(bar);
}

function validatePage(
  page: HistoryPage,
  request: HistoryRequest,
  revisionMode: 'monotonic' | 'arrival',
): MarketBar[] {
  if (!page || typeof page !== 'object' || !Array.isArray(page.bars) || typeof page.exhausted !== 'boolean') {
    throw new FeedException(failure('INVALID_HISTORY', 'history page shape is invalid', false));
  }
  const bars: MarketBar[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const input of page.bars) {
    const bar = validateBar(input, revisionMode);
    if (bar.time <= previous) {
      throw new FeedException(failure('INVALID_HISTORY', 'history bars must be strictly increasing', false));
    }
    if (request.before !== undefined && bar.time >= request.before) {
      throw new FeedException(
        failure('INVALID_HISTORY', 'history bar violates the exclusive before bound', false),
      );
    }
    if (request.from !== undefined && bar.time < request.from) {
      throw new FeedException(
        failure('INVALID_HISTORY', 'history bar violates the inclusive from bound', false),
      );
    }
    previous = bar.time;
    bars.push(bar);
  }
  if (bars.length > request.limit) {
    throw new FeedException(failure('INVALID_HISTORY', 'history page exceeds its limit', false));
  }
  return bars;
}

function findTime(bars: readonly MarketBar[], time: number): { found: boolean; index: number } {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bars[middle]!.time < time) low = middle + 1;
    else high = middle;
  }
  return { found: bars[low]?.time === time, index: low };
}

export function createFeedSession(options: FeedSessionOptions): FeedSession {
  const settings = resolveOptions(options);
  const { provider } = options;
  let destroyed = false;
  let epoch = 0;
  let nextConnectionId = 0;
  let nextLaneId = 0;
  let nextSequence = 0;
  let data: MarketBar[] = [];
  let lastKnownTime: number | null = null;
  let highWater = new Map<number, number>();
  let lane: Lane | null = null;
  let connection: Connection | null = null;
  let staleTimer: Timer | null = null;
  let retryTimer: Timer | null = null;
  let backfillPromise: Promise<void> | null = null;
  let cooldownUntil = 0;
  let state: FeedState = {
    status: 'idle',
    query: null,
    bars: 0,
    loadingMore: false,
    hasMore: false,
    lastUpdateAt: null,
    retryCount: 0,
    error: null,
  };

  const snapshotState = (): FeedState => ({
    ...state,
    query: copyQuery(state.query),
    error: copyFailure(state.error),
  });

  const emitState = (): void => {
    if (!options.onState) return;
    try {
      options.onState(snapshotState());
    } catch {
      // Observers are isolated from session lifecycle work.
    }
  };

  const emitChange = (change: FeedChange): void => {
    try {
      if (change.type === 'reset') {
        options.onChange({
          type: 'reset',
          reason: change.reason,
          bars: change.bars.map(copyBar),
        });
      } else {
        options.onChange({ type: 'update', bar: copyBar(change.bar) });
      }
    } catch {
      // Observers are isolated from session lifecycle work.
    }
  };

  const setState = (patch: Partial<FeedState>): void => {
    state = { ...state, ...patch };
    emitState();
  };

  const clearStaleTimer = (): void => {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const cancelLane = (): void => {
    const current = lane;
    if (!current) return;
    lane = null;
    current.cancel();
  };

  const closeConnection = (target = connection): void => {
    if (!target || !target.active) return;
    target.active = false;
    target.buffer.clear();
    target.corrections.clear();
    target.latestCorrectionSequence = null;
    if (connection === target) connection = null;
    try {
      target.unsubscribe();
    } catch {
      // Teardown is best-effort and remains idempotent.
    }
  };

  const beginLane = (kind: LaneKind, targetEpoch: number): Lane => {
    cancelLane();
    let cancel!: () => void;
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      cancel = () => resolve(CANCELLED);
    });
    const current: Lane = {
      id: ++nextLaneId,
      epoch: targetEpoch,
      kind,
      controller: null,
      timer: null,
      cancelled,
      cancel() {
        current.controller?.abort();
        current.controller = null;
        if (current.timer !== null) clearTimeout(current.timer);
        current.timer = null;
        cancel();
      },
    };
    lane = current;
    return current;
  };

  const finishLane = (target: Lane): void => {
    if (lane === target) lane = null;
    target.controller = null;
    if (target.timer !== null) clearTimeout(target.timer);
    target.timer = null;
  };

  const requestPage = async (
    target: Lane,
    request: HistoryRequest,
  ): Promise<HistoryPage | typeof CANCELLED> => {
    if (lane !== target || target.epoch !== epoch || destroyed) return CANCELLED;
    const controller = new AbortController();
    target.controller = controller;
    let timeout: Timer | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new FeedException(
            failure('TIMEOUT', `History request exceeded ${settings.requestTimeoutMs}ms`, true),
          ),
        );
      }, settings.requestTimeoutMs);
      target.timer = timeout;
    });
    let providerPromise: Promise<HistoryPage>;
    try {
      providerPromise = provider.getHistory({ ...request }, controller.signal);
    } catch (error) {
      providerPromise = Promise.reject(error);
    }
    try {
      return await Promise.race([providerPromise, timeoutPromise, target.cancelled]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (target.timer === timeout) target.timer = null;
      if (target.controller === controller) target.controller = null;
    }
  };

  const updateHighWater = (
    target: Map<number, number>,
    bar: MarketBar,
    revisionMode = provider.revisionMode,
  ): void => {
    if (revisionMode !== 'monotonic') return;
    const revision = bar.revision as number;
    const previous = target.get(bar.time);
    if (previous === undefined || revision > previous) target.set(bar.time, revision);
  };

  const applyAuthoritative = (
    target: Map<number, MarketBar>,
    targetHighWater: Map<number, number>,
    bars: readonly MarketBar[],
  ): void => {
    for (const bar of bars) {
      target.set(bar.time, copyBar(bar));
      updateHighWater(targetHighWater, bar);
    }
  };

  const applyOrdinary = (
    target: Map<number, MarketBar>,
    targetHighWater: Map<number, number>,
    bar: MarketBar,
  ): boolean => {
    if (provider.revisionMode === 'monotonic') {
      const revision = bar.revision as number;
      const previous = targetHighWater.get(bar.time);
      if (previous !== undefined && revision <= previous) return false;
      targetHighWater.set(bar.time, revision);
    }
    target.set(bar.time, copyBar(bar));
    return true;
  };

  const sortedValues = (source: Map<number, MarketBar>): MarketBar[] =>
    [...source.values()].sort((left, right) => left.time - right.time);

  const applyPending = (
    target: Map<number, MarketBar>,
    targetHighWater: Map<number, number>,
    targetConnection: Connection,
  ): void => {
    const pending = [
      ...[...targetConnection.buffer.values()].map((item) => ({ ...item, authoritative: false })),
      ...[...targetConnection.corrections.values()].map((item) => ({ ...item, authoritative: true })),
    ].sort((left, right) => left.sequence - right.sequence);
    for (const item of pending) {
      if (item.authoritative) applyAuthoritative(target, targetHighWater, [item.bar]);
      else applyOrdinary(target, targetHighWater, item.bar);
    }
  };

  const mergeHighWater = (target: Map<number, number>, source: Map<number, number>): void => {
    for (const [time, revision] of source) {
      const previous = target.get(time);
      if (previous === undefined || revision > previous) target.set(time, revision);
    }
  };

  const isTerminalInvariant = (problem: FeedFailure): boolean =>
    ['INVALID_HISTORY', 'BUFFER_LIMIT', 'RECOVERY_LIMIT', 'NO_PROGRESS', 'LIMIT'].includes(problem.code);

  const hardError = (problem: FeedFailure): void => {
    cancelLane();
    closeConnection();
    clearStaleTimer();
    clearRetryTimer();
    backfillPromise = null;
    setState({
      status: 'error',
      loadingMore: false,
      bars: data.length,
      error: copyFailure(problem),
    });
  };

  let beginReconnect: (targetEpoch: number) => void;

  const scheduleReconnect = (problem: FeedFailure, targetEpoch: number): void => {
    if (destroyed || targetEpoch !== epoch) return;
    if (problem.retryAfterMs !== undefined) {
      cooldownUntil = Math.max(cooldownUntil, Date.now() + problem.retryAfterMs);
    }
    if (!problem.retryable || state.retryCount >= settings.maxRetries) {
      hardError(problem);
      return;
    }
    const retryCount = state.retryCount + 1;
    const exponential = Math.min(
      settings.reconnectMaxMs,
      settings.reconnectBaseMs * 2 ** Math.max(0, retryCount - 1),
    );
    const delay = Math.max(exponential, problem.retryAfterMs ?? 0, Math.max(0, cooldownUntil - Date.now()));
    setState({
      status: 'reconnecting',
      retryCount,
      loadingMore: false,
      error: copyFailure(problem),
    });
    if (destroyed || targetEpoch !== epoch) return;
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      beginReconnect(targetEpoch);
    }, delay);
  };

  const failConnection = (target: Connection, problem: FeedFailure): void => {
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    target.failed = true;
    cancelLane();
    closeConnection(target);
    clearStaleTimer();
    scheduleReconnect(problem, target.epoch);
  };

  const armWatchdog = (target: Connection): void => {
    clearStaleTimer();
    if (destroyed || connection !== target || !target.active || state.status !== 'live') return;
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (destroyed || connection !== target || !target.active || target.failed) return;
      setState({ status: 'stale', error: failure('STALE', 'Live connection became silent', true) });
      failConnection(target, failure('STALE', 'Live connection became silent', true));
    }, settings.staleAfterMs);
  };

  const receiveBar = (target: Connection, input: MarketBar): void => {
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    let incoming: MarketBar;
    let revisionMode: 'monotonic' | 'arrival';
    try {
      revisionMode = provider.revisionMode;
      incoming = validateBar(input, revisionMode);
    } catch (error) {
      if (!destroyed && target.epoch === epoch && connection === target && target.active && !target.failed)
        hardError(normalizeFailure(error, 'INVALID_BAR'));
      return;
    }
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed)
      return;
    setState({ lastUpdateAt: Date.now() });
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    if (target.buffering) {
      if (settings.mode === 'latest') {
        const existing = target.buffer.values().next().value as BufferedBar | undefined;
        if (
          existing &&
          (incoming.time < existing.bar.time ||
            (incoming.time === existing.bar.time &&
              revisionMode === 'monotonic' &&
              (incoming.revision as number) <= (existing.bar.revision as number)))
        )
          return;
        target.buffer.clear();
        target.buffer.set(incoming.time, { bar: incoming, sequence: ++nextSequence });
        return;
      }
      const existing = target.buffer.get(incoming.time);
      if (!existing && target.buffer.size >= settings.maxBufferedBars) {
        hardError(failure('BUFFER_LIMIT', 'Live reconciliation buffer exceeded its limit', false));
        return;
      }
      if (
        !existing ||
        revisionMode === 'arrival' ||
        (incoming.revision as number) > (existing.bar.revision as number)
      ) {
        target.buffer.set(incoming.time, { bar: incoming, sequence: ++nextSequence });
      }
      return;
    }

    if (settings.mode === 'latest') {
      if (lastKnownTime !== null && incoming.time < lastKnownTime) {
        armWatchdog(target);
        return;
      }
      if (lastKnownTime === incoming.time && revisionMode === 'monotonic') {
        const previous = highWater.get(incoming.time);
        if (previous !== undefined && (incoming.revision as number) <= previous) {
          armWatchdog(target);
          return;
        }
      }
      lastKnownTime = incoming.time;
      highWater.clear();
      if (revisionMode === 'monotonic') highWater.set(incoming.time, incoming.revision as number);
      data[0] = copyBar(incoming);
      state = { ...state, bars: 1, hasMore: false, error: null };
      emitChange({ type: 'update', bar: incoming });
      if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed)
        return;
      emitState();
      armWatchdog(target);
      return;
    }

    if (revisionMode === 'monotonic') {
      const previous = highWater.get(incoming.time);
      if (previous !== undefined && (incoming.revision as number) <= previous) {
        armWatchdog(target);
        return;
      }
    }
    const position = findTime(data, incoming.time);
    if (!position.found && data.length >= settings.maxBars) {
      hardError(failure('LIMIT', 'A live append exceeded maxBars', false));
      return;
    }
    if (revisionMode === 'monotonic') {
      highWater.set(incoming.time, incoming.revision as number);
    }
    if (position.found) data[position.index] = copyBar(incoming);
    else data.splice(position.index, 0, copyBar(incoming));
    state = {
      ...state,
      bars: data.length,
      hasMore: state.hasMore && data.length < settings.maxBars,
      error: null,
    };
    emitChange({ type: 'update', bar: incoming });
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    emitState();
    armWatchdog(target);
  };

  const connect = (targetEpoch: number): Connection | null => {
    if (destroyed || targetEpoch !== epoch || !state.query) return null;
    const target: Connection = {
      epoch: targetEpoch,
      id: ++nextConnectionId,
      active: true,
      failed: false,
      buffering: true,
      buffer: new Map(),
      corrections: new Map(),
      latestCorrectionSequence: null,
      unsubscribe() {},
    };
    connection = target;
    const handlers: MarketStreamHandlers = {
      onOpen() {
        // Socket-open alone never marks reconciliation healthy.
      },
      onBar(incoming) {
        receiveBar(target, incoming);
      },
      onError(problem) {
        failConnection(target, { ...problem });
      },
      onClose() {
        failConnection(target, failure('STREAM_CLOSED', 'Live connection closed', true));
      },
    };
    try {
      const unsubscribe = provider.subscribe(copyQuery(state.query)!, handlers);
      if (typeof unsubscribe !== 'function') {
        throw new Error('Provider subscribe must return an unsubscribe function');
      }
      target.unsubscribe = unsubscribe;
      if (!target.active) unsubscribe();
      return target.active ? target : null;
    } catch (error) {
      failConnection(target, normalizeFailure(error, 'SUBSCRIBE'));
      return null;
    }
  };

  const commitReconciliation = (
    target: Connection,
    nextData: MarketBar[],
    nextHighWater: Map<number, number>,
    reason: 'initial' | 'reconnect',
    hasMore: boolean,
  ): void => {
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active) return;
    if (nextData.length > settings.maxBars) {
      hardError(failure('LIMIT', 'Reconciliation exceeded maxBars', false));
      return;
    }
    data = nextData;
    if (settings.mode === 'latest') lastKnownTime = nextData[0]?.time ?? lastKnownTime;
    highWater = nextHighWater;
    target.buffer.clear();
    target.corrections.clear();
    target.latestCorrectionSequence = null;
    target.buffering = false;
    state = {
      ...state,
      status: 'live',
      bars: data.length,
      loadingMore: false,
      hasMore: hasMore && data.length < settings.maxBars,
      retryCount: 0,
      error: null,
    };
    emitChange({ type: 'reset', bars: data, reason });
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    emitState();
    if (destroyed || target.epoch !== epoch || connection !== target || !target.active || target.failed) {
      return;
    }
    armWatchdog(target);
  };

  const runInitial = async (target: Connection, targetLane: Lane): Promise<void> => {
    const query = copyQuery(state.query)!;
    const request: HistoryRequest = { ...query, limit: settings.initialLimit };
    try {
      const page = await requestPage(targetLane, request);
      if (page === CANCELLED || lane !== targetLane || connection !== target || !target.active) return;
      const bars = validatePage(page, request, provider.revisionMode);
      const targetData = new Map<number, MarketBar>();
      const targetHighWater = new Map<number, number>();
      applyAuthoritative(targetData, targetHighWater, bars);
      applyPending(targetData, targetHighWater, target);
      const merged = sortedValues(targetData);
      finishLane(targetLane);
      commitReconciliation(target, merged, targetHighWater, 'initial', !page.exhausted);
    } catch (error) {
      if (lane !== targetLane || destroyed || target.epoch !== epoch || connection !== target) return;
      finishLane(targetLane);
      const problem = normalizeFailure(error);
      if (!problem.retryable) hardError(problem);
      else failConnection(target, problem);
    }
  };

  const runLatestReconciliation = async (
    target: Connection,
    targetLane: Lane,
    reason: 'initial' | 'reconnect',
  ): Promise<void> => {
    const query = copyQuery(state.query)!;
    const request: HistoryRequest = { ...query, limit: 1 };
    try {
      const page = await requestPage(targetLane, request);
      if (page === CANCELLED || lane !== targetLane || connection !== target || !target.active) return;
      const revisionMode = provider.revisionMode;
      const bars = validatePage(page, request, revisionMode);
      if (
        lane !== targetLane ||
        destroyed ||
        target.epoch !== epoch ||
        connection !== target ||
        !target.active
      )
        return;

      let newest: MarketBar | null = null;
      let latestTime = lastKnownTime;
      let latestRevision =
        latestTime !== null && revisionMode === 'monotonic' ? highWater.get(latestTime) : undefined;
      const accept = (bar: MarketBar, authoritative: boolean): void => {
        if (latestTime !== null && bar.time < latestTime) return;
        const sameTime = latestTime === bar.time;
        if (
          sameTime &&
          !authoritative &&
          revisionMode === 'monotonic' &&
          latestRevision !== undefined &&
          (bar.revision as number) <= latestRevision
        )
          return;
        newest = copyBar(bar);
        latestTime = bar.time;
        latestRevision =
          revisionMode === 'monotonic'
            ? Math.max(sameTime ? (latestRevision ?? -1) : -1, bar.revision as number)
            : undefined;
      };
      for (const bar of bars) accept(bar, true);
      const live = target.buffer.values().next().value as BufferedBar | undefined;
      const correctionSequence = target.latestCorrectionSequence;
      const corrected = correctionSequence === null ? null : (data[0] ?? null);
      if (corrected && correctionSequence !== null && (!live || correctionSequence < live.sequence))
        accept(corrected, true);
      if (live) accept(live.bar, false);
      if (corrected && live && correctionSequence !== null && correctionSequence > live.sequence)
        accept(corrected, true);

      const nextData = newest ? [newest] : [];
      const nextHighWater = new Map<number, number>();
      if (latestTime !== null && latestRevision !== undefined) nextHighWater.set(latestTime, latestRevision);
      finishLane(targetLane);
      commitReconciliation(target, nextData, nextHighWater, reason, false);
    } catch (error) {
      if (lane !== targetLane || destroyed || target.epoch !== epoch || connection !== target) return;
      finishLane(targetLane);
      const problem = normalizeFailure(error);
      if (!problem.retryable) hardError(problem);
      else failConnection(target, problem);
    }
  };

  const runRecovery = async (target: Connection, targetLane: Lane): Promise<void> => {
    const query = copyQuery(state.query)!;
    const targetData = new Map(data.map((item) => [item.time, copyBar(item)]));
    const targetHighWater = new Map(highWater);
    const finalTime = data.at(-1)?.time;
    if (finalTime === undefined) {
      await runInitial(target, targetLane);
      return;
    }
    let cursor: number = finalTime;
    let exhausted = false;
    try {
      for (let pageNumber = 1; pageNumber <= settings.maxRecoveryPages; pageNumber += 1) {
        const request: HistoryRequest = { ...query, limit: settings.pageSize, from: cursor };
        const page = await requestPage(targetLane, request);
        if (page === CANCELLED || lane !== targetLane || connection !== target || !target.active) return;
        const bars = validatePage(page, request, provider.revisionMode);
        if (bars.length === 0 && !page.exhausted) {
          throw new FeedException(failure('NO_PROGRESS', 'Forward recovery returned no progress', false));
        }
        applyAuthoritative(targetData, targetHighWater, bars);
        if (targetData.size > settings.maxBars) {
          throw new FeedException(failure('LIMIT', 'Recovery exceeded maxBars', false));
        }
        if (page.exhausted) {
          exhausted = true;
          break;
        }
        if (pageNumber === settings.maxRecoveryPages) {
          throw new FeedException(failure('RECOVERY_LIMIT', 'Recovery exceeded its page limit', false));
        }
        const lastTime = bars.at(-1)?.time;
        const nextCursor: number = lastTime === undefined ? cursor : lastTime + 1;
        if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
          throw new FeedException(failure('NO_PROGRESS', 'Forward recovery cursor did not advance', false));
        }
        cursor = nextCursor;
      }
      if (!exhausted) {
        throw new FeedException(failure('RECOVERY_LIMIT', 'Recovery did not exhaust', false));
      }
      if (lane !== targetLane || connection !== target || !target.active) return;
      mergeHighWater(targetHighWater, highWater);
      applyPending(targetData, targetHighWater, target);
      const merged = sortedValues(targetData);
      finishLane(targetLane);
      commitReconciliation(target, merged, targetHighWater, 'reconnect', state.hasMore);
    } catch (error) {
      if (lane !== targetLane || destroyed || target.epoch !== epoch || connection !== target) return;
      finishLane(targetLane);
      const problem = normalizeFailure(error);
      if (!problem.retryable) hardError(problem);
      else failConnection(target, problem);
    }
  };

  beginReconnect = (targetEpoch: number): void => {
    if (destroyed || targetEpoch !== epoch || !state.query) return;
    setState({
      status: settings.mode === 'latest' || data.length !== 0 ? 'reconnecting' : 'loading',
      loadingMore: false,
    });
    const target = connect(targetEpoch);
    if (!target) return;
    if (settings.mode === 'latest') {
      const targetLane = beginLane('recovery', targetEpoch);
      void runLatestReconciliation(target, targetLane, 'reconnect');
      return;
    }
    const targetLane = beginLane(data.length === 0 ? 'initial' : 'recovery', targetEpoch);
    void (data.length === 0 ? runInitial(target, targetLane) : runRecovery(target, targetLane));
  };

  const startFreshLoad = async (input: MarketQuery, delayMs = 0): Promise<void> => {
    if (destroyed) throw programmerError('DESTROYED', 'feed session is destroyed');
    const query = validateQuery(input);
    epoch += 1;
    const targetEpoch = epoch;
    cancelLane();
    closeConnection();
    clearRetryTimer();
    clearStaleTimer();
    backfillPromise = null;
    data = [];
    lastKnownTime = null;
    highWater = new Map();
    state = {
      status: 'loading',
      query,
      bars: 0,
      loadingMore: false,
      hasMore: settings.mode === 'history',
      lastUpdateAt: null,
      retryCount: 0,
      error: null,
    };
    emitChange({ type: 'reset', bars: [], reason: 'initial' });
    if (destroyed || targetEpoch !== epoch) return;
    emitState();
    if (destroyed || targetEpoch !== epoch) return;

    if (delayMs > 0) {
      const waitingLane = beginLane('initial', targetEpoch);
      let timer: Timer | null = null;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delayMs);
        waitingLane.timer = timer;
      });
      const result = await Promise.race([waited, waitingLane.cancelled]);
      if (timer !== null) clearTimeout(timer);
      if (waitingLane.timer === timer) waitingLane.timer = null;
      if (result === CANCELLED || lane !== waitingLane || destroyed || epoch !== targetEpoch) return;
      finishLane(waitingLane);
    }

    const target = connect(targetEpoch);
    if (!target) return;
    const targetLane = beginLane('initial', targetEpoch);
    if (settings.mode === 'latest') await runLatestReconciliation(target, targetLane, 'initial');
    else await runInitial(target, targetLane);
  };

  const loadMoreImpl = async (): Promise<void> => {
    if (destroyed) throw programmerError('DESTROYED', 'feed session is destroyed');
    if (settings.mode === 'latest') return;
    if (backfillPromise) return backfillPromise;
    if (state.loadingMore) return;
    if (!state.query || !state.hasMore || data.length === 0 || lane !== null) return;
    const targetEpoch = epoch;
    const before = data[0]!.time;
    const request: HistoryRequest = {
      ...copyQuery(state.query)!,
      limit: settings.pageSize,
      before,
    };
    setState({ loadingMore: true, error: null });
    if (destroyed || targetEpoch !== epoch) return;
    const targetLane = beginLane('backfill', targetEpoch);
    const work = (async (): Promise<void> => {
      try {
        const page = await requestPage(targetLane, request);
        if (page === CANCELLED || lane !== targetLane || destroyed || targetEpoch !== epoch) return;
        const revisionMode = provider.revisionMode;
        const older = validatePage(page, request, revisionMode);
        if (lane !== targetLane || destroyed || targetEpoch !== epoch) return;
        const exhausted = page.exhausted;
        if (lane !== targetLane || destroyed || targetEpoch !== epoch) return;

        const current = data;
        const candidates: MarketBar[] = [];
        let currentIndex = 0;
        for (const item of older) {
          while (currentIndex < current.length && current[currentIndex]!.time < item.time) currentIndex += 1;
          if (current[currentIndex]?.time !== item.time) candidates.push(item);
        }
        const room = Math.max(0, settings.maxBars - current.length);
        const acceptedOlder = candidates.slice(Math.max(0, candidates.length - room));
        const merged: MarketBar[] = [];
        let olderIndex = 0;
        currentIndex = 0;
        while (olderIndex < acceptedOlder.length && currentIndex < current.length) {
          const item = acceptedOlder[olderIndex]!;
          const existing = current[currentIndex]!;
          if (item.time < existing.time) {
            merged.push(item);
            olderIndex += 1;
          } else {
            merged.push(existing);
            currentIndex += 1;
            if (item.time === existing.time) olderIndex += 1;
          }
        }
        while (olderIndex < acceptedOlder.length) merged.push(acceptedOlder[olderIndex++]!);
        while (currentIndex < current.length) merged.push(current[currentIndex++]!);
        if (revisionMode === 'monotonic') {
          for (const item of acceptedOlder) {
            const revision = item.revision as number;
            const previous = highWater.get(item.time);
            if (previous === undefined || revision > previous) highWater.set(item.time, revision);
          }
        }
        data = merged;
        finishLane(targetLane);
        state = {
          ...state,
          bars: data.length,
          loadingMore: false,
          hasMore: !exhausted && data.length < settings.maxBars,
          error: null,
        };
        if (acceptedOlder.length > 0) {
          emitChange({ type: 'reset', bars: data, reason: 'backfill' });
          if (destroyed || targetEpoch !== epoch) return;
        }
        emitState();
      } catch (error) {
        if (lane !== targetLane || destroyed || targetEpoch !== epoch) return;
        finishLane(targetLane);
        const problem = normalizeFailure(error);
        if (isTerminalInvariant(problem)) {
          hardError(problem);
        } else {
          setState({ loadingMore: false, error: problem });
        }
      }
    })();
    backfillPromise = work.finally(() => {
      if (backfillPromise === work || lane !== targetLane) backfillPromise = null;
    });
    return backfillPromise;
  };

  const applyCorrections = (inputs: readonly MarketBar[]): void => {
    if (destroyed) throw programmerError('DESTROYED', 'feed session is destroyed');
    const targetEpoch = epoch;
    if (!Array.isArray(inputs)) {
      throw programmerError('INVALID_CORRECTION', 'corrections must be an array');
    }
    const revisionMode = inputs.length ? provider.revisionMode : 'arrival';
    const corrections = inputs.map((item) => validateBar(item, revisionMode));
    if (destroyed || targetEpoch !== epoch) return;
    const seen = new Set<number>();
    const replacements = new Map<number, MarketBar>();
    for (const item of corrections) {
      if (seen.has(item.time)) {
        throw programmerError('INVALID_CORRECTION', 'correction times must be unique');
      }
      seen.add(item.time);
      if (!findTime(data, item.time).found) {
        throw programmerError('INVALID_CORRECTION', 'corrections may only replace loaded bars');
      }
      replacements.set(item.time, item);
    }
    if (corrections.length === 0) return;
    const next = data.map((item) => copyBar(replacements.get(item.time) ?? item));
    for (const item of corrections) updateHighWater(highWater, item, revisionMode);
    data = next;
    const activeRecovery =
      connection && connection.active && connection.buffering && lane?.kind === 'recovery'
        ? connection
        : null;
    if (activeRecovery) {
      if (settings.mode === 'latest') activeRecovery.latestCorrectionSequence = ++nextSequence;
      else
        for (const item of corrections) {
          activeRecovery.corrections.set(item.time, { bar: copyBar(item), sequence: ++nextSequence });
        }
    }
    state = { ...state, bars: data.length, lastUpdateAt: Date.now(), error: null };
    emitChange({ type: 'reset', bars: data, reason: 'correction' });
    if (destroyed || targetEpoch !== epoch) return;
    emitState();
  };

  const session: FeedSession = {
    load(query) {
      return startFreshLoad(query);
    },
    loadMore() {
      return loadMoreImpl();
    },
    retry() {
      if (destroyed) return Promise.reject(programmerError('DESTROYED', 'feed session is destroyed'));
      if (!state.query) return Promise.reject(programmerError('INVALID_STATE', 'no query to retry'));
      const delay = Math.max(0, cooldownUntil - Date.now());
      return startFreshLoad(copyQuery(state.query)!, delay);
    },
    applyCorrections,
    getBar(time) {
      if (destroyed) throw programmerError('DESTROYED', 'feed session is destroyed');
      if (!Number.isSafeInteger(time)) return null;
      const found = findTime(data, time);
      return found.found ? copyBar(data[found.index]!) : null;
    },
    getData() {
      if (destroyed) throw programmerError('DESTROYED', 'feed session is destroyed');
      return data.map(copyBar);
    },
    getState() {
      return snapshotState();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      epoch += 1;
      cancelLane();
      closeConnection();
      clearStaleTimer();
      clearRetryTimer();
      backfillPromise = null;
      state = {
        ...state,
        status: 'destroyed',
        loadingMore: false,
        error: null,
      };
      emitState();
    },
  };
  resourceSnapshots.set(session, () => {
    const bufferedBars = connection?.buffer.size ?? 0;
    const correctionBars = connection?.corrections.size ?? 0;
    return {
      destroyed,
      mode: settings.mode,
      query: copyQuery(state.query),
      status: state.status,
      retainedBars: data.length,
      bufferedBars,
      correctionBars,
      pendingBarEntries: bufferedBars + correctionBars,
      activeConnection: connection?.active === true,
      buffering: connection?.buffering === true,
      laneKind: lane?.kind ?? null,
      pendingRequest: lane !== null && lane.controller !== null,
      staleTimer: staleTimer !== null,
      retryTimer: retryTimer !== null,
      requestTimer: lane !== null && lane.timer !== null,
    };
  });
  return session;
}
