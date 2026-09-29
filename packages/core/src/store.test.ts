import { describe, expect, it } from 'vitest';
import { ChartError, SeriesStore, type CandlePoint, type SeriesPoint, type ValuePoint } from './index';

const candle = (
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume?: number,
): CandlePoint => ({
  time,
  open,
  high,
  low,
  close,
  ...(volume === undefined ? {} : { volume }),
});

describe('SeriesStore', () => {
  it.each(['line', 'area', 'histogram', 'candlestick', 'ohlc', 'band'] as const)(
    'matches a public-point extrema oracle for %s across gaps, ties, clipping, and growth',
    (type) => {
      const store = new SeriesStore(type);
      const point = (time: number): SeriesPoint => {
        if (time % 6 === 0) return { time };
        const value = time % 4 === 1 ? -0 : time % 4 === 2 ? +0 : time % 4 === 3 ? -5 : 5;
        if (type === 'band') return { time, lower: value, upper: value + 10 };
        if (type === 'candlestick' || type === 'ohlc') return candle(time, value, value, value, value, 1);
        return { time, value };
      };
      const verify = (): void => {
        for (let from = -3; from <= store.length + 2; from += 1) {
          for (let to = from; to <= store.length + 2; to += 1) {
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let minIndex = -1;
            let maxIndex = -1;
            let lowerMax = Number.NEGATIVE_INFINITY;
            let upperMin = Number.POSITIVE_INFINITY;
            let lowerMaxIndex = -1;
            let upperMinIndex = -1;
            let count = 0;
            for (let index = Math.max(0, from); index <= Math.min(to, store.length - 1); index += 1) {
              const current = store.pointAt(index);
              if (!current || !('value' in current || 'low' in current || 'lower' in current)) continue;
              const low = 'low' in current ? current.low : 'lower' in current ? current.lower : current.value;
              const high =
                'high' in current ? current.high : 'upper' in current ? current.upper : current.value;
              if (low < min) {
                min = low;
                minIndex = index;
              }
              if (high > max) {
                max = high;
                maxIndex = index;
              }
              if (type === 'band') {
                if (low > lowerMax) {
                  lowerMax = low;
                  lowerMaxIndex = index;
                }
                if (high < upperMin) {
                  upperMin = high;
                  upperMinIndex = index;
                }
              }
              count += 1;
            }
            const actual = store.range(from, to);
            if (count === 0) {
              expect(actual).toBeNull();
              if (type === 'band') expect(store.bandRange(from, to)).toBeNull();
              continue;
            }
            expect(actual).not.toBeNull();
            expect(actual!.minIndex).toBe(minIndex);
            expect(actual!.maxIndex).toBe(maxIndex);
            expect(Object.is(actual!.min, min)).toBe(true);
            expect(Object.is(actual!.max, max)).toBe(true);
            expect(actual!.count).toBe(count);
            expect(actual!.volume).toBe(type === 'candlestick' || type === 'ohlc' ? count : 0);
            if (type === 'band') {
              const band = store.bandRange(from, to);
              expect(band).not.toBeNull();
              expect(band!.lowerMinIndex).toBe(minIndex);
              expect(band!.lowerMaxIndex).toBe(lowerMaxIndex);
              expect(band!.upperMinIndex).toBe(upperMinIndex);
              expect(band!.upperMaxIndex).toBe(maxIndex);
              expect(Object.is(band!.lowerMin, min)).toBe(true);
              expect(Object.is(band!.lowerMax, lowerMax)).toBe(true);
              expect(Object.is(band!.upperMin, upperMin)).toBe(true);
              expect(Object.is(band!.upperMax, max)).toBe(true);
              expect(band!.count).toBe(count);
            }
          }
        }
      };

      store.setData(Array.from({ length: 19 }, (_, time) => point(time)));
      verify();
      const replacement: SeriesPoint =
        type === 'band'
          ? { time: 18, lower: -99, upper: -98 }
          : type === 'candlestick' || type === 'ohlc'
            ? candle(18, -99, -99, -99, -99, 1)
            : { time: 18, value: -99 };
      expect(store.update(replacement)).toBe('replace');
      verify();
      expect(store.update(point(18))).toBe('replace');
      verify();
      expect(store.update(replacement)).toBe('replace');
      verify();
      expect(store.update(point(18))).toBe('replace');
      verify();
      for (let time = 19; time <= 33; time += 1) {
        expect(store.update(point(time))).toBe('append');
        if (time === 19 || time === 24 || time === 32) verify();
      }
      verify();
    },
  );

  it('keeps the earliest signed-zero payload for both band extrema across canonical nodes', () => {
    const store = new SeriesStore('band');
    store.setData(
      Array.from({ length: 19 }, (_, time) =>
        time === 1 ? { time, lower: -0, upper: -0 } : time === 17 ? { time, lower: +0, upper: +0 } : { time },
      ),
    );

    const range = store.range(-100, 100)!;
    const band = store.bandRange(-100, 100)!;
    expect(range.minIndex).toBe(1);
    expect(range.maxIndex).toBe(1);
    expect(Object.is(range.min, -0)).toBe(true);
    expect(Object.is(range.max, -0)).toBe(true);
    expect(band.lowerMinIndex).toBe(1);
    expect(band.lowerMaxIndex).toBe(1);
    expect(band.upperMinIndex).toBe(1);
    expect(band.upperMaxIndex).toBe(1);
    expect(Object.is(band.lowerMin, -0)).toBe(true);
    expect(Object.is(band.lowerMax, -0)).toBe(true);
    expect(Object.is(band.upperMin, -0)).toBe(true);
    expect(Object.is(band.upperMax, -0)).toBe(true);
  });
  it('validates an entire replacement before swapping and keeps caller data private', () => {
    const first = candle(0, 2, 3, 1, 2, 10);
    const input: CandlePoint[] = [first];
    const store = new SeriesStore('candlestick');
    store.setData(input);
    const revision = store.revision;

    expect(() => store.setData([candle(1, 4, 3, 1, 2)])).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(0)).toEqual(candle(0, 2, 3, 1, 2, 10));

    first.close = 99;
    input.push(candle(1, 2, 4, 2, 3));
    const snapshot = store.pointAt(0) as CandlePoint;
    snapshot.open = 77;
    expect(store.length).toBe(1);
    expect(store.pointAt(0)).toEqual(candle(0, 2, 3, 1, 2, 10));
  });

  it('handles input growth during validation without losing the appended point', () => {
    const store = new SeriesStore('line');
    const input = Array.from({ length: 16 }, (_, time) => ({ time, value: time }));
    let appended = false;
    Object.defineProperty(input[0], 'value', {
      get() {
        if (!appended) {
          input.push({ time: 16, value: 16 });
          appended = true;
        }
        return 0;
      },
    });

    store.setData(input);

    expect(store.length).toBe(17);
    expect(store.pointAt(16)).toEqual({ time: 16, value: 16 });
    expect(store.range(0, 16)).toEqual({
      min: 0,
      max: 16,
      minIndex: 0,
      maxIndex: 16,
      volume: 0,
      count: 17,
    });
  });

  it('rejects shrinking and sparse input without publishing a partial replacement', () => {
    const store = new SeriesStore('line');
    store.setData([{ time: 0, value: 7 }]);
    const revision = store.revision;
    const shrinking: ValuePoint[] = [
      { time: 1, value: 1 },
      { time: 2, value: 2 },
    ];
    Object.defineProperty(shrinking[0], 'value', {
      get() {
        shrinking.pop();
        return 1;
      },
    });
    expect(() => store.setData(shrinking)).toThrow();
    const sparse = new Array<ValuePoint>(2);
    sparse[0] = { time: 1, value: 1 };
    expect(() => store.setData(sparse)).toThrow(ChartError);

    expect(store.revision).toBe(revision);
    expect(store.length).toBe(1);
    expect(store.pointAt(0)).toEqual({ time: 0, value: 7 });
  });

  it('keeps the prior state when a late getter throws in a replacement', () => {
    const store = new SeriesStore('line');
    store.setData([{ time: 0, value: 7 }]);
    const revision = store.revision;
    const reads: string[] = [];
    const failing = {
      time: 2,
      get open() {
        reads.push('open');
        return undefined;
      },
      get high() {
        reads.push('high');
        return undefined;
      },
      get low() {
        reads.push('low');
        throw new Error('late getter failure');
      },
    };
    expect(() => store.setData([{ time: 1, value: 1 }, failing])).toThrow('late getter failure');
    expect(reads).toEqual(['open', 'high', 'low']);
    expect(store.revision).toBe(revision);
    expect(store.length).toBe(1);
    expect(store.pointAt(0)).toEqual({ time: 0, value: 7 });
  });

  it('keeps an outer replacement independent when a value getter updates the same store', () => {
    const store = new SeriesStore('line');
    store.setData([{ time: 0, value: 7 }]);
    let nested = false;
    const first = {
      time: 1,
      get value() {
        if (!nested) {
          nested = true;
          expect(store.update({ time: 3, value: 500 })).toBe('append');
        }
        return 1;
      },
    };

    store.setData([first, { time: 2, value: 2 }]);

    expect(nested).toBe(true);
    expect(store.length).toBe(2);
    expect(store.pointAt(0)).toEqual({ time: 1, value: 1 });
    expect(store.pointAt(1)).toEqual({ time: 2, value: 2 });
    expect(store.range(0, 1)).toEqual({
      min: 1,
      max: 2,
      minIndex: 0,
      maxIndex: 1,
      volume: 0,
      count: 2,
    });
  });

  it('rejects invalid or non-increasing data without partially changing the store', () => {
    const store = new SeriesStore('line', 'business-date');
    store.setData([{ time: '2024-01-02', value: 4 }]);
    const revision = store.revision;

    expect(() =>
      store.setData([
        { time: '2024-01-03', value: 5 },
        { time: '2024-01-03', value: 6 },
      ]),
    ).toThrow(ChartError);
    expect(() => store.setData([{ time: 1, value: 5 }])).toThrow(ChartError);
    expect(() => store.setData([{ time: '2024-01-03', value: Number.NaN }])).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(0)).toEqual({ time: '2024-01-02', value: 4 });
  });

  it('replaces the newest point or appends a later point and rejects history edits atomically', () => {
    const store = new SeriesStore('line');
    store.setData([{ time: 10, value: 1 }]);

    expect(store.update({ time: 10, value: 2 })).toBe('replace');
    expect(store.update({ time: 20, value: 3 })).toBe('append');
    const revision = store.revision;
    expect(() => store.update({ time: 15, value: 9 })).toThrow(ChartError);

    expect(store.revision).toBe(revision);
    expect(store.length).toBe(2);
    expect(store.pointAt(0)).toEqual({ time: 10, value: 2 });
    expect(store.pointAt(1)).toEqual({ time: 20, value: 3 });
  });

  it('tracks explicit whitespace segments and exposes typed numeric columns safely', () => {
    const store = new SeriesStore('candlestick');
    store.setData([
      candle(0, 2, 3, 1, 2, 5),
      { time: 1 },
      candle(2, 4, 5, 3, 4),
      candle(3, 5, 6, 4, 5, 7),
      { time: 4 },
    ]);

    expect(store.segments(-10, 99)).toEqual([
      { from: 0, to: 0 },
      { from: 2, to: 3 },
    ]);
    expect(store.segments(1, 2)).toEqual([{ from: 2, to: 2 }]);
    expect(store.keyAt(1)).toBe(1);
    expect(Number.isNaN(store.valueAt(1))).toBe(true);
    expect(store.openAt(2)).toBe(4);
    expect(store.highAt(2)).toBe(5);
    expect(store.lowAt(2)).toBe(3);
    expect(store.closeAt(2)).toBe(4);
    expect(store.volumeAt(2)).toBe(0);
    expect(Number.isNaN(store.keyAt(99))).toBe(true);
    expect(store.pointAt(99)).toBeNull();
  });

  it('clears candle volume and numeric fields between data and whitespace rows', () => {
    const store = new SeriesStore('candlestick');
    store.setData([candle(0, 2, 3, 1, 2, 5), { time: 1 }, candle(2, 4, 5, 3, 4), { time: 3 }]);

    expect(store.pointAt(1)).toEqual({ time: 1 });
    expect(Number.isNaN(store.valueAt(1))).toBe(true);
    expect(Number.isNaN(store.openAt(1))).toBe(true);
    expect(store.pointAt(2)).toEqual(candle(2, 4, 5, 3, 4));
    expect(store.volumeAt(2)).toBe(0);
    expect(store.range(0, 3)).toEqual({
      min: 1,
      max: 5,
      minIndex: 0,
      maxIndex: 2,
      volume: 5,
      count: 2,
    });
  });

  it('reads successful candle getters in validation order and snapshots their values', () => {
    const reads: string[] = [];
    const caller = {
      get time() {
        reads.push('time');
        return 1;
      },
      get open() {
        reads.push('open');
        return 2;
      },
      get high() {
        reads.push('high');
        return 3;
      },
      get low() {
        reads.push('low');
        return 1;
      },
      get close() {
        reads.push('close');
        return 2;
      },
      get value() {
        reads.push('value');
        return undefined;
      },
      get volume() {
        reads.push('volume');
        return 4;
      },
      get lower() {
        reads.push('lower');
        return undefined;
      },
      get upper() {
        reads.push('upper');
        return undefined;
      },
    };
    const store = new SeriesStore('candlestick');
    store.setData([caller]);

    expect(reads).toEqual([
      'time',
      'open',
      'value',
      'volume',
      'lower',
      'upper',
      'open',
      'high',
      'low',
      'close',
      'volume',
    ]);
    expect(store.pointAt(0)).toEqual(candle(1, 2, 3, 1, 2, 4));
  });

  it('keeps partial-capacity candle ties and volume correct through an append', () => {
    const store = new SeriesStore('candlestick');
    store.setData(
      Array.from({ length: 17 }, (_, time) =>
        time === 5 ? { time } : candle(time, 2, 10, 1, 2, time === 0 ? 5 : 1),
      ),
    );
    expect(store.range(0, 16)).toEqual({
      min: 1,
      max: 10,
      minIndex: 0,
      maxIndex: 0,
      volume: 20,
      count: 16,
    });

    expect(store.update(candle(17, 2, 12, 0, 2, 2))).toBe('append');
    expect(store.range(0, 31)).toEqual({
      min: 0,
      max: 12,
      minIndex: 17,
      maxIndex: 17,
      volume: 22,
      count: 17,
    });
  });

  it('answers clipped inclusive extrema and volume ranges while excluding whitespace', () => {
    const store = new SeriesStore('candlestick');
    store.setData([
      candle(0, 4, 8, 2, 5, 10),
      { time: 1 },
      candle(2, 5, 8, 1, 7, 20),
      candle(3, 6, 9, 1, 8),
      { time: 4 },
    ]);

    expect(store.range(-100, 100)).toEqual({
      min: 1,
      max: 9,
      minIndex: 2,
      maxIndex: 3,
      volume: 30,
      count: 3,
    });
    expect(store.range(0, 2)).toEqual({
      min: 1,
      max: 8,
      minIndex: 2,
      maxIndex: 0,
      volume: 30,
      count: 2,
    });
    expect(store.range(1, 1)).toBeNull();
  });

  it('rejects a full replacement whose aggregate candle volume would overflow', () => {
    const store = new SeriesStore('candlestick');
    store.setData([candle(0, 1, 2, 1, 2, 5)]);
    const revision = store.revision;

    expect(() =>
      store.setData([candle(1, 1, 2, 1, 2, Number.MAX_VALUE), candle(2, 1, 2, 1, 2, Number.MAX_VALUE)]),
    ).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(0)).toEqual(candle(0, 1, 2, 1, 2, 5));
  });

  it('rejects volume overflow before an append that would grow column capacity', () => {
    const store = new SeriesStore('candlestick');
    store.setData(
      Array.from({ length: 16 }, (_, index) => candle(index, 1, 2, 1, 2, index === 0 ? Number.MAX_VALUE : 0)),
    );
    const revision = store.revision;

    expect(() => store.update(candle(16, 1, 2, 1, 2, Number.MAX_VALUE))).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.length).toBe(16);
    expect(store.pointAt(15)).toEqual(candle(15, 1, 2, 1, 2, 0));
    expect(store.range(0, 15)?.volume).toBe(Number.MAX_VALUE);
  });

  it('rejects a newest-point replacement whose aggregate volume would overflow', () => {
    const store = new SeriesStore('candlestick');
    store.setData([candle(0, 1, 2, 1, 2, Number.MAX_VALUE), candle(1, 1, 2, 1, 2)]);
    const revision = store.revision;

    expect(() => store.update(candle(1, 1, 2, 1, 2, Number.MAX_VALUE))).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(1)).toEqual(candle(1, 1, 2, 1, 2));
    expect(store.range(0, 1)?.volume).toBe(Number.MAX_VALUE);
  });
  it('keeps indexed range results correct across amortized append growth', () => {
    const store = new SeriesStore('line');
    for (let index = 0; index < 40; index += 1) {
      expect(store.update({ time: index, value: 100 - index })).toBe('append');
    }
    expect(store.update({ time: 39, value: -5 })).toBe('replace');

    expect(store.length).toBe(40);
    expect(store.range(8, 39)).toEqual({
      min: -5,
      max: 92,
      minIndex: 39,
      maxIndex: 8,
      volume: 0,
      count: 32,
    });
  });
  it('stores complete band points and rolls back an invalid tail replacement', () => {
    const store = new SeriesStore('band', 'utc-ms');
    store.setData([{ time: 1, lower: 2, upper: 4 }, { time: 2 }]);

    expect([store.pointAt(0), store.pointAt(1)]).toEqual([{ time: 1, lower: 2, upper: 4 }, { time: 2 }]);
    expect(Number.isNaN(store.volumeAt(0))).toBe(true);
    const revision = store.revision;
    expect(() => store.update({ time: 2, lower: 5, upper: 4 })).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(1)).toEqual({ time: 2 });

    expect(store.update({ time: 2, lower: 1, upper: 6 })).toBe('replace');
    expect(store.range(0, 1)).toEqual({
      min: 1,
      max: 6,
      minIndex: 1,
      maxIndex: 1,
      volume: 0,
      count: 2,
    });
    expect(store.update({ time: 2 })).toBe('replace');
    expect(store.range(0, 1)).toEqual({
      min: 2,
      max: 4,
      minIndex: 0,
      maxIndex: 0,
      volume: 0,
      count: 1,
    });
  });

  it('rejects incomplete, nonfinite, reversed, and out-of-order band points atomically', () => {
    const store = new SeriesStore('band', 'utc-ms');
    store.setData([{ time: 1, lower: 2, upper: 4 }]);
    const revision = store.revision;

    for (const point of [
      { time: 2, lower: 2 },
      { time: 2, upper: 4 },
      { time: 2, lower: undefined, upper: 4 },
      { time: 2, lower: 2, upper: undefined },
      { time: 2, lower: Number.NaN, upper: 4 },
      { time: 2, lower: 2, upper: Number.POSITIVE_INFINITY },
      { time: 2, lower: 5, upper: 4 },
      { time: 2, lower: 2, upper: 4, value: 3 },
    ]) {
      expect(() => store.update(point)).toThrow(ChartError);
    }
    expect(() =>
      store.setData([
        { time: 3, lower: 1, upper: 6 },
        { time: 2, lower: 2, upper: 5 },
      ]),
    ).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(0)).toEqual({ time: 1, lower: 2, upper: 4 });
  });

  it('snapshots band fields once and returns defensive points', () => {
    let lowerReads = 0;
    let upperReads = 0;
    const caller = {
      time: 1,
      get lower() {
        lowerReads += 1;
        return lowerReads === 1 ? 2 : 20;
      },
      get upper() {
        upperReads += 1;
        return upperReads === 1 ? 4 : 40;
      },
    };
    const store = new SeriesStore('band');
    store.setData([caller]);

    expect(lowerReads).toBe(1);
    expect(upperReads).toBe(1);
    const snapshot = store.pointAt(0) as { time: number; lower: number; upper: number };
    snapshot.lower = 99;
    snapshot.upper = 100;
    expect(store.pointAt(0)).toEqual({ time: 1, lower: 2, upper: 4 });
  });

  it.each([
    { allocation: 1, label: 'first auxiliary-tree index' },
    { allocation: 2, label: 'second auxiliary-tree index' },
  ])('rolls back a growing band append when the $label allocation fails', ({ allocation }) => {
    const store = new SeriesStore('band');
    store.setData(Array.from({ length: 16 }, (_, time) => ({ time, lower: 100 - time, upper: 200 + time })));
    const before = {
      length: store.length,
      revision: store.revision,
      data: Array.from({ length: store.length }, (_, index) => store.pointAt(index)),
      range: store.range(0, store.length - 1),
      bandRange: store.bandRange(0, store.length - 1),
    };
    const NativeInt32Array = globalThis.Int32Array;
    let allocations = 0;
    let thrown: unknown;
    const FailingInt32Array = new Proxy(NativeInt32Array, {
      construct(target, argumentsList) {
        allocations += 1;
        if (allocations === allocation) throw new RangeError('injected Int32Array allocation failure');
        return Reflect.construct(target, argumentsList, target);
      },
    });
    (globalThis as { Int32Array: Int32ArrayConstructor }).Int32Array =
      FailingInt32Array as Int32ArrayConstructor;
    try {
      store.update({ time: 16, lower: -10, upper: 999 });
    } catch (error) {
      thrown = error;
    } finally {
      (globalThis as { Int32Array: Int32ArrayConstructor }).Int32Array = NativeInt32Array;
    }

    expect(thrown).toBeInstanceOf(RangeError);
    expect(allocations).toBe(allocation);
    expect({
      length: store.length,
      revision: store.revision,
      data: Array.from({ length: store.length }, (_, index) => store.pointAt(index)),
      range: store.range(0, store.length - 1),
      bandRange: store.bandRange(0, store.length - 1),
    }).toEqual(before);

    expect(store.update({ time: 16, lower: -10, upper: 999 })).toBe('append');
    expect(store.update({ time: 16, lower: -11, upper: 1000 })).toBe('replace');
    expect(store.length).toBe(17);
    expect(store.revision).toBe(before.revision + 2);
    expect(store.pointAt(16)).toEqual({ time: 16, lower: -11, upper: 1000 });
    expect(store.range(0, 16)).toEqual({
      min: -11,
      max: 1000,
      minIndex: 16,
      maxIndex: 16,
      volume: 0,
      count: 17,
    });
    expect(store.bandRange(0, 16)).toEqual({
      lowerMin: -11,
      lowerMax: 100,
      upperMin: 200,
      upperMax: 1000,
      lowerMinIndex: 16,
      lowerMaxIndex: 0,
      upperMinIndex: 0,
      upperMaxIndex: 16,
      count: 17,
    });
  });

  it('tracks both band boundaries in indexed ranges across replacement and growth', () => {
    const store = new SeriesStore('band');
    for (let index = 0; index < 40; index += 1) {
      expect(store.update({ time: index, lower: 100 - index, upper: 200 + index })).toBe('append');
    }
    expect(store.update({ time: 39, lower: -5, upper: 500 })).toBe('replace');

    expect(store.lowerAt(8)).toBe(92);
    expect(store.upperAt(8)).toBe(208);
    expect(Number.isNaN(store.valueAt(8))).toBe(true);
    expect(store.range(8, 39)).toEqual({
      min: -5,
      max: 500,
      minIndex: 39,
      maxIndex: 39,
      volume: 0,
      count: 32,
    });
    expect(store.bandRange(8, 39)).toEqual({
      lowerMin: -5,
      lowerMax: 92,
      upperMin: 208,
      upperMax: 500,
      lowerMinIndex: 39,
      lowerMaxIndex: 8,
      upperMinIndex: 8,
      upperMaxIndex: 39,
      count: 32,
    });
  });

  it('indexes each band boundary independently for dense envelope sampling', () => {
    const store = new SeriesStore('band');
    store.setData([
      { time: 0, lower: 5, upper: 10 },
      { time: 1, lower: 1, upper: 7 },
      { time: 2 },
      { time: 3, lower: 4, upper: 12 },
    ]);

    expect(store.bandRange(0, 3)).toEqual({
      lowerMin: 1,
      lowerMax: 5,
      upperMin: 7,
      upperMax: 12,
      lowerMinIndex: 1,
      lowerMaxIndex: 0,
      upperMinIndex: 1,
      upperMaxIndex: 3,
      count: 3,
    });
  });

  it('uses the selected time domain for band ordering and whitespace', () => {
    const store = new SeriesStore('band', 'business-date');
    store.setData([{ time: '2024-01-02', lower: 2, upper: 4 }, { time: '2024-01-03' }]);
    expect(store.segments(0, 1)).toEqual([{ from: 0, to: 0 }]);
    expect(() => store.update({ time: 1, lower: 3, upper: 5 })).toThrow(ChartError);
    expect(store.pointAt(1)).toEqual({ time: '2024-01-03' });
  });

  it('rejects band bounds passed to old series kinds instead of treating them as whitespace', () => {
    const line = new SeriesStore('line');
    line.setData([{ time: 1, value: 3 }]);
    const candleStore = new SeriesStore('candlestick');
    candleStore.setData([candle(1, 2, 3, 1, 2)]);

    expect(() => line.update({ time: 2, lower: 2, upper: 4 })).toThrow(ChartError);
    expect(() => candleStore.update({ time: 2, lower: 2, upper: 4 })).toThrow(ChartError);
    expect(line.pointAt(0)).toEqual({ time: 1, value: 3 });
    expect(candleStore.pointAt(0)).toEqual(candle(1, 2, 3, 1, 2));
  });

  it('uses values for value-series ranges and accepts finite non-positive values', () => {
    const points: ValuePoint[] = [
      { time: 0, value: 0 },
      { time: 1, value: -2 },
      { time: 2, value: -2 },
    ];
    const store = new SeriesStore('histogram');
    store.setData(points);

    expect(store.range(0, 2)).toEqual({
      min: -2,
      max: 0,
      minIndex: 1,
      maxIndex: 0,
      volume: 0,
      count: 3,
    });
    expect(store.lowerBound(1)).toBe(1);
  });

  it.each(['line', 'area', 'histogram'] as const)(
    'preserves %s ranges and unavailable candle fields through growth and reset',
    (type) => {
      const store = new SeriesStore(type);
      const initial = Array.from({ length: 16 }, (_, time) =>
        time === 5 ? { time } : { time, value: 100 - time },
      );
      store.setData(initial);
      expect(store.update({ time: 16, value: -2 })).toBe('append');
      expect(store.update({ time: 16, value: -3 })).toBe('replace');

      expect(store.range(0, 16)).toEqual({
        min: -3,
        max: 100,
        minIndex: 16,
        maxIndex: 0,
        volume: 0,
        count: 16,
      });
      expect(store.range(5, 5)).toBeNull();
      expect(store.pointAt(5)).toEqual({ time: 5 });
      expect(store.pointAt(16)).toEqual({ time: 16, value: -3 });
      expect(Number.isNaN(store.openAt(16))).toBe(true);
      expect(Number.isNaN(store.highAt(16))).toBe(true);
      expect(Number.isNaN(store.lowAt(16))).toBe(true);
      expect(Number.isNaN(store.closeAt(16))).toBe(true);
      expect(Number.isNaN(store.volumeAt(16))).toBe(true);

      store.setData([]);
      expect(store.length).toBe(0);
      expect(store.range(0, 16)).toBeNull();
      expect(store.pointAt(0)).toBeNull();
    },
  );

  it('keeps OHLC volume and overflow behavior across full replacement and newest-point update', () => {
    const store = new SeriesStore('ohlc');
    store.setData([candle(0, 2, 3, 1, 2, Number.MAX_VALUE), candle(1, 2, 3, 1, 2)]);
    const revision = store.revision;

    expect(store.pointAt(1)).toEqual(candle(1, 2, 3, 1, 2));
    expect(store.volumeAt(1)).toBe(0);
    expect(store.range(0, 1)?.volume).toBe(Number.MAX_VALUE);
    expect(() => store.update(candle(1, 2, 3, 1, 2, Number.MAX_VALUE))).toThrow(ChartError);
    expect(() =>
      store.setData([candle(0, 2, 3, 1, 2, Number.MAX_VALUE), candle(1, 2, 3, 1, 2, Number.MAX_VALUE)]),
    ).toThrow(ChartError);
    expect(store.revision).toBe(revision);
    expect(store.pointAt(1)).toEqual(candle(1, 2, 3, 1, 2));
  });
});

describe.each(['line', 'area', 'histogram'] as const)('scalar bulk contract: %s', (type) => {
  const readPrefix = ['time', 'open', 'high', 'low', 'close', 'value', 'volume', 'lower', 'upper'];

  it('preserves proxy reads and snapshots the second value read without probing descriptors', () => {
    const store = new SeriesStore(type);
    const reads: string[] = [];
    let valueReads = 0;
    const point = new Proxy(
      { time: 1, value: 1 },
      {
        get(target, key, receiver) {
          reads.push(String(key));
          if (key === 'value') return ++valueReads === 1 ? 7 : -0;
          return Reflect.get(target, key, receiver);
        },
        ownKeys() {
          throw new Error('unexpected enumeration');
        },
        getOwnPropertyDescriptor() {
          throw new Error('unexpected descriptor probe');
        },
      },
    );
    store.setData([point]);
    expect(reads).toEqual([...readPrefix, 'value']);
    expect(Object.is((store.pointAt(0) as ValuePoint).value, -0)).toBe(true);
    expect(Object.is(store.range(0, 0)!.min, -0)).toBe(true);
  });

  it('retains short-circuit candle probing and late-getter error precedence', () => {
    const store = new SeriesStore(type);
    store.setData([{ time: 0, value: 3 }]);
    const revision = store.revision;
    for (const failingUpper of [false, true]) {
      const reads: string[] = [];
      const sentinel = new Error('upper getter wins over shape rejection');
      const point = new Proxy(
        { time: 1, open: 2, value: 1 },
        {
          get(target, key, receiver) {
            reads.push(String(key));
            if (key === 'upper' && failingUpper) throw sentinel;
            if (key === 'high' || key === 'low' || key === 'close')
              throw new Error('probe did not short-circuit');
            return Reflect.get(target, key, receiver);
          },
        },
      );
      expect(() => store.setData([point])).toThrow(
        failingUpper ? sentinel : type + ' series require value points or whitespace',
      );
      expect(reads).toEqual(['time', 'open', 'value', 'volume', 'lower', 'upper']);
      expect(store.revision).toBe(revision);
      expect(store.pointAt(0)).toEqual({ time: 0, value: 3 });
    }
  });

  it('does not take a second value read for whitespace or read fields after invalid time', () => {
    const store = new SeriesStore(type);
    const reads: string[] = [];
    const point = new Proxy(
      { time: 1 },
      {
        get(target, key, receiver) {
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      },
    );
    store.setData([point]);
    expect(reads).toEqual(readPrefix);
    expect(store.pointAt(0)).toEqual({ time: 1 });
    expect(store.range(0, 0)).toBeNull();
    reads.length = 0;
    expect(() =>
      store.setData([
        new Proxy(
          { time: NaN, value: 1 },
          {
            get(target, key, receiver) {
              reads.push(String(key));
              return Reflect.get(target, key, receiver);
            },
          },
        ),
      ]),
    ).toThrow('UTC time');
    expect(reads).toEqual(['time']);
    expect(store.pointAt(0)).toEqual({ time: 1 });
  });

  it('keeps a completed inner write when the outer second value read fails', () => {
    const store = new SeriesStore(type);
    store.setData([{ time: 0, value: 1 }]);
    let reads = 0;
    const failure = new Error('outer finite-value read failed');
    const point = {
      time: 1,
      get value() {
        if (++reads === 1) {
          store.setData([{ time: 5, value: 9 }]);
          return 7;
        }
        throw failure;
      },
    };
    expect(() => store.setData([point])).toThrow(failure);
    expect(store.revision).toBe(2);
    expect(store.pointAt(0)).toEqual({ time: 5, value: 9 });
    expect(store.range(0, 0)).toMatchObject({ min: 9, max: 9, count: 1 });
  });

  it('keeps growth scratch local through nested updates and preserves the complete outer publication', () => {
    const store = new SeriesStore(type);
    store.setData([{ time: -1, value: -1 }]);
    const points: ValuePoint[] = Array.from({ length: 16 }, (_, time) => ({ time, value: time }));
    let added = false;
    Object.defineProperty(points[0], 'value', {
      get() {
        if (!added) {
          added = true;
          points.push({
            time: 16,
            get value() {
              store.update({ time: 20, value: 500 });
              return -7;
            },
          });
        }
        return 0;
      },
    });
    store.setData(points);
    expect(store.length).toBe(17);
    expect(store.pointAt(16)).toEqual({ time: 16, value: -7 });
    expect(store.range(0, 16)).toMatchObject({ min: -7, max: 15, minIndex: 16, maxIndex: 15, count: 17 });
    expect(store.revision).toBe(4); // Both value reads perform the inner update, then outer publication.
  });
});

describe.each(['line', 'area', 'histogram', 'band', 'candlestick', 'ohlc'] as const)(
  'raw timestamp storage contract: %s',
  (type) => {
    const point = (time: number | string, present = true): SeriesPoint => {
      if (!present) return { time } as SeriesPoint;
      if (type === 'band') return { time, upper: 5, lower: 1 } as SeriesPoint;
      if (type === 'candlestick' || type === 'ohlc')
        return { time, open: 2, high: 5, low: 1, close: 3, volume: 4 } as SeriesPoint;
      return { time, value: 3 } as SeriesPoint;
    };

    it('preserves UTC bounds, signed zero, copies, replacement, growth and shrink', () => {
      const store = new SeriesStore(type);
      const limit = 8_640_000_000_000_000;
      store.setData([point(-limit), point(-0, false), point(limit)]);
      expect(Object.is(store.pointAt(1)!.time, -0)).toBe(true);
      expect(Object.is(store.keyAt(1), -0)).toBe(true);
      expect(store.pointAt(0)).toEqual(point(-limit));
      expect(store.pointAt(2)).toEqual(point(limit));
      const revision = store.revision;
      expect(() => store.setData([point(0), point(limit + 1)])).toThrow();
      expect(store.revision).toBe(revision);
      expect(store.pointAt(2)).toEqual(point(limit));
      store.setData([point(-0)]);
      store.update(point(0, false));
      expect(Object.is(store.pointAt(0)!.time, 0)).toBe(true);
      store.update(point(-0));
      expect(Object.is(store.pointAt(0)!.time, -0)).toBe(true);
      for (let time = 1; time < 34; time++) store.update(point(time, time % 3 !== 0));
      expect(store.length).toBe(34);
      for (let time = 1; time < 34; time++) expect(store.pointAt(time)).toEqual(point(time, time % 3 !== 0));
      const copy = store.pointAt(33)!;
      (copy as { time: number }).time = -99;
      expect(store.pointAt(33)!.time).toBe(33);
      for (const index of [-1, 34, 0.5, NaN, Infinity]) expect(store.pointAt(index)).toBeNull();
      store.setData([point(7, false)]);
      expect(store.pointAt(0)).toEqual({ time: 7 });
      expect(store.pointAt(1)).toBeNull();
      store.setData([]);
      expect(store.length).toBe(0);
    });

    it('reads time once on bulk/growth/update and keeps failed outer staging isolated', () => {
      const store = new SeriesStore(type);
      const rows = Array.from({ length: 16 }, (_, i) => point(i));
      let reads = 0;
      Object.defineProperty(rows[0], 'time', {
        get() {
          reads++;
          rows.push(point(16));
          return -0;
        },
      });
      store.setData(rows);
      expect(reads).toBe(1);
      expect(store.length).toBe(17);
      expect(Object.is(store.pointAt(0)!.time, -0)).toBe(true);
      const update = point(17);
      Object.defineProperty(update, 'time', {
        get() {
          reads++;
          return 17;
        },
      });
      store.update(update);
      expect(reads).toBe(2);
      const failure = new Error('late timestamp failure');
      const late = point(3);
      Object.defineProperty(late, 'time', {
        get() {
          store.update(point(18));
          throw failure;
        },
      });
      expect(() => store.setData([point(1), late])).toThrow(failure);
      expect(store.length).toBe(19);
      expect(store.pointAt(18)).toEqual(point(18));
      expect(Object.is(store.pointAt(0)!.time, -0)).toBe(true);
      const shrinking = [point(1), point(2)];
      Object.defineProperty(shrinking[0], 'time', {
        get() {
          shrinking.pop();
          return 1;
        },
      });
      expect(() => store.setData(shrinking)).toThrow();
      expect(store.length).toBe(19);
    });

    it('retains business-date strings through growth, whitespace and rollback', () => {
      const store = new SeriesStore(type, 'business-date');
      const date = (i: number) =>
        `0099-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
      store.setData(Array.from({ length: 16 }, (_, i) => point(date(i), i % 3 !== 0)));
      for (let i = 16; i < 34; i++) store.update(point(date(i)));
      store.update(point(date(33), false));
      expect(store.pointAt(0)).toEqual(point(date(0), false));
      expect(store.pointAt(33)).toEqual(point(date(33), false));
      const revision = store.revision;
      expect(() => store.setData([point('0000-01-01'), point('0099-02-30')])).toThrow();
      expect(store.revision).toBe(revision);
      expect(store.pointAt(33)).toEqual(point(date(33), false));
      store.setData([point('0000-01-01')]);
      expect(store.pointAt(0)).toEqual(point('0000-01-01'));
    });
  },
);

describe('timestamp column allocation', () => {
  it.each(['line', 'area', 'histogram', 'band', 'candlestick', 'ohlc'] as const)(
    'allocates raw strings only for business-date stores (%s)',
    (type) => {
      for (const domain of ['utc-ms', 'business-date'] as const) {
        const store = new SeriesStore(type, domain);
        const times = () => (store as unknown as { columns: { times: unknown[] | null } }).columns.times;
        const assertAllocation = () => {
          if (domain === 'utc-ms') expect(times()).toBeNull();
          else expect(Array.isArray(times())).toBe(true);
        };
        const point = (i: number) =>
          ({ time: domain === 'utc-ms' ? i : `2000-01-${String(i + 1).padStart(2, '0')}` }) as SeriesPoint;
        assertAllocation();
        store.setData(Array.from({ length: 16 }, (_, i) => point(i)));
        assertAllocation();
        store.update(point(16));
        assertAllocation();
        store.update(point(16));
        assertAllocation();
        store.setData([point(0)]);
        assertAllocation();
        store.setData([]);
        assertAllocation();
      }
    },
  );
});
