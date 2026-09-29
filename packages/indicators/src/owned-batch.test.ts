import { describe, expect, it, vi } from 'vitest';
import { ChartError } from '@filtix/core';
import * as preparation from './internal';
import { BollingerCalculator } from './bollinger';
import { IndicatorCalculator, type IndicatorPoint } from './indicators';
import { MacdCalculator } from './macd';
import type { PreparationRequest } from './internal';

type Column = { values: Float64Array; present: Uint8Array };
type OwnedResult = {
  points: readonly IndicatorPoint[];
  studies: Array<{
    kind: string;
    outputs: Record<string, Column>;
    controller: { update(point: IndicatorPoint): unknown; reset(): void };
  }>;
};
const owned = (
  preparation as unknown as {
    prepareOwnedBatch: (
      requests: Iterable<PreparationRequest>,
      points: readonly IndicatorPoint[],
      domain: 'utc-ms',
    ) => OwnedResult;
  }
).prepareOwnedBatch;

const requests: PreparationRequest[] = [
  { kind: 'sma', period: 3 },
  { kind: 'ema', period: 8 },
  { kind: 'rsi', period: 14 },
  { kind: 'macd', options: { fastPeriod: 3, slowPeriod: 6, signalPeriod: 3 } },
  { kind: 'bollinger', options: { period: 5, multiplier: 2 } },
  { kind: 'macd', options: { fastPeriod: 3, slowPeriod: 6, signalPeriod: 3 } },
  { kind: 'bollinger', options: { period: 5, multiplier: 2 } },
];
const names = (kind: string) =>
  kind === 'macd'
    ? ['macd', 'signal', 'histogram']
    : kind === 'bollinger'
      ? ['middle', 'upper', 'lower']
      : ['value'];
const points = (length: number, mode: 'dense' | 'gaps' | 'final-gap'): IndicatorPoint[] =>
  Array.from({ length }, (_, time) =>
    (mode === 'gaps' && (time === 7 || time === 27)) || (mode === 'final-gap' && time === length - 1)
      ? { time }
      : { time, value: time === 0 ? -0 : 50 + Math.sin(time / 3) * 2 + time / 17 },
  );

function compareColumns(actual: OwnedResult, input: readonly IndicatorPoint[]): void {
  const expected = preparation.prepareBatch(requests, input, 'utc-ms');
  expect(actual.points).toBe(input);
  expect(actual.studies).toHaveLength(expected.length);
  for (let study = 0; study < expected.length; study++) {
    const got = actual.studies[study]!;
    const old = expected[study]!;
    expect(got.kind).toBe(old.kind);
    expect(Object.keys(got.outputs)).toEqual(names(old.kind));
    for (const name of names(old.kind)) {
      const column = got.outputs[name]!;
      const rows = Array.isArray(old.prepared.data)
        ? old.prepared.data
        : (old.prepared.data as unknown as Record<string, IndicatorPoint[]>)[name]!;
      expect(column.values).toBeInstanceOf(Float64Array);
      expect(column.present).toBeInstanceOf(Uint8Array);
      expect(column.values).toHaveLength(rows.length);
      expect(column.present).toHaveLength(rows.length);
      for (let row = 0; row < rows.length; row++) {
        const expectedPoint = rows[row]!;
        const present = Object.prototype.hasOwnProperty.call(expectedPoint, 'value');
        expect(column.present[row]).toBe(present ? 1 : 0);
        if (present)
          expect(Object.is(column.values[row], (expectedPoint as { value: number }).value)).toBe(true);
      }
    }
  }
}

function outcome(work: () => unknown): unknown {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    const failure = error as ChartError;
    return { ok: false, code: failure.code, message: failure.message };
  }
}

describe('operation-owned default UTC indicator columns', () => {
  it('exposes the private batch only on the internal entry', () => {
    expect(typeof owned).toBe('function');
  });

  it('preserves named values, signed zero, whitespace and independent duplicate studies', () => {
    for (const length of [0, 1, 2, 4, 5, 6, 19, 36, 64])
      for (const mode of ['dense', 'gaps', 'final-gap'] as const) {
        const input = points(length, mode);
        const batch = owned(requests, input, 'utc-ms');
        compareColumns(batch, input);
        const first = batch.studies[3]!.outputs.macd!;
        const duplicate = batch.studies[5]!.outputs.macd!;
        expect(first.values).not.toBe(duplicate.values);
        const before = duplicate.values[0];
        if (first.values.length > 0) first.values[0] = 123;
        expect(Object.is(duplicate.values[0], before)).toBe(true);
      }
  });

  it('keeps final-tail replacement, append, reset and staged-column ownership', () => {
    for (const mode of ['dense', 'gaps', 'final-gap'] as const) {
      const input = points(36, mode);
      const batch = owned(requests, input, 'utc-ms');
      const old = preparation.prepareBatch(requests, input, 'utc-ms');
      const frozen = batch.studies.map((study) =>
        Object.fromEntries(
          Object.entries(study.outputs).map(([key, column]) => [
            key,
            { values: column.values.slice(), present: column.present.slice() },
          ]),
        ),
      );
      for (const tail of [
        { time: 35, value: -0 },
        { time: 35 },
        { time: 35, value: 42 },
        { time: 36, value: 7 },
      ])
        for (let study = 0; study < old.length; study++)
          expect(outcome(() => batch.studies[study]!.controller.update(tail))).toEqual(
            outcome(() => old[study]!.prepared.controller.update(tail)),
          );
      for (let study = 0; study < batch.studies.length; study++)
        for (const [key, saved] of Object.entries(frozen[study]!)) {
          expect(batch.studies[study]!.outputs[key]!.values).toEqual(saved.values);
          expect(batch.studies[study]!.outputs[key]!.present).toEqual(saved.present);
        }
      batch.studies[3]!.outputs.macd!.values.fill(999);
      expect(outcome(() => batch.studies[3]!.controller.update({ time: 36, value: 9 }))).toEqual(
        outcome(() => old[3]!.prepared.controller.update({ time: 36, value: 9 })),
      );
      batch.studies[3]!.controller.reset();
      old[3]!.prepared.controller.reset();
      expect(batch.studies[3]!.controller.update({ time: 0, value: 1 })).toEqual(
        old[3]!.prepared.controller.update({ time: 0, value: 1 }),
      );
    }
  });

  it('preserves actual MACD/Bollinger overflow and first-math-before-later-options precedence', () => {
    const max = Number.MAX_VALUE;
    const failures: Array<[PreparationRequest, number[]]> = [
      [
        { kind: 'macd', options: { fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 } },
        [max, max, max, max, -max],
      ],
      [
        { kind: 'macd', options: { fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 } },
        [max, max, max, max, -max, max],
      ],
      [{ kind: 'bollinger', options: { period: 2, multiplier: 2 } }, [max, max, -max]],
      [{ kind: 'bollinger', options: { period: 2, multiplier: 2 } }, [max, max, -max, max]],
    ];
    for (const [request, values] of failures) {
      const input = values.map((value, time) => ({ time, value }));
      const expected = outcome(() => preparation.prepareBatch([request], input, 'utc-ms'));
      expect(expected).toMatchObject({ ok: false, code: 'INDICATOR_OVERFLOW' });
      expect(outcome(() => owned([request], input, 'utc-ms'))).toEqual(expected);
      const recovered = points(8, 'dense');
      const batch = owned([request], recovered, 'utc-ms');
      expect(batch.studies).toHaveLength(1);
    }
    const first = failures[0]![0];
    const input = failures[0]![1].map((value, time) => ({ time, value }));
    const requestsWithInvalidLate: PreparationRequest[] = [
      first,
      { kind: 'bollinger', options: { period: 2, multiplier: 0 } },
    ];
    expect(outcome(() => owned(requestsWithInvalidLate, input, 'utc-ms'))).toEqual(
      outcome(() => preparation.prepareBatch(requestsWithInvalidLate, input, 'utc-ms')),
    );
  });

  it('retains public arbitrary-iterator/getter behavior and rejects private calendar input', () => {
    const input = [
      { time: 0, value: 1 },
      { time: 1, value: 2 },
    ];
    const events: string[] = [];
    function* arbitrary(): Iterable<PreparationRequest> {
      events.push('first');
      yield { kind: 'sma', period: 2 };
      events.push('second');
      input[0]!.value = 9;
      yield { kind: 'ema', period: 2 };
    }
    expect(preparation.prepareBatch(arbitrary(), input).map((study) => study.prepared.data)).toEqual([
      [{ time: 0 }, { time: 1, value: 1.5 }],
      [{ time: 0 }, { time: 1, value: 1.5 }],
    ]);
    expect(events).toEqual(['first', 'second']);
    expect(
      outcome(() => owned([], [{ time: '2024-01-01', value: 1 }], 'business-date' as 'utc-ms')),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_TIME_DOMAIN',
    });
  });

  it('removes intermediate public point/group results while retaining final-row push and counting staging capacity', () => {
    const scalar = vi.spyOn(IndicatorCalculator.prototype, 'push');
    const macd = vi.spyOn(MacdCalculator.prototype, 'push');
    const bollinger = vi.spyOn(BollingerCalculator.prototype, 'push');
    try {
      const input = points(1000, 'dense');
      const batch = owned(requests.slice(0, 5), input, 'utc-ms');
      expect(scalar).toHaveBeenCalledTimes(3);
      expect(macd).toHaveBeenCalledTimes(1);
      expect(bollinger).toHaveBeenCalledTimes(1);
      const columns = batch.studies.flatMap((study) => Object.values(study.outputs));
      expect(columns).toHaveLength(9);
      expect(columns.reduce((sum, column) => sum + column.values.length + column.present.length, 0)).toBe(
        18_000,
      );
      expect(columns.every((column) => column.present.every((value) => value === 0 || value === 1))).toBe(
        true,
      );
    } finally {
      scalar.mockRestore();
      macd.mockRestore();
      bollinger.mockRestore();
    }
  });
});
