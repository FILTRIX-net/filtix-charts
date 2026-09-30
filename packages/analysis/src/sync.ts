import { ChartError, isChartError } from '@filtrix.net/core';
import type { ChartApi, ChartChangeMeta, CrosshairEvent, LogicalRange } from '@filtrix.net/charts';
import type { ChartSync, ChartSyncOptions } from './types';

function fail(message: string): never {
  throw new ChartError('INVALID_SYNC', message);
}
interface Member {
  chart: ChartApi;
  fence: number;
  active: boolean;
  removers: Array<() => void>;
}

export function createChartSync(charts: readonly ChartApi[], options: ChartSyncOptions = {}): ChartSync {
  if (!Array.isArray(charts) || charts.length < 2) fail('At least two charts are required');
  const inputs: readonly ChartApi[] = [...charts];
  if (new Set(inputs).size !== inputs.length) fail('Charts must be distinct');
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['viewport', 'crosshair', 'crosshairMatch', 'causes'].includes(key))
  )
    fail('Invalid sync options');
  if (options.viewport !== undefined && typeof options.viewport !== 'boolean')
    fail('viewport must be boolean');
  if (options.crosshair !== undefined && typeof options.crosshair !== 'boolean')
    fail('crosshair must be boolean');
  if (
    options.crosshairMatch !== undefined &&
    options.crosshairMatch !== 'exact' &&
    options.crosshairMatch !== 'nearest'
  )
    fail('Invalid crosshair match');
  const requestedCauses = options.causes;
  let causes: ReadonlySet<ChartChangeMeta['cause']> | null = null;
  if (requestedCauses !== undefined) {
    if (!Array.isArray(requestedCauses)) fail('causes must be an array');
    const captured: ChartChangeMeta['cause'][] = [];
    for (let index = 0; index < requestedCauses.length; index++) {
      if (!Object.hasOwn(requestedCauses, index)) fail('Invalid sync cause');
      const cause = requestedCauses[index];
      if (cause !== 'interaction' && cause !== 'api' && cause !== 'data') fail('Invalid sync cause');
      captured.push(cause);
    }
    causes = new Set(captured);
  }
  for (const chart of inputs) {
    if (
      !chart ||
      typeof chart !== 'object' ||
      !['utc-ms', 'business-date'].includes(chart.timeDomain) ||
      [
        'getChangeRevision',
        'getVisibleTimeRange',
        'setVisibleTimeRange',
        'setCrosshairTime',
        'subscribeVisibleRangeChange',
        'subscribeCrosshairMove',
      ].some((key) => typeof chart[key as keyof ChartApi] !== 'function')
    )
      fail('A live chart API is required');
  }
  const domain = inputs[0]!.timeDomain;
  // Capture all membership fences before installing any callback or changing targets.
  const members: Member[] = inputs.map((chart) => {
    if (chart.timeDomain !== domain) fail('Charts must share a time domain');
    return { chart, fence: chart.getChangeRevision(), active: true, removers: [] };
  });
  const viewport = options.viewport !== false,
    crosshair = options.crosshair !== false,
    match = options.crosshairMatch ?? 'exact';
  const origin = {};
  let destroyed = false;
  function remove(member: Member): unknown[] {
    member.active = false;
    const errors: unknown[] = [];
    for (const off of member.removers.splice(0)) {
      try {
        off();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
  function cleanup(): unknown[] {
    destroyed = true;
    return members.flatMap(remove);
  }
  function live(member: Member): boolean {
    if (destroyed || !member.active) return false;
    try {
      if (member.chart.timeDomain !== domain) {
        const errors = remove(member);
        if (errors.length) throw errors[0];
        return false;
      }
      member.chart.getChangeRevision();
      return true;
    } catch (error) {
      if (!isChartError(error) || error.code !== 'DESTROYED') throw error;
      const errors = remove(member);
      if (errors.length) throw errors[0];
      return false;
    }
  }
  function accepts(source: Member, meta: ChartChangeMeta): boolean {
    return (
      live(source) &&
      meta.revision > source.fence &&
      meta.origin !== origin &&
      (causes === null || causes.has(meta.cause))
    );
  }
  function apply(target: Member, action: () => void): void {
    if (!live(target)) return;
    try {
      action();
    } catch (error) {
      if (!isChartError(error) || error.code !== 'DESTROYED') throw error;
      const errors = remove(target);
      if (errors.length) throw errors[0];
    }
  }
  try {
    for (const source of members) {
      if (viewport)
        source.removers.push(
          source.chart.subscribeVisibleRangeChange((_range: LogicalRange, meta: ChartChangeMeta) => {
            if (!accepts(source, meta)) return;
            const range = source.chart.getVisibleTimeRange();
            if (!range) return;
            for (const target of members)
              if (target !== source)
                apply(target, () => {
                  target.chart.setVisibleTimeRange(range, { origin });
                });
          }),
        );
      if (crosshair)
        source.removers.push(
          source.chart.subscribeCrosshairMove((event: CrosshairEvent, meta: ChartChangeMeta) => {
            if (!accepts(source, meta)) return;
            for (const target of members)
              if (target !== source)
                apply(target, () => {
                  target.chart.setCrosshairTime(event.time, { match, origin });
                });
          }),
        );
    }
    if (viewport && live(members[0]!)) {
      const range = members[0]!.chart.getVisibleTimeRange();
      if (range)
        for (const target of members.slice(1))
          apply(target, () => {
            target.chart.setVisibleTimeRange(range, { origin });
          });
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  return Object.freeze({
    destroy() {
      if (destroyed) return;
      const errors = cleanup();
      if (errors.length) throw errors[0];
    },
  });
}
