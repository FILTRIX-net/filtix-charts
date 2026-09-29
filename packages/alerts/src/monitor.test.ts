import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  FeedSession,
  FeedSessionOptions,
  HistoryPage,
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from '@filtix/datafeed';
import { createPriceAlertStore } from './store';
import { createPriceAlertMonitor } from './monitor';
import { prepareAlertMembershipReplacement } from './membership';

const captured = vi.hoisted(() => ({ sessions: [] as FeedSession[] }));
vi.mock('@filtix/datafeed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@filtix/datafeed')>();
  return {
    ...actual,
    createFeedSession(options: FeedSessionOptions) {
      const session = actual.createFeedSession(options);
      captured.sessions.push(session);
      return session;
    },
  };
});

const query = { symbol: 'BTC', interval: '1m' };
const key = (value: MarketQuery) => JSON.stringify([value.symbol, value.interval]);
const bar = (time: number, close: number, revision = 1): MarketBar => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1,
  revision,
});
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

class Provider implements MarketDataProvider {
  readonly id = 'p';
  readonly revisionMode = 'monotonic';
  readonly maxPageSize = 100;
  readonly requests: HistoryRequest[] = [];
  readonly subscriptions: Array<{ query: MarketQuery; handlers: MarketStreamHandlers; active: boolean }> = [];
  readonly pages = new Map<string, HistoryPage[]>();
  synchronousTeardown = false;
  synchronousBar: MarketBar | null = null;
  failHistory = false;
  onSubscribe: ((value: MarketQuery) => void) | null = null;
  onUnsubscribe: ((value: MarketQuery) => void) | null = null;
  getHistory(request: HistoryRequest): Promise<HistoryPage> {
    this.requests.push({ ...request });
    if (this.failHistory) return Promise.reject(new Error('history unavailable'));
    return Promise.resolve(this.pages.get(key(request))?.shift() ?? { bars: [], exhausted: true });
  }
  subscribe(value: MarketQuery, handlers: MarketStreamHandlers): () => void {
    const record = { query: { ...value }, handlers, active: true };
    this.subscriptions.push(record);
    if (this.synchronousBar) handlers.onBar(this.synchronousBar);
    this.onSubscribe?.(value);
    return () => {
      record.active = false;
      if (this.synchronousTeardown) handlers.onClose();
      this.onUnsubscribe?.(value);
    };
  }
  emit(value: MarketQuery, valueBar: MarketBar): void {
    for (const item of this.subscriptions)
      if (item.active && key(item.query) === key(value)) item.handlers.onBar(valueBar);
  }
  active(value: MarketQuery): number {
    return this.subscriptions.filter((item) => item.active && key(item.query) === key(value)).length;
  }
  close(value: MarketQuery): void {
    for (const item of this.subscriptions)
      if (item.active && key(item.query) === key(value)) item.handlers.onClose();
  }
}

function store(scopeId: string, market = query, frequency: 'once' | 'repeat' = 'once') {
  const result = createPriceAlertStore({ providerId: 'p', scopeId });
  const id = result.add({ query: market, price: 0, condition: 'crosses-up', frequency });
  return { result, id };
}

function filled(scopeId: string, count: number, market = query) {
  const result = createPriceAlertStore({ providerId: 'p', scopeId });
  for (let index = 0; index < count; index++)
    result.add({ query: market, price: 0, condition: 'crosses-up', frequency: 'once' });
  return result;
}

afterEach(() => {
  vi.useRealTimers();
  captured.sessions.length = 0;
});

describe('grouped price alert monitor', () => {
  test.each([9, 32])(
    'finite synchronous provider reentry eventually monitors all %i queries',
    async (count) => {
      vi.useFakeTimers();
      const provider = new Provider();
      const monitor = createPriceAlertMonitor({ provider });
      const rules = createPriceAlertStore({ providerId: 'p', scopeId: `chain-${count}` });
      const input = (index: number) => ({
        query: { symbol: `Q${index}`, interval: '1m' },
        price: 0,
        condition: 'crosses' as const,
        frequency: 'repeat' as const,
      });
      const nestedErrors: unknown[] = [];
      provider.onSubscribe = (value) => {
        const index = Number(value.symbol.slice(1));
        if (index + 1 < count) {
          try {
            rules.add(input(index + 1));
          } catch (error) {
            nestedErrors.push(error);
          }
        }
      };
      monitor.attach(rules);
      rules.add(input(0));
      await vi.advanceTimersByTimeAsync(20);
      expect(nestedErrors).toEqual([]);
      expect(rules.list()).toHaveLength(count);
      expect(monitor.getState().queries).toHaveLength(count);
      expect(provider.subscriptions.filter((item) => item.active)).toHaveLength(count);
      monitor.destroy();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('pending drain is cancelled by destroy and by prepared membership activation', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const old = createPriceAlertStore({ providerId: 'p', scopeId: 'drain-old' });
    const input = (index: number) => ({
      query: { symbol: `Q${index}`, interval: '1m' },
      price: 0,
      condition: 'crosses' as const,
      frequency: 'once' as const,
    });
    provider.onSubscribe = (value) => {
      const index = Number(value.symbol.slice(1));
      if (index < 8) old.add(input(index + 1));
    };
    const release = monitor.attach(old);
    old.add(input(0));
    expect(old.list()).toHaveLength(9);
    const timersBeforeCommit = vi.getTimerCount();
    expect(timersBeforeCommit).toBeGreaterThan(0);
    const replacement = store('drain-new', { symbol: 'NEW', interval: '1m' });
    const tx = prepareAlertMembershipReplacement(monitor, {
      retire: [release],
      attach: [replacement.result],
    });
    const [nextRelease] = tx.commit();
    expect(vi.getTimerCount()).toBe(timersBeforeCommit - 1);
    tx.activate();
    await vi.advanceTimersByTimeAsync(20);
    expect(provider.subscriptions.filter((item) => item.active).map((item) => item.query.symbol)).toEqual([
      'NEW',
    ]);
    expect(provider.subscriptions.some((item) => item.query.symbol === 'Q8')).toBe(false);
    nextRelease!();
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);

    const secondProvider = new Provider();
    const secondMonitor = createPriceAlertMonitor({ provider: secondProvider });
    const secondRules = createPriceAlertStore({ providerId: 'p', scopeId: 'drain-destroy' });
    secondProvider.onSubscribe = (value) => {
      const index = Number(value.symbol.slice(1));
      if (index < 8) secondRules.add(input(index + 1));
    };
    secondMonitor.attach(secondRules);
    secondRules.add(input(0));
    secondMonitor.destroy();
    await vi.advanceTimersByTimeAsync(20);
    expect(secondProvider.subscriptions.some((item) => item.query.symbol === 'Q8')).toBe(false);
    expect(secondProvider.subscriptions.filter((item) => item.active)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('earlier host listener cannot admit a nested 401st rule', () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rules = [filled('A', 99), filled('B', 99), filled('C', 100), filled('D', 100), filled('E', 1)];
    let nestedRuleError: unknown = null;
    rules[0]!.subscribe(() => {
      try {
        rules[1]!.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' });
      } catch (error) {
        nestedRuleError = error;
      }
    });
    rules.forEach((item) => monitor.attach(item));
    rules[0]!.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' });
    expect(nestedRuleError).toBeInstanceOf(Error);
    expect(rules.map((item) => item.list().length)).toEqual([100, 99, 100, 100, 1]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('earlier host listener cannot admit a 33rd query', () => {
    vi.useFakeTimers();
    const queryProvider = new Provider();
    const queryMonitor = createPriceAlertMonitor({ provider: queryProvider });
    const first = createPriceAlertStore({ providerId: 'p', scopeId: 'many' });
    const second = createPriceAlertStore({ providerId: 'p', scopeId: 'nested' });
    for (let index = 0; index < 31; index++)
      first.add({
        query: { symbol: `Q${index}`, interval: '1m' },
        price: 0,
        condition: 'crosses',
        frequency: 'once',
      });
    let nestedQueryError: unknown = null;
    first.subscribe(() => {
      try {
        second.add({
          query: { symbol: 'Q32', interval: '1m' },
          price: 0,
          condition: 'crosses',
          frequency: 'once',
        });
      } catch (error) {
        nestedQueryError = error;
      }
    });
    queryMonitor.attach(first);
    queryMonitor.attach(second);
    first.add({
      query: { symbol: 'Q31', interval: '1m' },
      price: 0,
      condition: 'crosses',
      frequency: 'once',
    });
    expect(nestedQueryError).toBeInstanceOf(Error);
    expect(second.list()).toHaveLength(0);
    expect(queryMonitor.getState().queries).toHaveLength(32);
    expect(queryProvider.subscriptions.filter((item) => item.active)).toHaveLength(32);
    queryMonitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ordinary attach sees canonical peer state during an earlier host listener', () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const peers = [filled('A', 99), filled('B', 100), filled('C', 100), filled('D', 100)];
    const extra = filled('extra', 1);
    let attachError: unknown = null;
    peers[0]!.subscribe(() => {
      try {
        monitor.attach(extra);
      } catch (error) {
        attachError = error;
      }
    });
    peers.forEach((item) => monitor.attach(item));
    peers[0]!.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' });
    expect(attachError).toBeInstanceOf(Error);
    expect(peers.map((item) => item.list().length)).toEqual([100, 100, 100, 100]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('synchronous setup destruction stops later queries', () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const dual = store('dual', { symbol: 'A', interval: '1m' });
    dual.result.add({
      query: { symbol: 'B', interval: '1m' },
      price: 0,
      condition: 'crosses',
      frequency: 'once',
    });
    provider.onSubscribe = () => monitor.destroy();
    monitor.attach(dual.result);
    expect(provider.subscriptions.map((item) => item.query.symbol)).toEqual(['A']);
    expect(provider.subscriptions.filter((item) => item.active)).toHaveLength(0);
    expect(monitor.getState()).toMatchObject({ destroyed: true, queries: [] });
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('synchronous setup membership change skips a newly retired second query', () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const dual = store('dual-membership', { symbol: 'A', interval: '1m' });
    const secondId = dual.result.add({
      query: { symbol: 'B', interval: '1m' },
      price: 0,
      condition: 'crosses',
      frequency: 'once',
    });
    provider.onSubscribe = (value) => {
      if (value.symbol === 'A') dual.result.pause(secondId);
    };
    monitor.attach(dual.result);
    expect(provider.subscriptions.map((item) => item.query.symbol)).toEqual(['A']);
    expect(provider.subscriptions.filter((item) => item.active)).toHaveLength(1);
    expect(monitor.getState().queries.map((item) => item.query.symbol)).toEqual(['A']);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('synchronous teardown supersession cannot revive a retired query', () => {
    vi.useFakeTimers();
    const teardownProvider = new Provider();
    const monitor = createPriceAlertMonitor({ provider: teardownProvider });
    const changing = store('changing', { symbol: 'OLD', interval: '1m' });
    monitor.attach(changing.result);
    teardownProvider.onUnsubscribe = () => changing.result.pause(changing.id);
    changing.result.update(changing.id, { query: { symbol: 'RETIRED', interval: '1m' } });
    expect(teardownProvider.subscriptions.map((item) => item.query.symbol)).toEqual(['OLD']);
    expect(teardownProvider.subscriptions.filter((item) => item.active)).toHaveLength(0);
    expect(monitor.getState().queries).toEqual([]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('shares one latest transport per query and reference-counts store leases', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('a');
    const second = store('b');
    const other = store('c', { symbol: 'BTC', interval: '5m' });
    const a = monitor.attach(first.result);
    const a2 = monitor.attach(first.result);
    const b = monitor.attach(second.result);
    const c = monitor.attach(other.result);
    await tick();
    expect(provider.active(query)).toBe(1);
    expect(provider.active(other.result.list()[0]!.query)).toBe(1);
    expect(provider.requests.map((request) => request.limit)).toEqual([1, 1]);
    expect(monitor.getState().queries).toHaveLength(2);
    a();
    a();
    a2();
    expect(provider.active(query)).toBe(1);
    b();
    expect(provider.active(query)).toBe(0);
    c();
    expect(provider.active(other.result.list()[0]!.query)).toBe(0);
    monitor.destroy();
  });

  test('accepted steady latest bars advance prices without a public transport-state notification', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('steady', query, 'repeat');
    const events: number[] = [];
    rule.result.subscribeEvents((event) => events.push(event.price));
    monitor.attach(rule.result);
    await tick();
    expect(monitor.getState().queries[0]).toMatchObject({ status: 'monitoring', error: null });
    const states: string[] = [];
    monitor.subscribe(() => states.push(monitor.getState().queries[0]!.status));
    provider.emit(query, bar(10, -2));
    provider.emit(query, bar(11, -1));
    expect(events).toEqual([]);
    expect(states).toEqual([]);
    monitor.destroy();
  });

  test('reconnect state remains observable and its empty baseline still seeds before crossing', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('steady-gap', query, 'repeat');
    const events: number[] = [];
    rule.result.subscribeEvents((event) => events.push(event.price));
    monitor.attach(rule.result);
    await tick();
    const states: string[] = [];
    monitor.subscribe(() => states.push(monitor.getState().queries[0]!.status));
    provider.emit(query, bar(10, -1));
    provider.close(query);
    expect(states).toContain('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states.at(-1)).toBe('monitoring');
    provider.emit(query, bar(11, 0));
    expect(events).toEqual([]);
    provider.emit(query, bar(12, -1));
    provider.emit(query, bar(13, 0));
    expect(events).toEqual([0]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('same mapped reconnect status publishes a changed retryAfterMs during real feed reentry', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('retry-after');
    monitor.attach(rule.result);
    await tick();
    const retryAfter: Array<number | undefined> = [];
    monitor.subscribe(() => {
      const state = monitor.getState().queries[0]!;
      if (state.status !== 'reconnecting' || state.error?.code !== 'STALE') return;
      retryAfter.push(state.error.retryAfterMs);
      if (state.error.retryAfterMs === undefined)
        provider.subscriptions
          .find((item) => item.active)
          ?.handlers.onError({
            code: 'STALE',
            message: state.error.message,
            retryable: true,
            retryAfterMs: 250,
          });
    });
    provider.emit(query, bar(10, -1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(retryAfter).toEqual([undefined, 250]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('subscriber destroy during a reconnect notification fences later transport callbacks', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('state-destroy');
    monitor.attach(rule.result);
    await tick();
    const observations: string[] = [];
    monitor.subscribe(() => {
      const status = monitor.getState().queries[0]?.status;
      if (status === 'reconnecting') {
        observations.push(status);
        monitor.destroy();
      }
    });
    const stale = provider.subscriptions[0]!.handlers;
    provider.close(query);
    stale.onBar(bar(11, 0));
    expect(observations).toEqual(['reconnecting']);
    expect(monitor.getState().destroyed).toBe(true);
    expect(provider.active(query)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('seeds first price, triggers once or repeatedly, and fences reentrant sibling rearm', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const one = store('once');
    const repeat = store('repeat', query, 'repeat');
    const sibling = store('sibling');
    const received: string[] = [];
    one.result.subscribeEvents(() => {
      received.push('once');
      sibling.result.rearm(sibling.id);
    });
    repeat.result.subscribeEvents(() => received.push('repeat'));
    sibling.result.subscribeEvents(() => received.push('sibling'));
    monitor.attach(one.result);
    monitor.attach(repeat.result);
    monitor.attach(sibling.result);
    await tick();
    provider.emit(query, bar(10, -1));
    expect(received).toEqual([]);
    provider.emit(query, bar(10, 0, 2));
    expect(received).toEqual(['once', 'repeat']);
    expect(one.result.list()[0]).toMatchObject({ status: 'triggered', triggerCount: 1 });
    expect(sibling.result.list()[0]).toMatchObject({ status: 'armed', triggerCount: 0 });
    provider.emit(query, bar(11, 1));
    provider.emit(query, bar(12, -1));
    provider.emit(query, bar(13, 0));
    expect(received).toEqual(['once', 'repeat', 'repeat', 'sibling']);
    monitor.destroy();
  });

  test('one live update reaches every eligible rule despite earlier trigger commits and throwing observers', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('multi');
    const secondId = first.result.add({ query, price: 0, condition: 'crosses-up', frequency: 'repeat' });
    const other = store('other');
    const observed: string[] = [];
    first.result.subscribeEvents(() => {
      throw new Error('host observer');
    });
    first.result.subscribeEvents((event) => observed.push(event.alertId));
    other.result.subscribeEvents((event) => observed.push(event.alertId));
    monitor.subscribe(() => {
      throw new Error('host state observer');
    });
    monitor.attach(first.result);
    monitor.attach(other.result);
    await tick();
    provider.emit(query, bar(10, -1));
    provider.emit(query, bar(11, 0));
    expect(observed).toEqual([first.id, secondId, other.id]);
    expect(first.result.list().map((rule) => rule.triggerCount)).toEqual([1, 1]);
    expect(other.result.list()[0]?.triggerCount).toBe(1);
    monitor.destroy();
  });

  test('empty reconnect clears the baseline and next accepted live price only seeds', async () => {
    vi.useFakeTimers();
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('gap');
    const events: number[] = [];
    rule.result.subscribeEvents((event) => events.push(event.price));
    monitor.attach(rule.result);
    await tick();
    provider.emit(query, bar(10, -1));
    provider.close(query);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.getState().queries[0]?.status).toBe('monitoring');
    provider.emit(query, bar(11, 0));
    expect(events).toEqual([]);
    provider.emit(query, bar(12, -1));
    provider.emit(query, bar(13, 0));
    expect(events).toEqual([0]);
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('history and retry establish baselines without replay, then live close changes cross', async () => {
    const provider = new Provider();
    provider.pages.set(key(query), [{ bars: [bar(10, -1)], exhausted: true }]);
    provider.synchronousBar = bar(11, -2);
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('history', query, 'repeat');
    const received: number[] = [];
    rule.result.subscribeEvents((event) => received.push(event.price));
    monitor.attach(rule.result);
    await tick();
    expect(received).toEqual([]);
    provider.emit(query, bar(12, 0));
    expect(received).toEqual([0]);
    provider.failHistory = true;
    await monitor.retry();
    expect(monitor.getState().queries[0]?.status).toBe('reconnecting');
    expect(received).toEqual([0]);
    provider.failHistory = false;
    provider.synchronousBar = null;
    provider.pages.set(key(query), [{ bars: [bar(20, -1)], exhausted: true }]);
    await monitor.retry();
    expect(received).toEqual([0]);
    provider.emit(query, bar(21, 0));
    expect(received).toEqual([0, 0]);
    const snapshot = monitor.getState();
    snapshot.queries[0]!.query.symbol = 'changed';
    expect(monitor.getState().queries[0]!.query.symbol).toBe('BTC');
    monitor.destroy();
  });

  test('accepted correction replaces the baseline without a retroactive event', async () => {
    const provider = new Provider();
    provider.pages.set(key(query), [{ bars: [bar(10, -1)], exhausted: true }]);
    const monitor = createPriceAlertMonitor({ provider });
    const rule = store('correction', query, 'repeat');
    const received: number[] = [];
    rule.result.subscribeEvents((event) => received.push(event.price));
    monitor.attach(rule.result);
    await tick();
    const session = captured.sessions.at(-1)!;
    session.applyCorrections([bar(10, 1, 2)]);
    expect(received).toEqual([]);
    provider.emit(query, bar(11, -1));
    expect(received).toEqual([]);
    provider.emit(query, bar(12, 0));
    expect(received).toEqual([0]);
    monitor.destroy();
  });

  test('restore does not replay saved lastTrigger and pausing the final rule closes its feed', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('saved', query, 'repeat');
    monitor.attach(first.result);
    await tick();
    provider.emit(query, bar(10, -1));
    provider.emit(query, bar(11, 0));
    const saved = first.result.toJSON();
    expect(saved.alerts[0]?.triggerCount).toBe(1);
    monitor.destroy();

    const nextProvider = new Provider();
    nextProvider.pages.set(key(query), [{ bars: [bar(11, 0)], exhausted: true }]);
    const nextMonitor = createPriceAlertMonitor({ provider: nextProvider });
    const restored = createPriceAlertStore({ providerId: 'p', scopeId: 'saved' });
    restored.restore(saved);
    const occurrences: number[] = [];
    restored.subscribeEvents((event) => occurrences.push(event.occurrence));
    nextMonitor.attach(restored);
    await tick();
    expect(occurrences).toEqual([]);
    restored.pause(first.id);
    expect(nextProvider.active(query)).toBe(0);
    restored.rearm(first.id);
    await tick();
    nextProvider.emit(query, bar(12, -1));
    nextProvider.emit(query, bar(13, 0));
    expect(occurrences).toEqual([2]);
    nextMonitor.destroy();
  });

  test('destroy in the first event callback fences later rules and obsolete provider callbacks', async () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('first');
    const second = store('second');
    const observed: string[] = [];
    first.result.subscribeEvents(() => {
      observed.push('first');
      monitor.destroy();
    });
    second.result.subscribeEvents(() => observed.push('second'));
    monitor.attach(first.result);
    monitor.attach(second.result);
    await tick();
    const stale = provider.subscriptions[0]!.handlers;
    provider.emit(query, bar(10, -1));
    provider.emit(query, bar(11, 0));
    stale.onBar(bar(12, -1));
    stale.onBar(bar(13, 0));
    expect(observed).toEqual(['first']);
    expect(provider.active(query)).toBe(0);
    expect(monitor.getState().destroyed).toBe(true);
  });

  test('rejects duplicate scope and prospectively enforces 400 rules and 32 armed queries', () => {
    const provider = new Provider();
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('same');
    monitor.attach(first.result);
    expect(() => monitor.attach(store('same').result)).toThrow();
    const stores = Array.from({ length: 4 }, (_, index) =>
      createPriceAlertStore({ providerId: 'p', scopeId: `bulk-${index}` }),
    );
    for (const [index, item] of stores.entries()) {
      for (let number = 0; number < (index === 3 ? 99 : 100); number++)
        item.add({
          query: { symbol: `M${(index * 100 + number) % 31}`, interval: '1m' },
          price: 0,
          condition: 'crosses-up',
          frequency: 'once',
        });
    }
    for (const item of stores) monitor.attach(item);
    expect(() => stores[3]!.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' })).toThrow();
    expect(stores[3]!.list()).toHaveLength(99);
    stores[0]!.remove(stores[0]!.list().at(-1)!.id);
    const paused = createPriceAlertStore({ providerId: 'p', scopeId: 'paused' });
    const id = paused.add({
      query: { symbol: 'THIRTY-THIRD', interval: '1m' },
      price: 0,
      condition: 'crosses',
      frequency: 'once',
    });
    paused.pause(id);
    monitor.attach(paused);
    expect(() => paused.rearm(id)).toThrow();
    expect(paused.list()[0]?.status).toBe('paused');
    monitor.destroy();
  });

  test('destroyed attached store releases transport without a new bar and ignores teardown callbacks', async () => {
    const provider = new Provider();
    provider.synchronousTeardown = true;
    const monitor = createPriceAlertMonitor({ provider });
    const first = store('destroy');
    const release = monitor.attach(first.result);
    await tick();
    first.result.destroy();
    expect(provider.active(query)).toBe(0);
    expect(monitor.getState().queries).toEqual([]);
    release();
    release();
    monitor.destroy();
  });
});
