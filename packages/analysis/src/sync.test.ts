import { describe, expect, test } from 'vitest';
import { ChartError } from '@filtix/core';
import type { ChartApi, ChartChangeMeta, ChartTime, CrosshairEvent, TimeRange } from '@filtix/charts';
import { createChartSync } from './sync';

type Cause = ChartChangeMeta['cause'];

function chart(initial: TimeRange, times: readonly number[] = [1000, 2000, 3000]) {
  let range = { ...initial };
  let revision = 0;
  let alive = true;
  let cursor: ChartTime | null = null;
  const rangeListeners = new Set<(range: { from: number; to: number }, meta: ChartChangeMeta) => void>();
  const cursorListeners = new Set<(event: CrosshairEvent, meta: ChartChangeMeta) => void>();
  const writes: TimeRange[] = [];
  const cursorWrites: Array<{ requested: ChartTime | null; match: string; time: ChartTime | null }> = [];
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
      emitRange('api', meta?.origin);
      return { ...range };
    },
    setCrosshairTime(time: ChartTime | null, options?: { match?: 'exact' | 'nearest'; origin?: object }) {
      if (!alive) throw new ChartError('DESTROYED', 'chart destroyed');
      const matched =
        time === null
          ? null
          : options?.match === 'nearest'
            ? ([...times].sort((a, b) => Math.abs(a - Number(time)) - Math.abs(b - Number(time)))[0] ?? null)
            : times.includes(Number(time))
              ? time
              : null;
      cursor = matched;
      cursorWrites.push({ requested: time, match: options?.match ?? 'exact', time: matched });
      emitCursor('api', metaEvent(matched), options?.origin);
      return matched;
    },
    subscribeVisibleRangeChange(
      listener: (range: { from: number; to: number }, meta: ChartChangeMeta) => void,
    ) {
      rangeListeners.add(listener);
      return () => void rangeListeners.delete(listener);
    },
    subscribeCrosshairMove(listener: (event: CrosshairEvent, meta: ChartChangeMeta) => void) {
      cursorListeners.add(listener);
      return () => void cursorListeners.delete(listener);
    },
  } as unknown as ChartApi;
  function metaEvent(time: ChartTime | null): CrosshairEvent {
    return {
      time,
      logicalIndex: null,
      x: 17,
      y: 91,
      points: { price: { time: time ?? 1000, value: 999 } },
    } as CrosshairEvent;
  }
  function emitRange(cause: Cause, origin?: object, forcedRevision?: number) {
    const meta = { revision: forcedRevision ?? ++revision, cause, origin };
    for (const listener of [...rangeListeners]) listener({ from: 0, to: 1 }, meta);
  }
  function emitCursor(cause: Cause, event: CrosshairEvent, origin?: object, forcedRevision?: number) {
    const meta = { revision: forcedRevision ?? ++revision, cause, origin };
    for (const listener of [...cursorListeners]) listener(event, meta);
  }
  return {
    api,
    writes,
    cursorWrites,
    get range() {
      return { ...range };
    },
    get cursor() {
      return cursor;
    },
    get listenerCount() {
      return rangeListeners.size + cursorListeners.size;
    },
    emitRange,
    replaceRange(next: TimeRange, cause: Cause) {
      range = { ...next };
      emitRange(cause);
    },
    emitCursor: (cause: Cause, time: ChartTime | null, origin?: object, forcedRevision?: number) =>
      emitCursor(cause, metaEvent(time), origin, forcedRevision),
    destroy() {
      alive = false;
    },
  };
}

describe('createChartSync cause filtering', () => {
  test('omission keeps data events and first-chart initialization', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    const sync = createChartSync([first.api, second.api]);
    expect(second.range).toEqual({ from: 1000, to: 2000 });
    first.replaceRange({ from: 1000, to: 3000 }, 'data');
    expect(second.range).toEqual({ from: 1000, to: 3000 });
    sync.destroy();
  });

  test('empty causes still aligns initially but blocks later range and cursor events', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    const sync = createChartSync([first.api, second.api], { causes: [] });
    expect(second.range).toEqual({ from: 1000, to: 2000 });
    const alignmentWrites = second.writes.length;
    first.api.setVisibleTimeRange({ from: 2000, to: 3000 });
    first.emitCursor('interaction', 2000);
    expect(second.writes).toHaveLength(alignmentWrites);
    expect(second.cursorWrites).toHaveLength(0);
    sync.destroy();
  });

  test('accepted causes are copied and each permitted cause propagates', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    const causes: Cause[] = ['interaction', 'api'];
    const sync = createChartSync([first.api, second.api], { causes });
    causes.splice(0, causes.length, 'data');
    const aligned = second.writes.length;
    first.emitRange('interaction');
    first.emitRange('api');
    first.emitRange('data');
    expect(second.writes).toHaveLength(aligned + 2);
    first.emitCursor('interaction', 1000);
    first.emitCursor('api', 2000);
    first.emitCursor('data', 3000);
    expect(second.cursorWrites.map((entry) => entry.requested)).toEqual([1000, 2000]);
    sync.destroy();

    const third = chart({ from: 1000, to: 2000 });
    const fourth = chart({ from: 2000, to: 3000 });
    const dataSync = createChartSync([third.api, fourth.api], { causes: ['data'] });
    const before = fourth.writes.length;
    third.emitRange('data');
    expect(fourth.writes).toHaveLength(before + 1);
    dataSync.destroy();
  });

  test.each([null, 'api', {}, ['other'], ['api', null], [, 'api']])(
    'rejects malformed cause lists before subscriptions: %j',
    (causes) => {
      const first = chart({ from: 1000, to: 2000 });
      const second = chart({ from: 2000, to: 3000 });
      expect(() => createChartSync([first.api, second.api], { causes } as never)).toThrow();
      expect(first.listenerCount + second.listenerCount).toBe(0);
    },
  );

  test('stale revisions and controller-origin echoes do not propagate', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    first.emitRange('api');
    const sync = createChartSync([first.api, second.api], { causes: ['api'] });
    const aligned = second.writes.length;
    first.emitRange('api', undefined, 1);
    expect(second.writes).toHaveLength(aligned);
    first.emitRange('api');
    expect(second.writes).toHaveLength(aligned + 1);
    expect(first.writes).toHaveLength(0);
    sync.destroy();
  });

  test('synchronous nested destroy stops later writes and releases listeners', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    const third = chart({ from: 2000, to: 3000 });
    const sync = createChartSync([first.api, second.api, third.api], { causes: ['api'] });
    second.api.subscribeVisibleRangeChange(() => sync.destroy());
    const thirdBefore = third.writes.length;
    first.emitRange('api');
    expect(third.writes).toHaveLength(thirdBefore);
    expect(first.listenerCount).toBe(0);
  });

  test('destroyed peers detach while live peers continue', () => {
    const first = chart({ from: 1000, to: 2000 });
    const second = chart({ from: 2000, to: 3000 });
    const third = chart({ from: 2000, to: 3000 });
    const sync = createChartSync([first.api, second.api, third.api], { causes: ['interaction'] });
    second.destroy();
    const before = third.writes.length;
    first.emitRange('interaction');
    expect(third.writes).toHaveLength(before + 1);
    expect(second.listenerCount).toBe(0);
    sync.destroy();
  });

  test('crosshair forwards time only under exact and nearest matching', () => {
    const first = chart({ from: 1000, to: 2000 }, [1000, 2000, 3000]);
    const second = chart({ from: 1000, to: 2000 }, [1000, 3000]);
    const exact = createChartSync([first.api, second.api], { viewport: false, causes: ['interaction'] });
    first.emitCursor('interaction', 2000);
    expect(second.cursor).toBeNull();
    expect(second.cursorWrites.at(-1)).toEqual({ requested: 2000, match: 'exact', time: null });
    exact.destroy();
    const nearest = createChartSync([first.api, second.api], {
      viewport: false,
      crosshairMatch: 'nearest',
      causes: ['interaction'],
    });
    first.emitCursor('interaction', 2000);
    expect(second.cursor).toBe(1000);
    expect(second.cursorWrites.at(-1)).toEqual({ requested: 2000, match: 'nearest', time: 1000 });
    nearest.destroy();
  });
});
