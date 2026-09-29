import type { ChartTime, TimeDomain, ScaleMode } from '@filtix/core';
import type { ChartTheme } from './types';
export type PrimitiveMode = 'screen' | 'export';
export interface PrimitiveProjection {
  readonly width: number;
  readonly height: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly dpr: number;
  readonly timeDomain: TimeDomain;
  readonly theme: Readonly<ChartTheme>;
  readonly panes: readonly {
    readonly id: string;
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly scale: ScaleMode;
  }[];
  timeToX(time: ChartTime): number | null;
  timeToLogicalIndex(time: ChartTime): number | null;
  logicalIndexToTime(index: number): ChartTime | null;
  priceToY(price: number, paneId?: string): number | null;
  xToTime(x: number): ChartTime | null;
  yToPrice(y: number, paneId?: string): number | null;
}
export interface PrimitiveHost {
  readonly root: HTMLElement;
  invalidate(): void;
  getProjection(): PrimitiveProjection;
}
export interface ChartPrimitive {
  draw(context: CanvasRenderingContext2D, projection: PrimitiveProjection, mode: PrimitiveMode): void;
  attach?(host: PrimitiveHost): void | (() => void);
}
