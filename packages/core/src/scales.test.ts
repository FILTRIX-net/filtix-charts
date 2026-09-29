import { describe, expect, it } from 'vitest';
import { ChartError, clampRange, createPriceScale } from './index';

describe('price scales', () => {
  it('round-trips linear values and expands a flat range', () => {
    const scale = createPriceScale(5, 5, 20, 200);
    const y = scale.priceToY(5);
    expect(Number.isFinite(y)).toBe(true);
    expect(scale.yToPrice(y)).toBeCloseTo(5, 12);
    expect(scale.min).toBeLessThan(5);
    expect(scale.max).toBeGreaterThan(5);
    expect(scale.ticks().every(Number.isFinite)).toBe(true);
  });

  it('keeps extreme finite linear domains and ticks numerically usable', () => {
    const scale = createPriceScale(-1e308, 1e308, -50, 600);
    for (const value of [-1e308, 0, 1e308]) {
      const y = scale.priceToY(value);
      expect(Number.isFinite(y)).toBe(true);
      expect(scale.yToPrice(y)).toBeCloseTo(value, 12);
    }
    expect(scale.ticks(9)).toHaveLength(9);
    expect(scale.ticks(9).every(Number.isFinite)).toBe(true);
  });

  it('keeps adjacent finite logarithmic bounds usable when their logs round together', () => {
    const min = 1.7976931348623155e308;
    const max = Number.MAX_VALUE;
    const scale = createPriceScale(min, max, 0, 100, 'log');

    expect(scale.priceToY(min)).toBe(100);
    expect(scale.priceToY(max)).toBe(0);
    expect(scale.yToPrice(100)).toBe(min);
    expect(scale.yToPrice(0)).toBe(max);
    expect(scale.ticks(3).every(Number.isFinite)).toBe(true);
  });
  it('maps logarithmic domains and rejects non-positive bounds', () => {
    const scale = createPriceScale(1e-8, 1e9, 0, 340, 'log');
    for (const value of [1e-8, 1, 1e9]) {
      expect(scale.yToPrice(scale.priceToY(value))).toBeCloseTo(value, 10);
    }
    expect(scale.ticks(7)).toHaveLength(7);
    expect(scale.ticks(7).every((value) => Number.isFinite(value) && value > 0)).toBe(true);
    expect(() => createPriceScale(0, 10, 0, 100, 'log')).toThrow(ChartError);
    expect(() => createPriceScale(-1, 10, 0, 100, 'log')).toThrow(ChartError);
  });

  it('rejects invalid scale geometry', () => {
    expect(() => createPriceScale(0, Number.NaN, 0, 100)).toThrow(ChartError);
    expect(() => createPriceScale(0, 10, 0, 0)).toThrow(ChartError);
  });
});

describe('clampRange', () => {
  it('preserves a valid width while shifting the range inside the data extent', () => {
    expect(clampRange({ from: -3, to: 3 }, 10)).toEqual({ from: 0, to: 6 });
    expect(clampRange({ from: 8, to: 12 }, 10)).toEqual({ from: 5, to: 9 });
  });

  it('enforces its empty, minimum-width, and maximum-width contracts', () => {
    expect(clampRange({ from: 2, to: 2 }, 10)).toEqual({ from: 1.5, to: 2.5 });
    expect(clampRange({ from: -100, to: 100 }, 10)).toEqual({ from: 0, to: 9 });
    expect(clampRange({ from: 8, to: 9 }, 0)).toEqual({ from: 0, to: 1 });
    expect(clampRange({ from: 8, to: 9 }, 1)).toEqual({ from: 0, to: 1 });
    expect(clampRange({ from: 1e308, to: 1.1e308 }, 10)).toEqual({ from: 0, to: 9 });
    expect(clampRange({ from: -1.1e308, to: -1e308 }, 10)).toEqual({ from: 0, to: 9 });
    expect(clampRange({ from: -1e308, to: 0.5 }, 10)).toEqual({ from: 0, to: 9 });
  });
});
