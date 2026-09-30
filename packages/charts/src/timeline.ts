import { lowerBound, timeFromKey } from '@filtrix.net/core';
import type { SeriesStore, TimeDomain } from '@filtrix.net/core';
import type { SeriesState } from './types';

/** A fully aligned store can use its own contiguous segments on the shared timeline. */
export function storeMatchesTimeline(store: SeriesStore, timeline: readonly number[]): boolean {
  if (store.length !== timeline.length) return false;
  for (let index = 0; index < store.length; index++) {
    if (store.keyAt(index) !== timeline[index]) return false;
  }
  return true;
}

/** Existing store-local run indices survive only when the complete old union stays contiguous. */
export function oldTimelineIsContiguousSlice(previous: readonly number[], next: readonly number[]): boolean {
  if (previous.length === 0) return true;
  if (previous.length > next.length) return false;
  const offset = lowerBound(next, previous[0]!);
  if (offset + previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index++)
    if (previous[index] !== next[offset + index]) return false;
  return true;
}

/** Extend a shared union when a replacement retains every key of its prior store. */
export function extendTimelineFromSuperset(
  oldStore: SeriesStore,
  candidate: SeriesStore,
  timeline: number[],
): number[] | null {
  let candidateIndex = 0;
  for (let oldIndex = 0; oldIndex < oldStore.length; oldIndex++) {
    const oldKey = oldStore.keyAt(oldIndex);
    let candidateKey = Number.NaN;
    while (candidateIndex < candidate.length) {
      candidateKey = candidate.keyAt(candidateIndex);
      if (candidateKey >= oldKey) break;
      candidateIndex++;
    }
    if (candidateKey !== oldKey) return null;
    candidateIndex++;
  }

  let timelineIndex = 0;
  let merged: number[] | null = null;
  for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
    const key = candidate.keyAt(candidateIndex);
    while (timelineIndex < timeline.length && timeline[timelineIndex]! < key) {
      if (merged) merged.push(timeline[timelineIndex]!);
      timelineIndex++;
    }
    if (timeline[timelineIndex] === key) {
      if (merged) merged.push(key);
      timelineIndex++;
    } else {
      if (!merged) merged = timeline.slice(0, timelineIndex);
      merged.push(key);
    }
  }
  if (merged) {
    while (timelineIndex < timeline.length) merged.push(timeline[timelineIndex++]!);
    return merged;
  }
  return timeline;
}

/** Rebuilt only when setData/removal changes the union, never on navigation. */
export function buildRuns(store: SeriesStore, timeline: readonly number[]): SeriesState['runs'] {
  const runs: SeriesState['runs'] = [];
  let global = 0,
    previousGlobal = -2;
  for (let i = 0; i < store.length; i++) {
    const key = store.keyAt(i);
    while (global < timeline.length && timeline[global]! < key) global++;
    const valid = store.hasDataAt(i);
    if (valid) {
      const last = runs[runs.length - 1];
      if (last && last.to === i - 1 && global === previousGlobal + 1) last.to = i;
      else runs.push({ from: i, to: i });
    }
    previousGlobal = global;
  }
  return runs;
}
/** A newly appended chart tail has insertion index timeline.length before push. */
export function tailIsAdjacent(store: SeriesStore, timeline: readonly number[], index: number): boolean {
  return (
    index > 0 && lowerBound(timeline, store.keyAt(index)) - lowerBound(timeline, store.keyAt(index - 1)) === 1
  );
}
export function nearestTimelineIndex(timeline: readonly number[], key: number, domain: TimeDomain): number {
  if (!timeline.length) return 0;
  const next = lowerBound(timeline, key);
  if (next === 0) return 0;
  if (next === timeline.length) return next - 1;
  if (timeline[next] === key) return next;
  const metric = (value: number) =>
    domain === 'business-date' ? Date.parse(`${timeFromKey(value, domain)}T00:00:00.000Z`) : value;
  const before = metric(timeline[next - 1]!),
    after = metric(timeline[next]!),
    target = metric(key);
  return target - before <= after - target ? next - 1 : next;
}
