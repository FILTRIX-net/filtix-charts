import { describe, expect, test } from 'vitest';
import { ChartError } from '@filtrix.net/core';
import type { ChartApi, ChartChangeMeta, ChartTime, CrosshairEvent, TimeRange } from '@filtrix.net/charts';
import type { TerminalGridCellId, TerminalGridSync } from './grid-types';
import { createGridSyncController } from './grid-sync';

const enabled: TerminalGridSync = { viewport: true, crosshair: true, crosshairMatch: 'exact' };
const off: TerminalGridSync = { viewport: false, crosshair: false, crosshairMatch: 'exact' };

function chart(initial: TimeRange) {
  let range = { ...initial };
  let revision = 0;
  let alive = true;
  const ranges = new Set<(range: { from: number; to: number }, meta: ChartChangeMeta) => void>();
  const cursors = new Set<(event: CrosshairEvent, meta: ChartChangeMeta) => void>();
  const writes: TimeRange[] = [];
  const cursorWrites: Array<{ time: ChartTime | null; match: string }> = [];
  let onRangeWrite: (() => void) | null = null;
  let onCrosshairSubscribe: (() => void) | null = null;
  function emit(cause: ChartChangeMeta['cause'], origin?: object) {
    const meta = { cause, origin, revision: ++revision };
    for (const listener of [...ranges]) listener({ from: 0, to: 1 }, meta);
  }
  const api = {
    timeDomain: 'utc-ms',
    getChangeRevision() {
      if (!alive) throw new ChartError('DESTROYED', 'chart destroyed');
      return revision;
    },
    getVisibleTimeRange() {
      if (!alive) throw new ChartError('DESTROYED', 'chart destroyed');
      return { ...range };
    },
    setVisibleTimeRange(next: TimeRange, meta?: { origin?: object }) {
      if (!alive) throw new ChartError('DESTROYED', 'chart destroyed');
      range = { ...next };
      writes.push({ ...next });
      onRangeWrite?.();
      emit('api', meta?.origin);
      return { ...range };
    },
    setCrosshairTime(time: ChartTime | null, options?: { match?: string; origin?: object }) {
      if (!alive) throw new ChartError('DESTROYED', 'chart destroyed');
      cursorWrites.push({ time, match: options?.match ?? 'exact' });
      const meta = { cause: 'api' as const, origin: options?.origin, revision: ++revision };
      for (const listener of [...cursors])
        listener({ time, logicalIndex: null, x: 0, y: 0, points: {} }, meta);
      return time;
    },
    subscribeVisibleRangeChange(
      listener: (range: { from: number; to: number }, meta: ChartChangeMeta) => void,
    ) {
      ranges.add(listener);
      return () => void ranges.delete(listener);
    },
    subscribeCrosshairMove(listener: (event: CrosshairEvent, meta: ChartChangeMeta) => void) {
      onCrosshairSubscribe?.();
      cursors.add(listener);
      return () => void cursors.delete(listener);
    },
  } as unknown as ChartApi;
  return {
    api,
    writes,
    cursorWrites,
    emit,
    setRange(next: TimeRange, cause: ChartChangeMeta['cause']) {
      range = { ...next };
      emit(cause);
    },
    get range() {
      return { ...range };
    },
    get listeners() {
      return ranges.size + cursors.size;
    },
    onRangeWrite(callback: (() => void) | null) {
      onRangeWrite = callback;
    },
    onCrosshairSubscribe(callback: (() => void) | null) {
      onCrosshairSubscribe = callback;
    },
    destroy() {
      alive = false;
    },
  };
}

function member(id: TerminalGridCellId, item: ReturnType<typeof chart>, ready = true) {
  return { id, chart: item.api, ready };
}

describe('grid sync controller', () => {
  test('active ready chart supplies initial range; selection alone does not realign', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    const members = [member('cell-1', a), member('cell-2', b)];
    controller.update(members, 'cell-2', enabled);
    expect(a.range).toEqual({ from: 3000, to: 4000 });
    a.setRange({ from: 1000, to: 2000 }, 'data');
    const before = a.writes.length;
    controller.update(members, 'cell-1', enabled);
    expect(a.writes).toHaveLength(before);
    expect(b.range).toEqual({ from: 3000, to: 4000 });
    controller.destroy();
  });

  test('empty member is excluded until ready, then active authority aligns once', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const c = chart({ from: 5000, to: 6000 });
    const controller = createGridSyncController();
    controller.update(
      [member('cell-1', a, false), member('cell-2', b), member('cell-3', c)],
      'cell-1',
      enabled,
    );
    expect(c.range).toEqual({ from: 3000, to: 4000 });
    expect(a.listeners).toBe(0);
    controller.update([member('cell-1', a), member('cell-2', b), member('cell-3', c)], 'cell-1', enabled);
    expect(b.range).toEqual({ from: 1000, to: 2000 });
    expect(c.range).toEqual({ from: 1000, to: 2000 });
    const count = b.writes.length + c.writes.length;
    controller.update([member('cell-1', a), member('cell-2', b), member('cell-3', c)], 'cell-1', enabled);
    expect(b.writes.length + c.writes.length).toBe(count);
    controller.destroy();
  });

  test('data range changes do not take over neighbors; interaction and api do', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    const members = [member('cell-1', a), member('cell-2', b)];
    controller.update(members, 'cell-1', enabled);
    a.setRange({ from: 2000, to: 3000 }, 'data');
    controller.update(members, 'cell-1', enabled); // ordinary terminal feed state callback
    expect(b.range).toEqual({ from: 1000, to: 2000 });
    a.setRange({ from: 3000, to: 4000 }, 'interaction');
    expect(b.range).toEqual({ from: 3000, to: 4000 });
    a.api.setVisibleTimeRange({ from: 4000, to: 5000 });
    expect(b.range).toEqual({ from: 4000, to: 5000 });
    controller.destroy();
  });

  test('disabled and single-ready states own no listeners; 4 to 1 to 4 remounts cleanly', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const c = chart({ from: 5000, to: 6000 });
    const d = chart({ from: 7000, to: 8000 });
    const controller = createGridSyncController();
    const four = [member('cell-1', a), member('cell-2', b), member('cell-3', c), member('cell-4', d)];
    controller.update(four, 'cell-1', enabled);
    expect(
      four.every(
        (item) =>
          item.chart === a.api || item.chart === b.api || item.chart === c.api || item.chart === d.api,
      ),
    ).toBe(true);
    controller.update([member('cell-1', a)], 'cell-1', enabled);
    expect([a, b, c, d].map((item) => item.listeners)).toEqual([0, 0, 0, 0]);
    b.destroy();
    c.destroy();
    d.destroy();
    const fresh = [
      chart({ from: 3000, to: 4000 }),
      chart({ from: 5000, to: 6000 }),
      chart({ from: 7000, to: 8000 }),
    ];
    controller.update(
      [
        member('cell-1', a),
        member('cell-2', fresh[0]!),
        member('cell-3', fresh[1]!),
        member('cell-4', fresh[2]!),
      ],
      'cell-1',
      enabled,
    );
    expect(fresh.map((item) => item.range)).toEqual([
      { from: 1000, to: 2000 },
      { from: 1000, to: 2000 },
      { from: 1000, to: 2000 },
    ]);
    controller.update([member('cell-1', a), member('cell-2', fresh[0]!)], 'cell-1', off);
    expect([a, ...fresh].map((item) => item.listeners)).toEqual([0, 0, 0, 0]);
    controller.destroy();
  });

  test('effective toggle rebuild uses current active authority and rapid no-op toggles stay finite', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    const members = [member('cell-1', a), member('cell-2', b)];
    controller.update(members, 'cell-1', off);
    expect(a.listeners + b.listeners).toBe(0);
    controller.update(members, 'cell-2', enabled);
    expect(a.range).toEqual({ from: 3000, to: 4000 });
    const writes = a.writes.length + b.writes.length;
    for (let i = 0; i < 20; i++) controller.update(members, i % 2 ? 'cell-1' : 'cell-2', enabled);
    expect(a.writes.length + b.writes.length).toBe(writes);
    controller.update(members, 'cell-1', { ...enabled, viewport: false });
    expect(a.listeners + b.listeners).toBe(2);
    controller.destroy();
    expect(a.listeners + b.listeners).toBe(0);
  });

  test('obsolete or destroyed charts cannot reenter after restore or nested teardown', () => {
    const old = chart({ from: 1000, to: 2000 });
    const peer = chart({ from: 3000, to: 4000 });
    const next = chart({ from: 5000, to: 6000 });
    const controller = createGridSyncController();
    controller.update([member('cell-1', old), member('cell-2', peer)], 'cell-1', enabled);
    controller.update([member('cell-1', next), member('cell-2', peer)], 'cell-1', enabled);
    expect(old.listeners).toBe(0);
    old.destroy();
    const before = peer.writes.length;
    old.emit('interaction');
    expect(peer.writes).toHaveLength(before);
    next.destroy();
    controller.update([member('cell-1', next), member('cell-2', peer)], 'cell-1', enabled);
    expect(peer.listeners).toBe(0);
    controller.destroy();
  });

  test('destroy during synchronous initial alignment leaves no resurrected listeners', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    b.onRangeWrite(() => controller.destroy());
    controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled);
    expect(a.listeners + b.listeners).toBe(0);
    const count = b.writes.length;
    a.emit('interaction');
    expect(b.writes).toHaveLength(count);
  });

  test('effective update during alignment discards obsolete group and applies latest desired membership', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const c = chart({ from: 5000, to: 6000 });
    const controller = createGridSyncController();
    b.onRangeWrite(() => {
      b.onRangeWrite(null);
      controller.update([member('cell-1', a), member('cell-3', c)], 'cell-3', enabled);
    });
    controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled);
    expect(b.listeners).toBe(0);
    expect(a.range).toEqual({ from: 5000, to: 6000 });
    const before = c.writes.length;
    a.emit('interaction');
    expect(c.writes).toHaveLength(before + 1);
    controller.destroy();
  });

  test('identical readiness and selection updates during alignment do not recurse or change this rebuild authority', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    let callbacks = 0;
    b.onRangeWrite(() => {
      callbacks++;
      controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled);
      controller.update([member('cell-1', a), member('cell-2', b)], 'cell-2', enabled);
    });
    controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled);
    expect(callbacks).toBe(1);
    expect(b.range).toEqual({ from: 1000, to: 2000 });
    controller.update([member('cell-1', a), member('cell-2', b)], 'cell-2', enabled);
    expect(callbacks).toBe(1);
    controller.destroy();
  });

  test('partial subscription failure removes listeners and a later update recovers', () => {
    const a = chart({ from: 1000, to: 2000 });
    const b = chart({ from: 3000, to: 4000 });
    const controller = createGridSyncController();
    b.onCrosshairSubscribe(() => {
      throw new Error('injected subscribe failure');
    });
    expect(() => controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled)).toThrow(
      'injected subscribe failure',
    );
    expect(a.listeners + b.listeners).toBe(0);
    b.onCrosshairSubscribe(null);
    controller.update([member('cell-1', a), member('cell-2', b)], 'cell-1', enabled);
    expect(a.listeners + b.listeners).toBe(4);
    controller.destroy();
  });
});
