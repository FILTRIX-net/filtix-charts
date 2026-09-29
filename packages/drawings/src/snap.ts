import type { DrawingPoint, DrawingSnapCandidate } from './types';
import type { PixelPoint } from './geometry';

export function rankSnapCandidate(
  candidates: readonly DrawingSnapCandidate[],
  pointer: PixelPoint,
  distance: number,
  project: (point: DrawingPoint) => PixelPoint | null,
): DrawingSnapCandidate | null {
  if (
    !Number.isFinite(pointer.x) ||
    !Number.isFinite(pointer.y) ||
    !Number.isFinite(distance) ||
    distance < 0
  )
    return null;
  let best: DrawingSnapCandidate | null = null;
  let bestDistance = distance;
  for (const candidate of candidates) {
    if (
      !candidate ||
      !['open', 'high', 'low', 'close'].includes(candidate.field) ||
      !Number.isFinite(candidate.price) ||
      !(typeof candidate.time === 'string' || Number.isSafeInteger(candidate.time))
    )
      continue;
    let pixel: PixelPoint | null;
    try {
      pixel = project(candidate);
    } catch {
      continue;
    }
    if (!pixel || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y)) continue;
    const current = Math.hypot(pixel.x - pointer.x, pixel.y - pointer.y);
    if (current <= bestDistance && (best === null || current < bestDistance)) {
      best = candidate;
      bestDistance = current;
    }
  }
  return best;
}
