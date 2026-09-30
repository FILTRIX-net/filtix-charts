import { describe, expect, test, vi } from 'vitest';
import type {
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from '@filtrix.net/datafeed';
import { createPriceAlertStore } from './store';
import { createPriceAlertMonitor, getMonitorInternals } from './monitor';
import { prepareAlertMembershipReplacement } from './membership';

class Provider implements MarketDataProvider {
  readonly id = 'p';
  readonly revisionMode = 'monotonic';
  readonly maxPageSize = 100;
  setups = 0;
  teardowns = 0;
  history = 0;
  active = 0;
  subscriptions: Array<{ query: MarketQuery; handlers: MarketStreamHandlers; active: boolean }> = [];
  hostAdopted = false;
  teardownSawOldHost = false;
  onTeardown: (() => void) | null = null;
  getHistory(_request: HistoryRequest): Promise<HistoryPage> {
    this.history++;
    return Promise.resolve({ bars: [], exhausted: true });
  }
  subscribe(query: MarketQuery, handlers: MarketStreamHandlers): () => void {
    const subscription = { query, handlers, active: true };
    this.subscriptions.push(subscription);
    this.setups++;
    this.active++;
    return () => {
      subscription.active = false;
      if (!this.hostAdopted) this.teardownSawOldHost = true;
      this.teardowns++;
      this.active--;
      handlers.onClose();
      this.onTeardown?.();
    };
  }
  emit(query: MarketQuery, close: number, time: number): void {
    const bar: MarketBar = { time, open: close, high: close, low: close, close, volume: 1, revision: 1 };
    for (const subscription of this.subscriptions)
      if (subscription.active && subscription.query.symbol === query.symbol) subscription.handlers.onBar(bar);
  }
}

function filled(scopeId: string, count: number, symbolPrefix = 'M') {
  const result = createPriceAlertStore({ providerId: 'p', scopeId });
  for (let index = 0; index < count; index++)
    result.add({
      query: { symbol: `${symbolPrefix}${index % 32}`, interval: '1m' },
      price: 0,
      condition: 'crosses-up',
      frequency: 'repeat',
    });
  return result;
}
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

describe('prepared final alert membership replacement', () => {
  test('1→2→4→1 retains four runtimes, baselines, parked counts, and external leases', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const stores = Array.from({ length: 4 }, (_, index) => filled(`persistent-${index}`, 1, `P${index}-`));
    const permanent = stores.map((store) => monitor.attach(store));
    const external = monitor.attach(stores[3]!);
    let visible = [monitor.attach(stores[0]!)];
    const query = stores[0]!.list()[0]!.query;
    const events: number[] = [];
    stores[0]!.subscribeEvents((event) => events.push(event.occurrence));
    await tick();
    expect(monitor.getState().queries.map((item) => item.status)).toEqual(Array(4).fill('monitoring'));
    provider.emit(query, -1, 1);
    const before = { setups: provider.setups, teardowns: provider.teardowns, history: provider.history };
    let notices = 0;
    monitor.subscribe(() => notices++);
    const transition = (retire: readonly (() => void)[], attach: readonly number[]) => {
      const tx = prepareAlertMembershipReplacement(monitor, {
        retire,
        attach: attach.map((index) => stores[index]!),
      });
      const beforeCommitNotices = notices;
      const releases = tx.commit();
      expect(monitor.getState().queries).toHaveLength(4);
      expect(notices).toBe(beforeCommitNotices);
      expect({ setups: provider.setups, teardowns: provider.teardowns, history: provider.history }).toEqual(
        before,
      );
      tx.activate();
      expect({ setups: provider.setups, teardowns: provider.teardowns, history: provider.history }).toEqual(
        before,
      );
      return releases;
    };
    visible = [...visible, ...transition([], [1])];
    visible = [...visible, ...transition([], [2, 3])];
    provider.emit(query, 0, 2);
    expect(events).toEqual([1]);
    expect(stores[0]!.list()[0]).toMatchObject({ status: 'armed', triggerCount: 1 });
    transition(visible.slice(1), []);
    visible = visible.slice(0, 1);
    expect(stores[1]!.list()[0]?.triggerCount).toBe(0);
    expect(provider.active).toBe(4);
    external();
    visible.forEach((release) => release());
    permanent.forEach((release) => release());
    expect(provider.active).toBe(0);
    monitor.destroy();
  });

  test('a parked once rule keeps its triggered count across lease-only transfers', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = createPriceAlertStore({ providerId: 'p', scopeId: 'parked-once' });
    const id = rule.add({
      query: { symbol: 'ONCE', interval: '1m' },
      price: 0,
      condition: 'crosses-up',
      frequency: 'once',
    });
    const permanent = monitor.attach(rule);
    let visible = monitor.attach(rule);
    const events: number[] = [];
    rule.subscribeEvents((event) => events.push(event.occurrence));
    await tick();
    provider.emit(rule.list()[0]!.query, -1, 1);
    provider.emit(rule.list()[0]!.query, 0, 2);
    expect(events).toEqual([1]);
    const counts = [provider.history, provider.setups, provider.teardowns];
    const park = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [] });
    park.commit();
    park.activate();
    expect(rule.list()[0]).toMatchObject({ status: 'triggered', triggerCount: 1 });
    const show = prepareAlertMembershipReplacement(monitor, { retire: [], attach: [rule] });
    const shown = show.commit();
    expect(shown).toHaveLength(1);
    visible = shown[0]!;
    show.activate();
    provider.emit(rule.list()[0]!.query, -1, 3);
    provider.emit(rule.list()[0]!.query, 0, 4);
    expect(events).toEqual([1]);
    expect(rule.list().find((item) => item.id === id)?.triggerCount).toBe(1);
    expect([provider.history, provider.setups, provider.teardowns]).toEqual(counts);
    visible!();
    permanent();
    monitor.destroy();
  });

  test('activation reconciles a real rule edit committed while retained membership is pending', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = filled('edited', 1);
    const permanent = monitor.attach(rule);
    const visible = monitor.attach(rule);
    await tick();
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [rule] });
    const [next] = tx.commit();
    rule.update(rule.list()[0]!.id, { query: { symbol: 'NEW', interval: '1m' } });
    expect(provider.active).toBe(1);
    tx.activate();
    await tick();
    expect(monitor.getState().queries.map((item) => item.query.symbol)).toEqual(['NEW']);
    expect(provider.active).toBe(1);
    expect(provider.setups).toBe(2);
    expect(provider.teardowns).toBe(1);
    next!();
    permanent();
    monitor.destroy();
  });

  test('a retained feed close during adoption clears stale monitoring status and baseline', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = filled('pending-close', 1);
    const permanent = monitor.attach(rule);
    const visible = monitor.attach(rule);
    await tick();
    provider.emit(rule.list()[0]!.query, -1, 1);
    const events: number[] = [];
    rule.subscribeEvents((event) => events.push(event.occurrence));
    expect(monitor.getState().queries[0]?.status).toBe('monitoring');
    expect(getMonitorInternals(monitor).getResourceSnapshot().baselineEntries).toBe(1);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [rule] });
    const [next] = tx.commit();
    provider.subscriptions[0]!.handlers.onClose();
    tx.activate();
    expect(monitor.getState().queries[0]?.status).toBe('reconnecting');
    expect(getMonitorInternals(monitor).getResourceSnapshot().baselineEntries).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.getState().queries[0]?.status).toBe('monitoring');
    provider.emit(rule.list()[0]!.query, 0, 2);
    expect(events).toEqual([]);
    provider.emit(rule.list()[0]!.query, -1, 3);
    provider.emit(rule.list()[0]!.query, 0, 4);
    expect(events).toEqual([1]);
    next!();
    permanent();
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test('a pending crossing does not retroactively trigger a rule added after the sample', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = filled('pending-add', 1);
    const original = rule.list()[0]!.id;
    const permanent = monitor.attach(rule);
    const visible = monitor.attach(rule);
    await tick();
    provider.emit(rule.list()[0]!.query, -1, 1);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [rule] });
    const [next] = tx.commit();
    provider.emit(rule.list()[0]!.query, 0, 2);
    const added = rule.add({
      query: rule.list()[0]!.query,
      price: 0,
      condition: 'crosses-up',
      frequency: 'repeat',
    });
    tx.activate();
    expect(rule.list().find((item) => item.id === original)?.triggerCount).toBe(1);
    expect(rule.list().find((item) => item.id === added)?.triggerCount).toBe(0);
    next!();
    permanent();
    monitor.destroy();
  });

  test('pending retained callbacks trigger once and respect later edit and rearm chronology', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = createPriceAlertStore({ providerId: 'p', scopeId: 'pending-chronology' });
    const query = { symbol: 'CHRONO', interval: '1m' };
    const once = rule.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' });
    const repeat = rule.add({ query, price: 0, condition: 'crosses-up', frequency: 'repeat' });
    const permanent = monitor.attach(rule);
    const visible = monitor.attach(rule);
    await tick();
    provider.emit(query, -1, 1);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [rule] });
    const [next] = tx.commit();
    provider.emit(query, 0, 2);
    expect(rule.list().map((item) => item.triggerCount)).toEqual([1, 1]);
    rule.update(repeat, { price: 2 });
    rule.rearm(once);
    expect(rule.list().map((item) => item.triggerCount)).toEqual([1, 1]);
    tx.activate();
    expect(rule.list().map((item) => item.triggerCount)).toEqual([1, 1]);
    provider.emit(query, -1, 3);
    provider.emit(query, 0, 4);
    expect(rule.list().find((item) => item.id === once)?.triggerCount).toBe(2);
    expect(rule.list().find((item) => item.id === repeat)?.triggerCount).toBe(1);
    provider.emit(query, 2, 5);
    expect(rule.list().find((item) => item.id === repeat)?.triggerCount).toBe(2);
    next!();
    permanent();
    monitor.destroy();
  });

  test('retained activation clears its reservation after synchronous teardown destroy', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = filled('retained-destroy', 1);
    const permanent = monitor.attach(rule);
    const visible = monitor.attach(rule);
    await tick();
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [visible], attach: [rule] });
    const [next] = tx.commit();
    rule.pause(rule.list()[0]!.id);
    provider.onTeardown = () => monitor.destroy();
    tx.activate();
    expect(getMonitorInternals(monitor).getResourceSnapshot()).toMatchObject({
      destroyed: true,
      members: 0,
      runtimeEntries: 0,
      leaseEntries: 0,
      reservationPending: false,
      activationPending: false,
    });
    expect(provider.active).toBe(0);
    next!();
    permanent();
  });

  test('distinct same-scope objects fence old feeds and survive synchronous teardown destroy', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const old = filled('replace', 1);
    const release = monitor.attach(old);
    await tick();
    const stale = provider.subscriptions[0]!.handlers;
    const replacement = filled('replace', 1);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [release], attach: [replacement] });
    const [next] = tx.commit();
    expect(monitor.getState().queries).toEqual([]);
    let reentryError: unknown;
    provider.onTeardown = () => {
      monitor.destroy();
      try {
        monitor.attach(old);
      } catch (error) {
        reentryError = error;
      }
    };
    tx.activate();
    stale.onBar({ time: 1, open: 0, high: 0, low: 0, close: 0, volume: 1, revision: 1 });
    expect(reentryError).toBeInstanceOf(TypeError);
    expect(monitor.getState()).toMatchObject({ destroyed: true, queries: [] });
    expect(getMonitorInternals(monitor).getResourceSnapshot()).toMatchObject({
      members: 0,
      runtimeEntries: 0,
      leaseEntries: 0,
      activationPending: false,
    });
    expect(provider.active).toBe(0);
    next!();
  });

  test('replaces the same four scopes at 400 rules and 32 queries without calls during commit', () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const oldStores = Array.from({ length: 4 }, (_, index) => filled(`slot-${index}`, 100));
    const oldLeases = oldStores.map((store) => monitor.attach(store));
    expect(provider.active).toBe(32);
    const replacements = Array.from({ length: 4 }, (_, index) => filled(`slot-${index}`, 100));
    let notices = 0;
    monitor.subscribe(() => notices++);
    const before = { setups: provider.setups, teardowns: provider.teardowns, notices };
    const transaction = prepareAlertMembershipReplacement(monitor, {
      retire: oldLeases,
      attach: replacements,
    });
    expect({ setups: provider.setups, teardowns: provider.teardowns, notices }).toEqual(before);
    const nextLeases = transaction.commit();
    expect(nextLeases).toHaveLength(4);
    expect({ setups: provider.setups, teardowns: provider.teardowns, notices }).toEqual(before);
    oldLeases.forEach((release) => {
      release();
      release();
    });
    expect(provider.active).toBe(32);
    provider.hostAdopted = true;
    transaction.activate();
    expect(provider.active).toBe(32);
    expect(provider.teardowns).toBeGreaterThan(0);
    expect(provider.teardownSawOldHost).toBe(false);
    expect(monitor.getState().queries).toHaveLength(32);
    nextLeases.forEach((release) => release());
    expect(provider.active).toBe(0);
    monitor.destroy();
  });

  test('rejects a surviving external lease for a conflicting scope and rejects forged retire tokens', () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const old = filled('same', 1);
    const gridLease = monitor.attach(old);
    const externalLease = monitor.attach(old);
    const replacement = filled('same', 1);
    expect(() =>
      prepareAlertMembershipReplacement(monitor, { retire: [gridLease], attach: [replacement] }),
    ).toThrow();
    expect(() =>
      prepareAlertMembershipReplacement(monitor, { retire: [() => {}], attach: [replacement] }),
    ).toThrow();
    const consumed = monitor.attach(old);
    consumed();
    expect(() =>
      prepareAlertMembershipReplacement(monitor, { retire: [consumed], attach: [replacement] }),
    ).toThrow();
    expect(provider.active).toBe(1);
    externalLease();
    const transaction = prepareAlertMembershipReplacement(monitor, {
      retire: [gridLease],
      attach: [replacement],
    });
    transaction.abort();
    transaction.abort();
    expect(provider.active).toBe(1);
    gridLease();
    monitor.destroy();
  });

  test('stale participating or monitor revisions fail without consuming old leases', () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const old = filled('old', 1);
    const oldLease = monitor.attach(old);
    const replacement = filled('new', 1);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [oldLease], attach: [replacement] });
    replacement.update(replacement.list()[0]!.id, { label: 'changed' });
    expect(() => tx.commit()).toThrow();
    expect(provider.active).toBe(1);
    oldLease();
    const nextOld = filled('later', 1);
    const nextLease = monitor.attach(nextOld);
    const nextReplacement = filled('newest', 1);
    const tx2 = prepareAlertMembershipReplacement(monitor, {
      retire: [nextLease],
      attach: [nextReplacement],
    });
    nextOld.pause(nextOld.list()[0]!.id);
    expect(() => tx2.commit()).toThrow();
    nextLease();
    monitor.destroy();
  });

  test('retiring and reattaching the same store transfers its lease without tearing down membership', () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = filled('retained', 1);
    const original = monitor.attach(rule);
    const tx = prepareAlertMembershipReplacement(monitor, { retire: [original], attach: [rule] });
    const [replacement] = tx.commit();
    expect(provider.active).toBe(1);
    original();
    provider.hostAdopted = true;
    tx.activate();
    expect(monitor.getState().queries).toHaveLength(1);
    expect(provider.active).toBe(1);
    replacement!();
    expect(provider.active).toBe(0);
    monitor.destroy();
  });
});
