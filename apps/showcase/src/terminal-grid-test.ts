import { createChart } from '@filtix/charts';
import {
  createFeedSession,
  type MarketDataProvider,
  type MarketQuery,
  type MarketStreamHandlers,
} from '@filtix/datafeed';
import { createPriceAlertMonitor, createPriceAlertStore } from '@filtix/alerts';
import {
  getPriceAlertMonitorResourceSnapshot,
  getPriceAlertStoreResourceSnapshot,
} from '@filtix/alerts/internal';
import { prepareAlertMembershipReplacement } from '@filtix/alerts/internal';
import type {
  TerminalGridApi,
  TerminalGridCellId,
  TerminalGridOptions,
  TerminalGridState,
  TerminalGridWorkspace,
} from '@filtix/terminal';
import { createTerminalGridWithDependencies } from '../../../packages/terminal/src/grid';
import { prepareTerminalWithDependencies } from '../../../packages/terminal/src/terminal';

const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'] as const;
const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];
const intervals = ['1m', '5m', '1h', '1d'];
const query = (symbol = 'BTCUSDT', interval = '1m'): MarketQuery => ({ symbol, interval });
const bar = (time: number, close: number) => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  revision: time,
});
type Entry = {
  query: MarketQuery;
  handlers: MarketStreamHandlers;
  active: boolean;
  kind: 'chart' | 'monitor';
};

function fixtureProvider() {
  const entries: Entry[] = [];
  const counts = { history: 0, setup: 0, teardown: 0 };
  let inspect: ((phase: 'history' | 'setup' | 'teardown') => void) | null = null;
  let holdNextHistory = false;
  const heldHistory: Array<() => void> = [];
  const provider: MarketDataProvider = {
    id: 'grid-fixture',
    revisionMode: 'monotonic',
    maxPageSize: 100,
    getHistory() {
      counts.history++;
      inspect?.('history');
      if (holdNextHistory) {
        holdNextHistory = false;
        return new Promise((resolve) => heldHistory.push(() => resolve({ bars: [], exhausted: true })));
      }
      return Promise.resolve({ bars: [], exhausted: true });
    },
    subscribe(market, handlers) {
      counts.setup++;
      inspect?.('setup');
      // The monitor uses the same provider, so tests distinguish feeds by later
      // query/resource snapshots rather than assuming every subscribe is a chart.
      const entry: Entry = { query: { ...market }, handlers, active: true, kind: 'chart' };
      entries.push(entry);
      queueMicrotask(() => {
        if (entry.active) handlers.onOpen();
      });
      return () => {
        if (!entry.active) return;
        entry.active = false;
        counts.teardown++;
        inspect?.('teardown');
      };
    },
  };
  return {
    provider,
    snapshot: () => ({ ...counts, active: entries.filter((entry) => entry.active).length }),
    setupQueries: () => entries.map((entry) => `${entry.query.symbol}/${entry.query.interval}`),
    setInspector: (next: ((phase: 'history' | 'setup' | 'teardown') => void) | null) => {
      inspect = next;
    },
    holdNextHistory: () => {
      holdNextHistory = true;
    },
    resolveHeldHistory: () => {
      const ready = heldHistory.splice(0);
      ready.forEach((resolve) => resolve());
      return ready.length;
    },
    emit: (market: MarketQuery, value: number, time: number) => {
      for (const entry of [...entries])
        if (entry.active && entry.query.symbol === market.symbol && entry.query.interval === market.interval)
          entry.handlers.onBar(bar(time, value));
    },
    close: (market: MarketQuery) => {
      for (const entry of [...entries])
        if (entry.active && entry.query.symbol === market.symbol && entry.query.interval === market.interval)
          entry.handlers.onClose();
    },
    oldHandlers: () => entries.map((entry) => entry.handlers),
  };
}

function host(): HTMLDivElement {
  const node = document.createElement('div');
  node.style.width = '1000px';
  node.style.height = '1200px';
  document.body.append(node);
  return node;
}

function baseOptions(
  provider: MarketDataProvider,
  extra: Partial<TerminalGridOptions> = {},
): TerminalGridOptions {
  return { provider, query: query(), symbols, intervals, feed: { mode: 'latest' }, ...extra };
}

function workspaceOf(grid: TerminalGridApi): TerminalGridWorkspace {
  return grid.getWorkspace();
}

async function waitForLive(grid: TerminalGridApi, id: TerminalGridCellId): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (grid.getTerminal(id)?.getState().feed.status === 'live') return;
    await Promise.resolve();
  }
  throw new Error(
    `${id} did not reach live feed state: ${JSON.stringify(grid.getTerminal(id)?.getState().feed ?? null)}`,
  );
}

async function waitForMonitoredQuery(grid: TerminalGridApi, market: MarketQuery): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      grid
        .getState()
        .alertState.queries.some(
          (entry) =>
            entry.query.symbol === market.symbol &&
            entry.query.interval === market.interval &&
            entry.status === 'monitoring',
        )
    )
      return;
    await Promise.resolve();
  }
  throw new Error(`Alert query ${market.symbol}/${market.interval} did not become monitored`);
}

function resources(
  stores: ReturnType<typeof createPriceAlertStore>[],
  monitor: ReturnType<typeof createPriceAlertMonitor>,
) {
  return {
    stores: stores.map((store) => getPriceAlertStoreResourceSnapshot(store)),
    monitor: getPriceAlertMonitorResourceSnapshot(monitor),
  };
}

async function independentSlots() {
  const feed = fixtureProvider();
  const node = host();
  const grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      layout: 4,
      settings: { theme: 'light', volume: false },
      studies: [{ kind: 'sma', period: 7 }],
    }),
  );
  try {
    const initial = workspaceOf(grid);
    const first = grid.getTerminal('cell-1');
    const second = grid.getTerminal('cell-2');
    const third = grid.getTerminal('cell-3');
    const fourth = grid.getTerminal('cell-4');
    await Promise.all([
      second!.setMarket(query('ETHUSDT', '5m')),
      third!.setMarket(query('SOLUSDT', '1h')),
      fourth!.setMarket(query('ADAUSDT', '1d')),
    ]);
    second!.applySettings({ theme: 'dark' });
    third!.addStudy({ kind: 'rsi', period: 9 });
    fourth!.getDrawings().add({ type: 'horizontal-line', points: [{ time: 1000, price: 17 }] });
    second!.applyLayout({ studiesOpen: true });
    grid.setActiveCell('cell-4');
    grid.setSync({ viewport: true, crosshair: true, crosshairMatch: 'nearest' });
    const beforePark = workspaceOf(grid);
    await grid.setLayout(1);
    const parked = {
      state: grid.getState(),
      terminal2: grid.getTerminal('cell-2'),
      terminal4: grid.getTerminal('cell-4'),
      firstRetained: grid.getTerminal('cell-1') === first,
      workspace: workspaceOf(grid),
    };
    await grid.setLayout(4);
    const expanded = workspaceOf(grid);
    const retained = grid.getTerminal('cell-1') === first;
    const remounted =
      grid.getTerminal('cell-2') !== second &&
      grid.getTerminal('cell-3') !== third &&
      grid.getTerminal('cell-4') !== fourth;
    const copy = workspaceOf(grid);
    copy.cells[0]!.workspace.settings.theme = 'dark';
    const copiesDefensive = workspaceOf(grid).cells[0]!.workspace.settings.theme === 'light';
    grid.destroy();
    const finalState = grid.getState();
    const finalWorkspace = workspaceOf(grid);
    let destroyedMutation = false;
    try {
      grid.setActiveCell('cell-1');
    } catch {
      destroyedMutation = true;
    }
    const destroyedAsync = { layout: false, restore: false, sync: false };
    try {
      await grid.setLayout(2);
    } catch {
      destroyedAsync.layout = true;
    }
    try {
      await grid.restoreWorkspace(expanded);
    } catch {
      destroyedAsync.restore = true;
    }
    try {
      grid.setSync({ viewport: false });
    } catch {
      destroyedAsync.sync = true;
    }
    let invalidCellRejected = false;
    try {
      grid.getTerminal('wrong-cell' as TerminalGridCellId);
    } catch {
      invalidCellRejected = true;
    }
    return {
      initial,
      beforePark,
      parked,
      expanded,
      retained,
      remounted,
      copiesDefensive,
      finalState,
      finalWorkspace,
      destroyedMutation,
      destroyedAsync,
      invalidCellRejected,
      children: node.childElementCount,
      provider: feed.snapshot(),
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function parkedAlerts() {
  const feed = fixtureProvider();
  const node = host();
  const events: Array<{ cellId: string; alertId: string; occurrence: number; scopeId: string }> = [];
  const grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      layout: 4,
      onAlert: (cellId, event) =>
        events.push({ cellId, alertId: event.alertId, occurrence: event.occurrence, scopeId: event.scopeId }),
    }),
  );
  try {
    const second = grid.getTerminal('cell-2')!;
    const alertQuery = query('BTCUSDT', '1m');
    const id = second
      .getAlerts()
      .add({ query: alertQuery, price: 100, condition: 'crosses-up', frequency: 'once' });
    await second.setMarket(query('ETHUSDT', '5m'));
    const mountedId = second
      .getAlerts()
      .add({ query: query('ETHUSDT', '5m'), price: 100, condition: 'crosses-up', frequency: 'repeat' });
    await waitForMonitoredQuery(grid, query('ETHUSDT', '5m'));
    feed.emit(query('ETHUSDT', '5m'), 90, 1000);
    feed.emit(query('ETHUSDT', '5m'), 110, 2000);
    grid.setActiveCell('cell-3');
    await grid.setLayout(1);
    const savedBefore = workspaceOf(grid);
    feed.emit(alertQuery, 90, 3000);
    feed.emit(alertQuery, 110, 4000);
    const afterCrossing = workspaceOf(grid);
    await grid.restoreWorkspace(afterCrossing);
    await grid.setLayout(4);
    const expanded = workspaceOf(grid);
    const finalAlert = grid
      .getTerminal('cell-2')!
      .getAlerts()
      .list()
      .find((rule) => rule.id === id);
    grid.destroy();
    return {
      id,
      mountedId,
      savedBefore,
      afterCrossing,
      expanded,
      events,
      finalAlert,
      provider: feed.snapshot(),
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

function faultingDependencies(
  failAt: number | { value: number },
  counter: { value: number; charts: number; feeds: number },
) {
  return {
    prepareTerminal: (
      element: HTMLElement,
      options: Parameters<typeof prepareTerminalWithDependencies>[1],
      workspace: Parameters<typeof prepareTerminalWithDependencies>[2],
    ) =>
      prepareTerminalWithDependencies(element, options, workspace, {
        createChart(...args: Parameters<typeof createChart>) {
          const chart = createChart(...args);
          counter.charts++;
          return {
            ...chart,
            destroy() {
              counter.charts--;
              chart.destroy();
            },
          };
        },
        createFeedSession(...args: Parameters<typeof createFeedSession>) {
          counter.value++;
          if (counter.value === (typeof failAt === 'number' ? failAt : failAt.value))
            throw new Error('injected fourth feed construction failure');
          const session = createFeedSession(...args);
          counter.feeds++;
          return {
            ...session,
            destroy() {
              counter.feeds--;
              session.destroy();
            },
          };
        },
      }),
  };
}

function chartTrackingDependencies() {
  const counts = { history: 0, setup: 0, teardown: 0 };
  return {
    counts,
    dependencies: {
      prepareTerminal(
        element: HTMLElement,
        options: Parameters<typeof prepareTerminalWithDependencies>[1],
        workspace: Parameters<typeof prepareTerminalWithDependencies>[2],
      ) {
        return prepareTerminalWithDependencies(element, options, workspace, {
          createFeedSession(configuration) {
            const original = configuration.provider;
            const chartProvider: MarketDataProvider = {
              id: original.id,
              revisionMode: original.revisionMode,
              maxPageSize: original.maxPageSize,
              getHistory(request, signal) {
                counts.history++;
                return original.getHistory(request, signal);
              },
              subscribe(market, handlers) {
                counts.setup++;
                const release = original.subscribe(market, handlers);
                let active = true;
                return () => {
                  if (!active) return;
                  active = false;
                  counts.teardown++;
                  release();
                };
              },
            };
            return createFeedSession({ ...configuration, provider: chartProvider });
          },
        });
      },
    },
  };
}

function monitorCalls(
  total: { history: number; setup: number; teardown: number },
  chart: { history: number; setup: number; teardown: number },
) {
  return {
    history: total.history - chart.history,
    setup: total.setup - chart.setup,
    teardown: total.teardown - chart.teardown,
  };
}

async function trackResources<T>(work: () => Promise<T>): Promise<{
  value: T;
  listeners: number;
  observers: number;
  timers: number;
  frames: number;
  residualListeners: string[];
}> {
  const target = EventTarget.prototype;
  const nativeAdd = target.addEventListener;
  const nativeRemove = target.removeEventListener;
  const NativeResizeObserver = window.ResizeObserver;
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const nativeRequestFrame = window.requestAnimationFrame;
  const nativeCancelFrame = window.cancelAnimationFrame;
  const listeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  }> = [];
  const observers = new Set<ResizeObserver>();
  const timers = new Set<number>();
  const frames = new Set<number>();
  const capture = (options?: boolean | AddEventListenerOptions | EventListenerOptions) =>
    typeof options === 'boolean' ? options : Boolean(options?.capture);
  target.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (
      listener &&
      !listeners.some(
        (item) =>
          item.target === this &&
          item.type === type &&
          item.listener === listener &&
          item.capture === capture(options),
      )
    )
      listeners.push({ target: this, type, listener, capture: capture(options) });
    return nativeAdd.call(this, type, listener, options);
  };
  target.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    const index = listeners.findIndex(
      (item) =>
        item.target === this &&
        item.type === type &&
        item.listener === listener &&
        item.capture === capture(options),
    );
    if (index >= 0) listeners.splice(index, 1);
    return nativeRemove.call(this, type, listener, options);
  };
  class TrackedResizeObserver implements ResizeObserver {
    private readonly inner: ResizeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.inner = new NativeResizeObserver(callback);
      observers.add(this);
    }
    observe(element: Element, options?: ResizeObserverOptions): void {
      this.inner.observe(element, options);
    }
    unobserve(element: Element): void {
      this.inner.unobserve(element);
    }
    disconnect(): void {
      this.inner.disconnect();
      observers.delete(this);
    }
  }
  window.ResizeObserver = TrackedResizeObserver;
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    let id = 0;
    id = nativeSetTimeout.call(
      window,
      () => {
        timers.delete(id);
        if (typeof handler === 'function') (handler as (...values: unknown[]) => void)(...args);
      },
      timeout,
    ) as unknown as number;
    timers.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
    nativeClearTimeout.call(window, id);
  }) as typeof window.clearTimeout;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    let id = 0;
    id = nativeRequestFrame.call(window, (time) => {
      frames.delete(id);
      callback(time);
    });
    frames.add(id);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    frames.delete(id);
    nativeCancelFrame.call(window, id);
  }) as typeof window.cancelAnimationFrame;
  try {
    const value = await work();
    return {
      value,
      listeners: listeners.length,
      observers: observers.size,
      timers: timers.size,
      frames: frames.size,
      residualListeners: listeners.map(
        (item) =>
          `${item.type}:${item.target instanceof Element ? item.target.tagName : item.target.constructor.name}`,
      ),
    };
  } finally {
    target.addEventListener = nativeAdd;
    target.removeEventListener = nativeRemove;
    window.ResizeObserver = NativeResizeObserver;
    window.setTimeout = nativeSetTimeout;
    window.clearTimeout = nativeClearTimeout;
    window.requestAnimationFrame = nativeRequestFrame;
    window.cancelAnimationFrame = nativeCancelFrame;
  }
}

async function monitorContinuity() {
  const feed = fixtureProvider();
  const node = host();
  const monitor = createPriceAlertMonitor({ provider: feed.provider });
  const stores = ids.map((id) =>
    createPriceAlertStore({ providerId: feed.provider.id, scopeId: `continuity:${id}` }),
  );
  const storeRecord = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
    Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
  >;
  const events: string[] = [];
  const queries = ids.map((_, index) => query(symbols[index]!, '1m'));
  for (let index = 0; index < 4; index++)
    stores[index]!.add({
      query: queries[index]!,
      price: 100,
      condition: 'crosses-up',
      frequency: index === 3 ? 'once' : 'repeat',
    });
  const chart = chartTrackingDependencies();
  let states = 0;
  const grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      alerts: { monitor, stores: storeRecord },
      onState: () => states++,
      onAlert: (id) => events.push(id),
    }),
    chart.dependencies,
  );
  try {
    await waitForLive(grid, 'cell-1');
    for (let index = 0; index < 4; index++) feed.emit(queries[index]!, 90, 1000);
    const first = grid.getTerminal('cell-1');
    const before = {
      total: feed.snapshot(),
      chart: { ...chart.counts },
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
    };
    await grid.setLayout(2);
    await grid.setLayout(4);
    await grid.setLayout(1);
    const after = {
      total: feed.snapshot(),
      chart: { ...chart.counts },
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
    };
    const retained = grid.getTerminal('cell-1') === first;
    const stateBeforeEdit = states;
    first!.applySettings({ theme: 'light' });
    const stateAfterEdit = states;
    feed.emit(queries[3]!, 110, 2000);
    const parkedRule = stores[3]!.list()[0];
    grid.destroy();
    const final = {
      total: feed.snapshot(),
      chart: { ...chart.counts },
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      stores: stores.map((store) => getPriceAlertStoreResourceSnapshot(store)),
    };
    return {
      before,
      after,
      final,
      retained,
      stateBeforeEdit,
      stateAfterEdit,
      events,
      parkedRule,
      monitorBefore: monitorCalls(before.total, before.chart),
      monitorAfter: monitorCalls(after.total, after.chart),
      children: node.childElementCount,
    };
  } finally {
    grid.destroy();
    monitor.destroy();
    stores.forEach((store) => store.destroy());
    node.remove();
  }
}

async function atomicFourthFailure() {
  const feed = fixtureProvider();
  const node = host();
  const counts = { value: 0, charts: 0, feeds: 0 };
  let initialFailure = '';
  try {
    createTerminalGridWithDependencies(
      node,
      baseOptions(feed.provider, { layout: 4 }),
      faultingDependencies(4, counts),
    );
  } catch (error) {
    initialFailure = String(error);
  }
  const initial = {
    failure: initialFailure,
    counts: { ...counts },
    provider: feed.snapshot(),
    children: node.childElementCount,
  };
  counts.value = 0;
  const grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, { layout: 1 }),
    faultingDependencies(5, counts),
  );
  try {
    await waitForLive(grid, 'cell-1');
    const before = workspaceOf(grid);
    const live = grid.getTerminal('cell-1');
    const oldNode = node.querySelector('[data-filtix-terminal-grid]');
    const providerBefore = feed.snapshot();
    counts.value = 1; // The already mounted cell was construction number one.
    const savedFour = { ...before, layout: 4 as const };
    let restoreFailure = '';
    try {
      await grid.restoreWorkspace(savedFour);
    } catch (error) {
      restoreFailure = String(error);
    }
    return {
      initial,
      restoreFailure,
      before,
      after: workspaceOf(grid),
      sameTerminal: grid.getTerminal('cell-1') === live,
      sameNode: node.querySelector('[data-filtix-terminal-grid]') === oldNode,
      providerBefore,
      providerAfter: feed.snapshot(),
      counts: { ...counts },
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function borrowedCleanup() {
  const feed = fixtureProvider();
  const node = host();
  const monitor = createPriceAlertMonitor({ provider: feed.provider });
  const stores = ids.map((id) =>
    createPriceAlertStore({ providerId: feed.provider.id, scopeId: `grid-fixture:${id}` }),
  );
  const supplied = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
    Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
  >;
  const external = monitor.attach(stores[0]!);
  const before = resources(stores, monitor);
  const grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, { alerts: { monitor, stores: supplied } }),
  );
  grid.destroy();
  const after = resources(stores, monitor);
  const stillUsable = stores[0]!.add({
    query: query(),
    price: 100,
    condition: 'crosses-up',
    frequency: 'repeat',
  });
  external();
  monitor.destroy();
  stores.forEach((store) => store.destroy());
  node.remove();
  return { before, after, stillUsable, children: node.childElementCount, provider: feed.snapshot() };
}

async function preferenceReentry() {
  const feed = fixtureProvider();
  const node = host();
  let grid: TerminalGridApi | null = null;
  let reentered = false;
  grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      onState(state) {
        if (!grid || reentered || state.layout !== 4) return;
        reentered = true;
        grid.setActiveCell('cell-2');
        grid.setSync({ viewport: true });
      },
    }),
  );
  try {
    await waitForLive(grid, 'cell-1');
    let layoutError: string | null = null;
    try {
      await grid.setLayout(4);
    } catch (error) {
      layoutError = String(error);
    }
    const mounted = ids.map((id) => grid!.getTerminal(id));
    const statuses = mounted.map((terminal) => terminal?.getState().feed.status ?? null);
    const usable = mounted.map((terminal) => {
      try {
        terminal!.addStudy({ kind: 'sma', period: 6 });
        return true;
      } catch {
        return false;
      }
    });
    return { reentered, layoutError, state: grid.getState(), statuses, usable };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function invalidSuppliedStores() {
  const results = [];
  for (const missing of [null, undefined]) {
    const feed = fixtureProvider();
    const node = host();
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const stores = ids
      .slice(0, 3)
      .map((id) => createPriceAlertStore({ providerId: feed.provider.id, scopeId: `incomplete:${id}` }));
    const entries = {
      'cell-1': stores[0]!,
      'cell-2': stores[1]!,
      'cell-3': stores[2]!,
      'cell-4': missing,
    } as unknown as Readonly<Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>>;
    let grid: TerminalGridApi | null = null;
    let failure = '';
    let states = 0;
    try {
      grid = createTerminalGridWithDependencies(
        node,
        baseOptions(feed.provider, {
          alerts: { monitor, stores: entries },
          onState: () => states++,
        }),
      );
    } catch (error) {
      failure = String(error);
    }
    grid?.destroy();
    const beforeExternalCleanup = {
      rejected: grid === null,
      failure,
      states,
      provider: feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      stores: stores.map((store) => getPriceAlertStoreResourceSnapshot(store)),
      stillUsable: stores[0]!.add({
        query: query(),
        price: 99,
        condition: 'crosses-up',
        frequency: 'repeat',
      }),
      children: node.childElementCount,
    };
    monitor.destroy();
    stores.forEach((store) => store.destroy());
    node.remove();
    results.push(beforeExternalCleanup);
  }
  return results;
}

async function invalidNestedRestore() {
  const feed = fixtureProvider();
  const node = host();
  let grid: TerminalGridApi | null = null;
  let attempted = false;
  let nestedError = '';
  grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      onState(state) {
        if (!grid || attempted || state.layout !== 4) return;
        attempted = true;
        void grid.restoreWorkspace({}).catch((error) => {
          nestedError = String(error);
        });
      },
    }),
  );
  try {
    await waitForLive(grid, 'cell-1');
    let layoutError = '';
    try {
      await grid.setLayout(4);
    } catch (error) {
      layoutError = String(error);
    }
    await Promise.resolve();
    const mounted = ids.map((id) => grid!.getTerminal(id));
    const usable = mounted.map((terminal) => {
      try {
        terminal!.addStudy({ kind: 'sma', period: 6 });
        return true;
      } catch {
        return false;
      }
    });
    return {
      attempted,
      nestedError,
      layoutError,
      state: grid.getState(),
      usable,
      statuses: mounted.map((terminal) => terminal?.getState().feed.status ?? null),
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function boundaryRestore() {
  const feed = fixtureProvider();
  const node = host();
  const monitor = createPriceAlertMonitor({ provider: feed.provider });
  const boundarySymbols = Array.from({ length: 8 }, (_, index) => `S${index}`);
  const boundaryIntervals = ['1m', '5m', '1h', '1d'];
  const stores = ids.map((id) =>
    createPriceAlertStore({ providerId: feed.provider.id, scopeId: `boundary:${id}` }),
  );
  const unrelated = createPriceAlertStore({ providerId: feed.provider.id, scopeId: 'boundary:unrelated' });
  const unrelatedLease = monitor.attach(unrelated);
  const storeRecord = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
    Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
  >;
  let onceId = '';
  for (let cell = 0; cell < 4; cell++) {
    for (let rule = 0; rule < 100; rule++) {
      const key = cell * 8 + (rule % 8);
      const market = query(boundarySymbols[Math.floor(key / 4)]!, boundaryIntervals[key % 4]!);
      const id = stores[cell]!.add({
        query: market,
        price: 100,
        condition: 'crosses-up',
        frequency: cell === 3 && rule === 0 ? 'once' : 'repeat',
      });
      if (cell === 3 && rule === 0) onceId = id;
    }
  }
  const events: Array<{ cellId: string; alertId: string; occurrence: number }> = [];
  const threshold = { value: Number.MAX_SAFE_INTEGER };
  const construction = { value: 0, charts: 0, feeds: 0 };
  let staleOnNextCommit = false;
  const injected = faultingDependencies(threshold, construction);
  const grid = createTerminalGridWithDependencies(
    node,
    {
      provider: feed.provider,
      query: query('S0', '1m'),
      symbols: boundarySymbols,
      intervals: boundaryIntervals,
      layout: 4,
      alerts: { monitor, stores: storeRecord },
      onAlert: (cellId, event) =>
        events.push({ cellId, alertId: event.alertId, occurrence: event.occurrence }),
    },
    {
      ...injected,
      prepareMembership(target, options) {
        const real = prepareAlertMembershipReplacement(target, options);
        return {
          ...real,
          commit() {
            if (staleOnNextCommit) {
              staleOnNextCommit = false;
              const current = unrelated.toJSON();
              unrelated.restore({ ...current, nextRuleId: current.nextRuleId + 1 });
            }
            return real.commit();
          },
        };
      },
    },
  );
  try {
    await waitForLive(grid, 'cell-1');
    const saved = workspaceOf(grid);
    const oldTerminal = grid.getTerminal('cell-1');
    const initial = getPriceAlertMonitorResourceSnapshot(monitor);
    await grid.restoreWorkspace(saved);
    const roundTrip = workspaceOf(grid);
    const afterRestore = getPriceAlertMonitorResourceSnapshot(monitor);
    oldTerminal!.destroy(); // Its consumed C lease cannot detach replacement members.
    const afterConsumedRelease = getPriceAlertMonitorResourceSnapshot(monitor);
    for (const id of ids) await waitForLive(grid, id);
    const beforeFourthFailure = workspaceOf(grid);
    const beforeFourthTerminal = grid.getTerminal('cell-1');
    const providerBeforeFourth = feed.snapshot();
    threshold.value = construction.value + 4;
    let fourthFailure = '';
    try {
      await grid.restoreWorkspace(beforeFourthFailure);
    } catch (failure) {
      fourthFailure = String(failure);
    }
    threshold.value = Number.MAX_SAFE_INTEGER;
    const afterFourthFailure = workspaceOf(grid);
    const sameFourthTerminal = grid.getTerminal('cell-1') === beforeFourthTerminal;
    const providerAfterFourth = feed.snapshot();
    const stagedAfterFourth = { ...construction };
    staleOnNextCommit = true;
    const beforeStale = workspaceOf(grid);
    const providerBeforeStale = feed.snapshot();
    let staleFailure = '';
    try {
      await grid.restoreWorkspace(beforeStale);
    } catch (failure) {
      staleFailure = String(failure);
    }
    const afterStale = workspaceOf(grid);
    const providerAfterStale = feed.snapshot();
    const afterStaleMonitor = getPriceAlertMonitorResourceSnapshot(monitor);
    await grid.setLayout(1);
    const onceQuery = query('S6', '1m'); // Cell 4's first of eight exact keys.
    feed.emit(onceQuery, 90, 1000);
    feed.emit(onceQuery, 110, 2000);
    const parkedSaved = workspaceOf(grid);
    await grid.setLayout(4);
    for (const id of ids) await waitForLive(grid, id);
    const expanded = workspaceOf(grid);
    const live = grid.getTerminal('cell-1');
    const externallyHeldStore = live!.getAlerts();
    const externalLease = monitor.attach(externallyHeldStore);
    const beforeConflict = workspaceOf(grid);
    const providerBeforeConflict = feed.snapshot();
    let conflictError = '';
    try {
      await grid.restoreWorkspace(beforeConflict);
    } catch (error) {
      conflictError = String(error);
    }
    const afterConflict = workspaceOf(grid);
    const sameTerminal = grid.getTerminal('cell-1') === live;
    const providerAfterConflict = feed.snapshot();
    externalLease();
    grid.destroy();
    unrelatedLease();
    const final = {
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      provider: feed.snapshot(),
      oldStores: stores.map((store) => getPriceAlertStoreResourceSnapshot(store)),
      unrelated: getPriceAlertStoreResourceSnapshot(unrelated),
    };
    return {
      saved,
      roundTrip,
      initial,
      afterRestore,
      afterConsumedRelease,
      fourthFailure,
      beforeFourthFailure,
      afterFourthFailure,
      sameFourthTerminal,
      providerBeforeFourth,
      providerAfterFourth,
      stagedAfterFourth,
      staleFailure,
      beforeStale,
      afterStale,
      providerBeforeStale,
      providerAfterStale,
      afterStaleMonitor,
      onceId,
      parkedSaved,
      expanded,
      events,
      conflictError,
      beforeConflict,
      afterConflict,
      sameTerminal,
      providerBeforeConflict,
      providerAfterConflict,
      final,
      children: node.childElementCount,
    };
  } finally {
    grid.destroy();
    unrelatedLease();
    monitor.destroy();
    stores.forEach((store) => store.destroy());
    unrelated.destroy();
    node.remove();
  }
}

async function revisionRejections() {
  const results = [];
  for (const mode of ['old-store', 'unrelated-store', 'grid'] as const) {
    const feed = fixtureProvider();
    const node = host();
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const stores = ids.map((id) =>
      createPriceAlertStore({ providerId: feed.provider.id, scopeId: `revision:${mode}:${id}` }),
    );
    const unrelated = createPriceAlertStore({
      providerId: feed.provider.id,
      scopeId: `revision:${mode}:unrelated`,
    });
    const externalLease = monitor.attach(unrelated);
    const storeRecord = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
      Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
    >;
    let transactionNumber = 0;
    let constructionNumber = 0;
    let grid: TerminalGridApi | null = null;
    const dependencies = {
      prepareMembership(
        target: typeof monitor,
        options: Parameters<typeof prepareAlertMembershipReplacement>[1],
      ) {
        const real = prepareAlertMembershipReplacement(target, options);
        transactionNumber++;
        if (transactionNumber !== 2 || mode === 'grid') return real;
        return {
          ...real,
          commit() {
            const changed = mode === 'old-store' ? stores[2]! : unrelated;
            changed.add({
              query: query('ETHUSDT', '1m'),
              price: 100,
              condition: 'crosses-up',
              frequency: 'repeat',
            });
            return real.commit();
          },
        };
      },
      prepareTerminal(
        element: HTMLElement,
        options: Parameters<typeof prepareTerminalWithDependencies>[1],
        workspace: Parameters<typeof prepareTerminalWithDependencies>[2],
      ) {
        const prepared = prepareTerminalWithDependencies(element, options, workspace, { createFeedSession });
        constructionNumber++;
        if (mode === 'grid' && constructionNumber === 5) grid!.setSync({ viewport: true });
        return prepared;
      },
    };
    grid = createTerminalGridWithDependencies(
      node,
      baseOptions(feed.provider, { alerts: { monitor, stores: storeRecord } }),
      dependencies,
    );
    try {
      await waitForLive(grid, 'cell-1');
      const before = workspaceOf(grid);
      const oldTerminal = grid.getTerminal('cell-1');
      const oldNode = node.querySelector('[data-filtix-terminal-grid]');
      let failure = '';
      try {
        await grid.restoreWorkspace({ ...before, layout: 4 });
      } catch (error) {
        failure = String(error);
      }
      results.push({
        mode,
        failure,
        before,
        after: workspaceOf(grid),
        sameTerminal: grid.getTerminal('cell-1') === oldTerminal,
        sameNode: node.querySelector('[data-filtix-terminal-grid]') === oldNode,
        state: grid.getState(),
        unrelatedRules: unrelated.list().length,
        oldStoreRules: stores[2]!.list().length,
        monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      });
    } finally {
      grid.destroy();
      externalLease();
      monitor.destroy();
      stores.forEach((store) => store.destroy());
      unrelated.destroy();
      node.remove();
    }
  }
  return results;
}

async function adoptionReentry() {
  const results = [];
  for (const mode of ['observe', 'nested-layout', 'nested-restore', 'destroy'] as const) {
    const feed = fixtureProvider();
    const node = host();
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const stores = ids.map((id) =>
      createPriceAlertStore({ providerId: feed.provider.id, scopeId: `adoption:${mode}:${id}` }),
    );
    stores[1]!.add({ query: query('BTCUSDT', '1m'), price: 100, condition: 'crosses-up', frequency: 'once' });
    const storeRecord = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
      Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
    >;
    let alertEvents = 0;
    let grid: TerminalGridApi | null = createTerminalGridWithDependencies(
      node,
      baseOptions(feed.provider, { alerts: { monitor, stores: storeRecord }, onAlert: () => alertEvents++ }),
    );
    try {
      await waitForLive(grid, 'cell-1');
      await waitForMonitoredQuery(grid, query('BTCUSDT', '1m'));
      feed.emit(query('BTCUSDT', '1m'), 90, 1000);
      const before = workspaceOf(grid);
      const obsolete = feed.oldHandlers();
      feed.holdNextHistory();
      const pendingOldHistory = grid.getTerminal('cell-1')!.setMarket(query('ETHUSDT', '5m'));
      await Promise.resolve();
      const preRestoreProvider = feed.snapshot();
      const preRestoreQueries = feed.setupQueries();
      const observations: Array<{
        phase: string;
        layout: number;
        cells: number;
        active: string;
        workspaceLayout: number;
      }> = [];
      let nested: Promise<void> | null = null;
      let intervened = false;
      feed.setInspector((phase) => {
        if (!grid || (mode !== 'observe' && intervened)) return;
        if (mode !== 'observe' && phase !== 'teardown') return;
        // The old-chart teardown and every replacement setup follow canonical adoption.
        if (mode !== 'observe') intervened = true;
        const state = grid.getState();
        observations.push({
          phase,
          layout: state.layout,
          cells: node.querySelector('[data-filtix-terminal-grid]')?.children.length ?? -1,
          active: state.activeCellId,
          workspaceLayout: grid.getWorkspace().layout,
        });
        if (mode === 'nested-layout') nested = grid.setLayout(2);
        if (mode === 'nested-restore') nested = grid.restoreWorkspace({ ...grid.getWorkspace(), layout: 2 });
        if (mode === 'destroy') grid.destroy();
      });
      let restoreError = '';
      try {
        await grid.restoreWorkspace({ ...before, layout: 4 });
      } catch (error) {
        restoreError = String(error);
      }
      feed.setInspector(null);
      const historyResolved = feed.resolveHeldHistory();
      try {
        await pendingOldHistory;
      } catch {
        /* Old terminal was retired. */
      }
      let nestedError = '';
      if (nested)
        try {
          await nested;
        } catch (error) {
          nestedError = String(error);
        }
      const beforeObsolete = workspaceOf(grid);
      for (const handlers of obsolete) {
        handlers.onBar(bar(3000, 150));
        handlers.onClose();
      }
      const afterObsolete = workspaceOf(grid);
      const finalState = grid.getState();
      const resourcesBeforeCleanup = getPriceAlertMonitorResourceSnapshot(monitor);
      grid.destroy();
      results.push({
        mode,
        observations,
        restoreError,
        nestedError,
        beforeObsolete,
        afterObsolete,
        alertEvents,
        historyResolved,
        preRestoreProvider,
        preRestoreQueries,
        finalState,
        resourcesBeforeCleanup,
        afterCleanup: getPriceAlertMonitorResourceSnapshot(monitor),
        provider: feed.snapshot(),
        children: node.childElementCount,
      });
    } finally {
      feed.setInspector(null);
      grid?.destroy();
      monitor.destroy();
      stores.forEach((store) => store.destroy());
      node.remove();
    }
  }
  return results;
}

async function alertReentry() {
  const results = [];
  for (const mode of ['layout', 'restore', 'destroy'] as const) {
    const feed = fixtureProvider();
    const node = host();
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const stores = ids.map((id) =>
      createPriceAlertStore({ providerId: feed.provider.id, scopeId: `alert-reentry:${mode}:${id}` }),
    );
    const storeRecord = Object.fromEntries(ids.map((id, index) => [id, stores[index]!])) as Readonly<
      Record<TerminalGridCellId, ReturnType<typeof createPriceAlertStore>>
    >;
    const ruleId = stores[1]!.add({ query: query(), price: 100, condition: 'crosses-up', frequency: 'once' });
    let grid: TerminalGridApi | null = null;
    let nested: Promise<void> | null = null;
    const events: Array<{ id: string; occurrence: number; immutable: boolean; seenLayout: number }> = [];
    grid = createTerminalGridWithDependencies(
      node,
      baseOptions(feed.provider, {
        layout: 4,
        alerts: { monitor, stores: storeRecord },
        onAlert(_cell, event) {
          events.push({
            id: event.alertId,
            occurrence: event.occurrence,
            immutable: Object.isFrozen(event) && Object.isFrozen(event.query),
            seenLayout: grid!.getState().layout,
          });
          if (mode === 'layout') nested = grid!.setLayout(1);
          if (mode === 'restore') nested = grid!.restoreWorkspace(grid!.getWorkspace());
          if (mode === 'destroy') grid!.destroy();
        },
      }),
    );
    try {
      await waitForLive(grid, 'cell-1');
      await waitForMonitoredQuery(grid, query());
      feed.emit(query(), 90, 1000);
      feed.emit(query(), 110, 2000);
      let nestedError = '';
      if (nested)
        try {
          await nested;
        } catch (error) {
          nestedError = String(error);
        }
      const state = grid.getState();
      const saved = workspaceOf(grid);
      grid.destroy();
      results.push({
        mode,
        ruleId,
        events,
        nestedError,
        state,
        saved,
        monitor: getPriceAlertMonitorResourceSnapshot(monitor),
        provider: feed.snapshot(),
        children: node.childElementCount,
      });
    } finally {
      grid.destroy();
      monitor.destroy();
      stores.forEach((store) => store.destroy());
      node.remove();
    }
  }
  return results;
}

async function nativeDomFailure() {
  const feed = fixtureProvider();
  const node = host();
  const grid = createTerminalGridWithDependencies(node, baseOptions(feed.provider));
  try {
    await waitForLive(grid, 'cell-1');
    const before = workspaceOf(grid);
    const oldTerminal = grid.getTerminal('cell-1');
    const region = node.querySelector<HTMLElement>('[data-filtix-terminal-grid]')!;
    const oldChild = region.firstElementChild;
    const providerBefore = feed.snapshot();
    const nativeReplace = region.replaceChildren.bind(region);
    let first = true;
    region.replaceChildren = (...nodes: (Node | string)[]) => {
      nativeReplace(...nodes);
      if (first) {
        first = false;
        throw new Error('injected native adoption fault');
      }
    };
    let failure = '';
    try {
      await grid.restoreWorkspace({ ...before, layout: 4 });
    } catch (error) {
      failure = String(error);
    }
    region.replaceChildren = nativeReplace;
    return {
      failure,
      before,
      after: workspaceOf(grid),
      sameTerminal: grid.getTerminal('cell-1') === oldTerminal,
      sameChild: region.firstElementChild === oldChild,
      providerBefore,
      providerAfter: feed.snapshot(),
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function ownedCleanup() {
  return trackResources(async () => {
    const feed = fixtureProvider();
    const node = host();
    const stores = new Set<ReturnType<typeof createPriceAlertStore>>();
    let monitor: ReturnType<typeof createPriceAlertMonitor> | null = null;
    let charts = 0;
    let sessions = 0;
    const grid = createTerminalGridWithDependencies(node, baseOptions(feed.provider, { layout: 4 }), {
      prepareMembership(target, options) {
        monitor = target;
        return prepareAlertMembershipReplacement(target, options);
      },
      prepareTerminal(element, options, workspace) {
        stores.add(options.alerts!.store!);
        return prepareTerminalWithDependencies(element, options, workspace, {
          createChart(...args) {
            const chart = createChart(...args);
            charts++;
            return {
              ...chart,
              destroy() {
                charts--;
                chart.destroy();
              },
            };
          },
          createFeedSession(...args) {
            const session = createFeedSession(...args);
            sessions++;
            return {
              ...session,
              destroy() {
                sessions--;
                session.destroy();
              },
            };
          },
        });
      },
    });
    try {
      for (const id of ids) await waitForLive(grid, id);
      const saved = workspaceOf(grid);
      await grid.setLayout(1);
      await grid.restoreWorkspace(saved);
      grid.destroy();
      return {
        charts,
        sessions,
        provider: feed.snapshot(),
        children: node.childElementCount,
        monitor: getPriceAlertMonitorResourceSnapshot(monitor!),
        stores: [...stores].map((store) => getPriceAlertStoreResourceSnapshot(store)),
      };
    } finally {
      grid.destroy();
      node.remove();
    }
  });
}

async function repairExhaustion() {
  const feed = fixtureProvider();
  const node = host();
  let grid: TerminalGridApi | null = null;
  let callbackMutations = 0;
  grid = createTerminalGridWithDependencies(
    node,
    baseOptions(feed.provider, {
      onState(state) {
        if (!grid || state.layout !== 2 || callbackMutations >= 8) return;
        callbackMutations++;
        grid.setActiveCell(state.activeCellId === 'cell-1' ? 'cell-2' : 'cell-1');
      },
    }),
  );
  try {
    await waitForLive(grid, 'cell-1');
    await grid.setLayout(2);
    return {
      callbackMutations,
      state: grid.getState(),
      mounted: ids.slice(0, 2).map((id) => grid!.getTerminal(id) !== null),
    };
  } finally {
    grid.destroy();
    node.remove();
  }
}

async function failedConstructionResources() {
  return trackResources(atomicFourthFailure);
}

type UiSession = {
  frame: HTMLDivElement;
  node: HTMLDivElement;
  grid: TerminalGridApi;
  feed: ReturnType<typeof fixtureProvider>;
  firstTerminal: ReturnType<TerminalGridApi['getTerminal']>;
  firstNode: Element | null;
  counters: { hostObservers: number; hostCallbacks: number; frames: number; states: number };
  stateObserver: { current: ((state: TerminalGridState) => void) | null };
  restoreGlobals(): void;
};
let uiSession: UiSession | null = null;
let uiLastFailure: {
  failure: string;
  hostObservers: number;
  children: number;
  provider: ReturnType<ReturnType<typeof fixtureProvider>['snapshot']>;
} | null = null;

function uiDestroy() {
  const session = uiSession;
  if (!session) return null;
  uiSession = null;
  session.grid.destroy();
  const result = {
    ...session.counters,
    hostObservers: session.counters.hostObservers,
    children: session.node.childElementCount,
    provider: session.feed.snapshot(),
  };
  session.frame.remove();
  session.restoreGlobals();
  return result;
}

function uiMount(width = 1000, height = 440, failHostObserve = false) {
  uiDestroy();
  uiLastFailure = null;
  const frame = document.createElement('div');
  frame.dataset.gridUiFrame = '';
  frame.style.cssText = 'width:100%;max-width:100vw;overflow:hidden';
  const node = document.createElement('div');
  node.dataset.gridUiHost = '';
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
  frame.append(node);
  document.body.append(frame);

  const nativeObserver = window.ResizeObserver;
  const nativeFrame = window.requestAnimationFrame;
  const counters = { hostObservers: 0, hostCallbacks: 0, frames: 0, states: 0 };
  const stateObserver: UiSession['stateObserver'] = { current: null };
  class UiTrackedResizeObserver implements ResizeObserver {
    private readonly inner: ResizeObserver;
    private readonly observed = new Set<Element>();
    private disconnected = false;
    constructor(callback: ResizeObserverCallback) {
      this.inner = new nativeObserver((entries) => {
        if (this.observed.has(node)) counters.hostCallbacks++;
        callback(entries, this);
      });
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      if (this.disconnected) return;
      if (target === node && failHostObserve) throw new Error('injected grid host observer failure');
      if (target === node && !this.observed.has(target)) counters.hostObservers++;
      this.observed.add(target);
      this.inner.observe(target, options);
    }
    unobserve(target: Element) {
      if (this.observed.delete(target) && target === node) counters.hostObservers--;
      this.inner.unobserve(target);
    }
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      if (this.observed.has(node)) counters.hostObservers--;
      this.observed.clear();
      this.inner.disconnect();
    }
  }
  window.ResizeObserver = UiTrackedResizeObserver;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    counters.frames++;
    return nativeFrame.call(window, callback);
  }) as typeof window.requestAnimationFrame;
  const restoreGlobals = () => {
    window.ResizeObserver = nativeObserver;
    window.requestAnimationFrame = nativeFrame;
  };
  const feed = fixtureProvider();
  try {
    const grid = createTerminalGridWithDependencies(
      node,
      baseOptions(feed.provider, {
        layout: 4,
        onState(state) {
          counters.states++;
          stateObserver.current?.(state);
        },
      }),
    );
    uiSession = {
      frame,
      node,
      grid,
      feed,
      firstTerminal: grid.getTerminal('cell-1'),
      firstNode: node.querySelector('[data-filtix-grid-cell="cell-1"]'),
      counters,
      stateObserver,
      restoreGlobals,
    };
    return grid.getState();
  } catch (failure) {
    uiLastFailure = {
      failure: String(failure),
      hostObservers: counters.hostObservers,
      children: node.childElementCount,
      provider: feed.snapshot(),
    };
    frame.remove();
    restoreGlobals();
    throw failure;
  }
}

function uiConstructionFailure() {
  try {
    uiMount(1000, 440, true);
    uiDestroy();
    return { failure: null };
  } catch {
    return uiLastFailure;
  }
}

function uiWidth(width: number, height = 440) {
  if (!uiSession) throw new Error('UI grid is not mounted');
  uiSession.node.style.width = `${width}px`;
  uiSession.node.style.height = `${height}px`;
}

function uiState() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  return uiSession.grid.getState();
}

function uiWorkspace() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  return uiSession.grid.getWorkspace();
}

function uiStats() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  return { ...uiSession.counters, provider: uiSession.feed.snapshot() };
}

function uiRetained() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  return {
    terminal: uiSession.grid.getTerminal('cell-1') === uiSession.firstTerminal,
    node: uiSession.node.querySelector('[data-filtix-grid-cell="cell-1"]') === uiSession.firstNode,
  };
}

async function uiSetLayout(layout: 1 | 2 | 4) {
  if (!uiSession) throw new Error('UI grid is not mounted');
  await uiSession.grid.setLayout(layout);
}

function uiSetActive(id: TerminalGridCellId) {
  if (!uiSession) throw new Error('UI grid is not mounted');
  uiSession.grid.setActiveCell(id);
}

async function uiSeedDistinct() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  const grid = uiSession.grid;
  const second = grid.getTerminal('cell-2')!;
  const third = grid.getTerminal('cell-3')!;
  const fourth = grid.getTerminal('cell-4')!;
  await Promise.all([
    second.setMarket(query('ETHUSDT', '5m')),
    third.setMarket(query('SOLUSDT', '1h')),
    fourth.setMarket(query('ADAUSDT', '1d')),
  ]);
  grid.getTerminal('cell-1')!.applySettings({ theme: 'light', volume: false });
  second.applySettings({ theme: 'dark' });
  second.applyLayout({ studiesOpen: true });
  const studyId = third.addStudy({ kind: 'rsi', period: 9 });
  third.applyLayout({ panes: [{ id: `terminal-${studyId}-pane`, weight: 0.65 }] });
  fourth.getDrawings().add({ type: 'horizontal-line', points: [{ time: 1000, price: 17 }] });
  return grid.getWorkspace();
}

async function uiRestore(value: unknown) {
  if (!uiSession) throw new Error('UI grid is not mounted');
  await uiSession.grid.restoreWorkspace(value);
}

async function uiSupersededFocusRepair(phase: 'first' | 'second' = 'first') {
  if (!uiSession) throw new Error('UI grid is not mounted');
  const session = uiSession;
  const grid = session.grid;
  await grid.setLayout(1);
  const symbol = session.node.querySelector<HTMLSelectElement>(
    '[data-filtix-grid-cell="cell-1"] [data-terminal-symbol]',
  )!;
  symbol.focus();
  const initialFocused = session.node.ownerDocument.activeElement === symbol;
  let successor: Promise<string> | null = null;
  let intervention: Promise<string> | null = null;
  let staleFocusEvents = 0;
  let layoutFourNotifications = 0;
  let phaseTriggeredAt = 0;
  const onFocus = () => {
    if (!successor || grid.getState().layout !== 4) return;
    staleFocusEvents++;
    if (!intervention)
      intervention = grid.setLayout(2).then(
        () => 'ok',
        (failure: unknown) => String(failure),
      );
  };
  symbol.addEventListener('focus', onFocus);
  session.stateObserver.current = (state) => {
    if (state.layout !== 4) return;
    layoutFourNotifications++;
    if (successor || layoutFourNotifications !== (phase === 'first' ? 1 : 2)) return;
    phaseTriggeredAt = layoutFourNotifications;
    successor = grid.setLayout(1).then(
      () => 'ok',
      (failure: unknown) => String(failure),
    );
  };
  try {
    const first = await grid.setLayout(4).then(
      () => 'ok',
      (failure: unknown) => String(failure),
    );
    const successorResult = successor ? await successor : null;
    const interventionResult = intervention ? await intervention : null;
    return {
      initialFocused,
      first,
      successor: successorResult,
      intervention: interventionResult,
      staleFocusEvents,
      layoutFourNotifications,
      phaseTriggeredAt,
      finalLayout: grid.getState().layout,
    };
  } finally {
    session.stateObserver.current = null;
    symbol.removeEventListener('focus', onFocus);
  }
}

async function uiRedirectedFocusDuringRepair() {
  if (!uiSession) throw new Error('UI grid is not mounted');
  const session = uiSession;
  const grid = session.grid;
  const first = session.node.querySelector<HTMLSelectElement>(
    '[data-filtix-grid-cell="cell-1"] [data-terminal-symbol]',
  )!;
  const second = session.node.querySelector<HTMLSelectElement>(
    '[data-filtix-grid-cell="cell-2"] [data-terminal-symbol]',
  )!;
  first.focus();
  let redirects = 0;
  const redirect = () => {
    redirects++;
    second.focus();
  };
  first.addEventListener('focus', redirect, { once: true });
  try {
    const layoutResult = await grid.setLayout(2).then(
      () => 'ok',
      (failure: unknown) => String(failure),
    );
    return {
      redirects,
      secondFocused: session.node.ownerDocument.activeElement === second,
      activeCellId: grid.getState().activeCellId,
      layout: grid.getState().layout,
      layoutResult,
    };
  } finally {
    first.removeEventListener('focus', redirect);
  }
}

// D5 uses an independent populated provider so existing D3/D4 empty-history
// scenarios keep their original timing and resource assertions.
type SyncSession = {
  node: HTMLDivElement;
  grid: TerminalGridApi;
  feed: ReturnType<typeof fixtureProvider>;
  listeners: SyncListenerRecord[];
};
type SyncListenerRecord = {
  range: number;
  crosshair: number;
  destroyedAt: { range: number; crosshair: number } | null;
};
let syncSession: SyncSession | null = null;
let syncHeldQuery: MarketQuery | null = null;
let syncHeldPages: Array<() => void> = [];
let syncPendingMarket: Promise<void> | null = null;
const syncTimes = Array.from({ length: 20 }, (_, index) => (index + 1) * 1000);
function syncHistory(market: MarketQuery) {
  if (market.symbol === 'SOLUSDT') return [];
  const times =
    market.symbol === 'ADAUSDT'
      ? syncTimes.map((time) => time + 9000)
      : market.interval === '5m'
        ? syncTimes.filter((_, index) => index % 2 === 0)
        : syncTimes;
  const offset = market.symbol === 'ETHUSDT' ? 300 : market.symbol === 'ADAUSDT' ? 500 : 100;
  return times.map((time, index) => bar(time, offset + index));
}
async function syncSettle() {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  for (let index = 0; index < 3; index++) {
    await Promise.all(
      ids.flatMap((id) => {
        const terminal = syncSession!.grid.getTerminal(id);
        return terminal ? [terminal.chart.whenIdle()] : [];
      }),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
async function syncMount() {
  if (syncSession) syncDestroy();
  const feed = fixtureProvider();
  const provider: MarketDataProvider = {
    ...feed.provider,
    getHistory(request) {
      const source =
        request.symbol === 'ADAUSDT' && request.before !== undefined
          ? syncTimes.slice(0, 9).map((time, index) => bar(time, 480 + index))
          : syncHistory(request);
      const page = {
        bars: source
          .filter(
            (item) =>
              (request.before === undefined || item.time < request.before) &&
              (request.from === undefined || item.time >= request.from),
          )
          .slice(-request.limit),
        exhausted: request.before !== undefined || request.from !== undefined || request.symbol !== 'ADAUSDT',
      };
      if (syncHeldQuery?.symbol === request.symbol && syncHeldQuery.interval === request.interval)
        return new Promise((resolve) => syncHeldPages.push(() => resolve(page)));
      return Promise.resolve(page);
    },
  };
  const node = host();
  const listeners: SyncListenerRecord[] = [];
  try {
    const grid = createTerminalGridWithDependencies(
      node,
      baseOptions(provider, {
        layout: 4,
        feed: { mode: 'history', initialLimit: 20, maxBars: 100, reconnectBaseMs: 5, reconnectMaxMs: 5 },
        settings: { followLatest: false, theme: 'dark', volume: true, emaPeriod: null },
      }),
      {
        prepareTerminal(element, options, workspace) {
          return prepareTerminalWithDependencies(element, options, workspace, {
            createFeedSession,
            createChart(...args) {
              const chart = createChart(...args);
              const record: SyncListenerRecord = { range: 0, crosshair: 0, destroyedAt: null };
              listeners.push(record);
              return {
                ...chart,
                subscribeVisibleRangeChange(
                  callback: Parameters<typeof chart.subscribeVisibleRangeChange>[0],
                ) {
                  record.range++;
                  const remove = chart.subscribeVisibleRangeChange(callback);
                  let active = true;
                  return () => {
                    if (!active) return;
                    active = false;
                    record.range--;
                    remove();
                  };
                },
                subscribeCrosshairMove(callback: Parameters<typeof chart.subscribeCrosshairMove>[0]) {
                  record.crosshair++;
                  const remove = chart.subscribeCrosshairMove(callback);
                  let active = true;
                  return () => {
                    if (!active) return;
                    active = false;
                    record.crosshair--;
                    remove();
                  };
                },
                destroy() {
                  record.destroyedAt = { range: record.range, crosshair: record.crosshair };
                  chart.destroy();
                },
              };
            },
          });
        },
      },
    );
    syncSession = { node, grid, feed, listeners };
    for (const id of ids) await waitForLive(grid, id);
    await syncSettle();
    return syncSnapshot();
  } catch (failure) {
    syncSession?.grid.destroy();
    syncSession = null;
    node.remove();
    throw failure;
  }
}
function syncSnapshot() {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  const grid = syncSession.grid;
  return {
    state: grid.getState(),
    cells: Object.fromEntries(
      ids.map((id) => {
        const terminal = grid.getTerminal(id);
        return [
          id,
          terminal
            ? {
                query: terminal.getWorkspace().query,
                feed: terminal.getState().feed,
                range: terminal.chart.getVisibleTimeRange(),
                revision: terminal.chart.getChangeRevision(),
              }
            : null,
        ];
      }),
    ),
    provider: syncSession.feed.snapshot(),
    listeners: syncListenerSnapshot(syncSession),
  };
}
function syncListenerSnapshot(session: SyncSession) {
  return session.listeners.map((item) => ({
    range: item.range,
    crosshair: item.crosshair,
    destroyedAt: item.destroyedAt ? { ...item.destroyedAt } : null,
  }));
}
async function syncSetMarket(id: TerminalGridCellId, market: MarketQuery) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  await syncSession.grid.getTerminal(id)!.setMarket(market);
  await waitForLive(syncSession.grid, id);
  await syncSettle();
  return syncSnapshot();
}
async function syncBeginHeldMarket(id: TerminalGridCellId, market: MarketQuery) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  if (syncPendingMarket) throw new Error('A sync fixture market is already pending');
  syncHeldQuery = { ...market };
  syncPendingMarket = syncSession.grid.getTerminal(id)!.setMarket(market);
  await Promise.resolve();
  return syncSnapshot();
}
async function syncReleaseHeldMarket(id: TerminalGridCellId) {
  if (!syncSession || !syncPendingMarket) throw new Error('No held sync fixture market');
  syncHeldQuery = null;
  for (const release of syncHeldPages.splice(0)) release();
  const pending = syncPendingMarket;
  syncPendingMarket = null;
  await pending;
  await waitForLive(syncSession.grid, id);
  await syncSettle();
  return syncSnapshot();
}
function syncSetRange(id: TerminalGridCellId, range: { from: number; to: number }) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.grid.getTerminal(id)!.chart.setVisibleTimeRange(range);
  return syncSnapshot();
}
function syncSetConfig(patch: {
  viewport?: boolean;
  crosshair?: boolean;
  crosshairMatch?: 'exact' | 'nearest';
}) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.grid.setSync(patch);
  return syncSnapshot();
}
function syncSetActive(id: TerminalGridCellId) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.grid.setActiveCell(id);
  return syncSnapshot();
}
async function syncSetLayout(layout: 1 | 2 | 4) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  await syncSession.grid.setLayout(layout);
  for (const id of ids.slice(0, layout)) await waitForLive(syncSession.grid, id);
  await syncSettle();
  return syncSnapshot();
}
async function syncWaitLive(id: TerminalGridCellId) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  for (let attempt = 0; attempt < 100; attempt++) {
    const feed = syncSession.grid.getTerminal(id)?.getState().feed;
    if (feed?.status === 'live') return syncSnapshot();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Sync ${id} did not return to live: ${JSON.stringify(syncSession.grid.getTerminal(id)?.getState().feed ?? null)}`,
  );
}
function syncEmit(market: MarketQuery, time: number, close: number) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.feed.emit(market, close, time);
  return syncSnapshot();
}
function syncClose(market: MarketQuery) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.feed.close(market);
  return syncSnapshot();
}
async function syncLoadMore(id: TerminalGridCellId) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  await syncSession.grid.getTerminal(id)!.loadMore();
  await syncSettle();
  return syncSnapshot();
}
function syncFollowLatest(id: TerminalGridCellId, enabled: boolean) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.grid.getTerminal(id)!.applySettings({ followLatest: enabled });
  return syncSnapshot();
}
function syncPinLatest(id: TerminalGridCellId) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  syncSession.grid.getTerminal(id)!.chart.scrollToLatest();
  return syncSnapshot();
}
async function syncAlignmentReentry(action: 'disable' | 'destroy' | 'layout' | 'restore') {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  const session = syncSession;
  const grid = session.grid;
  const source = grid.getTerminal('cell-1')!.chart;
  const target = grid.getTerminal('cell-2')!.chart;
  source.setVisibleTimeRange({ from: 7000, to: 13000 });
  target.setVisibleTimeRange({ from: 3000, to: 9000 });
  let callbacks = 0;
  let pending: Promise<void> | null = null;
  let off = () => {};
  off = target.subscribeVisibleRangeChange((_range, meta) => {
    if (!meta.origin) return;
    callbacks++;
    off();
    if (action === 'destroy') grid.destroy();
    else if (action === 'disable') grid.setSync({ viewport: false, crosshair: false });
    else {
      pending = action === 'layout' ? grid.setLayout(1) : grid.restoreWorkspace(grid.getWorkspace());
      void pending.catch(() => {});
    }
  });
  try {
    grid.setSync({ viewport: true, crosshair: false });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (action === 'destroy')
      return {
        callbacks,
        destroyed: grid.getState().destroyed,
        provider: session.feed.snapshot(),
        listeners: syncListenerSnapshot(session),
      };
    if (pending) {
      await pending;
      for (const id of ids.slice(0, grid.getState().layout)) await syncWaitLive(id);
      await syncSettle();
      return {
        callbacks,
        state: grid.getState(),
        provider: session.feed.snapshot(),
        listeners: syncListenerSnapshot(session),
      };
    }
    const before = target.getVisibleTimeRange();
    source.setVisibleTimeRange({ from: 8000, to: 14000 });
    await syncSettle();
    return { callbacks, before, after: target.getVisibleTimeRange(), sync: grid.getState().sync };
  } finally {
    off();
  }
}
async function syncCursor(source: TerminalGridCellId, target: TerminalGridCellId, time: number) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  const sourceChart = syncSession.grid.getTerminal(source)!.chart;
  const targetChart = syncSession.grid.getTerminal(target)!.chart;
  let received: { time: number | string | null; point: unknown } | null = null;
  const off = targetChart.subscribeCrosshairMove((event) => {
    received = { time: event.time, point: event.points['terminal-price'] ?? null };
  });
  try {
    sourceChart.setCrosshairTime(null);
    sourceChart.setCrosshairTime(time);
    await syncSettle();
    return received;
  } finally {
    off();
  }
}
async function syncRestore(document: TerminalGridWorkspace) {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  await syncSession.grid.restoreWorkspace(document);
  await syncSettle();
  return syncSnapshot();
}
function syncWorkspace() {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  return syncSession.grid.getWorkspace();
}
async function syncObsoleteAfterRestore() {
  if (!syncSession) throw new Error('Sync grid is not mounted');
  const session = syncSession;
  const stale = session.feed.oldHandlers();
  const document = session.grid.getWorkspace();
  await session.grid.restoreWorkspace(document);
  for (const id of ids) await waitForLive(session.grid, id);
  await syncSettle();
  const before = syncSnapshot();
  for (const handlers of stale) handlers.onBar(bar(50000, 900));
  await syncSettle();
  return { before, after: syncSnapshot() };
}
function syncDestroy() {
  if (!syncSession) return null;
  const session = syncSession;
  syncSession = null;
  syncHeldQuery = null;
  syncHeldPages = [];
  syncPendingMarket = null;
  session.grid.destroy();
  session.node.remove();
  return { ...session.feed.snapshot(), listeners: syncListenerSnapshot(session) };
}

(window as unknown as { terminalGridHarness: unknown }).terminalGridHarness = {
  independentSlots,
  parkedAlerts,
  atomicFourthFailure,
  borrowedCleanup,
  preferenceReentry,
  invalidSuppliedStores,
  monitorContinuity,
  invalidNestedRestore,
  boundaryRestore,
  revisionRejections,
  adoptionReentry,
  alertReentry,
  nativeDomFailure,
  ownedCleanup,
  repairExhaustion,
  failedConstructionResources,
  uiMount,
  uiConstructionFailure,
  uiDestroy,
  uiWidth,
  uiState,
  uiWorkspace,
  uiStats,
  uiRetained,
  uiSetLayout,
  uiSetActive,
  uiSeedDistinct,
  uiRestore,
  uiSupersededFocusRepair,
  uiRedirectedFocusDuringRepair,
  syncMount,
  syncSettle,
  syncSnapshot,
  syncSetMarket,
  syncBeginHeldMarket,
  syncReleaseHeldMarket,
  syncSetRange,
  syncSetConfig,
  syncSetActive,
  syncSetLayout,
  syncWaitLive,
  syncEmit,
  syncClose,
  syncLoadMore,
  syncFollowLatest,
  syncPinLatest,
  syncAlignmentReentry,
  syncCursor,
  syncRestore,
  syncWorkspace,
  syncObsoleteAfterRestore,
  syncDestroy,
};
