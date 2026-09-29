import { describe, expect, it, vi } from 'vitest';
import { bollingerBands, createBollingerBands, type IndicatorPoint } from './index';
import { prepareBatch, prepareBollinger } from './internal';

const periods = [2, 3, 5, 20, 31];
const scenarios = ['rotations', 'signed zero', 'large finite', 'gaps', 'final gap'] as const;

function history(period: number, scenario: (typeof scenarios)[number]): IndicatorPoint[] {
  return Array.from({ length: period * 6 + 7 }, (_, i) => {
    const time = i === 0 ? -0 : i;
    if (
      (scenario === 'gaps' && i % (period + 3) === period + 1) ||
      (scenario === 'final gap' && i === period * 6 + 6)
    )
      return { time };
    const value =
      scenario === 'signed zero'
        ? i % 2
          ? -0
          : 0
        : scenario === 'large finite'
          ? ((i % 3) - 1) * (Number.MAX_VALUE / 32)
          : Math.sin(i / 3) * 81 + i / 7;
    return { time, value };
  });
}

describe.each(periods)('Bollinger mutable coefficient parity, period %i', (period) => {
  it.each(scenarios)('matches the persistent public reference exactly for %s', (scenario) => {
    const points = history(period, scenario);
    const options = { period, multiplier: 2 };
    const expected = bollingerBands(points, options); // Persistent push path, no bulk target.
    const prepared = prepareBollinger(options, points);
    expect(prepared.data).toEqual(expected);
    const batch = prepareBatch([{ kind: 'bollinger', options }], points);
    expect(batch[0]!.prepared.data).toEqual(expected);
    const streaming = createBollingerBands(options);
    for (const point of points) streaming.update(point);
    const lastTime = points.length - 1;
    for (const next of [
      { time: lastTime, value: -0 },
      { time: lastTime },
      { time: lastTime, value: 37 },
      { time: lastTime + 1, value: -19 },
      { time: lastTime + 1, value: 7 },
    ])
      expect(prepared.controller.update(next)).toEqual(streaming.update(next));
    prepared.controller.reset();
    expect(prepared.controller.update({ time: -0, value: 4 })).toEqual({
      middle: { time: -0 },
      upper: { time: -0 },
      lower: { time: -0 },
    });
  });
});

describe('Bollinger mutable coefficient safety', () => {
  it('recovers final-row snapshots after append/replacement overflow and rejects bulk overflow', () => {
    const options = { period: 3, multiplier: Number.MAX_VALUE };
    const points = Array.from({ length: 20 }, (_, time) => ({ time, value: 0 }));
    const prepared = prepareBollinger(options, points);
    const live = createBollingerBands(options);
    for (const point of points) live.update(point);
    for (const time of [19, 20]) {
      expect(() => prepared.controller.update({ time, value: Number.MAX_VALUE })).toThrow();
      expect(() => live.update({ time, value: Number.MAX_VALUE })).toThrow();
      expect(prepared.controller.update({ time, value: 0 })).toEqual(live.update({ time, value: 0 }));
    }
    expect(() => prepareBollinger(options, [...points, { time: 20, value: Number.MAX_VALUE }])).toThrow();
    expect(prepareBollinger(options, points).data).toEqual(bollingerBands(points, options));
  });

  it('keeps duplicate preparations, output records and retained tail controllers independent', () => {
    const options = { period: 5, multiplier: 2 };
    const points = history(5, 'rotations');
    const prepared = prepareBatch(
      [
        { kind: 'bollinger', options },
        { kind: 'bollinger', options },
      ],
      points,
    );
    const first = prepared[0]!;
    const second = prepared[1]!;
    if (first.kind !== 'bollinger' || second.kind !== 'bollinger') throw new Error('Wrong kind');
    expect(first.prepared.data).toEqual(second.prepared.data);
    for (const name of ['middle', 'upper', 'lower'] as const) {
      expect(first.prepared.data[name]).not.toBe(second.prepared.data[name]);
      expect(first.prepared.data[name][20]).not.toBe(second.prepared.data[name][20]);
      Object.assign(first.prepared.data[name][20]!, { time: -999, value: 999 });
    }
    points[0] = { time: -999, value: -999 };
    const tail = { time: points.length - 1, value: 17 };
    expect(first.prepared.controller.update(tail)).toEqual(second.prepared.controller.update(tail));
  });

  it('reduces native sqrt work on long unpublished bulk history without reducing hypot work', () => {
    const options = { period: 20, multiplier: 2 };
    const points = Array.from({ length: 4096 }, (_, time) => ({ time, value: Math.sin(time / 11) * 100 }));
    function measure(run: () => ReturnType<typeof bollingerBands>) {
      const sqrt = vi.spyOn(Math, 'sqrt');
      const hypot = vi.spyOn(Math, 'hypot');
      try {
        const data = run();
        return { data, sqrt: sqrt.mock.calls.length, hypot: hypot.mock.calls.length };
      } finally {
        sqrt.mockRestore();
        hypot.mockRestore();
      }
    }
    const persistent = measure(() => bollingerBands(points, options));
    const bulk = measure(() => prepareBollinger(options, points).data);
    expect(bulk.data).toEqual(persistent.data);
    expect(bulk.hypot).toBe(persistent.hypot);
    console.info('Bollinger coefficient work', {
      persistent: { sqrt: persistent.sqrt, hypot: persistent.hypot },
      bulk: { sqrt: bulk.sqrt, hypot: bulk.hypot },
    });
    expect(bulk.sqrt).toBeLessThan(1000);
    expect(persistent.sqrt).toBeGreaterThan(50000);
  });
});
