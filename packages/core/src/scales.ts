import { ChartError, type LogicalRange, type PriceScale, type ScaleMode } from './types';

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ChartError('INVALID_SCALE', `${label} must be finite`);
  }
}

function expandLinear(value: number): [number, number] {
  if (value === 0) return [-1, 1];
  const padding = Math.max(Math.abs(value) * 0.01, 1e-12);
  const lower = value - padding;
  const upper = value + padding;
  if (Number.isFinite(lower) && lower < value && Number.isFinite(upper) && upper > value) {
    return [lower, upper];
  }
  if (Number.isFinite(lower) && lower < value) return [lower, value];
  if (Number.isFinite(upper) && upper > value) return [value, upper];
  throw new ChartError('INVALID_SCALE', 'Flat range cannot be expanded');
}

function expandLog(value: number): [number, number] {
  const lower = value / 1.01;
  const upper = value * 1.01;
  if (lower > 0 && lower < value && Number.isFinite(upper) && upper > value) return [lower, upper];
  if (lower > 0 && lower < value) return [lower, value];
  if (Number.isFinite(upper) && upper > value) return [value, upper];

  const doubled = value * 2;
  if (Number.isFinite(doubled) && doubled > value) return [value, doubled];
  const halved = value / 2;
  if (halved > 0 && halved < value) return [halved, value];
  throw new ChartError('INVALID_SCALE', 'Flat logarithmic range cannot be expanded');
}

function linearFraction(value: number, min: number, max: number): number {
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  return (value / magnitude - min / magnitude) / (max / magnitude - min / magnitude);
}

function interpolate(min: number, max: number, fraction: number): number {
  if (fraction === 0) return min;
  if (fraction === 1) return max;
  return (1 - fraction) * min + fraction * max;
}

function tickCount(count: number | undefined): number {
  const resolved = count ?? 5;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new ChartError('INVALID_SCALE', 'Tick count must be a positive integer');
  }
  return resolved;
}

class NumericPriceScale implements PriceScale {
  readonly min: number;
  readonly max: number;
  private readonly bottom: number;
  private readonly height: number;
  private readonly mode: ScaleMode;
  private readonly logMin: number;
  private readonly logMax: number;
  private readonly logSpan: number;

  constructor(min: number, max: number, top: number, height: number, mode: ScaleMode) {
    this.min = min;
    this.max = max;
    this.bottom = top + height;
    this.height = height;
    this.mode = mode;
    this.logMin = mode === 'log' ? Math.log(min) : 0;
    this.logMax = mode === 'log' ? Math.log(max) : 0;
    this.logSpan = this.logMax - this.logMin;
  }

  priceToY(value: number): number {
    if (!Number.isFinite(value) || (this.mode === 'log' && value <= 0)) return Number.NaN;
    const fraction =
      this.mode === 'log'
        ? this.logSpan > 0
          ? (Math.log(value) - this.logMin) / this.logSpan
          : (value - this.min) / (this.max - this.min)
        : linearFraction(value, this.min, this.max);
    return this.bottom - fraction * this.height;
  }

  yToPrice(y: number): number {
    if (!Number.isFinite(y)) return Number.NaN;
    const fraction = (this.bottom - y) / this.height;
    if (this.mode === 'log') {
      if (fraction === 0) return this.min;
      if (fraction === 1) return this.max;
      if (this.logSpan === 0) return interpolate(this.min, this.max, fraction);
      const value = Math.exp(interpolate(this.logMin, this.logMax, fraction));
      return Number.isFinite(value) ? value : fraction < 0 ? Number.MIN_VALUE : Number.MAX_VALUE;
    }
    return interpolate(this.min, this.max, fraction);
  }

  ticks(count?: number): number[] {
    const length = tickCount(count);
    if (length === 1) return [this.min];
    const result = new Array<number>(length);
    for (let index = 0; index < length; index += 1) {
      const fraction = index / (length - 1);
      if (index === 0) result[index] = this.min;
      else if (index === length - 1) result[index] = this.max;
      else if (this.mode === 'log' && this.logSpan > 0)
        result[index] = Math.exp(interpolate(this.logMin, this.logMax, fraction));
      else if (this.mode === 'log') result[index] = interpolate(this.min, this.max, fraction);
      else result[index] = interpolate(this.min, this.max, fraction);
    }
    return result;
  }
}

export function createPriceScale(
  min: number,
  max: number,
  top: number,
  height: number,
  mode: ScaleMode = 'linear',
): PriceScale {
  assertFinite(min, 'Scale minimum');
  assertFinite(max, 'Scale maximum');
  assertFinite(top, 'Scale top');
  assertFinite(height, 'Scale height');
  if (height <= 0 || !Number.isFinite(top + height)) {
    throw new ChartError('INVALID_SCALE', 'Scale height must be positive with a finite bottom edge');
  }
  if (mode !== 'linear' && mode !== 'log') {
    throw new ChartError('INVALID_SCALE', `Unknown scale mode: ${String(mode)}`);
  }
  if (min > max) {
    throw new ChartError('INVALID_SCALE', 'Scale minimum cannot exceed its maximum');
  }
  if (mode === 'log' && min <= 0) {
    throw new ChartError('INVALID_SCALE', 'Logarithmic scales require positive bounds');
  }

  let effectiveMin = min;
  let effectiveMax = max;
  if (effectiveMin === effectiveMax) {
    [effectiveMin, effectiveMax] = mode === 'log' ? expandLog(effectiveMin) : expandLinear(effectiveMin);
  }
  return new NumericPriceScale(effectiveMin, effectiveMax, top, height, mode);
}

export function clampRange(range: LogicalRange, total: number): LogicalRange {
  if (!Number.isInteger(total) || total < 0) {
    throw new ChartError('INVALID_RANGE', 'Total must be a nonnegative integer');
  }
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from > range.to) {
    throw new ChartError('INVALID_RANGE', 'Logical range must contain ordered finite bounds');
  }
  if (total <= 1) return { from: 0, to: 1 };

  const extent = total - 1;
  const originalWidth = range.to - range.from;
  const width = Math.min(extent, Math.max(1, originalWidth));
  if (width === extent) return { from: 0, to: extent };
  if (range.to <= 0) return { from: 0, to: width };
  if (range.from >= extent) return { from: extent - width, to: extent };
  const center = range.from / 2 + range.to / 2;
  let from = center - width / 2;
  let to = center + width / 2;
  if (from < 0) {
    to -= from;
    from = 0;
  }
  if (to > extent) {
    from -= to - extent;
    to = extent;
  }
  return { from, to };
}
