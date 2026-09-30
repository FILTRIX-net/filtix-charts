import { describe, expect, test } from 'vitest';
import { copyWorkspaceDocument, decodeWorkspace, queryKey, resolveCatalog, resolveSettings } from './codec';
import { createPriceAlertStore } from '@filtrix.net/alerts';
import type {
  TerminalWorkspaceV1,
  TerminalWorkspaceV2,
  TerminalWorkspaceV3,
  TerminalWorkspaceV4,
  TerminalWorkspaceV4WithDrawingsV2,
} from './types';

const query = { symbol: 'BTCUSDT', interval: '1m' } as const;

test('v5 round-trips alerts and rejects invalid late alerts or out-of-catalog markets', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
    requiredAlertScopeId: 'terminal:scope',
  };
  const alerts = createPriceAlertStore({ providerId: 'fixture', scopeId: 'terminal:scope' });
  alerts.add({ query, price: 0, condition: 'crosses-up', frequency: 'once' });
  const workspace = {
    schema: 'filtix-terminal',
    version: 5,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [],
    layout: {
      panes: [
        { id: 'price', weight: 1, minHeight: 160 },
        { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
      ],
      maximizedPaneId: null,
      studiesOpen: false,
    },
    markets: [
      { query, drawings: { schema: 'filtix-drawings', version: 2, timeDomain: 'utc-ms', drawings: [] } },
    ],
    alerts: alerts.toJSON(),
  };
  const decoded = decodeWorkspace(workspace, context);
  expect(decoded).toEqual(workspace);
  const copy = copyWorkspaceDocument(decoded);
  (copy.alerts.alerts[0]!.query as { symbol: string }).symbol = 'changed';
  expect(decoded.alerts.alerts[0]!.query.symbol).toBe('BTCUSDT');
  expect(() =>
    decodeWorkspace(
      {
        ...workspace,
        alerts: {
          ...workspace.alerts,
          alerts: [
            ...workspace.alerts.alerts,
            { ...workspace.alerts.alerts[0]!, id: 'terminal:scope:2', price: Number.NaN },
          ],
          nextRuleId: 3,
        },
      },
      context,
    ),
  ).toThrow();
  expect(() =>
    decodeWorkspace({ ...workspace, alerts: { ...workspace.alerts, scopeId: 'other' } }, context),
  ).toThrow();
  expect(() =>
    decodeWorkspace(
      {
        ...workspace,
        alerts: {
          ...workspace.alerts,
          alerts: [{ ...workspace.alerts.alerts[0]!, query: { symbol: 'ETHUSDT', interval: '1m' } }],
        },
      },
      context,
    ),
  ).toThrow();
});

test('historical v1-v4 nested v1 and v2 drawings decode to owned v5', () => {
  const oldMarket: TerminalWorkspaceV1['markets'][number] = {
    query,
    drawings: {
      schema: 'filtix-drawings',
      version: 1,
      timeDomain: 'utc-ms',
      drawings: [
        {
          id: 'old',
          type: 'horizontal-line',
          paneId: 'price',
          points: [{ time: 1, price: 10 }],
          style: { color: '#123456', lineWidth: 2, fillOpacity: 0.2 },
        },
      ],
    },
  };
  const settings = { theme: 'dark', followLatest: true, volume: true } as const;
  const legacy1: TerminalWorkspaceV1 = {
    schema: 'filtix-terminal',
    version: 1,
    providerId: 'fixture',
    query,
    settings: { ...settings, emaPeriod: null },
    markets: [oldMarket],
  };
  const legacy2: TerminalWorkspaceV2 = { ...legacy1, version: 2, settings, studies: [] };
  const legacy3: TerminalWorkspaceV3 = { ...legacy2, version: 3 };
  const legacy4: TerminalWorkspaceV4 = {
    ...legacy3,
    version: 4,
    layout: {
      panes: [
        { id: 'price', weight: 1, minHeight: 160 },
        { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
      ],
      maximizedPaneId: null,
      studiesOpen: false,
    },
  };
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  for (const old of [legacy1, legacy2, legacy3, legacy4]) {
    const decoded = decodeWorkspace(old, context);
    expect(decoded.version).toBe(5);
    expect(decoded.alerts).toMatchObject({ scopeId: context.legacyAlertScopeId, alerts: [] });
    expect(decoded.markets[0]!.drawings).toMatchObject({
      version: 2,
      drawings: [{ id: 'old', locked: false, visible: true }],
    });
  }
  const historicalCurrent: TerminalWorkspaceV4WithDrawingsV2 = {
    ...legacy4,
    markets: decodeWorkspace(legacy4, context).markets,
  };
  const current = decodeWorkspace(historicalCurrent, context);
  const copy = copyWorkspaceDocument(current);
  expect(copy).toEqual(current);
  expect(copy.markets[0]!.drawings.drawings[0]).not.toBe(current.markets[0]!.drawings.drawings[0]);
  expect(decodeWorkspace(current, context)).toEqual(current);
});

describe('terminal codec', () => {
  test('resolves documented defaults and validates EMA changes atomically', () => {
    const defaults = resolveSettings();
    expect(defaults).toEqual({ theme: 'dark', followLatest: true, volume: true, emaPeriod: 20 });
    expect(resolveSettings({ theme: 'light', emaPeriod: null }, defaults)).toEqual({
      theme: 'light',
      followLatest: true,
      volume: true,
      emaPeriod: null,
    });
    expect(() => resolveSettings({ theme: 'light', emaPeriod: 1 }, defaults)).toThrow(/EMA period/);
    expect(defaults).toEqual({ theme: 'dark', followLatest: true, volume: true, emaPeriod: 20 });
  });

  test('requires supplied catalogs to include the query and caps their product at 32', () => {
    expect(resolveCatalog(query)).toEqual({ symbols: ['BTCUSDT'], intervals: ['1m'] });
    expect(resolveCatalog(query, ['BTCUSDT', 'ETHUSDT'], ['1m', '5m'])).toEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1m', '5m'],
    });
    expect(() => resolveCatalog(query, ['ETHUSDT'], ['1m'])).toThrow(/include the active query/);
    expect(() => resolveCatalog(query, ['BTCUSDT', 'BTCUSDT'], ['1m'])).toThrow(/unique/);
    expect(() =>
      resolveCatalog(
        query,
        Array.from({ length: 9 }, (_, index) => (index ? `S${index}` : 'BTCUSDT')),
        ['1m', '5m', '15m', '1h'],
      ),
    ).toThrow(/32/);
  });

  test('uses collision-free tuple identities for valid strings containing NUL', () => {
    const first = { symbol: 'A', interval: 'B\u0000C' };
    const second = { symbol: 'A\u0000B', interval: 'C' };
    const context = {
      providerId: 'fixture\u0000provider',
      legacyAlertScopeId: 'terminal:scope',
      symbols: ['A', 'A\u0000B'],
      intervals: ['B\u0000C', 'C'],
    };
    const emptyDrawings = {
      schema: 'filtix-drawings',
      version: 1,
      timeDomain: 'utc-ms',
      drawings: [],
    };
    expect(queryKey(context.providerId, first)).not.toBe(queryKey(context.providerId, second));
    const decoded = decodeWorkspace(
      {
        schema: 'filtix-terminal',
        version: 1,
        providerId: context.providerId,
        query: first,
        settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: 20 },
        markets: [
          { query: first, drawings: emptyDrawings },
          { query: second, drawings: emptyDrawings },
        ],
      },
      context,
    );
    expect(decoded.markets.map((market) => market.query)).toEqual([first, second]);
  });
  test('decodes a complete workspace defensively and rejects malformed markets before use', () => {
    const input = {
      schema: 'filtix-terminal',
      version: 1,
      providerId: 'fixture',
      query: { ...query },
      settings: { theme: 'light', followLatest: false, volume: true, emaPeriod: 8 },
      markets: [
        {
          query: { ...query },
          drawings: {
            schema: 'filtix-drawings',
            version: 1,
            timeDomain: 'utc-ms',
            drawings: [
              {
                id: 'trend-1',
                type: 'trend-line',
                paneId: 'price',
                points: [
                  { time: 1_700_000_000_000, price: 100 },
                  { time: 1_700_000_060_000, price: 105 },
                ],
                style: { color: '#d0ff35', lineWidth: 2, fillOpacity: 0.15 },
              },
            ],
          },
        },
      ],
    };
    const decoded = decodeWorkspace(input, {
      providerId: 'fixture',
      legacyAlertScopeId: 'terminal:scope',
      symbols: ['BTCUSDT'],
      intervals: ['1m'],
    });
    (input.query as { symbol: string }).symbol = 'MUTATED';
    input.markets[0]!.drawings.drawings[0]!.points[0]!.price = 999;
    expect(decoded.query.symbol).toBe('BTCUSDT');
    expect(decoded.markets[0]!.drawings.drawings[0]!.points[0]!.price).toBe(100);

    const missingActive = structuredClone(decoded) as unknown as { markets: unknown[] };
    missingActive.markets = [];
    expect(() =>
      decodeWorkspace(missingActive, {
        providerId: 'fixture',
        legacyAlertScopeId: 'terminal:scope',
        symbols: ['BTCUSDT'],
        intervals: ['1m'],
      }),
    ).toThrow(/active market/i);

    const duplicate = structuredClone(decoded) as unknown as { markets: unknown[] };
    duplicate.markets.push(structuredClone(duplicate.markets[0]));
    expect(() =>
      decodeWorkspace(duplicate, {
        providerId: 'fixture',
        legacyAlertScopeId: 'terminal:scope',
        symbols: ['BTCUSDT'],
        intervals: ['1m'],
      }),
    ).toThrow(/duplicate/i);

    const oversized = structuredClone(decoded) as unknown as {
      markets: Array<{ drawings: { drawings: unknown[] } }>;
    };
    oversized.markets[0]!.drawings.drawings = Array.from({ length: 201 }, () =>
      structuredClone(decoded.markets[0]!.drawings.drawings[0]),
    );
    expect(() =>
      decodeWorkspace(oversized, {
        providerId: 'fixture',
        legacyAlertScopeId: 'terminal:scope',
        symbols: ['BTCUSDT'],
        intervals: ['1m'],
      }),
    ).toThrow(/maximum drawing count/i);
  });
});

test('migrates strict v1 into canonical v5', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const market = {
    query: { ...query },
    drawings: { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] },
  };
  const migrated = decodeWorkspace(
    {
      schema: 'filtix-terminal',
      version: 1,
      providerId: 'fixture',
      query,
      settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: 20 },
      markets: [market],
    },
    context,
  );
  expect(migrated).toMatchObject({
    version: 5,
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [{ id: 'terminal-ema', kind: 'ema', period: 20, color: '#c27a50', lineWidth: 2, visible: true }],
  });
  expect(decodeWorkspace(migrated, context)).toEqual(migrated);
  expect(() =>
    decodeWorkspace({ ...migrated, settings: { ...migrated.settings, emaPeriod: 20 } }, context),
  ).toThrow(/emaPeriod|field/i);
  expect(() => decodeWorkspace({ ...migrated, studies: undefined }, context)).toThrow(/studies|required/i);
});

test('rejects sparse or getter-mutated market arrays before publishing a workspace', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const market = {
    query,
    drawings: { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] },
  };
  const workspace = {
    schema: 'filtix-terminal',
    version: 1,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: null },
    markets: [market, market],
  };
  const sparse = { ...workspace, markets: [market, market] as Array<typeof market> };
  delete sparse.markets[1];
  expect(() => decodeWorkspace(sparse, context)).toThrow(/market|dense|index/i);
  for (const nextLength of [1, 3]) {
    const unstable = { ...workspace, markets: [market, market] as Array<typeof market> };
    Object.defineProperty(unstable.markets, '0', {
      configurable: true,
      get() {
        unstable.markets.length = nextLength;
        return market;
      },
    });
    expect(() => decodeWorkspace(unstable, context)).toThrow(/market|length|stable/i);
  }
});

test('rejects an initially sparse market list before an earlier nested getter can heal the hole', () => {
  const market = {
    query: { ...query },
    drawings: { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] },
  };
  const markets = [market] as Array<{
    query: { symbol: string; interval: string };
    drawings: typeof market.drawings;
  }>;
  markets.length = 2;
  let nestedReads = 0;
  Object.defineProperty(market, 'query', {
    enumerable: true,
    get() {
      nestedReads++;
      markets[1] = { query: { symbol: 'ETHUSDT', interval: '1m' }, drawings: market.drawings };
      return query;
    },
  });
  const workspace = {
    schema: 'filtix-terminal',
    version: 1,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: null },
    markets,
  };
  expect(Object.prototype.hasOwnProperty.call(markets, 1)).toBe(false);
  expect(() =>
    decodeWorkspace(workspace, {
      providerId: 'fixture',
      legacyAlertScopeId: 'terminal:scope',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1m'],
    }),
  ).toThrow(/dense|market/i);
  expect(nestedReads).toBe(0);

  const entry = { query, drawings: market.drawings };
  const dense = [entry];
  let indexReads = 0;
  Object.defineProperty(dense, '0', {
    get() {
      indexReads++;
      return entry;
    },
  });
  expect(
    decodeWorkspace(
      { ...workspace, markets: dense },
      {
        providerId: 'fixture',
        legacyAlertScopeId: 'terminal:scope',
        symbols: ['BTCUSDT'],
        intervals: ['1m'],
      },
    ).markets,
  ).toHaveLength(1);
  expect(indexReads).toBe(1);
});

test('rejects invalid complete v1 and v2 documents without mutating inputs', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const drawings = { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] };
  const base = {
    schema: 'filtix-terminal',
    version: 2,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [{ id: 'study-1', kind: 'sma', period: 3, color: '#C7EF57', lineWidth: 2, visible: true }],
    markets: [{ query, drawings }],
  };
  const snapshot = structuredClone(base);
  expect(decodeWorkspace(base, context).studies[0]?.color).toBe('#c7ef57');
  expect(base).toEqual(snapshot);
  for (const invalid of [
    { ...base, studies: null },
    { ...base, studies: [...base.studies, { ...base.studies[0] }] },
    { ...base, studies: [{ ...base.studies[0], id: 'terminal-ema', kind: 'sma' }] },
    { ...base, studies: [{ ...base.studies[0], unexpected: true }] },
    { ...base, settings: { theme: 'dark', followLatest: true } },
    { ...base, version: 4 },
  ])
    expect(() => decodeWorkspace(invalid, context)).toThrow();
  expect(() =>
    decodeWorkspace(
      {
        schema: 'filtix-terminal',
        version: 1,
        providerId: 'fixture',
        query,
        settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: undefined },
        markets: [{ query, drawings }],
      },
      context,
    ),
  ).toThrow(/EMA|emaPeriod/i);
});

test('migrates exact old-kind v2 and round-trips strict v3 multi-output studies', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const drawings = { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] };
  const market = { query, drawings };
  const oldV2 = {
    schema: 'filtix-terminal',
    version: 2,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [{ id: 'study-4', kind: 'rsi', period: 14, color: '#A8A0DC', lineWidth: 2, visible: false }],
    markets: [market],
  };
  expect(decodeWorkspace(oldV2, context)).toEqual({
    ...oldV2,
    version: 5,
    alerts: {
      schema: 'filtix-price-alerts',
      version: 1,
      scopeId: context.legacyAlertScopeId,
      providerId: 'fixture',
      nextRuleId: 1,
      alerts: [],
    },
    markets: [{ query, drawings: { ...drawings, version: 2 } }],
    layout: {
      panes: [
        { id: 'price', weight: 1, minHeight: 160 },
        { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
        { id: 'terminal-study-4-pane', weight: 0.3, minHeight: 72 },
      ],
      maximizedPaneId: null,
      studiesOpen: false,
    },
    studies: [{ id: 'study-4', kind: 'rsi', period: 14, color: '#a8a0dc', lineWidth: 2, visible: false }],
  });

  const current = {
    schema: 'filtix-terminal',
    version: 3,
    providerId: 'fixture',
    query,
    settings: { theme: 'light', followLatest: false, volume: true },
    studies: [
      {
        id: 'study-7',
        kind: 'macd',
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        color: '#7AA2F7',
        signalColor: '#E0AF68',
        positiveColor: '#73C991',
        negativeColor: '#EF7C8E',
        lineWidth: 2,
        visible: true,
      },
      {
        id: 'study-8',
        kind: 'bollinger',
        period: 20,
        multiplier: 2.5,
        color: '#C7EF57',
        upperColor: '#7AA2F7',
        lowerColor: '#7AA2F7',
        fillColor: '#7AA2F7',
        fillOpacity: 0,
        lineWidth: 3,
        visible: false,
      },
    ],
    markets: [market],
  };
  const decoded = decodeWorkspace(current, context);
  expect(decoded.version).toBe(5);
  expect(decoded.studies).toEqual([
    {
      ...current.studies[0],
      color: '#7aa2f7',
      signalColor: '#e0af68',
      positiveColor: '#73c991',
      negativeColor: '#ef7c8e',
    },
    {
      ...current.studies[1],
      color: '#c7ef57',
      upperColor: '#7aa2f7',
      lowerColor: '#7aa2f7',
      fillColor: '#7aa2f7',
    },
  ]);
  expect(decodeWorkspace(decoded, context)).toEqual(decoded);

  const missingStyle = structuredClone(current) as {
    studies: Array<Record<string, unknown>>;
  };
  delete missingStyle.studies[0]!.signalColor;
  expect(() => decodeWorkspace(missingStyle, context)).toThrow(/signalColor|required/i);

  const foreign = structuredClone(current) as { studies: Array<Record<string, unknown>> };
  foreign.studies[1]!.positiveColor = '#73c991';
  expect(() => decodeWorkspace(foreign, context)).toThrow(/field/i);

  expect(() =>
    decodeWorkspace(
      {
        ...current,
        version: 2,
      },
      context,
    ),
  ).toThrow(/v2|kind|macd/i);
});

test('rejects own __proto__ fields in canonical and legacy workspace records and nested records', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const drawings = { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] };
  const market = { query: { ...query }, drawings };
  const v1 = {
    schema: 'filtix-terminal',
    version: 1,
    providerId: 'fixture',
    query: { ...query },
    settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: 20 },
    markets: [market],
  };
  const v2 = {
    schema: 'filtix-terminal',
    version: 2,
    providerId: 'fixture',
    query: { ...query },
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [singleStudy()],
    markets: [market],
  };
  const v3 = { ...v2, version: 3 };
  const hostile = <T extends object>(value: T): T => {
    const copy = structuredClone(value);
    Object.defineProperty(copy, '__proto__', {
      value: { unexpected: true },
      enumerable: true,
      configurable: true,
    });
    return copy;
  };
  const nested = <T extends Record<string, any>>(value: T, key: string): T => ({
    ...structuredClone(value),
    [key]: hostile(structuredClone(value[key])),
  });
  const marketNested = <T extends Record<string, any>>(value: T, transform: (entry: any) => any): T => ({
    ...structuredClone(value),
    markets: [transform(structuredClone(value.markets[0]))],
  });
  const cases = [
    hostile(v1),
    nested(v1, 'query'),
    nested(v1, 'settings'),
    hostile(v2),
    nested(v2, 'query'),
    nested(v2, 'settings'),
    { ...structuredClone(v2), studies: [hostile(singleStudy())] },
    hostile(v3),
    nested(v3, 'query'),
    nested(v3, 'settings'),
    marketNested(v3, hostile),
    marketNested(v3, (entry) => ({ ...entry, query: hostile(entry.query) })),
  ];

  for (const document of cases) expect(() => decodeWorkspace(document, context)).toThrow(/field|__proto__/i);

  let reads = 0;
  const getterDocument = structuredClone(v3) as Record<string, unknown>;
  Object.defineProperty(getterDocument, '__proto__', {
    enumerable: true,
    get() {
      reads += 1;
      return { unexpected: true };
    },
  });
  expect(() => decodeWorkspace(getterDocument, context)).toThrow(/field|__proto__/i);
  expect(reads).toBe(1);
});

function singleStudy() {
  return {
    id: 'study-1',
    kind: 'sma',
    period: 3,
    color: '#c7ef57',
    lineWidth: 2,
    visible: true,
  };
}

test('v4 requires exact complete canonical layout and normalizes semantic ordering', () => {
  const context = {
    providerId: 'fixture',
    legacyAlertScopeId: 'terminal:scope',
    symbols: ['BTCUSDT'],
    intervals: ['1m'],
  };
  const base = {
    schema: 'filtix-terminal',
    version: 4,
    providerId: 'fixture',
    query,
    settings: { theme: 'dark', followLatest: true, volume: false },
    studies: [{ ...singleStudy(), kind: 'rsi', visible: false }],
    markets: [
      { query, drawings: { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] } },
    ],
    layout: {
      panes: [
        { id: 'terminal-study-1-pane', weight: 4, minHeight: 96 },
        { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
        { id: 'price', weight: 2, minHeight: 160 },
      ],
      maximizedPaneId: null,
      studiesOpen: true,
    },
  };
  const output = decodeWorkspace(base, context);
  expect(output.layout.panes.map((p) => p.id)).toEqual([
    'price',
    'terminal-volume-pane',
    'terminal-study-1-pane',
  ]);
  expect(output.layout.panes[0]?.weight).toBe(2);
  expect(decodeWorkspace(output, context)).toEqual(output);
  const badLayouts: unknown[] = [
    undefined,
    null,
    {},
    { ...base.layout, panes: base.layout.panes.slice(1) },
    { ...base.layout, panes: [...base.layout.panes, base.layout.panes[0]] },
    { ...base.layout, maximizedPaneId: 'terminal-volume-pane' },
    { ...base.layout, maximizedPaneId: 'terminal-study-1-pane' },
    { ...base.layout, studiesOpen: undefined },
    { ...base.layout, panes: [...base.layout.panes.slice(0, 2), { id: 'price', weight: 2, minHeight: 23 }] },
    {
      ...base.layout,
      panes: [...base.layout.panes.slice(0, 2), Object.create({ id: 'price', weight: 2, minHeight: 160 })],
    },
    { ...base.layout, [Symbol('bad')]: true },
  ];
  const proto = JSON.parse(JSON.stringify(base.layout));
  Object.defineProperty(proto, '__proto__', { value: true, enumerable: true });
  badLayouts.push(proto);
  for (const layout of badLayouts) expect(() => decodeWorkspace({ ...base, layout }, context)).toThrow();
  for (const version of [1, 2, 3]) expect(() => decodeWorkspace({ ...base, version }, context)).toThrow();
  expect(base.layout.panes[0]?.id).toBe('terminal-study-1-pane');
});
