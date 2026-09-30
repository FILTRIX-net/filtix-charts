import { describe, expect, it } from 'vitest';
import { ChartError } from '@filtrix.net/core';
import {
  bollingerBands,
  createBollingerBands,
  createMacd,
  macd,
  type BollingerBandsOptions,
  type IndicatorPoint,
  type MacdOptions,
} from './index';

const points = (numbers: readonly (number | null)[]): IndicatorPoint[] =>
  numbers.map((value, index) => (value === null ? { time: index + 1 } : { time: index + 1, value }));

const pointValue = (point: IndicatorPoint): number | undefined =>
  'value' in point ? point.value : undefined;

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ChartError);
    expect((error as ChartError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ChartError ${code}`);
}

describe('MACD mathematics', () => {
  it('seeds price and signal EMAs independently at the specified indexes', () => {
    const input = [1, 2, 3, 4, 5].map((value, index) => ({ time: index + 1, value }));
    const result = macd(input, { fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 });

    expect(result.macd).toEqual([
      { time: 1 },
      { time: 2 },
      { time: 3, value: 0.5 },
      { time: 4, value: 0.5 },
      { time: 5, value: 0.5 },
    ]);
    expect(result.signal).toEqual([
      { time: 1 },
      { time: 2 },
      { time: 3 },
      { time: 4, value: 0.5 },
      { time: 5, value: 0.5 },
    ]);
    expect(result.histogram).toEqual([
      { time: 1 },
      { time: 2 },
      { time: 3 },
      { time: 4, value: 0 },
      { time: 5, value: 0 },
    ]);
  });

  it('matches hand-derived non-monotonic seeded recurrences for every output', () => {
    const result = macd(points([10, 11, 8, 12, 7, 13]), {
      fastPeriod: 2,
      slowPeriod: 3,
      signalPeriod: 2,
    });

    const expectedMacd = [undefined, undefined, -5 / 6, 1 / 9, -65 / 108, 311 / 648];
    const expectedSignal = [undefined, undefined, undefined, -13 / 36, -169 / 324, 71 / 486];
    const expectedHistogram = [undefined, undefined, undefined, 17 / 36, -13 / 162, 649 / 1944];
    expectedMacd.forEach((expected, index) => {
      expected === undefined
        ? expect(result.macd[index]).toEqual({ time: index + 1 })
        : expect(pointValue(result.macd[index]!)).toBeCloseTo(expected, 14);
      expectedSignal[index] === undefined
        ? expect(result.signal[index]).toEqual({ time: index + 1 })
        : expect(pointValue(result.signal[index]!)).toBeCloseTo(expectedSignal[index]!, 14);
      expectedHistogram[index] === undefined
        ? expect(result.histogram[index]).toEqual({ time: index + 1 })
        : expect(pointValue(result.histogram[index]!)).toBeCloseTo(expectedHistogram[index]!, 14);
    });
  });

  it('resets every recurrence at whitespace without hiding earlier MACD values', () => {
    const result = macd(points([1, 2, 3, null, 10, 12, 14, 16]), {
      fastPeriod: 2,
      slowPeriod: 3,
      signalPeriod: 2,
    });
    expect(result.macd).toEqual([
      { time: 1 },
      { time: 2 },
      { time: 3, value: 0.5 },
      { time: 4 },
      { time: 5 },
      { time: 6 },
      { time: 7, value: 1 },
      { time: 8, value: 1 },
    ]);
    expect(result.signal.slice(2)).toEqual([
      { time: 3 },
      { time: 4 },
      { time: 5 },
      { time: 6 },
      { time: 7 },
      { time: 8, value: 1 },
    ]);
    expect(result.histogram[7]).toEqual({ time: 8, value: 0 });
  });
});

describe('Bollinger Bands mathematics', () => {
  it('uses direct-window population variance for the hand-computable seed', () => {
    const result = bollingerBands(points([1, 2, 3]), { period: 3, multiplier: 2 });
    expect(result.middle[2]).toEqual({ time: 3, value: 2 });
    expect(pointValue(result.upper[2]!)).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3), 12);
    expect(pointValue(result.lower[2]!)).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3), 12);
  });

  it('matches independent direct-window means and deviations on non-monotonic data', () => {
    const input = points([10, -2, 7, 1, 12, -4]);
    const result = bollingerBands(input, { period: 3, multiplier: 1.5 });
    const expected = [
      undefined,
      undefined,
      { mean: 5, deviation: Math.sqrt(26) },
      { mean: 2, deviation: Math.sqrt(14) },
      { mean: 20 / 3, deviation: Math.sqrt(182 / 9) },
      { mean: 3, deviation: Math.sqrt(134 / 3) },
    ];

    expected.forEach((window, index) => {
      if (window === undefined) {
        expect(result.middle[index]).toEqual({ time: index + 1 });
        expect(result.upper[index]).toEqual({ time: index + 1 });
        expect(result.lower[index]).toEqual({ time: index + 1 });
        return;
      }
      expect(pointValue(result.middle[index]!)).toBeCloseTo(window.mean, 12);
      expect(pointValue(result.upper[index]!)).toBeCloseTo(window.mean + 1.5 * window.deviation, 12);
      expect(pointValue(result.lower[index]!)).toBeCloseTo(window.mean - 1.5 * window.deviation, 12);
    });
  });

  it('keeps high-offset narrow bands stable and verifies spread independently', () => {
    const input = points([1e12 + 1, 1e12 - 1, 1e12 + 2, 1e12 - 2]);
    const result = bollingerBands(input, { period: 4, multiplier: 2 });
    const expectedDeviation = Math.sqrt(2.5);
    const upper = pointValue(result.upper[3]!)!;
    const lower = pointValue(result.lower[3]!)!;

    expect(pointValue(result.middle[3]!)).toBe(1e12);
    expect((upper - lower) / 4).toBeCloseTo(expectedDeviation, 4);
  });

  it('keeps period-20 and period-500 rolling maintenance bounded and numerically stable', () => {
    for (const period of [20, 500]) {
      const numbers = Array.from(
        { length: period + 250 },
        (_, index) => 1e12 + (((index * 37) % 101) - 50) / 8,
      );
      const result = bollingerBands(points(numbers), { period, multiplier: 2.5 });
      const window = numbers.slice(-period);
      const anchor = window[0]!;
      const mean = anchor + window.reduce((sum, value) => sum + (value - anchor), 0) / window.length;
      let squaredDeviation = 0;
      for (const value of window) squaredDeviation += (value - mean) ** 2;
      const deviation = Math.sqrt(squaredDeviation / window.length);
      const last = numbers.length - 1;
      const upper = pointValue(result.upper[last]!)!;
      const lower = pointValue(result.lower[last]!)!;

      expect(pointValue(result.middle[last]!)).toBeCloseTo(mean, 3);
      expect((upper - lower) / 5).toBeCloseTo(deviation, 3);
    }
  });

  it('resets its complete bounded window at whitespace', () => {
    const result = bollingerBands(points([2, 4, 6, null, 10, 14]), { period: 2, multiplier: 1 });
    expect(result.middle).toEqual([
      { time: 1 },
      { time: 2, value: 3 },
      { time: 3, value: 5 },
      { time: 4 },
      { time: 5 },
      { time: 6, value: 12 },
    ]);
    expect(result.upper[5]).toEqual({ time: 6, value: 14 });
    expect(result.lower[5]).toEqual({ time: 6, value: 10 });
  });
});

describe('multi-output validation and time domains', () => {
  it('preserves final replacement after empty, single, and gapped bulk MACD and Bollinger data', () => {
    const macdOptions = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const bandsOptions = { period: 2, multiplier: 1 };
    const cases = [
      { create: () => createMacd(macdOptions), batch: (input: IndicatorPoint[]) => macd(input, macdOptions) },
      {
        create: () => createBollingerBands(bandsOptions),
        batch: (input: IndicatorPoint[]) => bollingerBands(input, bandsOptions),
      },
    ];
    for (const indicator of cases) {
      const stream = indicator.create();
      stream.setData([]);
      expect(stream.getData()).toEqual(indicator.batch([]));
      stream.update({ time: 1, value: 1 });
      stream.update({ time: 1, value: 2 });
      expect(stream.getData()).toEqual(indicator.batch([{ time: 1, value: 2 }]));

      stream.setData([{ time: 1, value: 1 }]);
      stream.update({ time: 1, value: 2 });
      expect(stream.getData()).toEqual(indicator.batch([{ time: 1, value: 2 }]));

      const prefix = points([1, 3, 5]);
      stream.setData([...prefix, { time: 4 }]);
      for (const tail of [{ time: 4, value: 7 }, { time: 4 }, { time: 4, value: 9 }]) {
        stream.update(tail);
        expect(stream.getData()).toEqual(indicator.batch([...prefix, tail]));
      }
      const extended = [...prefix, { time: 4, value: 9 }, { time: 5, value: 11 }, { time: 6, value: 13 }];
      stream.update(extended[4]!);
      stream.update(extended[5]!);
      expect(stream.getData()).toEqual(indicator.batch(extended));
    }
  });

  it('keeps nested updates and later recovery after intermediate and final bulk failures', () => {
    const macdOptions = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const bandsOptions = { period: 2, multiplier: 1 };
    const cases = [
      { create: () => createMacd(macdOptions), batch: (input: IndicatorPoint[]) => macd(input, macdOptions) },
      {
        create: () => createBollingerBands(bandsOptions),
        batch: (input: IndicatorPoint[]) => bollingerBands(input, bandsOptions),
      },
    ];
    for (const indicator of cases) {
      const stream = indicator.create();
      stream.setData(points([1, 2]));
      let firstReads = 0;
      let secondReads = 0;
      expect(() =>
        stream.setData([
          {
            get time() {
              firstReads += 1;
              if (firstReads === 2) stream.update({ time: 3, value: 3 });
              return 1;
            },
            value: 10,
          },
          {
            get time() {
              secondReads += 1;
              if (secondReads === 2) throw new Error('intermediate bulk read');
              return 2;
            },
            value: 20,
          },
          { time: 3, value: 30 },
        ]),
      ).toThrow('intermediate bulk read');
      expect(stream.getData()).toEqual(indicator.batch(points([1, 2, 3])));

      stream.update({ time: 4, value: 4 });
      const recovered = indicator.batch(points([1, 2, 3, 4]));
      expect(stream.getData()).toEqual(recovered);
      let finalReads = 0;
      expect(() =>
        stream.setData([
          { time: 1, value: 10 },
          {
            get time() {
              finalReads += 1;
              if (finalReads === 2) throw new Error('final bulk read');
              return 2;
            },
            value: 20,
          },
        ]),
      ).toThrow('final bulk read');
      expect(stream.getData()).toEqual(recovered);
    }
  });

  it('keeps append key order after a calculation-time getter performs a nested update', () => {
    const options = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const stream = createMacd(options);
    const input: IndicatorPoint[] = [{ time: 1, value: 1 }];
    stream.setData(input);
    let reads = 0;
    stream.update({
      get time() {
        reads += 1;
        if (reads === 2) stream.update({ time: 2, value: 3 });
        return 3;
      },
      value: 5,
    });
    expect(reads).toBe(2);
    input.push({ time: 2, value: 3 }, { time: 3, value: 5 });
    expect(stream.getData()).toEqual(macd(input, options));

    expectCode(() => stream.update({ time: 4, value: Number.NaN }), 'INVALID_VALUE');
    expect(stream.getData()).toEqual(macd(input, options));
    stream.update({ time: 4, value: 7 });
    input.push({ time: 4, value: 7 });
    expect(stream.getData()).toEqual(macd(input, options));
    stream.update({ time: 4, value: 9 });
    input[input.length - 1] = { time: 4, value: 9 };
    expect(stream.getData()).toEqual(macd(input, options));
  });

  it('keeps output when a value getter installs inherited validation-field setters', () => {
    for (const field of ['point', 'key', 'value'] as const) {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let reads = 0;
      let setterCalls = 0;
      let actual: unknown;
      let thrown: unknown;
      const input = {
        time: 0,
        get value() {
          reads += 1;
          if (reads === 3) {
            Object.defineProperty(Object.prototype, field, {
              configurable: true,
              set() {
                setterCalls += 1;
                throw new Error(`inherited ${field} setter`);
              },
            });
          }
          return 2;
        },
      };
      try {
        const stream = createMacd({ fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 });
        stream.setData([input]);
        actual = stream.getData();
      } catch (error) {
        thrown = error;
      } finally {
        if (previous === undefined) Reflect.deleteProperty(Object.prototype, field);
        else Object.defineProperty(Object.prototype, field, previous);
      }
      expect(thrown).toBeUndefined();
      expect(setterCalls).toBe(0);
      expect(reads).toBe(3);
      expect(actual).toEqual({
        macd: [{ time: 0 }],
        signal: [{ time: 0 }],
        histogram: [{ time: 0 }],
      });
    }
  });

  it('uses final validated values and captured references from a growing input iterator', () => {
    const makeInput = (): IndicatorPoint[] => {
      const input: IndicatorPoint[] = [];
      let firstReads = 0;
      let secondReads = 0;
      const second = {
        time: 1,
        get value() {
          secondReads += 1;
          if (secondReads === 3) input[0] = { time: 0, value: 99 };
          return 3;
        },
      };
      input.push({
        time: 0,
        get value() {
          firstReads += 1;
          if (firstReads === 3) input.push(second);
          return firstReads === 3 ? 7 : 1;
        },
      });
      return input;
    };

    const macdStream = createMacd({ fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 });
    macdStream.setData(makeInput());
    expect(macdStream.getData().macd).toEqual([{ time: 0 }, { time: 1, value: -2 }]);

    const bandsStream = createBollingerBands({ period: 2, multiplier: 1 });
    bandsStream.setData(makeInput());
    expect(bandsStream.getData()).toEqual({
      middle: [{ time: 0 }, { time: 1, value: 5 }],
      upper: [{ time: 0 }, { time: 1, value: 7 }],
      lower: [{ time: 0 }, { time: 1, value: 3 }],
    });

    let timeReads = 0;
    expectCode(
      () =>
        macdStream.setData([
          {
            get time() {
              timeReads += 1;
              if (timeReads > 1) throw new Error('calculation started before validation ended');
              return 0;
            },
            value: 1,
          },
          { time: 1, value: Number.NaN },
        ]),
      'INVALID_VALUE',
    );
    expect(timeReads).toBe(1);
    expect(macdStream.getData().macd).toEqual([{ time: 0 }, { time: 1, value: -2 }]);

    const nanOnThirdRead = (): IndicatorPoint[] => {
      let reads = 0;
      return [
        {
          time: 0,
          get value() {
            reads += 1;
            return reads >= 3 ? Number.NaN : 1;
          },
        },
        { time: 1, value: 3 },
      ];
    };
    expectCode(() => macdStream.setData(nanOnThirdRead()), 'INDICATOR_OVERFLOW');
    expectCode(() => bandsStream.setData(nanOnThirdRead()), 'INDICATOR_OVERFLOW');
    expect(macdStream.getData().macd).toEqual([{ time: 0 }, { time: 1, value: -2 }]);
    expect(bandsStream.getData().middle).toEqual([{ time: 0 }, { time: 1, value: 5 }]);
  });

  it('keeps batch output points independent from inputs and sibling outputs', () => {
    const input = points([1, 3, 5]);
    const macdResult = macd(input, { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 });
    const bandsResult = bollingerBands(input, { period: 2, multiplier: 1 });

    input[2]!.time = 97;
    if ('value' in input[2]!) input[2]!.value = 99;
    macdResult.macd[2]!.time = 99;
    bandsResult.upper[2]!.time = 98;

    expect(macdResult.signal[2]).toEqual({ time: 3, value: 1 });
    expect(macdResult.histogram[2]).toEqual({ time: 3, value: 0 });
    expect(bandsResult.middle[2]).toEqual({ time: 3, value: 4 });
    expect(bandsResult.lower[2]).toEqual({ time: 3, value: 3 });
  });

  it('rejects unsafe periods, invalid multipliers, missing fields, and unknown option fields', () => {
    const input = points([1, 2, 3]);
    const invalidMacd: unknown[] = [
      { fastPeriod: 0, slowPeriod: 3, signalPeriod: 2 },
      { fastPeriod: 3, slowPeriod: 3, signalPeriod: 2 },
      { fastPeriod: 1, slowPeriod: 2.5, signalPeriod: 2 },
      { fastPeriod: 1, slowPeriod: 2, signalPeriod: Number.MAX_SAFE_INTEGER + 1 },
      { fastPeriod: 1, slowPeriod: 2 },
      { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1, extra: true },
      null,
    ];
    for (const options of invalidMacd) {
      expect(() => macd(input, options as MacdOptions)).toThrow(ChartError);
    }

    const invalidBands: unknown[] = [
      { period: 1, multiplier: 2 },
      { period: 2.5, multiplier: 2 },
      { period: 2, multiplier: 0 },
      { period: 2, multiplier: Number.POSITIVE_INFINITY },
      { period: 2 },
      { period: 2, multiplier: 2, extra: true },
      null,
    ];
    for (const options of invalidBands) {
      expect(() => bollingerBands(input, options as BollingerBandsOptions)).toThrow(ChartError);
    }
  });

  it('infers business-date batch data and rejects mixed or malformed input', () => {
    const dated = [
      { time: '2026-09-01', value: 1 },
      { time: '2026-09-02', value: 2 },
      { time: '2026-09-03', value: 3 },
    ];
    expect(macd(dated, { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 }).macd[2]).toEqual({
      time: '2026-09-03',
      value: 0.5,
    });
    expect(bollingerBands(dated, { period: 2, multiplier: 1 }).middle[2]).toEqual({
      time: '2026-09-03',
      value: 2.5,
    });
    expect(() =>
      macd(
        [
          { time: '2026-09-01', value: 1 },
          { time: 2, value: 2 },
        ],
        { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 },
      ),
    ).toThrow(ChartError);
    expect(() => bollingerBands({} as IndicatorPoint[], { period: 2, multiplier: 1 })).toThrow(ChartError);
  });
});

describe('streaming MACD', () => {
  it('keeps returned point mutations isolated across append and tail replacement', () => {
    const options = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const stream = createMacd(options);
    stream.setData(points([1, 3]));

    const appended = stream.update({ time: 3, value: 5 });
    appended.macd.time = 99;
    if ('value' in appended.macd) appended.macd.value = 99;
    const snapshot = stream.getData();
    snapshot.signal[2]!.time = 98;
    if ('value' in snapshot.signal[2]!) snapshot.signal[2]!.value = 98;
    expect(stream.getData()).toEqual(macd(points([1, 3, 5]), options));

    const replaced = stream.update({ time: 3, value: 7 });
    replaced.histogram.time = 97;
    if ('value' in replaced.histogram) replaced.histogram.value = 97;
    expect(stream.getData()).toEqual(macd(points([1, 3, 7]), options));
  });

  it('matches batch through append and repeated value/whitespace tail replacements', () => {
    const options = { fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 };
    const stream = createMacd(options);
    const input = points([1, 5, 2, 8, 3, 9]);
    stream.setData(input.slice(0, 5));
    expect(stream.update(input[5]!)).toEqual({
      macd: macd(input, options).macd[5],
      signal: macd(input, options).signal[5],
      histogram: macd(input, options).histogram[5],
    });

    for (const replacement of [{ time: 6 }, { time: 6, value: 10 }, { time: 6, value: 4 }]) {
      stream.update(replacement);
      const expected = macd([...input.slice(0, -1), replacement], options);
      expect(stream.getData()).toEqual(expected);
    }
  });

  it('restores pre-gap state when a whitespace tail becomes numeric and back again', () => {
    const options = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 2 };
    const base = points([2, 4, 6, null]);
    const stream = createMacd(options);
    stream.setData(base);
    stream.update({ time: 4, value: 8 });
    expect(stream.getData()).toEqual(macd(points([2, 4, 6, 8]), options));
    stream.update({ time: 4 });
    expect(stream.getData()).toEqual(macd(base, options));
    stream.update({ time: 4, value: 10 });
    expect(stream.getData()).toEqual(macd(points([2, 4, 6, 10]), options));
  });

  it('rolls back overflow atomically and accepts the next valid append', () => {
    const options = { fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 };
    const max = Number.MAX_VALUE;
    const base = points([max, max, max, max]);
    const stream = createMacd(options);
    stream.setData(base);

    expectCode(() => stream.setData(points([max, max, max, max, -max])), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(macd(base, options));
    expectCode(() => stream.update({ time: 5, value: -max }), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(macd(base, options));
    stream.update({ time: 5, value: max });
    expect(stream.getData()).toEqual(macd(points([max, max, max, max, max]), options));
  });

  it('keeps setData atomic, enforces domain ordering, and returns defensive copies', () => {
    const options = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const stream = createMacd(options, 'business-date');
    const input = [
      { time: '2026-09-01', value: 1 },
      { time: '2026-09-02', value: 2 },
    ];
    stream.setData(input);
    expect(() =>
      stream.setData([
        { time: '2026-09-02', value: 2 },
        { time: '2026-09-01', value: 1 },
      ]),
    ).toThrow(ChartError);
    expect(() => stream.update({ time: '2026-08-31', value: 3 })).toThrow(ChartError);

    const data = stream.getData();
    data.macd[1] = { time: '2099-01-01', value: 99 };
    const returned = stream.update({ time: '2026-09-02', value: 3 });
    returned.macd = { time: '2099-01-02', value: 100 };
    expect(stream.getData()).toEqual(macd([input[0]!, { time: '2026-09-02', value: 3 }], options));
  });
});

describe('streaming Bollinger Bands', () => {
  it('matches batch through many bulk windows, a gap, and final-gap replacement', () => {
    const options = { period: 5, multiplier: 1.5 };
    const input: IndicatorPoint[] = Array.from({ length: 80 }, (_, index) =>
      index === 33 ? { time: index + 1 } : { time: index + 1, value: 1e12 + (((index * 17) % 23) - 11) / 8 },
    );
    input.push({ time: 81 });
    const stream = createBollingerBands(options);
    stream.setData(input);
    expect(stream.getData()).toEqual(bollingerBands(input, options));

    for (const replacement of [{ time: 81, value: 1e12 + 1 }, { time: 81 }, { time: 81, value: 1e12 - 1 }]) {
      stream.update(replacement);
      input[input.length - 1] = replacement;
      expect(stream.getData()).toEqual(bollingerBands(input, options));
    }
    stream.update({ time: 82, value: 1e12 + 2 });
    input.push({ time: 82, value: 1e12 + 2 });
    expect(stream.getData()).toEqual(bollingerBands(input, options));
  });

  it('preserves coercion order and nested setData during intermediate bulk arithmetic', () => {
    const options = { period: 2, multiplier: 1 };
    const stream = createBollingerBands(options);
    stream.setData(points([1, 3]));
    const events: string[] = [];
    let reads = 0;
    let nested = false;
    const coercible = {
      valueOf() {
        events.push('coerce');
        if (!nested) {
          nested = true;
          stream.setData(points([10, 20]));
        }
        return 4;
      },
    };
    stream.setData([
      {
        time: 1,
        get value() {
          reads += 1;
          events.push(`value:${reads}`);
          return reads < 3 ? 4 : (coercible as unknown as number);
        },
      },
      { time: 2, value: 6 },
      { time: 3, value: 8 },
    ]);
    expect(events).toEqual(['value:1', 'value:2', 'value:3', 'coerce', 'coerce']);
    const input = points([4, 6, 8]);
    expect(stream.getData()).toEqual(bollingerBands(input, options));
    stream.update({ time: 4, value: 10 });
    input.push({ time: 4, value: 10 });
    expect(stream.getData()).toEqual(bollingerBands(input, options));
    stream.update({ time: 4, value: 12 });
    input[input.length - 1] = { time: 4, value: 12 };
    expect(stream.getData()).toEqual(bollingerBands(input, options));
  });

  it('retains a nested update when intermediate coercion makes bulk setData fail', () => {
    const options = { period: 2, multiplier: 1 };
    const stream = createBollingerBands(options);
    const retained = points([1, 3]);
    stream.setData(retained);
    let reads = 0;
    let coercions = 0;
    const coercible = {
      valueOf() {
        coercions += 1;
        stream.update({ time: 3, value: 5 });
        throw new Error('coercion failure');
      },
    };
    expect(() =>
      stream.setData([
        {
          time: 1,
          get value() {
            reads += 1;
            return reads < 3 ? 4 : (coercible as unknown as number);
          },
        },
        { time: 2, value: 6 },
        { time: 3, value: 8 },
      ]),
    ).toThrow('coercion failure');
    expect(reads).toBe(3);
    expect(coercions).toBe(1);
    retained.push({ time: 3, value: 5 });
    expect(stream.getData()).toEqual(bollingerBands(retained, options));
    stream.update({ time: 4, value: 7 });
    retained.push({ time: 4, value: 7 });
    expect(stream.getData()).toEqual(bollingerBands(retained, options));
  });

  it('keeps returned point mutations isolated after a failed update and later replacement', () => {
    const options = { period: 2, multiplier: 2 };
    const stream = createBollingerBands(options);
    stream.setData(points([1, 3]));

    const appended = stream.update({ time: 3, value: 5 });
    appended.upper.time = 99;
    if ('value' in appended.upper) appended.upper.value = 99;
    expectCode(() => stream.update({ time: 4, value: Number.MAX_VALUE }), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(bollingerBands(points([1, 3, 5]), options));

    const replaced = stream.update({ time: 3, value: 7 });
    replaced.lower.time = 98;
    if ('value' in replaced.lower) replaced.lower.value = 98;
    expect(stream.getData()).toEqual(bollingerBands(points([1, 3, 7]), options));
  });

  it('matches batch through append and repeated tail replacements across a gap', () => {
    const options = { period: 3, multiplier: 2 };
    const input = points([1, 4, 2, 8, null, 10, 12, 14]);
    const stream = createBollingerBands(options);
    stream.setData(input.slice(0, -1));
    stream.update(input.at(-1)!);
    expect(stream.getData()).toEqual(bollingerBands(input, options));

    for (const replacement of [{ time: 8, value: 16 }, { time: 8 }, { time: 8, value: 18 }]) {
      stream.update(replacement);
      expect(stream.getData()).toEqual(bollingerBands([...input.slice(0, -1), replacement], options));
    }
  });

  it('rolls back numeric overflow after append and replacement and then recovers', () => {
    const options = { period: 2, multiplier: 2 };
    const max = Number.MAX_VALUE;
    const stream = createBollingerBands(options);
    stream.setData(points([max, max]));

    expectCode(() => stream.setData(points([max, max, -max])), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(bollingerBands(points([max, max]), options));
    expectCode(() => stream.update({ time: 3, value: -max }), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(bollingerBands(points([max, max]), options));
    expectCode(() => stream.update({ time: 2, value: -max }), 'INDICATOR_OVERFLOW');
    expect(stream.getData()).toEqual(bollingerBands(points([max, max]), options));
    stream.update({ time: 3, value: max });
    expect(stream.getData()).toEqual(bollingerBands(points([max, max, max]), options));
  });

  it('keeps setData atomic and copies options, inputs, outputs, and update results', () => {
    const options = { period: 2, multiplier: 1 };
    const input = points([1, 3]);
    const stream = createBollingerBands(options);
    stream.setData(input);
    options.multiplier = 10;
    input[1] = { time: 2, value: 99 };

    expect(() => stream.setData(points([1, Number.NaN]))).toThrow(ChartError);
    const data = stream.getData();
    data.upper[1] = { time: 99, value: 99 };
    const returned = stream.update({ time: 2, value: 5 });
    returned.lower = { time: 100, value: 100 };

    expect(stream.getData()).toEqual(bollingerBands(points([1, 5]), { period: 2, multiplier: 1 }));
  });
});

describe('review R1 exponent-safe Bollinger variance', () => {
  it('preserves representable bands at tiny and large centered magnitudes', () => {
    const tiny = bollingerBands(points([-1e-200, 1e-200]), { period: 2, multiplier: 1 });
    expect(tiny.middle[1]).toEqual({ time: 2, value: 0 });
    expect(tiny.upper[1]).toEqual({ time: 2, value: 1e-200 });
    expect(tiny.lower[1]).toEqual({ time: 2, value: -1e-200 });

    const large = bollingerBands(points([-1e200, 1e200]), { period: 2, multiplier: 1 });
    expect(large.middle[1]).toEqual({ time: 2, value: 0 });
    expect(large.upper[1]).toEqual({ time: 2, value: 1e200 });
    expect(large.lower[1]).toEqual({ time: 2, value: -1e200 });
  });

  it('supports representable extreme tail replacement and later valid replacement', () => {
    const options = { period: 2, multiplier: 1 };
    const stream = createBollingerBands(options);
    stream.setData(points([-1e200, 0]));

    expect(stream.update({ time: 2, value: 1e200 })).toEqual({
      middle: { time: 2, value: 0 },
      upper: { time: 2, value: 1e200 },
      lower: { time: 2, value: -1e200 },
    });
    stream.update({ time: 2, value: 0 });
    expect(stream.getData()).toEqual(bollingerBands(points([-1e200, 0]), options));
  });
});

describe('review R2 option snapshots', () => {
  it('reads Bollinger option accessors once and retains the validated values', () => {
    let periodReads = 0;
    let multiplierReads = 0;
    const options: BollingerBandsOptions = {
      get period() {
        periodReads += 1;
        if (periodReads > 1) throw new Error('period accessor was reread');
        return 2;
      },
      get multiplier() {
        multiplierReads += 1;
        return multiplierReads <= 3 ? 1 : -1;
      },
    };

    const stream = createBollingerBands(options);
    expect(periodReads).toBe(1);
    expect(multiplierReads).toBe(1);
    stream.setData(points([1, 3]));
    expect(stream.getData()).toEqual({
      middle: [{ time: 1 }, { time: 2, value: 2 }],
      upper: [{ time: 1 }, { time: 2, value: 3 }],
      lower: [{ time: 1 }, { time: 2, value: 1 }],
    });
  });

  it('reads coupled MACD option accessors once and validates the retained snapshot', () => {
    let fastReads = 0;
    let slowReads = 0;
    let signalReads = 0;
    const options: MacdOptions = {
      get fastPeriod() {
        fastReads += 1;
        return fastReads <= 2 ? 1 : 3;
      },
      get slowPeriod() {
        slowReads += 1;
        if (slowReads > 1) throw new Error('slowPeriod accessor was reread');
        return 2;
      },
      get signalPeriod() {
        signalReads += 1;
        return signalReads === 1 ? 1 : 0;
      },
    };

    const stream = createMacd(options);
    expect(fastReads).toBe(1);
    expect(slowReads).toBe(1);
    expect(signalReads).toBe(1);
    stream.setData(points([1, 3]));
    expect(stream.getData()).toEqual({
      macd: [{ time: 1 }, { time: 2, value: 1 }],
      signal: [{ time: 1 }, { time: 2, value: 1 }],
      histogram: [{ time: 1 }, { time: 2, value: 0 }],
    });
  });
});
