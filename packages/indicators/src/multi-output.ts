import { ChartError, type TimeDomain } from '@filtrix.net/core';
import {
  assertDomain,
  clonePoint,
  type IndicatorPoint,
  type ValidatedPoint,
  validatePoint,
  validatePointInto,
} from './indicators';

export interface MacdOptions {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface BollingerBandsOptions {
  period: number;
  multiplier: number;
}

export interface MacdResult<T> {
  macd: T;
  signal: T;
  histogram: T;
}

export interface BollingerBandsResult<T> {
  middle: T;
  upper: T;
  lower: T;
}

export type NamedIndicatorPoints<Name extends string> = {
  [Key in Name]: IndicatorPoint;
};

export type NamedIndicatorArrays<Name extends string> = {
  [Key in Name]: IndicatorPoint[];
};

export interface MultiOutputCalculator<Name extends string> {
  // Each call returns fresh point objects that the calculator never retains, reuses, or mutates.
  push(point: ValidatedPoint, bulkIntermediate?: boolean): NamedIndicatorPoints<Name>;
  replaceTail(point: ValidatedPoint): NamedIndicatorPoints<Name>;
  rollback(): void;
}

export function assertExactOptions(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChartError('INVALID_OPTIONS', `${label} options must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new ChartError(
      'INVALID_OPTIONS',
      `${label} options must contain exactly ${expectedKeys.join(', ')}`,
    );
  }
}

export function assertSafePeriod(value: unknown, minimum: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ChartError('INVALID_PERIOD', `${label} must be a safe integer >= ${minimum}`);
  }
}

function createArrays<Name extends string>(names: readonly Name[]): NamedIndicatorArrays<Name> {
  return Object.fromEntries(names.map((name) => [name, []])) as unknown as NamedIndicatorArrays<Name>;
}

function cloneNamedPoints<Name extends string>(
  names: readonly Name[],
  value: NamedIndicatorPoints<Name>,
): NamedIndicatorPoints<Name> {
  return Object.fromEntries(
    names.map((name) => [name, clonePoint(value[name])]),
  ) as NamedIndicatorPoints<Name>;
}

function cloneNamedArrays<Name extends string>(
  names: readonly Name[],
  value: NamedIndicatorArrays<Name>,
): NamedIndicatorArrays<Name> {
  return Object.fromEntries(
    names.map((name) => [name, value[name].map(clonePoint)]),
  ) as NamedIndicatorArrays<Name>;
}

export class MultiOutputStreaming<Name extends string> {
  private calculator: MultiOutputCalculator<Name>;
  private output: NamedIndicatorArrays<Name>;
  private latestKey: number | undefined;
  private count = 0;

  constructor(
    private readonly names: readonly Name[],
    private readonly domain: TimeDomain,
    private readonly calculatorFactory: () => MultiOutputCalculator<Name>,
  ) {
    assertDomain(domain);
    this.calculator = calculatorFactory();
    this.output = createArrays(names);
  }

  setData(points: readonly IndicatorPoint[]): void {
    assertDomain(this.domain);
    if (!Array.isArray(points)) {
      throw new ChartError('INVALID_DATA', 'Indicator points must be an array');
    }
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

    const nextCalculator = this.calculatorFactory();
    const nextOutput = createArrays(this.names);

    const finalIndex = inputPoints.length - 1;
    let index = 0;
    for (const point of inputPoints) {
      checked.point = point;
      checked.value = values[index];
      const result = nextCalculator.push(checked, index !== finalIndex);
      for (const name of this.names) nextOutput[name].push(result[name]);
      index += 1;
    }

    this.calculator = nextCalculator;
    this.output = nextOutput;
    this.latestKey = previousKey;
    this.count = inputPoints.length;
  }

  update(point: IndicatorPoint): NamedIndicatorPoints<Name> {
    const previousKey = this.latestKey;
    const checked = validatePoint(point, this.domain);
    if (previousKey !== undefined && checked.key < previousKey) {
      throw new ChartError('INVALID_TIME_ORDER', 'Indicator updates must append or replace the newest time');
    }

    if (previousKey !== undefined && checked.key === previousKey) {
      const last = this.count - 1;
      const previousOutputs = this.names.map((name) => this.output[name][last]!);
      const result = this.calculator.replaceTail(checked);
      try {
        const returned = cloneNamedPoints(this.names, result);
        for (const name of this.names) this.output[name][last] = result[name];
        return returned;
      } catch (error) {
        this.names.forEach((name, index) => {
          this.output[name][last] = previousOutputs[index]!;
        });
        this.calculator.rollback();
        throw error;
      }
    }

    const result = this.calculator.push(checked);
    let returned: NamedIndicatorPoints<Name>;
    try {
      returned = cloneNamedPoints(this.names, result);
    } catch (error) {
      this.calculator.rollback();
      throw error;
    }

    let pushed = 0;
    const previousCount = this.count;
    const previousLatestKey = this.latestKey;
    try {
      for (const name of this.names) {
        this.output[name].push(result[name]);
        pushed += 1;
      }
      this.count = previousCount + 1;
      this.latestKey = checked.key;
      return returned;
    } catch (error) {
      for (let index = 0; index < pushed; index += 1) {
        this.output[this.names[index]!].pop();
      }
      this.count = previousCount;
      this.latestKey = previousLatestKey;
      this.calculator.rollback();
      throw error;
    }
  }

  getData(): NamedIndicatorArrays<Name> {
    return cloneNamedArrays(this.names, this.output);
  }
}
