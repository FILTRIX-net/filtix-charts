# FILTRIX primitive overlay contract v0.3

Governing [spec](../SOURCE-DISTRIBUTION.md#omitted-development-materials). Additive ChartApi.attachPrimitive(primitive: ChartPrimitive): () => void.

```ts
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
```

## v0.8 pane visibility

Maximizing a pane preserves source data and resources but gives other panes zero geometry. `PrimitiveProjection.panes` contains only positive-height panes; price conversion methods return null for suppressed panes. `PrimitiveHost.root` remains the chart interaction root; separator controls are siblings outside that root and add no canvas. The bundled drawing layer honors projected pane visibility. Custom primitives receive a raw canvas context and must use the supplied projection to decide which pane content to paint; arbitrary custom drawing is not semantically filtered by the engine.
