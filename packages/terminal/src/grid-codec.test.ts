import { describe, expect, test } from 'vitest';
import { createPriceAlertStore } from '@filtrix.net/alerts';
import { copyGridWorkspace, decodeGridWorkspace } from './grid-codec';
import { decodeWorkspace } from './codec';
import type { TerminalGridCellId, TerminalGridWorkspace } from './grid-types';

const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'] as const;
const query = { symbol: 'BTCUSDT', interval: '1m' } as const;
const context = {
  providerId: 'fixture',
  symbols: ['BTCUSDT'],
  intervals: ['1m'],
  legacyAlertScopeIds: {
    'cell-1': 'grid-one:cell-1',
    'cell-2': 'grid-one:cell-2',
    'cell-3': 'grid-one:cell-3',
    'cell-4': 'grid-one:cell-4',
  },
};

function v1() {
  return {
    schema: 'filtix-terminal',
    version: 1,
    providerId: 'fixture',
    query: { ...query },
    settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: null },
    markets: [
      {
        query: { ...query },
        drawings: { schema: 'filtix-drawings', version: 1, timeDomain: 'utc-ms', drawings: [] },
      },
    ],
  };
}

function grid(workspaces: unknown[] = ids.map(() => v1())): Record<string, unknown> {
  return {
    schema: 'filtix-terminal-grid',
    version: 1,
    providerId: 'fixture',
    layout: 4,
    activeCellId: 'cell-3',
    sync: { viewport: false, crosshair: false, crosshairMatch: 'exact' },
    cells: ids.map((id, index) => ({ id, workspace: workspaces[index] })),
  };
}

function decode(value: unknown, overrides: Partial<typeof context> = {}): TerminalGridWorkspace {
  return decodeGridWorkspace(value, { ...context, ...overrides });
}

function currentWithAlerts(id: TerminalGridCellId, symbols: readonly string[], rules: number) {
  const terminal = decodeWorkspace(v1(), {
    providerId: context.providerId,
    symbols: ['BTCUSDT', ...symbols],
    intervals: ['1m'],
    legacyAlertScopeId: context.legacyAlertScopeIds[id],
  });
  const alerts = createPriceAlertStore({
    providerId: context.providerId,
    scopeId: context.legacyAlertScopeIds[id],
  });
  for (let n = 0; n < rules; n++)
    alerts.add({
      query: { symbol: symbols[n % symbols.length]!, interval: '1m' },
      price: n,
      condition: 'crosses-up',
      frequency: 'repeat',
    });
  return { ...terminal, alerts: alerts.toJSON() };
}

describe('terminal grid workspace codec', () => {
  test('canonicalizes four unordered cells and copies nested workspaces independently', () => {
    const input = grid();
    (input.cells as unknown[]).reverse();
    const before = structuredClone(input);
    const decoded = decode(input);
    expect(input).toEqual(before);
    expect(decoded.cells.map((cell) => cell.id)).toEqual(ids);
    expect(decoded.cells.map((cell) => cell.workspace.alerts.scopeId)).toEqual(
      ids.map((id) => context.legacyAlertScopeIds[id]),
    );
    expect(decoded.cells.every((cell) => cell.workspace.version === 5)).toBe(true);
    expect(decoded.cells.every((cell) => cell.workspace.markets[0]?.drawings.version === 2)).toBe(true);
    (decoded.cells[0]!.workspace.query as { symbol: string }).symbol = 'MUTATED';
    expect((input.cells as Array<{ workspace: ReturnType<typeof v1> }>)[3]!.workspace.query.symbol).toBe(
      'BTCUSDT',
    );
    const copy = copyGridWorkspace(decode(input));
    (copy.sync as { viewport: boolean }).viewport = true;
    (copy.cells[0]!.workspace.markets[0]!.query as { symbol: string }).symbol = 'CHANGED';
    expect(decode(input).sync.viewport).toBe(false);
    expect(
      (input.cells as Array<{ workspace: ReturnType<typeof v1> }>)[3]!.workspace.markets[0]!.query.symbol,
    ).toBe('BTCUSDT');
  });

  test('rejects malformed outer envelopes, cell membership, hidden active cells and sync fields', () => {
    const base = grid();
    for (const field of ['schema', 'version', 'providerId', 'layout', 'activeCellId', 'sync', 'cells']) {
      const missing = structuredClone(base);
      delete missing[field];
      expect(() => decode(missing)).toThrow();
    }
    for (const invalid of [
      { ...base, extra: true },
      { ...base, schema: 'other' },
      { ...base, version: 2 },
      { ...base, providerId: 'other' },
      { ...base, layout: 3 },
      { ...base, layout: 1, activeCellId: 'cell-2' },
      { ...base, layout: 2, activeCellId: 'cell-3' },
      { ...base, activeCellId: 'cell-5' },
      { ...base, sync: { viewport: true, crosshair: false } },
      { ...base, sync: { viewport: 1, crosshair: false, crosshairMatch: 'exact' } },
      { ...base, sync: { viewport: false, crosshair: false, crosshairMatch: 'closest' } },
      { ...base, sync: { viewport: false, crosshair: false, crosshairMatch: 'exact', extra: true } },
      { ...base, cells: [] },
      { ...base, cells: (base.cells as unknown[]).slice(0, 3) },
      { ...base, cells: [...(base.cells as unknown[]), (base.cells as unknown[])[0]] },
      {
        ...base,
        cells: [
          { id: 'cell-1', workspace: v1() },
          ...(base.cells as unknown[]).slice(1, 3),
          { id: 'cell-1', workspace: v1() },
        ],
      },
      { ...base, cells: [{ id: 'cell-5', workspace: v1() }, ...(base.cells as unknown[]).slice(1)] },
      {
        ...base,
        cells: [{ id: 'cell-1', workspace: v1(), extra: true }, ...(base.cells as unknown[]).slice(1)],
      },
    ])
      expect(() => decode(invalid)).toThrow();
  });

  test('rejects malformed last nested workspace and duplicate alert scopes without changing input', () => {
    const base = grid();
    const malformed = structuredClone(base) as {
      cells: Array<{ id: string; workspace: { providerId: string } }>;
    };
    malformed.cells[3]!.workspace.providerId = 'other';
    expect(() => decode(malformed)).toThrow();
    const wrongCatalog = structuredClone(base) as { cells: Array<{ workspace: ReturnType<typeof v1> }> };
    (wrongCatalog.cells[3]!.workspace.query as { symbol: string }).symbol = 'OTHER';
    expect(() => decode(wrongCatalog)).toThrow(/catalog/i);
    expect(decode(base).cells).toHaveLength(4);
    const canonical = ids.map((id) => currentWithAlerts(id, ['BTCUSDT'], 0));
    canonical[3]!.alerts.scopeId = canonical[0]!.alerts.scopeId;
    expect(() => decode(grid(canonical))).toThrow();
    expect(() =>
      decode(base, {
        legacyAlertScopeIds: {
          ...context.legacyAlertScopeIds,
          'cell-4': context.legacyAlertScopeIds['cell-1'],
        },
      }),
    ).toThrow();
  });

  test('rejects sparse, growing and shrinking cell arrays and reads a cell getter once', () => {
    const base = grid() as { cells: Array<{ id: string; workspace: unknown }> };
    const sparse = grid() as typeof base;
    delete sparse.cells[1];
    expect(() => decode(sparse)).toThrow();
    for (const nextLength of [3, 5]) {
      const unstable = grid() as typeof base;
      Object.defineProperty(unstable.cells, '0', {
        configurable: true,
        get() {
          unstable.cells.length = nextLength;
          return base.cells[0];
        },
      });
      expect(() => decode(unstable)).toThrow();
    }
    let reads = 0;
    Object.defineProperty(base.cells, '0', {
      configurable: true,
      get() {
        reads++;
        return { id: 'cell-1', workspace: v1() };
      },
    });
    expect(decode(base).cells).toHaveLength(4);
    expect(reads).toBe(1);
  });

  test('delegates historical v1-v5 nested migrations and preserves canonical v5 alert state', () => {
    const first = v1();
    const second = {
      ...v1(),
      version: 2,
      settings: { theme: 'dark', followLatest: true, volume: true },
      studies: [],
    };
    const third = { ...second, version: 3 };
    const fourth = {
      ...third,
      version: 4,
      layout: decodeWorkspace(v1(), { ...context, legacyAlertScopeId: context.legacyAlertScopeIds['cell-4'] })
        .layout,
    };
    const legacy = decode(grid([first, second, third, fourth]));
    expect(legacy.cells.map((cell) => cell.workspace.version)).toEqual([5, 5, 5, 5]);
    expect(legacy.cells.map((cell) => cell.workspace.alerts.alerts.length)).toEqual([0, 0, 0, 0]);
    const v4WithDrawingsV2 = {
      ...fourth,
      markets: decodeWorkspace(v1(), {
        ...context,
        legacyAlertScopeId: context.legacyAlertScopeIds['cell-4'],
      }).markets,
    };
    expect(
      decode(grid([first, second, third, v4WithDrawingsV2])).cells[3]!.workspace.markets[0]!.drawings.version,
    ).toBe(2);
    const fifth = currentWithAlerts('cell-4', ['BTCUSDT'], 1);
    const triggered = fifth.alerts.alerts[0]!;
    triggered.status = 'triggered';
    triggered.triggerCount = 2;
    triggered.lastTrigger = {
      id: JSON.stringify([fifth.alerts.scopeId, triggered.id, 2]),
      scopeId: fifth.alerts.scopeId,
      alertId: triggered.id,
      providerId: context.providerId,
      query: { ...triggered.query },
      condition: triggered.condition,
      threshold: triggered.price,
      previousPrice: triggered.price - 1,
      price: triggered.price + 1,
      barTime: 1_700_000_000_000,
      observedAt: 1_700_000_000_100,
      occurrence: 2,
    };
    const v5 = decode(grid([first, second, third, fifth]));
    expect(v5.cells[3]!.workspace.alerts).toEqual(fifth.alerts);
    expect(decode(v5)).toEqual(v5);
  });

  test('accepts exact aggregate 400/32 and rejects 33 armed query keys or a 401st rule', () => {
    const symbols = ['BTCUSDT', ...Array.from({ length: 32 }, (_, index) => `S${index}`)];
    const four = ids.map((id, index) => currentWithAlerts(id, symbols.slice(index * 8, index * 8 + 8), 100));
    const exact = decode(grid(four), { symbols: symbols.slice(0, 32) });
    expect(exact.cells.reduce((sum, cell) => sum + cell.workspace.alerts.alerts.length, 0)).toBe(400);
    four[3] = currentWithAlerts('cell-4', symbols.slice(24, 33), 100);
    expect(() => decode(grid(four), { symbols })).toThrow(/32|query|capacity/i);
    const extra = structuredClone(four) as typeof four;
    extra[0]!.alerts = {
      ...extra[0]!.alerts,
      alerts: [
        ...extra[0]!.alerts.alerts,
        { ...extra[0]!.alerts.alerts[0]!, id: `${extra[0]!.alerts.scopeId}:101` },
      ],
      nextRuleId: 102,
    };
    expect(() => decode(grid(extra), { symbols })).toThrow();
  });
});
