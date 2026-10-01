import { describe, expect, it } from 'vitest';
import { ChartError } from '@filtrix.net/core';
import { chartOptions, exportWatermark, seriesOptions } from './options';

describe('chart attribution options', () => {
  it('defaults on, accepts opt-out, and ignores undefined patches', () => {
    expect(chartOptions({}, {}).attribution).toBe(true);
    const caller = Object.freeze({ attribution: false });
    const old = chartOptions({}, caller);
    expect(old.attribution).toBe(false);
    expect(chartOptions(old, { attribution: undefined }).attribution).toBe(false);
    expect(chartOptions(old, { attribution: true }).attribution).toBe(true);
    expect(caller).toEqual({ attribution: false });
  });

  it('rejects non-booleans atomically', () => {
    const old = chartOptions({}, { attribution: false, width: 500 });
    for (const attribution of [null, 0, 1, '', 'false', {}, []]) {
      expect(() => chartOptions(old, { attribution, width: 900 } as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
      expect(old).toMatchObject({ attribution: false, width: 500 });
    }
  });
});

describe('PNG export options', () => {
  it('follows attribution unless this export has an explicit override', () => {
    for (const attribution of [false, true]) {
      expect(exportWatermark(undefined, attribution)).toBe(attribution);
      expect(exportWatermark({}, attribution)).toBe(attribution);
      expect(exportWatermark({ watermark: undefined }, attribution)).toBe(attribution);
      expect(exportWatermark({ watermark: false }, attribution)).toBe(false);
      expect(exportWatermark({ watermark: true }, attribution)).toBe(true);
      expect(exportWatermark(Object.assign(Object.create(null), { watermark: false }), attribution)).toBe(
        false,
      );
    }
  });

  it('rejects non-plain objects, unknown keys and non-boolean values', () => {
    for (const options of [
      null,
      [],
      new Date(),
      'false',
      0,
      Object.create({ watermark: false }),
      { unknown: undefined },
      { watermark: null },
      { watermark: 0 },
      { watermark: 'false' },
      { [Symbol('watermark')]: false },
    ]) {
      expect(() => exportWatermark(options as never, true)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    }
  });

  it('reads watermark getters once and leaves caller input unchanged', () => {
    let reads = 0;
    const options = Object.freeze({
      get watermark() {
        reads++;
        return reads === 1 ? false : true;
      },
    });
    expect(exportWatermark(options, true)).toBe(false);
    expect(reads).toBe(1);
    expect(Object.isFrozen(options)).toBe(true);
  });
});

describe('chart legend options', () => {
  it('defaults, merges partial patches and copies caller nested objects', () => {
    const caller = { visible: false, maxRows: 3 };
    const first = chartOptions({}, { legend: caller });
    caller.maxRows = 4;
    expect(first.legend).toEqual({ visible: false, maxRows: 3 });
    const second = chartOptions(first, { legend: { visible: true } });
    expect(second.legend).toEqual({ visible: true, maxRows: 3 });
    expect(chartOptions({}, {}).legend).toEqual({ visible: true, maxRows: 2 });
  });

  it('rejects invalid nested values and keys without mutating saved options', () => {
    const old = chartOptions({}, { legend: { visible: false, maxRows: 2 } });
    for (const legend of [
      null,
      [],
      new Date(),
      { other: true },
      { visible: 1 },
      { maxRows: 0 },
      { maxRows: 5 },
      { maxRows: 1.5 },
      { maxRows: Infinity },
      { maxRows: NaN },
    ]) {
      expect(() => chartOptions(old, { legend } as never)).toThrow(ChartError);
      expect(old.legend).toEqual({ visible: false, maxRows: 2 });
    }
  });
});

describe('band series options', () => {
  it('resolves fill-only defaults without changing old series defaults', () => {
    expect(seriesOptions('band', {}, true)).toEqual({
      fillOpacity: 0.14,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(seriesOptions('line', {}, true)).toEqual({});
  });

  it('rejects scalar annotations and invalid opacity', () => {
    for (const patch of [
      { lastValueVisible: true },
      { priceLineVisible: true },
      { fillOpacity: -0.01 },
      { fillOpacity: 1.01 },
      { fillOpacity: Number.NaN },
      { fillOpacity: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => seriesOptions('band', patch)).toThrow(ChartError);
    }
    expect(() => seriesOptions('line', { fillOpacity: 0.2 })).toThrow(ChartError);
  });

  it('reads retained option getters once', () => {
    let reads = 0;
    const patch = {
      get fillOpacity() {
        reads += 1;
        return reads === 1 ? 0.25 : 2;
      },
    };
    expect(seriesOptions('band', patch)).toEqual({ fillOpacity: 0.25 });
    expect(reads).toBe(1);
  });
});
