import type {
  ChartApi,
  PaneHandle,
  SeriesHandle,
  SeriesOptions,
  SeriesPoint,
  SeriesType,
} from '@filtix/charts';
import { hasOwnedStudyColumnCapability, setOwnedStudyColumns } from '@filtix/charts/internal';
import type { MarketBar } from '@filtix/datafeed';
import {
  createBollingerBands,
  createIndicator,
  createMacd,
  type BollingerBandsResult,
  type IndicatorPoint,
  type MacdResult,
  type StreamingBollingerBands,
  type StreamingIndicator,
  type StreamingMacd,
} from '@filtix/indicators';
import {
  prepareBatch,
  prepareOwnedBatch,
  prepareBollinger,
  prepareMacd,
  prepareScalar,
  type PreparationRequest,
  type ScalarColumns,
} from '@filtix/indicators/internal';
import { copyStudy, sameStudy, studyCalculationChanged } from './studies';
import type { TerminalStudy } from './types';

type OutputKey = 'value' | 'macd' | 'signal' | 'histogram' | 'middle' | 'upper' | 'lower' | 'fill';

interface RuntimeCalculator {
  clear(): void;
  update(point: IndicatorPoint): Readonly<Partial<Record<OutputKey, SeriesPoint>>>;
}

interface PreparedStudy {
  calculator: RuntimeCalculator;
  data: Readonly<Partial<Record<OutputKey, readonly SeriesPoint[]>>>;
}

interface PreparedOwnedStudy {
  calculator: RuntimeCalculator;
  outputs: Record<string, ScalarColumns>;
}

interface StudyResource {
  study: TerminalStudy;
  calculator: RuntimeCalculator;
  outputs: Map<OutputKey, SeriesHandle>;
  pane: PaneHandle | null;
}

interface OutputDescriptor {
  key: OutputKey;
  type: SeriesType;
  id: string;
  options: SeriesOptions;
}

export interface TerminalStudyRuntimeFactories {
  single: typeof createIndicator;
  macd: typeof createMacd;
  bollinger: typeof createBollingerBands;
}

const DEFAULT_FACTORIES: TerminalStudyRuntimeFactories = {
  single: createIndicator,
  macd: createMacd,
  bollinger: createBollingerBands,
};

function singleSeriesId(study: TerminalStudy): string {
  return study.id === 'terminal-ema' ? study.id : `terminal-${study.id}`;
}

function outputSeriesId(study: TerminalStudy, output: OutputKey): string {
  return `terminal-${study.id}-${output}`;
}

function paneId(study: TerminalStudy): string {
  return `terminal-${study.id}-pane`;
}

function scalarTitle(study: Extract<TerminalStudy, { kind: 'sma' | 'ema' | 'rsi' }>): string {
  return `${study.kind.toUpperCase()} ${study.period}`;
}

function macdTitle(study: Extract<TerminalStudy, { kind: 'macd' }>): string {
  return `MACD ${study.fastPeriod}/${study.slowPeriod}/${study.signalPeriod}`;
}

function bollingerTitle(study: Extract<TerminalStudy, { kind: 'bollinger' }>): string {
  return `BB ${study.period} × ${study.multiplier}`;
}

function isOscillator(study: TerminalStudy): boolean {
  return study.kind === 'rsi' || study.kind === 'macd';
}

function scalarCalculator(calculator: StreamingIndicator): RuntimeCalculator {
  return {
    clear() {
      calculator.setData([]);
    },
    update(point) {
      return { value: calculator.update(point) };
    },
  };
}

function macdCalculator(calculator: StreamingMacd): RuntimeCalculator {
  return {
    clear() {
      calculator.setData([]);
    },
    update(point) {
      return calculator.update(point);
    },
  };
}

function fillPoint(upper: IndicatorPoint | undefined, lower: IndicatorPoint | undefined): SeriesPoint {
  if (!upper || !lower || upper.time !== lower.time)
    throw new Error('Bollinger outputs must be aligned by time');
  const upperValue = 'value' in upper ? upper.value : undefined;
  const lowerValue = 'value' in lower ? lower.value : undefined;
  if (upperValue === undefined && lowerValue === undefined) return { time: upper.time };
  if (upperValue === undefined || lowerValue === undefined)
    throw new Error('Bollinger boundaries must become ready together');
  return { time: upper.time, upper: upperValue, lower: lowerValue };
}

function fillData(result: BollingerBandsResult<IndicatorPoint[]>): SeriesPoint[] {
  if (result.upper.length !== result.lower.length)
    throw new Error('Bollinger outputs must have equal lengths');
  return result.upper.map((upper, index) => fillPoint(upper, result.lower[index]));
}

function bollingerCalculator(calculator: StreamingBollingerBands): RuntimeCalculator {
  return {
    clear() {
      calculator.setData([]);
    },
    update(point) {
      const result = calculator.update(point);
      return { ...result, fill: fillPoint(result.upper, result.lower) };
    },
  };
}

function preparedScalarCalculator(
  controller: ReturnType<typeof prepareScalar>['controller'],
): RuntimeCalculator {
  return {
    clear() {
      controller.reset();
    },
    update(point) {
      return { value: controller.update(point) };
    },
  };
}

function preparedMacdCalculator(controller: ReturnType<typeof prepareMacd>['controller']): RuntimeCalculator {
  return {
    clear() {
      controller.reset();
    },
    update(point) {
      return controller.update(point);
    },
  };
}

function preparedBollingerCalculator(
  controller: ReturnType<typeof prepareBollinger>['controller'],
): RuntimeCalculator {
  return {
    clear() {
      controller.reset();
    },
    update(point) {
      const result = controller.update(point);
      return { ...result, fill: fillPoint(result.upper, result.lower) };
    },
  };
}

function prepare(
  study: TerminalStudy,
  closes: readonly IndicatorPoint[],
  factories: TerminalStudyRuntimeFactories,
  usePrivatePreparation: boolean,
): PreparedStudy {
  if (usePrivatePreparation) {
    if (study.kind === 'macd') {
      const prepared = prepareMacd(
        {
          fastPeriod: study.fastPeriod,
          slowPeriod: study.slowPeriod,
          signalPeriod: study.signalPeriod,
        },
        closes,
        'utc-ms',
      );
      const data = prepared.data;
      const controller = prepared.controller;
      return { calculator: preparedMacdCalculator(controller), data };
    }
    if (study.kind === 'bollinger') {
      const prepared = prepareBollinger(
        { period: study.period, multiplier: study.multiplier },
        closes,
        'utc-ms',
      );
      const data = prepared.data;
      const controller = prepared.controller;
      const withFill = { ...data, fill: fillData(data) };
      return { calculator: preparedBollingerCalculator(controller), data: withFill };
    }
    const prepared = prepareScalar(study.kind, study.period, closes, 'utc-ms');
    const data = { value: prepared.data };
    const controller = prepared.controller;
    return { calculator: preparedScalarCalculator(controller), data };
  }

  if (study.kind === 'macd') {
    const source = factories.macd(
      {
        fastPeriod: study.fastPeriod,
        slowPeriod: study.slowPeriod,
        signalPeriod: study.signalPeriod,
      },
      'utc-ms',
    );
    source.setData(closes);
    return { calculator: macdCalculator(source), data: source.getData() };
  } else if (study.kind === 'bollinger') {
    const source = factories.bollinger({ period: study.period, multiplier: study.multiplier }, 'utc-ms');
    source.setData(closes);
    const result = source.getData();
    return {
      calculator: bollingerCalculator(source),
      data: { ...result, fill: fillData(result) },
    };
  } else {
    const source = factories.single(study.kind, study.period, 'utc-ms');
    source.setData(closes);
    return { calculator: scalarCalculator(source), data: { value: source.getData() } };
  }
}

function prepareDefaultRebuild(
  studies: readonly TerminalStudy[],
  closes: readonly IndicatorPoint[],
): Map<string, PreparedStudy> {
  const ids: string[] = [];
  const results = prepareBatch(defaultRequests(studies, ids), closes, 'utc-ms');
  const prepared = new Map<string, PreparedStudy>();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    if (result.kind === 'macd') {
      prepared.set(ids[index]!, {
        calculator: preparedMacdCalculator(result.prepared.controller),
        data: result.prepared.data,
      });
    } else if (result.kind === 'bollinger') {
      const data = result.prepared.data;
      prepared.set(ids[index]!, {
        calculator: preparedBollingerCalculator(result.prepared.controller),
        data: { ...data, fill: fillData(data) },
      });
    } else {
      prepared.set(ids[index]!, {
        calculator: preparedScalarCalculator(result.prepared.controller),
        data: { value: result.prepared.data },
      });
    }
  }
  // The batch result array dies here, before chart publication and entry release.
  return prepared;
}

function* defaultRequests(studies: readonly TerminalStudy[], ids: string[]): Iterable<PreparationRequest> {
  for (const study of studies) {
    if (!study.visible) continue;
    ids.push(study.id);
    if (study.kind === 'macd') {
      yield {
        kind: study.kind,
        options: {
          fastPeriod: study.fastPeriod,
          slowPeriod: study.slowPeriod,
          signalPeriod: study.signalPeriod,
        },
      };
    } else if (study.kind === 'bollinger') {
      yield { kind: study.kind, options: { period: study.period, multiplier: study.multiplier } };
    } else {
      yield { kind: study.kind, period: study.period };
    }
  }
}

function checkOwnedFill(
  points: readonly { time: number }[],
  upper: ScalarColumns,
  lower: ScalarColumns,
): void {
  if (upper.values.length !== lower.values.length)
    throw new Error('Bollinger outputs must have equal lengths');
  if (
    upper.values.length !== points.length ||
    upper.present.length !== points.length ||
    lower.present.length !== points.length
  )
    throw new Error('Bollinger outputs must be aligned by time');
  for (let index = 0; index < points.length; index += 1)
    if (upper.present[index] !== lower.present[index])
      throw new Error('Bollinger boundaries must become ready together');
}

function prepareOwnedDefaultRebuild(
  studies: readonly TerminalStudy[],
  closes: readonly (IndicatorPoint & { time: number })[],
): Map<string, PreparedOwnedStudy> {
  const ids: string[] = [];
  const batch = prepareOwnedBatch(defaultRequests(studies, ids), closes, 'utc-ms');
  const prepared = new Map<string, PreparedOwnedStudy>();
  // All mathematics has completed before checking any fill or publishing a store.
  for (let index = 0; index < batch.studies.length; index += 1) {
    const result = batch.studies[index]!;
    if (result.kind === 'macd') {
      prepared.set(ids[index]!, {
        calculator: preparedMacdCalculator(result.controller as ReturnType<typeof prepareMacd>['controller']),
        outputs: result.outputs,
      });
    } else if (result.kind === 'bollinger') {
      checkOwnedFill(batch.points, result.outputs.upper!, result.outputs.lower!);
      prepared.set(ids[index]!, {
        calculator: preparedBollingerCalculator(
          result.controller as ReturnType<typeof prepareBollinger>['controller'],
        ),
        outputs: result.outputs,
      });
    } else {
      prepared.set(ids[index]!, {
        calculator: preparedScalarCalculator(
          result.controller as ReturnType<typeof prepareScalar>['controller'],
        ),
        outputs: result.outputs,
      });
    }
  }
  return prepared;
}

function ownedOutput(prepared: PreparedOwnedStudy, key: OutputKey): ScalarColumns {
  const column = prepared.outputs[key];
  if (!column) throw new Error(`Missing prepared study output: ${key}`);
  return column;
}

function outputDescriptors(study: TerminalStudy, pane: PaneHandle | null): OutputDescriptor[] {
  const sharedPane = pane ? { paneId: pane.id } : {};
  if (study.kind === 'macd')
    return [
      {
        key: 'macd',
        type: 'line',
        id: outputSeriesId(study, 'macd'),
        options: {
          ...sharedPane,
          title: macdTitle(study),
          color: study.color,
          lineWidth: study.lineWidth,
          lastValueVisible: true,
          priceLineVisible: false,
        },
      },
      {
        key: 'signal',
        type: 'line',
        id: outputSeriesId(study, 'signal'),
        options: {
          ...sharedPane,
          title: '',
          color: study.signalColor,
          lineWidth: study.lineWidth,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
      {
        key: 'histogram',
        type: 'histogram',
        id: outputSeriesId(study, 'histogram'),
        options: {
          ...sharedPane,
          title: '',
          upColor: study.positiveColor,
          downColor: study.negativeColor,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
    ];
  if (study.kind === 'bollinger')
    return [
      {
        key: 'middle',
        type: 'line',
        id: outputSeriesId(study, 'middle'),
        options: {
          title: bollingerTitle(study),
          color: study.color,
          lineWidth: study.lineWidth,
          lastValueVisible: true,
          priceLineVisible: false,
        },
      },
      {
        key: 'upper',
        type: 'line',
        id: outputSeriesId(study, 'upper'),
        options: {
          title: '',
          color: study.upperColor,
          lineWidth: study.lineWidth,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
      {
        key: 'lower',
        type: 'line',
        id: outputSeriesId(study, 'lower'),
        options: {
          title: '',
          color: study.lowerColor,
          lineWidth: study.lineWidth,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
      {
        key: 'fill',
        type: 'band',
        id: outputSeriesId(study, 'fill'),
        options: {
          title: '',
          color: study.fillColor,
          fillOpacity: study.fillOpacity,
          connectGaps: false,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
    ];
  return [
    {
      key: 'value',
      type: 'line',
      id: singleSeriesId(study),
      options: {
        ...sharedPane,
        title: scalarTitle(study),
        color: study.color,
        lineWidth: study.lineWidth,
        priceLineVisible: false,
      },
    },
  ];
}

function optionPatch(descriptor: OutputDescriptor): SeriesOptions {
  return { ...descriptor.options };
}

function outputData(prepared: PreparedStudy, key: OutputKey): readonly SeriesPoint[] {
  const data = prepared.data[key];
  if (!data) throw new Error(`Missing prepared study output: ${key}`);
  return data;
}

function outputPoint(result: ReturnType<RuntimeCalculator['update']>, key: OutputKey): SeriesPoint {
  const point = result[key];
  if (!point) throw new Error(`Missing study update output: ${key}`);
  return point;
}

export class TerminalStudyRuntime {
  private readonly resources = new Map<string, StudyResource>();
  private oscillatorOrder: string[] = [];
  private readonly loosePanes = new Set<PaneHandle>();
  private readonly factories: TerminalStudyRuntimeFactories;
  private readonly usePrivatePreparation: boolean;

  constructor(
    chart: ChartApi,
    factories?: Partial<TerminalStudyRuntimeFactories>,
    private readonly mutatePane: <T>(work: () => T) => T = (work) => work(),
    private readonly allowOwnedStudyColumns = false,
  ) {
    this.chart = chart;
    this.usePrivatePreparation = factories === undefined;
    this.factories = { ...DEFAULT_FACTORIES, ...factories };
  }

  private readonly chart: ChartApi;

  apply(
    previous: readonly TerminalStudy[],
    next: readonly TerminalStudy[],
    bars: readonly MarketBar[],
    rollbackBars: () => readonly MarketBar[] = () => bars,
  ): void {
    try {
      this.applyUnsafe(previous, next, bars);
    } catch (error) {
      this.destroy();
      try {
        this.applyUnsafe([], previous, rollbackBars());
      } catch {
        this.destroy();
      }
      throw error;
    }
  }

  restore(studies: readonly TerminalStudy[], bars: readonly MarketBar[]): void {
    this.destroy();
    this.applyUnsafe([], studies, bars);
  }

  /** Restore terminal order after append-only volume creation without rebuilding outputs. */
  reconcileVolumeOrder(studies: readonly TerminalStudy[]): void {
    const panes = this.chart.getPaneLayout().panes;
    const volumeIndex = panes.findIndex((pane) => pane.id === 'terminal-volume-pane');
    if (volumeIndex < 0) return;
    const oscillators = studies.filter((study) => study.visible && isOscillator(study));
    if (
      !oscillators.some((study) => {
        const index = panes.findIndex((pane) => pane.id === paneId(study));
        return index >= 0 && index < volumeIndex;
      })
    )
      return;
    this.reconcileOscillatorPanes(oscillators);
  }

  private applyUnsafe(
    previous: readonly TerminalStudy[],
    next: readonly TerminalStudy[],
    bars: readonly MarketBar[],
  ): void {
    const closes = bars.map((bar) => ({ time: bar.time, value: bar.close }));
    const previousById = new Map(previous.map((study) => [study.id, study]));
    const prepared = new Map<string, PreparedStudy>();
    for (const study of next) {
      const old = previousById.get(study.id);
      if (study.visible && (!old?.visible || studyCalculationChanged(old, study)))
        prepared.set(study.id, prepare(study, closes, this.factories, this.usePrivatePreparation));
    }

    const desiredOscillators = next.filter((study) => study.visible && isOscillator(study));
    const topologyChanged =
      desiredOscillators.length !== this.oscillatorOrder.length ||
      desiredOscillators.some(
        (study, index) =>
          study.id !== this.oscillatorOrder[index] || this.resources.get(study.id)?.study.kind !== study.kind,
      );
    const pendingPanes = topologyChanged
      ? this.reconcileOscillatorPanes(desiredOscillators)
      : new Map<string, PaneHandle>();

    for (const study of next) {
      if (!study.visible) continue;
      const ready = prepared.get(study.id);
      let resource = this.resources.get(study.id);
      if (resource && resource.study.kind !== study.kind) {
        this.removeResource(resource);
        this.resources.delete(study.id);
        resource = undefined;
      }
      if (!resource) {
        if (!ready) throw new Error(`Missing prepared study: ${study.id}`);
        const pane = isOscillator(study) ? (pendingPanes.get(study.id) ?? null) : null;
        resource = this.createResource(study, ready, pane);
        this.resources.set(study.id, resource);
        if (pane) this.loosePanes.delete(pane);
        continue;
      }

      if (ready) {
        for (const descriptor of outputDescriptors(study, resource.pane))
          resource.outputs.get(descriptor.key)!.setData(outputData(ready, descriptor.key));
        resource.calculator = ready.calculator;
      }
      if (!sameStudy(resource.study, study)) {
        for (const descriptor of outputDescriptors(study, resource.pane))
          resource.outputs.get(descriptor.key)!.applyOptions(optionPatch(descriptor));
      }
      resource.study = copyStudy(study);
    }

    const desiredIds = new Set(next.filter((study) => study.visible).map((study) => study.id));
    for (const [id, resource] of [...this.resources]) {
      if (desiredIds.has(id)) continue;
      this.removeResource(resource);
      this.resources.delete(id);
    }
  }

  private reconcileOscillatorPanes(desired: readonly TerminalStudy[]): Map<string, PaneHandle> {
    const desiredIds = new Set(desired.map((study) => study.id));
    const removed = this.oscillatorOrder
      .filter((id) => !desiredIds.has(id))
      .map((id) => [id, this.resources.get(id)] as const)
      .filter((entry): entry is readonly [string, StudyResource] => entry[1] !== undefined);
    for (const [, resource] of removed) {
      for (const output of resource.outputs.values()) output.remove();
      resource.outputs.clear();
    }
    for (const [id, resource] of removed) {
      const previousPane = resource.pane;
      resource.pane = null;
      this.mutatePane(() => previousPane?.remove());
      this.resources.delete(id);
    }
    for (const id of this.oscillatorOrder) {
      if (!desiredIds.has(id)) continue;
      const resource = this.resources.get(id);
      if (!resource) continue;
      for (const output of resource.outputs.values()) output.applyOptions({ paneId: 'price' });
      const previousPane = resource.pane;
      resource.pane = null;
      this.mutatePane(() => previousPane?.remove());
    }

    const panes = new Map<string, PaneHandle>();
    for (const study of desired) {
      const pane = this.mutatePane(() =>
        this.chart.addPane({
          id: paneId(study),
          weight: 0.3,
          minHeight: 72,
          scale: 'linear',
        }),
      );
      this.loosePanes.add(pane);
      panes.set(study.id, pane);
      const resource = this.resources.get(study.id);
      if (!resource || resource.study.kind !== study.kind) continue;
      resource.pane = pane;
      this.loosePanes.delete(pane);
      for (const output of resource.outputs.values()) output.applyOptions({ paneId: pane.id });
    }
    this.oscillatorOrder = desired.map((study) => study.id);
    return panes;
  }

  private createResource(
    study: TerminalStudy,
    prepared: PreparedStudy,
    pane: PaneHandle | null,
  ): StudyResource {
    const outputs = new Map<OutputKey, SeriesHandle>();
    try {
      for (const descriptor of outputDescriptors(study, pane)) {
        const handle = this.chart.addSeries(descriptor.type, {
          id: descriptor.id,
          ...descriptor.options,
        });
        outputs.set(descriptor.key, handle);
      }
      for (const descriptor of outputDescriptors(study, pane))
        outputs.get(descriptor.key)!.setData(outputData(prepared, descriptor.key));
    } catch (error) {
      for (const output of outputs.values()) {
        try {
          output.remove();
        } catch {}
      }
      throw error;
    }
    return {
      study: copyStudy(study),
      calculator: prepared.calculator,
      outputs,
      pane,
    };
  }

  private removeResource(resource: StudyResource): void {
    let failure: unknown;
    for (const output of resource.outputs.values()) {
      try {
        output.remove();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      this.mutatePane(() => resource.pane?.remove());
    } catch (error) {
      failure ??= error;
    }
    resource.outputs.clear();
    resource.pane = null;
    if (failure) throw failure;
  }

  rebuild(studies: readonly TerminalStudy[], bars: readonly MarketBar[]): void {
    const useOwned =
      this.allowOwnedStudyColumns && this.usePrivatePreparation && hasOwnedStudyColumnCapability(this.chart);
    const closes = bars.map((bar) => ({ time: bar.time, value: bar.close }));
    if (useOwned) {
      const prepared = prepareOwnedDefaultRebuild(studies, closes);
      for (const study of studies) {
        if (!study.visible) continue;
        const resource = this.resources.get(study.id);
        const ready = prepared.get(study.id);
        if (!resource || !ready) throw new Error(`Missing visible study resource: ${study.id}`);
        for (const descriptor of outputDescriptors(study, resource.pane)) {
          const handle = resource.outputs.get(descriptor.key)!;
          const input =
            descriptor.key === 'fill'
              ? {
                  kind: 'band' as const,
                  upper: ownedOutput(ready, 'upper'),
                  lower: ownedOutput(ready, 'lower'),
                }
              : { kind: 'scalar' as const, column: ownedOutput(ready, descriptor.key) };
          setOwnedStudyColumns(this.chart, handle, closes, input);
        }
        resource.calculator = ready.calculator;
        resource.study = copyStudy(study);
        prepared.delete(study.id);
      }
      return;
    }
    const prepared = this.usePrivatePreparation
      ? prepareDefaultRebuild(studies, closes)
      : new Map<string, PreparedStudy>();
    if (!this.usePrivatePreparation) {
      for (const study of studies)
        if (study.visible) prepared.set(study.id, prepare(study, closes, this.factories, false));
    }
    for (const study of studies) {
      if (!study.visible) continue;
      const resource = this.resources.get(study.id);
      const ready = prepared.get(study.id);
      if (!resource || !ready) throw new Error(`Missing visible study resource: ${study.id}`);
      for (const descriptor of outputDescriptors(study, resource.pane))
        resource.outputs.get(descriptor.key)!.setData(outputData(ready, descriptor.key));
      resource.calculator = ready.calculator;
      resource.study = copyStudy(study);
      // Calculations finish before publication, but consumed bulk outputs need
      // not remain reachable while the remaining chart stores are allocated.
      prepared.delete(study.id);
    }
  }

  clear(): void {
    for (const resource of this.resources.values()) {
      resource.calculator.clear();
      for (const output of resource.outputs.values()) output.setData([]);
    }
  }

  update(bar: MarketBar): void {
    const point = { time: bar.time, value: bar.close };
    for (const resource of [...this.resources.values()]) {
      const result = resource.calculator.update(point);
      for (const descriptor of outputDescriptors(resource.study, resource.pane))
        resource.outputs.get(descriptor.key)!.update(outputPoint(result, descriptor.key));
    }
  }

  /** Internal final-owner path: the chart has already retired all handles. */
  releaseAfterChartDestroy(): void {
    for (const resource of this.resources.values()) {
      resource.outputs.clear();
      resource.pane = null;
    }
    this.loosePanes.clear();
    this.resources.clear();
    this.oscillatorOrder = [];
  }

  destroy(): void {
    const resources = [...this.resources.values()];
    for (const resource of resources)
      for (const output of resource.outputs.values()) {
        try {
          output.remove();
        } catch {
          /* Chart teardown remains authoritative. */
        }
      }
    for (const resource of resources) {
      try {
        this.mutatePane(() => resource.pane?.remove());
      } catch {
        /* Pane may already be gone with its series. */
      }
      resource.outputs.clear();
      resource.pane = null;
    }
    for (const pane of this.loosePanes) {
      try {
        this.mutatePane(() => pane.remove());
      } catch {
        /* Failed composition may already have released the pane. */
      }
    }
    this.loosePanes.clear();
    this.resources.clear();
    this.oscillatorOrder = [];
  }
}
