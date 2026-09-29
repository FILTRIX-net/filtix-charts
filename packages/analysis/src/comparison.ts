import {
  ChartError,
  timeKey,
  type ChartTime,
  type TimeDomain,
  type ValuePoint,
  type WhitespacePoint,
} from '@filtix/core';
import type { ComparisonInput, ComparisonOptions, IndexedComparison } from './types';

type CheckedPoint = {
  readonly time: ChartTime;
  readonly key: number;
  readonly value: number | undefined;
};

type CheckedAsset = {
  readonly id: string;
  readonly points: readonly CheckedPoint[];
  readonly present: ReadonlyMap<number, CheckedPoint>;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function fail(code: string, message: string): never {
  throw new ChartError(code, message);
}

function assertDomain(domain: unknown): asserts domain is TimeDomain {
  if (domain !== 'utc-ms' && domain !== 'business-date') {
    fail('INVALID_TIME_DOMAIN', `Unknown time domain: ${String(domain)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function checkPoint(point: unknown, domain: TimeDomain, previousKey: number | undefined): CheckedPoint {
  if (!isRecord(point) || !('time' in point)) {
    fail('INVALID_POINT', 'Comparison points must contain a time');
  }

  const time = point.time as ChartTime;
  const key = timeKey(time, domain);
  if (previousKey !== undefined && key <= previousKey) {
    fail('INVALID_TIME_ORDER', 'Comparison times must be strictly increasing');
  }

  if (Object.prototype.hasOwnProperty.call(point, 'value')) {
    const value = point.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail('INVALID_VALUE', 'Comparison prices must be finite positive numbers');
    }
    return { time, key, value };
  }

  return { time, key, value: undefined };
}

function checkInputs(inputs: readonly ComparisonInput[], domain: TimeDomain): CheckedAsset[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail('INVALID_DATA', 'Comparison requires at least one asset');
  }

  const seenIds = new Set<string>();
  return inputs.map((input) => {
    if (!isRecord(input) || typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
      fail('INVALID_ID', 'Comparison asset ids must be 1-80 ASCII letters, digits, underscores, or hyphens');
    }
    if (seenIds.has(input.id)) {
      fail('DUPLICATE_ID', `Comparison asset id is duplicated: ${input.id}`);
    }
    seenIds.add(input.id);

    if (!Array.isArray(input.points)) {
      fail('INVALID_DATA', `Comparison points for ${input.id} must be an array`);
    }

    const checkedPoints: CheckedPoint[] = [];
    const present = new Map<number, CheckedPoint>();
    let previousKey: number | undefined;
    for (const point of input.points) {
      const checked = checkPoint(point, domain, previousKey);
      checkedPoints.push(checked);
      if (checked.value !== undefined) present.set(checked.key, checked);
      previousKey = checked.key;
    }
    return { id: input.id, points: checkedPoints, present };
  });
}

/**
 * Multiplies two positive finite values and divides by a third while trying
 * division-first orderings. This accepts representable results whose direct
 * product would overflow, and rejects results that cannot be represented as a
 * positive finite JavaScript number.
 */
function safeNormalize(baseValue: number, value: number, baseline: number): number {
  const directProduct = baseValue * value;
  if (Number.isFinite(directProduct) && directProduct > 0) {
    const direct = directProduct / baseline;
    if (Number.isFinite(direct) && direct > 0) return direct;
  }

  const baseRatio = baseValue / baseline;
  if (Number.isFinite(baseRatio) && baseRatio > 0) {
    const ordered = baseRatio * value;
    if (Number.isFinite(ordered) && ordered > 0) return ordered;
  }

  const valueRatio = value / baseline;
  if (Number.isFinite(valueRatio) && valueRatio > 0) {
    const ordered = valueRatio * baseValue;
    if (Number.isFinite(ordered) && ordered > 0) return ordered;
  }

  fail('COMPARISON_OVERFLOW', 'Indexed comparison contains an unrepresentable normalized value');
}

function clonePoint(point: CheckedPoint, normalizedValue: number | undefined): ValuePoint | WhitespacePoint {
  return normalizedValue === undefined ? { time: point.time } : { time: point.time, value: normalizedValue };
}

export function buildIndexedComparison(
  inputs: readonly ComparisonInput[],
  options: ComparisonOptions = {},
): readonly IndexedComparison[] {
  if (!isRecord(options) || Array.isArray(options))
    fail('INVALID_OPTIONS', 'Comparison options must be an object');

  const suppliedDomain = options.timeDomain as unknown;
  const domain = suppliedDomain === undefined ? 'utc-ms' : suppliedDomain;
  assertDomain(domain);

  const suppliedBaseValue = options.baseValue as unknown;
  const baseValue = suppliedBaseValue === undefined ? 100 : suppliedBaseValue;
  if (typeof baseValue !== 'number' || !Number.isFinite(baseValue) || baseValue <= 0) {
    fail('INVALID_BASE_VALUE', 'Comparison baseValue must be a finite positive number');
  }

  const assets = checkInputs(inputs, domain);
  const requestedBaseline = options.baselineTime as ChartTime | null | undefined;
  let baselineKey: number;
  if (requestedBaseline !== undefined) {
    if (requestedBaseline === null)
      fail('INVALID_BASELINE', 'Comparison baselineTime must be a valid chart time');
    baselineKey = timeKey(requestedBaseline, domain);
    if (assets.some((asset) => !asset.present.has(baselineKey))) {
      fail('INVALID_BASELINE', 'Requested comparison baseline must be present in every asset');
    }
  } else {
    const first = assets[0]!;
    baselineKey = [...first.present.keys()].find((key) => assets.every((asset) => asset.present.has(key)))!;
    if (baselineKey === undefined) {
      fail('NO_COMMON_BASELINE', 'Comparison assets have no common present timestamp');
    }
  }

  const baselines = assets.map((asset) => asset.present.get(baselineKey)!);
  const output: IndexedComparison[] = [];
  for (let assetIndex = 0; assetIndex < assets.length; assetIndex += 1) {
    const asset = assets[assetIndex]!;
    const baseline = baselines[assetIndex]!;
    const points = asset.points.map((point) =>
      clonePoint(
        point,
        point.value === undefined ? undefined : safeNormalize(baseValue, point.value, baseline.value!),
      ),
    );
    output.push({
      id: asset.id,
      baseline: { time: baseline.time, value: baseline.value! },
      points,
    });
  }
  return output;
}
