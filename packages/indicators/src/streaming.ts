import { ChartError, type TimeDomain } from '@filtix/core';
import {
  assertDomain,
  assertPeriod,
  clonePoint,
  IndicatorCalculator,
  type IndicatorPoint,
  validatePoint,
  validatePointInto,
} from './indicators';

export interface StreamingIndicator {
  setData(points: readonly IndicatorPoint[]): void;
  update(point: IndicatorPoint): IndicatorPoint;
  getData(): Array<IndicatorPoint>;
}

function readDiscardedInputCopy(point: IndicatorPoint): void {
  // Keep clonePoint's input has/get sequence even though its stored copy was unused.
  if ('value' in point) {
    void point.time;
    void point.value;
  } else {
    void point.time;
  }
}

export class StreamingIndicatorImpl implements StreamingIndicator {
  private calculator: IndicatorCalculator;
  private output: IndicatorPoint[] = [];
  private latestKey: number | undefined;

  constructor(
    private readonly kind: 'sma' | 'ema' | 'rsi',
    private readonly period: number,
    private readonly domain: TimeDomain,
  ) {
    assertDomain(domain);
    assertPeriod(kind, period);
    this.calculator = new IndicatorCalculator(kind, period);
  }

  setData(points: readonly IndicatorPoint[]): void {
    const inputPoints: IndicatorPoint[] = [];
    const values: Array<number | undefined> = [];
    const checked: { point: IndicatorPoint; key: number; value: number | undefined } = {
      point: undefined as unknown as IndicatorPoint,
      key: 0,
      value: undefined,
    };
    let previousKey: number | undefined;
    for (const point of points) {
      validatePointInto(point, this.domain, previousKey, checked);
      inputPoints.push(point);
      values.push(checked.value);
      previousKey = checked.key;
    }

    const nextCalculator = new IndicatorCalculator(this.kind, this.period);
    const nextOutput: IndicatorPoint[] = [];
    const finalIndex = inputPoints.length - 1;
    let index = 0;
    for (const point of inputPoints) {
      checked.point = point;
      checked.value = values[index];
      readDiscardedInputCopy(point);
      nextOutput.push(nextCalculator.push(checked, index !== finalIndex));
      index += 1;
    }
    this.calculator = nextCalculator;
    this.output = nextOutput;
    this.latestKey = previousKey;
  }

  update(point: IndicatorPoint): IndicatorPoint {
    const previousKey = this.latestKey;
    const checked = validatePoint(point, this.domain);
    if (previousKey !== undefined && checked.key < previousKey) {
      throw new ChartError('INVALID_TIME_ORDER', 'Indicator updates must append or replace the newest time');
    }
    readDiscardedInputCopy(point);
    if (previousKey !== undefined && checked.key === previousKey) {
      const result = this.calculator.replaceTail(checked);
      const last = this.output.length - 1;
      this.output[last] = result;
      return clonePoint(result);
    }

    const result = this.calculator.push(checked);
    this.output.push(result);
    this.latestKey = checked.key;
    return clonePoint(result);
  }

  getData(): Array<IndicatorPoint> {
    return this.output.map(clonePoint);
  }
}

export function createIndicator(
  kind: 'sma' | 'ema' | 'rsi',
  period: number,
  domain: TimeDomain = 'utc-ms',
): StreamingIndicator {
  return new StreamingIndicatorImpl(kind, period, domain);
}
