import { ChartError, type TimeDomain } from '@filtix/core';
import {
  inferDomain,
  indicatorOverflow,
  safeAdd,
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
  type BollingerBandsOptions,
  type BollingerBandsResult,
  type MultiOutputCalculator,
  type NamedIndicatorPoints,
} from './multi-output';

const BOLLINGER_NAMES = ['middle', 'upper', 'lower'] as const;
type BollingerName = (typeof BOLLINGER_NAMES)[number];
type BollingerPointResult = NamedIndicatorPoints<BollingerName>;
type BollingerColumns = Record<BollingerName, ScalarColumns>;

interface CountCoefficients {
  leftCount: number;
  rightCount: number;
  leftWeight: number;
  rightWeight: number;
  crossFactor: number;
  leftFactor: number;
  rightFactor: number;
}

interface AggregateNode {
  left: AggregateNode | undefined;
  right: AggregateNode | undefined;
  count: number;
  mean: number;
  deviation: number;
  coefficients?: CountCoefficients;
}

interface BollingerSnapshot {
  readonly root: AggregateNode | undefined;
  readonly count: number;
  readonly head: number;
}

function leaf(value: number): AggregateNode {
  return { left: undefined, right: undefined, count: 1, mean: value, deviation: 0 };
}

function combine(
  left: AggregateNode | undefined,
  right: AggregateNode | undefined,
  target?: AggregateNode,
): AggregateNode | undefined {
  if (left === undefined || right === undefined) {
    const child = left ?? right;
    if (child === undefined) return undefined;
    const count = child.count;
    const mean = child.mean;
    const deviation = child.deviation;
    if (target !== undefined) {
      target.left = left;
      target.right = right;
      target.count = count;
      target.mean = mean;
      target.deviation = deviation;
      target.coefficients = undefined;
      return target;
    }
    return { left, right, count, mean, deviation };
  }

  const count = left.count + right.count;
  if (!Number.isSafeInteger(count)) throw indicatorOverflow('Bollinger window count');
  // Mutable children have already been updated; compare saved primitive counts,
  // not counts reached through the target's child references.
  const saved = target?.coefficients;
  const cached =
    saved !== undefined && saved.leftCount === left.count && saved.rightCount === right.count
      ? saved
      : undefined;
  const leftWeight = cached === undefined ? left.count / count : cached.leftWeight;
  const rightWeight = cached === undefined ? right.count / count : cached.rightWeight;
  const directDelta = right.mean - left.mean;
  const mean = Number.isFinite(directDelta)
    ? safeAdd(left.mean, directDelta * rightWeight, 'Bollinger mean')
    : safeAdd(left.mean * leftWeight, right.mean * rightWeight, 'Bollinger mean');

  const crossFactor = cached === undefined ? Math.sqrt(leftWeight * rightWeight) : cached.crossFactor;
  const crossDeviation = Number.isFinite(directDelta)
    ? Math.abs(directDelta * crossFactor)
    : Math.abs(safeSub(right.mean * crossFactor, left.mean * crossFactor, 'Bollinger deviation'));
  let leftFactor: number;
  let rightFactor: number;
  const deviation = Math.hypot(
    left.deviation * (leftFactor = cached === undefined ? Math.sqrt(leftWeight) : cached.leftFactor),
    right.deviation * (rightFactor = cached === undefined ? Math.sqrt(rightWeight) : cached.rightFactor),
    crossDeviation,
  );
  if (!Number.isFinite(deviation)) throw indicatorOverflow('Bollinger deviation');
  if (target !== undefined) {
    target.left = left;
    target.right = right;
    target.count = count;
    target.mean = mean;
    target.deviation = deviation;
    if (cached === undefined) {
      // Only unpublished mutable nodes retain coefficients, after arithmetic succeeds.
      target.coefficients = {
        leftCount: left.count,
        rightCount: right.count,
        leftWeight,
        rightWeight,
        crossFactor,
        leftFactor,
        rightFactor,
      };
    }
    return target;
  }
  return { left, right, count, mean, deviation };
}

function updateTree(
  node: AggregateNode | undefined,
  low: number,
  high: number,
  index: number,
  value: number,
): AggregateNode {
  if (low === high) return leaf(value);
  const middle = low + Math.floor((high - low) / 2);
  if (index <= middle) {
    const left = updateTree(node?.left, low, middle, index, value);
    return combine(left, node?.right)!;
  }
  const right = updateTree(node?.right, middle + 1, high, index, value);
  return combine(node?.left, right)!;
}

/** Only for rows of a fresh, unpublished bulk calculator with no retained tree snapshot. */
function updateTreeMutable(
  node: AggregateNode | undefined,
  low: number,
  high: number,
  index: number,
  value: number,
): AggregateNode {
  if (low === high) {
    if (node === undefined) return leaf(value);
    node.mean = value;
    return node;
  }
  const middle = low + Math.floor((high - low) / 2);
  if (index <= middle) {
    const left = updateTreeMutable(node?.left, low, middle, index, value);
    return combine(left, node?.right, node)!;
  }
  const right = updateTreeMutable(node?.right, middle + 1, high, index, value);
  return combine(node?.left, right, node)!;
}

export class BollingerCalculator implements MultiOutputCalculator<BollingerName> {
  private root: AggregateNode | undefined;
  private count = 0;
  private head = 0;
  private preTail: BollingerSnapshot | undefined;
  private rollbackState: { snapshot: BollingerSnapshot; preTail: BollingerSnapshot | undefined } | undefined;
  private readonly current: {
    middle: number | undefined;
    upper: number | undefined;
    lower: number | undefined;
  } = {
    middle: undefined,
    upper: undefined,
    lower: undefined,
  };

  constructor(
    private readonly period: number,
    private readonly multiplier: number,
  ) {}

  push(input: ValidatedPoint, bulkIntermediate = false): BollingerPointResult {
    if (bulkIntermediate) return this.calculate(input, true);
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

  replaceTail(input: ValidatedPoint): BollingerPointResult {
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
  pushIntermediateInto(input: ValidatedPoint, columns: BollingerColumns, index: number): void {
    this.calculateValues(input, true);
    writeScalarColumn(columns.middle, index, this.current.middle);
    writeScalarColumn(columns.upper, index, this.current.upper);
    writeScalarColumn(columns.lower, index, this.current.lower);
  }

  private calculate(input: ValidatedPoint, mutableTree = false): BollingerPointResult {
    const time = input.point.time;
    this.calculateValues(input, mutableTree);
    const { middle, upper, lower } = this.current;
    return {
      middle: middle === undefined ? { time } : { time, value: middle },
      upper: upper === undefined ? { time } : { time, value: upper },
      lower: lower === undefined ? { time } : { time, value: lower },
    };
  }

  private calculateValues(input: ValidatedPoint, mutableTree = false): void {
    if (input.value === undefined) {
      this.root = undefined;
      this.count = 0;
      this.head = 0;
      this.current.middle = undefined;
      this.current.upper = undefined;
      this.current.lower = undefined;
      return;
    }

    const index = this.count < this.period ? this.count : this.head;
    this.root = mutableTree
      ? updateTreeMutable(this.root, 0, this.period - 1, index, input.value)
      : updateTree(this.root, 0, this.period - 1, index, input.value);

    if (this.count < this.period) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % this.period;
    }

    if (this.count < this.period) {
      this.current.middle = undefined;
      this.current.upper = undefined;
      this.current.lower = undefined;
      return;
    }

    const aggregate = this.root;
    if (aggregate === undefined || aggregate.count !== this.period) {
      throw indicatorOverflow('Bollinger window');
    }
    const spread = this.multiplier * aggregate.deviation;
    if (!Number.isFinite(spread)) throw indicatorOverflow('Bollinger band spread');
    const upper = safeAdd(aggregate.mean, spread, 'Bollinger upper band');
    const lower = safeSub(aggregate.mean, spread, 'Bollinger lower band');
    this.current.middle = aggregate.mean;
    this.current.upper = upper;
    this.current.lower = lower;
  }

  private snapshot(): BollingerSnapshot {
    return {
      root: this.root,
      count: this.count,
      head: this.head,
    };
  }

  private restore(snapshot: BollingerSnapshot): void {
    this.root = snapshot.root;
    this.count = snapshot.count;
    this.head = snapshot.head;
  }
}

export function validateBollingerOptions(options: BollingerBandsOptions): BollingerBandsOptions {
  assertExactOptions(options, ['period', 'multiplier'], 'Bollinger Bands');
  const { period, multiplier } = options;
  assertSafePeriod(period, 2, 'Bollinger Bands period');
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new ChartError(
      'INVALID_OPTIONS',
      'Bollinger Bands multiplier must be a finite number greater than zero',
    );
  }
  return { period, multiplier };
}

export interface StreamingBollingerBands {
  setData(points: readonly IndicatorPoint[]): void;
  update(point: IndicatorPoint): BollingerBandsResult<IndicatorPoint>;
  getData(): BollingerBandsResult<IndicatorPoint[]>;
}

export function bollingerBands(
  points: readonly IndicatorPoint[],
  options: BollingerBandsOptions,
): BollingerBandsResult<IndicatorPoint[]> {
  const copiedOptions = validateBollingerOptions(options);
  const checked = validatePoints(points, inferDomain(points));
  const calculator = new BollingerCalculator(copiedOptions.period, copiedOptions.multiplier);
  const output: BollingerBandsResult<IndicatorPoint[]> = { middle: [], upper: [], lower: [] };
  for (const point of checked) {
    const result = calculator.push(point);
    output.middle.push(result.middle);
    output.upper.push(result.upper);
    output.lower.push(result.lower);
  }
  return output;
}

export function createBollingerBands(
  options: BollingerBandsOptions,
  domain: TimeDomain = 'utc-ms',
): StreamingBollingerBands {
  const copiedOptions = validateBollingerOptions(options);
  return new MultiOutputStreaming(
    BOLLINGER_NAMES,
    domain,
    () => new BollingerCalculator(copiedOptions.period, copiedOptions.multiplier),
  );
}
