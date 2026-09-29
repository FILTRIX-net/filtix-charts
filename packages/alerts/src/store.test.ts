import { describe, expect, test } from 'vitest';
import { createPriceAlertStore, getStoreCapability } from './store';
import { preparePriceAlertStoreRestore } from './store';
import { createPriceAlertMonitor } from './monitor';
import type { MarketDataProvider } from '@filtix/datafeed';
import type { PriceAlertEvent, PriceAlertInput } from './types';

const owner = { providerId: 'p', scopeId: 'scope:a' };
const input: PriceAlertInput = {
  query: { symbol: 'BTC', interval: '1m' },
  price: 0,
  condition: 'crosses-up',
  frequency: 'once',
};
function trigger(alertId: string, occurrence = 1): PriceAlertEvent {
  return {
    id: JSON.stringify([owner.scopeId, alertId, occurrence]),
    scopeId: owner.scopeId,
    alertId,
    providerId: owner.providerId,
    query: { ...input.query },
    condition: input.condition,
    threshold: input.price,
    previousPrice: -1,
    price: 0,
    barTime: 10,
    observedAt: 20,
    occurrence,
  };
}

describe('price alert store', () => {
  test('prepared in-place restore publishes host and store before external observers', () => {
    const store = createPriceAlertStore(owner);
    store.add(input);
    const next = store.toJSON();
    next.alerts[0]!.price = 7;
    let hostVersion = 'old';
    const observed: string[] = [];
    store.subscribe(() => observed.push(`${hostVersion}:${store.list()[0]?.price}`));
    const prepared = preparePriceAlertStoreRestore(store, next);
    expect(store.list()[0]?.price).toBe(0);
    prepared.commit({
      assertCurrent() {
        expect(hostVersion).toBe('old');
      },
      adopt() {
        hostVersion = 'new';
      },
    });
    expect(store.list()[0]?.price).toBe(7);
    expect(observed).toEqual([]);
    prepared.activate();
    prepared.activate();
    expect(observed).toEqual(['new:7']);
  });

  test('prepared no-op still adopts host without store revision or notification', () => {
    const store = createPriceAlertStore(owner);
    const capability = getStoreCapability(store);
    const revision = capability.revision;
    let changes = 0;
    let adopted = false;
    store.subscribe(() => changes++);
    const prepared = preparePriceAlertStoreRestore(store, store.toJSON());
    prepared.commit({
      assertCurrent() {},
      adopt() {
        adopted = true;
      },
    });
    prepared.activate();
    expect(adopted).toBe(true);
    expect(changes).toBe(0);
    expect(capability.revision).toBe(revision);
  });

  test('prepared restore rechecks other monitor members before silent adoption', () => {
    const provider: MarketDataProvider = {
      id: 'p',
      revisionMode: 'monotonic',
      maxPageSize: 1,
      getHistory: async () => ({ bars: [], exhausted: true }),
      subscribe: () => () => {},
    };
    const monitor = createPriceAlertMonitor({ provider });
    const store = createPriceAlertStore(owner);
    store.add(input);
    const peer = createPriceAlertStore({ providerId: 'p', scopeId: 'peer' });
    for (let index = 1; index <= 30; index++)
      peer.add({ ...input, query: { symbol: `Q${index}`, interval: '1m' } });
    monitor.attach(store);
    monitor.attach(peer);
    const current = store.toJSON();
    const next = {
      ...current,
      nextRuleId: 3,
      alerts: [
        ...current.alerts,
        { ...current.alerts[0]!, id: `${owner.scopeId}:2`, query: { symbol: 'Q31', interval: '1m' } },
      ],
    };
    const prepared = preparePriceAlertStoreRestore(store, next);
    peer.add({ ...input, query: { symbol: 'Q32', interval: '1m' } });
    let adopted = false;
    expect(() =>
      prepared.commit({
        assertCurrent() {},
        adopt() {
          adopted = true;
        },
      }),
    ).toThrow();
    expect(adopted).toBe(false);
    expect(store.list()).toHaveLength(1);
    monitor.destroy();
  });

  test('prepared restore rejects changed store revision and abort stays silent', () => {
    const store = createPriceAlertStore(owner);
    store.add(input);
    const next = store.toJSON();
    next.alerts[0]!.price = 10;
    const prepared = preparePriceAlertStoreRestore(store, next);
    store.update(next.alerts[0]!.id, { label: 'external' });
    let adopted = false;
    expect(() =>
      prepared.commit({
        assertCurrent() {},
        adopt() {
          adopted = true;
        },
      }),
    ).toThrow();
    prepared.abort();
    prepared.abort();
    expect(adopted).toBe(false);
    expect(store.list()[0]).toMatchObject({ price: 0, label: 'external' });
  });

  test('prepared restore checks host generation after final admission before either adoption', () => {
    const store = createPriceAlertStore(owner);
    store.add(input);
    const next = store.toJSON();
    next.alerts[0]!.price = 10;
    let hostCurrent = true;
    let adopted = false;
    let changes = 0;
    store.subscribe(() => changes++);
    let admissions = 0;
    getStoreCapability(store).registerAdmission(() => {
      admissions++;
      if (admissions === 2) hostCurrent = false;
    });
    const prepared = preparePriceAlertStoreRestore(store, next);
    expect(() =>
      prepared.commit({
        assertCurrent() {
          if (!hostCurrent) throw new Error('host superseded');
        },
        adopt() {
          adopted = true;
        },
      }),
    ).toThrow('host superseded');
    prepared.abort();
    expect(admissions).toBe(2);
    expect(adopted).toBe(false);
    expect(store.list()[0]!.price).toBe(0);
    expect(changes).toBe(0);
  });

  test('rejects getter-grown or malformed restore before admissions or public observers', () => {
    const store = createPriceAlertStore(owner);
    store.add(input);
    const before = store.toJSON();
    const capability = getStoreCapability(store);
    const revision = capability.revision;
    let admissions = 0;
    let changes = 0;
    capability.registerAdmission(() => admissions++);
    store.subscribe(() => changes++);
    const rule = (number: number) => ({ ...before.alerts[0]!, id: `${owner.scopeId}:${number}` });
    const grown = [rule(1)];
    Object.defineProperty(grown, 0, {
      configurable: true,
      enumerable: true,
      get() {
        for (let index = 2; index <= 101; index++) grown.push(rule(index));
        return rule(1);
      },
    });
    expect(() => store.restore({ ...before, nextRuleId: 102, alerts: grown })).toThrow();
    const invalidLate = [rule(1), rule(2)];
    Object.defineProperty(invalidLate, 0, {
      configurable: true,
      enumerable: true,
      get() {
        invalidLate[1] = { ...rule(2), price: Number.NaN };
        return rule(1);
      },
    });
    expect(() => store.restore({ ...before, nextRuleId: 3, alerts: invalidLate })).toThrow();
    expect(store.toJSON()).toEqual(before);
    expect(capability.revision).toBe(revision);
    expect(admissions).toBe(0);
    expect(changes).toBe(0);
  });

  test('generates bounded stable IDs, notifies once per edit and returns defensive snapshots', () => {
    const store = createPriceAlertStore(owner);
    let changes = 0;
    store.subscribe(() => changes++);
    const source = { ...input, query: { ...input.query }, label: '  ' };
    const first = store.add(source);
    expect(first).toBe('scope:a:1');
    source.query.symbol = 'MUTATED';
    const listed = store.list();
    (listed[0]!.query as { symbol: string }).symbol = 'MUTATED';
    expect(store.list()[0]).toMatchObject({
      id: first,
      query: input.query,
      label: '  ',
      status: 'armed',
      triggerCount: 0,
      lastTrigger: null,
    });
    expect(store.toJSON()).toMatchObject({
      schema: 'filtix-price-alerts',
      version: 1,
      ...owner,
      nextRuleId: 2,
    });
    store.update(first, { label: '' });
    store.update(first, { label: '' });
    store.pause(first);
    store.pause(first);
    expect(changes).toBe(3);
    expect(store.remove(first)).toBe(true);
    expect(store.remove(first)).toBe(false);
    expect(store.add(input)).toBe('scope:a:2');
    expect(changes).toBe(5);
  });

  test('rejects invalid edits and restore atomically before observer notification', () => {
    const store = createPriceAlertStore(owner);
    const id = store.add(input);
    let changes = 0;
    store.subscribe(() => changes++);
    const before = store.toJSON();
    const badInputs: unknown[] = [
      { ...input, price: Number.NaN },
      { ...input, price: Number.POSITIVE_INFINITY },
      { ...input, condition: 'above' },
      { ...input, frequency: 'sometimes' },
      { ...input, query: { symbol: '', interval: '1m' } },
      { ...input, label: 'x'.repeat(121) },
      { ...input, unknown: 1 },
    ];
    for (const candidate of badInputs) expect(() => store.add(candidate as PriceAlertInput)).toThrow();
    for (const patch of [
      { price: Number.NaN },
      { label: undefined },
      { unknown: 1 },
      { query: { symbol: 'BTC', interval: ' ' } },
    ])
      expect(() => store.update(id, patch as Partial<PriceAlertInput>)).toThrow();
    for (const value of [
      { ...before, providerId: 'wrong' },
      { ...before, scopeId: 'wrong' },
      { ...before, alerts: [before.alerts[0], before.alerts[0]] },
    ])
      expect(() => store.restore(value)).toThrow();
    expect(store.toJSON()).toEqual(before);
    expect(changes).toBe(0);
  });

  test('enforces 100 rules and the safe identity counter without a partial edit', () => {
    const store = createPriceAlertStore(owner);
    for (let i = 0; i < 100; i++) store.add(input);
    const full = store.toJSON();
    expect(full.alerts).toHaveLength(100);
    expect(() => store.add(input)).toThrow();
    expect(store.toJSON()).toEqual(full);
    store.remove('scope:a:100');
    const nearLimit = { ...store.toJSON(), nextRuleId: Number.MAX_SAFE_INTEGER };
    store.restore(nearLimit);
    expect(() => store.add(input)).toThrow();
    expect(store.toJSON()).toEqual(nearLimit);
  });

  test('runs immutable admission before commit and fences reentrant edits', () => {
    const store = createPriceAlertStore(owner);
    const capability = getStoreCapability(store);
    let changes = 0;
    store.subscribe(() => changes++);
    const reject = capability.registerAdmission((next) => {
      expect(Object.isFrozen(next.alerts)).toBe(true);
      expect(Object.isFrozen(next.alerts[0]!.query)).toBe(true);
      throw new Error('capacity');
    });
    expect(() => store.add(input)).toThrow('capacity');
    expect(store.list()).toEqual([]);
    expect(changes).toBe(0);
    reject();
    let nested = false;
    const release = capability.registerAdmission(() => {
      if (!nested) {
        nested = true;
        release();
        store.add(input);
      }
    });
    expect(() => store.add(input)).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(changes).toBe(1);
  });

  test('fences getter reentry during add, restore and trigger candidate validation', () => {
    const store = createPriceAlertStore(owner);
    const outer = { ...input };
    Object.defineProperty(outer, 'price', {
      get() {
        store.add(input);
        return 2;
      },
    });
    expect(() => store.add(outer)).toThrow();
    expect(store.list()).toHaveLength(1);
    const id = store.list()[0]!.id;
    const candidate = store.toJSON();
    Object.defineProperty(candidate, 'scopeId', {
      get() {
        store.pause(id);
        return owner.scopeId;
      },
    });
    expect(() => store.restore(candidate)).toThrow();
    expect(store.list()[0]!.status).toBe('paused');
    store.rearm(id);
    const proposed = trigger(id);
    Object.defineProperty(proposed, 'threshold', {
      get() {
        store.remove(id);
        return 0;
      },
    });
    expect(getStoreCapability(store).commitTrigger(id, proposed)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test('commits trigger before defensive change/event dispatch and preserves historical lastTrigger', () => {
    const store = createPriceAlertStore(owner);
    const id = store.add(input);
    const capability = getStoreCapability(store);
    const seen: PriceAlertEvent[] = [];
    let changes = 0;
    store.subscribe(() => changes++);
    store.subscribeEvents((event) => {
      expect(store.list()[0]).toMatchObject({ status: 'triggered', triggerCount: 1, lastTrigger: event });
      (event.query as { symbol: string }).symbol = 'MUTATED';
      throw new Error('observer');
    });
    store.subscribeEvents((event) => seen.push(event));
    expect(capability.commitTrigger(id, trigger(id))).toBe(true);
    expect(changes).toBe(1);
    expect(seen).toEqual([trigger(id)]);
    expect(capability.commitTrigger(id, trigger(id, 2))).toBe(false);
    store.update(id, {
      query: { symbol: 'ETH', interval: '1m' },
      price: 2,
      condition: 'crosses-down',
      frequency: 'repeat',
    });
    expect(store.list()[0]).toMatchObject({ status: 'triggered', triggerCount: 1, lastTrigger: trigger(id) });
    expect(capability.commitTrigger(id, trigger(id, 2))).toBe(false);
    store.rearm(id);
    expect(store.list()[0]).toMatchObject({ status: 'armed', triggerCount: 1, lastTrigger: trigger(id) });
  });

  test('explicit armed-to-armed rearm signals only that rule before public observers', () => {
    const store = createPriceAlertStore(owner);
    const first = store.add(input);
    const second = store.add(input);
    const capability = getStoreCapability(store);
    const order: string[] = [];
    const startRevision = capability.revision;
    capability.subscribeLifecycle((event) =>
      order.push(`${event.type}:${event.type === 'rearm' ? event.alertId : ''}`),
    );
    store.subscribe(() => order.push('change'));
    store.update(first, { price: 0 });
    store.pause(second);
    store.pause(second);
    expect(order).toEqual(['change']);
    order.length = 0;
    store.rearm(first);
    expect(order).toEqual([`rearm:${first}`, 'change']);
    expect(capability.revision).toBe(startRevision + 2);
    expect(store.list().find((rule) => rule.id === first)?.status).toBe('armed');
  });

  test('destroy is terminal before isolated private callbacks and retains defensive final snapshots', () => {
    const store = createPriceAlertStore(owner);
    const id = store.add(input);
    const capability = getStoreCapability(store);
    const before = store.toJSON();
    const order: string[] = [];
    const staleAdmission = capability.registerAdmission(() => order.push('admission'));
    const staleChange = store.subscribe(() => order.push('change'));
    const staleEvent = store.subscribeEvents(() => order.push('event'));
    const staleLife = capability.subscribeLifecycle((event) => {
      order.push(event.type);
      expect(capability.commitTrigger(id, trigger(id))).toBe(false);
      expect(() => store.add(input)).toThrow();
      throw new Error('isolated');
    });
    capability.subscribeLifecycle(() => order.push('second-destroy'));
    const startRevision = capability.revision;
    store.destroy();
    store.destroy();
    expect(capability.revision).toBe(startRevision + 1);
    expect(order).toEqual(['destroy', 'second-destroy']);
    expect(store.toJSON()).toEqual(before);
    (store.list()[0]!.query as { symbol: string }).symbol = 'MUTATED';
    expect(store.list()[0]!.query.symbol).toBe('BTC');
    for (const release of [staleAdmission, staleChange, staleEvent, staleLife]) expect(release).not.toThrow();
    expect(() => store.subscribe(() => {})).toThrow();
    expect(() => store.subscribeEvents(() => {})).toThrow();
    expect(() => capability.subscribeLifecycle(() => {})).toThrow();
    expect(() => capability.registerAdmission(() => {})).toThrow();
    expect(capability.commitTrigger(id, trigger(id))).toBe(false);
    expect(() => store.restore(before)).toThrow();
  });
});
