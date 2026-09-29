// Installed-archive-only workload, loaded by main.tsx solely for ?test&alerts.
import { createTerminal } from '@filtix/terminal';
import { createPriceAlertStore, createPriceAlertMonitor } from '@filtix/alerts';
import {
  prepareAlertMembershipReplacement,
  getPriceAlertStoreResourceSnapshot,
  getPriceAlertMonitorResourceSnapshot,
} from '@filtix/alerts/internal';

const copy = (value) => structuredClone(value);
const epoch = () => performance.timeOrigin + performance.now();
const queryKey = (query) => JSON.stringify([query.symbol, query.interval]);
const chartQuery = { symbol: 'ALERT_CHART', interval: '1m' };
const host = document.createElement('div');
host.id = 'alerts-workload-host';
host.style.cssText = 'width:1440px;height:900px;max-width:100vw;max-height:100vh';
document.body.replaceChildren(host);

let fixture = null;
let stores = [];
let monitor = null;
let terminal = null;
let releases = [];
let eventReleases = [];
let events = [];
let terminalEvents = [];
let deliveryContext = null;
let obsoleteHandlers = null;
let finalOwnedSnapshots = null;
const streams = new Map();
const subscriptionsByQuery = new Map();
const deliveriesByQuery = new Map();
let providerSubscriptions = 0;
let providerUnsubscriptions = 0;
let providerDeliveries = 0;
let providerRequests = 0;
let activeRequests = 0;
let terminalMounts = 0;
let terminalDestroys = 0;

const provider = {
  id: 'filtix-alerts-workload-v1',
  revisionMode: 'monotonic',
  maxPageSize: 1000,
  async getHistory() {
    providerRequests++;
    activeRequests++;
    try {
      const latest = fixture?.firstTime ?? Date.UTC(2026, 0, 1);
      const close = fixture?.initialClose ?? 99;
      return {
        bars: [
          {
            time: latest - 60_000,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1,
            revision: 1,
          },
        ],
        exhausted: true,
      };
    } finally {
      activeRequests--;
    }
  },
  subscribe(query, handlers) {
    const key = queryKey(query);
    let live = streams.get(key);
    if (!live) {
      live = new Set();
      streams.set(key, live);
    }
    live.add(handlers);
    providerSubscriptions++;
    subscriptionsByQuery.set(key, (subscriptionsByQuery.get(key) ?? 0) + 1);
    queueMicrotask(() => {
      if (live.has(handlers)) handlers.onOpen();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.delete(handlers);
      if (live.size === 0) streams.delete(key);
      providerUnsubscriptions++;
      subscriptionsByQuery.set(key, (subscriptionsByQuery.get(key) ?? 1) - 1);
      obsoleteHandlers = handlers;
    };
  },
};

function providerCounts() {
  return {
    requests: providerRequests,
    activeRequests,
    subscriptions: providerSubscriptions,
    unsubscriptions: providerUnsubscriptions,
    deliveries: providerDeliveries,
    activeSubscriptions: [...subscriptionsByQuery.values()].reduce((sum, value) => sum + value, 0),
    byQuery: [...subscriptionsByQuery].map(([key, active]) => ({
      query: JSON.parse(key),
      active,
      delivered: deliveriesByQuery.get(key) ?? 0,
    })),
  };
}

function resourceSnapshot() {
  const timers = window.__filtixAlertsTimerTracker?.sample();
  return {
    stores: stores.map((store, index) => ({
      id: fixture.stores[index].scopeId,
      snapshot: getPriceAlertStoreResourceSnapshot(store),
    })),
    monitors: monitor ? [{ id: 'monitor-0', snapshot: getPriceAlertMonitorResourceSnapshot(monitor) }] : [],
    appTimers: timers?.outstanding ?? null,
    providerSubscriptions: providerCounts().activeSubscriptions,
  };
}

function recordEvent(event, terminalCallback = false) {
  // Production callbacks transfer defensive event snapshots. Keep only the reference,
  // prebuilt context, and clock read until the measured invocation has finished.
  const captured = [event, deliveryContext, epoch()];
  if (terminalCallback) terminalEvents.push(captured);
  else events.push(captured);
}

function materializeObservations(captures) {
  return captures.map(([event, context, callbackAt]) => ({
    ...event,
    ...context,
    callbackAt,
    callbackLatencyMs: context ? callbackAt - context.browserAt : null,
  }));
}

function mount() {
  if (!fixture || !monitor || stores.length !== 4 || terminal)
    throw Error('Alert fixture is not prepared or already mounted');
  terminal = createTerminal(host, {
    provider,
    query: chartQuery,
    // The terminal chart has one valid catalog entry; the borrowed monitor owns
    // all 32 independent alert queries, outside that chart catalog.
    symbols: [chartQuery.symbol],
    intervals: ['1m'],
    alerts: { store: stores[0], monitor },
    onAlert(event) {
      recordEvent(event, true);
    },
  });
  terminalMounts++;
  return { terminalMounts, provider: providerCounts() };
}

function unmount() {
  if (!terminal) return;
  terminal.destroy();
  terminal = null;
  terminalDestroys++;
}

function prepare(scene) {
  if (fixture || terminal || monitor || stores.length) throw Error('Alert fixture already prepared');
  fixture = copy(scene);
  if (fixture.providerId !== provider.id || fixture.stores.length !== 4 || fixture.queries.length !== 32)
    throw Error('Invalid installed alert fixture');
  events = [];
  terminalEvents = [];
  finalOwnedSnapshots = null;
  try {
    for (const document of fixture.stores) {
      const store = createPriceAlertStore({ providerId: document.providerId, scopeId: document.scopeId });
      stores.push(store);
      store.restore(document);
    }
    monitor = createPriceAlertMonitor({ provider });
    eventReleases = stores.map((store) => store.subscribeEvents((event) => recordEvent(event)));
    releases = stores.map((store) => monitor.attach(store));
    // Exercise the installed private subpath with the original branded release token.
    const reservation = prepareAlertMembershipReplacement(monitor, {
      retire: [releases[3]],
      attach: [stores[3]],
    });
    reservation.abort();
    mount();
    return {
      documents: stores.map((store) => store.toJSON()),
      resources: resourceSnapshot(),
      provider: providerCounts(),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function ready() {
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = monitor?.getState();
    const terminalState = terminal?.getState();
    if (state?.queries.length === 32 && state.queries.every((item) => item.status === 'monitoring')) {
      return { provider: providerCounts(), resources: resourceSnapshot(), monitor: state };
    }
    if (terminalState?.error || terminalState?.feed.error)
      throw Error(terminalState.error || terminalState.feed.error.message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Installed alert monitor did not activate all 32 queries');
}

async function deliverBatch(delivery) {
  if (!monitor || !fixture) throw Error('Alert fixture is not prepared');
  if (!Array.isArray(delivery?.updates) || delivery.updates.length !== 32)
    throw Error('Expected 32 accepted raw updates');
  const before = events.length;
  const terminalBefore = terminalEvents.length;
  const prepared = delivery.updates.map((update, queryIndex) => {
    const key = queryKey(update.query);
    const handlers = streams.get(key);
    if (!handlers || handlers.size !== 1)
      throw Error(`Expected one monitored subscription for query ${queryIndex}`);
    const close = update.close;
    return {
      key,
      handler: [...handlers][0],
      queryIndex,
      bar: {
        time: update.time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
        revision: update.revision,
      },
    };
  });
  const contexts = prepared.map(({ queryIndex }) => ({
    phase: delivery.phase,
    batch: delivery.batch,
    queryIndex,
    browserAt: 0,
  }));
  const browserAt = epoch();
  for (const context of contexts) context.browserAt = browserAt;
  const start = performance.now();
  for (const [index, item] of prepared.entries()) {
    deliveryContext = contexts[index];
    item.handler.onBar(item.bar);
  }
  deliveryContext = null;
  const syncMs = performance.now() - start;
  await Promise.resolve();
  const settledMs = performance.now() - start;
  for (const item of prepared) {
    providerDeliveries++;
    deliveriesByQuery.set(item.key, (deliveriesByQuery.get(item.key) ?? 0) + 1);
  }
  return {
    browserAt,
    syncMs,
    settledMs,
    preparedBars: prepared.length,
    evidenceMaterializedAfterTiming: true,
    events: materializeObservations(events.slice(before)),
    terminalEvents: materializeObservations(terminalEvents.slice(terminalBefore)),
  };
}

function ruleCycle(index) {
  if (!fixture || stores.length !== 4) throw Error('Alert fixture is not prepared');
  const store = stores[3];
  const original = store.toJSON();
  const stable = original.alerts[99];
  store.remove(stable.id);
  const id = store.add({
    query: { ...stable.query },
    price: stable.price,
    condition: stable.condition,
    frequency: stable.frequency,
  });
  store.update(id, { price: stable.price + index + 1 });
  store.pause(id);
  store.rearm(id);
  store.remove(id);
  store.restore(original);
  return { index, id, document: store.toJSON(), resources: resourceSnapshot() };
}

function mountCycle(index) {
  unmount();
  mount();
  return { index, terminalMounts, terminalDestroys, provider: providerCounts() };
}

function snapshot() {
  return {
    documents: stores.map((store) => store.toJSON()),
    monitor: monitor?.getState() ?? null,
    provider: providerCounts(),
    resources: resourceSnapshot(),
    events: materializeObservations(events),
    terminalEvents: materializeObservations(terminalEvents),
    terminalMounts,
    terminalDestroys,
  };
}

function probeObsolete() {
  const handler = obsoleteHandlers;
  obsoleteHandlers = null;
  if (!handler) return { available: false };
  const before = events.length;
  const documentsBefore = stores.map((store) => store.toJSON());
  const monitorBefore = monitor?.getState();
  const subscriptionsBefore = providerCounts().activeSubscriptions;
  const close = 99;
  handler.onBar({
    time: (fixture?.firstTime ?? 0) + 999_999_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    revision: 1,
  });
  return {
    available: true,
    newEvents: events.length - before,
    documentsUnchanged:
      JSON.stringify(stores.map((store) => store.toJSON())) === JSON.stringify(documentsBefore),
    monitorUnchanged: JSON.stringify(monitor?.getState()) === JSON.stringify(monitorBefore),
    subscriptionsUnchanged: providerCounts().activeSubscriptions === subscriptionsBefore,
  };
}

function cleanup() {
  unmount();
  for (const release of releases.splice(0)) release();
  for (const release of eventReleases.splice(0)) release();
  monitor?.destroy();
  for (const store of stores) store.destroy();
  finalOwnedSnapshots = monitor && fixture ? resourceSnapshot() : null;
  const providerFinal = providerCounts();
  obsoleteHandlers = null;
  stores = [];
  monitor = null;
  fixture = null;
  deliveryContext = null;
  events = [];
  terminalEvents = [];
  return { resources: finalOwnedSnapshots, provider: providerFinal, terminalMounts, terminalDestroys };
}

const api = {
  prepare,
  ready,
  mount,
  unmount,
  deliverBatch,
  ruleCycle,
  mountCycle,
  snapshot,
  probeObsolete,
  cleanup,
};
if (!window.terminalHarness) window.terminalHarness = {};
window.terminalHarness.alerts = api;
