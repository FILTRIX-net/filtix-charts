import { ChartError, type TimeDomain } from '@filtix/core';
import { BollingerCalculator, validateBollingerOptions } from './bollinger';
import {
  assertDomain,
  assertPeriod,
  IndicatorCalculator,
  type IndicatorPoint,
  type ScalarColumns,
  type ValidatedPoint,
  validatePoint,
  validatePointInto,
  writeScalarColumn,
} from './indicators';
import { MacdCalculator, validateMacdOptions } from './macd';
import type { BollingerBandsOptions, BollingerBandsResult, MacdOptions, MacdResult } from './multi-output';

export type { ScalarColumns } from './indicators';

type ScalarKind = 'sma' | 'ema' | 'rsi';

interface ValidatedHistory {
  inputPoints: IndicatorPoint[];
  values: Array<number | undefined>;
  checked: { point: IndicatorPoint; key: number; value: number | undefined };
  latestKey: number | undefined;
}

export interface PreparedOutput<Data, Point> {
  data: Data;
  controller: {
    update(point: IndicatorPoint): Point;
    reset(): void;
  };
}

function validatedUpdate(
  point: IndicatorPoint,
  domain: TimeDomain,
  latestKey: number | undefined,
): ValidatedPoint {
  const checked = validatePoint(point, domain);
  if (latestKey !== undefined && checked.key < latestKey) {
    throw new ChartError('INVALID_TIME_ORDER', 'Indicator updates must append or replace the newest time');
  }
  return checked;
}

function validateHistory(points: readonly IndicatorPoint[], domain: TimeDomain): ValidatedHistory {
  assertDomain(domain);
  if (!Array.isArray(points)) throw new ChartError('INVALID_DATA', 'Indicator points must be an array');
  const inputPoints: IndicatorPoint[] = [];
  const values: Array<number | undefined> = [];
  const checked = { point: { time: 0 } as IndicatorPoint, key: 0, value: undefined as number | undefined };
  let latestKey: number | undefined;
  for (const point of points) {
    validatePointInto(point, domain, latestKey, checked);
    inputPoints.push(point);
    values.push(checked.value);
    latestKey = checked.key;
  }
  return { inputPoints, values, checked, latestKey };
}

class ScalarController {
  private calculator: IndicatorCalculator;
  private latestKey: number | undefined;

  constructor(
    private readonly kind: ScalarKind,
    private readonly period: number,
    private readonly domain: TimeDomain,
    calculator: IndicatorCalculator,
    latestKey: number | undefined,
  ) {
    this.calculator = calculator;
    this.latestKey = latestKey;
  }

  update(point: IndicatorPoint): IndicatorPoint {
    const checked = validatedUpdate(point, this.domain, this.latestKey);
    if (checked.key === this.latestKey) return this.calculator.replaceTail(checked);
    const output = this.calculator.push(checked);
    this.latestKey = checked.key;
    return output;
  }

  reset(): void {
    this.calculator = new IndicatorCalculator(this.kind, this.period);
    this.latestKey = undefined;
  }
}

class MacdController {
  private calculator: MacdCalculator;
  private latestKey: number | undefined;

  constructor(
    private readonly options: MacdOptions,
    private readonly domain: TimeDomain,
    calculator: MacdCalculator,
    latestKey: number | undefined,
  ) {
    this.calculator = calculator;
    this.latestKey = latestKey;
  }

  update(point: IndicatorPoint): MacdResult<IndicatorPoint> {
    const checked = validatedUpdate(point, this.domain, this.latestKey);
    if (checked.key === this.latestKey) return this.calculator.replaceTail(checked);
    const output = this.calculator.push(checked);
    this.latestKey = checked.key;
    return output;
  }

  reset(): void {
    this.calculator = new MacdCalculator(this.options);
    this.latestKey = undefined;
  }
}

class BollingerController {
  private calculator: BollingerCalculator;
  private latestKey: number | undefined;

  constructor(
    private readonly options: BollingerBandsOptions,
    private readonly domain: TimeDomain,
    calculator: BollingerCalculator,
    latestKey: number | undefined,
  ) {
    this.calculator = calculator;
    this.latestKey = latestKey;
  }

  update(point: IndicatorPoint): BollingerBandsResult<IndicatorPoint> {
    const checked = validatedUpdate(point, this.domain, this.latestKey);
    if (checked.key === this.latestKey) return this.calculator.replaceTail(checked);
    const output = this.calculator.push(checked);
    this.latestKey = checked.key;
    return output;
  }

  reset(): void {
    this.calculator = new BollingerCalculator(this.options.period, this.options.multiplier);
    this.latestKey = undefined;
  }
}

export function prepareScalar(
  kind: ScalarKind,
  period: number,
  points: readonly IndicatorPoint[],
  domain: TimeDomain = 'utc-ms',
): PreparedOutput<IndicatorPoint[], IndicatorPoint> {
  assertPeriod(kind, period);
  const { inputPoints, values, checked, latestKey } = validateHistory(points, domain);
  const calculator = new IndicatorCalculator(kind, period);
  const data: IndicatorPoint[] = [];
  const finalIndex = inputPoints.length - 1;
  for (let index = 0; index < inputPoints.length; index += 1) {
    checked.point = inputPoints[index]!;
    checked.value = values[index];
    data.push(calculator.push(checked, index !== finalIndex));
  }
  return { data, controller: new ScalarController(kind, period, domain, calculator, latestKey) };
}

export function prepareMacd(
  options: MacdOptions,
  points: readonly IndicatorPoint[],
  domain: TimeDomain = 'utc-ms',
): PreparedOutput<MacdResult<IndicatorPoint[]>, MacdResult<IndicatorPoint>> {
  const copiedOptions = validateMacdOptions(options);
  const { inputPoints, values, checked, latestKey } = validateHistory(points, domain);
  const calculator = new MacdCalculator(copiedOptions);
  const data: MacdResult<IndicatorPoint[]> = { macd: [], signal: [], histogram: [] };
  const finalIndex = inputPoints.length - 1;
  for (let index = 0; index < inputPoints.length; index += 1) {
    checked.point = inputPoints[index]!;
    checked.value = values[index];
    const output = calculator.push(checked, index !== finalIndex);
    data.macd.push(output.macd);
    data.signal.push(output.signal);
    data.histogram.push(output.histogram);
  }
  return { data, controller: new MacdController(copiedOptions, domain, calculator, latestKey) };
}

export function prepareBollinger(
  options: BollingerBandsOptions,
  points: readonly IndicatorPoint[],
  domain: TimeDomain = 'utc-ms',
): PreparedOutput<BollingerBandsResult<IndicatorPoint[]>, BollingerBandsResult<IndicatorPoint>> {
  const copiedOptions = validateBollingerOptions(options);
  const { inputPoints, values, checked, latestKey } = validateHistory(points, domain);
  const calculator = new BollingerCalculator(copiedOptions.period, copiedOptions.multiplier);
  const data: BollingerBandsResult<IndicatorPoint[]> = { middle: [], upper: [], lower: [] };
  const finalIndex = inputPoints.length - 1;
  for (let index = 0; index < inputPoints.length; index += 1) {
    checked.point = inputPoints[index]!;
    checked.value = values[index];
    const output = calculator.push(checked, index !== finalIndex);
    data.middle.push(output.middle);
    data.upper.push(output.upper);
    data.lower.push(output.lower);
  }
  return {
    data,
    controller: new BollingerController(copiedOptions, domain, calculator, latestKey),
  };
}

export type PreparationRequest =
  | { kind: ScalarKind; period: number }
  | { kind: 'macd'; options: MacdOptions }
  | { kind: 'bollinger'; options: BollingerBandsOptions };

export type BatchPreparedOutput =
  | { kind: ScalarKind; prepared: ReturnType<typeof prepareScalar> }
  | { kind: 'macd'; prepared: ReturnType<typeof prepareMacd> }
  | { kind: 'bollinger'; prepared: ReturnType<typeof prepareBollinger> };

/**
 * Internal default-terminal rebuild boundary. Points are the operation's fresh,
 * plain close records, exclusively owned until this synchronous batch returns.
 * Requests are consumed lazily so earlier arithmetic failures precede later
 * option validation. Neither the shared history nor its scratch escapes.
 */
export function prepareBatch(
  requests: Iterable<PreparationRequest>,
  points: readonly IndicatorPoint[],
  domain: TimeDomain = 'utc-ms',
): BatchPreparedOutput[] {
  const results: BatchPreparedOutput[] = [];
  let history: ValidatedHistory | undefined;
  for (const request of requests) {
    if (request.kind === 'macd') {
      const options = validateMacdOptions(request.options);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new MacdCalculator(options);
      const data: MacdResult<IndicatorPoint[]> = { macd: [], signal: [], histogram: [] };
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        const output = calculator.push(checked, index !== finalIndex);
        data.macd.push(output.macd);
        data.signal.push(output.signal);
        data.histogram.push(output.histogram);
      }
      results.push({
        kind: request.kind,
        prepared: {
          data,
          controller: new MacdController(options, domain, calculator, latestKey),
        },
      });
    } else if (request.kind === 'bollinger') {
      const options = validateBollingerOptions(request.options);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new BollingerCalculator(options.period, options.multiplier);
      const data: BollingerBandsResult<IndicatorPoint[]> = { middle: [], upper: [], lower: [] };
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        const output = calculator.push(checked, index !== finalIndex);
        data.middle.push(output.middle);
        data.upper.push(output.upper);
        data.lower.push(output.lower);
      }
      results.push({
        kind: request.kind,
        prepared: {
          data,
          controller: new BollingerController(options, domain, calculator, latestKey),
        },
      });
    } else {
      assertPeriod(request.kind, request.period);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new IndicatorCalculator(request.kind, request.period);
      const data: IndicatorPoint[] = [];
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        data.push(calculator.push(checked, index !== finalIndex));
      }
      results.push({
        kind: request.kind,
        prepared: {
          data,
          controller: new ScalarController(request.kind, request.period, domain, calculator, latestKey),
        },
      });
    }
  }
  return results;
}

export interface OwnedPreparedStudy {
  kind: ScalarKind | 'macd' | 'bollinger';
  outputs: Record<string, ScalarColumns>;
  controller: BatchPreparedOutput['prepared']['controller'];
}

export interface OwnedBatch {
  points: readonly (IndicatorPoint & { time: number })[];
  studies: OwnedPreparedStudy[];
}

function createScalarColumns(length: number): ScalarColumns {
  return { values: new Float64Array(length), present: new Uint8Array(length) };
}

function writeFinalPoint(column: ScalarColumns, index: number, point: IndicatorPoint): void {
  writeScalarColumn(column, index, 'value' in point ? point.value : undefined);
}

/**
 * Private UTC default-terminal transport. Requests are inert records and points
 * are fresh plain close records owned by this operation until the last store copy.
 * Arbitrary public iterables and getter-bearing inputs retain prepareBatch above.
 */
export function prepareOwnedBatch(
  requests: Iterable<PreparationRequest>,
  points: readonly (IndicatorPoint & { time: number })[],
  domain: 'utc-ms',
): OwnedBatch {
  if (domain !== 'utc-ms') throw new ChartError('INVALID_TIME_DOMAIN', 'Owned study columns require utc-ms');
  const studies: OwnedPreparedStudy[] = [];
  let history: ValidatedHistory | undefined;
  for (const request of requests) {
    if (request.kind === 'macd') {
      const options = validateMacdOptions(request.options);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new MacdCalculator(options);
      const outputs = {
        macd: createScalarColumns(inputPoints.length),
        signal: createScalarColumns(inputPoints.length),
        histogram: createScalarColumns(inputPoints.length),
      };
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        if (index !== finalIndex) calculator.pushIntermediateInto(checked, outputs, index);
        else {
          const output = calculator.push(checked);
          writeFinalPoint(outputs.macd, index, output.macd);
          writeFinalPoint(outputs.signal, index, output.signal);
          writeFinalPoint(outputs.histogram, index, output.histogram);
        }
      }
      studies.push({
        kind: request.kind,
        outputs,
        controller: new MacdController(options, domain, calculator, latestKey),
      });
    } else if (request.kind === 'bollinger') {
      const options = validateBollingerOptions(request.options);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new BollingerCalculator(options.period, options.multiplier);
      const outputs = {
        middle: createScalarColumns(inputPoints.length),
        upper: createScalarColumns(inputPoints.length),
        lower: createScalarColumns(inputPoints.length),
      };
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        if (index !== finalIndex) calculator.pushIntermediateInto(checked, outputs, index);
        else {
          const output = calculator.push(checked);
          writeFinalPoint(outputs.middle, index, output.middle);
          writeFinalPoint(outputs.upper, index, output.upper);
          writeFinalPoint(outputs.lower, index, output.lower);
        }
      }
      studies.push({
        kind: request.kind,
        outputs,
        controller: new BollingerController(options, domain, calculator, latestKey),
      });
    } else {
      assertPeriod(request.kind, request.period);
      history ??= validateHistory(points, domain);
      const { inputPoints, values, checked, latestKey } = history;
      const calculator = new IndicatorCalculator(request.kind, request.period);
      const outputs = { value: createScalarColumns(inputPoints.length) };
      const finalIndex = inputPoints.length - 1;
      for (let index = 0; index < inputPoints.length; index += 1) {
        checked.point = inputPoints[index]!;
        checked.value = values[index];
        if (index !== finalIndex) calculator.pushIntermediateInto(checked, outputs.value, index);
        else writeFinalPoint(outputs.value, index, calculator.push(checked));
      }
      studies.push({
        kind: request.kind,
        outputs,
        controller: new ScalarController(request.kind, request.period, domain, calculator, latestKey),
      });
    }
  }
  return { points, studies };
}
