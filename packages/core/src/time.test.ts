import { describe, expect, it } from 'vitest';
import { ChartError, lowerBound, timeFromKey, timeKey, utcMillis } from './index';

describe('time helpers', () => {
  it('round-trips each explicit time domain without changing its public type', () => {
    const instant = utcMillis(1_725_724_800_123);
    expect(timeFromKey(timeKey(instant, 'utc-ms'), 'utc-ms')).toBe(1_725_724_800_123);

    const date = '2024-02-29';
    expect(timeFromKey(timeKey(date, 'business-date'), 'business-date')).toBe(date);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 8_640_000_000_000_001, -8_640_000_000_000_001])(
    'rejects invalid UTC millisecond value %s',
    (value) => {
      expect(() => utcMillis(value)).toThrow(ChartError);
    },
  );

  it('rejects mixed domains and invalid calendar dates', () => {
    expect(() => timeKey('2024-01-01', 'utc-ms')).toThrow(ChartError);
    expect(() => timeKey(1_725_724_800_123, 'business-date')).toThrow(ChartError);
    expect(() => timeKey('2023-02-29', 'business-date')).toThrow(ChartError);
    expect(() => timeKey('2024-2-09', 'business-date')).toThrow(ChartError);
    expect(() => timeKey('2024-02-30', 'business-date')).toThrow(ChartError);
  });

  it('finds the first sorted value greater than or equal to a key', () => {
    const values = new Float64Array([1, 4, 4, 9]);
    expect(lowerBound(values, 0)).toBe(0);
    expect(lowerBound(values, 4)).toBe(1);
    expect(lowerBound(values, 5)).toBe(3);
    expect(lowerBound(values, 10)).toBe(4);
  });
});
