import { describe, expect, it } from 'vitest';
import * as core from './index';
import type { SeriesPoint, SeriesType } from './types';

type Column = { values: Float64Array; present: Uint8Array };
type Input = { kind: 'scalar'; column: Column } | { kind: 'band'; upper: Column; lower: Column };

function owned(rows: readonly SeriesPoint[], kind: Input['kind']) {
  const points = rows.map((row) => ({ time: row.time as number }));
  const column = (name: 'value' | 'upper' | 'lower'): Column => {
    const values = new Float64Array(rows.length);
    const present = new Uint8Array(rows.length);
    rows.forEach((row, index) => {
      if (name in row) {
        values[index] = row[name as keyof typeof row] as number;
        present[index] = 1;
      } else values[index] = Number.NaN;
    });
    return { values, present };
  };
  return {
    points,
    input:
      kind === 'band'
        ? ({ kind, upper: column('upper'), lower: column('lower') } as const)
        : ({ kind, column: column('value') } as const),
  };
}

function source(type: SeriesType, count: number): SeriesPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const time = -5000 + index * 60_000;
    if (index % 7 === 2 || index % 11 === 6) return { time };
    const value = index % 13 === 0 ? -0 : index % 5 === 0 ? 0 : (index % 3 ? -1 : 1) * (index % 17);
    return type === 'band' ? { time, lower: value, upper: value + 10 } : { time, value };
  });
}

function ingest(type: SeriesType, points: readonly { time: number }[], input: Input) {
  const factory = (
    core as typeof core & {
      createOwnedStudyStore: (
        type: SeriesType,
        domain: 'utc-ms' | 'business-date',
        points: readonly { time: number }[],
        input: Input,
      ) => core.SeriesStore;
    }
  ).createOwnedStudyStore;
  expect(typeof factory).toBe('function');
  return factory(type, 'utc-ms', points, input);
}

function observed(store: core.SeriesStore) {
  const length = store.length;
  return {
    length,
    revision: store.revision,
    points: Array.from({ length }, (_, index) => store.pointAt(index)),
    keys: Array.from({ length }, (_, index) => store.keyAt(index)),
    windows: [
      [-2, length + 2],
      [0, 0],
      [1, 3],
      [14, 17],
      [length - 4, length + 4],
    ].map(([from, to]) => ({
      range: store.range(from!, to!),
      band: store.type === 'band' ? store.bandRange(from!, to!) : null,
      segments: store.segments(from!, to!),
    })),
  };
}

function errorCode(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function volumeFactory() {
  const factory = (
    core as typeof core & {
      createOwnedVolumeStoreFromPrice: (source: core.SeriesStore) => core.SeriesStore;
    }
  ).createOwnedVolumeStoreFromPrice;
  expect(typeof factory).toBe('function');
  return factory;
}

function candlesWithVolumeEdges(): SeriesPoint[] {
  return Array.from({ length: 33 }, (_, index) => {
    const time = index + 1;
    if (index === 16) return { time };
    const candle = { time, open: 2, high: 3, low: 1, close: 2 };
    if (index === 17 || (index % 7 === 0 && index !== 14)) return candle;
    return { ...candle, volume: index === 14 ? -0 : index === 15 ? 0 : index + 1 };
  });
}

describe('private owned-study store factory', () => {
  it.each(['line', 'area', 'histogram', 'band'] as const)(
    'copies %s columns into a fresh real store with public range, gap and tail semantics',
    (type) => {
      for (const count of [0, 1, 4, 15, 16, 17, 32, 33, 257]) {
        const rows = source(type, count);
        const publicStore = new core.SeriesStore(type, 'utc-ms');
        publicStore.setData(rows);
        const stage = owned(rows, type === 'band' ? 'band' : 'scalar');
        const privateStore = ingest(type, stage.points, stage.input);
        expect(observed(privateStore)).toEqual(observed(publicStore));
        if (count > 0) {
          const point = privateStore.pointAt(0)!;
          const publicPoint = publicStore.pointAt(0)!;
          if ('value' in point && 'value' in publicPoint)
            expect(Object.is(point.value, publicPoint.value)).toBe(true);
          if ('lower' in point && 'lower' in publicPoint)
            expect(Object.is(point.lower, publicPoint.lower)).toBe(true);
        }
        const saved = observed(privateStore);
        for (const column of stage.input.kind === 'band'
          ? [stage.input.upper, stage.input.lower]
          : [stage.input.column]) {
          column.values.fill(999);
          column.present.fill(1);
        }
        for (const point of stage.points) point.time = 999;
        expect(observed(privateStore)).toEqual(saved);
        const lastTime = count ? (rows.at(-1)!.time as number) : -5000;
        const appended =
          type === 'band'
            ? { time: lastTime + 60_000, lower: -2, upper: 2 }
            : { time: lastTime + 60_000, value: 2 };
        expect(privateStore.update(appended)).toBe(publicStore.update(appended));
        expect(observed(privateStore)).toEqual(observed(publicStore));
      }
    },
  );

  it('rejects malformed private columns and domains before returning a candidate', () => {
    const rows = source('line', 4);
    const stage = owned(rows, 'scalar');
    if (stage.input.kind !== 'scalar') throw new Error('scalar fixture expected');
    const factory = (
      core as typeof core & {
        createOwnedStudyStore: (
          type: SeriesType,
          domain: 'utc-ms' | 'business-date',
          points: readonly { time: number }[],
          input: Input,
        ) => core.SeriesStore;
      }
    ).createOwnedStudyStore;
    expect(typeof factory).toBe('function');
    stage.input.column.present[0] = 2;
    expect(errorCode(() => factory('line', 'utc-ms', stage.points, stage.input))).toBe('INVALID_DATA');
    stage.input.column.present[0] = 1;
    stage.input.column.values[0] = Number.POSITIVE_INFINITY;
    expect(errorCode(() => factory('line', 'utc-ms', stage.points, stage.input))).toBe('INVALID_DATA');
    stage.input.column.values[0] = -0;
    expect(errorCode(() => factory('line', 'business-date', stage.points, stage.input))).toBe(
      'INVALID_TIME_DOMAIN',
    );
    expect(errorCode(() => factory('candlestick', 'utc-ms', stage.points, stage.input))).toBe('INVALID_DATA');
    const duplicate = owned(rows, 'scalar');
    duplicate.points[1]!.time = duplicate.points[0]!.time;
    expect(errorCode(() => factory('line', 'utc-ms', duplicate.points, duplicate.input))).toBe(
      'OUT_OF_ORDER',
    );

    const band = owned(source('band', 4), 'band');
    if (band.input.kind !== 'band') throw new Error('band fixture expected');
    band.input.lower.present[0] = 0;
    expect(errorCode(() => factory('band', 'utc-ms', band.points, band.input))).toBe('INVALID_DATA');
    band.input.lower.present[0] = 1;
    band.input.lower.values[0] = 20;
    expect(errorCode(() => factory('band', 'utc-ms', band.points, band.input))).toBe('INVALID_DATA');
    band.input.lower.values[0] = -0;
    band.input.upper.values = new Float64Array(3);
    expect(errorCode(() => factory('band', 'utc-ms', band.points, band.input))).toBe('INVALID_DATA');
  });
});

describe('private price-derived volume store factory', () => {
  it('copies sparse, signed-zero and whitespace candles across a block and capacity edge', () => {
    const derive = volumeFactory();
    const bars = candlesWithVolumeEdges();
    const price = new core.SeriesStore('candlestick', 'utc-ms');
    price.setData(bars);
    const volume = derive(price);
    const publicVolume = new core.SeriesStore('histogram', 'utc-ms');
    publicVolume.setData(
      bars.map((bar) =>
        'volume' in bar && bar.volume !== undefined
          ? { time: bar.time, value: bar.volume }
          : { time: bar.time },
      ),
    );

    expect(observed(volume)).toEqual(observed(publicVolume));
    expect(volume.lowerBound(16)).toBe(15);
    expect(volume.lowerBound(16.5)).toBe(16);
    expect(Object.is((volume.pointAt(14) as { value: number }).value, -0)).toBe(true);
    expect(Object.is((volume.pointAt(15) as { value: number }).value, 0)).toBe(true);
    expect(volume.pointAt(16)).toEqual({ time: 17 });
    expect(volume.pointAt(17)).toEqual({ time: 18 });

    const priceColumns = (
      price as unknown as {
        columns: {
          keys: Float64Array;
          present: Uint8Array;
          volumes: Float64Array;
        };
      }
    ).columns;
    const volumeColumns = (
      volume as unknown as {
        columns: {
          keys: Float64Array;
          present: Uint8Array;
          values: Float64Array;
        };
      }
    ).columns;
    expect(volumeColumns.keys.buffer).not.toBe(priceColumns.keys.buffer);
    expect(volumeColumns.present.buffer).not.toBe(priceColumns.present.buffer);
    expect(volumeColumns.values.buffer).not.toBe(priceColumns.volumes.buffer);

    const savedVolume = observed(volume);
    price.update({ time: 33, open: 2, high: 3, low: 1, close: 2, volume: 777 });
    expect(observed(volume)).toEqual(savedVolume);
    const savedPrice = observed(price);
    expect(volume.update({ time: 34, value: -5 })).toBe(publicVolume.update({ time: 34, value: -5 }));
    expect(observed(volume)).toEqual(observed(publicVolume));
    expect(observed(price)).toEqual(savedPrice);
    expect(volume.update({ time: 34, value: 9 })).toBe(publicVolume.update({ time: 34, value: 9 }));
    expect(observed(volume)).toEqual(observed(publicVolume));
    expect(observed(price)).toEqual(savedPrice);
  });

  it('rejects a scalar or calendar source before creating a derived store', () => {
    const derive = volumeFactory();
    expect(errorCode(() => derive(new core.SeriesStore('line', 'utc-ms')))).toBe('INVALID_DATA');
    expect(errorCode(() => derive(new core.SeriesStore('candlestick', 'business-date')))).toBe(
      'INVALID_DATA',
    );
  });
});
