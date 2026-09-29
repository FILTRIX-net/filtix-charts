import { describe, expect, it } from 'vitest';
import { SeriesStore } from '@filtix/core';
import * as charts from './index';
import type { ChartApi, SeriesHandle, SeriesPoint } from './types';

class ElementStub {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: ElementStub[] = [];
  readonly ownerDocument: DocumentStub;
  parent: ElementStub | null = null;
  width = 0;
  height = 0;
  tabIndex = -1;
  textContent = '';

  constructor(
    readonly tagName: string,
    document: DocumentStub,
  ) {
    this.ownerDocument = document;
  }

  append(...children: ElementStub[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  insertBefore(child: ElementStub, before: ElementStub) {
    child.parent = this;
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute() {}
  getAttribute() {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
  getContext() {
    return { setTransform() {} };
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 420, height: 260 };
  }
}

class DocumentStub {
  readonly defaultView = {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    setTimeout,
  };

  createElement(tagName: string) {
    return new ElementStub(tagName, this);
  }
}

function create(timeDomain: 'utc-ms' | 'business-date' = 'utc-ms') {
  const document = new DocumentStub();
  const host = document.createElement('div') as unknown as HTMLElement;
  const chart = charts.createChart(host, { autoSize: false, width: 420, height: 260, timeDomain });
  return chart;
}

function bridge() {
  const named = charts as typeof charts & {
    hasOwnedStudyColumnCapability: (chart: ChartApi) => boolean;
    setOwnedStudyColumns: (
      chart: ChartApi,
      handle: SeriesHandle,
      points: readonly { time: number }[],
      input:
        | { kind: 'scalar'; column: { values: Float64Array; present: Uint8Array } }
        | {
            kind: 'band';
            upper: { values: Float64Array; present: Uint8Array };
            lower: { values: Float64Array; present: Uint8Array };
          },
    ) => void;
  };
  expect(typeof named.hasOwnedStudyColumnCapability).toBe('function');
  expect(typeof named.setOwnedStudyColumns).toBe('function');
  return named;
}

function code(work: () => unknown) {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function priceVolumeBridge() {
  const operation = (
    charts as typeof charts & {
      setOwnedPriceVolumeData: (
        chart: ChartApi,
        price: SeriesHandle,
        volume: SeriesHandle,
        bars: readonly SeriesPoint[],
      ) => void;
    }
  ).setOwnedPriceVolumeData;
  expect(typeof operation).toBe('function');
  return operation;
}

function failure(work: () => unknown) {
  try {
    work();
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return null;
}

const candle = (time: number, volume?: number): SeriesPoint =>
  volume === undefined
    ? { time, open: 2, high: 3, low: 1, close: 2 }
    : { time, open: 2, high: 3, low: 1, close: 2, volume };

describe('built-in chart owned-study bridge', () => {
  it('admits only exact live UTC charts and their current handles', () => {
    const { hasOwnedStudyColumnCapability, setOwnedStudyColumns } = bridge();
    const first = create();
    const second = create();
    const one = first.addSeries('line', { id: 'one' });
    const two = second.addSeries('line', { id: 'two' });
    const points = [{ time: 1 }, { time: 2 }];
    const input = {
      kind: 'scalar' as const,
      column: { values: Float64Array.of(5, 6), present: Uint8Array.of(1, 1) },
    };
    expect(hasOwnedStudyColumnCapability(first)).toBe(true);
    expect(hasOwnedStudyColumnCapability(second)).toBe(true);
    const fake = {
      get timeDomain() {
        throw Error('must not read fake chart');
      },
    } as unknown as ChartApi;
    expect(hasOwnedStudyColumnCapability(fake)).toBe(false);
    expect(code(() => setOwnedStudyColumns(first, two, points, input))).toBe('INVALID_SERIES');
    expect(code(() => setOwnedStudyColumns(first, { ...one }, points, input))).toBe('INVALID_SERIES');
    setOwnedStudyColumns(first, one, points, input);
    expect(one.getData()).toEqual([
      { time: 1, value: 5 },
      { time: 2, value: 6 },
    ]);
    one.remove();
    expect(code(() => setOwnedStudyColumns(first, one, points, input))).toBe('REMOVED');
    first.destroy();
    expect(hasOwnedStudyColumnCapability(first)).toBe(false);
    expect(code(() => setOwnedStudyColumns(first, one, points, input))).toBe('DESTROYED');
    second.destroy();
  });

  it('publishes owned candidates through the same union, gap and log checks as public setData', () => {
    const { setOwnedStudyColumns } = bridge();
    const chart = create();
    const untouched = chart.addSeries('area', { id: 'sparse' });
    const target = chart.addSeries('line', { id: 'target' });
    untouched.setData([
      { time: 1, value: 1 },
      { time: 3, value: 3 },
    ]);
    target.setData([
      { time: 1, value: 2 },
      { time: 3, value: 4 },
    ]);
    const input = {
      kind: 'scalar' as const,
      column: { values: Float64Array.of(7, 8, 9), present: Uint8Array.of(1, 0, 1) },
    };
    setOwnedStudyColumns(chart, target, [{ time: 0 }, { time: 2 }, { time: 4 }], input);
    expect(target.getData()).toEqual([{ time: 0, value: 7 }, { time: 2 }, { time: 4, value: 9 }]);
    expect(untouched.getData()).toEqual([
      { time: 1, value: 1 },
      { time: 3, value: 3 },
    ]);
    const comparison = create();
    comparison.addSeries('area', { id: 'sparse' }).setData([
      { time: 1, value: 1 },
      { time: 3, value: 3 },
    ]);
    const publicTarget = comparison.addSeries('line', { id: 'target' });
    publicTarget.setData([
      { time: 1, value: 2 },
      { time: 3, value: 4 },
    ]);
    publicTarget.setData([{ time: 0, value: 7 }, { time: 2 }, { time: 4, value: 9 }]);
    expect(chart.getVisibleTimeRange()).toEqual(comparison.getVisibleTimeRange());
    input.column.values.fill(99);
    input.column.present.fill(1);
    expect(target.getData()).toEqual([{ time: 0, value: 7 }, { time: 2 }, { time: 4, value: 9 }]);

    const pane = chart.addPane({ id: 'log', scale: 'log' });
    const log = chart.addSeries('line', { id: 'log-series', paneId: pane.id });
    log.setData([{ time: 0, value: 1 }]);
    const negative = {
      kind: 'scalar' as const,
      column: { values: Float64Array.of(-1), present: Uint8Array.of(1) },
    };
    expect(code(() => setOwnedStudyColumns(chart, log, [{ time: 1 }], negative))).toBe('INVALID_LOG_DATA');
    expect(log.getData()).toEqual([{ time: 0, value: 1 }]);
    chart.destroy();
    comparison.destroy();
  });

  it('rejects unsupported calendar charts and a handle retired during candidate validation', () => {
    const { hasOwnedStudyColumnCapability, setOwnedStudyColumns } = bridge();
    const calendar = create('business-date');
    const calendarHandle = calendar.addSeries('line');
    expect(hasOwnedStudyColumnCapability(calendar)).toBe(false);
    expect(
      code(() =>
        setOwnedStudyColumns(calendar, calendarHandle, [], {
          kind: 'scalar',
          column: { values: new Float64Array(), present: new Uint8Array() },
        }),
      ),
    ).toBe('INVALID_TIME_DOMAIN');
    calendar.destroy();

    const chart = create();
    const unaffected = chart.addSeries('area', { id: 'unaffected' });
    unaffected.setData([{ time: 1, value: 4 }]);
    const retired = chart.addSeries('line', { id: 'retired' });
    retired.setData([{ time: 1, value: 5 }]);
    let reads = 0;
    const replacements: SeriesHandle[] = [];
    const points = [
      { time: 1 },
      {
        get time() {
          reads++;
          retired.remove();
          const replacement = chart.addSeries('line', { id: 'retired' });
          replacement.setData([{ time: 1, value: 8 }]);
          replacements.push(replacement);
          return 2;
        },
      },
    ];
    expect(
      code(() =>
        setOwnedStudyColumns(chart, retired, points, {
          kind: 'scalar',
          column: { values: Float64Array.of(6, 7), present: Uint8Array.of(1, 1) },
        }),
      ),
    ).toBe('REMOVED');
    expect(reads).toBe(1);
    expect(unaffected.getData()).toEqual([{ time: 1, value: 4 }]);
    expect(replacements[0]?.getData()).toEqual([{ time: 1, value: 8 }]);
    expect(chart.getVisibleTimeRange()).toEqual({ from: 1, to: 1 });
    chart.destroy();

    const destroyed = create();
    const deadHandle = destroyed.addSeries('line');
    const destructivePoints = [
      {
        get time() {
          destroyed.destroy();
          return 1;
        },
      },
    ];
    expect(
      code(() =>
        setOwnedStudyColumns(destroyed, deadHandle, destructivePoints, {
          kind: 'scalar',
          column: { values: Float64Array.of(2), present: Uint8Array.of(1) },
        }),
      ),
    ).toBe('DESTROYED');
    expect(hasOwnedStudyColumnCapability(destroyed)).toBe(false);
  });
});

describe('built-in chart price-derived volume bridge', () => {
  it('publishes independent price and volume with public setter parity, gaps and signed zero', () => {
    const publish = priceVolumeBridge();
    const chart = create();
    const price = chart.addSeries('candlestick', { id: 'price' });
    const volume = chart.addSeries('histogram', { id: 'volume' });
    const publicChart = create();
    const publicPrice = publicChart.addSeries('candlestick', { id: 'price' });
    const publicVolume = publicChart.addSeries('histogram', { id: 'volume' });
    const bars: SeriesPoint[] = [candle(1, -0), candle(2, 0), { time: 3 }, candle(4), candle(5, 7)];
    publish(chart, price, volume, bars);
    publicPrice.setData(bars);
    publicVolume.setData(
      bars.map((bar) => ({ time: bar.time, value: 'volume' in bar ? bar.volume : undefined })),
    );
    expect(price.getData()).toEqual(publicPrice.getData());
    expect(volume.getData()).toEqual(publicVolume.getData());
    expect(chart.getVisibleTimeRange()).toEqual(publicChart.getVisibleTimeRange());
    expect(volume.getData()[2]).toEqual({ time: 3 });
    expect(volume.getData()[3]).toEqual({ time: 4 });
    expect(Object.is((volume.getData()[0] as { value: number }).value, -0)).toBe(true);
    expect(Object.is((volume.getData()[1] as { value: number }).value, 0)).toBe(true);

    const volumeBefore = volume.getData();
    price.update(candle(5, 99));
    expect(volume.getData()).toEqual(volumeBefore);
    const priceBefore = price.getData();
    volume.update({ time: 5, value: 12 });
    expect(price.getData()).toEqual(priceBefore);
    bars[0] = candle(1, 777);
    expect(Object.is((volume.getData()[0] as { value: number }).value, -0)).toBe(true);
    chart.destroy();
    publicChart.destroy();
  });

  it('keeps price published when destination ownership or log validation fails, then recovers', () => {
    const publish = priceVolumeBridge();
    const chart = create();
    const price = chart.addSeries('candlestick', { id: 'price' });
    const logPane = chart.addPane({ id: 'log', scale: 'log' });
    const volume = chart.addSeries('histogram', { id: 'volume', paneId: logPane.id });
    const foreignChart = create();
    const foreignVolume = foreignChart.addSeries('histogram', { id: 'foreign-volume' });
    price.setData([candle(1, 1)]);
    volume.setData([{ time: 1, value: 1 }]);

    expect(
      failure(() =>
        publish(chart, price, volume, [{ time: 2, open: Number.NaN, high: 3, low: 1, close: 2, volume: 2 }]),
      )?.code,
    ).toBe('INVALID_DATA');
    expect(price.getData()).toEqual([candle(1, 1)]);
    expect(volume.getData()).toEqual([{ time: 1, value: 1 }]);

    expect(failure(() => publish(chart, price, foreignVolume, [candle(2, 2)]))).toEqual({
      code: 'INVALID_SERIES',
      message: 'Volume handle does not belong to chart',
    });
    expect(price.getData()).toEqual([candle(2, 2)]);
    expect(volume.getData()).toEqual([{ time: 1, value: 1 }]);
    expect(failure(() => publish(chart, price, volume, [candle(3, 0)]))).toEqual({
      code: 'INVALID_LOG_DATA',
      message: 'Logarithmic panes require strictly positive data',
    });
    expect(price.getData()).toEqual([candle(3, 0)]);
    expect(volume.getData()).toEqual([{ time: 1, value: 1 }]);
    publish(chart, price, volume, [candle(4, 4)]);
    expect(price.getData()).toEqual([candle(4, 4)]);
    expect(volume.getData()).toEqual([{ time: 4, value: 4 }]);
    chart.destroy();
    foreignChart.destroy();
  });

  it('rejects fake, foreign, calendar and destroyed owners without reading fake properties', () => {
    const publish = priceVolumeBridge();
    const chart = create();
    const price = chart.addSeries('candlestick', { id: 'price' });
    const volume = chart.addSeries('histogram', { id: 'volume' });
    const other = create();
    const foreignPrice = other.addSeries('candlestick', { id: 'foreign' });
    let reads = 0;
    const fake = {
      get timeDomain() {
        reads++;
        throw Error('fake chart property read');
      },
    } as unknown as ChartApi;
    expect(failure(() => publish(fake, price, volume, [candle(1, 1)]))?.code).toBe('INVALID_SERIES');
    expect(reads).toBe(0);
    expect(failure(() => publish(chart, foreignPrice, volume, [candle(1, 1)]))?.code).toBe('INVALID_SERIES');
    expect(price.getData()).toEqual([]);
    expect(volume.getData()).toEqual([]);

    const calendar = create('business-date');
    const calendarPrice = calendar.addSeries('candlestick');
    const calendarVolume = calendar.addSeries('histogram');
    expect(failure(() => publish(calendar, calendarPrice, calendarVolume, []))?.code).toBe(
      'INVALID_TIME_DOMAIN',
    );
    calendar.destroy();
    chart.destroy();
    expect(failure(() => publish(chart, price, volume, []))?.code).toBe('DESTROYED');
    other.destroy();
  });

  it.each([false, true])('preserves exact removed price and volume errors (replacement: %s)', (replace) => {
    const publish = priceVolumeBridge();
    const priceChart = create();
    const stalePrice = priceChart.addSeries('candlestick', { id: 'price' });
    const priceVolume = priceChart.addSeries('histogram', { id: 'volume' });
    stalePrice.remove();
    const newPrice = replace ? priceChart.addSeries('candlestick', { id: 'price' }) : null;
    expect(failure(() => publish(priceChart, stalePrice, priceVolume, [candle(2, 2)]))).toEqual({
      code: 'REMOVED',
      message: replace ? 'Series has been removed' : 'Series does not exist',
    });
    expect(newPrice?.getData()).toEqual(replace ? [] : undefined);
    expect(priceVolume.getData()).toEqual([]);
    priceChart.destroy();

    const volumeChart = create();
    const price = volumeChart.addSeries('candlestick', { id: 'price' });
    const staleVolume = volumeChart.addSeries('histogram', { id: 'volume' });
    staleVolume.remove();
    const newVolume = replace ? volumeChart.addSeries('histogram', { id: 'volume' }) : null;
    expect(failure(() => publish(volumeChart, price, staleVolume, [candle(2, 2)]))).toEqual({
      code: 'REMOVED',
      message: replace ? 'Series has been removed' : 'Series does not exist',
    });
    expect(price.getData()).toEqual([candle(2, 2)]);
    expect(newVolume?.getData()).toEqual(replace ? [] : undefined);
    volumeChart.destroy();
  });

  it('honors a volume-handle replacement reentered during price validation', () => {
    const publish = priceVolumeBridge();
    const chart = create();
    const price = chart.addSeries('candlestick', { id: 'price' });
    const staleVolume = chart.addSeries('histogram', { id: 'volume' });
    let reads = 0;
    const state: { replacement: SeriesHandle | null } = { replacement: null };
    const bar = {
      time: 1,
      high: 3,
      low: 1,
      close: 2,
      volume: 5,
      get open() {
        reads++;
        if (!state.replacement) {
          staleVolume.remove();
          state.replacement = chart.addSeries('histogram', { id: 'volume' });
        }
        return 2;
      },
    };
    expect(failure(() => publish(chart, price, staleVolume, [bar]))).toEqual({
      code: 'REMOVED',
      message: 'Series has been removed',
    });
    expect(reads).toBeGreaterThan(0);
    expect(price.getData()).toEqual([candle(1, 5)]);
    expect(state.replacement?.getData()).toEqual([]);
    chart.destroy();
  });

  it('rejects a retained price revision changed while its volume candidate is copied', () => {
    const publish = priceVolumeBridge();
    const chart = create();
    const price = chart.addSeries('candlestick', { id: 'price' });
    const volume = chart.addSeries('histogram', { id: 'volume' });
    price.setData([candle(0, 1)]);
    volume.setData([{ time: 0, value: 1 }]);
    const symbols = Object.getOwnPropertySymbols(SeriesStore.prototype).filter(
      (symbol) => symbol.description === 'derive-owned-volume',
    );
    expect(symbols).toHaveLength(1);
    const symbol = symbols[0]!;
    const original = Object.getOwnPropertyDescriptor(SeriesStore.prototype, symbol);
    expect(typeof original?.value).toBe('function');
    if (!original || typeof original.value !== 'function') throw Error('Owned copier method missing');
    const copy = original.value as (this: SeriesStore) => SeriesStore;
    let copies = 0;
    let updates = 0;
    try {
      Object.defineProperty(SeriesStore.prototype, symbol, {
        ...original,
        value: function (this: SeriesStore) {
          const candidate = copy.call(this);
          copies++;
          price.update(candle(1, 9));
          updates++;
          return candidate;
        },
      });
      expect(failure(() => publish(chart, price, volume, [candle(1, 5)]))).toEqual({
        code: 'INVALID_SERIES',
        message: 'Owned price source changed during volume derivation',
      });
      expect(copies).toBe(1);
      expect(updates).toBe(1);
      expect(price.getData()).toEqual([candle(1, 9)]);
      expect(volume.getData()).toEqual([{ time: 0, value: 1 }]);
    } finally {
      Object.defineProperty(SeriesStore.prototype, symbol, original);
      chart.destroy();
    }
  });
});
