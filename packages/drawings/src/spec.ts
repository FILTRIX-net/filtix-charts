import type { DrawingStyle, DrawingType, FibonacciLevel } from './types';

export const DEFAULT_DRAWING_STYLE: Readonly<DrawingStyle> = Object.freeze({
  color: '#c7ee92',
  lineWidth: 1.5,
  fillOpacity: 0.12,
});
export const DEFAULT_FIBONACCI_LEVELS: readonly FibonacciLevel[] = Object.freeze(
  [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => Object.freeze({ ratio })),
);
export function requiredAnchorCount(type: DrawingType): 1 | 2 | 3 {
  return type === 'horizontal-line' || type === 'text-note' ? 1 : type === 'parallel-channel' ? 3 : 2;
}
