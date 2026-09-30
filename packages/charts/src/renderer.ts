import { lowerBound, timeFromKey } from '@filtrix.net/core';
import { logicalX, sourceBounds, sourceX, densityStep, binEnd, histogramSum } from './layout';
import type { TimelineIndexLookup } from './layout';
import { layoutLegend } from './legend-layout';
import type { Scene, SeriesState, PaneState, CrosshairEvent } from './types';
const priceFormats = new Map<number, Intl.NumberFormat>();
const timeFormats = new WeakMap<Scene, { locale: string; timeZone: string; format: Intl.DateTimeFormat }>();
function tickPrecision(tick: number): number {
  const [mantissa, exponent = '0'] = tick.toString().split('e');
  return Math.min(12, Math.max(0, (mantissa!.split('.')[1]?.length ?? 0) - Number(exponent)));
}
export function formatPrice(value: number, options: SeriesState['options'] = {}): string {
  const tick = options.tickSize;
  const rounded = tick && Number.isFinite(value / tick) ? Math.round(value / tick) * tick : value;
  const precision =
    options.pricePrecision ??
    (tick
      ? tickPrecision(tick)
      : Math.abs(value) < 1
        ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(Math.abs(value) || 1)) + 2))
        : 2);
  if (Math.abs(rounded) >= 1e12) return rounded.toExponential(2);
  // Supported series precision has only thirteen possible values. Keep direct
  // internal callers outside that range on the original native behavior.
  if (!Number.isInteger(precision) || precision < 0 || precision > 12)
    return rounded.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  let format = priceFormats.get(precision);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
    priceFormats.set(precision, format);
  }
  return format.format(rounded);
}
export function formatTime(scene: Scene, key: number): string {
  const time = timeFromKey(key, scene.options.timeDomain ?? 'utc-ms');
  if (typeof time === 'string') return time;
  const locale = scene.options.locale ?? 'en-US';
  const timeZone = scene.options.timeZone ?? 'UTC';
  let entry = timeFormats.get(scene);
  if (!entry || entry.locale !== locale || entry.timeZone !== timeZone) {
    entry = {
      locale,
      timeZone,
      format: new Intl.DateTimeFormat(locale, {
        timeZone,
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    };
    timeFormats.set(scene, entry);
  }
  return entry.format.format(new Date(time));
}
function lineRuns(
  scene: Scene,
  series: SeriesState,
  a: number,
  b: number,
): Array<{
  from: number;
  to: number;
}> {
  if (series.options.connectGaps) return [{ from: a, to: b }];
  let lo = 0,
    hi = series.runs.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (series.runs[m]!.to < a) lo = m + 1;
    else hi = m;
  }
  const runs = [];
  for (let i = lo; i < series.runs.length; i++) {
    const run = series.runs[i]!;
    if (run.from > b) break;
    runs.push({ from: Math.max(a, run.from), to: Math.min(b, run.to) });
  }
  return runs;
}
function bandSampleIndices(
  scene: Scene,
  series: SeriesState,
  from: number,
  to: number,
  step: number,
  lookup: TimelineIndexLookup,
): number[] {
  const store = series.store;
  if (step === 1) {
    const indices: number[] = [];
    for (let index = from; index <= to; index += 1) if (store.hasDataAt(index)) indices.push(index);
    return indices;
  }
  const indices: number[] = [];
  let index = from;
  while (index <= to) {
    const end = binEnd(scene, series, index, to, step, lookup);
    const stats = store.bandRange(index, end);
    if (stats) {
      const candidates = [
        index,
        stats.lowerMinIndex,
        stats.lowerMaxIndex,
        stats.upperMinIndex,
        stats.upperMaxIndex,
        end,
      ].sort((left, right) => left - right);
      let previous = -1;
      for (const candidate of candidates) {
        if (candidate === previous || !store.hasDataAt(candidate)) continue;
        previous = candidate;
        indices.push(candidate);
      }
    }
    index = end + 1;
  }
  return indices;
}

function paintBand(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  series: SeriesState,
  pane: PaneState,
  from: number,
  to: number,
  lookup: TimelineIndexLookup,
): number {
  const scale = pane.scale;
  const opacity = series.options.fillOpacity ?? 0.14;
  if (!scale || opacity === 0) return 0;
  let count = 0;
  const step = densityStep(scene);
  ctx.save();
  ctx.fillStyle = series.options.color ?? scene.theme.accent;
  ctx.globalAlpha = opacity;
  for (const run of lineRuns(scene, series, from, to)) {
    const indices = bandSampleIndices(scene, series, run.from, run.to, step, lookup);
    if (!indices.length) continue;
    const upper = indices.map(
      (index) =>
        [sourceX(scene, series, index, lookup), scale.priceToY(series.store.upperAt(index))] as const,
    );
    const lower = indices.map(
      (index) =>
        [sourceX(scene, series, index, lookup), scale.priceToY(series.store.lowerAt(index))] as const,
    );
    if (indices.length === 1) {
      upper.push([upper[0]![0] + 1, upper[0]![1]]);
      lower.push([lower[0]![0] + 1, lower[0]![1]]);
    }
    ctx.beginPath();
    ctx.moveTo(upper[0]![0], upper[0]![1]);
    for (let index = 1; index < upper.length; index += 1) ctx.lineTo(upper[index]![0], upper[index]![1]);
    for (let index = lower.length - 1; index >= 0; index -= 1) ctx.lineTo(lower[index]![0], lower[index]![1]);
    ctx.closePath();
    ctx.fill();
    count += upper.length + lower.length;
  }
  ctx.restore();
  return count;
}

function paintSeries(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  series: SeriesState,
  pane: PaneState,
  lookup: TimelineIndexLookup,
): number {
  const scale = pane.scale;
  if (!scale) return 0;
  const [a, b] = sourceBounds(scene, series, scene.range.from, scene.range.to);
  if (b < a) return 0;
  if (series.type === 'band') return paintBand(ctx, scene, series, pane, a, b, lookup);
  const store = series.store;
  let count = 0;
  const color = series.options.color ?? scene.theme.accent;
  const up = series.options.upColor ?? scene.theme.up;
  const down = series.options.downColor ?? scene.theme.down;
  const spacing = (scene.plotWidth - 16) / Math.max(1, scene.range.to - scene.range.from);
  const step = densityStep(scene);
  ctx.lineWidth = series.options.lineWidth ?? 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (series.type === 'line' || series.type === 'area') {
    for (const run of lineRuns(scene, series, a, b)) {
      const coords: Array<[number, number]> = [];
      if (step === 1) {
        for (let i = run.from; i <= run.to; i++) {
          const value = store.valueAt(i);
          if (Number.isFinite(value)) coords.push([sourceX(scene, series, i, lookup), scale.priceToY(value)]);
        }
      } else {
        let i = run.from;
        while (i <= run.to) {
          const global = lookup(store.keyAt(i));
          const endKey =
            scene.timeline[Math.min(scene.timeline.length - 1, (Math.floor(global / step) + 1) * step)];
          let end = endKey === undefined ? run.to : store.lowerBound(endKey) - 1;
          end = Math.min(run.to, Math.max(i, end));
          const stats = store.range(i, end);
          if (stats) {
            const indices = [i, stats.minIndex, stats.maxIndex, end].sort((x, y) => x - y);
            let prev = -1;
            for (const index of indices) {
              if (index === prev) continue;
              prev = index;
              const value = store.valueAt(index);
              if (Number.isFinite(value))
                coords.push([sourceX(scene, series, index, lookup), scale.priceToY(value)]);
            }
          }
          i = end + 1;
        }
      }
      if (!coords.length) continue;
      ctx.beginPath();
      ctx.moveTo(coords[0]![0], coords[0]![1]);
      for (let i = 1; i < coords.length; i++) ctx.lineTo(coords[i]![0], coords[i]![1]);
      if (coords.length === 1) {
        ctx.lineTo(coords[0]![0] + 1, coords[0]![1]);
      }
      ctx.stroke();
      count += coords.length;
      if (series.type === 'area') {
        ctx.lineTo(coords[coords.length - 1]![0], pane.top + pane.height);
        ctx.lineTo(coords[0]![0], pane.top + pane.height);
        ctx.closePath();
        ctx.globalAlpha = 0.14;
        ctx.fill();
        ctx.globalAlpha = 1;
        count++;
      }
    }
  } else {
    let i = a;
    while (i <= b) {
      const end = binEnd(scene, series, i, b, step, lookup);
      const stats = store.range(i, end);
      if (!stats) {
        i = end + 1;
        continue;
      }
      const x =
        Math.round((sourceX(scene, series, i, lookup) + sourceX(scene, series, end, lookup)) / 2) + 0.5;
      const width = Math.max(1, Math.min(22, spacing * (end === i ? 1 : step) * 0.68));
      if (series.type === 'histogram') {
        const value = histogramSum(series, i, end);
        const y = scale.priceToY(value);
        const baseline = pane.options.scale === 'log' ? pane.top + pane.height : scale.priceToY(0);
        ctx.fillStyle = series.options.color ?? (value >= 0 ? up : down);
        ctx.globalAlpha = 0.72;
        ctx.fillRect(x - width / 2, Math.min(y, baseline), width, Math.max(1, Math.abs(baseline - y)));
        ctx.globalAlpha = 1;
        count++;
      } else {
        let first = i,
          last = end;
        while (first <= end && !Number.isFinite(store.valueAt(first))) first++;
        while (last >= first && !Number.isFinite(store.valueAt(last))) last--;
        const open = store.openAt(first),
          close = store.closeAt(last);
        const rising = close >= open;
        ctx.strokeStyle = rising ? up : down;
        ctx.fillStyle = rising ? up : down;
        ctx.lineWidth = 1;
        const oy = scale.priceToY(open),
          cy = scale.priceToY(close),
          hy = scale.priceToY(stats.max),
          ly = scale.priceToY(stats.min);
        ctx.beginPath();
        ctx.moveTo(x, hy);
        ctx.lineTo(x, ly);
        ctx.stroke();
        count++;
        if (series.type === 'ohlc') {
          ctx.beginPath();
          ctx.moveTo(x - width / 2, oy);
          ctx.lineTo(x, oy);
          ctx.moveTo(x, cy);
          ctx.lineTo(x + width / 2, cy);
          ctx.stroke();
          count += 2;
        } else {
          const bodyTop = Math.min(oy, cy),
            bodyHeight = Math.max(1, Math.abs(cy - oy));
          if (rising) {
            ctx.fillStyle = scene.theme.background;
            ctx.fillRect(x - width / 2, bodyTop, width, bodyHeight);
            ctx.strokeRect(x - width / 2, bodyTop, width, bodyHeight);
          } else ctx.fillRect(x - width / 2, bodyTop, width, bodyHeight);
          count++;
        }
      }
      i = end + 1;
    }
  }
  return count;
}
/** First nonempty series in insertion order defines a pane's shared axis format. */
function panePriceOptions(scene: Scene, paneId: string): SeriesState['options'] {
  return (
    (
      scene.series.find((series) => series.paneId === paneId && series.store.length > 0) ??
      scene.series.find((series) => series.paneId === paneId)
    )?.options ?? {}
  );
}
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): number {
  const positions = new Map<number, number>();
  let timeline = scene.timeline;
  let timelineLength = timeline.length;
  const lookup: TimelineIndexLookup = (key) => {
    if (scene.timeline !== timeline || scene.timeline.length !== timelineLength) {
      positions.clear();
      timeline = scene.timeline;
      timelineLength = timeline.length;
    }
    const cached = positions.get(key);
    if (cached !== undefined) return cached;
    const index = lowerBound(timeline, key);
    positions.set(key, index);
    return index;
  };
  const { theme } = scene;
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.font = `${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';
  let count = 0;
  for (const pane of scene.panes) {
    if (pane.height <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, pane.top, scene.plotWidth, pane.height);
    ctx.clip();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 80; x < scene.plotWidth; x += Math.max(80, scene.plotWidth / 8)) {
      ctx.moveTo(Math.round(x) + 0.5, pane.top);
      ctx.lineTo(Math.round(x) + 0.5, pane.top + pane.height);
    }
    for (const tick of pane.scale?.ticks(Math.max(2, Math.floor(pane.height / 62))) ?? []) {
      const y = pane.scale!.priceToY(tick);
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(scene.plotWidth, Math.round(y) + 0.5);
    }
    ctx.stroke();
    for (const series of scene.series) {
      if (series.paneId === pane.id && series.type === 'band')
        count += paintSeries(ctx, scene, series, pane, lookup);
    }
    for (const series of scene.series) {
      if (series.paneId === pane.id && series.type !== 'band')
        count += paintSeries(ctx, scene, series, pane, lookup);
    }
    ctx.restore();
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(scene.plotWidth + 0.5, pane.top);
    ctx.lineTo(scene.plotWidth + 0.5, pane.top + pane.height);
    ctx.moveTo(0, pane.top + pane.height + 0.5);
    ctx.lineTo(scene.width, pane.top + pane.height + 0.5);
    ctx.stroke();
    ctx.fillStyle = theme.mutedText;
    for (const tick of pane.scale?.ticks(Math.max(2, Math.floor(pane.height / 62))) ?? []) {
      ctx.fillText(
        formatPrice(tick, panePriceOptions(scene, pane.id)),
        scene.plotWidth + 8,
        pane.scale!.priceToY(tick),
        scene.width - scene.plotWidth - 12,
      );
    }
    if (scene.options.legend?.visible !== false) {
      const legend = layoutLegend(
        scene.series
          .filter((series) => series.paneId === pane.id && series.options.title)
          .map((series) => ({
            id: series.id,
            text: series.options.title!,
            color: series.options.color ?? theme.mutedText,
          })),
        {
          plotWidth: scene.plotWidth,
          paneTop: pane.top,
          paneHeight: pane.height,
          fontSize: theme.fontSize,
          maxRows: scene.options.legend?.maxRows ?? 2,
        },
        (text) => ctx.measureText(text).width,
      );
      if (legend.entries.length) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(12, pane.top + 6, scene.plotWidth - 24, pane.height - 12);
        ctx.clip();
        for (const entry of legend.entries) {
          ctx.fillStyle = entry.id === null ? theme.mutedText : entry.color;
          ctx.fillText(entry.text, entry.x, entry.y + entry.height / 2);
        }
        ctx.restore();
      }
    }
    for (const series of scene.series) {
      if (series.paneId !== pane.id) continue;
      const value = series.store.valueAt(series.store.length - 1);
      if (!pane.scale || !Number.isFinite(value)) continue;
      const y = pane.scale.priceToY(value);
      if (y < pane.top || y > pane.top + pane.height) continue;
      const color =
        series.options.color ??
        (value >= series.store.openAt(series.store.length - 1)
          ? (series.options.upColor ?? theme.up)
          : (series.options.downColor ?? theme.down));
      if (series.options.priceLineVisible) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(scene.plotWidth, y);
        ctx.stroke();
        ctx.restore();
      }
      if (series.options.lastValueVisible !== false) {
        ctx.fillStyle = color;
        ctx.fillRect(scene.plotWidth + 1, y - 10, scene.width - scene.plotWidth - 1, 20);
        ctx.fillStyle = theme.background;
        ctx.fillText(
          formatPrice(value, series.options),
          scene.plotWidth + 7,
          y,
          scene.width - scene.plotWidth - 10,
        );
      }
    }
  }
  ctx.fillStyle = theme.mutedText;
  const labels = Math.max(2, Math.floor(scene.plotWidth / 150));
  for (let j = 0; j < labels; j++) {
    const index = Math.round(scene.range.from + ((scene.range.to - scene.range.from) * j) / (labels - 1));
    const key = scene.timeline[index];
    if (key === undefined) continue;
    const label = formatTime(scene, key);
    const x = Math.max(
      5,
      Math.min(
        scene.plotWidth - ctx.measureText(label).width - 5,
        logicalX(scene, index) - ctx.measureText(label).width / 2,
      ),
    );
    ctx.fillText(label, x, scene.plotHeight + 14);
  }
  if (!scene.timeline.length) {
    ctx.fillStyle = theme.mutedText;
    ctx.textAlign = 'center';
    ctx.fillText('No data', scene.plotWidth / 2, scene.plotHeight / 2);
    ctx.textAlign = 'left';
  }
  return count;
}
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  event: CrosshairEvent | null,
  verticalOnly = false,
): void {
  ctx.clearRect(0, 0, scene.width, scene.height);
  if (!event || event.logicalIndex === null || scene.options.crosshair === false) return;
  const x = logicalX(scene, event.logicalIndex);
  const { theme } = scene;
  ctx.strokeStyle = theme.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, scene.plotHeight);
  if (!verticalOnly) {
    ctx.moveTo(0, Math.round(event.y) + 0.5);
    ctx.lineTo(scene.plotWidth, Math.round(event.y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';
  const pane = scene.panes.find((p) => p.height > 0 && event.y >= p.top && event.y <= p.top + p.height);
  if (!verticalOnly && pane?.scale) {
    const value = pane.scale.yToPrice(event.y);
    ctx.fillStyle = theme.text;
    ctx.fillRect(scene.plotWidth + 1, event.y - 11, scene.width - scene.plotWidth - 1, 22);
    ctx.fillStyle = theme.background;
    ctx.fillText(
      formatPrice(value, panePriceOptions(scene, pane.id)),
      scene.plotWidth + 7,
      event.y,
      scene.width - scene.plotWidth - 10,
    );
  }
  const key = scene.timeline[event.logicalIndex];
  if (key !== undefined) {
    const label = formatTime(scene, key),
      w = ctx.measureText(label).width + 16;
    const left = Math.max(0, Math.min(scene.plotWidth - w, x - w / 2));
    ctx.fillStyle = theme.text;
    ctx.fillRect(left, scene.plotHeight, w, 26);
    ctx.fillStyle = theme.background;
    ctx.fillText(label, left + 8, scene.plotHeight + 13);
  }
}
