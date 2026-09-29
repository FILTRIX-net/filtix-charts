# FILTIX Drawings contract v0.3

Governing [spec](../SOURCE-DISTRIBUTION.md#omitted-development-materials).

```ts
import type { ChartApi, ChartTime } from '@filtix/charts';
import type { TimeDomain } from '@filtix/core';
export type DrawingType = 'trend-line' | 'horizontal-line' | 'rectangle' | 'measure';
export type DrawingTool = 'select' | DrawingType;
export interface DrawingPoint { time: ChartTime; price: number }
export interface DrawingStyle { color: string; lineWidth: number; fillOpacity: number }
export interface Drawing {
  id: string;
  type: DrawingType;
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
}
export interface DrawingPatch { points?: readonly DrawingPoint[]; style?: Partial<DrawingStyle>; paneId?: string }
export interface DrawingDocument {
  schema: 'filtix-drawings';
  version: 1;
  timeDomain: TimeDomain;
  drawings: readonly Drawing[];
}
export interface DrawingStoreOptions { timeDomain?: TimeDomain; maxDrawings?: number; maxHistory?: number }
export interface DrawingHistoryState { canUndo: boolean; canRedo: boolean }
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
}
export interface DrawingLayerOptions {
  store?: DrawingStore;
  paneId?: string;
  style?: Partial<DrawingStyle>;
  onState?(state: DrawingLayerState): void;
}
export interface DrawingLayer {
  readonly store: DrawingStore;
  setTool(tool: DrawingTool): void;
  select(id: string | null): void;
  setStyle(style: Partial<DrawingStyle>): void;
  getState(): DrawingLayerState;
  destroy(): void;
}
export declare function createDrawingStore(options?: DrawingStoreOptions): DrawingStore;
export declare function measureDrawing(drawing: Drawing, timeDomain?: TimeDomain): DrawingMeasurement | null;
export declare function createDrawingLayer(chart: ChartApi, options?: DrawingLayerOptions): DrawingLayer;
```

Lifecycle clarification: layer.destroy() is idempotent and leaves its pure store usable. getState() after destruction returns the last cached layer state; mutating layer methods reject further use.
