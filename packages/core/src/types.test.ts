import { describe, expect, it } from 'vitest';
import { ChartError, isChartError } from './types';

describe('isChartError', () => {
  it('recognizes the public error shape across bundle and serialization boundaries', () => {
    const error = new ChartError('INVALID_DATA', 'A finite value is required');
    expect(isChartError(error)).toBe(true);
    expect(isChartError({ name: error.name, code: error.code, message: error.message })).toBe(true);
    for (const value of [
      null,
      undefined,
      'failure',
      new Error('failure'),
      { name: 'ChartError', code: 1, message: 'bad' },
    ]) {
      expect(isChartError(value)).toBe(false);
    }
  });
});
