import { describe, expect, it } from 'vitest';
import { copyDrawingDocument, decodeDrawingDocument } from './codec';

const style = { color: '#123456', lineWidth: 2, fillOpacity: 0.2 };
const p = (time: number, price: number) => ({ time, price });
const base = { paneId: 'price', style, locked: false, visible: true };
const variants = [
  { id: 'trend', type: 'trend-line', points: [p(1, 10), p(2, 20)] },
  { id: 'horizontal', type: 'horizontal-line', points: [p(1, 10)] },
  { id: 'rectangle', type: 'rectangle', points: [p(1, 10), p(2, 20)] },
  { id: 'measure', type: 'measure', points: [p(1, 10), p(2, 20)] },
  {
    id: 'fib',
    type: 'fibonacci-retracement',
    points: [p(1, 10), p(2, 20)],
    levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef', lineWidth: 3, lineStyle: 'dashed' }],
  },
  { id: 'channel', type: 'parallel-channel', points: [p(1, 10), p(2, 20), p(3, 30)] },
  { id: 'note', type: 'text-note', points: [p(1, 10)], text: 'one\ntwo', fontSize: 14 },
].map((drawing) => ({ ...base, ...drawing }));
const doc = (drawings: unknown[], version = 2) => ({
  schema: 'filtix-drawings',
  version,
  timeDomain: 'utc-ms',
  drawings,
});

describe('drawing document codec', () => {
  it('migrates exact v1 without changing old fields and owns the result', () => {
    const old = { id: 'old', type: 'trend-line', paneId: 'price', points: [p(1, 10), p(2, 20)], style };
    const input = doc([old], 1);
    const result = decodeDrawingDocument(input);
    expect(result).toEqual(doc([{ ...old, locked: false, visible: true }]));
    old.points[0]!.price = 999;
    expect(result.drawings[0]!.points[0]!.price).toBe(10);
    expect(() => decodeDrawingDocument(doc([{ ...old, locked: false }], 1))).toThrow();
  });

  it('round trips all seven v2 variants with defensive nested ownership', () => {
    const result = decodeDrawingDocument(doc(variants));
    const copied = copyDrawingDocument(result);
    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(copied.drawings[4]).not.toBe(result.drawings[4]);
    expect(copied.drawings[4]!.points).not.toBe(result.drawings[4]!.points);
    expect(decodeDrawingDocument(copied)).toEqual(result);
    expect(result.drawings[4]).toMatchObject({ levels: [{ ratio: 0 }, { ratio: 1, color: '#abcdef' }] });
  });

  it('rejects malformed whole documents including type-specific extras and duplicate IDs', () => {
    const fib = variants[4]!;
    const note = variants[6]!;
    const bad: unknown[] = [
      [variants[0], variants[0]],
      [{ ...variants[0], levels: [{ ratio: 0 }] }],
      [{ ...fib, points: [p(1, 10)] }],
      [{ ...fib, levels: [] }],
      [{ ...fib, levels: [{ ratio: 0 }, { ratio: 0 }] }],
      [{ ...fib, levels: [{ ratio: -10.001 }] }],
      [{ ...fib, levels: [{ ratio: 0, color: undefined }] }],
      [{ ...note, text: ' '.repeat(3) }],
      [{ ...note, text: 'a'.repeat(2001) }],
      [{ ...note, text: Array(21).fill('a').join('\n') }],
      [{ ...note, fontSize: 7 }],
      [{ ...note, fontSize: Number.NaN }],
      [{ ...variants[0], locked: 0 }],
    ];
    for (const drawings of bad) expect(() => decodeDrawingDocument(doc(drawings as unknown[]))).toThrow();
    expect(() => decodeDrawingDocument(doc(variants, 2), { maxDrawings: 6 })).toThrow();
    expect(() => decodeDrawingDocument(doc(variants), { timeDomain: 'business-date' })).toThrow();
  });

  it('accepts a finite fractional note font size within the CSS pixel range', () => {
    expect(decodeDrawingDocument(doc([{ ...variants[6], fontSize: 12.5 }])).drawings[0]).toMatchObject({
      fontSize: 12.5,
    });
  });

  it('rejects holes in document drawings, anchors, and Fibonacci levels', () => {
    const sparseDrawings = new Array<unknown>(2);
    sparseDrawings[0] = variants[0];
    const sparseAnchors = new Array<unknown>(3);
    sparseAnchors[0] = p(1, 10);
    sparseAnchors[2] = p(3, 30);
    const sparseLevels = new Array<unknown>(2);
    sparseLevels[0] = { ratio: 1 };
    for (const malformed of [
      doc(sparseDrawings),
      doc([{ ...variants[5], points: sparseAnchors }]),
      doc([{ ...variants[4], levels: sparseLevels }]),
      doc(new Array<unknown>(1), 1),
    ])
      expect(() => decodeDrawingDocument(malformed)).toThrow();

    const dense = decodeDrawingDocument(
      doc([{ ...variants[4], levels: [{ ratio: 1, color: '#abcdef' }, { ratio: 0 }] }]),
    );
    expect(dense.drawings[0]).toMatchObject({ levels: [{ ratio: 1, color: '#abcdef' }, { ratio: 0 }] });
    const fib = dense.drawings[0];
    if (fib?.type !== 'fibonacci-retracement') throw new Error('Expected Fibonacci drawing');
    expect(Object.keys(fib.levels[1]!)).toEqual(['ratio']);
  });
});
