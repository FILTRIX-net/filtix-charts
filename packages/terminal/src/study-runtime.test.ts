import { describe, expect, test, vi } from 'vitest';
import type {
  ChartApi,
  PaneHandle,
  SeriesHandle,
  SeriesOptions,
  SeriesPoint,
  SeriesType,
} from '@filtix/charts';
import * as chartInternal from '@filtix/charts/internal';
import {
  createBollingerBands,
  createIndicator,
  createMacd,
  type BollingerBandsOptions,
  type MacdOptions,
} from '@filtix/indicators';
import * as privatePreparation from '@filtix/indicators/internal';
import * as indicatorValidation from '../../indicators/src/indicators';
import { TerminalStudyRuntime } from './study-runtime';
import type { TerminalBollingerStudy, TerminalMacdStudy, TerminalSingleStudy, TerminalStudy } from './types';

interface FakeSeries {
  id: string;
  type: SeriesType;
  options: SeriesOptions;
  data: SeriesPoint[];
  updates: SeriesPoint[];
  applies: Array<Partial<SeriesOptions>>;
  removed: boolean;
}

class FakeChart {
  readonly events: string[] = [];
  readonly series = new Map<string, FakeSeries>();
  readonly panes = new Map<string, { id: string; removed: boolean }>();
  private calls = new Map<string, number>();
  private failure: { operation: string; at: number } | null = null;
  readonly transferredArrays: SeriesPoint[][] = [];
  readonly transferredPoints: SeriesPoint[] = [];
  readonly updateSubmissions: Array<{ id: string; point: SeriesPoint }> = [];
  onSetData?: (id: string, data: SeriesPoint[]) => void;
  onUpdate?: (id: string, point: SeriesPoint) => void;

  failOnce(operation: 'addSeries' | 'setData' | 'applyOptions' | 'addPane', at: number): void {
    this.calls.set(operation, 0);
    this.failure = { operation, at };
  }

  private hit(operation: string): void {
    const count = (this.calls.get(operation) ?? 0) + 1;
    this.calls.set(operation, count);
    if (this.failure?.operation === operation && this.failure.at === count) {
      this.failure = null;
      throw new Error(`injected ${operation} ${count}`);
    }
  }

  addPane(options: { id?: string } = {}): PaneHandle {
    this.hit('addPane');
    const id = options.id ?? `pane-${this.panes.size + 1}`;
    const state = { id, removed: false };
    this.panes.set(id, state);
    this.events.push(`add-pane:${id}`);
    return {
      id,
      applyOptions() {},
      remove: () => {
        if (state.removed) return;
        state.removed = true;
        this.panes.delete(id);
        this.events.push(`remove-pane:${id}`);
      },
    };
  }

  addSeries(type: SeriesType, options: SeriesOptions = {}): SeriesHandle {
    this.hit('addSeries');
    if (options.paneId !== undefined && options.paneId !== 'price' && !this.panes.has(options.paneId))
      throw new Error('Pane does not exist');
    const id = options.id ?? `series-${this.series.size + 1}`;
    const state: FakeSeries = {
      id,
      type,
      options: { ...options },
      data: [],
      updates: [],
      applies: [],
      removed: false,
    };
    this.series.set(id, state);
    this.events.push(`add-series:${id}`);
    return {
      id,
      type,
      setData: (data) => {
        this.hit('setData');
        this.transferredArrays.push(data as SeriesPoint[]);
        this.onSetData?.(id, data as SeriesPoint[]);
        state.data = data.map((point) => ({ ...point }));
        this.events.push(`set-data:${id}`);
      },
      update: (point) => {
        this.transferredPoints.push(point as SeriesPoint);
        this.updateSubmissions.push({ id, point: { ...point } });
        this.onUpdate?.(id, point as SeriesPoint);
        state.updates.push({ ...point });
        this.events.push(`update:${id}`);
      },
      applyOptions: (patch) => {
        this.hit('applyOptions');
        state.options = { ...state.options, ...patch };
        state.applies.push({ ...patch });
        this.events.push(`apply:${id}`);
      },
      getData: () => state.data.map((point) => ({ ...point })),
      remove: () => {
        if (state.removed) return;
        state.removed = true;
        if (this.series.get(id) === state) this.series.delete(id);
        this.events.push(`remove-series:${id}`);
      },
    };
  }

  api(): ChartApi {
    return this as unknown as ChartApi;
  }
}

const bars = [1, 2, 3, 4].map((close) => ({
  time: close,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 10,
}));

const single = (id: string, kind: TerminalSingleStudy['kind'] = 'sma'): TerminalSingleStudy => ({
  id,
  kind,
  period: kind === 'rsi' ? 2 : 3,
  color: '#c7ef57',
  lineWidth: 2,
  visible: true,
});

const macd = (id = 'study-1'): TerminalMacdStudy => ({
  id,
  kind: 'macd',
  fastPeriod: 2,
  slowPeriod: 3,
  signalPeriod: 2,
  color: '#7aa2f7',
  signalColor: '#e0af68',
  positiveColor: '#73c991',
  negativeColor: '#ef7c8e',
  lineWidth: 2,
  visible: true,
});

const bollinger = (id = 'study-2'): TerminalBollingerStudy => ({
  id,
  kind: 'bollinger',
  period: 2,
  multiplier: 2,
  color: '#c7ef57',
  upperColor: '#7aa2f7',
  lowerColor: '#7aa2f7',
  fillColor: '#7aa2f7',
  fillOpacity: 0.12,
  lineWidth: 2,
  visible: true,
});

describe('terminal grouped study runtime', () => {
  test('admits owned columns only with explicit permission, default factories and live capability', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const owned = vi.spyOn(privatePreparation, 'prepareOwnedBatch');
    try {
      const study = [single('scalar')];
      const chart = new FakeChart();
      const ordinary = new TerminalStudyRuntime(chart.api());
      ordinary.apply([], study, []);
      ordinary.rebuild(study, bars);
      expect(capability).not.toHaveBeenCalled();
      expect(owned).not.toHaveBeenCalled();

      const customChart = new FakeChart();
      const custom = new TerminalStudyRuntime(customChart.api(), {}, undefined, true);
      custom.apply([], study, []);
      custom.rebuild(study, bars);
      expect(owned).not.toHaveBeenCalled();

      capability.mockReturnValue(false);
      const unsupportedChart = new FakeChart();
      const unsupported = new TerminalStudyRuntime(unsupportedChart.api(), undefined, undefined, true);
      unsupported.apply([], study, []);
      unsupported.rebuild(study, bars);
      expect(owned).not.toHaveBeenCalled();
      expect(capability).toHaveBeenCalledTimes(1);
    } finally {
      owned.mockRestore();
      capability.mockRestore();
    }
  });

  test('publishes all owned outputs in descriptor order and retains old tail controllers', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const publication = vi
      .spyOn(chartInternal, 'setOwnedStudyColumns')
      .mockImplementation((chart, handle, points, input) => {
        const columnPoint = (column: { values: Float64Array; present: Uint8Array }, index: number) =>
          column.present[index] ? column.values[index] : undefined;
        const data = points.map((point, index) =>
          input.kind === 'scalar'
            ? columnPoint(input.column, index) === undefined
              ? { time: point.time }
              : { time: point.time, value: columnPoint(input.column, index)! }
            : columnPoint(input.upper, index) === undefined
              ? { time: point.time }
              : {
                  time: point.time,
                  upper: columnPoint(input.upper, index)!,
                  lower: columnPoint(input.lower, index)!,
                },
        );
        expect(chart).toBe(actual.api());
        handle.setData(data);
      });
    const studies: TerminalStudy[] = [
      single('sma'),
      single('ema', 'ema'),
      single('rsi', 'rsi'),
      macd(),
      bollinger(),
    ];
    const actual = new FakeChart(),
      reference = new FakeChart();
    const runtime = new TerminalStudyRuntime(actual.api(), undefined, undefined, true);
    const old = new TerminalStudyRuntime(reference.api(), {});
    try {
      runtime.apply([], studies, []);
      old.apply([], studies, []);
      for (const start of [3, 1, 0]) {
        publication.mockClear();
        runtime.rebuild(studies, bars.slice(start));
        old.rebuild(studies, bars.slice(start));
        expect(publication.mock.calls.map(([, handle, , input]) => [handle.id, input.kind])).toEqual([
          ['terminal-sma', 'scalar'],
          ['terminal-ema', 'scalar'],
          ['terminal-rsi', 'scalar'],
          ['terminal-study-1-macd', 'scalar'],
          ['terminal-study-1-signal', 'scalar'],
          ['terminal-study-1-histogram', 'scalar'],
          ['terminal-study-2-middle', 'scalar'],
          ['terminal-study-2-upper', 'scalar'],
          ['terminal-study-2-lower', 'scalar'],
          ['terminal-study-2-fill', 'band'],
        ]);
        expect([...actual.series.values()].map((series) => series.data)).toEqual(
          [...reference.series.values()].map((series) => series.data),
        );
      }
      const next = { ...bars[0]!, time: 5, close: 7 };
      runtime.update(next);
      old.update(next);
      expect([...actual.series.values()].map((series) => series.updates)).toEqual(
        [...reference.series.values()].map((series) => series.updates),
      );
    } finally {
      publication.mockRestore();
      capability.mockRestore();
    }
  });

  test('checks every owned Bollinger fill before the first study publication', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const original = privatePreparation.prepareOwnedBatch;
    const owned = vi.spyOn(privatePreparation, 'prepareOwnedBatch').mockImplementation((...args) => {
      const batch = original(...args);
      const bollinger = batch.studies.find((study) => study.kind === 'bollinger')!;
      bollinger.outputs.lower!.present[0] = 1;
      return batch;
    });
    const publication = vi.spyOn(chartInternal, 'setOwnedStudyColumns');
    try {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api(), undefined, undefined, true);
      const studies = [single('first'), bollinger()];
      runtime.apply([], studies, []);
      expect(() => runtime.rebuild(studies, bars)).toThrow('Bollinger boundaries must become ready together');
      expect(publication).not.toHaveBeenCalled();
    } finally {
      publication.mockRestore();
      owned.mockRestore();
      capability.mockRestore();
    }
  });

  test('decides chart capability before reading bars and finishes later math before any owned copy', () => {
    const events: string[] = [];
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockImplementation(() => {
      events.push('capability');
      return true;
    });
    const publication = vi.spyOn(chartInternal, 'setOwnedStudyColumns');
    try {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api(), undefined, undefined, true);
      const studies = [single('first'), macd()];
      runtime.apply([], studies, []);
      const input = [
        {
          ...bars[0]!,
          get close() {
            events.push('close');
            return 1;
          },
        },
      ];
      const invalid = [studies[0]!, { ...macd(), signalPeriod: 0 }];
      expect(() => runtime.rebuild(invalid, input)).toThrow();
      expect(events).toEqual(['capability', 'close']);
      expect(publication).not.toHaveBeenCalled();
    } finally {
      publication.mockRestore();
      capability.mockRestore();
    }
  });

  test('retains original per-series partial publication when a later owned copy fails', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const publication = vi
      .spyOn(chartInternal, 'setOwnedStudyColumns')
      .mockImplementation((_chart, handle, points, input) => {
        if (handle.id === 'terminal-second') throw new Error('injected owned copy');
        if (input.kind !== 'scalar') throw new Error('unexpected band');
        handle.setData(
          points.map((point, index) =>
            input.column.present[index]
              ? { time: point.time, value: input.column.values[index]! }
              : { time: point.time },
          ),
        );
      });
    try {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api(), undefined, undefined, true);
      const studies = [single('first'), single('second')];
      runtime.apply([], studies, []);
      expect(() => runtime.rebuild(studies, bars)).toThrow('injected owned copy');
      expect(publication.mock.calls.map(([, handle]) => handle.id)).toEqual([
        'terminal-first',
        'terminal-second',
      ]);
      expect(chart.series.get('terminal-first')!.data).toHaveLength(bars.length);
      expect(chart.series.get('terminal-second')!.data).toEqual([]);
    } finally {
      publication.mockRestore();
      capability.mockRestore();
    }
  });

  test('keeps a later arithmetic overflow ahead of every owned study copy', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const publication = vi.spyOn(chartInternal, 'setOwnedStudyColumns');
    try {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api(), undefined, undefined, true);
      const first = { ...single('first'), period: 1 };
      const studies = [first, macd()];
      runtime.apply([], studies, []);
      const overflowing = [
        Number.MAX_VALUE,
        Number.MAX_VALUE,
        Number.MAX_VALUE,
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
      ].map((close, time) => ({ ...bars[0]!, time, close }));
      const changed = [first, { ...macd(), fastPeriod: 1, slowPeriod: 4, signalPeriod: 1 }];
      expect(() => runtime.rebuild(changed, overflowing)).toThrow(
        'MACD output is outside the finite numeric range',
      );
      expect(publication).not.toHaveBeenCalled();
    } finally {
      publication.mockRestore();
      capability.mockRestore();
    }
  });

  test('keeps apply, restore, clear and tail update on public series methods after owned rebuild', () => {
    const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
    const publication = vi
      .spyOn(chartInternal, 'setOwnedStudyColumns')
      .mockImplementation((_chart, handle, points, input) => {
        if (input.kind !== 'scalar') throw new Error('unexpected band');
        handle.setData(
          points.map((point, index) =>
            input.column.present[index]
              ? { time: point.time, value: input.column.values[index]! }
              : { time: point.time },
          ),
        );
      });
    try {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api(), undefined, undefined, true);
      const studies = [single('first')];
      runtime.apply([], studies, bars);
      expect(publication).not.toHaveBeenCalled();
      expect(chart.transferredArrays).toHaveLength(1);
      runtime.rebuild(studies, bars);
      expect(publication).toHaveBeenCalledTimes(1);
      runtime.clear();
      expect(chart.transferredArrays.at(-1)).toEqual([]);
      runtime.update({ ...bars[0]!, time: 5 });
      expect(chart.updateSubmissions.at(-1)?.id).toBe('terminal-first');
      runtime.restore(studies, bars);
      expect(publication).toHaveBeenCalledTimes(1);
      expect(chart.transferredArrays.at(-1)).toHaveLength(bars.length);
    } finally {
      publication.mockRestore();
      capability.mockRestore();
    }
  });
  test('validates default rebuild history once for five independent studies', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    const studies = [single('sma'), single('ema', 'ema'), single('rsi', 'rsi'), macd(), bollinger()];
    runtime.apply([], studies, bars);
    const validation = vi.spyOn(indicatorValidation, 'validatePointInto');
    try {
      runtime.rebuild(studies, bars);
      expect(validation).toHaveBeenCalledTimes(bars.length);
    } finally {
      validation.mockRestore();
    }
  });

  test('replays prepended history and keeps batch calculators safe across chart mutation and reentry', () => {
    const studies: TerminalStudy[] = [
      { ...single('sma'), period: 200 },
      { ...single('ema', 'ema'), period: 20 },
      { ...single('rsi', 'rsi'), period: 14 },
      { ...macd(), fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      { ...bollinger(), period: 20 },
      { ...single('duplicate'), period: 200 },
    ];
    const source = Array.from({ length: 256 }, (_, i) => ({
      ...bars[0]!,
      time: i,
      close: 500 + Math.sin(i / 3) * 20 + i / 11,
    }));
    const actual = new FakeChart(),
      reference = new FakeChart();
    const runtime = new TerminalStudyRuntime(actual.api());
    const publicRuntime = new TerminalStudyRuntime(reference.api(), {});
    runtime.apply([], studies, []);
    publicRuntime.apply([], studies, []);
    for (const start of [220, 128, 0]) {
      runtime.rebuild(studies, source.slice(start));
      publicRuntime.rebuild(studies, source.slice(start));
      expect([...actual.series.values()].map((series) => series.data)).toEqual(
        [...reference.series.values()].map((series) => series.data),
      );
    }
    const nestedChart = new FakeChart();
    const nestedRuntime = new TerminalStudyRuntime(nestedChart.api());
    nestedRuntime.apply([], studies, []);
    let reentered = false;
    actual.onSetData = (_id, data) => {
      if (!reentered) {
        reentered = true;
        nestedRuntime.rebuild(
          studies,
          source.map((bar) => ({ ...bar, close: bar.close * 2 })),
        );
      }
      for (const point of data) {
        point.time = -1;
        if ('value' in point) point.value = -1000;
        if ('upper' in point) point.upper = -2000;
        if ('lower' in point) point.lower = -3000;
      }
      data.length = 0;
    };
    runtime.rebuild(studies, source);
    publicRuntime.rebuild(studies, source);
    expect(reentered).toBe(true);
    for (const point of [
      { time: 255, close: 620 },
      { time: 255, close: 610 },
      { time: 256, close: 630 },
    ]) {
      runtime.update({ ...bars[0]!, ...point });
      publicRuntime.update({ ...bars[0]!, ...point });
      expect(actual.updateSubmissions).toEqual(reference.updateSubmissions);
    }
    expect(nestedChart.series.get('terminal-sma')!.data).not.toEqual(
      reference.series.get('terminal-sma')!.data,
    );
  });

  test('finishes every batch calculation before publication and keeps prior state after later failure', () => {
    const studies = [single('first'), single('last', 'rsi')];
    const actual = new FakeChart(),
      reference = new FakeChart();
    const runtime = new TerminalStudyRuntime(actual.api());
    const control = new TerminalStudyRuntime(reference.api(), {});
    runtime.apply([], studies, bars);
    control.apply([], studies, bars);
    actual.events.length = 0;
    expect(() => runtime.rebuild([studies[0]!, { ...studies[1]!, period: 0 }], bars)).toThrow();
    expect(actual.events).toEqual([]);
    const overflow = [0, Number.MAX_VALUE, -Number.MAX_VALUE].map((close, time) => ({
      ...bars[0]!,
      time,
      close,
    }));
    expect(() => runtime.rebuild(studies, overflow)).toThrow();
    expect(actual.events).toEqual([]);
    const next = { ...bars[0]!, time: 5, close: 5 };
    runtime.update(next);
    control.update(next);
    expect(actual.updateSubmissions).toEqual(reference.updateSubmissions);
    runtime.rebuild(studies, bars);
    expect(actual.events.filter((event) => event.startsWith('set-data:'))).toHaveLength(2);
  });

  test('keeps supplied factory rebuild order and excludes empty and hidden-only batches', () => {
    const chart = new FakeChart();
    const events: string[] = [];
    const runtime = new TerminalStudyRuntime(chart.api(), {
      single(kind, period, domain) {
        events.push('create:' + kind);
        const source = createIndicator(kind, period, domain);
        return {
          ...source,
          setData(points) {
            events.push('set:' + kind);
            source.setData(points);
          },
          getData() {
            events.push('get:' + kind);
            return source.getData();
          },
        };
      },
    });
    const studies = [single('a'), single('b', 'ema')];
    runtime.apply([], studies, bars);
    const batch = vi.spyOn(privatePreparation, 'prepareBatch');
    try {
      events.length = 0;
      chart.onSetData = (id) => {
        events.push('write:' + id);
      };
      runtime.rebuild(studies, bars);
      expect(events).toEqual([
        'create:sma',
        'set:sma',
        'get:sma',
        'create:ema',
        'set:ema',
        'get:ema',
        'write:terminal-a',
        'write:terminal-b',
      ]);
      expect(batch).not.toHaveBeenCalled();
      new TerminalStudyRuntime(new FakeChart().api(), {}).rebuild([], bars);
      expect(batch).not.toHaveBeenCalled();
      const defaults = new TerminalStudyRuntime(new FakeChart().api());
      const invalid = [{ ...bars[0]!, close: NaN }];
      expect(() => defaults.rebuild([], invalid)).not.toThrow();
      expect(() =>
        defaults.rebuild([{ ...single('hidden'), period: 0, visible: false }], invalid),
      ).not.toThrow();
    } finally {
      batch.mockRestore();
    }
  });

  test('uses private preparation only when the factories argument is undefined', () => {
    const prepareScalar = vi.spyOn(privatePreparation, 'prepareScalar');
    const prepareMacd = vi.spyOn(privatePreparation, 'prepareMacd');
    const prepareBollinger = vi.spyOn(privatePreparation, 'prepareBollinger');
    const defaultChart = new FakeChart();
    new TerminalStudyRuntime(defaultChart.api()).apply([], [single('private'), macd(), bollinger()], bars);
    expect(prepareScalar).toHaveBeenCalledTimes(1);
    expect(prepareMacd).toHaveBeenCalledTimes(1);
    expect(prepareBollinger).toHaveBeenCalledTimes(1);

    const emptyChart = new FakeChart();
    new TerminalStudyRuntime(emptyChart.api(), {}).apply([], [single('empty')], bars);
    const explicitChart = new FakeChart();
    new TerminalStudyRuntime(explicitChart.api(), {
      single: createIndicator,
      macd: createMacd,
      bollinger: createBollingerBands,
    }).apply([], [single('explicit')], bars);

    expect(prepareScalar).toHaveBeenCalledTimes(1);
    expect(prepareMacd).toHaveBeenCalledTimes(1);
    expect(prepareBollinger).toHaveBeenCalledTimes(1);
    prepareScalar.mockRestore();
    prepareMacd.mockRestore();
    prepareBollinger.mockRestore();
  });

  test('keeps private study state safe when chart callbacks retain and mutate transferred history and update points', () => {
    const chart = new FakeChart();
    chart.onSetData = (_id, data) => {
      for (const point of data) {
        point.time = -100;
        if ('value' in point) point.value = 100_000;
        if ('upper' in point) point.upper = 100_000;
        if ('lower' in point) point.lower = -100_000;
        if ('macd' in point) point.macd = 100_000;
      }
      data.reverse();
      data.push({ time: -200, value: -200 });
    };
    chart.onUpdate = (_id, point) => {
      point.time = -300;
      if ('value' in point) point.value = 200_000;
      if ('middle' in point) point.middle = 200_000;
      if ('upper' in point) point.upper = 200_000;
      if ('lower' in point) point.lower = -200_000;
    };
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [single('scalar'), bollinger('bands')], bars);
    const retainedArrays = [...chart.transferredArrays];

    runtime.update({ ...bars[3]!, time: 5, close: 5 });
    runtime.update({ ...bars[3]!, time: 5, close: 7 });

    expect(chart.transferredArrays).toEqual(retainedArrays);
    expect(chart.transferredPoints).toHaveLength(10);
    expect(chart.updateSubmissions.filter((entry) => entry.id === 'terminal-scalar').at(-1)?.point).toEqual({
      time: 5,
      value: 14 / 3,
    });
    expect(
      chart.updateSubmissions.filter((entry) => entry.id === 'terminal-bands-middle').at(-1)?.point,
    ).toEqual({
      time: 5,
      value: 5.5,
    });
    expect(
      chart.updateSubmissions.filter((entry) => entry.id === 'terminal-bands-upper').at(-1)?.point,
    ).toEqual({
      time: 5,
      value: 8.5,
    });
    expect(
      chart.updateSubmissions.filter((entry) => entry.id === 'terminal-bands-lower').at(-1)?.point,
    ).toEqual({
      time: 5,
      value: 2.5,
    });
    expect(
      chart.updateSubmissions.filter((entry) => entry.id === 'terminal-bands-fill').at(-1)?.point,
    ).toEqual({
      time: 5,
      upper: 8.5,
      lower: 2.5,
    });
    expect(chart.transferredArrays.every((data) => data.length === bars.length + 1)).toBe(true);
  });

  test('does not write chart output when private preparation fails', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [bollinger()], bars);
    const previousMiddle = chart.series.get('terminal-study-2-middle')!.data;
    chart.events.length = 0;

    expect(() => runtime.rebuild([bollinger()], [bars[0]!, { ...bars[1]!, time: bars[0]!.time }])).toThrow();

    expect(chart.events).toEqual([]);
    expect(chart.series.get('terminal-study-2-middle')!.data).toEqual(previousMiddle);
  });

  test('keeps the prior controller when a later private output write fails', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [bollinger()], bars);
    const replacement = bars.map((bar) => ({ ...bar, close: bar.close * 10 }));
    chart.failOnce('setData', 4);

    expect(() => runtime.rebuild([bollinger()], replacement)).toThrow(/setData/);
    runtime.update({ ...bars[3]!, time: 5, close: 5 });

    expect(chart.series.get('terminal-study-2-middle')!.updates.at(-1)).toEqual({ time: 5, value: 4.5 });
    expect(chart.series.get('terminal-study-2-upper')!.updates.at(-1)).toEqual({ time: 5, value: 5.5 });
    expect(chart.series.get('terminal-study-2-lower')!.updates.at(-1)).toEqual({ time: 5, value: 3.5 });
    expect(chart.series.get('terminal-study-2-fill')!.updates.at(-1)).toEqual({
      time: 5,
      upper: 5.5,
      lower: 3.5,
    });
  });

  test('reads supplied factory getters once and preserves create, setData, getData order before chart writes', () => {
    const chart = new FakeChart();
    const events: string[] = [];
    const factories = {
      get single() {
        events.push('read-single');
        return (kind: TerminalSingleStudy['kind'], period: number) => {
          events.push(`create:${kind}:${period}`);
          return {
            setData(points: readonly { time: number; value?: number }[]) {
              events.push(`set:${points.length}`);
            },
            getData() {
              events.push('get');
              return [{ time: 1, value: 1 }];
            },
            update(point: { time: number; value: number }) {
              return point;
            },
          };
        };
      },
      get macd() {
        events.push('read-macd');
        return createMacd;
      },
      get bollinger() {
        events.push('read-bollinger');
        return createBollingerBands;
      },
    };

    new TerminalStudyRuntime(chart.api(), factories).apply([], [single('legacy')], bars);

    expect(events).toEqual(['read-single', 'read-macd', 'read-bollinger', 'create:sma:3', 'set:4', 'get']);
    expect(chart.events.filter((event) => event.startsWith('set-data:'))).toEqual([
      'set-data:terminal-legacy',
    ]);
  });

  test('propagates legacy getData throws without writing output series', () => {
    const chart = new FakeChart();
    const events: string[] = [];
    const factories = {
      single(kind: TerminalSingleStudy['kind'], period: number) {
        events.push(`create:${kind}:${period}`);
        return {
          setData(points: readonly { time: number; value?: number }[]) {
            events.push(`set:${points.length}`);
          },
          getData() {
            events.push('get');
            throw new Error('legacy snapshot failed');
          },
          update(point: { time: number; value: number }) {
            return point;
          },
        };
      },
    };

    expect(() =>
      new TerminalStudyRuntime(chart.api(), factories).apply([], [single('throws')], bars),
    ).toThrow('legacy snapshot failed');

    expect(events).toEqual(['create:sma:3', 'set:4', 'get']);
    expect(chart.events).toEqual([]);
  });

  test('private clear resets the controller and rebuild adopts a fresh prepared controller', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [single('reset')], bars);
    runtime.clear();
    runtime.update({ ...bars[0]!, time: 1, close: 9 });
    expect(chart.series.get('terminal-reset')!.updates.at(-1)).toEqual({ time: 1 });

    runtime.rebuild([single('reset')], bars);
    runtime.update({ ...bars[3]!, time: 5, close: 5 });
    expect(chart.series.get('terminal-reset')!.updates.at(-1)).toEqual({ time: 5, value: 4 });
  });

  test('hydrates named MACD and Bollinger outputs with exact identities, styles, panes, and fill data', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [macd(), bollinger()], bars);

    expect([...chart.panes.keys()]).toEqual(['terminal-study-1-pane']);
    expect([...chart.series.keys()]).toEqual([
      'terminal-study-1-macd',
      'terminal-study-1-signal',
      'terminal-study-1-histogram',
      'terminal-study-2-middle',
      'terminal-study-2-upper',
      'terminal-study-2-lower',
      'terminal-study-2-fill',
    ]);

    const macdLine = chart.series.get('terminal-study-1-macd')!;
    const signal = chart.series.get('terminal-study-1-signal')!;
    const histogram = chart.series.get('terminal-study-1-histogram')!;
    expect(macdLine.options).toMatchObject({
      paneId: 'terminal-study-1-pane',
      title: 'MACD 2/3/2',
      color: '#7aa2f7',
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: false,
    });
    expect(signal.options).toMatchObject({
      paneId: 'terminal-study-1-pane',
      title: '',
      color: '#e0af68',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(histogram.type).toBe('histogram');
    expect(histogram.options).toMatchObject({
      paneId: 'terminal-study-1-pane',
      title: '',
      upColor: '#73c991',
      downColor: '#ef7c8e',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(histogram.options).not.toHaveProperty('color');
    expect(macdLine.data).toEqual([
      { time: 1 },
      { time: 2 },
      { time: 3, value: 0.5 },
      { time: 4, value: 0.5 },
    ]);
    expect(signal.data).toEqual([{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4, value: 0.5 }]);
    expect(histogram.data).toEqual([{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4, value: 0 }]);

    const middle = chart.series.get('terminal-study-2-middle')!;
    const upper = chart.series.get('terminal-study-2-upper')!;
    const lower = chart.series.get('terminal-study-2-lower')!;
    const fill = chart.series.get('terminal-study-2-fill')!;
    expect(middle.options).toMatchObject({
      title: 'BB 2 × 2',
      color: '#c7ef57',
      lastValueVisible: true,
      priceLineVisible: false,
    });
    expect(upper.options).toMatchObject({
      title: '',
      color: '#7aa2f7',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(lower.options).toMatchObject({
      title: '',
      color: '#7aa2f7',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(fill.type).toBe('band');
    expect(fill.options).toMatchObject({
      title: '',
      color: '#7aa2f7',
      fillOpacity: 0.12,
      connectGaps: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    expect(fill.data).toEqual([
      { time: 1 },
      { time: 2, lower: 0.5, upper: 2.5 },
      { time: 3, lower: 1.5, upper: 3.5 },
      { time: 4, lower: 2.5, upper: 4.5 },
    ]);
  });

  test('same-id scalar to MACD replacement keeps the new oscillator pane alive for every output', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    const previous: TerminalStudy[] = [single('study-1')];
    runtime.apply([], previous, bars);

    runtime.apply(previous, [macd('study-1')], bars);

    expect([...chart.panes.keys()]).toEqual(['terminal-study-1-pane']);
    expect([...chart.series.keys()]).toEqual([
      'terminal-study-1-macd',
      'terminal-study-1-signal',
      'terminal-study-1-histogram',
    ]);
  });

  test.each([
    ['RSI to MACD', single('study-1', 'rsi'), macd('study-1')],
    ['MACD to RSI', macd('study-1'), single('study-1', 'rsi')],
  ] as const)(
    'same-id %s replacement keeps every output on one dedicated pane through style and tail work',
    (_, from, to) => {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api());
      runtime.apply([], [from], bars);
      const oldHandles = [...chart.series.values()];

      runtime.apply([from], [to], bars);

      const expectedIds =
        to.kind === 'macd'
          ? ['terminal-study-1-macd', 'terminal-study-1-signal', 'terminal-study-1-histogram']
          : ['terminal-study-1'];
      expect([...chart.panes.keys()]).toEqual(['terminal-study-1-pane']);
      expect([...chart.series.keys()]).toEqual(expectedIds);
      expect(oldHandles.every((handle) => handle.removed)).toBe(true);
      for (const id of expectedIds)
        expect(chart.series.get(id)!.options.paneId).toBe('terminal-study-1-pane');

      const styled: TerminalStudy =
        to.kind === 'macd' ? { ...to, signalColor: '#112233' } : { ...to, color: '#112233' };
      chart.events.length = 0;
      runtime.apply([to], [styled], []);
      runtime.update({ ...bars[3]!, time: 5, close: 7 });

      expect([...chart.panes.keys()]).toEqual(['terminal-study-1-pane']);
      expect([...chart.series.keys()]).toEqual(expectedIds);
      for (const id of expectedIds) {
        const output = chart.series.get(id)!;
        expect(output.options.paneId).toBe('terminal-study-1-pane');
        expect(output.updates).toHaveLength(1);
      }
      expect(chart.events.some((event) => event.startsWith('add-pane:'))).toBe(false);
      expect(chart.events.some((event) => event.startsWith('remove-pane:'))).toBe(false);
    },
  );

  test('tail and style work avoids calculator history, series hydration, and resource recreation', () => {
    const chart = new FakeChart();
    const counts = { create: 0, setData: 0, getData: 0, update: 0 };
    const factories = {
      single(kind: TerminalSingleStudy['kind'], period: number) {
        counts.create++;
        const calculator = createIndicator(kind, period, 'utc-ms');
        return {
          setData(points: Parameters<typeof calculator.setData>[0]) {
            counts.setData++;
            calculator.setData(points);
          },
          getData() {
            counts.getData++;
            return calculator.getData();
          },
          update(point: Parameters<typeof calculator.update>[0]) {
            counts.update++;
            return calculator.update(point);
          },
        };
      },
      macd(options: MacdOptions) {
        counts.create++;
        const calculator = createMacd(options, 'utc-ms');
        return {
          setData(points: Parameters<typeof calculator.setData>[0]) {
            counts.setData++;
            calculator.setData(points);
          },
          getData() {
            counts.getData++;
            return calculator.getData();
          },
          update(point: Parameters<typeof calculator.update>[0]) {
            counts.update++;
            return calculator.update(point);
          },
        };
      },
      bollinger(options: BollingerBandsOptions) {
        counts.create++;
        const calculator = createBollingerBands(options, 'utc-ms');
        return {
          setData(points: Parameters<typeof calculator.setData>[0]) {
            counts.setData++;
            calculator.setData(points);
          },
          getData() {
            counts.getData++;
            return calculator.getData();
          },
          update(point: Parameters<typeof calculator.update>[0]) {
            counts.update++;
            return calculator.update(point);
          },
        };
      },
    };
    const studies: TerminalStudy[] = [macd(), bollinger()];
    const runtime = new TerminalStudyRuntime(chart.api(), factories);
    runtime.apply([], studies, bars);
    expect(counts).toEqual({ create: 2, setData: 2, getData: 2, update: 0 });
    chart.events.length = 0;
    counts.create = counts.setData = counts.getData = counts.update = 0;

    runtime.update({ ...bars[3]!, time: 5, close: 5 });
    runtime.update({ ...bars[3]!, time: 5, close: 6 });
    const styled: TerminalStudy[] = [
      { ...macd(), signalColor: '#112233', positiveColor: '#445566', lineWidth: 4 },
      { ...bollinger(), fillColor: '#abcdef', fillOpacity: 0, upperColor: '#fedcba' },
    ];
    runtime.apply(studies, styled, []);

    expect(counts).toEqual({ create: 0, setData: 0, getData: 0, update: 4 });
    expect(chart.events.filter((event) => event.startsWith('update:'))).toHaveLength(14);
    expect(chart.events.some((event) => event.startsWith('set-data:'))).toBe(false);
    expect(chart.events.some((event) => event.startsWith('add-series:'))).toBe(false);
    expect(chart.events.some((event) => event.startsWith('add-pane:'))).toBe(false);
    expect(chart.series.get('terminal-study-1-histogram')!.options).toMatchObject({
      upColor: '#445566',
      downColor: '#ef7c8e',
    });
    expect(chart.series.get('terminal-study-2-fill')!.options).toMatchObject({
      color: '#abcdef',
      fillOpacity: 0,
    });
  });

  test('rehydrates only calculation-changed visible groups and allocates nothing for hidden parameter changes', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    const initial: TerminalStudy[] = [macd(), bollinger()];
    runtime.apply([], initial, bars);
    chart.events.length = 0;

    const changed: TerminalStudy[] = [{ ...macd(), signalPeriod: 3 }, bollinger()];
    runtime.apply(initial, changed, bars);
    expect(
      chart.events.filter((event) => event.startsWith('set-data:')).map((event) => event.slice(9)),
    ).toEqual(['terminal-study-1-macd', 'terminal-study-1-signal', 'terminal-study-1-histogram']);
    expect(chart.events.some((event) => event.startsWith('add-'))).toBe(false);

    runtime.apply(changed, [changed[0]!, { ...bollinger(), visible: false }], []);
    chart.events.length = 0;
    runtime.apply(
      [changed[0]!, { ...bollinger(), visible: false }],
      [changed[0]!, { ...bollinger(), visible: false, period: 5, multiplier: 3 }],
      [],
    );
    expect(chart.events).toEqual([]);
  });

  test.each([
    ['addSeries', 1],
    ['addSeries', 2],
    ['addSeries', 3],
    ['addSeries', 4],
    ['setData', 1],
    ['setData', 2],
    ['setData', 3],
    ['setData', 4],
  ] as const)(
    'rolls back a new four-output group after injected %s failure at position %i',
    (operation, at) => {
      const chart = new FakeChart();
      const runtime = new TerminalStudyRuntime(chart.api());
      const previous: TerminalStudy[] = [single('study-1')];
      runtime.apply([], previous, bars);
      chart.failOnce(operation, at);
      expect(() => runtime.apply(previous, [previous[0]!, bollinger('study-2')], bars)).toThrow(
        new RegExp(operation),
      );
      expect([...chart.series.keys()]).toEqual(['terminal-study-1']);
      expect([...chart.panes.keys()]).toEqual([]);
    },
  );

  test.each([1, 2, 3, 4])('rolls back all grouped styles after failure at output position %i', (at) => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    const previous = [bollinger()];
    runtime.apply([], previous, bars);
    chart.failOnce('applyOptions', at);
    expect(() => runtime.apply(previous, [{ ...bollinger(), lineWidth: 4, fillOpacity: 0.5 }], [])).toThrow(
      /applyOptions/,
    );
    expect([...chart.series.keys()]).toEqual([
      'terminal-study-2-middle',
      'terminal-study-2-upper',
      'terminal-study-2-lower',
      'terminal-study-2-fill',
    ]);
    expect(chart.series.get('terminal-study-2-middle')!.options.lineWidth).toBe(2);
    expect(chart.series.get('terminal-study-2-fill')!.options.fillOpacity).toBe(0.12);
  });

  test('orders combined RSI and MACD panes by visible registry and releases every series before panes', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    const studies: TerminalStudy[] = [macd('study-1'), single('study-2', 'rsi')];
    runtime.apply([], studies, bars);
    expect([...chart.panes.keys()]).toEqual(['terminal-study-1-pane', 'terminal-study-2-pane']);

    chart.events.length = 0;
    runtime.apply(studies, [], []);
    const firstPaneRemoval = chart.events.findIndex((event) => event.startsWith('remove-pane:'));
    const lastSeriesFromEnd = [...chart.events]
      .reverse()
      .findIndex((event) => event.startsWith('remove-series:'));
    const lastSeriesRemoval = chart.events.length - 1 - lastSeriesFromEnd;
    expect(firstPaneRemoval).toBeGreaterThan(lastSeriesRemoval);
    expect(chart.series.size).toBe(0);
    expect(chart.panes.size).toBe(0);
  });

  test('whole-chart retirement releases runtime references without per-resource removals or calculator callbacks', () => {
    const chart = new FakeChart();
    const mutatePane = vi.fn();
    const runtime = new TerminalStudyRuntime(chart.api(), undefined, <T>(work: () => T): T => {
      mutatePane();
      return work();
    });
    runtime.apply([], [single('scalar'), single('rsi', 'rsi'), macd(), bollinger()], bars);
    // Inspect reference ownership, including a loose pane left by partial composition.
    // This does not add a public diagnostic surface to the runtime.
    const owned = runtime as unknown as {
      resources: Map<
        string,
        { outputs: Map<string, SeriesHandle>; pane: PaneHandle | null; calculator: { clear(): void } }
      >;
      loosePanes: Set<PaneHandle>;
      oscillatorOrder: string[];
    };
    const retained = [...owned.resources.values()];
    const clear = retained.map((resource) => vi.spyOn(resource.calculator, 'clear'));
    owned.loosePanes.add(chart.addPane({ id: 'orphaned-pending-pane' }));
    expect(owned.resources.size).toBe(4);
    expect(owned.loosePanes.size).toBe(1);
    expect(owned.oscillatorOrder).toHaveLength(2);
    // The owning chart has already discharged its stores/panes; no individual
    // handle may be invoked by the following reference-only release.
    chart.series.clear();
    chart.panes.clear();
    chart.events.length = 0;
    mutatePane.mockClear();
    runtime.releaseAfterChartDestroy();
    runtime.releaseAfterChartDestroy();
    runtime.destroy();
    expect(chart.events).toEqual([]);
    expect(mutatePane).not.toHaveBeenCalled();
    expect(clear.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(owned.resources.size).toBe(0);
    expect(owned.loosePanes.size).toBe(0);
    expect(owned.oscillatorOrder).toEqual([]);
    expect(retained.every((resource) => resource.outputs.size === 0 && resource.pane === null)).toBe(true);
  });

  test('live-chart restore still removes old output handles and oscillator panes', () => {
    const chart = new FakeChart();
    const runtime = new TerminalStudyRuntime(chart.api());
    runtime.apply([], [macd()], bars);
    chart.events.length = 0;
    runtime.restore([single('replacement')], bars);
    expect(chart.events.filter((event) => event.startsWith('remove-series:'))).toHaveLength(3);
    expect(chart.events.filter((event) => event.startsWith('remove-pane:'))).toEqual([
      'remove-pane:terminal-study-1-pane',
    ]);
    expect([...chart.series.keys()]).toEqual(['terminal-replacement']);
    expect(chart.panes.size).toBe(0);
  });
});
