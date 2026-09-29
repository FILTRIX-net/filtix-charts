import { ChartError, timeKey, type TimeDomain, type ValuePoint, type WhitespacePoint } from '@filtix/core';

export type IndicatorPoint = ValuePoint | WhitespacePoint;

/** Private default-batch staging only; a store must copy these columns before publication. */
export interface ScalarColumns {
  values: Float64Array;
  present: Uint8Array;
}

export function writeScalarColumn(column: ScalarColumns, index: number, value: number | undefined): void {
  column.values[index] = value === undefined ? Number.NaN : value;
  column.present[index] = value === undefined ? 0 : 1;
}

export interface ValidatedPoint {
  readonly point: IndicatorPoint;
  readonly key: number;
  readonly value: number | undefined;
}

type ValidatedPointTarget = {
  point: IndicatorPoint;
  key: number;
  value: number | undefined;
};

export function assertPeriod(kind: 'sma' | 'ema' | 'rsi', period: number): void {
  const minimum = kind === 'rsi' ? 2 : 1;
  if (!Number.isInteger(period) || period < minimum) {
    throw new ChartError('INVALID_PERIOD', `${kind.toUpperCase()} period must be an integer >= ${minimum}`);
  }
}

export function assertDomain(domain: TimeDomain): void {
  if (domain !== 'utc-ms' && domain !== 'business-date') {
    throw new ChartError('INVALID_TIME_DOMAIN', `Unknown time domain: ${String(domain)}`);
  }
}

function isValuePoint(point: IndicatorPoint): point is ValuePoint {
  return Object.prototype.hasOwnProperty.call(point, 'value');
}

export function validatePoint(
  point: IndicatorPoint,
  domain: TimeDomain,
  previousKey?: number,
): ValidatedPoint {
  const result: ValidatedPointTarget = { point, key: 0, value: undefined };
  validatePointInto(point, domain, previousKey, result);
  return result;
}

/** Internal reusable target for streaming bulk validation; not exported from the package index. */
export function validatePointInto(
  point: IndicatorPoint,
  domain: TimeDomain,
  previousKey: number | undefined,
  target: ValidatedPointTarget,
): void {
  if (point === null || typeof point !== 'object' || !('time' in point)) {
    throw new ChartError('INVALID_POINT', 'Indicator points must contain a time');
  }
  const key = timeKey(point.time, domain);
  if (previousKey !== undefined && key <= previousKey) {
    throw new ChartError('INVALID_TIME_ORDER', 'Indicator times must be strictly increasing');
  }
  if (isValuePoint(point)) {
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      throw new ChartError('INVALID_VALUE', 'Indicator values must be finite numbers');
    }
    const value = point.value;
    target.point = point;
    target.key = key;
    target.value = value;
    return;
  }
  target.point = point;
  target.key = key;
  target.value = undefined;
}

export function validatePoints(points: readonly IndicatorPoint[], domain: TimeDomain): ValidatedPoint[] {
  assertDomain(domain);
  if (!Array.isArray(points)) {
    throw new ChartError('INVALID_DATA', 'Indicator points must be an array');
  }
  const checked: ValidatedPoint[] = [];
  let previousKey: number | undefined;
  for (const point of points) {
    const result = validatePoint(point, domain, previousKey);
    checked.push(result);
    previousKey = result.key;
  }
  return checked;
}

export function inferDomain(points: readonly IndicatorPoint[]): TimeDomain {
  if (!Array.isArray(points)) {
    throw new ChartError('INVALID_DATA', 'Indicator points must be an array');
  }
  if (points.length === 0) return 'utc-ms';
  const first = points[0];
  if (first === undefined || first === null || typeof first !== 'object' || !('time' in first)) {
    throw new ChartError('INVALID_POINT', 'Indicator points must contain a time');
  }
  return typeof first.time === 'string' ? 'business-date' : 'utc-ms';
}

export function clonePoint(point: IndicatorPoint): IndicatorPoint {
  return 'value' in point ? { time: point.time, value: point.value } : { time: point.time };
}

export function indicatorOverflow(label: string): ChartError {
  return new ChartError('INDICATOR_OVERFLOW', `${label} is outside the finite numeric range`);
}

/** Adds finite values without overflowing an intermediate same-sign sum when the result is representable. */
export function safeAdd(left: number, right: number, label: string): number {
  const direct = left + right;
  if (Number.isFinite(direct)) return direct;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  if (scale === 0) return 0;
  const scaled = scale * (left / scale + right / scale);
  if (!Number.isFinite(scaled)) throw indicatorOverflow(label);
  return scaled;
}

export function safeSub(left: number, right: number, label: string): number {
  return safeAdd(left, -right, label);
}

export function safeMeanAdd(mean: number, value: number, count: number, label: string): number {
  const delta = safeSub(value / count, mean / count, label);
  return safeAdd(mean, delta, label);
}

type SmaSnapshot = {
  kind: 'sma';
  count: number;
  head: number;
  mean: number;
  slotIndex: number;
  slotValue: number | undefined;
};

type EmaSnapshot = {
  kind: 'ema';
  count: number;
  seedMean: number;
  current: number | undefined;
};

type RsiSnapshot = {
  kind: 'rsi';
  valueCount: number;
  previous: number | undefined;
  gainMean: number;
  lossMean: number;
  averageGain: number | undefined;
  averageLoss: number | undefined;
};

type IndicatorSnapshot = SmaSnapshot | EmaSnapshot | RsiSnapshot;

/** Internal calculator shared by batch and streaming transforms. */
export class IndicatorCalculator {
  private readonly alpha: number;
  private readonly smaRing: number[];
  private smaCount = 0;
  private smaHead = 0;
  private smaMean = 0;
  private emaCount = 0;
  private emaSeedMean = 0;
  private emaCurrent: number | undefined;
  private rsiValueCount = 0;
  private rsiPrevious: number | undefined;
  private rsiGainMean = 0;
  private rsiLossMean = 0;
  private rsiAverageGain: number | undefined;
  private rsiAverageLoss: number | undefined;
  private preTail: IndicatorSnapshot | undefined;

  constructor(
    private readonly kind: 'sma' | 'ema' | 'rsi',
    private readonly period: number,
  ) {
    assertPeriod(kind, period);
    this.alpha = 2 / (period + 1);
    this.smaRing = new Array<number>(period);
  }

  reset(): void {
    this.smaCount = 0;
    this.smaHead = 0;
    this.smaMean = 0;
    this.emaCount = 0;
    this.emaSeedMean = 0;
    this.emaCurrent = undefined;
    this.rsiValueCount = 0;
    this.rsiPrevious = undefined;
    this.rsiGainMean = 0;
    this.rsiLossMean = 0;
    this.rsiAverageGain = undefined;
    this.rsiAverageLoss = undefined;
    this.preTail = undefined;
  }

  push(input: ValidatedPoint, bulkIntermediate = false): IndicatorPoint {
    const previousPreTail = this.preTail;
    const snapshot = bulkIntermediate ? undefined : this.snapshot();
    if (snapshot !== undefined) this.preTail = snapshot;
    try {
      const output = this.calculateValue(input);
      return output === undefined ? { time: input.point.time } : { time: input.point.time, value: output };
    } catch (error) {
      if (snapshot !== undefined) {
        this.restore(snapshot);
        this.preTail = previousPreTail;
      }
      throw error;
    }
  }

  /** Only for an unpublished intermediate row of the operation-owned default batch. */
  pushIntermediateInto(input: ValidatedPoint, column: ScalarColumns, index: number): void {
    writeScalarColumn(column, index, this.calculateValue(input));
  }

  private calculateValue(input: ValidatedPoint): number | undefined {
    if (input.value === undefined) {
      this.resetContiguousState();
      return undefined;
    }
    const output =
      this.kind === 'sma'
        ? this.pushSma(input.value)
        : this.kind === 'ema'
          ? this.pushEma(input.value)
          : this.pushRsi(input.value);
    if (output !== undefined && !Number.isFinite(output))
      throw indicatorOverflow(`${this.kind.toUpperCase()} output`);
    return output;
  }

  replaceTail(input: ValidatedPoint): IndicatorPoint {
    const beforeTail = this.preTail;
    if (beforeTail === undefined) {
      throw new ChartError('INVALID_UPDATE', 'Cannot replace an empty indicator');
    }

    // Keep the committed post-tail state so a failed trial can restore it.
    const committed = this.snapshot();
    const committedPreTail = this.preTail;
    const committedTailSlot = beforeTail.kind === 'sma' ? this.smaRing[beforeTail.slotIndex] : undefined;
    this.restore(beforeTail);
    try {
      return this.push(input);
    } catch (error) {
      this.restore(committed);
      if (beforeTail.kind === 'sma') this.smaRing[beforeTail.slotIndex] = committedTailSlot!;
      this.preTail = committedPreTail;
      throw error;
    }
  }

  private resetContiguousState(): void {
    this.smaCount = 0;
    this.smaHead = 0;
    this.smaMean = 0;
    this.emaCount = 0;
    this.emaSeedMean = 0;
    this.emaCurrent = undefined;
    this.rsiValueCount = 0;
    this.rsiPrevious = undefined;
    this.rsiGainMean = 0;
    this.rsiLossMean = 0;
    this.rsiAverageGain = undefined;
    this.rsiAverageLoss = undefined;
  }

  private pushSma(value: number): number | undefined {
    if (this.smaCount < this.period) {
      const nextCount = this.smaCount + 1;
      this.smaMean = this.smaCount === 0 ? value : safeMeanAdd(this.smaMean, value, nextCount, 'SMA mean');
      this.smaRing[this.smaCount] = value;
      this.smaCount = nextCount;
    } else if (this.period === 1) {
      this.smaRing[0] = value;
      this.smaMean = value;
    } else {
      const old = this.smaRing[this.smaHead]!;
      const delta = safeSub(value / this.period, old / this.period, 'SMA rolling mean');
      this.smaMean = safeAdd(this.smaMean, delta, 'SMA rolling mean');
      this.smaRing[this.smaHead] = value;
      this.smaHead = (this.smaHead + 1) % this.period;
    }
    return this.smaCount === this.period ? this.smaMean : undefined;
  }

  private pushEma(value: number): number | undefined {
    const nextCount = this.emaCount + 1;
    if (this.emaCount < this.period) {
      this.emaSeedMean =
        this.emaCount === 0 ? value : safeMeanAdd(this.emaSeedMean, value, nextCount, 'EMA seed');
      this.emaCount = nextCount;
      if (this.emaCount < this.period) return undefined;
      this.emaCurrent = this.emaSeedMean;
      return this.emaCurrent;
    }
    this.emaCount = nextCount;
    const weightedValue = this.alpha * value;
    const weightedCurrent = (1 - this.alpha) * this.emaCurrent!;
    this.emaCurrent = safeAdd(weightedValue, weightedCurrent, 'EMA output');
    return this.emaCurrent;
  }

  private pushRsi(value: number): number | undefined {
    if (this.rsiValueCount === 0) {
      this.rsiPrevious = value;
      this.rsiValueCount = 1;
      return undefined;
    }

    const change = safeSub(value, this.rsiPrevious!, 'RSI price change');
    this.rsiPrevious = value;
    this.rsiValueCount += 1;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    const changeCount = this.rsiValueCount - 1;
    if (changeCount < this.period) {
      this.rsiGainMean =
        changeCount === 1 ? gain : safeMeanAdd(this.rsiGainMean, gain, changeCount, 'RSI gain seed');
      this.rsiLossMean =
        changeCount === 1 ? loss : safeMeanAdd(this.rsiLossMean, loss, changeCount, 'RSI loss seed');
      return undefined;
    }
    if (changeCount === this.period) {
      this.rsiGainMean =
        changeCount === 1 ? gain : safeMeanAdd(this.rsiGainMean, gain, changeCount, 'RSI gain seed');
      this.rsiLossMean =
        changeCount === 1 ? loss : safeMeanAdd(this.rsiLossMean, loss, changeCount, 'RSI loss seed');
      this.rsiAverageGain = this.rsiGainMean;
      this.rsiAverageLoss = this.rsiLossMean;
    } else {
      const weight = (this.period - 1) / this.period;
      this.rsiAverageGain = safeAdd(this.rsiAverageGain! * weight, gain / this.period, 'RSI gain smoothing');
      this.rsiAverageLoss = safeAdd(this.rsiAverageLoss! * weight, loss / this.period, 'RSI loss smoothing');
    }
    return this.rsiValue();
  }

  private rsiValue(): number {
    const gain = this.rsiAverageGain!;
    const loss = this.rsiAverageLoss!;
    if (loss === 0) return gain === 0 ? 50 : 100;
    if (gain === 0) return 0;
    const ratio = gain / loss;
    if (!Number.isFinite(ratio)) return ratio > 0 ? 100 : 0;
    const result = 100 - 100 / (1 + ratio);
    if (!Number.isFinite(result)) throw indicatorOverflow('RSI output');
    return result;
  }

  private snapshot(): IndicatorSnapshot {
    if (this.kind === 'sma') {
      const slotIndex = this.smaCount < this.period ? this.smaCount : this.smaHead;
      return {
        kind: 'sma',
        count: this.smaCount,
        head: this.smaHead,
        mean: this.smaMean,
        slotIndex,
        slotValue: this.smaRing[slotIndex],
      };
    }
    if (this.kind === 'ema') {
      return { kind: 'ema', count: this.emaCount, seedMean: this.emaSeedMean, current: this.emaCurrent };
    }
    return {
      kind: 'rsi',
      valueCount: this.rsiValueCount,
      previous: this.rsiPrevious,
      gainMean: this.rsiGainMean,
      lossMean: this.rsiLossMean,
      averageGain: this.rsiAverageGain,
      averageLoss: this.rsiAverageLoss,
    };
  }

  private restore(snapshot: IndicatorSnapshot): void {
    if (snapshot.kind === 'sma') {
      this.smaCount = snapshot.count;
      this.smaHead = snapshot.head;
      this.smaMean = snapshot.mean;
      this.smaRing[snapshot.slotIndex] = snapshot.slotValue!;
      return;
    }
    if (snapshot.kind === 'ema') {
      this.emaCount = snapshot.count;
      this.emaSeedMean = snapshot.seedMean;
      this.emaCurrent = snapshot.current;
      return;
    }
    this.rsiValueCount = snapshot.valueCount;
    this.rsiPrevious = snapshot.previous;
    this.rsiGainMean = snapshot.gainMean;
    this.rsiLossMean = snapshot.lossMean;
    this.rsiAverageGain = snapshot.averageGain;
    this.rsiAverageLoss = snapshot.averageLoss;
  }
}

export function calculate(
  kind: 'sma' | 'ema' | 'rsi',
  points: readonly IndicatorPoint[],
  period: number,
): Array<IndicatorPoint> {
  assertPeriod(kind, period);
  const checked = validatePoints(points, inferDomain(points));
  const calculator = new IndicatorCalculator(kind, period);
  return checked.map((point) => calculator.push(point));
}

export function sma(points: readonly IndicatorPoint[], period: number): Array<IndicatorPoint> {
  return calculate('sma', points, period);
}

export function ema(points: readonly IndicatorPoint[], period: number): Array<IndicatorPoint> {
  return calculate('ema', points, period);
}

export function rsi(points: readonly IndicatorPoint[], period: number): Array<IndicatorPoint> {
  return calculate('rsi', points, period);
}
