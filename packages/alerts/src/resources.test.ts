import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MarketDataProvider, MarketStreamHandlers, HistoryPage } from '@filtrix.net/datafeed';
import { createPriceAlertStore, getStoreCapability } from './store';
import { createPriceAlertMonitor } from './monitor';
import { prepareAlertMembershipReplacement } from './membership';
import { getPriceAlertMonitorResourceSnapshot, getPriceAlertStoreResourceSnapshot } from './resources';

const query = { symbol: 'BTC', interval: '1m' };
const provider: MarketDataProvider = {
  id: 'p',
  revisionMode: 'monotonic',
  maxPageSize: 1,
  getHistory: async () => ({ bars: [], exhausted: true }),
  subscribe: () => () => {},
};

function store(scopeId: string, rule = true) {
  const result = createPriceAlertStore({ providerId: 'p', scopeId });
  if (rule) result.add({ query, price: 1, condition: 'crosses-up', frequency: 'once' });
  return result;
}

afterEach(() => vi.useRealTimers());

describe('package-private alert resource snapshots', () => {
  test('exposes defensive actual runtime feed state, including inactive pending retirement', async () => {
    let resolvePage!: (page: HistoryPage) => void;
    let stream!: MarketStreamHandlers;
    const pendingProvider: MarketDataProvider = {
      ...provider,
      getHistory: () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
      subscribe(_query, handlers) {
        stream = handlers;
        return () => {};
      },
    };
    const monitor = createPriceAlertMonitor({ provider: pendingProvider });
    const first = store('feed-details');
    const next = store('empty-details', false);
    try {
      const release = monitor.attach(first);
      stream.onBar({ time: 1, open: 0, high: 1, low: -1, close: 0, volume: 1, revision: 1 });
      const snapshot = getPriceAlertMonitorResourceSnapshot(monitor);
      expect(snapshot.runtimes).toHaveLength(1);
      expect(snapshot.runtimes[0]).toMatchObject({
        query,
        active: true,
        feed: {
          query,
          mode: 'latest',
          retainedBars: 0,
          bufferedBars: 1,
          correctionBars: 0,
          pendingBarEntries: 1,
          pendingRequest: true,
        },
      });
      (snapshot.runtimes[0]!.query as { symbol: string }).symbol = 'CHANGED';
      (snapshot.runtimes[0]!.feed.query as { symbol: string }).symbol = 'CHANGED';
      expect(getPriceAlertMonitorResourceSnapshot(monitor).runtimes[0]).toMatchObject({
        query,
        feed: { query },
      });
      resolvePage({ bars: [], exhausted: true });
      for (let index = 0; index < 12; index++) await Promise.resolve();
      expect(getPriceAlertMonitorResourceSnapshot(monitor).runtimes[0]!.feed).toMatchObject({
        retainedBars: 1,
        pendingBarEntries: 0,
        pendingRequest: false,
        status: 'live',
      });
      const tx = prepareAlertMembershipReplacement(monitor, { retire: [release], attach: [next] });
      const [nextRelease] = tx.commit();
      expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
        runtimeEntries: 1,
        activeRuntimeEntries: 0,
        runtimes: [{ query, active: false, feed: { retainedBars: 1 } }],
      });
      tx.activate();
      expect(getPriceAlertMonitorResourceSnapshot(monitor).runtimes).toEqual([]);
      nextRelease!();
    } finally {
      monitor.destroy();
      first.destroy();
      next.destroy();
    }
    expect(getPriceAlertMonitorResourceSnapshot(monitor).runtimes).toEqual([]);
  });

  test('counts real store Sets, preserves duplicate callback Set semantics, and reads after destroy', () => {
    const value = store('store');
    const capability = getStoreCapability(value);
    const change = () => {};
    const event = () => {};
    const admission = () => {};
    const lifecycle = () => {};
    const releaseChange = value.subscribe(change);
    value.subscribe(change);
    const releaseEvent = value.subscribeEvents(event);
    value.subscribeEvents(event);
    const releaseAdmission = capability.registerAdmission(admission);
    capability.registerAdmission(admission);
    const releaseLifecycle = capability.subscribeLifecycle(lifecycle);
    capability.subscribeLifecycle(lifecycle);

    expect(getPriceAlertStoreResourceSnapshot(value)).toEqual({
      destroyed: false,
      changeListeners: 1,
      eventListeners: 1,
      admissionListeners: 1,
      lifecycleListeners: 1,
    });
    releaseChange();
    releaseEvent();
    releaseAdmission();
    releaseLifecycle();
    expect(getPriceAlertStoreResourceSnapshot(value)).toMatchObject({
      changeListeners: 0,
      eventListeners: 0,
      admissionListeners: 0,
      lifecycleListeners: 0,
    });
    value.destroy();
    expect(getPriceAlertStoreResourceSnapshot(value)).toEqual({
      destroyed: true,
      changeListeners: 0,
      eventListeners: 0,
      admissionListeners: 0,
      lifecycleListeners: 0,
    });
  });

  test('returns fresh flat primitive records and rejects foreign stores', () => {
    const value = store('defensive');
    const first = getPriceAlertStoreResourceSnapshot(value);
    expect(first).not.toBe(getPriceAlertStoreResourceSnapshot(value));
    expect(Object.values(first).every((item) => ['boolean', 'number'].includes(typeof item))).toBe(true);
    expect(
      Object.values(Object.getOwnPropertyDescriptors(first)).every((item) => !item.get && !item.set),
    ).toBe(true);
    (first as { changeListeners: number }).changeListeners = 900;
    expect(getPriceAlertStoreResourceSnapshot(value).changeListeners).toBe(0);
    expect(() => getPriceAlertStoreResourceSnapshot({} as never)).toThrow(/created by createPriceAlertStore/);
  });

  test('counts monitor members, leases, actual listeners, cached rules, and shared runtimes', () => {
    const monitor = createPriceAlertMonitor({ provider });
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toEqual({
      destroyed: false,
      members: 0,
      leaseEntries: 0,
      observerListeners: 0,
      retainedMemberDisposers: 0,
      cachedRuleEntries: 0,
      baselineEntries: 0,
      runtimeEntries: 0,
      activeRuntimeEntries: 0,
      reconcileTimers: 0,
      reservationPending: false,
      activationPending: false,
      runtimes: [],
    });
    const first = store('first');
    const second = store('second');
    const firstRelease = monitor.attach(first);
    const secondLease = monitor.attach(first);
    const secondStoreRelease = monitor.attach(second);
    const observer = () => {};
    const releaseObserver = monitor.subscribe(observer);
    monitor.subscribe(observer);

    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toEqual({
      destroyed: false,
      members: 2,
      leaseEntries: 3,
      observerListeners: 1,
      retainedMemberDisposers: 6,
      cachedRuleEntries: 2,
      baselineEntries: 0,
      runtimeEntries: 1,
      activeRuntimeEntries: 1,
      reconcileTimers: 0,
      reservationPending: false,
      activationPending: false,
      runtimes: [
        expect.objectContaining({ query, active: true, feed: expect.objectContaining({ mode: 'latest' }) }),
      ],
    });
    firstRelease();
    expect(getPriceAlertMonitorResourceSnapshot(monitor).leaseEntries).toBe(2);
    secondLease();
    secondStoreRelease();
    releaseObserver();
    monitor.destroy();
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      destroyed: true,
      members: 0,
      leaseEntries: 0,
      observerListeners: 0,
      retainedMemberDisposers: 0,
      cachedRuleEntries: 0,
      baselineEntries: 0,
      runtimeEntries: 0,
      activeRuntimeEntries: 0,
      reconcileTimers: 0,
      reservationPending: false,
      activationPending: false,
    });
  });

  test('unwinds partially registered store listeners when attachment fails', () => {
    const monitor = createPriceAlertMonitor({ provider });
    const value = store('failure');
    value.subscribe = () => {
      throw new Error('host subscription failed');
    };
    expect(() => monitor.attach(value)).toThrow('host subscription failed');
    expect(getPriceAlertStoreResourceSnapshot(value)).toMatchObject({
      admissionListeners: 0,
      lifecycleListeners: 0,
    });
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      members: 0,
      leaseEntries: 0,
      runtimeEntries: 0,
    });
    monitor.destroy();
  });

  test('reports prepared inactive runtimes until activation retires them', () => {
    const monitor = createPriceAlertMonitor({ provider });
    const previous = store('previous');
    const next = store('next', false);
    const release = monitor.attach(previous);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [release], attach: [next] });
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      members: 1,
      leaseEntries: 1,
      reservationPending: true,
      activationPending: false,
    });
    const [nextRelease] = tx.commit();
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      members: 1,
      leaseEntries: 1,
      runtimeEntries: 1,
      activeRuntimeEntries: 0,
      activationPending: true,
    });
    tx.activate();
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      runtimeEntries: 0,
      activeRuntimeEntries: 0,
      activationPending: false,
    });
    nextRelease!();
    monitor.destroy();
  });

  test('reports a deferred reconcile timer and its cancellation during prepared commit', () => {
    vi.useFakeTimers();
    let cascadingStore: ReturnType<typeof store>;
    let additions = 0;
    const cascadingProvider: MarketDataProvider = {
      ...provider,
      subscribe: () => {
        if (additions < 8) {
          const index = additions++;
          cascadingStore.add({
            query: { symbol: `Q${index + 1}`, interval: '1m' },
            price: 1,
            condition: 'crosses-up',
            frequency: 'once',
          });
        }
        return () => {};
      },
    };
    const cascadingMonitor = createPriceAlertMonitor({ provider: cascadingProvider });
    cascadingStore = store('timer-cascade', false);
    const cascadingRelease = cascadingMonitor.attach(cascadingStore);
    cascadingStore.add({
      query: { symbol: 'Q0', interval: '1m' },
      price: 1,
      condition: 'crosses-up',
      frequency: 'once',
    });
    expect(getPriceAlertMonitorResourceSnapshot(cascadingMonitor).reconcileTimers).toBe(1);
    const replacement = store('timer-replacement', false);
    const tx = prepareAlertMembershipReplacement(cascadingMonitor, {
      retire: [cascadingRelease],
      attach: [replacement],
    });
    const [replacementRelease] = tx.commit();
    expect(getPriceAlertMonitorResourceSnapshot(cascadingMonitor)).toMatchObject({
      reconcileTimers: 0,
      activationPending: true,
    });
    tx.abort();
    replacementRelease!();
    cascadingMonitor.destroy();
  });

  test('rejects foreign monitors and remains readable after monitor destruction', () => {
    expect(() => getPriceAlertMonitorResourceSnapshot({} as never)).toThrow(
      /created by createPriceAlertMonitor/,
    );
    const monitor = createPriceAlertMonitor({ provider });
    const value = store('destroyed-monitor');
    monitor.attach(value);
    monitor.destroy();
    expect(getPriceAlertMonitorResourceSnapshot(monitor)).toMatchObject({
      destroyed: true,
      members: 0,
      runtimeEntries: 0,
      reconcileTimers: 0,
    });
  });
});
