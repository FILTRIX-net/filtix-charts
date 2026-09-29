import { ChartError } from '@filtix/core';
import type { ChartApi, ChartPrimitive, PrimitiveHost, PrimitiveProjection } from '@filtix/charts';
import { createDrawingStore } from './model';
import {
  hitTest,
  insidePane,
  projectDrawing,
  translateDrawing,
  type PixelPoint,
  type TextMeasurer,
} from './geometry';
import { paintDrawing } from './render';
import { rankSnapCandidate } from './snap';
import { DEFAULT_FIBONACCI_LEVELS, requiredAnchorCount } from './spec';
import type {
  Drawing,
  DrawingType,
  DrawingLayer,
  DrawingLayerOptions,
  DrawingLayerState,
  DrawingPoint,
  DrawingStore,
  DrawingStyle,
  DrawingTool,
  DrawingSnapCandidate,
} from './types';

const tools: readonly DrawingTool[] = [
  'select',
  'trend-line',
  'horizontal-line',
  'rectangle',
  'measure',
  'fibonacci-retracement',
  'parallel-channel',
  'text-note',
];
function stylePatch(base: DrawingStyle, patch: Partial<DrawingStyle>): DrawingStyle {
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((k) => !['color', 'lineWidth', 'fillOpacity'].includes(k))
  )
    throw new ChartError('INVALID_STYLE', 'Unknown drawing style');
  const result = { ...base, ...patch };
  if (
    typeof result.color !== 'string' ||
    !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(result.color) ||
    !Number.isFinite(result.lineWidth) ||
    result.lineWidth < 0.5 ||
    result.lineWidth > 8 ||
    !Number.isFinite(result.fillOpacity) ||
    result.fillOpacity < 0 ||
    result.fillOpacity > 1
  )
    throw new ChartError('INVALID_STYLE', 'Invalid drawing style');
  return result;
}
function distinct(points: readonly DrawingPoint[]): boolean {
  return points.length === 1 || points[0]!.time !== points[1]!.time || points[0]!.price !== points[1]!.price;
}
export function createDrawingLayer(chart: ChartApi, options: DrawingLayerOptions = {}): DrawingLayer {
  const paneId = options.paneId ?? 'price';
  if (typeof paneId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(paneId))
    throw new ChartError('INVALID_PANE', 'Invalid drawing pane ID');
  if (options.onState !== undefined && typeof options.onState !== 'function')
    throw new ChartError('INVALID_CALLBACK', 'onState must be a function');
  let style = stylePatch({ color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 }, options.style ?? {});
  if (options.snapProvider !== undefined && typeof options.snapProvider !== 'function')
    throw new ChartError('INVALID_SNAP_PROVIDER', 'snapProvider must be a function');
  const snapDistance = options.snapDistance ?? 10;
  if (!Number.isFinite(snapDistance) || snapDistance < 1 || snapDistance > 40)
    throw new ChartError('INVALID_SNAP_DISTANCE', 'snapDistance must be from 1 to 40');
  if (options.magnet !== undefined && typeof options.magnet !== 'boolean')
    throw new ChartError('INVALID_MAGNET', 'magnet must be a boolean');
  let magnet = options.magnet ?? false;
  let store!: DrawingStore, host!: PrimitiveHost;
  let tool: DrawingTool = 'select',
    selectedId: string | null = null,
    destroyed = false;
  let drawings: readonly Drawing[] = [],
    detach: (() => void) | undefined,
    unsubscribe: (() => void) | undefined;
  let history = { canUndo: false, canRedo: false };
  const removers: Array<() => void> = [],
    claimed = new Set<number>(),
    navigation = new Set<number>();
  let owner: number | null = null;
  let pending: { drawing: Drawing; projection: PrimitiveProjection; fixed: DrawingPoint[] } | null = null;
  let textContext: CanvasRenderingContext2D | null = null;
  let storeGeneration = 0;
  let drag: {
    source: Drawing;
    preview: Drawing;
    projection: PrimitiveProjection;
    handle: number | null;
    start: PixelPoint;
    locked: boolean;
  } | null = null;
  let revision = 0;
  function assertAlive() {
    if (destroyed) throw new ChartError('DESTROYED', 'Drawing layer is destroyed');
  }
  function getState(): DrawingLayerState {
    return { tool, selectedId, drawingCount: drawings.length, magnet, ...history };
  }
  function notify() {
    if (!destroyed) {
      try {
        options.onState?.(getState());
      } catch {}
    }
  }
  function invalidate() {
    if (!destroyed) host.invalidate();
  }
  function release(id: number) {
    claimed.delete(id);
    try {
      if (host.root.hasPointerCapture(id)) host.root.releasePointerCapture(id);
    } catch {}
  }
  function cancel() {
    revision++;
    pending = null;
    drag = null;
    owner = null;
    for (const id of claimed) release(id);
    invalidate();
  }
  function blur() {
    navigation.clear();
    cancel();
  }
  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    cancel();
    navigation.clear();
    for (const remove of removers.splice(0)) remove();
    unsubscribe?.();
    unsubscribe = undefined;
  }
  function claim(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function position(event: PointerEvent): PixelPoint {
    const rect = host.root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function divider(projection: PrimitiveProjection, point: PixelPoint): boolean {
    return (
      point.x >= 0 &&
      point.x <= projection.plotWidth &&
      projection.panes.some(
        (pane, i) => i < projection.panes.length - 1 && Math.abs(point.y - (pane.bottom + 2.5)) <= 5,
      )
    );
  }
  function measureText(): TextMeasurer | undefined {
    if (!textContext) return undefined;
    return (line, font) => {
      const ctx = textContext!;
      ctx.save();
      try {
        ctx.font = font;
        return ctx.measureText(line).width;
      } finally {
        ctx.restore();
      }
    };
  }
  function drawingPoint(
    projection: PrimitiveProjection,
    point: PixelPoint,
    id: string,
    provenance?: DrawingPoint,
  ): DrawingPoint | null {
    const pane = projection.panes.find((entry) => entry.id === id);
    if (!pane || !insidePane(pane, point.x, point.y)) return null;
    const time = provenance?.time ?? projection.xToTime(point.x);
    const price = projection.yToPrice(point.y, id);
    if (time === null || price === null || !Number.isFinite(price) || (pane.scale === 'log' && price <= 0))
      return null;
    const raw: DrawingPoint = { time, price };
    if (!magnet || !options.snapProvider) return raw;
    const generation = storeGeneration,
      version = revision;
    let candidates: readonly DrawingSnapCandidate[];
    try {
      candidates = options.snapProvider({ paneId: id, point: raw });
    } catch {
      return destroyed || generation !== storeGeneration || version !== revision ? null : raw;
    }
    if (destroyed || generation !== storeGeneration || version !== revision) return null;
    if (!Array.isArray(candidates)) return raw;
    const nearest = rankSnapCandidate(candidates, point, snapDistance, (candidate) => {
      const x = projection.timeToX(candidate.time);
      const y = projection.priceToY(candidate.price, id);
      return x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
    });
    return nearest ? { time: provenance?.time ?? nearest.time, price: nearest.price } : raw;
  }
  function previewPoints(
    type: DrawingType,
    fixed: readonly DrawingPoint[],
    last: DrawingPoint,
  ): DrawingPoint[] {
    return [...fixed, ...Array.from({ length: requiredAnchorCount(type) - fixed.length }, () => last)];
  }
  function makePreview(type: DrawingType, first: DrawingPoint): Drawing {
    const base = {
      id: 'preview',
      paneId,
      locked: false,
      visible: true,
      style,
      points: previewPoints(type, [], first),
    };
    if (type === 'fibonacci-retracement') return { ...base, type, levels: DEFAULT_FIBONACCI_LEVELS };
    if (type === 'text-note') return { ...base, type, text: 'Note', fontSize: 12 };
    if (type === 'parallel-channel') return { ...base, type };
    return { ...base, type };
  }
  function validAnchors(
    type: DrawingType,
    points: readonly DrawingPoint[],
    projection: PrimitiveProjection,
    drawingPaneId: string,
  ): boolean {
    if (points.length >= 2 && !distinct(points)) return false;
    if (type !== 'parallel-channel' || points.length < 3) return true;
    const [a, b, c] = points.map((point) => ({
      x: projection.timeToX(point.time),
      y: projection.priceToY(point.price, drawingPaneId),
    }));
    if (a!.x === null || a!.y === null || b!.x === null || b!.y === null || c!.x === null || c!.y === null)
      return false;
    const dx = b!.x - a!.x,
      dy = b!.y - a!.y;
    const length = Math.hypot(dx, dy);
    return length > 0 && Math.abs((c!.x - a!.x) * dy - (c!.y - a!.y) * dx) / length >= 2;
  }
  function updatePreview(point: PixelPoint) {
    if (drag) {
      if (drag.locked) return;
      const active = drag;
      let next: Drawing | null;
      if (active.handle === null)
        next = translateDrawing(
          active.source,
          active.projection,
          point.x - active.start.x,
          point.y - active.start.y,
        );
      else {
        const value = drawingPoint(
          active.projection,
          point,
          active.source.paneId,
          active.source.type === 'horizontal-line' ? active.source.points[0] : undefined,
        );
        if (drag !== active || destroyed) return;
        const points = active.source.points.map((p, i) => (i === active.handle && value ? value : p));
        next =
          value && validAnchors(active.source.type, points, active.projection, active.source.paneId)
            ? { ...active.source, points }
            : null;
      }
      if (next && drag === active) {
        active.preview = next;
        invalidate();
      }
    } else if (pending && pending.fixed.length > 0) {
      const active = pending;
      const value = drawingPoint(active.projection, point, paneId);
      if (value && pending === active) {
        active.drawing = {
          ...active.drawing,
          points: previewPoints(active.drawing.type, active.fixed, value),
        };
        invalidate();
      }
    }
  }
  function down(event: PointerEvent) {
    if (destroyed || event.button !== 0) return;
    if (owner !== null || claimed.size) {
      claimed.add(event.pointerId);
      claim(event);
      try {
        host.root.setPointerCapture(event.pointerId);
      } catch {}
      return;
    }
    if (navigation.size) {
      navigation.add(event.pointerId);
      return;
    }
    const projection = pending?.projection ?? host.getProjection(),
      point = position(event);
    if (point.x < 0 || point.x > projection.plotWidth || point.y < 0 || point.y > projection.plotHeight)
      return;
    if (divider(projection, point)) {
      navigation.add(event.pointerId);
      return;
    }
    if (tool !== 'select') {
      const pane = projection.panes.find((entry) => entry.id === paneId);
      if (!pane || !insidePane(pane, point.x, point.y)) {
        navigation.add(event.pointerId);
        return;
      }
      const value = drawingPoint(projection, point, paneId);
      if (!value || destroyed) {
        navigation.add(event.pointerId);
        return;
      }
      if (!pending) pending = { projection, fixed: [], drawing: makePreview(tool, value) };
    } else {
      const hit = hitTest(drawings, projection, point.x, point.y, measureText());
      if (!hit) {
        navigation.add(event.pointerId);
        return;
      }
      const source = drawings.find((drawing) => drawing.id === hit.id)!;
      drag = { source, preview: source, projection, handle: hit.handle, start: point, locked: source.locked };
      selectedId = hit.id;
    }
    claim(event);
    owner = event.pointerId;
    claimed.add(event.pointerId);
    try {
      host.root.setPointerCapture(event.pointerId);
    } catch {}
    host.root.focus({ preventScroll: true });
    invalidate();
    notify();
  }
  function move(event: PointerEvent) {
    if (destroyed) return;
    if (claimed.has(event.pointerId)) {
      claim(event);
      if (owner === event.pointerId) updatePreview(position(event));
    } else if (pending?.fixed.length && !navigation.size) updatePreview(position(event));
  }
  function up(event: PointerEvent) {
    navigation.delete(event.pointerId);
    if (destroyed || !claimed.has(event.pointerId)) return;
    claim(event);
    if (owner !== event.pointerId) {
      release(event.pointerId);
      return;
    }
    const point = position(event);
    updatePreview(point);
    owner = null;
    release(event.pointerId);
    if (drag) {
      const complete = drag;
      drag = null;
      if (!complete.locked) store.update(complete.source.id, { points: complete.preview.points });
      invalidate();
    } else if (pending) {
      const active = pending;
      const value = drawingPoint(active.projection, point, paneId);
      if (!value || pending !== active || destroyed) return;
      const fixed = [...active.fixed, value];
      if (!validAnchors(active.drawing.type, fixed, active.projection, paneId)) return;
      active.fixed = fixed;
      active.drawing = { ...active.drawing, points: previewPoints(active.drawing.type, fixed, value) };
      if (fixed.length < requiredAnchorCount(active.drawing.type)) {
        invalidate();
        return;
      }
      const complete = active.drawing,
        version = revision;
      pending = null;
      const input = {
        type: complete.type,
        paneId,
        points: complete.points,
        style,
        ...(complete.type === 'fibonacci-retracement' ? { levels: complete.levels } : {}),
        ...(complete.type === 'text-note' ? { text: complete.text, fontSize: complete.fontSize } : {}),
      };
      const id = store.add(input);
      if (destroyed || revision !== version) return;
      tool = 'select';
      selectedId = id;
      invalidate();
      notify();
    }
  }
  function canceled(event: PointerEvent) {
    navigation.delete(event.pointerId);
    if (claimed.has(event.pointerId)) {
      claim(event);
      cancel();
    }
  }
  function key(event: KeyboardEvent) {
    if (destroyed || host.root.ownerDocument.activeElement !== host.root) return;
    const modifier = event.ctrlKey || event.metaKey;
    const lower = event.key.toLowerCase();
    if (event.key === 'Escape' && (pending || drag || tool !== 'select')) {
      claim(event);
      cancel();
      tool = 'select';
      notify();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
      claim(event);
      const id = selectedId;
      cancel();
      store.remove(id);
    } else if (modifier && (lower === 'z' || lower === 'y')) {
      const redo = lower === 'y' || event.shiftKey;
      if (redo ? history.canRedo : history.canUndo) {
        claim(event);
        cancel();
        if (redo) store.redo();
        else store.undo();
      }
    }
  }
  const primitive: ChartPrimitive = {
    attach(value) {
      host = value;
      const domain = host.getProjection().timeDomain;
      if (options.store && options.store.timeDomain !== domain)
        throw new ChartError('INVALID_TIME_DOMAIN', 'Drawing store domain must match chart');
      store = options.store ?? createDrawingStore({ timeDomain: domain });
      try {
        drawings = store.list();
        history = store.getHistoryState();
        unsubscribe = store.subscribe(() => {
          if (destroyed) return;
          drawings = store.list();
          history = store.getHistoryState();
          if (selectedId && !drawings.some((d) => d.id === selectedId)) selectedId = null;
          storeGeneration++;
          if (drag || pending) cancel();
          invalidate();
          notify();
        });
        const root = host.root;
        function on<K extends keyof HTMLElementEventMap>(
          name: K,
          callback: (e: HTMLElementEventMap[K]) => void,
        ) {
          root.addEventListener(name, callback, true);
          removers.push(() => root.removeEventListener(name, callback, true));
        }
        on('pointerdown', down);
        on('pointermove', move);
        on('pointerup', up);
        on('pointercancel', canceled);
        on('lostpointercapture', canceled);
        on('keydown', key);
        on('blur', blur);
        // A frozen gesture projection must keep the same viewport until it finishes.
        const wheel = (event: WheelEvent) => {
          if (!destroyed && (drag || pending)) claim(event);
        };
        root.addEventListener('wheel', wheel, { capture: true, passive: false });
        removers.push(() => root.removeEventListener('wheel', wheel, true));
        const win = root.ownerDocument.defaultView!;
        win.addEventListener('blur', blur);
        removers.push(() => win.removeEventListener('blur', blur));
      } catch (error) {
        cleanup();
        throw error;
      }
      return cleanup;
    },
    draw(ctx, projection, mode) {
      if (destroyed) return;
      textContext = ctx;
      for (const drawing of drawings)
        paintDrawing(
          ctx,
          mode === 'screen' && drag?.source.id === drawing.id ? drag.preview : drawing,
          projection,
          mode === 'screen' && selectedId === drawing.id,
        );
      if (mode === 'screen' && pending) paintDrawing(ctx, pending.drawing, projection, false);
    },
  };
  try {
    detach = chart.attachPrimitive(primitive);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    store,
    setTool(value) {
      assertAlive();
      if (!tools.includes(value)) throw new ChartError('INVALID_TOOL', 'Unknown drawing tool');
      cancel();
      tool = value;
      host.root.focus({ preventScroll: true });
      notify();
    },
    select(id) {
      assertAlive();
      if (id !== null && !drawings.some((d) => d.id === id))
        throw new ChartError('UNKNOWN_DRAWING', 'Unknown drawing ID');
      cancel();
      selectedId = id;
      tool = 'select';
      notify();
    },
    setStyle(value) {
      assertAlive();
      style = stylePatch(style, value);
      if (pending) pending.drawing = { ...pending.drawing, style };
      invalidate();
    },
    setMagnet(enabled) {
      assertAlive();
      if (typeof enabled !== 'boolean') throw new ChartError('INVALID_MAGNET', 'magnet must be a boolean');
      if (magnet === enabled) return;
      magnet = enabled;
      notify();
    },
    getState,
    destroy() {
      if (destroyed) return;
      cleanup();
      detach?.();
      detach = undefined;
    },
  };
}
