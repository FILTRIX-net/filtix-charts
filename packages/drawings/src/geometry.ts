import type { PrimitiveProjection } from '@filtrix.net/charts';
import type { Drawing, DrawingPoint, FibonacciLevel } from './types';

export interface PixelPoint {
  x: number;
  y: number;
}
export interface ProjectedLevel {
  ratio: number;
  price: number;
  x1: number;
  x2: number;
  y: number;
  style: { color: string; lineWidth: number; lineStyle: NonNullable<FibonacciLevel['lineStyle']> };
}
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ProjectedDrawing {
  pane: PrimitiveProjection['panes'][number];
  points: readonly PixelPoint[];
  handles: readonly PixelPoint[];
  levels?: readonly ProjectedLevel[];
  rect?: PixelRect;
  lines?: readonly string[];
  font?: string;
  lineHeight?: number;
}
export type TextMeasurer = (line: string, font: string) => number;
const finite = (value: number): boolean => Number.isFinite(value);
const pixel = (x: number | null, y: number | null): PixelPoint | null =>
  x !== null && y !== null && finite(x) && finite(y) ? { x, y } : null;

function interpolate(a: number, b: number, ratio: number, logarithmic: boolean): number | null {
  if (ratio === 0) return a;
  if (ratio === 1) return b;
  if (logarithmic) {
    if (a <= 0 || b <= 0) return null;
    const exponent = Math.log(a) * (1 - ratio) + Math.log(b) * ratio;
    const result = Math.exp(exponent);
    return finite(result) && result > 0 ? result : null;
  }
  if (a === b) return a;
  if (ratio > 0 && ratio < 1) {
    const weighted = a * (1 - ratio) + b * ratio;
    return finite(weighted) ? weighted : null;
  }
  const scale = Math.max(Math.abs(a), Math.abs(b));
  const normalized = (a / scale) * (1 - ratio) + (b / scale) * ratio;
  const result = normalized * scale;
  return finite(result) ? result : null;
}

export function projectDrawing(
  drawing: Drawing,
  projection: PrimitiveProjection,
  measureText?: TextMeasurer,
): ProjectedDrawing | null {
  if (!drawing.visible) return null;
  const pane = projection.panes.find((entry) => entry.id === drawing.paneId);
  if (!pane || pane.right <= pane.left || pane.bottom <= pane.top) return null;
  if (drawing.type === 'horizontal-line') {
    const y = projection.priceToY(drawing.points[0]!.price, drawing.paneId);
    if (y === null || !finite(y)) return null;
    return {
      pane,
      points: [
        { x: pane.left, y },
        { x: pane.right, y },
      ],
      handles: [{ x: pane.left / 2 + pane.right / 2, y }],
    };
  }
  const anchors: PixelPoint[] = [];
  for (const point of drawing.points) {
    const value = pixel(projection.timeToX(point.time), projection.priceToY(point.price, drawing.paneId));
    if (!value) return null;
    anchors.push(value);
  }
  if (drawing.type === 'parallel-channel') {
    const [a, b, c] = anchors as [PixelPoint, PixelPoint, PixelPoint];
    const fourth = pixel(b.x + c.x - a.x, b.y + c.y - a.y);
    return fourth ? { pane, points: [...anchors, fourth], handles: anchors } : null;
  }
  if (drawing.type === 'fibonacci-retracement') {
    const [a, b] = drawing.points as [DrawingPoint, DrawingPoint];
    const levels: ProjectedLevel[] = [];
    for (const level of drawing.levels) {
      const price = interpolate(a.price, b.price, level.ratio, pane.scale === 'log');
      if (price === null) continue;
      const y = projection.priceToY(price, drawing.paneId);
      if (y === null || !finite(y)) continue;
      levels.push({
        ratio: level.ratio,
        price,
        x1: anchors[0]!.x,
        x2: anchors[1]!.x,
        y,
        style: {
          color: level.color ?? drawing.style.color,
          lineWidth: level.lineWidth ?? drawing.style.lineWidth,
          lineStyle: level.lineStyle ?? 'solid',
        },
      });
    }
    return { pane, points: anchors, handles: anchors, levels };
  }
  if (drawing.type === 'text-note') {
    const lines = drawing.text.split('\n');
    const font = drawing.fontSize + 'px sans-serif';
    const widths = lines.map((line) => measureText?.(line, font) ?? line.length * drawing.fontSize * 0.6);
    if (widths.some((width) => !finite(width) || width < 0)) return null;
    const lineHeight = drawing.fontSize * 1.25;
    const width = Math.max(12, ...widths) + 12;
    const height = lines.length * lineHeight + 12;
    if (!finite(width) || !finite(height)) return null;
    return {
      pane,
      points: anchors,
      handles: anchors,
      rect: { x: anchors[0]!.x, y: anchors[0]!.y, width, height },
      lines,
      font,
      lineHeight,
    };
  }
  return { pane, points: anchors, handles: anchors };
}

export function translateDrawing(
  drawing: Drawing,
  projection: PrimitiveProjection,
  dx: number,
  dy: number,
): Drawing | null {
  if (!finite(dx) || !finite(dy) || !projectDrawing(drawing, projection)) return null;
  let delta = 0;
  if (drawing.type !== 'horizontal-line' && dx !== 0) {
    const t0 = projection.logicalIndexToTime(0),
      t1 = projection.logicalIndexToTime(1);
    if (t0 === null || t1 === null) return null;
    const x0 = projection.timeToX(t0),
      x1 = projection.timeToX(t1);
    if (x0 === null || x1 === null || x1 === x0 || !finite(x0) || !finite(x1)) return null;
    delta = Math.round(dx / (x1 - x0));
    if (!Number.isSafeInteger(delta)) return null;
  }
  const points: DrawingPoint[] = [];
  for (const point of drawing.points) {
    const index = drawing.type === 'horizontal-line' ? null : projection.timeToLogicalIndex(point.time);
    const time =
      drawing.type === 'horizontal-line'
        ? point.time
        : index === null || !Number.isSafeInteger(index + delta)
          ? null
          : projection.logicalIndexToTime(index + delta);
    const y = projection.priceToY(point.price, drawing.paneId);
    const price = dy === 0 ? point.price : y === null ? null : projection.yToPrice(y + dy, drawing.paneId);
    if (
      time === null ||
      price === null ||
      !finite(price) ||
      (projection.panes.find((pane) => pane.id === drawing.paneId)?.scale === 'log' && price <= 0)
    )
      return null;
    points.push({ time, price });
  }
  return { ...drawing, points };
}

export function insidePane(pane: ProjectedDrawing['pane'], x: number, y: number): boolean {
  return x >= pane.left && x <= pane.right && y >= pane.top && y <= pane.bottom;
}
function distance(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function insideChannel(point: PixelPoint, a: PixelPoint, b: PixelPoint, c: PixelPoint): boolean {
  const ux = b.x - a.x,
    uy = b.y - a.y,
    vx = c.x - a.x,
    vy = c.y - a.y;
  const determinant = ux * vy - uy * vx;
  if (!finite(determinant) || determinant === 0) return false;
  const px = point.x - a.x,
    py = point.y - a.y;
  const u = (px * vy - py * vx) / determinant;
  const v = (ux * py - uy * px) / determinant;
  return finite(u) && finite(v) && u >= 0 && u <= 1 && v >= 0 && v <= 1;
}
function contains(rect: PixelRect, x: number, y: number, tolerance: number): boolean {
  return (
    x >= rect.x - tolerance &&
    x <= rect.x + rect.width + tolerance &&
    y >= rect.y - tolerance &&
    y <= rect.y + rect.height + tolerance
  );
}
export function hitTest(
  drawings: readonly Drawing[],
  projection: PrimitiveProjection,
  x: number,
  y: number,
  measureText?: TextMeasurer,
): { id: string; handle: number | null } | null {
  const projected = drawings.map((drawing) => projectDrawing(drawing, projection, measureText));
  for (let i = drawings.length - 1; i >= 0; i--) {
    const geometry = projected[i],
      drawing = drawings[i]!;
    if (!geometry || drawing.locked || !insidePane(geometry.pane, x, y)) continue;
    for (let j = 0; j < geometry.handles.length; j++) {
      const h = geometry.handles[j]!;
      if (Math.hypot(x - h.x, y - h.y) <= 7) return { id: drawing.id, handle: j };
    }
  }
  for (let i = drawings.length - 1; i >= 0; i--) {
    const geometry = projected[i],
      drawing = drawings[i]!;
    if (!geometry || !insidePane(geometry.pane, x, y)) continue;
    const [a, b] = geometry.points;
    if (!a) continue;
    const tolerance = Math.max(6, drawing.style.lineWidth / 2 + 3);
    let hit = false;
    if (drawing.type === 'text-note') hit = !!geometry.rect && contains(geometry.rect, x, y, 0);
    else if (drawing.type === 'fibonacci-retracement')
      hit = !!geometry.levels?.some(
        (level) => distance({ x, y }, { x: level.x1, y: level.y }, { x: level.x2, y: level.y }) <= tolerance,
      );
    else if (drawing.type === 'parallel-channel') {
      const c = geometry.points[2]!,
        d = geometry.points[3]!;
      hit =
        !!b &&
        (distance({ x, y }, a, b) <= tolerance ||
          distance({ x, y }, c, d) <= tolerance ||
          distance({ x, y }, a, c) <= tolerance ||
          distance({ x, y }, b, d) <= tolerance ||
          insideChannel({ x, y }, a, b, c));
    } else if (drawing.type === 'rectangle' || drawing.type === 'measure')
      hit =
        !!b &&
        contains(
          {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
          },
          x,
          y,
          tolerance,
        );
    else hit = !!b && distance({ x, y }, a, b) <= tolerance;
    if (hit) return { id: drawing.id, handle: null };
  }
  return null;
}
