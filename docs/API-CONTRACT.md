# FILTIX Charts implementation contracts

This document records the original v0.1 engine contract. The additive v0.7 band-series and multi-output indicator interfaces are specified in [the v0.7 design](../SOURCE-DISTRIBUTION.md#omitted-development-materials). The additive v0.8 pane layout, resize intent/availability and pure geometry interfaces are specified in [the v0.8 design](../SOURCE-DISTRIBUTION.md#omitted-development-materials); see [the current API guide](API.md) for examples.

Approved design: [v0.1 spec](../SOURCE-DISTRIBUTION.md#omitted-development-materials).
These signatures freeze the cross-task interfaces. Implementers may add private helpers; coordinate changes to these exports with root.

## Core (Task 1)

```ts
type UtcMillis = number & { readonly __utcMillis: 'FILTIX.UtcMillis' };
type ChartTime = UtcMillis | number | string;
type TimeDomain = 'utc-ms' | 'business-date';
type SeriesType = 'candlestick' | 'ohlc' | 'line' | 'area' | 'histogram';
type ScaleMode = 'linear' | 'log';
interface WhitespacePoint {
  time: ChartTime;
}
interface CandlePoint extends WhitespacePoint {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
interface ValuePoint extends WhitespacePoint {
  value: number;
}
type SeriesPoint = CandlePoint | ValuePoint | WhitespacePoint;
interface LogicalRange {
  from: number;
  to: number;
}
interface RangeStats {
  min: number;
  max: number;
  minIndex: number;
  maxIndex: number;
  volume: number;
  count: number;
}
// min/max on candle stores use low/high; on value stores use value.
// minIndex/maxIndex refer to the source indices with those extrema; ties choose first.
class ChartError extends Error {
  readonly code: string;
}
function isChartError(value: unknown): value is ChartError;
function utcMillis(value: number): UtcMillis;
function timeKey(time: ChartTime, domain: TimeDomain): number;
function timeFromKey(key: number, domain: TimeDomain): ChartTime;
function lowerBound(values: ArrayLike<number>, key: number): number;
class SeriesStore {
  constructor(type: SeriesType, domain?: TimeDomain);
  readonly type: SeriesType;
  readonly domain: TimeDomain;
  readonly length: number;
  readonly revision: number;
  setData(points: readonly SeriesPoint[]): void; // validate/copy then swap; atomic
  update(point: SeriesPoint): 'append' | 'replace'; // earlier than own newest throws
  pointAt(index: number): SeriesPoint | null; // fresh snapshot, original time type
  keyAt(index: number): number; // normalized numeric key, NaN outside
  valueAt(index: number): number; // close/value, NaN for whitespace/outside
  openAt(index: number): number;
  highAt(index: number): number;
  lowAt(index: number): number;
  closeAt(index: number): number;
  volumeAt(index: number): number;
  lowerBound(key: number): number;
  range(from: number, to: number): RangeStats | null; // inclusive indices, clipped, O(log n)
  segments(from: number, to: number): Array<{ from: number; to: number }>; // non-whitespace, inclusive
}
interface PriceScale {
  min: number;
  max: number;
  priceToY(value: number): number;
  yToPrice(y: number): number;
  ticks(count?: number): number[];
}
function createPriceScale(
  min: number,
  max: number,
  top: number,
  height: number,
  mode?: ScaleMode,
): PriceScale;
function clampRange(range: LogicalRange, total: number): LogicalRange;
// preserve width when clamping; total=0 -> {from:0,to:1}; minimum width 1; maximum width max(1,total-1).
```

Store uses amortized typed numeric arrays and a min/max/sum index; range excludes whitespace. Store itself allows finite non-positive values; chart enforces pane logarithmic policy. Candle volume is optional and nonnegative. Price scale expands flat ranges and handles magnitudes 1e-8 to 1e9 and finite extreme overflow defensively.

## Browser charts (Task 3)

```ts
interface ChartTheme {
  background: string;
  text: string;
  mutedText: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  accent: string;
  fontFamily: string;
  fontSize: number;
}
interface ChartLegendOptions {
  visible?: boolean;
  maxRows?: number;
}
interface ChartOptions {
  theme?: 'dark' | 'light' | Partial<ChartTheme>;
  timeDomain?: TimeDomain;
  locale?: string;
  timeZone?: string;
  autoSize?: boolean;
  width?: number;
  height?: number;
  crosshair?: boolean;
  followLatest?: boolean;
  diagnostics?: boolean;
  ariaLabel?: string;
  maxPixelRatio?: number;
  legend?: ChartLegendOptions;
}
interface PaneOptions {
  id?: string;
  weight?: number;
  scale?: ScaleMode;
  minHeight?: number;
}
interface PaneHandle {
  readonly id: string;
  applyOptions(options: Partial<PaneOptions>): void;
  remove(): void;
}
interface SeriesOptions {
  id?: string;
  paneId?: string;
  title?: string;
  color?: string;
  upColor?: string;
  downColor?: string;
  lineWidth?: number;
  pricePrecision?: number;
  tickSize?: number;
  lastValueVisible?: boolean;
  priceLineVisible?: boolean;
  connectGaps?: boolean;
}
interface SeriesHandle {
  readonly id: string;
  readonly type: SeriesType;
  setData(data: readonly SeriesPoint[]): void;
  update(point: SeriesPoint): void;
  applyOptions(options: Partial<SeriesOptions>): void;
  getData(): readonly SeriesPoint[];
  remove(): void;
}
interface CrosshairEvent {
  time: ChartTime | null;
  logicalIndex: number | null;
  x: number;
  y: number;
  points: Readonly<Record<string, SeriesPoint | null>>;
}
interface ChartDiagnostics {
  sceneDraws: number;
  overlayDraws: number;
  lastRenderMs: number;
  lastIngestMs: number;
  renderedPrimitives: number;
  dataPoints: number;
  seriesCount: number;
  framePending: boolean;
}
interface ChartApi {
  addPane(options?: PaneOptions): PaneHandle;
  removePane(id: string): void;
  addSeries(type: SeriesType, options?: SeriesOptions): SeriesHandle;
  removeSeries(id: string): void;
  applyOptions(options: Partial<ChartOptions>): void;
  fitContent(): void;
  getVisibleRange(): LogicalRange;
  setVisibleRange(range: LogicalRange): void;
  scrollToLatest(): void;
  timeToCoordinate(time: ChartTime): number | null;
  coordinateToTime(x: number): ChartTime | null;
  priceToCoordinate(price: number, paneId?: string): number | null;
  coordinateToPrice(y: number, paneId?: string): number | null;
  subscribeCrosshairMove(callback: (event: CrosshairEvent) => void): () => void;
  subscribeVisibleRangeChange(callback: (range: LogicalRange) => void): () => void;
  exportImage(): Promise<Blob>;
  getDiagnostics(): Readonly<ChartDiagnostics>;
  whenIdle(): Promise<void>; // queued render SUBMISSION complete, not physical presentation; resolves on destroy
  destroy(): void;
}
function createChart(container: HTMLElement, options?: ChartOptions): ChartApi;
const darkTheme: Readonly<ChartTheme>;
const lightTheme: Readonly<ChartTheme>;
```

A default price pane with id `price` exists. A series with no paneId uses it; after removing every pane, addPane explicitly before adding series. Pane log mode validates every attached data value. Shared timeline is union; setData rebuilds union atomically, update either extends tail or fills/replaces an existing slot under the approved spec. IDs are immutable. Invalid options/operations must not mutate state. Coordinate methods return null outside plot/data. All chart-owned references/resources are released on destroy. Crosshair snapshots use exact original data and null gaps, never aggregate values.

## Indicators (Task 2)

```ts
function sma(
  points: readonly (ValuePoint | WhitespacePoint)[],
  period: number,
): Array<ValuePoint | WhitespacePoint>;
function ema(
  points: readonly (ValuePoint | WhitespacePoint)[],
  period: number,
): Array<ValuePoint | WhitespacePoint>;
function rsi(
  points: readonly (ValuePoint | WhitespacePoint)[],
  period: number,
): Array<ValuePoint | WhitespacePoint>;
interface StreamingIndicator {
  setData(points: readonly (ValuePoint | WhitespacePoint)[]): void;
  update(point: ValuePoint | WhitespacePoint): ValuePoint | WhitespacePoint;
  getData(): Array<ValuePoint | WhitespacePoint>;
}
function createIndicator(
  kind: 'sma' | 'ema' | 'rsi',
  period: number,
  domain?: TimeDomain,
): StreamingIndicator;
```

Pure transforms preserve timestamps and length, emit whitespace during warm-up, reset on gaps, reject nonfinite inputs and invalid periods atomically. Streaming same-tail replacement restores state before that input then computes anew; append is O(1), batch initialization O(n). getData copies, no caller mutation. Formulas and RSI flat behavior come from spec section 4.

## React (Task 4)

```tsx
interface FiltixChartProps {
  options?: ChartOptions;
  className?: string;
  style?: React.CSSProperties;
  onReady?: (chart: ChartApi) => void;
  onDestroy?: () => void;
}
const FiltixChart: React.ForwardRefExoticComponent<FiltixChartProps & React.RefAttributes<ChartApi | null>>;
```

No data prop diffing: onReady owns initial series; ref exposes update API. Options patches do not remount. StrictMode lifecycle and latest callbacks supported. React peer dependency, SSR-safe import, no frame state in React.
