import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SeriesStore, clampRange, type SeriesPoint, type SeriesType } from '@filtrix.net/core';
import {
  buildRuns,
  extendTimelineFromSuperset,
  nearestTimelineIndex,
  oldTimelineIsContiguousSlice,
  storeMatchesTimeline,
  tailIsAdjacent,
} from './timeline';

const chartSource = readFileSync(new URL('./chart.ts', import.meta.url), 'utf8');

function chartSetDataHarness(oldTimes: number[], unchangedTimes = oldTimes) {
  const make = (type: 'line' | 'area' | 'band', whitespace = false) => {
    const store = new SeriesStore(type);
    const times = type === 'line' ? oldTimes : unchangedTimes;
    store.setData(
      times.map((time, index) =>
        whitespace && index === 1
          ? { time }
          : type === 'band'
            ? { time, lower: 1, upper: 3 }
            : { time, value: 2 },
      ),
    );
    return { id: type, type, paneId: 'price', store, runs: buildRuns(store, oldTimes) };
  };
  const replacement = make('line');
  const unchanged = [make('area', true), make('band')];
  const scene = {
    timeline: oldTimes.slice(),
    range: { from: 0, to: Math.max(1, oldTimes.length - 1) },
    series: [replacement, ...unchanged],
  };
  const adoptStart = chartSource.indexOf('  function adoptTimeline(next: number[]');
  const adoptEnd = chartSource.indexOf('  function syncCounts()', adoptStart);
  const publishStart = chartSource.indexOf(
    '  function publishCandidate(series: SeriesState, candidate: SeriesStore, start: number) {',
  );
  const publishEnd = chartSource.indexOf('  function removeSeries(', publishStart);
  const setStart = chartSource.indexOf('      setData(data: readonly SeriesPoint[]) {');
  const setEnd = chartSource.indexOf('      update(point: SeriesPoint) {', setStart);
  if (adoptStart < 0 || adoptEnd < 0 || publishStart < 0 || publishEnd < 0 || setStart < 0 || setEnd < 0)
    throw Error('Actual chart timeline/setData functions not found');
  const adoptSource = chartSource
    .slice(adoptStart, adoptEnd)
    .replace('next: number[]', 'next')
    .replaceAll('options.timeDomain!', 'options.timeDomain');
  const setDataSource = chartSource
    .slice(setStart, setEnd)
    .replace('setData(data: readonly SeriesPoint[]) {', 'function setData(data) {')
    .replace(/},\s*$/, '}');
  const publishSource = chartSource
    .slice(publishStart, publishEnd)
    .replace('series: SeriesState, candidate: SeriesStore, start: number', 'series, candidate, start');
  const diagnostics = { lastIngestMs: 0 };
  const options = { timeDomain: 'utc-ms', followLatest: false, diagnostics: false };
  const events: string[] = [];
  const deps = {
    SeriesStore,
    buildRuns,
    clampRange,
    diagnostics,
    extendTimelineFromSuperset,
    nearestTimelineIndex,
    oldTimelineIsContiguousSlice,
    options,
    scene,
    series: replacement,
    type: replacement.type,
    id: replacement.id,
    assert: () => {},
    failure: (code: string) => {
      throw Error(code);
    },
    seriesById: () => replacement,
    paneById: () => ({ options: { scale: 'linear' } }),
    validLog: () => {},
    storeMatchesTimeline,
    sameKeys: (left: SeriesStore, right: SeriesStore) =>
      left.length === right.length &&
      Array.from({ length: left.length }, (_, index) => left.keyAt(index) === right.keyAt(index)).every(
        Boolean,
      ),
    rebuilt: (_series: unknown, candidate: SeriesStore) =>
      [
        ...new Set(
          scene.series.flatMap(({ store }) =>
            Array.from(
              { length: store === replacement.store ? candidate.length : store.length },
              (_, index) => (store === replacement.store ? candidate : store).keyAt(index),
            ),
          ),
        ),
      ].sort((left, right) => left - right),
    sameTimeline: (left: number[], right: number[]) =>
      left.length === right.length && left.every((key, index) => key === right[index]),
    visibleKeys: (timeline = scene.timeline, range = scene.range) => {
      const first = Math.max(0, Math.ceil(range.from));
      const last = Math.min(timeline.length - 1, Math.floor(range.to));
      return first > last ? [undefined, undefined] : [timeline[first], timeline[last]];
    },
    nextMeta: () => ({ revision: 1 }),
    reprojectCursor: (origin: string) => events.push(`cursor:${origin}`),
    queue: () => events.push('queue'),
    syncCounts: () => {},
  };
  const setData = new Function(
    'deps',
    `const {${Object.keys(deps).join(',')}} = deps; let rangeMeta={revision:0}, rangeDirty=false; ${adoptSource} ${publishSource} ${setDataSource}; return setData;`,
  )(deps) as (data: SeriesPoint[]) => void;
  return { setData, replacement, unchanged, scene, events };
}

describe('actual chart setData timeline adoption', () => {
  it.each([
    ['prepend', [0, 50, 100, 200, 300]],
    ['append', [100, 200, 300, 350, 400]],
    ['both ends', [0, 100, 200, 300, 400]],
  ] as const)('keeps unchanged sparse area/band stores unscanned on %s', (_name, times) => {
    const harness = chartSetDataHarness([100, 200, 300]);
    const reads = harness.unchanged.map((series) => vi.spyOn(series.store, 'keyAt'));
    try {
      harness.setData(times.map((time) => ({ time, value: 3 })));
      expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
      expect(harness.scene.timeline).toEqual(times);
      expect(harness.events).toEqual(['cursor:data', 'queue']);
      if (_name === 'prepend') expect(harness.scene.range).toEqual({ from: 2, to: 4 });
      for (const series of harness.scene.series)
        expect(series.runs).toEqual(buildRuns(series.store, harness.scene.timeline));
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it('falls back to full run rebuild for an interior insertion and preserves range/cursor work', () => {
    const harness = chartSetDataHarness([100, 200, 300]);
    const reads = harness.unchanged.map((series) => vi.spyOn(series.store, 'keyAt'));
    try {
      harness.setData([100, 150, 200, 300].map((time) => ({ time, value: 3 })));
      expect(reads.every((spy) => spy.mock.calls.length > 0)).toBe(true);
      expect(harness.scene.timeline).toEqual([100, 150, 200, 300]);
      expect(harness.events).toEqual(['cursor:data', 'queue']);
      for (const series of harness.scene.series)
        expect(series.runs).toEqual(buildRuns(series.store, harness.scene.timeline));
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it('falls back when the candidate removes the only copy of an old union key', () => {
    const harness = chartSetDataHarness([100, 200, 300], [100, 300]);
    const reads = harness.unchanged.map((series) => vi.spyOn(series.store, 'keyAt'));
    try {
      harness.setData([100, 300].map((time) => ({ time, value: 3 })));
      expect(reads.every((spy) => spy.mock.calls.length > 0)).toBe(true);
      expect(harness.scene.timeline).toEqual([100, 300]);
      expect(harness.events).toEqual(['cursor:data', 'queue']);
      for (const series of harness.scene.series)
        expect(series.runs).toEqual(buildRuns(series.store, harness.scene.timeline));
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it('updates changed series presence on the same union without rebuilding unchanged stores', () => {
    const harness = chartSetDataHarness([100, 200, 300]);
    const reads = harness.unchanged.map((series) => vi.spyOn(series.store, 'keyAt'));
    try {
      harness.setData([{ time: 100, value: 3 }, { time: 200 }, { time: 300, value: 4 }]);
      expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
      expect(harness.replacement.runs).toEqual([
        { from: 0, to: 0 },
        { from: 2, to: 2 },
      ]);
      expect(harness.events).toEqual(['cursor:data', 'queue']);
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

  it('proves containment against the timeline after a candidate getter changes another store', () => {
    const harness = chartSetDataHarness([100, 200, 300]);
    let changed = false;
    const first = {
      get time() {
        if (!changed) {
          changed = true;
          const other = harness.unchanged[0]!;
          other.store.setData([
            { time: 100, value: 1 },
            { time: 150, value: 2 },
            { time: 200, value: 3 },
            { time: 300, value: 4 },
          ]);
          harness.scene.timeline = [100, 150, 200, 300];
          other.runs = buildRuns(other.store, harness.scene.timeline);
          harness.unchanged[1]!.runs = buildRuns(harness.unchanged[1]!.store, harness.scene.timeline);
        }
        return 0;
      },
      value: 5,
    };
    harness.setData([first, ...[100, 200, 300].map((time) => ({ time, value: 3 }))]);
    expect(changed).toBe(true);
    expect(harness.scene.timeline).toEqual([0, 100, 150, 200, 300]);
    for (const series of harness.scene.series)
      expect(series.runs).toEqual(buildRuns(series.store, harness.scene.timeline));
    expect(harness.events).toEqual(['cursor:data', 'queue']);
  });
});

describe('outside-only timeline addition proof', () => {
  it('checks the complete old union, including empty, prefix, suffix and both ends', () => {
    expect(oldTimelineIsContiguousSlice([], [])).toBe(true);
    expect(oldTimelineIsContiguousSlice([], [1, 2])).toBe(true);
    expect(oldTimelineIsContiguousSlice([10, 20], [10, 20])).toBe(true);
    expect(oldTimelineIsContiguousSlice([10, 20], [0, 10, 20])).toBe(true);
    expect(oldTimelineIsContiguousSlice([10, 20], [10, 20, 30])).toBe(true);
    expect(oldTimelineIsContiguousSlice([10, 20], [0, 10, 20, 30])).toBe(true);
    expect(oldTimelineIsContiguousSlice([-0, 1], [0, 1, 2])).toBe(true);
    expect(oldTimelineIsContiguousSlice([10, 20], [10, 15, 20])).toBe(false);
    expect(oldTimelineIsContiguousSlice([10, 20], [10, 21])).toBe(false);
    expect(oldTimelineIsContiguousSlice([10, 20, 30], [10, 30])).toBe(false);
    expect(oldTimelineIsContiguousSlice([10, 20, 30], [0, 10, 25, 30])).toBe(false);
  });

  it.each(['line', 'area', 'band'] as const)(
    'preserves sparse/whitespace %s run indices for UTC and business-date outside additions',
    (type) => {
      for (const domain of ['utc-ms', 'business-date'] as const) {
        const times = domain === 'utc-ms' ? [10, 20, 30] : ['2024-01-30', '2024-02-01', '2024-02-05'];
        const store = new SeriesStore(type, domain);
        store.setData([
          type === 'band' ? { time: times[0]!, lower: 1, upper: 3 } : { time: times[0]!, value: 2 },
          { time: times[1]! },
          type === 'band' ? { time: times[2]!, lower: 2, upper: 4 } : { time: times[2]!, value: 3 },
        ]);
        const previous = Array.from({ length: store.length }, (_, index) => store.keyAt(index));
        const next = domain === 'utc-ms' ? [0, ...previous, 40] : [20240129, ...previous, 20240206];
        expect(oldTimelineIsContiguousSlice(previous, next)).toBe(true);
        expect(buildRuns(store, next)).toEqual(buildRuns(store, previous));
      }
    },
  );
});

describe('exact store and timeline alignment', () => {
  const types: SeriesType[] = ['line', 'area', 'histogram', 'candlestick', 'ohlc', 'band'];
  const point = (type: SeriesType, time: number | string): SeriesPoint => {
    if (type === 'band') return { time, lower: 1, upper: 3 };
    if (type === 'candlestick' || type === 'ohlc') return { time, open: 1, high: 3, low: 1, close: 2 };
    return { time, value: 2 };
  };

  it.each(types)('matches every %s key and preserves the old run boundaries', (type) => {
    for (const times of [[], [8], [3, 8, 21, 34, 89]]) {
      for (const whitespace of [
        new Set<number>(),
        new Set([1, 3]),
        new Set([times.length - 1]),
        new Set(times.map((_, index) => index)),
      ]) {
        const store = new SeriesStore(type);
        store.setData(times.map((time, index) => (whitespace.has(index) ? { time } : point(type, time))));
        const timeline = times.slice();
        expect(storeMatchesTimeline(store, timeline)).toBe(true);
        expect(store.segments(0, store.length - 1)).toEqual(buildRuns(store, timeline));
      }
    }
  });

  it('checks length before keys and rejects a same-length interior mismatch or shared gap', () => {
    const store = new SeriesStore('line');
    store.setData([point('line', 3), { time: 8 }, point('line', 21)]);
    const keyAt = vi.spyOn(store, 'keyAt');
    expect(storeMatchesTimeline(store, [3, 8])).toBe(false);
    expect(keyAt).not.toHaveBeenCalled();
    expect(storeMatchesTimeline(store, [3, 9, 21])).toBe(false);
    expect(storeMatchesTimeline(store, [3, 8, 21])).toBe(true);
    expect(storeMatchesTimeline(store, [3, 5, 8, 21])).toBe(false);
    expect(buildRuns(store, [3, 5, 8, 21])).toEqual([
      { from: 0, to: 0 },
      { from: 2, to: 2 },
    ]);

    const dense = new SeriesStore('line');
    dense.setData([point('line', 3), point('line', 8), point('line', 21)]);
    expect(dense.segments(0, dense.length - 1)).toEqual([{ from: 0, to: 2 }]);
    expect(storeMatchesTimeline(dense, [3, 5, 8, 21])).toBe(false);
    expect(buildRuns(dense, [3, 5, 8, 21])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 2 },
    ]);
  });

  it('compares normalized business dates and signed-zero keys with numeric equality', () => {
    const dates = new SeriesStore('area', 'business-date');
    dates.setData([point('area', '2024-01-31'), { time: '2024-02-01' }, point('area', '2024-02-05')]);
    const keys = [20240131, 20240201, 20240205];
    expect(storeMatchesTimeline(dates, keys)).toBe(true);
    expect(dates.segments(0, dates.length - 1)).toEqual(buildRuns(dates, keys));
    expect(storeMatchesTimeline(dates, [20240131, 20240202, 20240205])).toBe(false);

    const zero = new SeriesStore('line');
    zero.setData([point('line', -0)]);
    expect(storeMatchesTimeline(zero, [0])).toBe(true);
  });
});

describe('superset timeline extension', () => {
  const line = (times: number[]) => {
    const store = new SeriesStore('line');
    store.setData(times.map((time) => ({ time, value: time + 1 })));
    return store;
  };

  it('merges a prepend once and reuses the union for the next aligned series without sorting', () => {
    const oldTimes = Array.from({ length: 1000 }, (_, index) => index + 100);
    const nextTimes = Array.from({ length: 1100 }, (_, index) => index);
    const stores = Array.from({ length: 12 }, () => line(oldTimes));
    const replacement = line(nextTimes);
    const reads = stores.map((store) => vi.spyOn(store, 'keyAt'));
    const nextReads = vi.spyOn(replacement, 'keyAt');
    const sort = vi.spyOn(Array.prototype, 'sort');
    let timeline: number[] = oldTimes;
    try {
      for (const [index, store] of stores.entries()) {
        const readsBefore = reads.map((spy) => spy.mock.calls.length);
        const nextReadsBefore = nextReads.mock.calls.length;
        const previous = timeline;
        const sortsBefore = sort.mock.calls.length;
        const result = extendTimelineFromSuperset(store, replacement, timeline);
        expect(sort.mock.calls.length).toBe(sortsBefore);
        for (const [storeIndex, spy] of reads.entries())
          expect(spy.mock.calls.length - readsBefore[storeIndex]!).toBeLessThanOrEqual(
            storeIndex === index ? oldTimes.length : 0,
          );
        expect(nextReads.mock.calls.length - nextReadsBefore).toBeLessThanOrEqual(nextTimes.length * 2);
        expect(result).not.toBeNull();
        timeline = result!;
        expect(timeline).toEqual(nextTimes);
        if (store !== stores[0]) expect(timeline).toBe(previous);
      }
    } finally {
      for (const spy of reads) spy.mockRestore();
      nextReads.mockRestore();
      sort.mockRestore();
    }
  });

  it('retains whitespace keys and splits runs at explicit and shared gaps', () => {
    const old = line([10, 30]);
    const candidate = new SeriesStore('line');
    candidate.setData([{ time: 0, value: 1 }, { time: 10, value: 2 }, { time: 20 }, { time: 30, value: 4 }]);
    const timeline = extendTimelineFromSuperset(old, candidate, [10, 15, 30]);
    expect(timeline).toEqual([0, 10, 15, 20, 30]);
    expect(buildRuns(candidate, timeline!)).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 3 },
    ]);
  });

  it('rejects partial overlap and shrink but handles an empty old store and unchanged union', () => {
    expect(extendTimelineFromSuperset(line([1, 3]), line([1, 2, 4]), [1, 3, 4])).toBeNull();
    expect(extendTimelineFromSuperset(line([1, 3]), line([1]), [1, 3])).toBeNull();
    const current = [1, 2, 3];
    expect(extendTimelineFromSuperset(line([]), line([2]), current)).toBe(current);
    expect(extendTimelineFromSuperset(line([1]), line([]), current)).toBeNull();
  });
});
describe('shared timeline boundaries', () => {
  it('splits source runs at implicit and explicit shared gaps', () => {
    const store = new SeriesStore('line');
    store.setData([
      { time: 0, value: 1 },
      { time: 2, value: 2 },
      { time: 3 },
      { time: 4, value: 4 },
      { time: 5, value: 5 },
    ]);
    expect(buildRuns(store, [0, 1, 2, 3, 4, 5])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 3, to: 4 },
    ]);
    expect(buildRuns(store, [0, 2, 3, 4, 5])).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ]);
  });
  it('builds band runs from complete bounds across implicit and explicit gaps', () => {
    const store = new SeriesStore('band');
    store.setData([
      { time: 0, lower: 1, upper: 3 },
      { time: 2, lower: 2, upper: 4 },
      { time: 3 },
      { time: 4, lower: 3, upper: 5 },
    ]);
    expect(buildRuns(store, [0, 1, 2, 3, 4])).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 3, to: 3 },
    ]);
    expect(buildRuns(store, [0, 2, 3, 4])).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 3 },
    ]);
  });
  it('checks only tail adjacency when existing historical slots are filled', () => {
    const store = new SeriesStore('line');
    store.setData([
      { time: 0, value: 1 },
      { time: 2, value: 2 },
    ]);
    expect(tailIsAdjacent(store, [0, 1, 2, 3], 1)).toBe(false);
    expect(tailIsAdjacent(store, [0, 2, 3], 1)).toBe(true);
    store.update({ time: 3, value: 3 });
    expect(tailIsAdjacent(store, [0, 2], 2)).toBe(true);
  });
});
describe('nearest surviving timestamp', () => {
  it('chooses the closer neighbor, ties prefer earlier, and endpoints clamp', () => {
    expect(nearestTimelineIndex([0, 9, 20, 30], 10, 'utc-ms')).toBe(1);
    expect(nearestTimelineIndex([0, 11, 20, 30], 10, 'utc-ms')).toBe(1);
    expect(nearestTimelineIndex([0, 20, 30], 10, 'utc-ms')).toBe(0);
    expect(nearestTimelineIndex([0, 10, 20, 30], 10, 'utc-ms')).toBe(1);
    expect(nearestTimelineIndex([0, 10, 20, 30], -1, 'utc-ms')).toBe(0);
    expect(nearestTimelineIndex([0, 10, 20, 30], 100, 'utc-ms')).toBe(3);
  });
  it('measures calendar-day distance across business-date month boundaries', () => {
    expect(nearestTimelineIndex([20240131, 20240204], 20240201, 'business-date')).toBe(0);
  });
});
