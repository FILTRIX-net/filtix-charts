import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@filtrix.net/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@filtrix.net/core')>();
  return { ...core, lowerBound: vi.fn(core.lowerBound) };
});

import { lowerBound, SeriesStore, timeKey, type SeriesPoint, type SeriesType } from '@filtrix.net/core';
import { layout } from './layout';
import { drawScene } from './renderer';
import { buildRuns } from './timeline';
import { darkTheme } from './themes';
import type { Scene, SeriesState } from './types';

type Domain = 'utc-ms' | 'business-date';

function makeScene(kind: 'dense' | 'sparse' | 'business', lineCount = 4): Scene {
  const domain: Domain = kind === 'business' ? 'business-date' : 'utc-ms';
  const times: Array<number | string> =
    kind === 'business'
      ? Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10))
      : kind === 'sparse'
        ? Array.from({ length: 72 }, (_, i) => i * 3 + (i % 5 === 0 ? 1 : 0))
        : Array.from({ length: 128 }, (_, i) => i);
  const timeline = times.map((time) => timeKey(time, domain));
  const series: SeriesState[] = [];
  const add = (type: SeriesType, id: string, paneId: string, subset: (i: number) => boolean) => {
    const store = new SeriesStore(type, domain);
    const points: SeriesPoint[] = times.flatMap((time, i) => {
      if (!subset(i)) return [];
      if (i % 19 === 7) return [{ time }];
      const value = 90 + i * 0.08 + Math.sin(i / 4) * 4;
      if (type === 'band') return [{ time, lower: value - 2, upper: value + 3 }];
      if (type === 'candlestick' || type === 'ohlc')
        return [{ time, open: value, high: value + 2, low: value - 1.5, close: value + (i % 2 ? -0.5 : 1) }];
      return [{ time, value: type === 'histogram' ? Math.sin(i / 3) * 5 : value }];
    });
    store.setData(points);
    series.push({
      id,
      type,
      paneId,
      options: {},
      store,
      runs: buildRuns(store, timeline),
    });
  };
  add('band', 'fill', 'price', () => true);
  for (let i = 0; i < lineCount; i++)
    add('line', `line-${i}`, 'price', (index) => kind !== 'sparse' || index % (i + 2) !== 0);
  add('area', 'area', 'price', (index) => kind !== 'sparse' || index % 5 !== 0);
  add('candlestick', 'candles', 'price', (index) => kind !== 'sparse' || index % 4 !== 0);
  add('ohlc', 'ohlc', 'price', (index) => kind !== 'sparse' || index % 6 !== 0);
  add('histogram', 'volume', 'volume', (index) => kind !== 'sparse' || index % 3 !== 0);
  const scene: Scene = {
    width: 360,
    height: 320,
    plotWidth: 0,
    plotHeight: 0,
    dpr: 1,
    theme: { ...darkTheme },
    options: { timeDomain: domain },
    timeline,
    range: { from: 0, to: timeline.length - 1 },
    panes: [
      {
        id: 'price',
        top: 0,
        height: 0,
        scale: null,
        options: { weight: 0.7, minHeight: 48, scale: 'linear' },
      },
      {
        id: 'volume',
        top: 0,
        height: 0,
        scale: null,
        options: { weight: 0.3, minHeight: 48, scale: 'linear' },
      },
    ],
    series,
  };
  layout(scene);
  return scene;
}

function recordedCanvas(onCall?: (name: string, ordinal: number) => void) {
  const commands: unknown[][] = [];
  let ordinal = 0;
  const context = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 6.25 });
      return (...args: unknown[]) => {
        commands.push([prop, ...args]);
        onCall?.(prop, ++ordinal);
      };
    },
    set(target, prop, value) {
      commands.push(['set', String(prop), value]);
      return Reflect.set(target, prop, value);
    },
  }) as unknown as CanvasRenderingContext2D;
  return { context, commands };
}

function paint(scene: Scene, onCall?: (name: string, ordinal: number) => void) {
  const { context, commands } = recordedCanvas(onCall);
  const count = drawScene(context, scene);
  const hash = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
  return { count, hash, commands };
}

describe('render-local exact timeline lookup', () => {
  it('shares visible time-key searches across multi-output series', () => {
    const scene = makeScene('dense', 8);
    vi.mocked(lowerBound).mockClear();
    const observed = paint(scene);
    expect(observed.count).toBeGreaterThan(0);
    expect(vi.mocked(lowerBound).mock.calls.length).toBeLessThan(scene.timeline.length * 1.5);
  });

  it.each([
    ['dense', '58abea224fb659a865771de7fe6c1e1008648842dce9d66eee83c61dbc902390'],
    ['sparse', 'fa319a69cde75a7a7e926ad8a29e7afec5e87df86684617e9bbae88918c9b07d'],
    ['business', 'b5cb68bc5d532baf2408f185bff71431b936bfebbba5fcd33978f0901f084f8b'],
  ] as const)('keeps exact canvas commands for %s gaps and panes', (kind, expectedHash) => {
    const scene = makeScene(kind);
    const observed = paint(scene);
    expect(observed.count).toBeGreaterThan(0);
    expect(observed.hash).toBe(expectedHash);
  });

  it('does not retain positions after timeline prepend, append, or same-length replacement', () => {
    const scene = makeScene('dense');
    const before = paint(scene);
    scene.timeline = [-1, ...scene.timeline, scene.timeline.at(-1)! + 1];
    scene.range = { from: 0, to: scene.timeline.length - 1 };
    layout(scene);
    const expanded = paint(scene);
    scene.timeline = scene.timeline.map((key, index) => (index === 50 ? key - 0.5 : key));
    layout(scene);
    const replaced = paint(scene);
    expect([before.hash, expanded.hash, replaced.hash]).toEqual([
      '58abea224fb659a865771de7fe6c1e1008648842dce9d66eee83c61dbc902390',
      'c1f4832c4a685b0670a1e07d484b95984b26fa5a3e00f243a514ed0dc0b52707',
      '2a3739f24802bb78147e44bf7ffa1a4796f0b35c515ef73a8cf186fca52d52e1',
    ]);
  });

  it('invalidates a shared lookup if canvas instrumentation replaces the timeline during draw', () => {
    const scene = makeScene('dense', 2);
    let strokes = 0;
    const observed = paint(scene, (name) => {
      if (name !== 'stroke' || ++strokes !== 2) return;
      scene.timeline = scene.timeline.map((key, index) => (index === 50 ? key - 0.5 : key));
    });
    expect(strokes).toBeGreaterThan(2);
    expect(observed.hash).toBe('fc58d2da240d1ee041b8e4d6df40155c469527191422a3ced8173ad472c78654');
  });

  it('preserves signed-zero time keys', () => {
    const scene = makeScene('dense');
    scene.timeline[0] = -0;
    layout(scene);
    expect(paint(scene).hash).toBe('58abea224fb659a865771de7fe6c1e1008648842dce9d66eee83c61dbc902390');
  });
});
