import { describe, expect, it } from 'vitest';
import { SeriesStore } from './store';
import type { RangeStats, SeriesPoint, SeriesType } from './types';

type ScalarType = Extract<SeriesType, 'line' | 'area' | 'histogram'>;

function expectExact(actual: RangeStats | null, expected: RangeStats | null): void {
  if (!expected) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(Object.is(actual!.min, expected.min)).toBe(true);
  expect(Object.is(actual!.max, expected.max)).toBe(true);
  expect(Object.is(actual!.volume, expected.volume)).toBe(true);
  expect(actual!.minIndex).toBe(expected.minIndex);
  expect(actual!.maxIndex).toBe(expected.maxIndex);
  expect(actual!.count).toBe(expected.count);
}

function oracle(rows: readonly SeriesPoint[], from: number, to: number): RangeStats | null {
  if (rows.length === 0 || Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  const start = Math.max(0, Math.ceil(from));
  const end = Math.min(rows.length - 1, Math.floor(to));
  if (start > end) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let minIndex = -1;
  let maxIndex = -1;
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    const row = rows[index]!;
    if (!('value' in row)) continue;
    const value = row.value;
    if (minIndex < 0 || value < min) {
      min = value;
      minIndex = index;
    }
    if (maxIndex < 0 || value > max) {
      max = value;
      maxIndex = index;
    }
    count += 1;
  }
  return count === 0 ? null : { min, max, minIndex, maxIndex, count, volume: 0 };
}

function indexBytes(store: SeriesStore): number {
  const state = store as unknown as {
    tree: {
      mins: Float64Array;
      maxes: Float64Array;
      volumes: Float64Array | null;
      prefixCounts: Uint32Array;
    } | null;
    scalarTree: {
      mins: Float64Array;
      maxes: Float64Array;
      minIndices: Float64Array;
      maxIndices: Float64Array;
      prefixCounts: Uint32Array;
    } | null;
    bandTree: { lowerMaxIndices: Int32Array; upperMinIndices: Int32Array } | null;
  };
  const arrays = [...Object.values(state.scalarTree ?? state.tree!), ...Object.values(state.bandTree ?? {})];
  return arrays.reduce((bytes, array) => bytes + (ArrayBuffer.isView(array) ? array.byteLength : 0), 0);
}

describe('scalar block range index', () => {
  it('uses reduced real index backing for 100,000-row setData and leaves candle/band layouts intact', () => {
    const length = 100_000;
    const scalar = new SeriesStore('line');
    scalar.setData(Array.from({ length }, (_, time) => ({ time, value: time % 97 })));
    expect(indexBytes(scalar)).toBe(1_048_580);
    const candle = new SeriesStore('candlestick');
    candle.setData(
      Array.from({ length }, (_, time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
    );
    expect(indexBytes(candle)).toBe(6_815_748);
    const band = new SeriesStore('band');
    band.setData(Array.from({ length }, (_, time) => ({ time, lower: 1, upper: 1 })));
    expect(indexBytes(band)).toBe(6_815_748);
  });

  it.each(['line', 'area', 'histogram'] as const)(
    '%s keeps earliest signed-zero values across blocks',
    (type: ScalarType) => {
      const store = new SeriesStore(type);
      const rows = Array.from(
        { length: 65 },
        (_, time): SeriesPoint =>
          time === 1 || time === 32
            ? { time, value: -0 }
            : time === 17 || time === 64
              ? { time, value: +0 }
              : { time },
      );
      store.setData(rows);
      expectExact(store.range(0, 64), { min: -0, max: -0, minIndex: 1, maxIndex: 1, volume: 0, count: 4 });
      expectExact(store.range(16, 64), { min: +0, max: +0, minIndex: 17, maxIndex: 17, volume: 0, count: 3 });
      expectExact(store.range(31, 64), { min: -0, max: -0, minIndex: 32, maxIndex: 32, volume: 0, count: 2 });
      expect(store.range(2, 16)).toBeNull();
      expect(store.range(65, 70)).toBeNull();
    },
  );

  it.each(['line', 'area', 'histogram'] as const)(
    '%s matches an input oracle for sparse blocks, clipping and growth',
    (type: ScalarType) => {
      let seed = 0x5199a;
      const next = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
      };
      const rows: SeriesPoint[] = Array.from({ length: 257 }, (_, time) => {
        const draw = next() % 23;
        return draw < 6 ? { time } : { time, value: draw < 10 ? -0 : draw < 14 ? +0 : draw - 11 };
      });
      const store = new SeriesStore(type);
      store.setData(rows);
      for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 257]) {
        store.setData(rows.slice(0, length));
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const from = (next() % 300) - 20 + (next() % 3) / 3;
          const to = (next() % 300) - 20 + (next() % 3) / 3;
          expectExact(store.range(from, to), oracle(rows.slice(0, length), from, to));
        }
        expectExact(store.range(-Infinity, Infinity), oracle(rows.slice(0, length), -Infinity, Infinity));
        expect(store.range(Number.NaN, 20)).toBeNull();
        expect(store.range(20, Number.NaN)).toBeNull();
      }
      store.setData(rows);
      for (let time = 257; time < 290; time += 1) {
        const appended: SeriesPoint =
          time % 7 === 0 ? { time } : { time, value: time % 5 === 0 ? -0 : time - 270 };
        rows.push(appended);
        expect(store.update(appended)).toBe('append');
        expectExact(store.range(time - 35, time), oracle(rows, time - 35, time));
        const replacement: SeriesPoint = time % 2 ? { time } : { time, value: +0 };
        rows[time] = replacement;
        expect(store.update(replacement)).toBe('replace');
        expectExact(store.range(time - 17, time), oracle(rows, time - 17, time));
      }
    },
  );

  it.each(['line', 'area', 'histogram'] as const)(
    '%s preserves a completed nested write after outer getter failure',
    (type: ScalarType) => {
      const store = new SeriesStore(type);
      store.setData([{ time: 0, value: 1 }]);
      const failure = new Error('injected value getter failure');
      let reads = 0;
      const outer = {
        time: 1,
        get value() {
          if (++reads === 1) {
            store.update({ time: 2, value: -0 });
            return 7;
          }
          throw failure;
        },
      };
      expect(() => store.setData([outer])).toThrow(failure);
      expect(store.revision).toBe(2);
      expect(store.length).toBe(2);
      expectExact(store.range(0, 2), { min: -0, max: 1, minIndex: 1, maxIndex: 0, volume: 0, count: 2 });
      expect(store.pointAt(1)).toEqual({ time: 2, value: -0 });
    },
  );
});
