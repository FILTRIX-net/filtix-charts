import {
  ChartError,
  SeriesStore,
  clampRange,
  createOwnedStudyStore,
  createOwnedVolumeStoreFromPrice,
  lowerBound,
  timeKey,
  timeFromKey,
} from '@filtrix.net/core';
import type { ChartTime, SeriesPoint, LogicalRange, OwnedStudyColumnInput } from '@filtrix.net/core';
import type {
  ChartApi,
  ChartOptions,
  ChartDiagnostics,
  CrosshairEvent,
  ChartChangeMeta,
  ChartMutationMeta,
  CrosshairTimeOptions,
  TimeRange,
  PaneHandle,
  PaneOptions,
  ChartPaneLayout,
  ChartPaneLayoutPatch,
  PaneState,
  SeriesHandle,
  SeriesOptions,
  SeriesState,
  SeriesType,
  Scene,
} from './types';
import { chartOptions, paneOptions, seriesOptions, resolveTheme, clean, exportWatermark } from './options';
import { createAttribution, drawWatermark } from './attribution';
import { layout, logicalX, xLogical } from './layout';
import { mergePaneLayout, resizePanePair, samePaneLayout, snapshotPaneLayout } from './pane-layout';
import { createPaneControls } from './pane-controls';
import { drawScene, drawOverlay } from './renderer';
import { attachInteraction } from './interaction';
import {
  buildRuns,
  extendTimelineFromSuperset,
  nearestTimelineIndex,
  oldTimelineIsContiguousSlice,
  storeMatchesTimeline,
  tailIsAdjacent,
} from './timeline';
import type { ChartPrimitive, PrimitiveHost, PrimitiveProjection } from './primitives.types';
function failure(code: string, message: string): never {
  throw new ChartError(code, message);
}

const chartOwners = new WeakMap<ChartApi, { active: boolean; utc: boolean }>();
const ownedPriceVolumeOperations = new WeakMap<
  ChartApi,
  (price: SeriesHandle, volume: SeriesHandle, bars: readonly SeriesPoint[]) => void
>();
const ownedStudyHandles = new WeakMap<
  SeriesHandle,
  {
    owner: ChartApi;
    series: SeriesState;
    ingest(points: readonly { time: number }[], input: OwnedStudyColumnInput): void;
  }
>();

/** @internal Exact live built-in UTC chart admission for the default terminal rebuild. */
export function hasOwnedStudyColumnCapability(chart: ChartApi): boolean {
  const owner = chartOwners.get(chart);
  return owner?.active === true && owner.utc;
}

/** @internal Copies an operation-owned output into one current built-in series. */
export function setOwnedStudyColumns(
  chart: ChartApi,
  handle: SeriesHandle,
  points: readonly { time: number }[],
  input: OwnedStudyColumnInput,
): void {
  const owner = chartOwners.get(chart);
  if (!owner) failure('INVALID_SERIES', 'Chart is not a built-in chart');
  if (!owner.active) failure('DESTROYED', 'Chart has been destroyed');
  if (!owner.utc) failure('INVALID_TIME_DOMAIN', 'Owned study columns require a UTC chart');
  const entry = ownedStudyHandles.get(handle);
  if (!entry || entry.owner !== chart) failure('INVALID_SERIES', 'Series handle does not belong to chart');
  entry.ingest(points, input);
}

/** @internal Publishes price first, then copies volume from that exact fresh price candidate. */
export function setOwnedPriceVolumeData(
  chart: ChartApi,
  price: SeriesHandle,
  volume: SeriesHandle,
  bars: readonly SeriesPoint[],
): void {
  const owner = chartOwners.get(chart);
  if (!owner) failure('INVALID_SERIES', 'Chart is not a built-in chart');
  if (!owner.active) failure('DESTROYED', 'Chart has been destroyed');
  if (!owner.utc) failure('INVALID_TIME_DOMAIN', 'Owned price/volume requires a UTC chart');
  const operation = ownedPriceVolumeOperations.get(chart);
  if (!operation) failure('INVALID_SERIES', 'Chart has no owned price/volume operation');
  operation(price, volume, bars);
}
export function createChart(container: HTMLElement, initial: ChartOptions = {}): ChartApi {
  if (!container?.ownerDocument?.defaultView)
    failure('INVALID_CONTAINER', 'A browser HTMLElement is required');
  const doc = container.ownerDocument,
    win = doc.defaultView!;
  let options = chartOptions(
    { timeDomain: 'utc-ms', autoSize: true, crosshair: true, followLatest: true, maxPixelRatio: 2 },
    initial,
  );
  const wrapper = doc.createElement('div');
  wrapper.dataset.filtixChart = '';
  wrapper.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  const root = doc.createElement('div');
  root.dataset.filtixRoot = '';
  root.tabIndex = 0;
  root.setAttribute('role', 'img');
  root.setAttribute(
    'aria-label',
    options.ariaLabel ??
      'Financial chart. Arrow keys pan, plus and minus zoom, Home fits content, End returns to latest.',
  );
  root.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;overflow:hidden;touch-action:none;outline-offset:-2px;';
  const sceneCanvas = doc.createElement('canvas'),
    overlayCanvas = doc.createElement('canvas');
  for (const canvas of [sceneCanvas, overlayCanvas]) {
    canvas.style.cssText =
      'position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none;';
    canvas.setAttribute('aria-hidden', 'true');
    root.append(canvas);
  }
  sceneCanvas.dataset.filtixLayer = 'scene';
  overlayCanvas.dataset.filtixLayer = 'overlay';
  const sceneCtx = sceneCanvas.getContext('2d'),
    overlayCtx = overlayCanvas.getContext('2d');
  if (!sceneCtx || !overlayCtx) failure('CANVAS_UNAVAILABLE', 'Canvas 2D is unavailable');
  wrapper.append(root);
  container.append(wrapper);
  const scene: Scene = {
    width: 0,
    height: 0,
    plotWidth: 0,
    plotHeight: 0,
    dpr: 1,
    theme: resolveTheme(options),
    options,
    timeline: [],
    range: { from: 0, to: 1 },
    panes: [{ id: 'price', options: paneOptions({}), top: 0, height: 0, scale: null }],
    series: [],
  };
  let dead = false,
    frame = 0,
    sceneDirty = true,
    overlayDirty = true,
    layoutDirty = true,
    rangeDirty = false,
    crosshairDirty = false,
    idCounter = 0;
  let revision = 0;
  let layoutRevision = 0;
  let maximizedPaneId: string | null = null;
  let previewLayout: ChartPaneLayout | null = null;
  let paneControls: ReturnType<typeof createPaneControls> | null = null;
  let attribution: ReturnType<typeof createAttribution> | null = null;
  let rangeMeta: ChartChangeMeta = Object.freeze({ revision: 0, cause: 'api' });
  let crosshairMeta: ChartChangeMeta = Object.freeze({ revision: 0, cause: 'api' });
  let controlled: { key: number; match: 'exact' | 'nearest'; origin?: object } | null = null;
  let annotationCanvas: HTMLCanvasElement | null = null,
    annotationCtx: CanvasRenderingContext2D | null = null,
    primitiveDirty = false;
  type PrimitiveEntry = { primitive: ChartPrimitive; active: boolean; cleanup: (() => void) | undefined };
  const primitives = new Map<ChartPrimitive, PrimitiveEntry>();
  let pointer: {
    x: number;
    y: number;
  } | null = null;
  let crosshair: CrosshairEvent | null = null;
  const rangeListeners = new Set<(r: LogicalRange, meta: ChartChangeMeta) => void>(),
    crosshairListeners = new Set<(e: CrosshairEvent, meta: ChartChangeMeta) => void>(),
    paneLayoutListeners = new Set<(value: ChartPaneLayout, meta: ChartChangeMeta) => void>(),
    waiters = new Set<() => void>();
  const diagnostics: ChartDiagnostics = {
    sceneDraws: 0,
    overlayDraws: 0,
    primitiveDraws: 0,
    primitiveCount: 0,
    lastRenderMs: 0,
    lastIngestMs: 0,
    renderedPrimitives: 0,
    dataPoints: 0,
    seriesCount: 0,
    framePending: false,
  };
  const assert = () => {
    if (dead) failure('DESTROYED', 'Chart has been destroyed');
  };
  function committedPaneLayout(): ChartPaneLayout {
    return snapshotPaneLayout(
      scene.panes.map((pane) => ({
        id: pane.id,
        weight: pane.options.weight,
        minHeight: pane.options.minHeight,
      })),
      maximizedPaneId,
    );
  }
  function ensureLayout() {
    if (layoutDirty) {
      layout(scene, previewLayout ?? committedPaneLayout());
      layoutDirty = false;
      paneControls?.sync();
      attribution?.sync();
    }
  }
  function queue(sceneChange = true) {
    if (dead) return;
    if (sceneChange) {
      sceneDirty = true;
      layoutDirty = true;
      if (primitives.size) primitiveDirty = true;
    }
    overlayDirty = true;
    if (!frame) {
      frame = win.requestAnimationFrame(render);
      diagnostics.framePending = true;
    }
  }
  function ensureAnnotationCanvas() {
    if (annotationCanvas) return annotationCanvas;
    const canvas = doc.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) failure('CANVAS_UNAVAILABLE', 'Canvas 2D is unavailable');
    canvas.dataset.filtixLayer = 'annotation';
    canvas.style.cssText =
      'position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none;';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = sceneCanvas.width;
    canvas.height = sceneCanvas.height;
    context.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
    root.insertBefore(canvas, overlayCanvas);
    annotationCanvas = canvas;
    annotationCtx = context;
    return canvas;
  }
  function releaseAnnotationCanvas() {
    if (!annotationCanvas) return;
    annotationCanvas.width = annotationCanvas.height = 0;
    annotationCanvas.remove();
    annotationCanvas = null;
    annotationCtx = null;
  }
  function projection(): PrimitiveProjection {
    ensureLayout();
    const range = Object.freeze({ ...scene.range });
    const timeline = scene.timeline,
      timelineLength = timeline.length;
    const theme = Object.freeze({ ...scene.theme });
    const panes = scene.panes
      .filter((pane) => pane.height > 0)
      .map((pane) => ({
        id: pane.id,
        left: 0,
        top: pane.top,
        right: scene.plotWidth,
        bottom: pane.top + pane.height,
        scale: pane.options.scale,
        priceScale: pane.scale,
      }));
    const width = scene.width,
      height = scene.height,
      plotWidth = scene.plotWidth,
      plotHeight = scene.plotHeight,
      dpr = scene.dpr;
    const drawable =
      width > 0 &&
      height > 0 &&
      plotWidth > 0 &&
      plotHeight > 0 &&
      panes.some((pane) => pane.bottom > pane.top);
    const logicalXAt = (index: number) =>
      8 + ((index - range.from) / Math.max(1, range.to - range.from)) * Math.max(1, plotWidth - 16);
    const xLogicalAt = (x: number) =>
      range.from + ((x - 8) / Math.max(1, plotWidth - 16)) * (range.to - range.from);
    const loadedIndex = (time: ChartTime) => {
      const key = timeKey(time, options.timeDomain!);
      const index = lowerBound(timeline, key);
      return index < timelineLength && timeline[index] === key ? index : null;
    };
    const paneAt = (id: string) => panes.find((pane) => pane.id === id) ?? null;
    return Object.freeze({
      width,
      height,
      plotWidth,
      plotHeight,
      dpr,
      timeDomain: options.timeDomain!,
      theme,
      panes: Object.freeze(panes.map(({ priceScale: _scale, ...pane }) => Object.freeze(pane))),
      timeToX(time: ChartTime) {
        if (!drawable) return null;
        const index = loadedIndex(time);
        return index === null ? null : logicalXAt(index);
      },
      timeToLogicalIndex(time: ChartTime) {
        return drawable ? loadedIndex(time) : null;
      },
      logicalIndexToTime(index: number) {
        return !drawable || !Number.isInteger(index) || index < 0 || index >= timelineLength
          ? null
          : timeFromKey(timeline[index]!, options.timeDomain!);
      },
      priceToY(price: number, paneId = 'price') {
        const pane = paneAt(paneId);
        if (!drawable || !pane?.priceScale || !Number.isFinite(price) || (pane.scale === 'log' && price <= 0))
          return null;
        const y = pane.priceScale.priceToY(price);
        return Number.isFinite(y) ? y : null;
      },
      xToTime(x: number) {
        if (!drawable || !Number.isFinite(x)) return null;
        const index = Math.round(xLogicalAt(x));
        return index < 0 || index >= timelineLength
          ? null
          : timeFromKey(timeline[index]!, options.timeDomain!);
      },
      yToPrice(y: number, paneId = 'price') {
        const pane = paneAt(paneId);
        if (!drawable || !pane?.priceScale || !Number.isFinite(y)) return null;
        const price = pane.priceScale.yToPrice(y);
        return Number.isFinite(price) ? price : null;
      },
    });
  }
  function paintPrimitives(context: CanvasRenderingContext2D, mode: 'screen' | 'export') {
    const view = projection();
    for (const entry of [...primitives.values()]) {
      if (!entry.active) continue;
      context.save();
      try {
        entry.primitive.draw(context, view, mode);
      } catch (error) {
        if (mode === 'export') throw error;
        invoke(() => {
          throw error;
        });
      } finally {
        context.restore();
      }
      diagnostics.primitiveDraws++;
    }
  }
  function requestPrimitivePaint() {
    if (dead || !primitives.size) return;
    primitiveDirty = true;
    if (!frame) {
      frame = win.requestAnimationFrame(render);
      diagnostics.framePending = true;
    }
  }
  function detachEntry(entry: PrimitiveEntry) {
    if (!entry.active) return;
    entry.active = false;
    primitives.delete(entry.primitive);
    diagnostics.primitiveCount = primitives.size;
    const cleanup = entry.cleanup;
    entry.cleanup = undefined;
    if (cleanup) invoke(cleanup);
    if (!primitives.size) releaseAnnotationCanvas();
  }
  function hasPlot(): boolean {
    return scene.plotWidth > 0 && scene.plotHeight > 0 && scene.panes.some((pane) => pane.height > 0);
  }
  function resolveControlled(key: number, match: 'exact' | 'nearest'): number | null {
    const found = lowerBound(scene.timeline, key);
    if (scene.timeline[found] === key) return found;
    return match === 'nearest' && scene.timeline.length
      ? nearestTimelineIndex(scene.timeline, key, options.timeDomain!)
      : null;
  }
  function mutationOptions(value: unknown, cursor = false): CrosshairTimeOptions {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      failure('INVALID_OPTIONS', 'Mutation options must be an object');
    const candidate = value as CrosshairTimeOptions;
    if (
      Object.keys(candidate).some((key) => key !== 'origin' && (!cursor || key !== 'match')) ||
      (candidate.origin !== undefined &&
        (candidate.origin === null || !['object', 'function'].includes(typeof candidate.origin))) ||
      (cursor &&
        candidate.match !== undefined &&
        candidate.match !== 'exact' &&
        candidate.match !== 'nearest')
    )
      failure('INVALID_OPTIONS', 'Invalid mutation metadata or matching policy');
    return candidate;
  }
  function makeCrosshair(): CrosshairEvent {
    ensureLayout();
    const points: Record<string, SeriesPoint | null> = Object.create(null);
    let index: number | null = null;
    let x = pointer?.x ?? -1;
    const y = controlled ? 0 : (pointer?.y ?? -1);
    if (controlled) {
      const resolved = resolveControlled(controlled.key, controlled.match);
      if (resolved !== null && hasPlot()) {
        x = logicalX(scene, resolved);
        if (resolved >= scene.range.from && resolved <= scene.range.to && x >= 0 && x <= scene.plotWidth)
          index = resolved;
      }
    } else if (
      hasPlot() &&
      pointer &&
      pointer.x >= 0 &&
      pointer.x <= scene.plotWidth &&
      scene.panes.some((p) => p.height > 0 && pointer!.y >= p.top && pointer!.y <= p.top + p.height) &&
      scene.timeline.length
    ) {
      const logical = xLogical(scene, pointer.x);
      const nearest = Math.round(logical);
      if (
        nearest >= 0 &&
        nearest < scene.timeline.length &&
        logical >= scene.range.from - 0.5 &&
        logical <= scene.range.to + 0.5
      )
        index = nearest;
    }
    const key = index === null ? undefined : scene.timeline[index];
    for (const series of scene.series) {
      const i = key === undefined ? -1 : series.store.lowerBound(key);
      const point =
        key !== undefined && series.store.keyAt(i) === key && series.store.hasDataAt(i)
          ? series.store.pointAt(i)
          : null;
      points[series.id] = point ? Object.freeze(point) : null;
    }
    return Object.freeze({
      time: key === undefined ? null : timeFromKey(key, options.timeDomain!),
      logicalIndex: index,
      x,
      y,
      points: Object.freeze(points),
    });
  }
  function render() {
    frame = 0;
    diagnostics.framePending = false;
    if (dead) return;
    const start = options.diagnostics ? performance.now() : 0;
    ensureLayout();
    const notifyRange = rangeDirty,
      notifyRangeMeta = rangeMeta,
      notifyCrosshair = crosshairDirty,
      notifyCrosshairMeta = crosshairMeta;
    rangeDirty = false;
    crosshairDirty = false;
    if (scene.width > 0 && scene.height > 0) {
      if (sceneDirty) {
        diagnostics.renderedPrimitives = drawScene(sceneCtx!, scene);
        diagnostics.sceneDraws++;
      }
      const drawPrimitives = primitiveDirty;
      primitiveDirty = false;
      if (drawPrimitives && annotationCtx) {
        annotationCtx.clearRect(0, 0, scene.width, scene.height);
        paintPrimitives(annotationCtx, 'screen');
      }
    }
    if (overlayDirty) {
      crosshair = makeCrosshair();
      if (scene.width > 0 && scene.height > 0) {
        drawOverlay(overlayCtx!, scene, crosshair, controlled !== null);
        diagnostics.overlayDraws++;
      }
    }
    sceneDirty = false;
    overlayDirty = false;
    diagnostics.lastRenderMs = options.diagnostics ? performance.now() - start : 0;
    const finalRange = Object.freeze({ ...scene.range });
    const finalCrosshair = crosshair ?? makeCrosshair();
    const pendingWaiters = [...waiters];
    waiters.clear();
    if (notifyRange)
      for (const callback of [...rangeListeners]) {
        if (dead) break;
        if (rangeListeners.has(callback)) invoke(() => callback(finalRange, notifyRangeMeta));
      }
    if (notifyCrosshair)
      for (const callback of [...crosshairListeners]) {
        if (dead) break;
        if (crosshairListeners.has(callback)) invoke(() => callback(finalCrosshair, notifyCrosshairMeta));
      }
    for (const resolve of pendingWaiters) resolve();
  }
  function invoke(callback: () => void) {
    try {
      callback();
    } catch (error) {
      win.setTimeout(() => {
        throw error;
      }, 0);
    }
  }
  function resize() {
    if (dead) return;
    const width = options.width ?? container.clientWidth,
      height = options.height ?? container.clientHeight;
    const dpr = Math.min(
      win.devicePixelRatio || 1,
      options.maxPixelRatio ?? 2,
      16384 / Math.max(1, width),
      16384 / Math.max(1, height),
      4096 / Math.sqrt(Math.max(1, width)) / Math.sqrt(Math.max(1, height)),
    );
    if (width === scene.width && height === scene.height && dpr === scene.dpr) return;
    scene.width = width;
    scene.height = height;
    scene.dpr = dpr;
    reprojectCursor('api');
    paneControls?.cancel();
    wrapper.style.width = options.width !== undefined ? `${width}px` : '100%';
    wrapper.style.height = options.height !== undefined ? `${height}px` : '100%';
    for (const canvas of [sceneCanvas, annotationCanvas, overlayCanvas]) {
      if (!canvas) continue;
      canvas.width = Math.max(0, Math.min(16384, Math.floor(width * dpr)));
      canvas.height = Math.max(0, Math.min(16384, Math.floor(height * dpr)));
      canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    queue();
  }
  function nextMeta(cause: ChartChangeMeta['cause'], origin?: object) {
    const meta: ChartChangeMeta =
      origin === undefined ? { revision: ++revision, cause } : { revision: ++revision, cause, origin };
    return Object.freeze(meta);
  }
  function reprojectCursor(cause: ChartChangeMeta['cause']) {
    if (dead || (!controlled && !pointer)) return;
    crosshairMeta = nextMeta(cause, controlled?.origin);
    crosshairDirty = true;
  }
  function changeRange(range: LogicalRange, cause: ChartChangeMeta['cause'] = 'api', origin?: object) {
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to < range.from)
      failure('INVALID_RANGE', 'Range must be finite and ordered');
    const next = clampRange(range, scene.timeline.length);
    if (next.from === scene.range.from && next.to === scene.range.to) return;
    scene.range = next;
    rangeMeta = nextMeta(cause, origin);
    rangeDirty = true;
    reprojectCursor(cause);
    queue();
  }
  function publishPaneLayout(cause: ChartChangeMeta['cause'], origin?: object) {
    reprojectCursor(cause);
    queue();
    const snapshot = committedPaneLayout();
    const meta = nextMeta(cause, origin);
    layoutRevision = meta.revision;
    for (const callback of [...paneLayoutListeners]) {
      if (dead || layoutRevision !== meta.revision) break;
      if (!paneLayoutListeners.has(callback)) continue;
      try {
        callback(snapshot, meta);
      } catch {
        /* A consumer cannot unwind a committed mutation. */
      }
    }
  }
  function commitPaneLayout(candidate: ChartPaneLayout, cause: ChartChangeMeta['cause'], origin?: object) {
    paneControls?.cancel();
    previewLayout = null;
    const before = committedPaneLayout();
    if (samePaneLayout(before, candidate)) {
      queue();
      return;
    }
    for (const entry of candidate.panes) {
      const pane = scene.panes.find((item) => item.id === entry.id);
      if (!pane) return;
      pane.options = { ...pane.options, weight: entry.weight, minHeight: entry.minHeight };
    }
    maximizedPaneId = candidate.maximizedPaneId;
    publishPaneLayout(cause, origin);
  }
  function paneById(id: string) {
    const pane = scene.panes.find((p) => p.id === id);
    if (!pane) failure('REMOVED', 'Pane does not exist');
    return pane;
  }
  function seriesById(id: string) {
    const series = scene.series.find((s) => s.id === id);
    if (!series) failure('REMOVED', 'Series does not exist');
    return series;
  }
  function validLog(store: SeriesStore, pane: PaneState) {
    if (pane.options.scale === 'log') {
      const stats = store.range(0, store.length - 1);
      if (stats && stats.min <= 0)
        failure('INVALID_LOG_DATA', 'Logarithmic panes require strictly positive data');
    }
  }
  function rebuilt(replacement?: SeriesState, candidate?: SeriesStore): number[] {
    const stores = scene.series.map((s) => (s === replacement ? candidate! : s.store));
    if (stores.length === 1) {
      const store = stores[0]!;
      return Array.from({ length: store.length }, (_, i) => store.keyAt(i));
    }
    const keys: number[] = [];
    for (const store of stores) for (let i = 0; i < store.length; i++) keys.push(store.keyAt(i));
    keys.sort((a, b) => a - b);
    let length = 0;
    for (let i = 0; i < keys.length; i++) if (i === 0 || keys[i] !== keys[i - 1]) keys[length++] = keys[i]!;
    keys.length = length;
    return keys;
  }
  function sameKeys(left: SeriesStore, right: SeriesStore): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++)
      if (left.keyAt(index) !== right.keyAt(index)) return false;
    return true;
  }
  function sameTimeline(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((key, index) => key === right[index]);
  }
  function visibleKeys(
    timeline = scene.timeline,
    range = scene.range,
  ): [number | undefined, number | undefined] {
    const first = Math.max(0, Math.ceil(range.from)),
      last = Math.min(timeline.length - 1, Math.floor(range.to));
    return first > last ? [undefined, undefined] : [timeline[first], timeline[last]];
  }
  function adoptTimeline(next: number[], rebuildLineRuns = true) {
    const previousBounds = visibleKeys();
    const old = scene.timeline;
    const span = scene.range.to - scene.range.from;
    const pinned = old.length > 0 && scene.range.to >= old.length - 1 - 0.01;
    const anchorIndex = Math.floor(scene.range.from);
    const anchor = old[anchorIndex];
    scene.timeline = next;
    if (rebuildLineRuns)
      for (const series of scene.series) {
        if (series.type === 'line' || series.type === 'area' || series.type === 'band')
          series.runs = buildRuns(series.store, next);
      }
    let from = scene.range.from;
    if (!old.length) {
      from = Math.max(0, next.length - 101);
    } else if (options.followLatest && pinned) {
      from = Math.max(0, next.length - 1 - span);
    } else if (anchor !== undefined) {
      from = nearestTimelineIndex(next, anchor, options.timeDomain!) + (scene.range.from - anchorIndex);
    }
    const nextRange = clampRange(
      { from, to: from + (old.length ? span : Math.min(100, Math.max(1, next.length - 1))) },
      next.length,
    );
    const nextBounds = visibleKeys(next, nextRange);
    if (
      nextRange.from !== scene.range.from ||
      nextRange.to !== scene.range.to ||
      previousBounds[0] !== nextBounds[0] ||
      previousBounds[1] !== nextBounds[1]
    ) {
      scene.range = nextRange;
      rangeMeta = nextMeta('data');
      rangeDirty = true;
    }
    reprojectCursor('data');
    queue();
  }
  function syncCounts() {
    diagnostics.dataPoints = scene.series.reduce((n, s) => n + s.store.length, 0);
    diagnostics.seriesCount = scene.series.length;
  }
  function publishCandidate(series: SeriesState, candidate: SeriesStore, start: number) {
    validLog(candidate, paneById(series.paneId));
    const aligned = storeMatchesTimeline(candidate, scene.timeline);
    const extended =
      aligned || sameKeys(series.store, candidate)
        ? scene.timeline
        : extendTimelineFromSuperset(series.store, candidate, scene.timeline);
    const computed = extended ?? rebuilt(series, candidate);
    const timeline = extended === null && sameTimeline(computed, scene.timeline) ? scene.timeline : computed;
    const timelineChanged = timeline !== scene.timeline;
    const preserveUnchangedRuns = timelineChanged && oldTimelineIsContiguousSlice(scene.timeline, timeline);
    const runs = aligned
      ? candidate.segments(0, candidate.length - 1)
      : series.type === 'line' || series.type === 'area' || series.type === 'band'
        ? timelineChanged && !preserveUnchangedRuns
          ? []
          : buildRuns(candidate, timeline)
        : candidate.segments(0, candidate.length - 1);
    series.store = candidate;
    series.runs = runs;
    adoptTimeline(timeline, timelineChanged && !preserveUnchangedRuns);
    syncCounts();
    diagnostics.lastIngestMs = options.diagnostics ? performance.now() - start : 0;
  }
  function removeSeries(id: string) {
    assert();
    const series = seriesById(id);
    scene.series.splice(scene.series.indexOf(series), 1);
    series.store = new SeriesStore(series.type, options.timeDomain);
    series.runs = [];
    adoptTimeline(rebuilt());
    syncCounts();
  }
  function removePane(id: string) {
    assert();
    const pane = paneById(id);
    for (const series of [...scene.series])
      if (series.paneId === id) {
        scene.series.splice(scene.series.indexOf(series), 1);
        series.store = new SeriesStore(series.type, options.timeDomain);
        series.runs = [];
      }
    paneControls?.cancel();
    scene.panes.splice(scene.panes.indexOf(pane), 1);
    if (maximizedPaneId === id) maximizedPaneId = null;
    adoptTimeline(rebuilt());
    syncCounts();
    publishPaneLayout('api');
  }
  function addPane(patch: PaneOptions = {}): PaneHandle {
    assert();
    patch = clean(patch);
    const validated = paneOptions(patch);
    const id = patch.id ?? `pane-${++idCounter}`;
    if (scene.panes.some((p) => p.id === id)) failure('DUPLICATE_ID', 'Pane id already exists');
    const pane: PaneState = { id, options: validated, top: 0, height: 0, scale: null };
    paneControls?.cancel();
    scene.panes.push(pane);
    publishPaneLayout('api');
    return Object.freeze({
      id,
      applyOptions(next: PaneOptions) {
        assert();
        if (paneById(id) !== pane) failure('REMOVED', 'Pane has been removed');
        next = clean(next);
        if (next.id !== undefined && next.id !== id) failure('IMMUTABLE_ID', 'Pane id is immutable');
        const validated = paneOptions({ ...pane.options, ...next });
        if (validated.scale === 'log')
          for (const series of scene.series)
            if (series.paneId === id) validLog(series.store, { ...pane, options: validated });
        paneControls?.cancel();
        const changed =
          pane.options.weight !== validated.weight || pane.options.minHeight !== validated.minHeight;
        pane.options = validated;
        if (changed) publishPaneLayout('api');
        else {
          reprojectCursor('api');
          queue();
        }
      },
      remove() {
        assert();
        if (paneById(id) !== pane) failure('REMOVED', 'Pane has been removed');
        removePane(id);
      },
    });
  }
  function addSeries(type: SeriesType, patch: SeriesOptions = {}): SeriesHandle {
    assert();
    if (!['candlestick', 'ohlc', 'line', 'area', 'histogram', 'band'].includes(type))
      failure('INVALID_SERIES', 'Unknown series type');
    patch = seriesOptions(type, patch, true);
    const paneId = patch.paneId ?? 'price';
    paneById(paneId);
    const id = patch.id ?? `series-${++idCounter}`;
    if (scene.series.some((s) => s.id === id)) failure('DUPLICATE_ID', 'Series id already exists');
    const series: SeriesState = {
      id,
      type,
      paneId,
      options: patch,
      store: new SeriesStore(type, options.timeDomain),
      runs: [],
    };
    scene.series.push(series);
    syncCounts();
    queue();
    const handle: SeriesHandle = Object.freeze({
      id,
      type,
      setData(data: readonly SeriesPoint[]) {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        const start = options.diagnostics ? performance.now() : 0;
        const candidate = new SeriesStore(type, options.timeDomain);
        candidate.setData(data);
        publishCandidate(series, candidate, start);
      },
      update(point: SeriesPoint) {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        const start = options.diagnostics ? performance.now() : 0;
        const validation = new SeriesStore(type, options.timeDomain);
        validation.setData([point]);
        validLog(validation, paneById(series.paneId));
        const snapshot = validation.pointAt(0)!;
        const key = validation.keyAt(0);
        const lastKey = scene.timeline[scene.timeline.length - 1];
        if (lastKey !== undefined && key < lastKey && scene.timeline[lowerBound(scene.timeline, key)] !== key)
          failure('HISTORICAL_INSERT', 'New historical timeline slots require setData');
        const cursorRevision = crosshairMeta.revision,
          rangeRevision = rangeMeta.revision,
          previousBounds = visibleKeys();
        const oldLength = series.store.length;
        const kind = series.store.update(snapshot);
        const index = series.store.length - 1;
        const hasValue = series.store.hasDataAt(index);
        const lastRun = series.runs[series.runs.length - 1];
        if (kind === 'replace' && lastRun?.to === index) {
          if (lastRun.from === index) series.runs.pop();
          else lastRun.to--;
        }
        if (hasValue) {
          const run = series.runs[series.runs.length - 1];
          if (
            run &&
            run.to === index - 1 &&
            ((type !== 'line' && type !== 'area' && type !== 'band') ||
              tailIsAdjacent(series.store, scene.timeline, index))
          )
            run.to = index;
          else series.runs.push({ from: index, to: index });
        }
        if (lastKey === undefined || key > lastKey) {
          const pinned = scene.timeline.length > 0 && scene.range.to >= scene.timeline.length - 1 - 0.01;
          scene.timeline.push(key);
          if (options.followLatest && pinned) {
            const span = scene.range.to - scene.range.from;
            changeRange({ from: scene.timeline.length - 1 - span, to: scene.timeline.length - 1 }, 'data');
          } else if (scene.timeline.length === 1) scene.range = { from: 0, to: 1 };
        }
        const nextBounds = visibleKeys();
        if (
          rangeMeta.revision === rangeRevision &&
          (previousBounds[0] !== nextBounds[0] || previousBounds[1] !== nextBounds[1])
        ) {
          rangeMeta = nextMeta('data');
          rangeDirty = true;
        }
        diagnostics.dataPoints += series.store.length - oldLength;
        if (crosshairMeta.revision === cursorRevision) reprojectCursor('data');
        queue();
        diagnostics.lastIngestMs = options.diagnostics ? performance.now() - start : 0;
      },
      applyOptions(next: SeriesOptions) {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        next = seriesOptions(type, next);
        if (next.id !== undefined && next.id !== id) failure('IMMUTABLE_ID', 'Series id is immutable');
        const target = paneById(next.paneId ?? series.paneId);
        validLog(series.store, target);
        series.options = { ...series.options, ...next };
        series.paneId = target.id;
        queue();
      },
      getData() {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        return Array.from({ length: series.store.length }, (_, i) => series.store.pointAt(i)!);
      },
      remove() {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        removeSeries(id);
      },
    });
    ownedStudyHandles.set(handle, {
      owner: api,
      series,
      ingest(points, input) {
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        const start = options.diagnostics ? performance.now() : 0;
        const candidate = createOwnedStudyStore(type, options.timeDomain!, points, input);
        assert();
        if (seriesById(id) !== series) failure('REMOVED', 'Series has been removed');
        publishCandidate(series, candidate, start);
      },
    });
    return handle;
  }
  function subscribe<T>(
    set: Set<(value: T, meta: ChartChangeMeta) => void>,
    callback: (value: T, meta: ChartChangeMeta) => void,
  ) {
    assert();
    if (typeof callback !== 'function') failure('INVALID_LISTENER', 'Listener must be a function');
    set.add(callback);
    let active = true;
    return () => {
      if (active) {
        set.delete(callback);
        active = false;
      }
    };
  }
  let observer: ResizeObserver | null = null;
  function observe() {
    observer?.disconnect();
    if (options.autoSize !== false && typeof win.ResizeObserver === 'function') {
      observer = new win.ResizeObserver(resize);
      observer.observe(container);
    }
  }
  let media: MediaQueryList | null = null;
  function dprChange() {
    media?.removeEventListener('change', dprChange);
    resize();
    media = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    media.addEventListener('change', dprChange);
  }
  const cleanupInput = attachInteraction(root, scene, {
    range: (range) => changeRange(range, 'interaction'),
    fit: () => changeRange({ from: 0, to: Math.max(1, scene.timeline.length - 1) }, 'interaction'),
    latest: () => {
      const span = scene.range.to - scene.range.from;
      changeRange({ from: scene.timeline.length - 1 - span, to: scene.timeline.length - 1 }, 'interaction');
    },
    pointer(value) {
      if (dead || (!controlled && pointer?.x === value?.x && pointer?.y === value?.y)) return;
      controlled = null;
      pointer = value;
      crosshairMeta = nextMeta('interaction');
      crosshairDirty = true;
      queue(false);
    },
    layout: ensureLayout,
  });
  function paneResizeCandidate(paneId: string, deltaCssPixels: number) {
    if (typeof paneId !== 'string' || !scene.panes.some((pane) => pane.id === paneId))
      failure('INVALID_PANE_LAYOUT', 'Unknown pane id');
    if (!Number.isFinite(deltaCssPixels)) failure('INVALID_PANE_LAYOUT', 'Resize delta must be finite');
    const before = committedPaneLayout();
    const index = scene.panes.findIndex((pane) => pane.id === paneId);
    const upperIndex = index === scene.panes.length - 1 ? index - 1 : index;
    const candidate = resizePanePair(
      before,
      scene.height,
      upperIndex,
      index === scene.panes.length - 1 ? -deltaCssPixels : deltaCssPixels,
    );
    return { before, candidate };
  }
  paneControls = createPaneControls(wrapper, scene, {
    committed: committedPaneLayout,
    revision: () => layoutRevision,
    syncSize: resize,
    preview(value) {
      previewLayout = value;
      reprojectCursor('interaction');
      queue();
    },
    commit(value) {
      commitPaneLayout(value, 'interaction');
    },
    resize(index, delta) {
      const candidate = resizePanePair(committedPaneLayout(), scene.height, index, delta);
      commitPaneLayout(candidate, 'interaction');
    },
  });
  const api: ChartApi = {
    get timeDomain() {
      return options.timeDomain!;
    },
    getChangeRevision() {
      assert();
      return revision;
    },
    getVisibleTimeRange() {
      assert();
      const first = Math.max(0, Math.ceil(scene.range.from)),
        last = Math.min(scene.timeline.length - 1, Math.floor(scene.range.to));
      return first > last || scene.timeline[first] === undefined || scene.timeline[last] === undefined
        ? null
        : Object.freeze({
            from: timeFromKey(scene.timeline[first]!, options.timeDomain!),
            to: timeFromKey(scene.timeline[last]!, options.timeDomain!),
          });
    },
    setVisibleTimeRange(range: TimeRange, mutation: ChartMutationMeta = {}) {
      assert();
      const validated = mutationOptions(mutation);
      if (
        !range ||
        typeof range !== 'object' ||
        Array.isArray(range) ||
        Object.keys(range).some((key) => key !== 'from' && key !== 'to')
      )
        failure('INVALID_RANGE', 'Invalid time range');
      const fromKey = timeKey(range.from, options.timeDomain!),
        toKey = timeKey(range.to, options.timeDomain!);
      if (fromKey > toKey) failure('INVALID_RANGE', 'Range must be ordered');
      let first = lowerBound(scene.timeline, fromKey),
        last = lowerBound(scene.timeline, toKey);
      if (scene.timeline[last] !== toKey) last--;
      if (first >= scene.timeline.length || last < first) return null;
      if (first === last) {
        if (last + 1 < scene.timeline.length) last++;
        else if (first > 0) first--;
      }
      changeRange({ from: first, to: Math.max(first + 1, last) }, 'api', validated.origin);
      return Object.freeze({
        from: timeFromKey(scene.timeline[first]!, options.timeDomain!),
        to: timeFromKey(scene.timeline[last]!, options.timeDomain!),
      });
    },
    setCrosshairTime(time: ChartTime | null, cursorOptions: CrosshairTimeOptions = {}) {
      assert();
      const validated = mutationOptions(cursorOptions, true),
        match = validated.match ?? 'exact';
      const key = time === null ? null : timeKey(time, options.timeDomain!);
      const resolved = key === null ? null : resolveControlled(key, match);
      if (
        key === null
          ? !controlled && !pointer
          : controlled?.key === key && controlled.match === match && controlled.origin === validated.origin
      )
        return resolved === null ? null : timeFromKey(scene.timeline[resolved]!, options.timeDomain!);
      cleanupInput.clearCursor();
      pointer = null;
      controlled = key === null ? null : { key, match, origin: validated.origin };
      crosshairMeta = nextMeta('api', validated.origin);
      crosshairDirty = true;
      queue(false);
      return resolved === null ? null : timeFromKey(scene.timeline[resolved]!, options.timeDomain!);
    },
    getPaneLayout() {
      assert();
      return committedPaneLayout();
    },
    applyPaneLayout(patch: ChartPaneLayoutPatch, meta: ChartMutationMeta = {}) {
      assert();
      const validatedMeta = mutationOptions(meta);
      const candidate = mergePaneLayout(committedPaneLayout(), patch);
      commitPaneLayout(candidate, 'api', validatedMeta.origin);
    },
    resizePane(paneId: string, deltaCssPixels: number, meta: ChartMutationMeta = {}) {
      assert();
      const validatedMeta = mutationOptions(meta);
      const { before, candidate } = paneResizeCandidate(paneId, deltaCssPixels);
      if (!samePaneLayout(candidate, before)) commitPaneLayout(candidate, 'api', validatedMeta.origin);
    },
    canResizePane(paneId: string, deltaCssPixels: number) {
      assert();
      const { before, candidate } = paneResizeCandidate(paneId, deltaCssPixels);
      return !samePaneLayout(candidate, before);
    },
    subscribePaneLayoutChange(callback) {
      return subscribe(paneLayoutListeners, callback);
    },
    addPane,
    removePane,
    addSeries,
    removeSeries,
    applyOptions(patch) {
      assert();
      const next = chartOptions(options, patch);
      if (next.timeDomain !== options.timeDomain)
        failure('IMMUTABLE_TIME_DOMAIN', 'Time domain is immutable');
      paneControls?.cancel();
      options = next;
      if (!options.diagnostics) {
        diagnostics.lastRenderMs = 0;
        diagnostics.lastIngestMs = 0;
      }
      scene.options = options;
      scene.theme = resolveTheme(options);
      root.setAttribute(
        'aria-label',
        options.ariaLabel ??
          'Financial chart. Arrow keys pan, plus and minus zoom, Home fits content, End returns to latest.',
      );
      observe();
      resize();
      queue();
    },
    fitContent() {
      assert();
      changeRange({ from: 0, to: Math.max(1, scene.timeline.length - 1) });
    },
    getVisibleRange() {
      assert();
      return { ...scene.range };
    },
    setVisibleRange(range) {
      assert();
      changeRange(range);
    },
    scrollToLatest() {
      assert();
      const span = scene.range.to - scene.range.from;
      changeRange({
        from: Math.max(0, scene.timeline.length - 1 - span),
        to: Math.max(1, scene.timeline.length - 1),
      });
    },
    timeToCoordinate(time: ChartTime) {
      assert();
      ensureLayout();
      const key = timeKey(time, options.timeDomain!);
      const i = lowerBound(scene.timeline, key);
      if (!hasPlot() || scene.timeline[i] !== key || i < scene.range.from || i > scene.range.to) return null;
      const x = logicalX(scene, i);
      return x >= 0 && x <= scene.plotWidth ? x : null;
    },
    coordinateToTime(x) {
      assert();
      ensureLayout();
      if (!Number.isFinite(x) || !hasPlot() || x < 0 || x > scene.plotWidth) return null;
      const i = Math.round(xLogical(scene, x));
      const key = scene.timeline[i];
      return key === undefined ? null : timeFromKey(key, options.timeDomain!);
    },
    priceToCoordinate(price, paneId = 'price') {
      assert();
      ensureLayout();
      const pane = scene.panes.find((p) => p.id === paneId);
      if (
        !hasPlot() ||
        !pane?.scale ||
        !Number.isFinite(price) ||
        (pane.options.scale === 'log' && price <= 0)
      )
        return null;
      const y = pane.scale.priceToY(price);
      return Number.isFinite(y) && y >= pane.top && y <= pane.top + pane.height ? y : null;
    },
    coordinateToPrice(y, paneId = 'price') {
      assert();
      ensureLayout();
      const pane = scene.panes.find((p) => p.id === paneId);
      if (!hasPlot() || !pane?.scale || !Number.isFinite(y) || y < pane.top || y > pane.top + pane.height)
        return null;
      const value = pane.scale.yToPrice(y);
      return Number.isFinite(value) ? value : null;
    },
    subscribeCrosshairMove(callback) {
      return subscribe(crosshairListeners, callback);
    },
    subscribeVisibleRangeChange(callback) {
      return subscribe(rangeListeners, callback);
    },
    attachPrimitive(primitive: ChartPrimitive) {
      assert();
      if (
        !primitive ||
        typeof primitive !== 'object' ||
        typeof primitive.draw !== 'function' ||
        (primitive.attach !== undefined && typeof primitive.attach !== 'function')
      )
        failure('INVALID_PRIMITIVE', 'Primitive draw and attach callbacks must be functions');
      if (primitives.has(primitive)) failure('DUPLICATE_PRIMITIVE', 'Primitive is already attached');
      ensureAnnotationCanvas();
      const entry: PrimitiveEntry = { primitive, active: true, cleanup: undefined };
      primitives.set(primitive, entry);
      diagnostics.primitiveCount = primitives.size;
      const host: PrimitiveHost = Object.freeze({
        root,
        invalidate() {
          if (entry.active && !dead) requestPrimitivePaint();
        },
        getProjection() {
          if (dead) failure('DESTROYED', 'Chart has been destroyed');
          if (!entry.active) failure('DETACHED', 'Primitive has been detached');
          return projection();
        },
      });
      try {
        const cleanup = primitive.attach?.(host);
        if (cleanup !== undefined && typeof cleanup !== 'function')
          failure('INVALID_PRIMITIVE', 'Primitive cleanup must be a function');
        entry.cleanup = cleanup ?? undefined;
      } catch (error) {
        entry.active = false;
        primitives.delete(primitive);
        diagnostics.primitiveCount = primitives.size;
        if (!primitives.size) releaseAnnotationCanvas();
        throw error;
      }
      if (!entry.active || dead) {
        const cleanup = entry.cleanup;
        entry.cleanup = undefined;
        if (cleanup) invoke(cleanup);
        return () => {};
      }
      requestPrimitivePaint();
      return () => detachEntry(entry);
    },
    async exportImage(exportOptions) {
      assert();
      const watermark = exportWatermark(exportOptions, options.attribution !== false);
      await api.whenIdle();
      assert();
      if (!primitives.size && !watermark)
        return new Promise<Blob>((resolve, reject) =>
          sceneCanvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new ChartError('EXPORT_FAILED', 'PNG export failed'))),
            'image/png',
          ),
        );
      const canvas = doc.createElement('canvas');
      canvas.width = sceneCanvas.width;
      canvas.height = sceneCanvas.height;
      const context = canvas.getContext('2d');
      if (!context) failure('CANVAS_UNAVAILABLE', 'Canvas 2D is unavailable');
      context.drawImage(sceneCanvas, 0, 0);
      context.setTransform(scene.dpr, 0, 0, scene.dpr, 0, 0);
      paintPrimitives(context, 'export');
      if (watermark) drawWatermark(context, scene);
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new ChartError('EXPORT_FAILED', 'PNG export failed'))),
          'image/png',
        ),
      );
    },
    getDiagnostics() {
      assert();
      return Object.freeze({ ...diagnostics });
    },
    whenIdle() {
      if (dead || !frame) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.add(resolve));
    },
    destroy() {
      if (dead) return;
      dead = true;
      const owner = chartOwners.get(api);
      if (owner) owner.active = false;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      diagnostics.framePending = false;
      observer?.disconnect();
      observer = null;
      media?.removeEventListener('change', dprChange);
      media = null;
      win.removeEventListener('resize', resize);
      cleanupInput();
      paneControls?.destroy();
      attribution?.destroy();
      for (const entry of [...primitives.values()]) detachEntry(entry);
      wrapper.remove();
      for (const series of scene.series) {
        series.store = new SeriesStore(series.type, options.timeDomain);
        series.runs = [];
      }
      scene.series = [];
      scene.panes = [];
      scene.timeline = [];
      pointer = null;
      controlled = null;
      crosshair = null;
      rangeListeners.clear();
      crosshairListeners.clear();
      paneLayoutListeners.clear();
      for (const resolve of waiters) resolve();
      waiters.clear();
      sceneCanvas.width = sceneCanvas.height = overlayCanvas.width = overlayCanvas.height = 0;
      releaseAnnotationCanvas();
    },
  };
  ownedPriceVolumeOperations.set(api, (priceHandle, volumeHandle, bars) => {
    // The source candidate is fresh and unexposed for this synchronous call;
    // these checks do not certify arbitrary externally mutable stores.
    assert();
    const priceEntry = ownedStudyHandles.get(priceHandle);
    if (!priceEntry || priceEntry.owner !== api)
      failure('INVALID_SERIES', 'Price handle does not belong to chart');
    const priceSeries = priceEntry.series;
    if (priceSeries.type !== 'candlestick') failure('INVALID_DATA', 'Owned price source must be candlestick');
    if (seriesById(priceSeries.id) !== priceSeries) failure('REMOVED', 'Series has been removed');
    const priceStart = options.diagnostics ? performance.now() : 0;
    const priceCandidate = new SeriesStore('candlestick', options.timeDomain);
    priceCandidate.setData(bars);
    const priceRevision = priceCandidate.revision;
    publishCandidate(priceSeries, priceCandidate, priceStart);

    // Destination lookup deliberately follows the successful price publication.
    assert();
    if (
      seriesById(priceSeries.id) !== priceSeries ||
      priceSeries.store !== priceCandidate ||
      priceCandidate.revision !== priceRevision
    )
      failure('INVALID_SERIES', 'Owned price source changed during volume derivation');
    const volumeEntry = ownedStudyHandles.get(volumeHandle);
    if (!volumeEntry || volumeEntry.owner !== api)
      failure('INVALID_SERIES', 'Volume handle does not belong to chart');
    const volumeSeries = volumeEntry.series;
    if (volumeSeries.type !== 'histogram')
      failure('INVALID_DATA', 'Owned volume destination must be histogram');
    if (seriesById(volumeSeries.id) !== volumeSeries) failure('REMOVED', 'Series has been removed');
    const volumeStart = options.diagnostics ? performance.now() : 0;
    const volumeCandidate = createOwnedVolumeStoreFromPrice(priceCandidate);
    assert();
    if (
      seriesById(priceSeries.id) !== priceSeries ||
      priceSeries.store !== priceCandidate ||
      priceCandidate.revision !== priceRevision
    )
      failure('INVALID_SERIES', 'Owned price source changed during volume derivation');
    if (seriesById(volumeSeries.id) !== volumeSeries) failure('REMOVED', 'Series has been removed');
    publishCandidate(volumeSeries, volumeCandidate, volumeStart);
  });
  try {
    observe();
    win.addEventListener('resize', resize);
    dprChange();
    attribution = createAttribution(wrapper, scene);
    queue();
  } catch (error) {
    api.destroy();
    throw error;
  }
  chartOwners.set(api, { active: true, utc: options.timeDomain === 'utc-ms' });
  return Object.freeze(api);
}
