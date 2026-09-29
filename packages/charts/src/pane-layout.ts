import { ChartError } from '@filtix/core';
import type {
  ChartPaneLayout,
  ChartPaneLayoutPatch,
  MeasuredChartPaneLayout,
  PaneLayoutOptions,
} from './types';

const fail = (message: string): never => {
  throw new ChartError('INVALID_PANE_LAYOUT', message);
};
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Reflect.ownKeys(value as object))
    if (typeof key !== 'string' || !keys.includes(key)) fail(`Unknown ${name} field`);
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(`${name} must be positive and finite`);
  return value as number;
}
export function snapshotPaneLayout(
  panes: readonly PaneLayoutOptions[],
  maximizedPaneId: string | null,
): ChartPaneLayout {
  return Object.freeze({
    panes: Object.freeze(
      panes.map((pane) => Object.freeze({ id: pane.id, weight: pane.weight, minHeight: pane.minHeight })),
    ),
    maximizedPaneId,
  });
}
export function mergePaneLayout(current: ChartPaneLayout, input: ChartPaneLayoutPatch): ChartPaneLayout {
  const patch = record(input, ['panes', 'maximizedPaneId'], 'layout');
  let panes = current.panes;
  if (own(patch, 'panes')) {
    if (!Array.isArray(patch.panes)) fail('panes must be an array');
    const seen = new Set<string>();
    const updates = new Map<string, { weight?: number; minHeight?: number }>();
    for (const item of patch.panes as unknown[]) {
      const entry = record(item, ['id', 'weight', 'minHeight'], 'pane');
      if (!own(entry, 'id') || typeof entry.id !== 'string' || !entry.id.trim()) fail('pane id is required');
      const id = entry.id as string;
      if (seen.has(id)) fail('duplicate pane id');
      if (!current.panes.some((pane) => pane.id === id)) fail('unknown pane id');
      seen.add(id);
      const update: { weight?: number; minHeight?: number } = {};
      if (own(entry, 'weight')) update.weight = positive(entry.weight, 'weight');
      if (own(entry, 'minHeight')) update.minHeight = positive(entry.minHeight, 'minHeight');
      updates.set(id, update);
    }
    panes = current.panes.map((pane) => ({ ...pane, ...updates.get(pane.id) }));
  }
  let maximizedPaneId = current.maximizedPaneId;
  if (own(patch, 'maximizedPaneId')) {
    const target = patch.maximizedPaneId;
    if (target !== null && (typeof target !== 'string' || !current.panes.some((pane) => pane.id === target)))
      fail('unknown maximized pane');
    maximizedPaneId = target as string | null;
  }
  return snapshotPaneLayout(panes, maximizedPaneId);
}
export function samePaneLayout(a: ChartPaneLayout, b: ChartPaneLayout): boolean {
  return (
    a.maximizedPaneId === b.maximizedPaneId &&
    a.panes.length === b.panes.length &&
    a.panes.every(
      (pane, index) =>
        pane.id === b.panes[index]?.id &&
        pane.weight === b.panes[index]?.weight &&
        pane.minHeight === b.panes[index]?.minHeight,
    )
  );
}

function validateCompleteLayout(value: unknown): ChartPaneLayout {
  const layout = record(value, ['panes', 'maximizedPaneId'], 'layout');
  if (!own(layout, 'panes') || !Array.isArray(layout.panes) || !own(layout, 'maximizedPaneId'))
    fail('A complete pane layout is required');
  const seen = new Set<string>();
  const panes: PaneLayoutOptions[] = [];
  for (const item of layout.panes as unknown[]) {
    const pane = record(item, ['id', 'weight', 'minHeight'], 'pane');
    if (typeof pane.id !== 'string') fail('Pane ID must be a string');
    const id = pane.id as string;
    if (!own(pane, 'id') || !id.trim() || seen.has(id)) fail('Pane IDs must be distinct own strings');
    if (!own(pane, 'weight') || !own(pane, 'minHeight')) fail('Pane geometry is incomplete');
    seen.add(id);
    panes.push({
      id,
      weight: positive(pane.weight, 'weight'),
      minHeight: positive(pane.minHeight, 'minHeight'),
    });
  }
  if (
    layout.maximizedPaneId !== null &&
    (typeof layout.maximizedPaneId !== 'string' || !seen.has(layout.maximizedPaneId))
  )
    fail('Unknown maximized pane');
  return snapshotPaneLayout(panes, layout.maximizedPaneId as string | null);
}

export function measurePaneLayout(layout: ChartPaneLayout, height: number): MeasuredChartPaneLayout {
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0)
    fail('Chart height must be finite and nonnegative');
  layout = validateCompleteLayout(layout);
  const plotHeight = Math.max(0, height - 28);
  if (layout.maximizedPaneId !== null)
    return Object.freeze({
      plotHeight,
      panes: Object.freeze(
        layout.panes.map((pane) =>
          Object.freeze({
            id: pane.id,
            top: 0,
            height: pane.id === layout.maximizedPaneId ? plotHeight : 0,
          }),
        ),
      ),
    });
  const count = layout.panes.length;
  if (!count) return Object.freeze({ plotHeight, panes: Object.freeze([]) });
  const gap = count > 1 ? Math.min(5, plotHeight / (count - 1)) : 0;
  const available = Math.max(0, plotHeight - gap * (count - 1));
  const maxMin = Math.max(...layout.panes.map((pane) => pane.minHeight));
  const normalizedMins = layout.panes.map((pane) => pane.minHeight / maxMin);
  const minUnits = normalizedMins.reduce((sum, unit) => sum + unit, 0);
  const compressed = available / maxMin < minUnits;
  const maxWeight = Math.max(...layout.panes.map((pane) => pane.weight));
  const normalizedWeights = layout.panes.map((pane) => pane.weight / maxWeight);
  const weightUnits = normalizedWeights.reduce((sum, unit) => sum + unit, 0);
  const minSum = compressed ? 0 : layout.panes.reduce((sum, pane) => sum + pane.minHeight, 0);
  const free = compressed ? 0 : Math.max(0, available - minSum);
  let top = 0;
  const panes = layout.panes.map((pane, index) => {
    const size = compressed
      ? (available * normalizedMins[index]!) / minUnits
      : pane.minHeight + (free * normalizedWeights[index]!) / weightUnits;
    const result = Object.freeze({ id: pane.id, top, height: size });
    top += size + gap;
    return result;
  });
  return Object.freeze({ plotHeight, panes: Object.freeze(panes) });
}

export function resizePanePair(
  layout: ChartPaneLayout,
  height: number,
  upperIndex: number,
  delta: number,
): ChartPaneLayout {
  if (layout.maximizedPaneId !== null || layout.panes.length < 2 || !Number.isFinite(delta) || !delta)
    return layout;
  const measured = measurePaneLayout(layout, height);
  const upper = layout.panes[upperIndex],
    lower = layout.panes[upperIndex + 1];
  const upperMeasured = measured.panes[upperIndex],
    lowerMeasured = measured.panes[upperIndex + 1];
  if (!upper || !lower || !upperMeasured || !lowerMeasured) return layout;
  const free = upperMeasured.height + lowerMeasured.height - upper.minHeight - lower.minHeight;
  if (!(free > 0) || !Number.isFinite(free)) return layout;
  const maxWeight = Math.max(upper.weight, lower.weight);
  const pairUnits = upper.weight / maxWeight + lower.weight / maxWeight;
  const finiteLimit = Math.min(
    1 - Number.EPSILON,
    (Number.MAX_VALUE / maxWeight / pairUnits) * (1 - Number.EPSILON),
  );
  const positiveLimit = Number.MIN_VALUE / maxWeight / pairUnits;
  const minShare = Math.max(Number.EPSILON, 1 - finiteLimit, positiveLimit);
  const maxShare = Math.min(finiteLimit, 1 - minShare);
  if (!(maxShare > minShare)) return layout;
  const currentExtra = upperMeasured.height - upper.minHeight;
  const targetShare = Math.min(maxShare, Math.max(minShare, (currentExtra + delta) / free));
  if (targetShare === currentExtra / free) return layout;
  const upperWeight = maxWeight * (pairUnits * targetShare);
  // Subnormal products can round in the same direction. When the pair sum is
  // representable, take the second weight as its complement after rounding.
  const pairTotal = upper.weight + lower.weight;
  const lowerWeight = Number.isFinite(pairTotal)
    ? pairTotal - upperWeight
    : maxWeight * (pairUnits * (1 - targetShare));
  if (!Number.isFinite(upperWeight) || !Number.isFinite(lowerWeight) || upperWeight <= 0 || lowerWeight <= 0)
    return layout;
  if (Number.isFinite(pairTotal) && upperWeight + lowerWeight !== pairTotal) return layout;
  return snapshotPaneLayout(
    layout.panes.map((pane, i) =>
      i === upperIndex
        ? { ...pane, weight: upperWeight }
        : i === upperIndex + 1
          ? { ...pane, weight: lowerWeight }
          : pane,
    ),
    null,
  );
}
