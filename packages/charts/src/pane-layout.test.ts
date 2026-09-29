import { describe, expect, it } from 'vitest';
import { measurePaneLayout, resizePanePair } from './pane-layout';

const layout = {
  panes: [
    { id: 'price', weight: 1, minHeight: 160 },
    { id: 'volume', weight: 0.26, minHeight: 64 },
    { id: 'rsi', weight: 0.3, minHeight: 72 },
  ],
  maximizedPaneId: null,
};

describe('measurePaneLayout', () => {
  it('distributes floor then weighted free space with exact chart budget', () => {
    const actual = measurePaneLayout(layout, 600);
    expect(actual.plotHeight).toBe(572);
    expect(actual.panes.map((pane) => pane.id)).toEqual(['price', 'volume', 'rsi']);
    expect(actual.panes[0]!.top).toBe(0);
    expect(actual.panes[1]!.top).toBeCloseTo(actual.panes[0]!.height + 5, 8);
    expect(actual.panes[2]!.top).toBeCloseTo(actual.panes[1]!.top + actual.panes[1]!.height + 5, 8);
    expect(actual.panes[2]!.top + actual.panes[2]!.height).toBeCloseTo(572, 8);
    expect(actual.panes[0]!.height).toBeCloseTo(160 + 266 / 1.56, 8);
  });
  it('compresses impossible minima and recovers finite zero geometry', () => {
    const tiny = measurePaneLayout(layout, 60);
    expect(tiny.panes[0]!.height).toBeCloseTo((22 * 160) / 296, 10);
    expect(tiny.panes[1]!.height).toBeCloseTo((22 * 64) / 296, 10);
    expect(tiny.panes[2]!.height).toBeCloseTo((22 * 72) / 296, 10);
    const zero = measurePaneLayout(layout, 0);
    expect(zero.plotHeight).toBe(0);
    expect(zero.panes.every((pane) => pane.top === 0 && pane.height === 0)).toBe(true);
  });
  it('maximizes one pane without gaps or changing preferences', () => {
    const actual = measurePaneLayout({ ...layout, maximizedPaneId: 'rsi' }, 600);
    expect(actual.panes).toEqual([
      { id: 'price', top: 0, height: 0 },
      { id: 'volume', top: 0, height: 0 },
      { id: 'rsi', top: 0, height: 572 },
    ]);
  });
  it('rejects invalid full height before allocation', () => {
    for (const value of [Infinity, -Infinity, NaN, -1])
      expect(() => measurePaneLayout({ panes: [], maximizedPaneId: null }, value)).toThrow();
  });
  it('requires complete, exact and internally consistent measured layouts', () => {
    const invalid: unknown[] = [
      { panes: layout.panes },
      { panes: layout.panes, maximizedPaneId: 'missing' },
      { panes: [layout.panes[0], layout.panes[0]], maximizedPaneId: null },
      { panes: [{ id: 'price', weight: 1 }], maximizedPaneId: null },
      { panes: [{ id: 'price', weight: Infinity, minHeight: 48 }], maximizedPaneId: null },
      { panes: [{ id: 'price', weight: 1, minHeight: 0 }], maximizedPaneId: null },
      {
        panes: [Object.assign(Object.create({ id: 'price' }), { weight: 1, minHeight: 48 })],
        maximizedPaneId: null,
      },
      {
        panes: [{ id: 'price', weight: 1, minHeight: 48, [Symbol('foreign')]: true }],
        maximizedPaneId: null,
      },
      { panes: [], maximizedPaneId: null, foreign: true },
    ];
    for (const candidate of invalid) expect(() => measurePaneLayout(candidate as never, 600)).toThrow();
  });
  it('conserves a subnormal pair and leaves a third pane unchanged at the half-step boundary', () => {
    const unit = Number.MIN_VALUE;
    const source = {
      panes: [
        { id: 'price', weight: unit, minHeight: 48 },
        { id: 'volume', weight: 2 * unit, minHeight: 48 },
        { id: 'caller', weight: 3 * unit, minHeight: 48 },
      ],
      maximizedPaneId: null,
    };
    const before = measurePaneLayout(source, 600);
    for (const delta of [34.833333333333336, -Number.MAX_VALUE, Number.MAX_VALUE]) {
      const changed = resizePanePair(source, 600, 0, delta);
      const after = measurePaneLayout(changed, 600);
      expect(changed.panes[0]!.weight + changed.panes[1]!.weight).toBe(3 * unit);
      expect(changed.panes[2]!.weight).toBe(3 * unit);
      expect(after.panes[2]!.top).toBeCloseTo(before.panes[2]!.top, 12);
      expect(after.panes[2]!.height).toBeCloseTo(before.panes[2]!.height, 12);
    }
    const minimum = measurePaneLayout(resizePanePair(source, 600, 0, -Number.MAX_VALUE), 600);
    const maximum = measurePaneLayout(resizePanePair(source, 600, 0, Number.MAX_VALUE), 600);
    expect(minimum.panes[0]!.height).toBeCloseTo(117.66666666666666, 10);
    expect(maximum.panes[0]!.height).toBeCloseTo(187.33333333333331, 10);
  });
  it('resizes representable extreme finite weights without overflowing the pair', () => {
    const source = {
      panes: [
        { id: 'price', weight: 1e308, minHeight: 48 },
        { id: 'volume', weight: 1e308, minHeight: 48 },
      ],
      maximizedPaneId: null,
    };
    const before = measurePaneLayout(source, 600);
    const changed = resizePanePair(source, 600, 0, 200);
    const after = measurePaneLayout(changed, 600);
    expect(after.panes[0]!.height).toBeGreaterThan(before.panes[0]!.height + 100);
    expect(after.panes[1]!.height).toBeLessThan(before.panes[1]!.height - 100);
    expect(changed.panes.every((pane) => Number.isFinite(pane.weight) && pane.weight > 0)).toBe(true);
  });
  it('allocates normal minima with near-maximum, subnormal and mixed finite weights', () => {
    const source = (a: number, b: number) => ({
      panes: [
        { id: 'price', weight: a, minHeight: 48 },
        { id: 'volume', weight: b, minHeight: 48 },
      ],
      maximizedPaneId: null,
    });
    expect(
      measurePaneLayout(source(Number.MAX_VALUE, Number.MAX_VALUE), 600).panes.map((pane) => pane.height),
    ).toEqual([283.5, 283.5]);
    expect(
      measurePaneLayout(source(Number.MIN_VALUE, 2 * Number.MIN_VALUE), 600).panes.map((pane) => pane.height),
    ).toEqual([205, 362]);
    expect(
      measurePaneLayout(source(Number.MAX_VALUE, Number.MIN_VALUE), 600).panes.map((pane) => pane.height),
    ).toEqual([519, 48]);
    const bounded = resizePanePair(source(Number.MAX_VALUE, Number.MAX_VALUE), 600, 0, 24);
    expect(bounded.panes.every((pane) => Number.isFinite(pane.weight) && pane.weight > 0)).toBe(true);
  });
  it('keeps extreme finite weights and minima finite', () => {
    const actual = measurePaneLayout(
      {
        panes: [
          { id: 'price', weight: 1e308, minHeight: 1e308 },
          { id: 'volume', weight: 1e308, minHeight: 1e308 },
        ],
        maximizedPaneId: null,
      },
      600,
    );
    expect(actual.panes.map((pane) => pane.height)).toEqual([283.5, 283.5]);
    expect(actual.panes.every((pane) => Number.isFinite(pane.top))).toBe(true);
  });
});
