# FILTIX analysis contract

Original [design](../SOURCE-DISTRIBUTION.md#omitted-development-materials), with the additive cause filter from the [terminal-grid design](../SOURCE-DISTRIBUTION.md#omitted-development-materials).

```ts
import type { ChartApi, ChartTime, CandlePoint, ValuePoint, WhitespacePoint, TimeDomain } from '@filtix/charts';
export interface ChartSyncOptions {
  viewport?: boolean;
  crosshair?: boolean;
  crosshairMatch?: 'exact' | 'nearest';
  causes?: readonly ('interaction' | 'api' | 'data')[];
}
export interface ChartSync { destroy(): void }
export interface ComparisonInput { id: string; points: readonly (ValuePoint | WhitespacePoint)[] }
export interface ComparisonOptions { timeDomain?: TimeDomain; baselineTime?: ChartTime; baseValue?: number }
export interface IndexedComparison {
  id: string;
  baseline: { time: ChartTime; value: number };
  points: readonly (ValuePoint | WhitespacePoint)[];
}
export type ReplayStatus = 'paused' | 'playing' | 'ended' | 'destroyed';
export interface ReplayState { readonly status: ReplayStatus; readonly position: number; readonly total: number; readonly barsPerSecond: number }
export interface ReplayChange { readonly type: 'append' | 'reset'; readonly bars: readonly CandlePoint[]; readonly state: ReplayState }
export interface HistoryReplayOptions {
  bars: readonly CandlePoint[];
  timeDomain?: TimeDomain;
  barsPerSecond?: number;
  onChange(change: ReplayChange): void;
  onState?(state: ReplayState): void;
}
export interface HistoryReplay {
  play(): void;
  pause(): void;
  step(count?: number): void;
  seek(position: number): void;
  setSpeed(barsPerSecond: number): void;
  getData(): readonly CandlePoint[];
  getState(): ReplayState;
  destroy(): void;
}
export declare function createChartSync(charts: readonly ChartApi[], options?: ChartSyncOptions): ChartSync;
export declare function buildIndexedComparison(inputs: readonly ComparisonInput[], options?: ComparisonOptions): readonly IndexedComparison[];
export declare function createHistoryReplay(options: HistoryReplayOptions): HistoryReplay;
```

`causes` is defensively copied. Omission accepts all historical causes; an empty list prevents subsequent event propagation. Initial viewport alignment remains unchanged. Invalid entries and sparse arrays reject before subscriptions are installed.
