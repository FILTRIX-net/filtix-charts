import { describe, expect, it } from 'vitest';
import { ChartError, type ChartTime, type ValuePoint, type WhitespacePoint } from '@filtrix.net/core';
import { buildIndexedComparison } from './comparison';

const value = (time: ChartTime, amount: number): ValuePoint => ({ time, value: amount });
const gap = (time: ChartTime): WhitespacePoint => ({ time });

describe('buildIndexedComparison', () => {
  it('selects the earliest common present timestamp and keeps gaps without interpolation', () => {
    const result = buildIndexedComparison([
      { id: 'BTC', points: [value(0, 10), gap(1), value(2, 20), value(3, 30)] },
      { id: 'ETH', points: [gap(0), value(1, 5), value(2, 10), gap(3)] },
    ]);

    expect(result).toEqual([
      {
        id: 'BTC',
        baseline: { time: 2, value: 20 },
        points: [value(0, 50), gap(1), value(2, 100), value(3, 150)],
      },
      {
        id: 'ETH',
        baseline: { time: 2, value: 10 },
        points: [gap(0), value(1, 50), value(2, 100), gap(3)],
      },
    ]);
  });

  it('uses an exact requested common baseline and includes points before it', () => {
    const result = buildIndexedComparison(
      [
        { id: 'A', points: [value('2024-01-01', 2), value('2024-01-02', 4)] },
        { id: 'B', points: [value('2024-01-01', 8), value('2024-01-02', 16)] },
      ],
      { timeDomain: 'business-date', baselineTime: '2024-01-02', baseValue: 1 },
    );

    expect(result[0]).toEqual({
      id: 'A',
      baseline: { time: '2024-01-02', value: 4 },
      points: [value('2024-01-01', 0.5), value('2024-01-02', 1)],
    });
  });

  it('rejects a requested baseline that is not present in every asset', () => {
    expect(() =>
      buildIndexedComparison(
        [
          { id: 'A', points: [value(0, 1)] },
          { id: 'B', points: [value(0, 2), value(1, 3)] },
        ],
        { baselineTime: 1 },
      ),
    ).toThrow(ChartError);
  });

  it('fails when no common present timestamp exists', () => {
    expect(() =>
      buildIndexedComparison([
        { id: 'A', points: [value(0, 1), gap(1)] },
        { id: 'B', points: [gap(0), value(1, 2)] },
      ]),
    ).toThrow(ChartError);
  });

  it('validates ids, points, ordering, positive prices, and options atomically', () => {
    const points = [value(0, 1), gap(1)] as Array<ValuePoint | WhitespacePoint>;
    const input = { id: 'A', points };

    expect(() => buildIndexedComparison([])).toThrow(ChartError);
    expect(() => buildIndexedComparison([input, { id: 'A', points: [value(0, 2)] }])).toThrow(ChartError);
    expect(() => buildIndexedComparison([{ id: 'bad id', points: [value(0, 1)] }])).toThrow(ChartError);
    expect(() => buildIndexedComparison([{ id: 'A', points: [value(1, 1), value(1, 2)] }])).toThrow(
      ChartError,
    );
    expect(() => buildIndexedComparison([{ id: 'A', points: [value(0, 0)] }])).toThrow(ChartError);
    expect(() => buildIndexedComparison([{ id: 'A', points: [value(0, Number.NaN)] }])).toThrow(ChartError);
    expect(() => buildIndexedComparison([{ id: 'A', points: [value(0, 1)] }], { baseValue: 0 })).toThrow(
      ChartError,
    );
    expect(() =>
      buildIndexedComparison([{ id: 'A', points: [value(0, 1)] }], { baseValue: Infinity }),
    ).toThrow(ChartError);

    expect(points).toEqual([value(0, 1), gap(1)]);
  });

  it('copies output points and baseline metadata without mutating caller data', () => {
    const source = [value(0, 2), value(1, 4)];
    const result = buildIndexedComparison([{ id: 'A', points: source }]);

    (source[0] as ValuePoint).value = 99;
    expect(result[0]!.points[0]).toEqual(value(0, 100));
    expect(result[0]!.baseline).toEqual({ time: 0, value: 2 });

    (result[0]!.points[0] as ValuePoint).value = 77;
    result[0]!.baseline.value = 66;

    expect(source).toEqual([value(0, 99), value(1, 4)]);
  });

  it('handles UTC and business-date boundary times through the core validator', () => {
    const utc = buildIndexedComparison([
      { id: 'A', points: [value(-8640000000000000, 1), value(8640000000000000, 2)] },
      { id: 'B', points: [value(-8640000000000000, 4), value(8640000000000000, 8)] },
    ]);
    expect(utc[0]!.baseline).toEqual({ time: -8640000000000000, value: 1 });

    const dates = buildIndexedComparison(
      [
        { id: 'A', points: [value('0000-01-01', 2), value('0099-12-31', 4)] },
        { id: 'B', points: [value('0000-01-01', 8), value('0099-12-31', 16)] },
      ],
      { timeDomain: 'business-date' },
    );
    expect(dates[0]!.baseline.time).toBe('0000-01-01');
  });

  it('accepts a representable normalized value when direct multiplication would overflow', () => {
    const result = buildIndexedComparison([
      { id: 'A', points: [value(0, Number.MAX_VALUE)] },
      { id: 'B', points: [value(0, Number.MAX_VALUE)] },
    ]);

    expect(result[0]!.points[0]).toEqual(value(0, 100));
  });

  it('rejects an unrepresentable normalized value', () => {
    expect(() =>
      buildIndexedComparison(
        [
          { id: 'A', points: [value(0, Number.MIN_VALUE), value(1, Number.MAX_VALUE)] },
          { id: 'B', points: [value(0, Number.MIN_VALUE), value(1, Number.MIN_VALUE)] },
        ],
        { baseValue: Number.MAX_VALUE },
      ),
    ).toThrow(ChartError);
  });
});
