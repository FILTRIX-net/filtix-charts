import { describe, it, expect } from 'vitest';
import { SeriesStore } from '@filtix/core';
import { layout, histogramSum } from './layout';
import { formatPrice } from './renderer';
import { darkTheme } from './themes';
import type { Scene, SeriesState } from './types';
describe('financial display reductions', () => {
  it('fits the sums actually drawn by dense histogram bins', () => {
    const store = new SeriesStore('histogram');
    store.setData(Array.from({ length: 1000 }, (_, i) => ({ time: i, value: 1 })));
    const scene: Scene = {
      width: 200,
      height: 300,
      plotWidth: 0,
      plotHeight: 0,
      dpr: 1,
      theme: { ...darkTheme },
      options: {},
      timeline: Array.from({ length: 1000 }, (_, i) => i),
      range: { from: 0, to: 999 },
      panes: [
        {
          id: 'price',
          top: 0,
          height: 0,
          scale: null,
          options: { weight: 1, minHeight: 48, scale: 'linear' },
        },
      ],
      series: [
        { id: 'hist', type: 'histogram', paneId: 'price', options: {}, store, runs: [{ from: 0, to: 999 }] },
      ],
    };
    layout(scene);
    const step = Math.ceil(2 / ((scene.plotWidth - 16) / 999));
    expect(scene.panes[0]!.scale!.max).toBeGreaterThanOrEqual(step);
  });
  it('autoscales a band from both boundaries', () => {
    const store = new SeriesStore('band');
    store.setData([
      { time: 0, lower: 5, upper: 6 },
      { time: 1, lower: 4, upper: 20 },
    ]);
    const scene: Scene = {
      width: 400,
      height: 300,
      plotWidth: 0,
      plotHeight: 0,
      dpr: 1,
      theme: { ...darkTheme },
      options: {},
      timeline: [0, 1],
      range: { from: 0, to: 1 },
      panes: [
        {
          id: 'price',
          top: 0,
          height: 0,
          scale: null,
          options: { weight: 1, minHeight: 48, scale: 'linear' },
        },
      ],
      series: [{ id: 'band', type: 'band', paneId: 'price', options: {}, store, runs: [{ from: 0, to: 1 }] }],
    };
    layout(scene);
    expect(scene.panes[0]!.scale!.min).toBe(4);
    expect(scene.panes[0]!.scale!.max).toBe(20);
  });
  it('keeps every decimal required for fractional tick sizes', () => {
    expect(formatPrice(1.25, { tickSize: 0.25 })).toBe('1.25');
    expect(formatPrice(12.5, { tickSize: 2.5 })).toBe('12.5');
    expect(formatPrice(0.00000025, { tickSize: 2.5e-7 })).toBe('0.00000025');
  });
});

describe('overflow-safe histogram display sums', () => {
  function sum(values: number[]): number {
    const store = new SeriesStore('histogram');
    store.setData(values.map((value, time) => ({ time, value })));
    const series: SeriesState = {
      id: 'hist',
      type: 'histogram',
      paneId: 'price',
      options: {},
      store,
      runs: [],
    };
    return histogramSum(series, 0, values.length - 1);
  }
  it('retains representable totals after signed intermediate overflow', () => {
    const max = Number.MAX_VALUE;
    expect(sum([max, max, -max])).toBe(max);
    expect(sum([-max, -max, max])).toBe(-max);
    expect(sum([max, max, -max, -max])).toBe(0);
  });
  it('preserves a small residual through large cancellation', () => {
    const max = Number.MAX_VALUE;
    expect(sum([max, 1, -max])).toBeCloseTo(1, 12);
    expect(sum([-max, -1, max])).toBeCloseTo(-1, 12);
  });
  it('clamps only final unrepresentable totals and keeps ordinary sums', () => {
    expect(sum([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
    expect(sum([-Number.MAX_VALUE, -Number.MAX_VALUE])).toBe(-Number.MAX_VALUE);
    expect(sum([5])).toBe(5);
    expect(sum([1, 2, 3])).toBe(6);
    expect(sum([])).toBe(0);
  });
});
