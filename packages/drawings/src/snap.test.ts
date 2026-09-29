import { describe, expect, it } from 'vitest';
import { rankSnapCandidate } from './snap';
import type { DrawingPoint, DrawingSnapCandidate } from './types';

const candidate = (
  time: number,
  price: number,
  field: DrawingSnapCandidate['field'] = 'close',
): DrawingSnapCandidate => ({ time, price, field });

describe('snap ranking', () => {
  it('chooses closest projected candidate at the threshold with stable ties', () => {
    const candidates = [candidate(1, 1, 'open'), candidate(2, 2, 'high')];
    const projection = (point: DrawingPoint) => ({ x: Number(point.time) * 10, y: point.price * 10 });
    expect(rankSnapCandidate(candidates, { x: 15, y: 15 }, 8, projection)).toEqual(candidates[0]);
    expect(rankSnapCandidate(candidates, { x: 15, y: 15 }, 7, projection)).toBeNull();
  });
  it('ignores invalid and unprojectable candidates', () => {
    const projection = (point: DrawingPoint) => (Number.isFinite(point.price) ? { x: 0, y: 0 } : null);
    expect(rankSnapCandidate([candidate(1, NaN), candidate(1, 1)], { x: 0, y: 0 }, 10, projection)).toEqual(
      candidate(1, 1),
    );
  });
});

describe('invalid provider coordinates', () => {
  it('skips a candidate rejected by projection and keeps a later valid one', () => {
    const invalid = { time: 'not-a-date', price: 1, field: 'open' as const };
    const valid = candidate(3, 2);
    const project = (point: DrawingPoint) => {
      if (point.time === invalid.time) throw new Error('invalid time');
      return { x: 0, y: 0 };
    };
    expect(rankSnapCandidate([invalid, valid], { x: 0, y: 0 }, 10, project)).toEqual(valid);
  });
});
