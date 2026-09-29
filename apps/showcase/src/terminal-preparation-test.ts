import { createChart } from '@filtix/charts';
import { createFeedSession, type MarketDataProvider, type MarketStreamHandlers } from '@filtix/datafeed';
import { createPriceAlertMonitor, createPriceAlertStore } from '@filtix/alerts';
import {
  getPriceAlertMonitorResourceSnapshot,
  getPriceAlertStoreResourceSnapshot,
} from '@filtix/alerts/internal';
import {
  createTerminal,
  type TerminalApi,
  type TerminalOptions,
  type TerminalWorkspace,
} from '@filtix/terminal';
import { decodeWorkspace } from '../../../packages/terminal/src/codec';

type Prepared = {
  readonly api: TerminalApi;
  start(options?: { alertLease?: () => void }): Promise<void>;
  getAlertLease(): (() => void) | null;
  destroy(): void;
};
type PreparationFactories = {
  prepareTerminal(host: HTMLElement, options: TerminalOptions, workspace?: TerminalWorkspace): Prepared;
  prepareTerminalWithDependencies(
    host: HTMLElement,
    options: TerminalOptions,
    workspace: TerminalWorkspace | undefined,
    dependencies: { createChart?: typeof createChart; createFeedSession: typeof createFeedSession },
  ): Prepared;
};
async function factories(): Promise<PreparationFactories> {
  return (await import('../../../packages/terminal/src/terminal')) as unknown as PreparationFactories;
}

const btc = { symbol: 'BTCUSDT', interval: '1m' } as const;
const eth = { symbol: 'ETHUSDT', interval: '1m' } as const;
type Subscription = { handlers: MarketStreamHandlers; active: boolean };

function fixtureProvider(options: { synchronousOpen?: boolean; heldHistory?: boolean } = {}) {
  const subscriptions: Subscription[] = [];
  let history = 0;
  let subscribes = 0;
  let held: ((value: { bars: []; exhausted: true }) => void) | null = null;
  const provider: MarketDataProvider = {
    id: 'preparation-fixture',
    revisionMode: 'monotonic',
    maxPageSize: 100,
    getHistory() {
      history++;
      if (options.heldHistory)
        return new Promise((resolve) => {
          held = resolve;
        });
      return Promise.resolve({ bars: [], exhausted: true });
    },
    subscribe(_query, handlers) {
      subscribes++;
      const entry: Subscription = { handlers, active: true };
      subscriptions.push(entry);
      if (options.synchronousOpen) handlers.onOpen();
      else
        queueMicrotask(() => {
          if (entry.active) handlers.onOpen();
        });
      return () => {
        entry.active = false;
      };
    },
  };
  return {
    provider,
    snapshot: () => ({
      history,
      subscriptions: subscriptions.filter((entry) => entry.active).length,
      subscribes,
    }),
    oldHandler: () => subscriptions[0]?.handlers ?? null,
    resolveHistory: () => held?.({ bars: [], exhausted: true }),
  };
}

function host(): HTMLDivElement {
  const node = document.createElement('div');
  node.style.width = '640px';
  node.style.height = '400px';
  return node;
}

function trackConstruction<T>(work: () => T): {
  value: T;
  listeners: number;
  observers: number;
  residualListeners: Array<{
    type: string;
    kind: string;
    tag: string | null;
    className: string | null;
    connected: boolean;
  }>;
} {
  const target = EventTarget.prototype as any;
  const nativeAdd = target.addEventListener;
  const nativeRemove = target.removeEventListener;
  const NativeResizeObserver = window.ResizeObserver;
  const listeners: Array<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  }> = [];
  const observers = new Set<ResizeObserver>();
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
  try {
    const value = work();
    return {
      value,
      listeners: listeners.length,
      observers: observers.size,
      residualListeners: listeners.map((item) => {
        const element = item.target instanceof Element ? item.target : null;
        return {
          type: item.type,
          kind:
            item.target === window
              ? 'window'
              : item.target === document
                ? 'document'
                : element
                  ? 'element'
                  : item.target.constructor.name,
          tag: element?.tagName ?? null,
          className: element && typeof element.className === 'string' ? element.className : null,
          connected: element?.isConnected ?? (item.target === window || item.target === document),
        };
      }),
    };
  } finally {
    window.ResizeObserver = NativeResizeObserver;
    target.addEventListener = nativeAdd;
    target.removeEventListener = nativeRemove;
  }
}

function options(
  provider: MarketDataProvider,
  observers?: { onState(): void; onAlert(): void },
): TerminalOptions {
  return {
    provider,
    query: btc,
    symbols: ['BTCUSDT', 'ETHUSDT'],
    intervals: ['1m'],
    onState: observers?.onState,
    onAlert: observers?.onAlert,
  };
}

function savedWorkspace(providerId: string): TerminalWorkspace {
  const drawings = (symbol: string) => ({
    query: { symbol, interval: '1m' },
    drawings: {
      schema: 'filtix-drawings',
      version: 1,
      timeDomain: 'utc-ms',
      drawings:
        symbol === 'ETHUSDT'
          ? [
              {
                id: 'saved-line',
                type: 'horizontal-line',
                paneId: 'price',
                points: [{ time: 1_700_000_000_000, price: 250 }],
                style: { color: '#c7ef57', lineWidth: 2, fillOpacity: 0.2 },
              },
            ]
          : [],
    },
  });
  return decodeWorkspace(
    {
      schema: 'filtix-terminal',
      version: 2,
      providerId,
      query: eth,
      settings: { theme: 'light', followLatest: false, volume: true },
      studies: [{ id: 'study-1', kind: 'sma', period: 3, color: '#c7ef57', lineWidth: 2, visible: true }],
      markets: [drawings('BTCUSDT'), drawings('ETHUSDT')],
    },
    {
      providerId,
      legacyAlertScopeId: 'saved:scope',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1m'],
    },
  );
}

const harness = {
  async prepareThenDestroy() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider();
    const node = host();
    let events = 0;
    const tracked = trackConstruction(() => {
      const prepared = prepareTerminal(
        node,
        options(feed.provider, { onState: () => events++, onAlert: () => events++ }),
      );
      const before = feed.snapshot();
      const beforeDestroy = { history: before.history, subscriptions: before.subscriptions, events };
      const stateBefore = prepared.api.getState();
      prepared.destroy();
      const after = feed.snapshot();
      return {
        beforeDestroy,
        afterDestroy: { history: after.history, subscriptions: after.subscriptions, events },
        stateBefore,
        finalDestroyed: prepared.api.getState().destroyed,
        store: getPriceAlertStoreResourceSnapshot(prepared.api.getAlerts()),
      };
    });
    const { store, ...value } = tracked.value;
    return {
      ...value,
      listeners: tracked.listeners,
      observers: tracked.observers,
      residualListeners: tracked.residualListeners,
      store,
      remainingOwnedResources:
        node.childElementCount +
        feed.snapshot().subscriptions +
        tracked.listeners +
        tracked.observers +
        store.changeListeners +
        store.eventListeners +
        store.admissionListeners +
        store.lifecycleListeners,
    };
  },

  async partialFourthFailure() {
    const { prepareTerminalWithDependencies } = await factories();
    const feed = fixtureProvider();
    const nodes = [host(), host(), host(), host()];
    const prepared: Prepared[] = [];
    let charts = 0;
    let sessions = 0;
    let events = 0;
    let failure = '';
    const deps = {
      createChart(...args: Parameters<typeof createChart>) {
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
      createFeedSession(...args: Parameters<typeof createFeedSession>) {
        if (sessions === 3) throw new Error('fourth feed construction fault');
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
    };
    const tracked = trackConstruction(() => {
      try {
        for (const node of nodes)
          prepared.push(
            prepareTerminalWithDependencies(
              node,
              options(feed.provider, { onState: () => events++, onAlert: () => events++ }),
              undefined,
              deps,
            ),
          );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        for (const item of prepared) item.destroy();
      }
    });
    return {
      failure,
      charts,
      sessions,
      events,
      children: nodes.reduce((sum, node) => sum + node.childElementCount, 0),
      listeners: tracked.listeners,
      observers: tracked.observers,
      residualListeners: tracked.residualListeners,
      ...feed.snapshot(),
    };
  },

  async immediatePublicStart() {
    const feed = fixtureProvider({ synchronousOpen: true });
    const node = host();
    let states = 0;
    const api = createTerminal(node, options(feed.provider, { onState: () => states++, onAlert: () => {} }));
    const immediately = feed.snapshot();
    await Promise.resolve();
    const afterTick = feed.snapshot();
    api.destroy();
    return {
      immediately,
      afterTick,
      states,
      final: feed.snapshot(),
      destroyed: api.getState().destroyed,
      children: node.childElementCount,
    };
  },

  async preStartMutations() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider();
    const node = host();
    let events = 0;
    const prepared = prepareTerminal(
      node,
      options(feed.provider, { onState: () => events++, onAlert: () => events++ }),
    );
    const rejected: string[] = [];
    const attempt = (name: string, action: () => unknown) => {
      try {
        action();
      } catch (error) {
        if (error instanceof Error && /not been started/i.test(error.message)) rejected.push(name);
      }
    };
    attempt('layout', () => prepared.api.applyLayout({ studiesOpen: true }));
    attempt('settings', () => prepared.api.applySettings({ theme: 'light' }));
    attempt('study', () => prepared.api.addStudy({ kind: 'sma', period: 3 }));
    attempt('correction', () => prepared.api.applyCorrections([]));
    attempt('tool', () => prepared.api.setTool('horizontal-line'));
    for (const [name, operation] of [
      ['market', () => prepared.api.setMarket(eth)],
      ['retry', () => prepared.api.retry()],
      ['history', () => prepared.api.loadMore()],
      ['restore', () => prepared.api.restoreWorkspace(prepared.api.getWorkspace())],
    ] as const) {
      try {
        await operation();
      } catch (error) {
        if (error instanceof Error && /not been started/i.test(error.message)) rejected.push(name);
      }
    }
    const beforeDestroy = { ...feed.snapshot(), events };
    prepared.destroy();
    return { rejected: rejected.sort(), beforeDestroy, children: node.childElementCount };
  },

  async adoptedLease() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider({ synchronousOpen: true });
    const store = createPriceAlertStore({ providerId: feed.provider.id, scopeId: 'borrowed:scope' });
    store.add({ query: eth, price: 250, condition: 'crosses-up', frequency: 'repeat' });
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const unattached = {
      ...feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
    };
    const lease = monitor.attach(store);
    const before = {
      ...feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
    };
    const node = host();
    const prepared = prepareTerminal(node, { ...options(feed.provider), alerts: { store, monitor } });
    const preparedSnapshot = {
      ...feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
    };
    await prepared.start({ alertLease: lease });
    const afterStart = {
      ...feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
    };
    const sameLease = prepared.getAlertLease() === lease;
    prepared.destroy();
    const afterDestroy = {
      ...feed.snapshot(),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
      children: node.childElementCount,
    };
    const stillUsable = store.add({ query: btc, price: 100, condition: 'crosses-up', frequency: 'once' });
    monitor.destroy();
    store.destroy();
    return { unattached, before, preparedSnapshot, afterStart, sameLease, afterDestroy, stillUsable };
  },

  async savedAndBorrowedWorkspace() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider();
    const workspace = savedWorkspace(feed.provider.id);
    const ownedNode = host();
    const owned = prepareTerminal(ownedNode, options(feed.provider), workspace);
    const ownedSaved = owned.api.getWorkspace();
    const beforeStart = feed.snapshot();
    owned.destroy();

    const store = createPriceAlertStore({ providerId: feed.provider.id, scopeId: 'borrowed:scope' });
    const ruleId = store.add({ query: eth, price: 251, condition: 'crosses-down', frequency: 'once' });
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const borrowedNode = host();
    const borrowedBefore = {
      ...feed.snapshot(),
      store: getPriceAlertStoreResourceSnapshot(store),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
    };
    const borrowed = prepareTerminal(
      borrowedNode,
      { ...options(feed.provider), alerts: { store, monitor } },
      workspace,
    );
    const borrowedPrepared = {
      ...feed.snapshot(),
      store: getPriceAlertStoreResourceSnapshot(store),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
    };
    const borrowedSaved = borrowed.api.getWorkspace();
    borrowed.destroy();
    const surviving = {
      ...feed.snapshot(),
      store: getPriceAlertStoreResourceSnapshot(store),
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      ruleId,
    };
    monitor.destroy();
    store.destroy();
    return {
      expected: workspace,
      ownedSaved,
      borrowedSaved,
      beforeStart,
      borrowedBefore,
      borrowedPrepared,
      surviving,
      ownedChildren: ownedNode.childElementCount,
      borrowedChildren: borrowedNode.childElementCount,
    };
  },

  async synchronousDestroyAndObsoleteHistory() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider({ synchronousOpen: true, heldHistory: true });
    const node = host();
    let states = 0;
    let prepared: Prepared | null = null;
    prepared = prepareTerminal(
      node,
      options(feed.provider, {
        onState: () => {
          states++;
          if (states === 1) prepared?.destroy();
        },
        onAlert: () => {},
      }),
    );
    try {
      await prepared.start();
    } catch {
      // Destruction during the synchronous loading callback is the expected fence.
    }
    const afterDestroy = {
      ...feed.snapshot(),
      states,
      children: node.childElementCount,
      destroyed: prepared.api.getState().destroyed,
    };
    feed.resolveHistory();
    feed.oldHandler()?.onOpen();
    await Promise.resolve();
    await Promise.resolve();
    return {
      afterDestroy,
      afterObsolete: {
        ...feed.snapshot(),
        states,
        children: node.childElementCount,
        destroyed: prepared.api.getState().destroyed,
      },
    };
  },

  async synchronousDestroyWithAdoptedLease() {
    const { prepareTerminal } = await factories();
    const feed = fixtureProvider({ synchronousOpen: true, heldHistory: true });
    const store = createPriceAlertStore({ providerId: feed.provider.id, scopeId: 'borrowed:reentry' });
    const monitor = createPriceAlertMonitor({ provider: feed.provider });
    const token = monitor.attach(store);
    const node = host();
    let states = 0;
    let tokenIdentity = false;
    let prepared: Prepared | null = null;
    prepared = prepareTerminal(node, {
      ...options(feed.provider, {
        onState: () => {
          states++;
          if (states === 1) {
            tokenIdentity = prepared?.getAlertLease() === token;
            prepared?.destroy();
          }
        },
        onAlert: () => {},
      }),
      alerts: { store, monitor },
    });
    try {
      await prepared.start({ alertLease: token });
    } catch {
      // Synchronous destruction during loading rejects the obsolete start.
    }
    const afterDestroy = {
      ...feed.snapshot(),
      states,
      children: node.childElementCount,
      destroyed: prepared.api.getState().destroyed,
      monitor: getPriceAlertMonitorResourceSnapshot(monitor),
      store: getPriceAlertStoreResourceSnapshot(store),
    };
    feed.resolveHistory();
    feed.oldHandler()?.onOpen();
    await Promise.resolve();
    await Promise.resolve();
    const afterObsolete = {
      ...feed.snapshot(),
      states,
      children: node.childElementCount,
      destroyed: prepared.api.getState().destroyed,
    };
    const usableRule = store.add({ query: btc, price: 100, condition: 'crosses-up', frequency: 'once' });
    monitor.destroy();
    store.destroy();
    return { afterDestroy, afterObsolete, tokenIdentity, usableRule };
  },
};

(window as unknown as { terminalPreparationHarness: typeof harness }).terminalPreparationHarness = harness;
