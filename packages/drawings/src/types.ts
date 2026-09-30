import type { ChartTime } from '@filtrix.net/charts';
import type { TimeDomain } from '@filtrix.net/core';
export type DrawingType =
  | 'trend-line'
  | 'horizontal-line'
  | 'rectangle'
  | 'measure'
  | 'fibonacci-retracement'
  | 'parallel-channel'
  | 'text-note';
export type DrawingTypeV1 = 'trend-line' | 'horizontal-line' | 'rectangle' | 'measure';
export type DrawingTool = 'select' | DrawingType;
export interface DrawingPoint {
  time: ChartTime;
  price: number;
}
export interface DrawingSnapCandidate extends DrawingPoint {
  field: 'open' | 'high' | 'low' | 'close';
}
export interface DrawingSnapRequest {
  paneId: string;
  point: DrawingPoint;
}
export type DrawingSnapProvider = (request: DrawingSnapRequest) => readonly DrawingSnapCandidate[];
export interface DrawingStyle {
  color: string;
  lineWidth: number;
  fillOpacity: number;
}
export interface FibonacciLevel {
  ratio: number;
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
}
interface DrawingBase {
  id: string;
  paneId: string;
  points: readonly DrawingPoint[];
  style: DrawingStyle;
  locked: boolean;
  visible: boolean;
}
export interface StandardDrawing extends DrawingBase {
  type: DrawingTypeV1;
}
export interface FibonacciDrawing extends DrawingBase {
  type: 'fibonacci-retracement';
  levels: readonly FibonacciLevel[];
}
export interface ParallelChannelDrawing extends DrawingBase {
  type: 'parallel-channel';
}
export interface TextNoteDrawing extends DrawingBase {
  type: 'text-note';
  text: string;
  fontSize: number;
}
export type Drawing = StandardDrawing | FibonacciDrawing | ParallelChannelDrawing | TextNoteDrawing;
export interface DrawingV1 {
  id: string;
  type: DrawingTypeV1;
  paneId: string;
  points: readonly DrawingPoint[];
  style: DrawingStyle;
}
export interface DrawingInput {
  id?: string;
  type: DrawingType;
  paneId?: string;
  points: readonly DrawingPoint[];
  style?: Partial<DrawingStyle>;
  locked?: boolean;
  visible?: boolean;
  levels?: readonly FibonacciLevel[];
  text?: string;
  fontSize?: number;
}
export interface DrawingPatch {
  points?: readonly DrawingPoint[];
  style?: Partial<DrawingStyle>;
  paneId?: string;
  locked?: boolean;
  visible?: boolean;
  levels?: readonly FibonacciLevel[];
  text?: string;
  fontSize?: number;
}
export interface DrawingDocumentV1 {
  schema: 'filtix-drawings';
  version: 1;
  timeDomain: TimeDomain;
  drawings: readonly DrawingV1[];
}
export interface DrawingDocument {
  schema: 'filtix-drawings';
  version: 2;
  timeDomain: TimeDomain;
  drawings: readonly Drawing[];
}
export interface DrawingStoreOptions {
  timeDomain?: TimeDomain;
  maxDrawings?: number;
  maxHistory?: number;
}
export interface DrawingHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}
export interface DrawingStore {
  readonly timeDomain: TimeDomain;
  add(input: DrawingInput): string;
  update(id: string, patch: DrawingPatch): void;
  remove(id: string): void;
  clear(): void;
  get(id: string): Drawing | null;
  list(): readonly Drawing[];
  undo(): boolean;
  redo(): boolean;
  getHistoryState(): DrawingHistoryState;
  subscribe(listener: () => void): () => void;
  toJSON(): DrawingDocument;
  restore(document: unknown): void;
}
export interface DrawingMeasurement {
  priceChange: number | null;
  percentChange: number | null;
  elapsedMs: number;
}
export interface DrawingLayerState {
  tool: DrawingTool;
  selectedId: string | null;
  drawingCount: number;
  canUndo: boolean;
  canRedo: boolean;
  magnet: boolean;
}
export interface DrawingLayerOptions {
  store?: DrawingStore;
  paneId?: string;
  style?: Partial<DrawingStyle>;
  onState?(state: DrawingLayerState): void;
  snapProvider?: DrawingSnapProvider;
  snapDistance?: number;
  magnet?: boolean;
}
export interface DrawingLayer {
  readonly store: DrawingStore;
  setTool(tool: DrawingTool): void;
  select(id: string | null): void;
  setStyle(style: Partial<DrawingStyle>): void;
  setMagnet(enabled: boolean): void;
  getState(): DrawingLayerState;
  destroy(): void;
}
