import type { PrimitiveProjection } from '@filtrix.net/charts';
import { measureDrawing } from './model';
import { projectDrawing, type PixelPoint, type TextMeasurer } from './geometry';
import type { Drawing } from './types';

function segment(ctx: CanvasRenderingContext2D, a: PixelPoint, b: PixelPoint): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}
export function paintDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  projection: PrimitiveProjection,
  selected: boolean,
): void {
  ctx.save();
  try {
    const measure: TextMeasurer = (line, font) => {
      ctx.font = font;
      return ctx.measureText(line).width;
    };
    const geometry = projectDrawing(drawing, projection, measure);
    if (!geometry) return;
    const { pane, points, handles } = geometry;
    const a = points[0]!,
      b = points[1];
    ctx.beginPath();
    ctx.rect(pane.left, pane.top, pane.right - pane.left, pane.bottom - pane.top);
    ctx.clip();
    ctx.strokeStyle = drawing.style.color;
    ctx.fillStyle = drawing.style.color;
    ctx.lineWidth = drawing.style.lineWidth;
    ctx.setLineDash([]);
    if (drawing.type === 'rectangle' || drawing.type === 'measure') {
      if (!b) return;
      const x = Math.min(a.x, b.x),
        y = Math.min(a.y, b.y);
      const width = Math.abs(b.x - a.x),
        height = Math.abs(b.y - a.y);
      ctx.globalAlpha = drawing.style.fillOpacity;
      ctx.fillRect(x, y, width, height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(x, y, width, height);
      if (drawing.type === 'measure') {
        const result = measureDrawing(drawing, projection.timeDomain)!;
        const number = (value: number | null) =>
          value === null ? 'n/a' : Number(value.toPrecision(5)).toString();
        const label =
          number(result.priceChange) +
          ' (' +
          number(result.percentChange) +
          '%) · ' +
          number(result.elapsedMs / 86400000) +
          'd';
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'top';
        const labelWidth = ctx.measureText(label).width + 12;
        const labelX = Math.max(pane.left, Math.min(pane.right - labelWidth, x));
        const labelY = Math.max(pane.top, Math.min(pane.bottom - 22, y));
        ctx.fillStyle = projection.theme.background;
        ctx.fillRect(labelX, labelY, labelWidth, 22);
        ctx.fillStyle = drawing.style.color;
        ctx.fillText(label, labelX + 6, labelY + 5);
      }
    } else if (drawing.type === 'fibonacci-retracement') {
      for (const level of geometry.levels ?? []) {
        ctx.strokeStyle = level.style.color;
        ctx.lineWidth = level.style.lineWidth;
        ctx.setLineDash(
          level.style.lineStyle === 'dashed' ? [6, 4] : level.style.lineStyle === 'dotted' ? [2, 3] : [],
        );
        segment(ctx, { x: level.x1, y: level.y }, { x: level.x2, y: level.y });
        const label =
          Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(level.price.toPrecision(6));
        ctx.font = '11px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = level.style.color;
        const width = ctx.measureText(label).width;
        const labelX = Math.max(
          pane.left + 4,
          Math.min(pane.right - width - 4, Math.max(level.x1, level.x2) - width),
        );
        const labelY = Math.max(pane.top, Math.min(pane.bottom - 11, level.y - 13));
        if (pane.right - pane.left > 8 && pane.bottom - pane.top > 11)
          ctx.fillText(label, labelX, labelY, pane.right - pane.left - 8);
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = drawing.style.color;
      ctx.lineWidth = drawing.style.lineWidth;
    } else if (drawing.type === 'parallel-channel') {
      if (!b) return;
      const c = points[2]!,
        d = points[3]!;
      ctx.globalAlpha = drawing.style.fillOpacity;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(d.x, d.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      segment(ctx, a, b);
      segment(ctx, c, d);
      segment(ctx, a, c);
      segment(ctx, b, d);
    } else if (drawing.type === 'text-note') {
      const rect = geometry.rect!;
      ctx.globalAlpha = drawing.style.fillOpacity;
      ctx.fillStyle = projection.theme.background;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.globalAlpha = 1;
      ctx.fillStyle = drawing.style.color;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.font = geometry.font!;
      ctx.textBaseline = 'top';
      for (let i = 0; i < geometry.lines!.length; i++)
        ctx.fillText(geometry.lines![i]!, rect.x + 6, rect.y + 6 + i * geometry.lineHeight!);
    } else if (b) segment(ctx, a, b);
    if (selected && !drawing.locked) {
      ctx.strokeStyle = drawing.style.color;
      for (const point of handles) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = projection.theme.background;
        ctx.fill();
        ctx.stroke();
      }
    }
  } finally {
    ctx.restore();
  }
}
