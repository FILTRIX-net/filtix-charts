import { ChartError, type TimeDomain } from '@filtix/core';
import {
  inferDomain,
  safeAdd,
  safeMeanAdd,
  safeSub,
  type ScalarColumns,
  type IndicatorPoint,
  type ValidatedPoint,
  validatePoints,
  writeScalarColumn,
} from './indicators';
import {
  assertExactOptions,
  assertSafePeriod,
  MultiOutputStreaming,
  type MacdOptions,
  type MacdResult,
  type MultiOutputCalculator,
  type NamedIndicatorPoints,
} from './multi-output';

const MACD_NAMES = ['macd', 'signal', 'histogram'] as const;
type MacdName = (typeof MACD_NAMES)[number];
type MacdPointResult = NamedIndicatorPoints<MacdName>;
type MacdColumns = Record<MacdName, ScalarColumns>;

interface EmaState {
  count: number;
  seedMean: number;
  current: number | undefined;
}

class EmaAccumulator {
  private readonly alpha: number;
  private count = 0;
  private seedMean = 0;
  private current: number | undefined;

  constructor(private readonly period: number) {
    this.alpha = 2 / (period + 1);
  }

  reset(): void {
    this.count = 0;
    this.seedMean = 0;
    this.current = undefined;
  }

  push(value: number): number | undefined {
    if (this.count < this.period) {
      const nextCount = this.count + 1;
      this.seedMean = this.count === 0 ? value : safeMeanAdd(this.seedMean, value, nextCount, 'EMA seed');
      this.count = nextCount;
      if (this.count < this.period) return undefined;
      this.current = this.seedMean;
      return this.current;
    }

    const weightedValue = this.alpha * value;
    const weightedCurrent = (1 - this.alpha) * this.current!;
    const next = safeAdd(weightedValue, weightedCurrent, 'EMA output');
    this.current = next;
    return next;
  }

  snapshot(): EmaState {
    return { count: this.count, seedMean: this.seedMean, current: this.current };
  }

  restore(state: EmaState): void {
    this.count = state.count;
    this.seedMean = state.seedMean;
    this.current = state.current;
  }
}

interface MacdSnapshot {
  fast: EmaState;
  slow: EmaState;
  signal: EmaState;
}

export class MacdCalculator implements MultiOutputCalculator<MacdName> {
  private readonly fast: EmaAccumulator;
  private readonly slow: EmaAccumulator;
  private readonly signal: EmaAccumulator;
  private preTail: MacdSnapshot | undefined;
  private rollbackState: { snapshot: MacdSnapshot; preTail: MacdSnapshot | undefined } | undefined;
  private readonly current: {
    macd: number | undefined;
    signal: number | undefined;
    histogram: number | undefined;
  } = {
    macd: undefined,
    signal: undefined,
    histogram: undefined,
  };

  constructor(options: MacdOptions) {
    this.fast = new EmaAccumulator(options.fastPeriod);
    this.slow = new EmaAccumulator(options.slowPeriod);
    this.signal = new EmaAccumulator(options.signalPeriod);
  }

  push(input: ValidatedPoint, bulkIntermediate = false): MacdPointResult {
    if (bulkIntermediate) return this.calculate(input);
    const previousPreTail = this.preTail;
    const snapshot = this.snapshot();
    this.preTail = snapshot;
    try {
      const result = this.calculate(input);
      this.rollbackState = { snapshot, preTail: previousPreTail };
      return result;
    } catch (error) {
      this.restore(snapshot);
      this.preTail = previousPreTail;
      throw error;
    }
  }

  replaceTail(input: ValidatedPoint): MacdPointResult {
    const beforeTail = this.preTail;
    if (beforeTail === undefined) {
      throw new ChartError('INVALID_UPDATE', 'Cannot replace an empty indicator');
    }
    const committed = this.snapshot();
    const committedPreTail = this.preTail;
    this.restore(beforeTail);
    try {
      const result = this.push(input);
      this.rollbackState = { snapshot: committed, preTail: committedPreTail };
      return result;
    } catch (error) {
      this.restore(committed);
      this.preTail = committedPreTail;
      throw error;
    }
  }

  rollback(): void {
    const rollback = this.rollbackState;
    if (rollback === undefined) return;
    this.restore(rollback.snapshot);
    this.preTail = rollback.preTail;
    this.rollbackState = undefined;
  }

  /** Only for an unpublished intermediate row of the operation-owned default batch. */
  pushIntermediateInto(input: ValidatedPoint, columns: MacdColumns, index: number): void {
    this.calculateValues(input);
    writeScalarColumn(columns.macd, index, this.current.macd);
    writeScalarColumn(columns.signal, index, this.current.signal);
    writeScalarColumn(columns.histogram, index, this.current.histogram);
  }

  private calculate(input: ValidatedPoint): MacdPointResult {
    const time = input.point.time;
    this.calculateValues(input);
    const { macd, signal, histogram } = this.current;
    return {
      macd: macd === undefined ? { time } : { time, value: macd },
      signal: signal === undefined ? { time } : { time, value: signal },
      histogram: histogram === undefined ? { time } : { time, value: histogram },
    };
  }

  private calculateValues(input: ValidatedPoint): void {
    if (input.value === undefined) {
      this.fast.reset();
      this.slow.reset();
      this.signal.reset();
      this.current.macd = undefined;
      this.current.signal = undefined;
      this.current.histogram = undefined;
      return;
    }

    const fast = this.fast.push(input.value);
    const slow = this.slow.push(input.value);
    if (fast === undefined || slow === undefined) {
      this.current.macd = undefined;
      this.current.signal = undefined;
      this.current.histogram = undefined;
      return;
    }

    const macd = safeSub(fast, slow, 'MACD output');
    const signal = this.signal.push(macd);
    if (signal === undefined) {
      this.current.macd = macd;
      this.current.signal = undefined;
      this.current.histogram = undefined;
      return;
    }
    const histogram = safeSub(macd, signal, 'MACD histogram');
    this.current.macd = macd;
    this.current.signal = signal;
    this.current.histogram = histogram;
  }

  private snapshot(): MacdSnapshot {
    return {
      fast: this.fast.snapshot(),
      slow: this.slow.snapshot(),
      signal: this.signal.snapshot(),
    };
  }

  private restore(snapshot: MacdSnapshot): void {
    this.fast.restore(snapshot.fast);
    this.slow.restore(snapshot.slow);
    this.signal.restore(snapshot.signal);
  }
}

export function validateMacdOptions(options: MacdOptions): MacdOptions {
  assertExactOptions(options, ['fastPeriod', 'slowPeriod', 'signalPeriod'], 'MACD');
  const { fastPeriod, slowPeriod, signalPeriod } = options;
  assertSafePeriod(fastPeriod, 1, 'MACD fastPeriod');
  assertSafePeriod(slowPeriod, 1, 'MACD slowPeriod');
  assertSafePeriod(signalPeriod, 1, 'MACD signalPeriod');
  if (slowPeriod <= fastPeriod) {
    throw new ChartError('INVALID_PERIOD', 'MACD slowPeriod must be greater than fastPeriod');
  }
  return { fastPeriod, slowPeriod, signalPeriod };
}

export interface StreamingMacd {
  setData(points: readonly IndicatorPoint[]): void;
  update(point: IndicatorPoint): MacdResult<IndicatorPoint>;
  getData(): MacdResult<IndicatorPoint[]>;
}

export function macd(points: readonly IndicatorPoint[], options: MacdOptions): MacdResult<IndicatorPoint[]> {
  const copiedOptions = validateMacdOptions(options);
  const checked = validatePoints(points, inferDomain(points));
  const calculator = new MacdCalculator(copiedOptions);
  const output: MacdResult<IndicatorPoint[]> = { macd: [], signal: [], histogram: [] };
  for (const point of checked) {
    const result = calculator.push(point);
    output.macd.push(result.macd);
    output.signal.push(result.signal);
    output.histogram.push(result.histogram);
  }
  return output;
}

export function createMacd(options: MacdOptions, domain: TimeDomain = 'utc-ms'): StreamingMacd {
  const copiedOptions = validateMacdOptions(options);
  return new MultiOutputStreaming(MACD_NAMES, domain, () => new MacdCalculator(copiedOptions));
}
