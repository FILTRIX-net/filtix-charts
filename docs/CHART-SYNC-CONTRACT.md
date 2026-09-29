# FILTIX chart synchronization contract v0.4

Governing [design](../SOURCE-DISTRIBUTION.md#omitted-development-materials).

```ts
export interface TimeRange { from: ChartTime; to: ChartTime }
export interface ChartChangeMeta { readonly revision: number; readonly cause: 'interaction' | 'api' | 'data'; readonly origin?: object }
export interface ChartMutationMeta { origin?: object }
export interface CrosshairTimeOptions extends ChartMutationMeta { match?: 'exact' | 'nearest' }
// Additive ChartApi members:
// readonly timeDomain: TimeDomain;
// getChangeRevision(): number;
// getVisibleTimeRange(): TimeRange | null;
// setVisibleTimeRange(range: TimeRange, meta?: ChartMutationMeta): TimeRange | null;
// setCrosshairTime(time: ChartTime | null, options?: CrosshairTimeOptions): ChartTime | null;
// subscribeCrosshairMove(callback: (event: CrosshairEvent, meta: ChartChangeMeta) => void): () => void;
// subscribeVisibleRangeChange(callback: (range: LogicalRange, meta: ChartChangeMeta) => void): () => void;
```
