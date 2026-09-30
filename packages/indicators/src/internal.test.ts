import { describe, expect, it } from 'vitest';
import { ChartError, type TimeDomain } from '@filtrix.net/core';
import { createBollingerBands, createIndicator, createMacd, type IndicatorPoint } from './index';
import {
  prepareBatch,
  prepareBollinger,
  prepareMacd,
  prepareScalar,
  type PreparationRequest,
} from './internal';

const history = (domain: TimeDomain): IndicatorPoint[] => {
  const times =
    domain === 'business-date'
      ? ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08']
      : [0, 1, 2, 3, 4];
  return [
    { time: times[0]!, value: 2 },
    { time: times[1]!, value: 4 },
    { time: times[2]! },
    { time: times[3]!, value: 8 },
    { time: times[4]! },
  ];
};

const laterTime = (domain: TimeDomain) => (domain === 'business-date' ? '2024-01-09' : 5);

function damagePoint(point: IndicatorPoint): void {
  (point as { time: number }).time = -999;
  (point as { value: number }).value = 999;
}

function damageNamed(data: Record<string, IndicatorPoint[]>): void {
  for (const key of Object.keys(data)) {
    const array = data[key]!;
    for (const point of array) damagePoint(point);
    if (array.length > 0) array[0] = { time: -999, value: 999 };
    array.push({ time: -998, value: 998 });
    data[key] = [{ time: -997, value: 997 }];
  }
}

describe('private prepared indicator outputs', () => {
  it('establishes a replaceable final tail for empty and singleton preparations', () => {
    const initial = { time: 0, value: 2 };
    const replacement = { time: 0, value: 4 };
    const scalarEmpty = prepareScalar('ema', 2, []);
    const macdOptions = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 };
    const bollingerOptions = { period: 2, multiplier: 2 };
    const macdEmpty = prepareMacd(macdOptions, []);
    const bollingerEmpty = prepareBollinger(bollingerOptions, []);
    expect(scalarEmpty.data).toEqual([]);
    expect(macdEmpty.data).toEqual({ macd: [], signal: [], histogram: [] });
    expect(bollingerEmpty.data).toEqual({ middle: [], upper: [], lower: [] });
    expect(scalarEmpty.controller.update(initial)).toEqual(createIndicator('ema', 2).update(initial));
    expect(macdEmpty.controller.update(initial)).toEqual(createMacd(macdOptions).update(initial));
    expect(bollingerEmpty.controller.update(initial)).toEqual(
      createBollingerBands(bollingerOptions).update(initial),
    );

    const scalar = prepareScalar('ema', 2, [initial]);
    const macd = prepareMacd(macdOptions, [initial]);
    const bollinger = prepareBollinger(bollingerOptions, [initial]);
    const publicScalar = createIndicator('ema', 2);
    const publicMacd = createMacd(macdOptions);
    const publicBollinger = createBollingerBands(bollingerOptions);
    publicScalar.setData([initial]);
    publicMacd.setData([initial]);
    publicBollinger.setData([initial]);
    expect(scalar.controller.update(replacement)).toEqual(publicScalar.update(replacement));
    expect(macd.controller.update(replacement)).toEqual(publicMacd.update(replacement));
    expect(bollinger.controller.update(replacement)).toEqual(publicBollinger.update(replacement));
  });

  it.each(['utc-ms', 'business-date'] as const)(
    'matches public scalar streams through gaps, final-gap replacement, append, and reset in %s',
    (domain) => {
      for (const kind of ['sma', 'ema', 'rsi'] as const) {
        const points = history(domain);
        const prepared = prepareScalar(kind, 2, points, domain);
        const publicStream = createIndicator(kind, 2, domain);
        publicStream.setData(points);
        expect(prepared.data).toEqual(publicStream.getData());

        for (const tail of [
          { time: points[4]!.time, value: 10 },
          { time: points[4]!.time },
          { time: points[4]!.time, value: 12 },
          { time: laterTime(domain), value: 14 },
        ]) {
          expect(prepared.controller.update(tail)).toEqual(publicStream.update(tail));
        }
        expect(() => prepared.controller.update({ time: points[1]!.time, value: 1 })).toThrow(ChartError);
        const next = { time: domain === 'business-date' ? '2024-01-10' : 6, value: 16 };
        expect(prepared.controller.update(next)).toEqual(publicStream.update(next));

        prepared.controller.reset();
        const empty = createIndicator(kind, 2, domain);
        expect(prepared.controller.update({ time: points[0]!.time, value: 5 })).toEqual(
          empty.update({ time: points[0]!.time, value: 5 }),
        );
      }
    },
  );

  it.each(['utc-ms', 'business-date'] as const)(
    'matches public MACD and Bollinger streams through gaps, replacement, append, and reset in %s',
    (domain) => {
      const points = history(domain);
      const macdOptions = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 2 };
      const bollingerOptions = { period: 2, multiplier: 2 };
      const preparedMacd = prepareMacd(macdOptions, points, domain);
      const publicMacd = createMacd(macdOptions, domain);
      publicMacd.setData(points);
      expect(preparedMacd.data).toEqual(publicMacd.getData());
      const preparedBollinger = prepareBollinger(bollingerOptions, points, domain);
      const publicBollinger = createBollingerBands(bollingerOptions, domain);
      publicBollinger.setData(points);
      expect(preparedBollinger.data).toEqual(publicBollinger.getData());

      for (const tail of [
        { time: points[4]!.time, value: 10 },
        { time: points[4]!.time },
        { time: points[4]!.time, value: 12 },
        { time: laterTime(domain), value: 14 },
      ]) {
        expect(preparedMacd.controller.update(tail)).toEqual(publicMacd.update(tail));
        expect(preparedBollinger.controller.update(tail)).toEqual(publicBollinger.update(tail));
      }
      expect(() => preparedMacd.controller.update({ time: points[1]!.time, value: 1 })).toThrow(ChartError);
      expect(() => preparedBollinger.controller.update({ time: points[1]!.time, value: 1 })).toThrow(
        ChartError,
      );
      const next = { time: domain === 'business-date' ? '2024-01-10' : 6, value: 16 };
      expect(preparedMacd.controller.update(next)).toEqual(publicMacd.update(next));
      expect(preparedBollinger.controller.update(next)).toEqual(publicBollinger.update(next));

      preparedMacd.controller.reset();
      preparedBollinger.controller.reset();
      const emptyMacd = createMacd(macdOptions, domain);
      const emptyBollinger = createBollingerBands(bollingerOptions, domain);
      const fresh = { time: points[0]!.time, value: 5 };
      expect(preparedMacd.controller.update(fresh)).toEqual(emptyMacd.update(fresh));
      expect(preparedBollinger.controller.update(fresh)).toEqual(emptyBollinger.update(fresh));
    },
  );

  it('permanently transfers scalar arrays and points without reading them on later updates', () => {
    const prepared = prepareScalar('sma', 2, [
      { time: 0, value: 1 },
      { time: 1, value: 3 },
    ]);
    const publicStream = createIndicator('sma', 2);
    publicStream.setData([
      { time: 0, value: 1 },
      { time: 1, value: 3 },
    ]);
    damagePoint(prepared.data[1]!);
    prepared.data[0] = { time: 100, value: 100 };
    prepared.data.push({ time: 200, value: 200 });
    const first = prepared.controller.update({ time: 2, value: 5 });
    expect(first).toEqual(publicStream.update({ time: 2, value: 5 }));
    damagePoint(first);
    expect(prepared.controller.update({ time: 2, value: 7 })).toEqual(
      publicStream.update({ time: 2, value: 7 }),
    );
    expect(prepared.controller.update({ time: 3, value: 9 })).toEqual(
      publicStream.update({ time: 3, value: 9 }),
    );
  });

  it('permanently transfers every MACD and Bollinger array, point, and named result object', () => {
    const points = [
      { time: 0, value: 1 },
      { time: 1, value: 3 },
      { time: 2, value: 5 },
    ];
    const macdOptions = { fastPeriod: 1, slowPeriod: 2, signalPeriod: 2 };
    const bollingerOptions = { period: 2, multiplier: 2 };
    const preparedMacd = prepareMacd(macdOptions, points);
    const publicMacd = createMacd(macdOptions);
    publicMacd.setData(points);
    const preparedBollinger = prepareBollinger(bollingerOptions, points);
    const publicBollinger = createBollingerBands(bollingerOptions);
    publicBollinger.setData(points);
    damageNamed(preparedMacd.data as unknown as Record<string, IndicatorPoint[]>);
    damageNamed(preparedBollinger.data as unknown as Record<string, IndicatorPoint[]>);

    const macdUpdate = preparedMacd.controller.update({ time: 3, value: 7 });
    const bollingerUpdate = preparedBollinger.controller.update({ time: 3, value: 7 });
    expect(macdUpdate).toEqual(publicMacd.update({ time: 3, value: 7 }));
    expect(bollingerUpdate).toEqual(publicBollinger.update({ time: 3, value: 7 }));
    for (const result of [macdUpdate, bollingerUpdate]) {
      for (const value of Object.values(result)) damagePoint(value);
      (result as unknown as Record<string, IndicatorPoint>).polluted = { time: -1, value: 999 };
    }
    expect(preparedMacd.controller.update({ time: 3, value: 9 })).toEqual(
      publicMacd.update({ time: 3, value: 9 }),
    );
    expect(preparedBollinger.controller.update({ time: 3, value: 9 })).toEqual(
      publicBollinger.update({ time: 3, value: 9 }),
    );
  });

  it('validates complete histories before math and rejects malformed options and ordering', () => {
    const invalid: IndicatorPoint[] = [
      { time: 0, value: Number.MAX_VALUE },
      { time: 1, value: -Number.MAX_VALUE },
      { time: 2, value: Number.NaN },
    ];
    for (const prepare of [
      () => prepareScalar('rsi', 2, invalid),
      () => prepareMacd({ fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 }, invalid),
      () => prepareBollinger({ period: 2, multiplier: 2 }, invalid),
    ]) {
      expect(prepare).toThrowError(ChartError);
      try {
        prepare();
      } catch (error) {
        expect((error as ChartError).code).toBe('INVALID_VALUE');
      }
    }
    expect(() => prepareScalar('sma', 0, [])).toThrow(ChartError);
    expect(() => prepareMacd({ fastPeriod: 2, slowPeriod: 1, signalPeriod: 1 }, [])).toThrow(ChartError);
    expect(() => prepareBollinger({ period: 1, multiplier: 2 }, [])).toThrow(ChartError);
    expect(() => prepareScalar('ema', 2, [{ time: 1 }, { time: 1 }])).toThrow(ChartError);
  });

  it('uses captured validated values during scalar, MACD, and Bollinger bulk calculation', () => {
    for (const prepare of [
      (points: IndicatorPoint[]) => prepareScalar('sma', 2, points),
      (points: IndicatorPoint[]) => prepareMacd({ fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 }, points),
      (points: IndicatorPoint[]) => prepareBollinger({ period: 2, multiplier: 2 }, points),
    ]) {
      let reads = 0;
      const points: IndicatorPoint[] = [
        {
          time: 0,
          get value() {
            reads += 1;
            if (reads > 3) throw new Error('value reread after validation');
            return 2;
          },
        },
        { time: 1, value: 4 },
      ];
      expect(prepare(points).data).toBeDefined();
      expect(reads).toBe(3);
    }
  });

  it('recovers calculator state after deterministic update arithmetic failure', () => {
    const max = Number.MAX_VALUE;
    const initial = [
      { time: 0, value: 0 },
      { time: 1, value: max },
      { time: 2, value: max / 2 },
    ];
    const prepared = prepareScalar('rsi', 2, initial);
    const publicStream = createIndicator('rsi', 2);
    publicStream.setData(initial);
    expect(() => prepared.controller.update({ time: 2, value: -max })).toThrow(ChartError);
    expect(prepared.controller.update({ time: 2, value: max })).toEqual(
      publicStream.update({ time: 2, value: max }),
    );
    expect(() => prepared.controller.update({ time: 3, value: -max })).toThrow(ChartError);
    expect(prepared.controller.update({ time: 3, value: 0 })).toEqual(
      publicStream.update({ time: 3, value: 0 }),
    );
  });

  it('recovers MACD and Bollinger state after append and replacement overflow', () => {
    const max = Number.MAX_VALUE;
    const macdOptions = { fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 };
    const macdInput = [0, 1, 2, 3].map((time) => ({ time, value: max }));
    const preparedMacd = prepareMacd(macdOptions, macdInput);
    const publicMacd = createMacd(macdOptions);
    publicMacd.setData(macdInput);
    expect(() => preparedMacd.controller.update({ time: 3, value: -max })).toThrow(ChartError);
    expect(() => preparedMacd.controller.update({ time: 5, value: -max })).toThrow(ChartError);
    expect(preparedMacd.controller.update({ time: 5, value: max })).toEqual(
      publicMacd.update({ time: 5, value: max }),
    );

    const bollingerOptions = { period: 2, multiplier: 2 };
    const bollingerInput = [0, 1].map((time) => ({ time, value: max }));
    const preparedBollinger = prepareBollinger(bollingerOptions, bollingerInput);
    const publicBollinger = createBollingerBands(bollingerOptions);
    publicBollinger.setData(bollingerInput);
    expect(() => preparedBollinger.controller.update({ time: 1, value: -max })).toThrow(ChartError);
    expect(() => preparedBollinger.controller.update({ time: 3, value: -max })).toThrow(ChartError);
    expect(preparedBollinger.controller.update({ time: 3, value: max })).toEqual(
      publicBollinger.update({ time: 3, value: max }),
    );
  });
});

const batchRequests: PreparationRequest[] = [
  { kind: 'sma', period: 200 },
  { kind: 'ema', period: 20 },
  { kind: 'rsi', period: 14 },
  { kind: 'macd', options: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  { kind: 'bollinger', options: { period: 20, multiplier: 2 } },
  { kind: 'sma', period: 200 },
];

function separatePreparation(
  request: PreparationRequest,
  points: IndicatorPoint[],
  domain: TimeDomain = 'utc-ms',
) {
  if (request.kind === 'macd') return prepareMacd(request.options, points, domain);
  if (request.kind === 'bollinger') return prepareBollinger(request.options, points, domain);
  return prepareScalar(request.kind, request.period, points, domain);
}

function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    return {
      name: (error as Error).name,
      message: (error as Error).message,
      code: (error as ChartError).code,
    };
  }
}

describe('default rebuild preparation batch', () => {
  it.each(['utc-ms', 'business-date'] as const)(
    'matches separate full replay, prepend, tail gaps and reset in %s',
    (domain) => {
      const times = Array.from({ length: 260 }, (_, i) =>
        domain === 'utc-ms' ? i : new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
      );
      const all: IndicatorPoint[] = times
        .slice(0, 256)
        .map((time, i) =>
          i === 255 || i === 17 ? { time } : { time, value: 500 + Math.sin(i / 3) * 20 + i / 11 },
        );
      // Each prefix extension is a full chronological replay, including prepended history.
      for (const start of [220, 128, 0]) {
        const points = all.slice(start);
        const batch = prepareBatch(batchRequests, points, domain);
        const separate = batchRequests.map((request) => separatePreparation(request, points, domain));
        expect(batch.map((result) => result.prepared.data)).toEqual(separate.map((result) => result.data));
        expect(batch[0]!.prepared.data).not.toBe(batch[5]!.prepared.data);
        for (const point of [
          { time: times[255]!, value: 620 },
          { time: times[255]! },
          { time: times[255]!, value: 610 },
          { time: times[256]!, value: 630 },
          { time: times[256]!, value: 625 },
        ])
          for (let index = 0; index < batch.length; index++) {
            expect(batch[index]!.prepared.controller.update(point)).toEqual(
              separate[index]!.controller.update(point),
            );
          }
        for (let index = 0; index < batch.length; index++) {
          expect(() => batch[index]!.prepared.controller.update({ time: times[0]!, value: 1 })).toThrow(
            ChartError,
          );
          expect(batch[index]!.prepared.controller.update({ time: times[257]!, value: 640 })).toEqual(
            separate[index]!.controller.update({ time: times[257]!, value: 640 }),
          );
          batch[index]!.prepared.controller.reset();
          separate[index]!.controller.reset();
          expect(batch[index]!.prepared.controller.update({ time: times[0]!, value: 5 })).toEqual(
            separate[index]!.controller.update({ time: times[0]!, value: 5 }),
          );
        }
      }
    },
  );

  it('does not retain source history or share outputs/controllers across duplicate studies', () => {
    const points = Array.from({ length: 256 }, (_, time) => ({ time, value: time + 1 }));
    const batch = prepareBatch(batchRequests, points);
    const separate = batchRequests.map((request) => separatePreparation(request, points));
    for (const point of points) damagePoint(point);
    points.length = 0;
    for (const result of batch) {
      if (Array.isArray(result.prepared.data)) {
        for (const point of result.prepared.data) damagePoint(point);
        result.prepared.data.length = 0;
      } else damageNamed(result.prepared.data as unknown as Record<string, IndicatorPoint[]>);
    }
    for (let index = 0; index < batch.length; index++) {
      // Distinct advances, including same-period duplicates, expose calculator aliasing.
      const point = { time: 256 + index, value: 10 + index };
      expect(batch[index]!.prepared.controller.update(point)).toEqual(
        separate[index]!.controller.update(point),
      );
      expect(batch[index]!.prepared.controller.update({ ...point, value: 20 + index })).toEqual(
        separate[index]!.controller.update({ ...point, value: 20 + index }),
      );
    }
  });

  it('preserves first-options, complete-history, first-math, later-options error precedence', () => {
    const invalidHistory = [
      { time: 0, value: Number.MAX_VALUE },
      { time: 1, value: -Number.MAX_VALUE },
      { time: 2, value: NaN },
    ];
    const overflow = invalidHistory.slice(0, 2);
    for (const [requests, points] of [
      [
        [
          { kind: 'sma', period: 0 },
          { kind: 'rsi', period: 2 },
        ],
        invalidHistory,
      ],
      [
        [
          { kind: 'rsi', period: 2 },
          { kind: 'sma', period: 0 },
        ],
        invalidHistory,
      ],
      [
        [
          { kind: 'rsi', period: 2 },
          { kind: 'sma', period: 0 },
        ],
        overflow,
      ],
      [
        [
          { kind: 'sma', period: 2 },
          { kind: 'macd', options: { fastPeriod: 2, slowPeriod: 1, signalPeriod: 1 } },
        ],
        [{ time: 0, value: 1 }],
      ],
    ] as Array<[PreparationRequest[], IndicatorPoint[]]>) {
      const expected = outcome(() => requests.map((request) => separatePreparation(request, points)));
      const actual = outcome(() => prepareBatch(requests, points));
      expect(actual).toEqual(expected);
      expect(actual).not.toHaveProperty('value');
    }
    let nextRequested = false;
    function* requests(): Iterable<PreparationRequest> {
      yield { kind: 'rsi', period: 2 };
      nextRequested = true;
      throw new Error('must not request later options after arithmetic failure');
    }
    expect(() => prepareBatch(requests(), overflow)).toThrow(ChartError);
    expect(nextRequested).toBe(false);
  });

  it('skips validation for empty batches and establishes independent empty/singleton tail state', () => {
    expect(prepareBatch([], null as unknown as IndicatorPoint[], 'invalid' as TimeDomain)).toEqual([]);
    for (const points of [[], [{ time: 0, value: 2 }]]) {
      const batch = prepareBatch(batchRequests, points);
      for (let index = 0; index < batch.length; index++) {
        const separate = separatePreparation(batchRequests[index]!, points);
        expect(batch[index]!.prepared.data).toEqual(separate.data);
        expect(batch[index]!.prepared.controller.update({ time: 0, value: 4 })).toEqual(
          separate.controller.update({ time: 0, value: 4 }),
        );
      }
    }
  });

  it('recovers each independent controller after replacement and append arithmetic failure', () => {
    const max = Number.MAX_VALUE;
    const cases: Array<{
      request: PreparationRequest;
      points: IndicatorPoint[];
      bad: IndicatorPoint[];
      good: IndicatorPoint;
    }> = [
      {
        request: { kind: 'rsi', period: 2 },
        points: [
          { time: 0, value: 0 },
          { time: 1, value: max },
          { time: 2, value: max / 2 },
        ],
        bad: [
          { time: 2, value: -max },
          { time: 3, value: -max },
        ],
        good: { time: 3, value: 0 },
      },
      {
        request: { kind: 'macd', options: { fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 } },
        points: [0, 1, 2, 3].map((time) => ({ time, value: max })),
        bad: [
          { time: 3, value: -max },
          { time: 5, value: -max },
        ],
        good: { time: 5, value: max },
      },
      {
        request: { kind: 'bollinger', options: { period: 2, multiplier: 2 } },
        points: [0, 1].map((time) => ({ time, value: max })),
        bad: [
          { time: 1, value: -max },
          { time: 3, value: -max },
        ],
        good: { time: 3, value: max },
      },
    ];
    for (const { request, points, bad, good } of cases) {
      const batch = prepareBatch([request, request], points);
      const separate = separatePreparation(request, points);
      for (const point of bad) {
        expect(() => batch[0]!.prepared.controller.update(point)).toThrow(ChartError);
        expect(() => separate.controller.update(point)).toThrow(ChartError);
      }
      const expected = separate.controller.update(good);
      expect(batch[0]!.prepared.controller.update(good)).toEqual(expected);
      expect(batch[1]!.prepared.controller.update(good)).toEqual(expected);
    }
  });
});
