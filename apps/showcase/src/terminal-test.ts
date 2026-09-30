import { createChart, type ChartApi, type SeriesHandle, type PaneHandle } from '@filtrix.net/charts';
import { TerminalLayoutRuntime } from '../../../packages/terminal/src/layout-runtime';
import {
  createTerminal,
  type TerminalApi,
  type TerminalOptions,
  type TerminalState,
  type TerminalStudyOptions,
} from '@filtrix.net/terminal';
import { createFeedSession } from '@filtrix.net/datafeed';
import {
  createPriceAlertMonitor,
  createPriceAlertStore,
  type PriceAlertEvent,
  type PriceAlertMonitor,
  type PriceAlertStore,
} from '@filtrix.net/alerts';
import { createBollingerBands, createIndicator, createMacd } from '@filtrix.net/indicators';
import { createTerminalWithDependencies } from '../../../packages/terminal/src/terminal';
import type { TerminalStudyRuntimeFactories } from '../../../packages/terminal/src/study-runtime';
import type {
  FeedSession,
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from '@filtrix.net/datafeed';

const start = Date.UTC(2026, 8, 1);
const sources = new Map<string, MarketBar[]>();
const key = (query: MarketQuery) => `${query.symbol}:${query.interval}`;
const step = (interval: string) => (interval === '5m' ? 300_000 : 60_000);
function source(query: MarketQuery): MarketBar[] {
  const id = key(query);
  let bars = sources.get(id);
  if (!bars) {
    const base = query.symbol === 'ETHUSDT' ? 300 : 100;
    const stride = step(query.interval);
    bars = Array.from({ length: 60 }, (_, index) => {
      const open = base + index;
      return {
        time: start + index * stride,
        open,
        high: open + 2,
        low: open - 1,
        close: open + 1,
        volume: 10 + index,
        revision: 1,
      };
    });
    sources.set(id, bars);
  }
  return bars;
}

function history(request: HistoryRequest): HistoryPage {
  let bars = source(request).filter(
    (bar) =>
      (request.before === undefined || bar.time < request.before) &&
      (request.from === undefined || bar.time >= request.from),
  );
  bars = request.from === undefined ? bars.slice(-request.limit) : bars.slice(0, request.limit);
  return { bars: bars.map((bar) => ({ ...bar })), exhausted: bars.length < request.limit };
}

type Subscription = { query: MarketQuery; handlers: MarketStreamHandlers; active: boolean };
const subscriptions = new Set<Subscription>();
let obsolete: Subscription | null = null;
let hold = false;
let held: { request: HistoryRequest; resolve(page: HistoryPage): void } | null = null;
let historyRequests = 0;
let feedDataReadCount = 0;
let geometryOnly = false;
let failedPaneId: string | null = null;
const geometryCalls = { seriesSetData: 0, addSeries: 0, removeSeries: 0, addPane: 0, removePane: 0 };
function resourceCall(kind: keyof typeof geometryCalls): void {
  geometryCalls[kind]++;
  if (geometryOnly) throw new Error('Geometry called ' + kind);
}
function forbidGeometry(label: string): void {
  if (geometryOnly) throw new Error('Geometry called ' + label);
}
function instrumentedChart(...args: Parameters<typeof createChart>): ChartApi {
  const chart = createChart(...args);
  const series = (handle: SeriesHandle): SeriesHandle => ({
    ...handle,
    setData(data) {
      resourceCall('seriesSetData');
      handle.setData(data);
    },
    remove() {
      resourceCall('removeSeries');
      handle.remove();
    },
  });
  const pane = (handle: PaneHandle): PaneHandle => ({
    ...handle,
    remove() {
      resourceCall('removePane');
      handle.remove();
    },
  });
  return {
    ...chart,
    addSeries(type, options) {
      resourceCall('addSeries');
      return series(chart.addSeries(type, options));
    },
    removeSeries(id) {
      resourceCall('removeSeries');
      chart.removeSeries(id);
    },
    addPane(options) {
      resourceCall('addPane');
      if (options?.id === failedPaneId) {
        failedPaneId = null;
        throw new Error('fixture repair pane failure');
      }
      return pane(chart.addPane(options));
    },
    removePane(id) {
      resourceCall('removePane');
      chart.removePane(id);
    },
  };
}
let layoutObserverAction: (() => void) | null = null;

function instrumentedFeedSession(options: Parameters<typeof createFeedSession>[0]): FeedSession {
  const session = createFeedSession(options);
  return {
    load(query) {
      return session.load(query);
    },
    loadMore() {
      return session.loadMore();
    },
    retry() {
      return session.retry();
    },
    applyCorrections(bars) {
      session.applyCorrections(bars);
    },
    getBar(time) {
      return session.getBar(time);
    },
    getData() {
      forbidGeometry('feed.getData');
      feedDataReadCount += 1;
      return session.getData();
    },
    getState() {
      return session.getState();
    },
    destroy() {
      session.destroy();
    },
  };
}

function appendSource(query: MarketQuery, count: number, stream: boolean): void {
  const bars = source(query);
  for (let index = 0; index < count; index++) {
    const previous = bars.at(-1)!;
    const open = previous.close;
    const next: MarketBar = {
      time: previous.time + step(query.interval),
      open,
      high: open + 2,
      low: open - 1,
      close: open + 1,
      volume: previous.volume + 1,
      revision: 1,
    };
    bars.push(next);
    if (stream) deliver(next);
  }
}

const provider: MarketDataProvider = {
  id: 'terminal-browser-fixture',
  revisionMode: 'monotonic',
  maxPageSize: 100,
  getHistory(request) {
    forbidGeometry('provider.getHistory');
    historyRequests += 1;
    if (hold) {
      hold = false;
      return new Promise<HistoryPage>((resolve) => {
        held = { request: { ...request }, resolve };
      });
    }
    return Promise.resolve(history(request));
  },
  subscribe(query, handlers) {
    forbidGeometry('provider.subscribe');
    const entry: Subscription = { query: { ...query }, handlers, active: true };
    subscriptions.add(entry);
    queueMicrotask(() => {
      if (entry.active) handlers.onOpen();
    });
    return () => {
      entry.active = false;
      subscriptions.delete(entry);
      obsolete = entry;
    };
  },
};
const alertEvents: PriceAlertEvent[] = [];
const alertTimes = new Map<string, number>();

const calculatorCounts = { create: 0, setData: 0, getData: 0, update: 0 };
const studyFactories: TerminalStudyRuntimeFactories = {
  single(kind, period, domain) {
    forbidGeometry('calculator.create');
    calculatorCounts.create += 1;
    const calculator = createIndicator(kind, period, domain);
    return {
      setData(points) {
        forbidGeometry('calculator.setData');
        calculatorCounts.setData += 1;
        calculator.setData(points);
      },
      getData() {
        forbidGeometry('calculator.getData');
        calculatorCounts.getData += 1;
        return calculator.getData();
      },
      update(point) {
        calculatorCounts.update += 1;
        return calculator.update(point);
      },
    };
  },
  macd(options, domain) {
    forbidGeometry('calculator.create');
    calculatorCounts.create += 1;
    const calculator = createMacd(options, domain);
    return {
      setData(points) {
        forbidGeometry('calculator.setData');
        calculatorCounts.setData += 1;
        calculator.setData(points);
      },
      getData() {
        forbidGeometry('calculator.getData');
        calculatorCounts.getData += 1;
        return calculator.getData();
      },
      update(point) {
        calculatorCounts.update += 1;
        return calculator.update(point);
      },
    };
  },
  bollinger(options, domain) {
    forbidGeometry('calculator.create');
    calculatorCounts.create += 1;
    const calculator = createBollingerBands(options, domain);
    return {
      setData(points) {
        forbidGeometry('calculator.setData');
        calculatorCounts.setData += 1;
        calculator.setData(points);
      },
      getData() {
        forbidGeometry('calculator.getData');
        calculatorCounts.getData += 1;
        return calculator.getData();
      },
      update(point) {
        calculatorCounts.update += 1;
        return calculator.update(point);
      },
    };
  },
};

let throwFromObserver = false;
let destroyFromObserver = false;
let observerSwitch: MarketQuery | null = null;
let observerDestroy = false;
let observerCapture = false;
let consistencyCapture = false;
let observerAction: Promise<void> = Promise.resolve();
let observerStudy: { action: 'remove' | 'destroy'; id?: string } | null = null;
const capturedWorkspaces: ReturnType<TerminalApi['getWorkspace']>[] = [];
const consistencyCaptures: Array<{
  state: TerminalState;
  workspace: ReturnType<TerminalApi['getWorkspace']>;
  data: readonly MarketBar[];
}> = [];
const observedStates: TerminalState[] = [];
let borrowedAlertStore: PriceAlertStore | null = null;
let borrowedAlertMonitor: PriceAlertMonitor | null = null;
let borrowedAlertSequence = 0;
const earlyAlertObservations: Array<{
  workspace: ReturnType<TerminalApi['getWorkspace']>;
  store: ReturnType<PriceAlertStore['toJSON']>;
}> = [];
let earlyAlertAction: 'destroy' | 'restore' | null = null;
let earlyAlertNested: Promise<void> = Promise.resolve();
const host = document.getElementById('terminal-host')!;
function mount(
  maxBars?: number,
  query: MarketQuery = { symbol: 'BTCUSDT', interval: '1m' },
  symbols: readonly string[] = ['BTCUSDT', 'ETHUSDT'],
  intervals: readonly string[] = ['1m', '5m'],
  studies?: readonly TerminalStudyOptions[],
  alerts?: TerminalOptions['alerts'],
): TerminalApi {
  return createTerminalWithDependencies(
    host,
    {
      provider,
      query,
      symbols,
      intervals,
      ...(studies === undefined ? { settings: { emaPeriod: 3 } } : { studies }),
      ...(alerts ? { alerts } : {}),
      feed: {
        initialLimit: Math.min(12, maxBars ?? 12),
        pageSize: Math.min(6, maxBars ?? 6),
        ...(maxBars === undefined ? {} : { maxBars }),
        staleAfterMs: 60_000,
        requestTimeoutMs: 2_000,
        reconnectBaseMs: 10,
        reconnectMaxMs: 20,
        maxRetries: 2,
      },
      onState(state) {
        observedStates.push(state);
        if (layoutObserverAction) {
          const action = layoutObserverAction;
          layoutObserverAction = null;
          action();
        }
        if (observerCapture) {
          observerCapture = false;
          capturedWorkspaces.push(terminal.getWorkspace());
        }
        if (consistencyCapture) {
          consistencyCapture = false;
          consistencyCaptures.push({
            state,
            workspace: terminal.getWorkspace(),
            data: terminal.getData(),
          });
        }
        if (observerSwitch) {
          const query = observerSwitch;
          observerSwitch = null;
          observerAction = terminal.setMarket(query);
        }
        if (observerDestroy) {
          observerDestroy = false;
          terminal.destroy();
        }
        if (observerStudy) {
          const pending = observerStudy;
          observerStudy = null;
          if (pending.action === 'remove') terminal.removeStudy(pending.id!);
          else terminal.destroy();
        }
        if (destroyFromObserver) {
          destroyFromObserver = false;
          terminal.destroy();
        }
        if (throwFromObserver) throw new Error('fixture observer failure');
      },
      onAlert(event) {
        alertEvents.push(event);
      },
    },
    { createFeedSession: instrumentedFeedSession, studyFactories, createChart: instrumentedChart },
  );
}
let terminal = mount();
let pendingSwitch: Promise<void> = Promise.resolve();

function activeQuery(): MarketQuery {
  const query = terminal.getState().feed.query;
  if (!query) throw new Error('No active query');
  return query;
}

function deliver(bar: MarketBar): void {
  const active = activeQuery();
  for (const entry of [...subscriptions])
    if (entry.query.symbol === active.symbol && entry.query.interval === active.interval)
      entry.handlers.onBar({ ...bar });
}

const api = {
  get terminal() {
    return terminal;
  },
  get alertEvents() {
    return alertEvents.map((event) => ({ ...event, query: { ...event.query } }));
  },
  clearAlertEvents() {
    alertEvents.length = 0;
  },
  remountWithAlertOwnership(kind: 'neither' | 'store' | 'monitor' | 'both') {
    terminal.destroy();
    borrowedAlertStore?.destroy();
    borrowedAlertMonitor?.destroy();
    borrowedAlertStore =
      kind === 'store' || kind === 'both'
        ? createPriceAlertStore({ providerId: provider.id, scopeId: `borrowed-${++borrowedAlertSequence}` })
        : null;
    borrowedAlertMonitor =
      kind === 'monitor' || kind === 'both' ? createPriceAlertMonitor({ provider }) : null;
    terminal = mount(undefined, undefined, undefined, undefined, undefined, {
      ...(borrowedAlertStore ? { store: borrowedAlertStore } : {}),
      ...(borrowedAlertMonitor ? { monitor: borrowedAlertMonitor } : {}),
    });
    return terminal;
  },
  remountWithEarlyBorrowedAlertObserver() {
    terminal.destroy();
    borrowedAlertStore?.destroy();
    borrowedAlertMonitor?.destroy();
    borrowedAlertMonitor = null;
    earlyAlertObservations.length = 0;
    earlyAlertAction = null;
    earlyAlertNested = Promise.resolve();
    borrowedAlertStore = createPriceAlertStore({
      providerId: provider.id,
      scopeId: `borrowed-${++borrowedAlertSequence}`,
    });
    const store = borrowedAlertStore;
    store.subscribe(() => {
      const workspace = terminal.getWorkspace();
      earlyAlertObservations.push({ workspace, store: store.toJSON() });
      const action = earlyAlertAction;
      earlyAlertAction = null;
      if (action === 'destroy') terminal.destroy();
      if (action === 'restore') {
        earlyAlertNested = terminal.restoreWorkspace({
          ...workspace,
          settings: { ...workspace.settings, theme: workspace.settings.theme === 'dark' ? 'light' : 'dark' },
        });
      }
    });
    terminal = mount(undefined, undefined, undefined, undefined, undefined, { store });
    return terminal;
  },
  armEarlyBorrowedAlertObserver(action: 'destroy' | 'restore') {
    earlyAlertAction = action;
    earlyAlertObservations.length = 0;
  },
  get earlyAlertObservations() {
    return earlyAlertObservations.map((item) => structuredClone(item));
  },
  get earlyAlertNested() {
    return earlyAlertNested;
  },
  get borrowedAlertStore() {
    return borrowedAlertStore;
  },
  get borrowedAlertMonitor() {
    return borrowedAlertMonitor;
  },
  cleanupBorrowedAlerts() {
    borrowedAlertStore?.destroy();
    borrowedAlertMonitor?.destroy();
    borrowedAlertStore = null;
    borrowedAlertMonitor = null;
  },
  emitAlertBar(query: MarketQuery, close: number) {
    const id = key(query);
    const time = (alertTimes.get(id) ?? source(query).at(-1)!.time) + step(query.interval);
    alertTimes.set(id, time);
    const bar: MarketBar = {
      time,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
      revision: 1,
    };
    for (const entry of [...subscriptions])
      if (entry.query.symbol === query.symbol && entry.query.interval === query.interval)
        entry.handlers.onBar({ ...bar });
  },
  get pendingSwitch() {
    return pendingSwitch;
  },
  set pendingSwitch(value: Promise<void>) {
    pendingSwitch = value;
  },
  get throwFromObserver() {
    return throwFromObserver;
  },
  set throwFromObserver(value: boolean) {
    throwFromObserver = value;
  },
  observedStates,
  capturedWorkspaces,
  consistencyCaptures,
  armConsistencyCapture() {
    consistencyCapture = true;
  },
  armObserverSwitch(query: MarketQuery) {
    observerSwitch = { ...query };
    observerAction = Promise.resolve();
  },
  armObserverDestroy() {
    observerDestroy = true;
  },
  armStudyObserver(action: 'remove' | 'destroy', id?: string) {
    observerStudy = { action, id };
  },
  armWorkspaceCapture() {
    observerCapture = true;
  },
  waitObserverAction() {
    return observerAction;
  },
  workspaceFor(query: MarketQuery, settingsPatch: Record<string, unknown>) {
    const workspace = terminal.getWorkspace();
    const markets = [...workspace.markets];
    if (!markets.some((market) => key(market.query) === key(query)))
      markets.push({
        query: { ...query },
        drawings: {
          schema: 'filtix-drawings',
          version: 2,
          timeDomain: 'utc-ms',
          drawings: [],
        },
      });
    const nextSettings = { ...settingsPatch };
    const studies = workspace.studies.map((study) => ({ ...study }));
    if (Object.prototype.hasOwnProperty.call(nextSettings, 'emaPeriod')) {
      const value = nextSettings.emaPeriod;
      delete nextSettings.emaPeriod;
      const index = studies.findIndex((study) => study.id === 'terminal-ema');
      if (value === null) {
        if (index >= 0) studies.splice(index, 1);
      } else if (index >= 0) {
        const current = studies[index]!;
        if (current.kind !== 'ema') throw new Error('Reserved terminal-ema study must have ema kind');
        studies[index] = { ...current, period: value as number, visible: true };
      } else {
        studies.push({
          id: 'terminal-ema',
          kind: 'ema',
          period: value as number,
          color: '#c27a50',
          lineWidth: 2,
          visible: true,
        });
      }
    }
    return {
      ...workspace,
      query: { ...query },
      settings: { ...workspace.settings, ...nextSettings },
      studies,
      markets,
    };
  },
  activeQueries() {
    return [...subscriptions].map((entry) => key(entry.query)).sort();
  },
  get destroyFromObserver() {
    return destroyFromObserver;
  },
  set destroyFromObserver(value: boolean) {
    destroyFromObserver = value;
  },
  holdNextHistory() {
    hold = true;
  },
  releaseHeldHistory() {
    const pending = held;
    held = null;
    if (pending) pending.resolve(history(pending.request));
  },
  emitObsolete() {
    if (!obsolete) return;
    const bar = source(obsolete.query).at(-1)!;
    obsolete.handlers.onBar({ ...bar, close: 999, high: 1000, revision: bar.revision! + 100 });
  },
  correctLoadedBar(index: number, close: number, volume: number) {
    const loaded = terminal.getData();
    const previous = loaded[index];
    if (!previous) throw new Error('Unknown loaded bar');
    const next = {
      ...previous,
      high: Math.max(previous.high, close + 1),
      low: Math.min(previous.low, close - 1),
      close,
      volume,
      revision: previous.revision! + 100,
    };
    const bars = source(activeQuery());
    const sourceIndex = bars.findIndex((bar) => bar.time === next.time);
    if (sourceIndex >= 0) bars[sourceIndex] = next;
    terminal.applyCorrections([next]);
  },
  disconnectAndAppend(count: number) {
    const query = activeQuery();
    for (const entry of [...subscriptions]) entry.handlers.onClose();
    appendSource(query, count, false);
  },
  appendBars(count: number) {
    appendSource(activeQuery(), count, true);
  },
  reviseHistorical(time: number, close: number, volume: number) {
    const bars = source(activeQuery());
    const index = bars.findIndex((bar) => bar.time === time);
    if (index < 0) throw new Error('Unknown historical bar');
    const previous = bars[index]!;
    const next = {
      ...previous,
      high: Math.max(previous.high, close + 1),
      low: Math.min(previous.low, close - 1),
      close,
      volume,
      revision: previous.revision! + 1,
    };
    bars[index] = next;
    deliver(next);
  },
  reviseTail(close: number, volume: number) {
    const bars = source(activeQuery());
    const previous = bars.at(-1)!;
    const next = {
      ...previous,
      high: Math.max(previous.high, close + 1),
      low: Math.min(previous.low, close - 1),
      close,
      volume,
      revision: previous.revision! + 1,
    };
    bars[bars.length - 1] = next;
    deliver(next);
  },
  pointsAt(time: number) {
    return new Promise<Record<string, unknown>>((resolve) => {
      let unsubscribe = () => {};
      unsubscribe = terminal.chart.subscribeCrosshairMove((event) => {
        if (event.time !== time) return;
        unsubscribe();
        resolve(event.points as Record<string, unknown>);
      });
      terminal.chart.setCrosshairTime(null);
      terminal.chart.setCrosshairTime(time);
    });
  },
  async renderedSeries() {
    terminal.chart.fitContent();
    await terminal.chart.whenIdle();
    const bars = terminal.getData();
    const price: unknown[] = [];
    const volume: unknown[] = [];
    const ema: unknown[] = [];
    for (const bar of bars) {
      const points = await api.pointsAt(bar.time);
      price.push(points['terminal-price']);
      volume.push(points['terminal-volume']);
      ema.push(points['terminal-ema']);
    }
    return { bars, price, volume, ema };
  },
  activeSubscriptions() {
    return subscriptions.size;
  },
  failNextPane(id: string) {
    failedPaneId = id;
  },
  setGeometryOnly(value: boolean) {
    geometryOnly = value;
  },
  geometryCalls() {
    return { ...geometryCalls };
  },
  armLayoutObserver(action: 'reset' | 'remove' | 'restore' | 'destroy', value?: unknown) {
    layoutObserverAction = () => {
      if (action === 'reset') terminal.resetLayout();
      else if (action === 'remove') terminal.removeStudy(value as string);
      else if (action === 'restore') observerAction = terminal.restoreWorkspace(value);
      else terminal.destroy();
    };
  },
  derivedLayoutBridge() {
    const target = document.createElement('div');
    target.style.cssText = 'width:600px;height:400px';
    document.body.append(target);
    const chart = createChart(target);
    chart.addPane({ id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 });
    let canonical = {
      panes: [
        { id: 'price' as const, weight: 1, minHeight: 160 },
        { id: 'terminal-volume-pane' as const, weight: 0.26, minHeight: 64 },
      ],
      maximizedPaneId: null,
      studiesOpen: true,
    } as import('@filtrix.net/terminal').TerminalLayout;
    const runtime = new TerminalLayoutRuntime(
      chart,
      () => canonical,
      () => new Set(['price', 'terminal-volume-pane']),
      (value) => {
        canonical = value;
      },
    );
    try {
      runtime.sync(canonical, 'price');
      chart.applyPaneLayout({ panes: [{ id: 'price', weight: 2 }] });
      const result = { canonical, effective: chart.getPaneLayout() };
      runtime.sync(canonical);
      return { result, restored: chart.getPaneLayout() };
    } finally {
      runtime.destroy();
      chart.destroy();
      target.remove();
    }
  },
  historyRequests() {
    return historyRequests;
  },
  resetFeedDataReads() {
    feedDataReadCount = 0;
  },
  feedDataReads() {
    return feedDataReadCount;
  },
  resetStudyCalculatorCounts() {
    calculatorCounts.create = 0;
    calculatorCounts.setData = 0;
    calculatorCounts.getData = 0;
    calculatorCounts.update = 0;
  },
  studyCalculatorCounts() {
    return { ...calculatorCounts };
  },
  constructorLayout(layout: unknown) {
    const target = document.createElement('div');
    let error = '';
    try {
      createTerminalWithDependencies(
        target,
        { provider, query: { symbol: 'BTCUSDT', interval: '1m' }, layout: layout as never },
        { createFeedSession: instrumentedFeedSession, createChart: instrumentedChart, studyFactories },
      ).destroy();
    } catch (cause) {
      error = String(cause);
    }
    return { error, children: target.childNodes.length };
  },
  constructorAlertGetterOwnership(
    mode: 'stable-borrowed' | 'first-borrowed' | 'late-borrowed' | 'absent',
    failFeed = false,
  ) {
    const target = document.createElement('div');
    const testProvider = failFeed ? { ...provider, maxPageSize: 0 } : provider;
    const store = createPriceAlertStore({
      providerId: provider.id,
      scopeId: `getter-${++borrowedAlertSequence}`,
    });
    store.add({
      query: { symbol: 'BTCUSDT', interval: '1m' },
      price: 10,
      condition: 'crosses-up',
      frequency: 'once',
    });
    const monitor = createPriceAlertMonitor({ provider: testProvider });
    let storeReads = 0;
    let monitorReads = 0;
    const value = (read: number) =>
      mode === 'stable-borrowed' ||
      (mode === 'first-borrowed' && read === 1) ||
      (mode === 'late-borrowed' && read >= 3);
    const alerts = {
      get store() {
        return value(++storeReads) ? store : undefined;
      },
      get monitor() {
        return value(++monitorReads) ? monitor : undefined;
      },
    };
    const subscriptionsBefore = subscriptions.size;
    let created: TerminalApi | null = null;
    let error = '';
    try {
      created = createTerminalWithDependencies(
        target,
        {
          provider: testProvider,
          query: { symbol: 'BTCUSDT', interval: '1m' },
          alerts,
        },
        { createFeedSession: instrumentedFeedSession, createChart: instrumentedChart, studyFactories },
      );
    } catch (problem) {
      error = String(problem);
    }
    const selectedBorrowedStore = created?.getAlerts() === store;
    const borrowedMonitorQueries = monitor.getState().queries.length;
    created?.destroy();
    let borrowedStoreUsable = true;
    try {
      store.add({
        query: { symbol: 'BTCUSDT', interval: '1m' },
        price: 11,
        condition: 'crosses-up',
        frequency: 'once',
      });
    } catch {
      borrowedStoreUsable = false;
    }
    const borrowedMonitorAlive = !monitor.getState().destroyed;
    const subscriptionsAfter = subscriptions.size;
    const children = target.childNodes.length;
    store.destroy();
    monitor.destroy();
    return {
      storeReads,
      monitorReads,
      selectedBorrowedStore,
      borrowedMonitorQueries,
      borrowedStoreUsable,
      borrowedMonitorAlive,
      subscriptionsBefore,
      subscriptionsAfter,
      children,
      error,
    };
  },
  constructorOverlength() {
    const target = document.createElement('div');
    const subscriptionsBefore = subscriptions.size;
    let descriptorAccesses = 0;
    let error = '';
    const studies = Array.from({ length: 9 }, () => {
      const study = { period: 20 } as { kind?: string; period: number };
      Object.defineProperty(study, 'kind', {
        enumerable: true,
        get() {
          descriptorAccesses += 1;
          throw new Error('oversized descriptor was accessed');
        },
      });
      return study;
    });
    try {
      createTerminal(target, {
        provider,
        query: { symbol: 'BTCUSDT', interval: '1m' },
        studies: studies as any,
      });
    } catch (cause) {
      error = String(cause);
    }
    return {
      error,
      descriptorAccesses,
      children: target.childElementCount,
      subscriptionsBefore,
      subscriptionsAfter: subscriptions.size,
    };
  },
  constructorConflict() {
    const target = document.createElement('div');
    const subscriptionsBefore = subscriptions.size;
    let error = '';
    try {
      createTerminal(target, {
        provider,
        query: { symbol: 'BTCUSDT', interval: '1m' },
        settings: { emaPeriod: undefined },
        studies: [],
      });
    } catch (cause) {
      error = String(cause);
    }
    return {
      error,
      children: target.childElementCount,
      subscriptionsBefore,
      subscriptionsAfter: subscriptions.size,
    };
  },
  async renderedStudies() {
    terminal.chart.fitContent();
    await terminal.chart.whenIdle();
    const bars = terminal.getData();
    const studies = terminal.getStudies();
    const result: Record<string, unknown[]> = {};
    for (const study of studies) {
      if (!study.visible) continue;
      const ids =
        study.kind === 'macd'
          ? ['macd', 'signal', 'histogram'].map((output) => `terminal-${study.id}-${output}`)
          : study.kind === 'bollinger'
            ? ['middle', 'upper', 'lower', 'fill'].map((output) => `terminal-${study.id}-${output}`)
            : [study.id === 'terminal-ema' ? study.id : `terminal-${study.id}`];
      for (const id of ids) result[id] = [];
    }
    for (const bar of bars) {
      const points = await api.pointsAt(bar.time);
      for (const id of Object.keys(result)) result[id]!.push(points[id] ?? null);
    }
    return { bars, studies, series: result, diagnostics: terminal.chart.getDiagnostics() };
  },
  remountWithStudyPattern(closes: readonly number[], studies: readonly TerminalStudyOptions[]) {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    observerSwitch = null;
    observerDestroy = false;
    observerCapture = false;
    consistencyCapture = false;
    observerAction = Promise.resolve();
    observerStudy = null;
    const query = { symbol: 'BTCUSDT', interval: '1m' };
    sources.delete(key(query));
    const bars = source(query);
    if (closes.length !== bars.length) throw new Error(`Expected ${bars.length} fixture closes`);
    bars.forEach((bar, index) => {
      const close = closes[index]!;
      bar.open = close;
      bar.high = close + 1;
      bar.low = close - 1;
      bar.close = close;
      bar.volume = 20;
      bar.revision = 1;
    });
    terminal = mount(undefined, query, ['BTCUSDT', 'ETHUSDT'], ['1m', '5m'], studies);
    return terminal;
  },
  remountWithStudies(studies: readonly TerminalStudyOptions[]) {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    observerSwitch = null;
    observerDestroy = false;
    observerCapture = false;
    consistencyCapture = false;
    observerAction = Promise.resolve();
    observerStudy = null;
    const query = { symbol: 'BTCUSDT', interval: '1m' };
    sources.delete(key(query));
    const bars = source(query);
    const pattern = [109, 103, 112, 108, 118, 115, 121, 111, 124, 119, 129, 123, 132, 126, 136, 131];
    bars.forEach((bar, index) => {
      const close = pattern[index % pattern.length]! + Math.floor(index / pattern.length) * 3;
      bar.open = close - 1;
      bar.high = close + 2;
      bar.low = close - 3;
      bar.close = close;
      bar.volume = 20 + (index % 7);
      bar.revision = 1;
    });
    terminal = mount(undefined, query, ['BTCUSDT', 'ETHUSDT'], ['1m', '5m'], studies);
    return terminal;
  },
  remount() {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    observerSwitch = null;
    observerDestroy = false;
    observerCapture = false;
    consistencyCapture = false;
    observerAction = Promise.resolve();
    observerStudy = null;
    terminal = mount();
    return terminal;
  },
  remountWithOverflow() {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    observerSwitch = null;
    observerDestroy = false;
    observerCapture = false;
    consistencyCapture = false;
    observerAction = Promise.resolve();
    observerStudy = null;
    const query = { symbol: 'BTCUSDT', interval: '1m' };
    const bars = source(query);
    for (const bar of bars.slice(-2)) bar.volume = Number.MAX_VALUE;
    terminal = mount();
    return terminal;
  },
  repairOverflow() {
    const loaded = terminal.getData();
    const sourceBars = source(activeQuery());
    const corrections = loaded
      .filter((bar) => bar.volume === Number.MAX_VALUE)
      .map((bar, index) => ({ ...bar, volume: 20 + index, revision: bar.revision! + 1 }));
    for (const correction of corrections) {
      const index = sourceBars.findIndex((bar) => bar.time === correction.time);
      if (index >= 0) sourceBars[index] = correction;
    }
    terminal.applyCorrections(corrections);
  },
  remountWithCollisionCatalog() {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    observerSwitch = null;
    observerDestroy = false;
    observerCapture = false;
    consistencyCapture = false;
    observerAction = Promise.resolve();
    terminal = mount(undefined, { symbol: 'A', interval: 'B\u0000C' }, ['A', 'A\u0000B'], ['B\u0000C', 'C']);
    return terminal;
  },
  remountWithCap(maxBars: number) {
    terminal.destroy();
    throwFromObserver = false;
    destroyFromObserver = false;
    terminal = mount(maxBars);
    return terminal;
  },
};

declare global {
  interface Window {
    terminalTestApi: typeof api;
  }
}
window.terminalTestApi = api;
