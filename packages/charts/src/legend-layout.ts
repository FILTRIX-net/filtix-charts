export interface LegendItem {
  id: string;
  text: string;
  color: string;
}

export interface LegendPlacement {
  id: string | null;
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegendGeometry {
  plotWidth: number;
  paneTop: number;
  paneHeight: number;
  fontSize: number;
  maxRows: number;
}

const horizontalPadding = 12;
const verticalPadding = 6;
const gap = 18;

export function layoutLegend(
  items: readonly LegendItem[],
  geometry: LegendGeometry,
  measure: (text: string) => number,
): { entries: LegendPlacement[]; hiddenCount: number } {
  const titles = items.filter((item) => item.text.trim().length > 0);
  const hidden = (entries: LegendPlacement[] = []) => ({
    entries,
    hiddenCount: titles.length - entries.filter((e) => e.id !== null).length,
  });
  const { plotWidth, paneTop, paneHeight, fontSize, maxRows } = geometry;
  const lineHeight = Math.max(16, fontSize + 4);
  const fullWidth = plotWidth - 2 * horizontalPadding;
  if (
    !Number.isFinite(plotWidth) ||
    !Number.isFinite(paneTop) ||
    !Number.isFinite(paneHeight) ||
    !Number.isFinite(fontSize) ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    paneHeight < lineHeight + 2 * verticalPadding ||
    fullWidth <= 0 ||
    titles.length === 0
  )
    return hidden();
  const physicalRows = Math.floor((paneHeight - 2 * verticalPadding) / lineHeight);
  const budgetRows = Math.max(1, Math.floor((paneHeight * 0.25 - 2 * verticalPadding) / lineHeight));
  const rows = Math.min(maxRows, physicalRows, budgetRows);
  if (rows < 1) return hidden();

  function shortened(text: string, limit: number): string | null {
    const width = measure(text);
    if (Number.isFinite(width) && width <= limit) return text;
    const codePoints = Array.from(text);
    let low = 1;
    let high = codePoints.length - 1;
    let best: string | null = null;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const candidate = codePoints.slice(0, mid).join('') + '…';
      const measured = measure(candidate);
      if (Number.isFinite(measured) && measured <= limit) {
        best = candidate;
        low = mid + 1;
      } else high = mid - 1;
    }
    return best;
  }

  function place(show: number): LegendPlacement[] | null {
    const entries: LegendPlacement[] = [];
    let row = 0;
    let x = horizontalPadding;
    const candidates: Array<{ id: string | null; text: string; color: string }> = titles.slice(0, show);
    if (show < titles.length)
      candidates.push({ id: null, text: `+${titles.length - show}`, color: titles[0]!.color });
    for (const candidate of candidates) {
      let text = candidate.text;
      let width = measure(text);
      if (!Number.isFinite(width) || width <= 0) return null;
      const end = plotWidth - horizontalPadding;
      if (x + width > end && x !== horizontalPadding) {
        row += 1;
        x = horizontalPadding;
      }
      if (row >= rows) return null;
      if (x + width > end) {
        if (candidate.id === null) return null;
        const truncated = shortened(text, fullWidth);
        if (!truncated) return null;
        text = truncated;
        width = measure(text);
      }
      if (x + width > end) return null;
      entries.push({
        id: candidate.id,
        text,
        color: candidate.color,
        x,
        y: paneTop + verticalPadding + row * lineHeight,
        width,
        height: lineHeight,
      });
      x += width + gap;
    }
    return entries;
  }

  for (let show = titles.length; show >= 0; show -= 1) {
    const entries = place(show);
    if (entries) return hidden(entries);
  }
  return hidden();
}
