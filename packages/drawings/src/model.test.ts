import { describe, expect, it, vi } from 'vitest';
import { ChartError } from '@filtrix.net/core';
import { createDrawingStore, measureDrawing } from './model';
import type { Drawing, DrawingDocumentV1 } from './types';

const point = (time: number | string, price = 10) => ({ time, price });

describe('drawing store', () => {
  it('preserves omitted style fields in partial updates and records one undoable change', () => {
    const store = createDrawingStore({ maxHistory: 4 });
    const changed = vi.fn();
    store.subscribe(changed);
    store.add({
      id: 'styled',
      type: 'horizontal-line',
      points: [point(1_000)],
      style: { color: '#abcdef', lineWidth: 4, fillOpacity: 0.7 },
    });
    changed.mockClear();

    store.update('styled', { style: { color: '#112233' } });
    expect(store.get('styled')!.style).toEqual({ color: '#112233', lineWidth: 4, fillOpacity: 0.7 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.undo()).toBe(true);
    expect(store.get('styled')!.style).toEqual({ color: '#abcdef', lineWidth: 4, fillOpacity: 0.7 });
    expect(store.redo()).toBe(true);
    expect(store.get('styled')!.style).toEqual({ color: '#112233', lineWidth: 4, fillOpacity: 0.7 });

    changed.mockClear();
    store.update('styled', { style: { color: '#112233' } });
    expect(changed).not.toHaveBeenCalled();
    expect(store.undo()).toBe(true);
    expect(store.get('styled')!.style.color).toBe('#abcdef');
  });
  it('copies inputs and outputs so caller mutation cannot alter state', () => {
    const input = { id: 'line', type: 'trend-line' as const, points: [point(1_000), point(2_000, 12)] };
    const store = createDrawingStore();
    store.add(input);
    input.points[0]!.price = 99;
    const output = store.get('line')!;
    output.points[0]!.price = 88;
    expect(store.get('line')!.points[0]!.price).toBe(10);
    expect(store.list()).not.toBe(store.list());
  });

  it('keeps optional undefined add IDs compatible with existing callers', () => {
    const store = createDrawingStore();
    expect(store.add({ id: undefined, type: 'horizontal-line', points: [point(1_000)] })).toBe('drawing-1');
  });

  it('validates atomically and isolates listener failures', () => {
    const store = createDrawingStore();
    const listener = vi.fn(() => {
      throw new Error('observer');
    });
    const healthy = vi.fn();
    store.subscribe(listener);
    store.subscribe(healthy);
    expect(() => store.add({ id: 'ok', type: 'horizontal-line', points: [point(1_000)] })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(() => store.add({ id: 'bad', type: 'trend-line', points: [point(2_000)] })).toThrow(ChartError);
    expect(store.list()).toHaveLength(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('supports bounded divergent undo and redo, including history zero', () => {
    const store = createDrawingStore({ maxHistory: 1 });
    store.add({ id: 'a', type: 'horizontal-line', points: [point(1_000)] });
    store.add({ id: 'b', type: 'horizontal-line', points: [point(2_000)] });
    expect(store.undo()).toBe(true);
    expect(store.get('a')).not.toBeNull();
    expect(store.get('b')).toBeNull();
    store.add({ id: 'c', type: 'horizontal-line', points: [point(3_000)] });
    expect(store.redo()).toBe(false);

    const noHistory = createDrawingStore({ maxHistory: 0 });
    noHistory.add({ id: 'x', type: 'horizontal-line', points: [point(1_000)] });
    expect(noHistory.undo()).toBe(false);
    expect(noHistory.get('x')).not.toBeNull();
  });

  it('restores a complete owned document atomically and rejects malformed candidates', () => {
    const store = createDrawingStore({ timeDomain: 'business-date' });
    store.add({ id: 'before', type: 'horizontal-line', points: [point('2024-01-02')] });
    const doc: DrawingDocumentV1 = {
      schema: 'filtix-drawings',
      version: 1,
      timeDomain: 'business-date',
      drawings: [
        {
          id: 'after',
          type: 'horizontal-line',
          paneId: 'price',
          points: [point('2024-01-03')],
          style: { color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 },
        },
      ],
    };
    store.restore(doc);
    doc.drawings[0]!.points[0]!.price = 200;
    expect(store.get('after')!.points[0]!.price).toBe(10);
    expect(() =>
      store.restore({
        ...doc,
        drawings: [{ ...doc.drawings[0]!, id: 'bad!', style: { ...doc.drawings[0]!.style, extra: 1 } }],
      }),
    ).toThrow(ChartError);
    expect(store.get('after')).not.toBeNull();
    expect(store.get('before')).toBeNull();
  });

  it('keeps no-op mutations out of history and enforces drawing capacity atomically', () => {
    const store = createDrawingStore({ maxDrawings: 1, maxHistory: 2 });
    const changed = vi.fn();
    store.subscribe(changed);
    store.add({ id: 'one', type: 'horizontal-line', points: [point(1_000)] });
    changed.mockClear();
    store.update('one', {});
    store.clear();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.undo()).toBe(true);
    expect(store.get('one')).not.toBeNull();
    expect(() => store.add({ id: 'two', type: 'horizontal-line', points: [point(2_000)] })).toThrow(
      ChartError,
    );
    expect(store.get('one')).not.toBeNull();
  });

  it('keeps generated IDs safe across restored IDs', () => {
    const store = createDrawingStore();
    store.restore({
      schema: 'filtix-drawings',
      version: 1,
      timeDomain: 'utc-ms',
      drawings: [
        {
          id: 'drawing-1',
          type: 'horizontal-line',
          paneId: 'price',
          points: [point(1_000)],
          style: { color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 },
        },
      ],
    });
    expect(store.add({ type: 'horizontal-line', points: [point(2_000)] })).toBe('drawing-2');
  });
  it('validates both time domains and measurement edge arithmetic', () => {
    const business = createDrawingStore({ timeDomain: 'business-date' });
    expect(() => business.add({ type: 'horizontal-line', points: [point(1_000)] })).toThrow(ChartError);
    const drawing: Drawing = {
      id: 'm',
      type: 'measure',
      locked: false,
      visible: true,
      paneId: 'price',
      points: [point('2024-01-01', 2), point('2024-01-03', 3)],
      style: { color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 },
    };
    expect(measureDrawing(drawing, 'business-date')).toEqual({
      priceChange: 1,
      percentChange: 50,
      elapsedMs: 2 * 86_400_000,
    });
    expect(
      measureDrawing(
        { ...drawing, points: [point('2024-01-31', 2), point('2024-02-02', 3)] },
        'business-date',
      )!.elapsedMs,
    ).toBe(2 * 86_400_000);
    expect(
      measureDrawing(
        { ...drawing, points: [point('2024-01-01', 0), point('2024-01-03', 3)] },
        'business-date',
      )!.percentChange,
    ).toBeNull();
    expect(
      measureDrawing(
        {
          ...drawing,
          points: [point('2024-01-01', Number.MAX_VALUE), point('2024-01-03', -Number.MAX_VALUE)],
        },
        'business-date',
      )!.priceChange,
    ).toBeNull();
    expect(
      measureDrawing({ ...drawing, type: 'horizontal-line', points: [drawing.points[0]!] }, 'business-date'),
    ).toBeNull();
  });
});

describe('v2 drawing fields', () => {
  it('uses defaults and records one undo entry per explicit new-field update', () => {
    const store = createDrawingStore();
    const id = store.add({ type: 'fibonacci-retracement', points: [point(0, 100), point(1, 200)] });
    const before = store.toJSON();
    expect(store.get(id)).toMatchObject({
      locked: false,
      visible: true,
      levels: [
        { ratio: 0 },
        { ratio: 0.236 },
        { ratio: 0.382 },
        { ratio: 0.5 },
        { ratio: 0.618 },
        { ratio: 0.786 },
        { ratio: 1 },
      ],
    });
    store.update(id, {
      style: { color: '#123456' },
      locked: true,
      visible: false,
      levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }],
    });
    expect(store.get(id)).toMatchObject({
      locked: true,
      visible: false,
      levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }],
    });
    expect(store.undo()).toBe(true);
    expect(store.toJSON()).toEqual(before);
    expect(store.redo()).toBe(true);
    const changed = vi.fn();
    store.subscribe(changed);
    store.update(id, {
      locked: true,
      visible: false,
      levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }],
    });
    expect(changed).not.toHaveBeenCalled();
    expect(() => store.update(id, { levels: [{ ratio: 0 }, { ratio: 0 }] })).toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it('defaults note text and font, then preserves normalized text through undo and redo', () => {
    const store = createDrawingStore();
    const id = store.add({ type: 'text-note', points: [point(1)] });
    expect(store.get(id)).toMatchObject({ text: 'Note', fontSize: 12 });
    store.update(id, { text: 'first\r\nsecond', fontSize: 18 });
    expect(store.get(id)).toMatchObject({ text: 'first\nsecond', fontSize: 18 });
    expect(store.undo()).toBe(true);
    expect(store.get(id)).toMatchObject({ text: 'Note', fontSize: 12 });
    expect(store.redo()).toBe(true);
    expect(() => store.update(id, { fontSize: 49 })).toThrow();
    expect(store.get(id)).toMatchObject({ text: 'first\nsecond', fontSize: 18 });
  });

  it('rejects null style patches atomically and keeps inherited Fibonacci overrides absent', () => {
    const store = createDrawingStore();
    const id = store.add({
      type: 'fibonacci-retracement',
      points: [point(1), point(2)],
      levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }],
    });
    const before = store.toJSON();
    expect(() =>
      store.update(id, { style: null } as unknown as Parameters<typeof store.update>[1]),
    ).toThrow();
    expect(store.toJSON()).toEqual(before);
    store.update(id, { style: { color: '#123456' } });
    expect(store.get(id)).toMatchObject({
      style: { color: '#123456' },
      levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }],
    });
    expect(
      Object.keys((store.get(id) as Extract<Drawing, { type: 'fibonacci-retracement' }>).levels[0]!),
    ).toEqual(['ratio']);
  });

  it('rejects sparse add, update, and restore arrays without changing snapshot, history, or observers', () => {
    const store = createDrawingStore();
    const id = store.add({ type: 'fibonacci-retracement', points: [point(1), point(2)] });
    store.update(id, { style: { color: '#123456' } });
    expect(store.undo()).toBe(true);
    const before = store.toJSON();
    const history = store.getHistoryState();
    const changed = vi.fn();
    store.subscribe(changed);

    const sparseChannelPoints = new Array<ReturnType<typeof point>>(3);
    const sparseFibPoints = new Array<ReturnType<typeof point>>(2);
    sparseFibPoints[0] = point(1);
    const sparseLevels = new Array<{ ratio: number }>(2);
    sparseLevels[0] = { ratio: 0 };
    const sparseDrawings = new Array<unknown>(2);
    sparseDrawings[0] = before.drawings[0];
    const invalidOperations = [
      () => store.add({ type: 'parallel-channel', points: sparseChannelPoints }),
      () => store.update(id, { points: sparseFibPoints }),
      () => store.update(id, { levels: sparseLevels }),
      () => store.restore({ ...before, drawings: sparseDrawings }),
      () => store.restore({ ...before, drawings: [{ ...before.drawings[0], levels: sparseLevels }] }),
      () => store.restore({ ...before, drawings: [{ ...before.drawings[0], points: sparseFibPoints }] }),
    ];
    for (const operation of invalidOperations) {
      expect(operation).toThrow();
      expect(store.toJSON()).toEqual(before);
      expect(store.getHistoryState()).toEqual(history);
      expect(changed).not.toHaveBeenCalled();
    }
    expect(store.redo()).toBe(true);
    expect(store.get(id)!.style.color).toBe('#123456');
    expect(store.undo()).toBe(true);
    expect(store.toJSON()).toEqual(before);
  });
});

describe('bounded generated drawing identity', () => {
  const input = { type: 'horizontal-line' as const, points: [point(1_000)] };
  it('advances canonical IDs past accepted values without rewinding on undo or eviction', () => {
    const store = createDrawingStore({ maxDrawings: 2, maxHistory: 1 });
    store.add({ ...input, id: 'drawing-20' });
    store.remove('drawing-20');
    store.undo();
    store.redo();
    expect(store.add(input)).toBe('drawing-21');
    store.clear();
    expect(store.add(input)).toBe('drawing-22');
  });
  it('keeps exact integer successors above Number precision and fails finite namespace exhaustion atomically', () => {
    const store = createDrawingStore();
    store.add({ ...input, id: 'drawing-9007199254740993' });
    expect(store.add(input)).toBe('drawing-9007199254740994');
    const exhausted = createDrawingStore();
    exhausted.add({ ...input, id: 'drawing-' + '9'.repeat(72) });
    const before = exhausted.toJSON();
    const changed = vi.fn();
    exhausted.subscribe(changed);
    expect(() => exhausted.add(input)).toThrow(expect.objectContaining({ code: 'DRAWING_ID_EXHAUSTED' }));
    expect(exhausted.toJSON()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    expect(exhausted.add({ ...input, id: 'custom' })).toBe('custom');
  });
  it('does not advance for noncanonical lookalikes or invalid atomic candidates', () => {
    const store = createDrawingStore();
    for (const id of ['drawing-01', 'drawing-0', 'drawing--1', 'custom']) store.add({ ...input, id });
    expect(() => store.add({ ...input, id: 'drawing-999999999', points: [] })).toThrow();
    const doc = store.toJSON();
    expect(() =>
      store.restore({
        ...doc,
        drawings: [
          { ...doc.drawings[0], id: 'drawing-888888888' },
          { ...doc.drawings[0], id: 'invalid!' },
        ],
      }),
    ).toThrow();
    expect(store.add(input)).toBe('drawing-1');
  });
  it('advances restored identifiers before reentrant observers generate more drawings', () => {
    const store = createDrawingStore();
    let reentered = false;
    let generated = '';
    const template = createDrawingStore();
    template.add({ ...input, id: 'drawing-72' });
    store.subscribe(() => {
      if (!reentered) {
        reentered = true;
        generated = store.add(input);
      }
    });
    store.restore(template.toJSON());
    expect(generated).toBe('drawing-73');
    expect(new Set(store.list().map((d) => d.id)).size).toBe(2);
  });
  it('keeps generated identities unique through thousands of bounded-history create/remove cycles', () => {
    for (const maxHistory of [0, 1]) {
      const store = createDrawingStore({ maxDrawings: 1, maxHistory });
      let last = '';
      for (let i = 1; i <= 3000; i++) {
        last = store.add(input);
        expect(last).toBe('drawing-' + i);
        store.remove(last);
      }
      expect(store.list()).toEqual([]);
      expect(store.undo()).toBe(maxHistory === 1);
    }
  });
});
