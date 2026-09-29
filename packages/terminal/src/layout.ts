import type { TerminalLayout, TerminalPaneId, TerminalPaneLayout, TerminalStudy } from './types';

export function copyLayout(layout: TerminalLayout): TerminalLayout {
  return {
    panes: layout.panes.map((pane) => ({ ...pane })),
    maximizedPaneId: layout.maximizedPaneId,
    studiesOpen: layout.studiesOpen,
  };
}
export function defaultLayout(studies: readonly TerminalStudy[]): TerminalLayout {
  return {
    panes: [
      { id: 'price', weight: 1, minHeight: 160 },
      { id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 },
      ...studies
        .filter((s) => s.kind === 'rsi' || s.kind === 'macd')
        .map((s) => ({ id: `terminal-${s.id}-pane` as TerminalPaneId, weight: 0.3, minHeight: 72 })),
    ],
    maximizedPaneId: null,
    studiesOpen: false,
  };
}
export function visiblePaneIds(studies: readonly TerminalStudy[], volume: boolean): Set<TerminalPaneId> {
  return new Set<TerminalPaneId>([
    'price',
    ...(volume ? ['terminal-volume-pane' as const] : []),
    ...studies
      .filter((s) => s.visible && (s.kind === 'rsi' || s.kind === 'macd'))
      .map((s) => `terminal-${s.id}-pane` as TerminalPaneId),
  ]);
}
export function reconcileLayout(
  layout: TerminalLayout,
  studies: readonly TerminalStudy[],
  volume: boolean,
): TerminalLayout {
  const before = new Map(layout.panes.map((p) => [p.id, p]));
  return {
    panes: defaultLayout(studies).panes.map((p) => ({ ...(before.get(p.id) ?? p) })),
    maximizedPaneId:
      layout.maximizedPaneId && visiblePaneIds(studies, volume).has(layout.maximizedPaneId)
        ? layout.maximizedPaneId
        : null,
    studiesOpen: layout.studiesOpen,
  };
}
function record(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Terminal layout must be an object');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new TypeError('Unknown terminal layout field');
    result[key] = (value as Record<string, unknown>)[key];
  }
  for (const key of required)
    if (!Object.hasOwn(result, key)) throw new TypeError('Terminal layout field is required: ' + key);
  return result;
}
export function resolveLayout(
  value: unknown,
  base: TerminalLayout,
  visible: ReadonlySet<TerminalPaneId>,
  complete = false,
): TerminalLayout {
  const keys = ['panes', 'maximizedPaneId', 'studiesOpen'];
  const input = record(value, keys, complete ? keys : []);
  const panes = new Map(base.panes.map((p) => [p.id, { ...p }]));
  if (Object.hasOwn(input, 'panes')) {
    if (!Array.isArray(input.panes) || input.panes.length > 5)
      throw new TypeError('Terminal layout panes must be an array of at most five entries');
    const seen = new Set<string>();
    for (const raw of input.panes) {
      const patch = record(
        raw,
        ['id', 'weight', 'minHeight'],
        complete ? ['id', 'weight', 'minHeight'] : ['id'],
      );
      if (typeof patch.id !== 'string' || !panes.has(patch.id as TerminalPaneId) || seen.has(patch.id))
        throw new TypeError('Unknown or duplicate terminal pane ID');
      seen.add(patch.id);
      if (
        Object.hasOwn(patch, 'weight') &&
        (typeof patch.weight !== 'number' || !Number.isFinite(patch.weight) || patch.weight <= 0)
      )
        throw new TypeError('Terminal pane weight must be positive and finite');
      if (
        Object.hasOwn(patch, 'minHeight') &&
        (!Number.isInteger(patch.minHeight) ||
          (patch.minHeight as number) < 24 ||
          (patch.minHeight as number) > 2048)
      )
        throw new TypeError('Terminal pane minHeight must be an integer from 24 to 2048');
      const id = patch.id as TerminalPaneId;
      panes.set(id, { ...panes.get(id)!, ...patch } as TerminalPaneLayout);
    }
    if (complete && seen.size !== panes.size)
      throw new TypeError('Terminal layout must include every canonical pane');
  }
  let maximizedPaneId = base.maximizedPaneId;
  if (Object.hasOwn(input, 'maximizedPaneId')) {
    const id = input.maximizedPaneId;
    if (id !== null && (typeof id !== 'string' || !visible.has(id as TerminalPaneId)))
      throw new TypeError('Maximized pane must be a visible terminal pane or null');
    maximizedPaneId = id as TerminalPaneId | null;
  }
  if (Object.hasOwn(input, 'studiesOpen') && typeof input.studiesOpen !== 'boolean')
    throw new TypeError('studiesOpen must be a boolean');
  return {
    panes: [...panes.values()],
    maximizedPaneId,
    studiesOpen: Object.hasOwn(input, 'studiesOpen') ? (input.studiesOpen as boolean) : base.studiesOpen,
  };
}
export function sameLayout(a: TerminalLayout, b: TerminalLayout): boolean {
  return (
    a.maximizedPaneId === b.maximizedPaneId &&
    a.studiesOpen === b.studiesOpen &&
    a.panes.length === b.panes.length &&
    a.panes.every(
      (p, i) =>
        p.id === b.panes[i]?.id && p.weight === b.panes[i]?.weight && p.minHeight === b.panes[i]?.minHeight,
    )
  );
}
