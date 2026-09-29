import { describe, expect, it } from 'vitest';
import { ChartError } from '@filtix/core';
import { createIndicator, ema, rsi, sma } from './index';
import { validatePoint } from './indicators';
import type { ValuePoint, WhitespacePoint } from '@filtix/core';

const values = (numbers: Array<number | null>): Array<ValuePoint | WhitespacePoint> =>
  numbers.map((value, index) => (value === null ? { time: index } : { time: index, value }));

describe('batch indicators', () => {
  it('computes SMA after a full period and preserves warmup timestamps', () => {
    expect(sma(values([1, 2, 3, 4]), 3)).toEqual([
      { time: 0 },
      { time: 1 },
      { time: 2, value: 2 },
      { time: 3, value: 3 },
    ]);
  });

  it('seeds EMA with the first full-period SMA', () => {
    expect(ema(values([1, 2, 3, 4, 5]), 3)).toEqual([
      { time: 0 },
      { time: 1 },
      { time: 2, value: 2 },
      { time: 3, value: 3 },
      { time: 4, value: 4 },
    ]);
  });

  it('uses Wilder RSI seeding and flat/up/down edge values', () => {
    expect(rsi(values([1, 1, 1, 1]), 2)).toEqual([
      { time: 0 },
      { time: 1 },
      { time: 2, value: 50 },
      { time: 3, value: 50 },
    ]);
    expect(rsi(values([1, 2, 3, 4]), 2).slice(2)).toEqual([
      { time: 2, value: 100 },
      { time: 3, value: 100 },
    ]);
    expect(rsi(values([4, 3, 2, 1]), 2).slice(2)).toEqual([
      { time: 2, value: 0 },
      { time: 3, value: 0 },
    ]);
  });

  it('emits whitespace and resets the contiguous window after a gap', () => {
    const input = values([1, 2, null, 3, 4, 5]);
    expect(sma(input, 2)).toEqual([
      { time: 0 },
      { time: 1, value: 1.5 },
      { time: 2 },
      { time: 3 },
      { time: 4, value: 3.5 },
      { time: 5, value: 4.5 },
    ]);
    expect(ema(input, 2)).toEqual([
      { time: 0 },
      { time: 1, value: 1.5 },
      { time: 2 },
      { time: 3 },
      { time: 4, value: 3.5 },
      { time: 5, value: 4.5 },
    ]);
    expect(rsi(input, 2)).toEqual([
      { time: 0 },
      { time: 1 },
      { time: 2 },
      { time: 3 },
      { time: 4 },
      { time: 5, value: 100 },
    ]);
  });

  it('rejects invalid periods, values, and out-of-order times atomically', () => {
    const input = values([1, 2, 3]);
    expect(() => sma(input, 0)).toThrow(ChartError);
    expect(() => ema(input, 1.5)).toThrow(ChartError);
    expect(() => rsi(input, 1)).toThrow(ChartError);
    expect(() => sma(values([1, Number.NaN]), 2)).toThrow(ChartError);
    expect(() =>
      sma(
        [
          { time: 1, value: 1 },
          { time: 1, value: 2 },
        ],
        2,
      ),
    ).toThrow(ChartError);

    const stream = createIndicator('sma', 2);
    stream.setData(values([1, 2]));
    expect(() => stream.setData(values([1, Number.POSITIVE_INFINITY]))).toThrow(ChartError);
    expect(stream.getData()).toEqual([{ time: 0 }, { time: 1, value: 1.5 }]);
  });

  it('returns copies of computed data', () => {
    const input = values([1, 2, 3]);
    const output = sma(input, 2);
    output[1] = { time: 100, value: 99 };
    expect(input).toEqual(values([1, 2, 3]));
    expect(sma(input, 2)[1]).toEqual({ time: 1, value: 1.5 });
  });
});

describe('streaming indicators', () => {
  it('preserves immediate and repeated tail replacement after empty, single, and gapped bulk data', () => {
    for (const kind of ['sma', 'ema', 'rsi'] as const) {
      const batch = (input: Array<ValuePoint | WhitespacePoint>) =>
        kind === 'sma' ? sma(input, 2) : kind === 'ema' ? ema(input, 2) : rsi(input, 2);
      const stream = createIndicator(kind, 2);
      stream.setData([]);
      expect(stream.getData()).toEqual([]);
      stream.update({ time: 0, value: 1 });
      stream.update({ time: 0, value: 2 });
      expect(stream.getData()).toEqual(batch([{ time: 0, value: 2 }]));

      stream.setData([{ time: 0, value: 1 }]);
      stream.update({ time: 0, value: 2 });
      expect(stream.getData()).toEqual(batch([{ time: 0, value: 2 }]));

      const prefix = values([1, 3, 5]);
      stream.setData([...prefix, { time: 3 }]);
      for (const tail of [{ time: 3, value: 7 }, { time: 3 }, { time: 3, value: 9 }]) {
        stream.update(tail);
        expect(stream.getData()).toEqual(batch([...prefix, tail]));
      }
      const extended = [...prefix, { time: 3, value: 9 }, { time: 4, value: 11 }, { time: 5, value: 13 }];
      stream.update(extended[4]!);
      stream.update(extended[5]!);
      expect(stream.getData()).toEqual(batch(extended));
    }
  });

  it('keeps a nested public update when later intermediate bulk arithmetic fails', () => {
    const stream = createIndicator('sma', 1);
    stream.setData([{ time: 0, value: 1 }]);
    let timeReads = 0;
    let valueReads = 0;
    expect(() =>
      stream.setData([
        {
          get time() {
            timeReads += 1;
            if (timeReads === 3) stream.update({ time: 1, value: 2 });
            return 0;
          },
          value: 10,
        },
        {
          time: 1,
          get value() {
            valueReads += 1;
            return valueReads >= 3 ? Number.NaN : 20;
          },
        },
        { time: 2, value: 30 },
      ]),
    ).toThrow(ChartError);
    expect(stream.getData()).toEqual([
      { time: 0, value: 1 },
      { time: 1, value: 2 },
    ]);
    stream.update({ time: 2, value: 3 });
    expect(stream.getData()).toEqual([
      { time: 0, value: 1 },
      { time: 1, value: 2 },
      { time: 2, value: 3 },
    ]);
  });

  it('creates own validation fields when a value getter installs inherited setters', () => {
    for (const field of ['point', 'key', 'value'] as const) {
      for (const path of ['validator', 'scalar'] as const) {
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
          if (path === 'validator') {
            actual = validatePoint(input, 'utc-ms');
          } else {
            const stream = createIndicator('sma', 1);
            stream.setData([input]);
            actual = stream.getData();
          }
        } catch (error) {
          thrown = error;
        } finally {
          if (previous === undefined) Reflect.deleteProperty(Object.prototype, field);
          else Object.defineProperty(Object.prototype, field, previous);
        }
        expect(thrown).toBeUndefined();
        expect(setterCalls).toBe(0);
        expect(reads).toBe(path === 'validator' ? 3 : 4);
        if (path === 'validator') {
          expect(actual).toEqual({ point: input, key: 0, value: 2 });
          expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
          for (const ownField of ['point', 'key', 'value']) {
            expect(Object.getOwnPropertyDescriptor(actual, ownField)).toMatchObject({
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        } else {
          expect(actual).toEqual([{ time: 0, value: 2 }]);
        }
      }
    }
  });

  it('uses final validated values and captured references from a growing input iterator', () => {
    const input: Array<ValuePoint | WhitespacePoint> = [];
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

    const stream = createIndicator('sma', 1);
    stream.setData(input);
    expect(stream.getData()).toEqual([
      { time: 0, value: 7 },
      { time: 1, value: 3 },
    ]);

    let failingReads = 0;
    expect(() =>
      stream.setData([
        {
          time: 0,
          get value() {
            failingReads += 1;
            return failingReads >= 3 ? Number.NaN : 1;
          },
        },
      ]),
    ).toThrow(ChartError);
    expect(stream.getData()).toEqual([
      { time: 0, value: 7 },
      { time: 1, value: 3 },
    ]);
  });

  it('reads all input validations before the scalar setData copy phase', () => {
    const reads: string[] = [];
    const observed = (name: string, time: number, value: number) =>
      new Proxy(
        { time, value },
        {
          has(target, key) {
            reads.push(`${name}:has:${String(key)}`);
            return Reflect.has(target, key);
          },
          get(target, key, receiver) {
            reads.push(`${name}:get:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        },
      );

    const stream = createIndicator('sma', 2);
    stream.setData([observed('first', 0, 1), observed('second', 1, 3)]);
    expect(reads).toEqual([
      'first:has:time',
      'first:get:time',
      'first:get:value',
      'first:get:value',
      'first:get:value',
      'second:has:time',
      'second:get:time',
      'second:get:value',
      'second:get:value',
      'second:get:value',
      'first:has:value',
      'first:get:time',
      'first:get:value',
      'first:get:time',
      'second:has:value',
      'second:get:time',
      'second:get:value',
      'second:get:time',
    ]);
    expect(stream.getData()).toEqual([{ time: 0 }, { time: 1, value: 2 }]);
  });

  it('leaves prior state intact when a scalar copy-phase getter throws', () => {
    const stream = createIndicator('sma', 1);
    stream.setData([{ time: 0, value: 1 }]);
    const failing = (time: number) => {
      let valueReads = 0;
      return {
        time,
        get value() {
          valueReads += 1;
          if (valueReads === 4) throw new Error('copy phase');
          return 3;
        },
      };
    };

    expect(() => stream.setData([failing(1)])).toThrow('copy phase');
    expect(stream.getData()).toEqual([{ time: 0, value: 1 }]);
    expect(() => stream.update(failing(1))).toThrow('copy phase');
    expect(stream.getData()).toEqual([{ time: 0, value: 1 }]);
  });

  it('keeps nested setData and update effects at their original clone-phase boundaries', () => {
    const stream = createIndicator('sma', 1);
    stream.setData([{ time: 0, value: 1 }]);
    let outerSetTimeReads = 0;
    stream.setData([
      {
        get time() {
          outerSetTimeReads += 1;
          if (outerSetTimeReads === 2) {
            expect(stream.update({ time: 1, value: 2 })).toEqual({ time: 1, value: 2 });
          }
          return 0;
        },
        value: 10,
      },
    ]);
    expect(stream.getData()).toEqual([{ time: 0, value: 10 }]);

    stream.setData([
      { time: 0, value: 1 },
      { time: 1, value: 2 },
    ]);
    let outerUpdateTimeReads = 0;
    expect(
      stream.update({
        get time() {
          outerUpdateTimeReads += 1;
          if (outerUpdateTimeReads === 2) {
            stream.setData([
              { time: 0, value: 10 },
              { time: 1, value: 20 },
              { time: 2, value: 30 },
            ]);
          }
          return 1;
        },
        value: 5,
      }),
    ).toEqual({ time: 1, value: 5 });
    expect(stream.getData()).toEqual([
      { time: 0, value: 10 },
      { time: 1, value: 20 },
      { time: 1, value: 5 },
    ]);
  });

  it('keeps the latest key after an append time getter replaces the published data', () => {
    const stream = createIndicator('sma', 2);
    stream.setData([{ time: 0, value: 1 }]);
    let reads = 0;
    expect(
      stream.update({
        get time() {
          reads += 1;
          if (reads === 3)
            stream.setData([
              { time: 0, value: 10 },
              { time: 1, value: 20 },
            ]);
          return 2;
        },
        value: 5,
      }),
    ).toEqual({ time: 2, value: 3 });
    expect(reads).toBe(3);
    expect(stream.getData()).toEqual([{ time: 0 }, { time: 1, value: 15 }, { time: 2, value: 3 }]);
    expect(stream.update({ time: 3, value: 7 })).toEqual({ time: 3, value: 13.5 });
    expect(stream.update({ time: 3, value: 8 })).toEqual({ time: 3, value: 14 });
    expect(stream.getData().at(-1)).toEqual({ time: 3, value: 14 });
  });

  it('matches batch EMA when replacing the newest point repeatedly', () => {
    const stream = createIndicator('ema', 3);
    stream.setData(values([1, 2, 3]));
    expect(stream.update({ time: 2, value: 6 })).toEqual({ time: 2, value: 3 });
    expect(stream.update({ time: 2, value: 9 })).toEqual({ time: 2, value: 4 });
    expect(stream.getData()).toEqual(ema(values([1, 2, 9]), 3));
  });

  it('matches batch RSI after appends, replacements, and gaps', () => {
    const stream = createIndicator('rsi', 2);
    const input = values([1, 2, 3, null, 4, 5, 4]);
    stream.setData(input.slice(0, 3));
    for (const point of input.slice(3)) stream.update(point);
    expect(stream.getData()).toEqual(rsi(input, 2));
    stream.update({ time: 6, value: 8 });
    expect(stream.getData()).toEqual(rsi([...input.slice(0, -1), { time: 6, value: 8 }], 2));
    stream.update({ time: 6, value: 2 });
    expect(stream.getData()).toEqual(rsi([...input.slice(0, -1), { time: 6, value: 2 }], 2));
  });
});

describe('streaming SMA rollback', () => {
  it('matches batch output after repeated tail replacement across a gap', () => {
    const stream = createIndicator('sma', 3);
    const input = values([1, 2, 3, 4, 5, null, 6, 7, 8]);
    stream.setData(input);
    for (const replacement of [9, 10, 11, 12]) {
      stream.update({ time: 8, value: replacement });
      expect(stream.getData()).toEqual(sma([...input.slice(0, -1), { time: 8, value: replacement }], 3));
    }
  });

  it('supports business-date time validation on the streaming API', () => {
    const stream = createIndicator('ema', 2, 'business-date');
    stream.setData([
      { time: '2024-01-02', value: 2 },
      { time: '2024-01-03', value: 4 },
    ]);
    expect(stream.getData()).toEqual([{ time: '2024-01-02' }, { time: '2024-01-03', value: 3 }]);
    expect(() => stream.update({ time: '2024-01-01', value: 5 })).toThrow(ChartError);
  });
});

describe('review regressions', () => {
  it('infers the homogeneous batch time domain from the first timestamp', () => {
    const input = [
      { time: '2024-01-02', value: 10 },
      { time: '2024-01-03', value: 20 },
      { time: '2024-01-04', value: 30 },
    ];
    expect(sma(input, 2)).toEqual([
      { time: '2024-01-02' },
      { time: '2024-01-03', value: 15 },
      { time: '2024-01-04', value: 25 },
    ]);
    expect(ema(input, 2)).toEqual([
      { time: '2024-01-02' },
      { time: '2024-01-03', value: 15 },
      { time: '2024-01-04', value: 25 },
    ]);
    expect(rsi(input, 2)).toEqual([
      { time: '2024-01-02' },
      { time: '2024-01-03' },
      { time: '2024-01-04', value: 100 },
    ]);
    expect(() =>
      sma(
        [
          { time: '2024-01-02', value: 10 },
          { time: 1, value: 20 },
        ],
        2,
      ),
    ).toThrow(ChartError);
  });

  it('keeps representable MAX_VALUE averages finite and rejects unsupported RSI overflow atomically', () => {
    const max = Number.MAX_VALUE;
    const pair = [
      { time: 0, value: max },
      { time: 1, value: max },
    ];
    expect(sma(pair, 2)).toEqual([{ time: 0 }, { time: 1, value: max }]);
    expect(ema(pair, 2)).toEqual([{ time: 0 }, { time: 1, value: max }]);

    const stream = createIndicator('rsi', 2);
    stream.setData([
      { time: 0, value: 0 },
      { time: 1, value: max },
    ]);
    expect(() => stream.update({ time: 2, value: -max })).toThrow(ChartError);
    expect(stream.getData()).toEqual([{ time: 0 }, { time: 1 }]);
    stream.update({ time: 2, value: 0 });
    expect(stream.getData()).toEqual(
      rsi(
        [
          { time: 0, value: 0 },
          { time: 1, value: max },
          { time: 2, value: 0 },
        ],
        2,
      ),
    );
  });
});

describe('streaming setData arithmetic atomicity', () => {
  it('keeps prior calculator state after an unsupported overflow in replacement data', () => {
    const max = Number.MAX_VALUE;
    const stream = createIndicator('rsi', 2);
    stream.setData([
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ]);
    expect(() =>
      stream.setData([
        { time: 0, value: 0 },
        { time: 1, value: max },
        { time: 2, value: -max },
      ]),
    ).toThrow(ChartError);
    expect(stream.getData()).toEqual([{ time: 0 }, { time: 1 }]);
    stream.update({ time: 2, value: 2 });
    expect(stream.getData()).toEqual(
      rsi(
        [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
          { time: 2, value: 2 },
        ],
        2,
      ),
    );
  });
});

describe('streaming replacement rollback', () => {
  it('restores committed RSI state after an overflowing tail replacement', () => {
    const max = Number.MAX_VALUE;
    const initial = [
      { time: 0, value: 0 },
      { time: 1, value: max },
      { time: 2, value: max / 2 },
    ];
    const stream = createIndicator('rsi', 2);
    stream.setData(initial);
    expect(() => stream.update({ time: 2, value: -max })).toThrow(ChartError);
    expect(() => stream.update({ time: 2, value: -max })).toThrow(ChartError);
    expect(stream.getData()).toEqual(rsi(initial, 2));
    stream.update({ time: 3, value: max });
    expect(stream.getData()).toEqual(rsi([...initial, { time: 3, value: max }], 2));
    stream.update({ time: 3, value: 0 });
    expect(stream.getData()).toEqual(rsi([...initial, { time: 3, value: 0 }], 2));
  });
});
