import { describe, expect, it } from 'vitest';
import { layoutLegend, type LegendItem, type LegendGeometry } from './legend-layout';

const measure = (text: string) => Array.from(text).length * 7;
const geometry: LegendGeometry = { plotWidth: 248, paneTop: 10, paneHeight: 180, fontSize: 12, maxRows: 2 };

function checkBounds(items: readonly LegendItem[], area: LegendGeometry) {
  const result = layoutLegend(items, area, measure);
  for (const entry of result.entries) {
    expect(entry.x).toBeGreaterThanOrEqual(12);
    expect(entry.x + entry.width).toBeLessThanOrEqual(area.plotWidth - 12);
    expect(entry.y).toBeGreaterThanOrEqual(area.paneTop + 6);
    expect(entry.y + entry.height).toBeLessThanOrEqual(area.paneTop + area.paneHeight - 6);
    for (const other of result.entries) {
      if (other === entry || other.y !== entry.y) continue;
      expect(entry.x + entry.width <= other.x || other.x + other.width <= entry.x).toBe(true);
    }
  }
  expect(result.entries.filter((item) => item.id !== null).length + result.hiddenCount).toBe(
    items.filter((item) => item.text.trim()).length,
  );
  return result;
}

describe('measured legend layout', () => {
  it('packs titles in order and reserves a truthful final overflow marker', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      text: 'Overlay ' + i,
      color: '#88aaff',
    }));
    const result = checkBounds(items, geometry);
    expect(result.hiddenCount).toBeGreaterThan(0);
    expect(result.entries.filter((entry) => entry.id !== null).map((entry) => entry.id)).toEqual(
      items.slice(0, 12 - result.hiddenCount).map((item) => item.id),
    );
    expect(result.entries.at(-1)?.text).toBe('+' + result.hiddenCount);
  });

  it('shortens one Unicode title without splitting surrogate pairs or inventing omitted series', () => {
    const result = checkBounds([{ id: 'emoji', text: '📈'.repeat(40), color: '#fff' }], geometry);
    expect(result.hiddenCount).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.text).toMatch(/^📈+…$/u);
  });

  it('recalculates overflow width across 9/10 and 99/100 hidden title boundaries', () => {
    const cases: Array<[number, number]> = [
      [10, 9],
      [11, 10],
      [100, 99],
      [101, 100],
    ];
    for (const [count, omitted] of cases) {
      const items = Array.from({ length: count }, (_, i) => ({
        id: String(i),
        text: 'Title',
        color: '#fff',
      }));
      const result = checkBounds(items, { ...geometry, plotWidth: 107, maxRows: 1 });
      expect(result.hiddenCount).toBe(omitted);
      expect(result.entries.at(-1)?.text).toBe('+' + omitted);
    }
  });

  it('suppresses titles when width or pane height cannot fit a meaningful token, and recovers', () => {
    const items = [{ id: 'a', text: 'Price', color: '#fff' }];
    for (const area of [
      { ...geometry, plotWidth: 20 },
      { ...geometry, paneHeight: 0 },
      { ...geometry, paneHeight: 27 },
      { ...geometry, fontSize: 40, paneHeight: 50 },
    ])
      expect(layoutLegend(items, area, measure).entries).toHaveLength(0);
    expect(checkBounds(items, geometry).entries).toHaveLength(1);
  });
});
