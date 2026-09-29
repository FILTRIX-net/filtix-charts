import type { PriceAlertCondition } from './types';

export function crossed(
  previous: number,
  current: number,
  threshold: number,
  condition: PriceAlertCondition,
): boolean {
  const up = previous < threshold && current >= threshold;
  const down = previous > threshold && current <= threshold;
  return condition === 'crosses-up' ? up : condition === 'crosses-down' ? down : up || down;
}
