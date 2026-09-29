import { describe, expect, test } from 'vitest';
import { copyPriceAlertDocument, createEmptyPriceAlertDocument, decodePriceAlertDocument } from './codec';
import type { PriceAlertDocument, PriceAlertEvent } from './types';

const context = { providerId: 'provider', scopeId: 'slot:1' };
const query = { symbol: 'BTC', interval: '1m' };
function event(occurrence = 1): PriceAlertEvent {
  return {
    id: JSON.stringify(['slot:1', 'slot:1:1', occurrence]),
    scopeId: 'slot:1',
    alertId: 'slot:1:1',
    providerId: 'provider',
    query,
    condition: 'crosses-up',
    threshold: 0,
    previousPrice: -1,
    price: 0,
    barTime: 100,
    observedAt: 200,
    occurrence,
  };
}
function document(): PriceAlertDocument {
  return {
    schema: 'filtix-price-alerts',
    version: 1,
    ...context,
    nextRuleId: 2,
    alerts: [
      {
        id: 'slot:1:1',
        query,
        price: 0,
        condition: 'crosses-up',
        frequency: 'once',
        status: 'triggered',
        triggerCount: 1,
        lastTrigger: event(),
      },
    ],
  };
}

describe('price alert document codec', () => {
  test('rejects getter-driven growth and shrink while accepting a dense 100-rule boundary', () => {
    const base = document();
    const rule = (number: number) => ({
      ...base.alerts[0]!,
      id: `slot:1:${number}`,
      status: 'armed' as const,
      triggerCount: 0,
      lastTrigger: null,
    });
    const dense = Array.from({ length: 100 }, (_, index) => rule(index + 1));
    expect(
      decodePriceAlertDocument({ ...base, nextRuleId: 101, alerts: dense }, context).alerts,
    ).toHaveLength(100);
    expect(() =>
      decodePriceAlertDocument({ ...base, nextRuleId: 102, alerts: [...dense, rule(101)] }, context),
    ).toThrow();

    for (const targetLength of [2, 101]) {
      const rows = [rule(1)];
      Object.defineProperty(rows, 0, {
        configurable: true,
        enumerable: true,
        get() {
          for (let index = 2; index <= targetLength; index++) rows.push(rule(index));
          return rule(1);
        },
      });
      expect(() => decodePriceAlertDocument({ ...base, nextRuleId: 102, alerts: rows }, context)).toThrow();
    }

    const shrinking = [rule(1), rule(2)];
    Object.defineProperty(shrinking, 0, {
      configurable: true,
      enumerable: true,
      get() {
        shrinking.pop();
        return rule(1);
      },
    });
    expect(() => decodePriceAlertDocument({ ...base, nextRuleId: 3, alerts: shrinking }, context)).toThrow();

    const invalidLate = [rule(1), rule(2)];
    Object.defineProperty(invalidLate, 0, {
      configurable: true,
      enumerable: true,
      get() {
        invalidLate[1] = { ...rule(2), price: Number.NaN };
        return rule(1);
      },
    });
    expect(() =>
      decodePriceAlertDocument({ ...base, nextRuleId: 3, alerts: invalidLate }, context),
    ).toThrow();

    const holed = [rule(1), rule(2)];
    Object.defineProperty(holed[1], 'price', {
      configurable: true,
      enumerable: true,
      get() {
        delete holed[0];
        return 0;
      },
    });
    expect(() => decodePriceAlertDocument({ ...base, nextRuleId: 3, alerts: holed }, context)).toThrow();
  });

  test('creates and copies exact independent canonical documents', () => {
    const empty = createEmptyPriceAlertDocument(context);
    expect(empty).toEqual({
      schema: 'filtix-price-alerts',
      version: 1,
      ...context,
      nextRuleId: 1,
      alerts: [],
    });
    const source = document();
    const first = decodePriceAlertDocument(source, context);
    const second = copyPriceAlertDocument(first);
    expect(second).toEqual(source);
    (source.alerts[0]!.query as { symbol: string }).symbol = 'CHANGED';
    (first.alerts[0]!.lastTrigger!.query as { symbol: string }).symbol = 'CHANGED';
    expect(second.alerts[0]!.query.symbol).toBe('BTC');
    expect(second.alerts[0]!.lastTrigger!.query.symbol).toBe('BTC');
  });

  test('rejects unknown, symbol, absent and sparse fields at each level', () => {
    const base = document();
    expect(() => decodePriceAlertDocument({ ...base, extra: true }, context)).toThrow();
    expect(() =>
      decodePriceAlertDocument({ ...base, alerts: [{ ...base.alerts[0], extra: 1 }] }, context),
    ).toThrow();
    expect(() =>
      decodePriceAlertDocument(
        { ...base, alerts: [{ ...base.alerts[0], query: { ...query, extra: 1 } }] },
        context,
      ),
    ).toThrow();
    expect(() =>
      decodePriceAlertDocument(
        { ...base, alerts: [{ ...base.alerts[0], lastTrigger: { ...event(), extra: 1 } }] },
        context,
      ),
    ).toThrow();
    const missing = { ...base } as Record<string, unknown>;
    delete missing.nextRuleId;
    expect(() => decodePriceAlertDocument(missing, context)).toThrow();
    expect(() => decodePriceAlertDocument({ ...base, [Symbol('unknown')]: true }, context)).toThrow();
    const sparse = new Array(1);
    expect(() => decodePriceAlertDocument({ ...base, alerts: sparse }, context)).toThrow();
  });

  test('rejects wrong identities, canonical IDs, duplicates and exhausted counters', () => {
    const base = document();
    for (const changed of [
      { ...base, providerId: 'other' },
      { ...base, scopeId: 'other' },
      { ...base, nextRuleId: 1 },
      { ...base, nextRuleId: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, alerts: [...base.alerts, base.alerts[0]] },
      { ...base, alerts: [{ ...base.alerts[0], id: 'other:1' }] },
      { ...base, alerts: [{ ...base.alerts[0], id: 'slot:1:01' }] },
      { ...base, alerts: [{ ...base.alerts[0], lastTrigger: { ...event(), scopeId: 'other' } }] },
    ])
      expect(() => decodePriceAlertDocument(changed, context)).toThrow();
    expect(() => decodePriceAlertDocument(base, { providerId: 'provider' })).not.toThrow();
    expect(() =>
      decodePriceAlertDocument(base, { providerId: 'provider', scopeId: undefined }),
    ).not.toThrow();
  });

  test('rejects invalid counts, finite fields, query and labels while preserving historical events', () => {
    const base = document();
    const rule = base.alerts[0]!;
    for (const changed of [
      { ...rule, price: Number.NaN },
      { ...rule, triggerCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...rule, triggerCount: -1 },
      { ...rule, triggerCount: 0 },
      { ...rule, lastTrigger: null },
      { ...rule, label: 'x'.repeat(121) },
      { ...rule, query: { symbol: ' BTC', interval: '1m' } },
      { ...rule, lastTrigger: { ...event(), previousPrice: Number.POSITIVE_INFINITY } },
      { ...rule, lastTrigger: { ...event(), barTime: Number.NaN } },
      { ...rule, lastTrigger: { ...event(), observedAt: Number.POSITIVE_INFINITY } },
      { ...rule, lastTrigger: { ...event(), occurrence: 2 } },
      { ...rule, lastTrigger: { ...event(), id: 'wrong' } },
    ])
      expect(() => decodePriceAlertDocument({ ...base, alerts: [changed] }, context)).toThrow();
    expect(() =>
      decodePriceAlertDocument(
        { ...base, alerts: [{ ...rule, price: -4, label: '  ', condition: 'crosses-down' }] },
        context,
      ),
    ).not.toThrow();
  });
});
