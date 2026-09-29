import type {
  ChartTime,
  TimeDomain,
  ScaleMode,
  SeriesType,
  SeriesPoint,
  LogicalRange,
  SeriesStore,
  PriceScale,
} from '@filtix/core';
import type { ChartPrimitive } from './primitives.types';
export type {
  ChartTime,
  TimeDomain,
  ScaleMode,
  SeriesType,
  SeriesPoint,
  LogicalRange,
  CandlePoint,
  ValuePoint,
  BandPoint,
  WhitespacePoint,
  UtcMillis,
} from '@filtix/core';
export interface ChartTheme {
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
export interface ChartLegendOptions {
  visible?: boolean;
  maxRows?: number;
}
export interface ChartOptions {
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
export interface PaneOptions {
  id?: string;
  weight?: number;
  scale?: ScaleMode;
  minHeight?: number;
}
export interface PaneLayoutOptions {
  id: string;
  weight: number;
  minHeight: number;
}
export interface PaneLayoutPatch {
  id: string;
  weight?: number;
  minHeight?: number;
}
export interface ChartPaneLayout {
  panes: readonly PaneLayoutOptions[];
  maximizedPaneId: string | null;
}
export interface ChartPaneLayoutPatch {
  panes?: readonly PaneLayoutPatch[];
  maximizedPaneId?: string | null;
}
export interface MeasuredPaneLayout {
  id: string;
  top: number;
  height: number;
}
export interface MeasuredChartPaneLayout {
  plotHeight: number;
  panes: readonly MeasuredPaneLayout[];
}
export interface PaneHandle {
  readonly id: string;
  applyOptions(options: Partial<PaneOptions>): void;
  remove(): void;
}
export interface SeriesOptions {
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
  fillOpacity?: number;
}
export interface SeriesHandle {
  readonly id: string;
  readonly type: SeriesType;
  setData(data: readonly SeriesPoint[]): void;
  update(point: SeriesPoint): void;
  applyOptions(options: Partial<SeriesOptions>): void;
  getData(): readonly SeriesPoint[];
  remove(): void;
}
export interface TimeRange {
  from: ChartTime;
  to: ChartTime;
}
export interface ChartChangeMeta {
  readonly revision: number;
  readonly cause: 'interaction' | 'api' | 'data';
  readonly origin?: object;
}
export interface ChartMutationMeta {
  origin?: object;
}
export interface CrosshairTimeOptions extends ChartMutationMeta {
  match?: 'exact' | 'nearest';
}
export interface CrosshairEvent {
  time: ChartTime | null;
  logicalIndex: number | null;
  x: number;
  y: number;
  points: Readonly<Record<string, SeriesPoint | null>>;
}
export interface ChartDiagnostics {
  sceneDraws: number;
  overlayDraws: number;
  primitiveDraws: number;
  primitiveCount: number;
  lastRenderMs: number;
  lastIngestMs: number;
  renderedPrimitives: number;
  dataPoints: number;
  seriesCount: number;
  framePending: boolean;
}
export interface ChartApi {
  readonly timeDomain: TimeDomain;
  getChangeRevision(): number;
  getVisibleTimeRange(): TimeRange | null;
  setVisibleTimeRange(range: TimeRange, meta?: ChartMutationMeta): TimeRange | null;
  setCrosshairTime(time: ChartTime | null, options?: CrosshairTimeOptions): ChartTime | null;
  getPaneLayout(): ChartPaneLayout;
  applyPaneLayout(patch: ChartPaneLayoutPatch, meta?: ChartMutationMeta): void;
  resizePane(paneId: string, deltaCssPixels: number, meta?: ChartMutationMeta): void;
  canResizePane(paneId: string, deltaCssPixels: number): boolean;
  subscribePaneLayoutChange(listener: (layout: ChartPaneLayout, meta: ChartChangeMeta) => void): () => void;
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
  subscribeCrosshairMove(callback: (event: CrosshairEvent, meta: ChartChangeMeta) => void): () => void;
  subscribeVisibleRangeChange(callback: (range: LogicalRange, meta: ChartChangeMeta) => void): () => void;
  attachPrimitive(primitive: ChartPrimitive): () => void;
  exportImage(): Promise<Blob>;
  getDiagnostics(): Readonly<ChartDiagnostics>;
  whenIdle(): Promise<void>;
  destroy(): void;
}
export interface PaneState {
  id: string;
  options: Required<Omit<PaneOptions, 'id'>>;
  top: number;
  height: number;
  scale: PriceScale | null;
}
export interface SeriesState {
  id: string;
  type: SeriesType;
  options: SeriesOptions;
  paneId: string;
  store: SeriesStore;
  runs: Array<{ from: number; to: number }>;
}
export interface Scene {
  width: number;
  height: number;
  plotWidth: number;
  plotHeight: number;
  dpr: number;
  theme: ChartTheme;
  options: ChartOptions;
  timeline: number[];
  range: LogicalRange;
  panes: PaneState[];
  series: SeriesState[];
}
