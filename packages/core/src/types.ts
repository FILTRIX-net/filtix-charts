export type UtcMillis = number & { readonly __utcMillis: 'FILTIX.UtcMillis' };
export type ChartTime = UtcMillis | number | string;
export type TimeDomain = 'utc-ms' | 'business-date';
export type SeriesType = 'candlestick' | 'ohlc' | 'line' | 'area' | 'histogram' | 'band';
export type ScaleMode = 'linear' | 'log';

export interface WhitespacePoint {
  time: ChartTime;
}

export interface CandlePoint extends WhitespacePoint {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface ValuePoint extends WhitespacePoint {
  value: number;
}

export interface BandPoint extends WhitespacePoint {
  upper: number;
  lower: number;
}

export type SeriesPoint = CandlePoint | ValuePoint | BandPoint | WhitespacePoint;

export interface LogicalRange {
  from: number;
  to: number;
}

export interface RangeStats {
  min: number;
  max: number;
  minIndex: number;
  maxIndex: number;
  volume: number;
  count: number;
}

export interface BandRangeStats {
  lowerMin: number;
  lowerMax: number;
  upperMin: number;
  upperMax: number;
  lowerMinIndex: number;
  lowerMaxIndex: number;
  upperMinIndex: number;
  upperMaxIndex: number;
  count: number;
}

export interface PriceScale {
  min: number;
  max: number;
  priceToY(value: number): number;
  yToPrice(y: number): number;
  ticks(count?: number): number[];
}

export class ChartError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ChartError';
    this.code = code;
  }
}

/** Recognizes errors across independently bundled packages and serialized error envelopes. */
export function isChartError(value: unknown): value is ChartError {
  if (value === null || typeof value !== 'object') return false;
  const error = value as Partial<ChartError>;
  return error.name === 'ChartError' && typeof error.code === 'string' && typeof error.message === 'string';
}
