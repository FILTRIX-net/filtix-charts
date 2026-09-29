import { describe, expect, it } from 'vitest';
import { createPriceScale, type ChartTime } from '@filtix/core';
import type { PrimitiveProjection } from '@filtix/charts';
import { hitTest, projectDrawing, translateDrawing } from './geometry';
import type { Drawing, DrawingTypeV1 } from './types';

const timeline = ['2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];
function projection(log = false): PrimitiveProjection {
  const scale = createPriceScale(1, 100, 0, 200, log ? 'log' : 'linear');
  return {
    width: 240,
    height: 230,
    plotWidth: 200,
    plotHeight: 200,
    dpr: 1,
    timeDomain: 'business-date',
    theme: {} as PrimitiveProjection['theme'],
    panes: [{ id: 'price', left: 0, right: 200, top: 0, bottom: 200, scale: log ? 'log' : 'linear' }],
    timeToX: (time) => {
      const i = timeline.indexOf(time as string);
      return i < 0 ? null : i * 50;
    },
    timeToLogicalIndex: (time) => {
      const i = timeline.indexOf(time as string);
      return i < 0 ? null : i;
    },
    logicalIndexToTime: (i) => (Number.isInteger(i) ? (timeline[i] ?? null) : null),
    xToTime: (x) => timeline[Math.round(x / 50)] ?? null,
    priceToY: (p, pane = 'price') => (pane === 'price' && (!log || p > 0) ? scale.priceToY(p) : null),
    yToPrice: (y, pane = 'price') => (pane === 'price' ? scale.yToPrice(y) : null),
  };
}
function drawing(type: DrawingTypeV1 = 'trend-line'): Drawing {
  return {
    id: 'a',
    type,
    locked: false,
    visible: true,
    paneId: 'price',
    points: [
      { time: timeline[0]!, price: 10 },
      { time: timeline[1]!, price: 20 },
    ],
    style: { color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 },
  };
}

describe('drawing geometry', () => {
  it('moves both endpoints by a common logical delta across the weekend', () => {
    const moved = translateDrawing(drawing(), projection(), 50, 0)!;
    expect(moved.points.map((p) => p.time)).toEqual(['2026-09-07', '2026-09-08']);
    expect(translateDrawing(drawing(), projection(), -50, 0)).toBeNull();
  });
  it('translates logarithmic prices multiplicatively', () => {
    const moved = translateDrawing(drawing(), projection(true), 0, -100)!;
    expect(moved.points[0]!.price).toBeCloseTo(100);
    expect(moved.points[1]!.price).toBeCloseTo(200);
  });
  it('uses a horizontal level time only as provenance', () => {
    const level = { ...drawing('horizontal-line'), points: [{ time: '2020-01-01' as ChartTime, price: 10 }] };
    expect(projectDrawing(level, projection())).not.toBeNull();
    const moved = translateDrawing(level, projection(), 9999, -10)!;
    expect(moved.points[0]!.time).toBe('2020-01-01');
    expect(moved.points[0]!.price).toBeCloseTo(14.95);
    expect(projectDrawing({ ...level, paneId: 'missing' }, projection())).toBeNull();
  });
  it('hides unloaded multipoint data without discarding it', () => {
    const d = drawing();
    d.points = [{ time: '2020-01-01', price: 10 }, d.points[1]!];
    expect(projectDrawing(d, projection())).toBeNull();
    expect(d.points[0]!.time).toBe('2020-01-01');
  });
  it('hits endpoints before bodies, then reverse document order, and respects pane clips', () => {
    const p = projection();
    const bottom = drawing();
    const top = { ...drawing('horizontal-line'), id: 'top', points: [{ time: timeline[0]!, price: 10 }] };
    const y = p.priceToY(10)!;
    expect(hitTest([bottom, top], p, 0, y)?.id).toBe('a');
    expect(hitTest([bottom, { ...bottom, id: 'last' }], p, 0, y)?.id).toBe('last');
    expect(hitTest([top], p, 210, y)).toBeNull();
    expect(hitTest([top], p, 80, y)?.handle).toBeNull();
  });
});

describe('advanced drawing geometry', () => {
  it('projects Fibonacci endpoints exactly and preserves inherited and overridden strokes', () => {
    const d: Drawing = {
      ...drawing(),
      type: 'fibonacci-retracement',
      levels: [
        { ratio: 0 },
        { ratio: 1 },
        { ratio: 0.5, color: '#ff0000', lineWidth: 3, lineStyle: 'dashed' },
      ],
    };
    const g = projectDrawing(d, projection())!;
    expect(g.levels?.[0]?.y).toBe(projection().priceToY(10));
    expect(g.levels?.[1]?.y).toBe(projection().priceToY(20));
    expect(g.levels?.[0]?.style.color).toBe(d.style.color);
    expect(g.levels?.[2]?.style).toMatchObject({ color: '#ff0000', lineWidth: 3, lineStyle: 'dashed' });
    expect(
      projectDrawing({ ...d, style: { ...d.style, color: '#00ff00' } }, projection())?.levels?.[0]?.style
        .color,
    ).toBe('#00ff00');
    expect(
      projectDrawing({ ...d, style: { ...d.style, color: '#00ff00' } }, projection())?.levels?.[2]?.style
        .color,
    ).toBe('#ff0000');
  });
  it('derives a channel fourth corner and moves only its three real anchors', () => {
    const d: Drawing = {
      ...drawing(),
      type: 'parallel-channel',
      points: [
        { time: timeline[0]!, price: 10 },
        { time: timeline[1]!, price: 20 },
        { time: timeline[2]!, price: 30 },
      ],
    };
    const g = projectDrawing(d, projection())!;
    expect(g.handles).toHaveLength(3);
    expect(g.points[3]).toEqual({
      x: g.points[1]!.x + g.points[2]!.x - g.points[0]!.x,
      y: g.points[1]!.y + g.points[2]!.y - g.points[0]!.y,
    });
    const moved = translateDrawing(d, projection(), 50, 5)!;
    expect(moved.points).toHaveLength(3);
    expect(d.points[0]!.time).toBe(timeline[0]);
  });
  it('excludes hidden drawings and selects locked bodies without handles', () => {
    const p = projection(),
      d = drawing();
    const x = 25,
      y = (p.priceToY(10)! + p.priceToY(20)!) / 2;
    expect(projectDrawing({ ...d, visible: false }, p)).toBeNull();
    expect(hitTest([{ ...d, visible: false }], p, x, y)).toBeNull();
    expect(hitTest([{ ...d, locked: true }], p, 0, p.priceToY(10)!)?.handle).toBeNull();
  });
});

describe('advanced projection recovery', () => {
  it('interpolates reversed logarithmic Fibonacci anchors and skips overflow levels independently', () => {
    const p = projection(true);
    const d: Drawing = {
      ...drawing(),
      type: 'fibonacci-retracement',
      points: [
        { time: timeline[0]!, price: 100 },
        { time: timeline[1]!, price: 1 },
      ],
      levels: [{ ratio: 0 }, { ratio: 0.5 }, { ratio: 1 }, { ratio: 10 }],
    };
    const g = projectDrawing(d, p)!;
    expect(g.levels?.slice(0, 3).map((level) => level.y)).toEqual([
      p.priceToY(100),
      p.priceToY(10),
      p.priceToY(1),
    ]);
    const linear = {
      ...p,
      panes: [{ ...p.panes[0]!, scale: 'linear' as const }],
      priceToY: (price: number) => (Number.isFinite(price) ? price : null),
    };
    const extreme: Drawing = {
      ...d,
      points: [
        { time: timeline[0]!, price: -1e308 },
        { time: timeline[1]!, price: 1e308 },
      ],
      levels: [{ ratio: 0 }, { ratio: 0.5 }, { ratio: 1 }, { ratio: 10 }],
    };
    expect(projectDrawing(extreme, linear)?.levels?.map((level) => level.ratio)).toEqual([0, 0.5, 1]);
    expect(extreme.points[0]!.price).toBe(-1e308);
  });
  it('uses measured multiline note bounds for the same hit rectangle', () => {
    const p = projection();
    const d: Drawing = {
      ...drawing(),
      type: 'text-note',
      points: [{ time: timeline[1]!, price: 20 }],
      text: 'wide\nno',
      fontSize: 16,
    };
    const measure = (line: string) => (line === 'wide' ? 60 : 20);
    const g = projectDrawing(d, p, measure)!;
    expect(g.rect).toMatchObject({ x: 50, width: 72, height: 52 });
    expect(hitTest([d], p, 100, g.rect!.y + 20, measure)).toEqual({ id: 'a', handle: null });
    expect(hitTest([d], p, 123, g.rect!.y + 20, measure)).toBeNull();
  });
  it('hides an unloaded channel and projects it again when its time becomes loaded', () => {
    const d: Drawing = {
      ...drawing(),
      type: 'parallel-channel',
      points: [
        { time: '2020-01-01', price: 10 },
        { time: timeline[1]!, price: 20 },
        { time: timeline[2]!, price: 30 },
      ],
    };
    expect(projectDrawing(d, projection())).toBeNull();
    const restored = {
      ...projection(),
      timeToX: (time: ChartTime) => (time === '2020-01-01' ? 0 : projection().timeToX(time)),
    };
    expect(projectDrawing(d, restored)?.handles).toHaveLength(3);
  });
});

describe('channel painted area', () => {
  it('hits the interior of a nondegenerate projected channel', () => {
    const p = projection();
    const d: Drawing = {
      ...drawing(),
      type: 'parallel-channel',
      points: [
        { time: timeline[0]!, price: 10 },
        { time: timeline[1]!, price: 20 },
        { time: timeline[2]!, price: 10 },
      ],
    };
    const g = projectDrawing(d, p)!;
    const x = (g.points[0]!.x + g.points[1]!.x + g.points[2]!.x + g.points[3]!.x) / 4;
    const y = (g.points[0]!.y + g.points[1]!.y + g.points[2]!.y + g.points[3]!.y) / 4;
    expect(hitTest([d], p, x, y)).toEqual({ id: 'a', handle: null });
  });
});

describe('representable extended Fibonacci prices', () => {
  it('keeps extended same-sign levels finite without weighted-term overflow', () => {
    const p = {
      ...projection(),
      priceToY: (price: number) => (Number.isFinite(price) ? price * 1e-306 : null),
    };
    const d: Drawing = {
      ...drawing(),
      type: 'fibonacci-retracement',
      points: [
        { time: timeline[0]!, price: 1e308 },
        { time: timeline[1]!, price: 9e307 },
      ],
      levels: [{ ratio: 0 }, { ratio: 1 }, { ratio: 2 }],
    };
    const levels = projectDrawing(d, p)!.levels!;
    expect(levels.map((level) => level.ratio)).toEqual([0, 1, 2]);
    expect(levels[0]!.price).toBe(1e308);
    expect(levels[1]!.price).toBe(9e307);
    expect(levels[2]!.price / 1e307).toBeCloseTo(8, 10);
    expect(levels[2]!.y).toBeCloseTo(80, 8);
  });
  it('keeps equal extreme anchors at extended ratios and still skips genuine overflow', () => {
    const p = {
      ...projection(),
      priceToY: (price: number) => (Number.isFinite(price) ? price * 1e-306 : null),
    };
    const equal: Drawing = {
      ...drawing(),
      type: 'fibonacci-retracement',
      points: [
        { time: timeline[0]!, price: 1e308 },
        { time: timeline[1]!, price: 1e308 },
      ],
      levels: [{ ratio: 0 }, { ratio: 1 }, { ratio: 2 }],
    };
    expect(projectDrawing(equal, p)?.levels?.map((level) => level.price)).toEqual([1e308, 1e308, 1e308]);
    const opposite: Drawing = {
      ...equal,
      points: [
        { time: timeline[0]!, price: -1e308 },
        { time: timeline[1]!, price: 1e308 },
      ],
      levels: [{ ratio: 0.5 }, { ratio: 2 }],
    };
    expect(projectDrawing(opposite, p)?.levels?.map((level) => [level.ratio, level.price])).toEqual([
      [0.5, 0],
    ]);
  });
});

describe('near-endpoint Fibonacci precision', () => {
  it('retains the small weighted contribution when a ratio lies just below one', () => {
    const ratio = 1 - Number.EPSILON / 2;
    const p = {
      ...projection(),
      priceToY: (price: number) => (Number.isFinite(price) ? price * 1e-306 : null),
    };
    const d: Drawing = {
      ...drawing(),
      type: 'fibonacci-retracement',
      points: [
        { time: timeline[0]!, price: 1e308 },
        { time: timeline[1]!, price: 1 },
      ],
      levels: [{ ratio }],
    };
    const expected = 1e308 * (1 - ratio) + ratio;
    const actual = projectDrawing(d, p)!.levels![0]!.price;
    expect(actual / expected).toBeCloseTo(1, 12);
  });
});
