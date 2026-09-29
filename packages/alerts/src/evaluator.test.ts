import { describe, expect, test } from 'vitest';
import { crossed } from './evaluator';
import type { PriceAlertCondition } from './types';

describe('crossed', () => {
  test.each<readonly [number, number, number, PriceAlertCondition, boolean]>([
    [-1, 0, 0, 'crosses-up', true],
    [-1, 1, 0, 'crosses-up', true],
    [0, 1, 0, 'crosses-up', false],
    [1, 0, 0, 'crosses-down', true],
    [1, -1, 0, 'crosses-down', true],
    [0, -1, 0, 'crosses-down', false],
    [-3, -2, -2, 'crosses-up', true],
    [-1, -2, -2, 'crosses-down', true],
    [2, 2, 2, 'crosses', false],
    [-1, 0, 0, 'crosses', true],
    [1, 0, 0, 'crosses', true],
    [0, 1, 0, 'crosses', false],
  ])('%s to %s at %s under %s is %s', (previous, current, level, condition, result) => {
    expect(crossed(previous, current, level, condition)).toBe(result);
  });
});
