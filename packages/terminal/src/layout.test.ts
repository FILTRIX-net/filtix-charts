import { describe, expect, test } from 'vitest';
import {
  copyLayout,
  defaultLayout,
  reconcileLayout,
  resolveLayout,
  sameLayout,
  visiblePaneIds,
} from './layout';
import { resolveStoredStudies } from './studies';
const studies = resolveStoredStudies([
  { id: 'study-1', kind: 'rsi', period: 3, color: '#a8a0dc', lineWidth: 2, visible: false },
  {
    id: 'study-2',
    kind: 'macd',
    fastPeriod: 2,
    slowPeriod: 3,
    signalPeriod: 2,
    color: '#7aa2f7',
    signalColor: '#e0af68',
    positiveColor: '#73c991',
    negativeColor: '#ef7c8e',
    lineWidth: 2,
    visible: true,
  },
]);
describe('canonical terminal layout', () => {
  test('reserves hidden oscillators and disabled volume and reconciles semantic registry order', () => {
    const initial = defaultLayout(studies);
    expect(initial.panes).toEqual([
      { id: 'price', weight: 1, minHeight: 160 },
      { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
      { id: 'terminal-study-1-pane', weight: 0.3, minHeight: 72 },
      { id: 'terminal-study-2-pane', weight: 0.3, minHeight: 72 },
    ]);
    const changed = resolveLayout(
      {
        panes: [{ id: 'terminal-study-1-pane', weight: 4, minHeight: 100 }],
        maximizedPaneId: 'terminal-study-2-pane',
        studiesOpen: true,
      },
      initial,
      visiblePaneIds(studies, false),
    );
    const next = reconcileLayout(changed, [studies[1]!, studies[0]!], false);
    expect(next.panes.map((p) => p.id)).toEqual([
      'price',
      'terminal-volume-pane',
      'terminal-study-2-pane',
      'terminal-study-1-pane',
    ]);
    expect(next.panes[3]?.weight).toBe(4);
    expect(reconcileLayout(next, [studies[0]!], false).maximizedPaneId).toBeNull();
    expect(reconcileLayout(next, [], false).panes).toHaveLength(2);
  });
  test('accepts full finite weight domain and bounded integer minima without coercion', () => {
    const base = defaultLayout([]);
    for (const weight of [Number.MIN_VALUE, Number.MAX_VALUE, 1e-200, 1e200])
      for (const minHeight of [24, 2048])
        expect(
          resolveLayout({ panes: [{ id: 'price', weight, minHeight }] }, base, visiblePaneIds([], false))
            .panes[0],
        ).toEqual({ id: 'price', weight, minHeight });
    for (const value of [NaN, Infinity, 0, -1, null, undefined, '2'])
      expect(() =>
        resolveLayout({ panes: [{ id: 'price', weight: value }] }, base, visiblePaneIds([], true)),
      ).toThrow();
    for (const value of [23, 2049, 24.5, NaN, Infinity, null, undefined, '24'])
      expect(() =>
        resolveLayout({ panes: [{ id: 'price', minHeight: value }] }, base, visiblePaneIds([], true)),
      ).toThrow();
  });
  test('validates complete input before adopting a late invalid entry and retains defensive snapshots', () => {
    const base = defaultLayout(studies),
      before = copyLayout(base);
    expect(() =>
      resolveLayout(
        {
          panes: [
            { id: 'price', weight: 4 },
            { id: 'terminal-study-1-pane', weight: 0 },
          ],
        },
        base,
        visiblePaneIds(studies, true),
      ),
    ).toThrow();
    expect(base).toEqual(before);
    const next = resolveLayout({ panes: [{ id: 'price', weight: 4 }] }, base, visiblePaneIds(studies, true));
    next.panes[0]!.weight = 99;
    expect(base).toEqual(before);
    expect(sameLayout(base, copyLayout(base))).toBe(true);
  });
  test('requires own exact full fields while allowing partial no-ops only for existing IDs', () => {
    const base = defaultLayout([]),
      visible = visiblePaneIds([], true);
    for (const key of ['panes', 'studiesOpen', 'maximizedPaneId']) {
      const value = { ...base } as Record<string, unknown>;
      delete value[key];
      expect(() => resolveLayout(value, base, visible, true)).toThrow();
    }
    for (const key of ['id', 'weight', 'minHeight']) {
      const pane = { ...base.panes[0] } as Record<string, unknown>;
      delete pane[key];
      expect(() => resolveLayout({ ...base, panes: [pane, base.panes[1]] }, base, visible, true)).toThrow();
    }
    expect(resolveLayout({ panes: [{ id: 'price' }] }, base, visible)).toEqual(base);
    expect(() => resolveLayout({ panes: [{ id: 'caller' }] }, base, visible)).toThrow();
    expect(() => resolveLayout({ panes: Array(6).fill({ id: 'price' }) }, base, visible)).toThrow();
  });
});
