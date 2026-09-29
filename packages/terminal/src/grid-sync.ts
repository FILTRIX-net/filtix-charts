import { createChartSync, type ChartSync } from '@filtix/analysis';
import type { ChartApi } from '@filtix/charts';
import { isChartError } from '@filtix/core';
import type { TerminalGridCellId, TerminalGridSync } from './grid-types';

export interface GridSyncMember {
  id: TerminalGridCellId;
  chart: ChartApi;
  ready: boolean;
}

export interface GridSyncController {
  update(members: readonly GridSyncMember[], activeCellId: TerminalGridCellId, sync: TerminalGridSync): void;
  destroy(): void;
}

interface EffectiveSync {
  viewport: boolean;
  crosshair: boolean;
  crosshairMatch: 'exact' | 'nearest';
}

interface Desired {
  members: readonly Pick<GridSyncMember, 'id' | 'chart'>[];
  activeCellId: TerminalGridCellId;
  options: EffectiveSync;
}

function sameGroup(a: Desired, b: Desired): boolean {
  return (
    a.options.viewport === b.options.viewport &&
    a.options.crosshair === b.options.crosshair &&
    a.options.crosshairMatch === b.options.crosshairMatch &&
    a.members.length === b.members.length &&
    a.members.every(
      (member, index) => member.id === b.members[index]?.id && member.chart === b.members[index]?.chart,
    )
  );
}

function usable(member: GridSyncMember): boolean {
  if (!member.ready) return false;
  try {
    member.chart.getChangeRevision();
    return member.chart.getVisibleTimeRange() !== null;
  } catch (failure) {
    if (isChartError(failure) && failure.code === 'DESTROYED') return false;
    throw failure;
  }
}

function orderedCharts(desired: Desired): ChartApi[] {
  const active = desired.members.find((member) => member.id === desired.activeCellId);
  const ordered = active
    ? [active, ...desired.members.filter((member) => member !== active)]
    : desired.members;
  return ordered.map((member) => member.chart);
}

export function createGridSyncController(): GridSyncController {
  const empty: Desired = {
    members: [],
    activeCellId: 'cell-1',
    options: { viewport: false, crosshair: false, crosshairMatch: 'exact' },
  };
  let desired = empty;
  let current: { desired: Desired; group: ChartSync } | null = null;
  let revision = 0;
  let reconciling = false;
  let destroyed = false;

  function reconcile(): void {
    if (reconciling || destroyed) return;
    reconciling = true;
    let attempts = 0;
    try {
      while (!destroyed) {
        if (current && sameGroup(current.desired, desired)) return;
        const previous = current;
        current = null;
        previous?.group.destroy();
        if (destroyed) return;
        if (desired.members.length < 2 || (!desired.options.viewport && !desired.options.crosshair)) return;
        if (++attempts > 8) throw new Error('Terminal grid sync repair exhausted');
        const candidate = desired;
        const fence = revision;
        const group = createChartSync(orderedCharts(candidate), {
          ...candidate.options,
          causes: ['interaction', 'api'],
        });
        if (destroyed || revision !== fence) {
          group.destroy();
          continue;
        }
        current = { desired: candidate, group };
        return;
      }
    } finally {
      reconciling = false;
    }
  }

  return Object.freeze({
    update(members: readonly GridSyncMember[], activeCellId: TerminalGridCellId, sync: TerminalGridSync) {
      if (destroyed) return;
      const next: Desired = {
        members: members.filter(usable).map(({ id, chart }) => ({ id, chart })),
        activeCellId,
        options: {
          viewport: sync.viewport,
          crosshair: sync.crosshair,
          crosshairMatch: sync.crosshair ? sync.crosshairMatch : 'exact',
        },
      };
      if (!sameGroup(desired, next)) revision++;
      desired = next;
      reconcile();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      revision++;
      desired = empty;
      const previous = current;
      current = null;
      previous?.group.destroy();
    },
  });
}
