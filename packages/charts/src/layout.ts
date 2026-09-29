import { createPriceScale, lowerBound } from '@filtix/core';
import type { ChartPaneLayout, Scene, SeriesState } from './types';
import { measurePaneLayout } from './pane-layout';
export const AXIS_HEIGHT = 28;
export function logicalX(scene: Scene, index: number): number {
  return (
    8 +
    ((index - scene.range.from) / Math.max(1, scene.range.to - scene.range.from)) *
      Math.max(1, scene.plotWidth - 16)
  );
}
export function xLogical(scene: Scene, x: number): number {
  return (
    scene.range.from + ((x - 8) / Math.max(1, scene.plotWidth - 16)) * (scene.range.to - scene.range.from)
  );
}
export function sourceBounds(scene: Scene, series: SeriesState, from: number, to: number): [number, number] {
  const lo = scene.timeline[Math.max(0, Math.ceil(from))];
  const hi = scene.timeline[Math.min(scene.timeline.length - 1, Math.floor(to))];
  if (lo === undefined || hi === undefined || lo > hi) return [0, -1];
  const first = series.store.lowerBound(lo);
  let end = series.store.lowerBound(hi);
  if (series.store.keyAt(end) !== hi) end--;
  return [first, end];
}
export type TimelineIndexLookup = (key: number) => number;
export function sourceX(
  scene: Scene,
  series: SeriesState,
  index: number,
  lookup?: TimelineIndexLookup,
): number {
  const key = series.store.keyAt(index);
  return logicalX(scene, lookup ? lookup(key) : lowerBound(scene.timeline, key));
}
// Both the scale and renderer must use the same bin boundaries and sums.
export function densityStep(scene: Scene): number {
  const spacing = (scene.plotWidth - 16) / Math.max(1, scene.range.to - scene.range.from);
  return Math.max(1, Math.ceil(2 / Math.max(0.00001, spacing)));
}
export function binEnd(
  scene: Scene,
  series: SeriesState,
  index: number,
  last: number,
  step: number,
  lookup?: TimelineIndexLookup,
): number {
  if (step === 1) return index;
  const key = series.store.keyAt(index);
  const global = lookup ? lookup(key) : lowerBound(scene.timeline, key);
  const endKey = scene.timeline[Math.min(scene.timeline.length - 1, (Math.floor(global / step) + 1) * step)];
  return endKey === undefined ? last : Math.max(index, Math.min(last, series.store.lowerBound(endKey) - 1));
}
export function histogramSum(series: SeriesState, from: number, to: number): number {
  if (from === to) {
    const value = series.store.valueAt(from);
    return Number.isFinite(value) ? value : 0;
  }
  let magnitude = 0;
  for (let i = from; i <= to; i++) {
    const value = series.store.valueAt(i);
    if (Number.isFinite(value)) magnitude = Math.max(magnitude, Math.abs(value));
  }
  if (magnitude === 0) return 0;

  // Normalization keeps intermediate totals representable. Neumaier compensation
  // retains small residuals when large positive and negative bars cancel.
  let sum = 0;
  let correction = 0;
  for (let i = from; i <= to; i++) {
    const value = series.store.valueAt(i);
    if (!Number.isFinite(value)) continue;
    const normalized = value / magnitude;
    const next = sum + normalized;
    correction += Math.abs(sum) >= Math.abs(normalized) ? sum - next + normalized : normalized - next + sum;
    sum = next;
  }
  const total = (sum + correction) * magnitude;
  // A truly unrepresentable display total saturates only after cancellation.
  return Number.isFinite(total) ? total : Math.sign(total) * Number.MAX_VALUE;
}
export function layout(scene: Scene, preferences?: ChartPaneLayout): void {
  scene.plotWidth = Math.max(0, scene.width - (scene.width < 640 ? 72 : 88));
  const measured = measurePaneLayout(
    preferences ?? {
      panes: scene.panes.map((pane) => ({
        id: pane.id,
        weight: pane.options.weight,
        minHeight: pane.options.minHeight,
      })),
      maximizedPaneId: null,
    },
    scene.height,
  );
  scene.plotHeight = measured.plotHeight;
  for (const [index, pane] of scene.panes.entries()) {
    const geometry = measured.panes[index];
    pane.top = geometry?.top ?? 0;
    pane.height = geometry?.height ?? 0;
    if (pane.height <= 0) {
      pane.scale = null;
      continue;
    }
    let min = Infinity,
      max = -Infinity;
    for (const series of scene.series) {
      if (series.paneId !== pane.id) continue;
      const [a, b] = sourceBounds(scene, series, scene.range.from, scene.range.to);
      const stats = series.store.range(a, b);
      if (!stats) continue;
      min = Math.min(min, stats.min);
      max = Math.max(max, stats.max);
      if (series.type === 'histogram' && densityStep(scene) > 1) {
        const step = densityStep(scene);
        for (let i = a; i <= b; ) {
          const end = binEnd(scene, series, i, b, step);
          const sum = histogramSum(series, i, end);
          if (pane.options.scale === 'linear' || sum > 0) {
            min = Math.min(min, sum);
            max = Math.max(max, sum);
          }
          i = end + 1;
        }
      }
      if (series.type === 'histogram' && pane.options.scale === 'linear') {
        min = Math.min(0, min);
        max = Math.max(0, max);
      }
    }
    pane.scale =
      Number.isFinite(min) && Number.isFinite(max) && pane.height > 0
        ? createPriceScale(
            min,
            max,
            pane.top + Math.min(14, pane.height * 0.15),
            Math.max(1, pane.height - Math.min(28, pane.height * 0.3)),
            pane.options.scale,
          )
        : null;
  }
}
