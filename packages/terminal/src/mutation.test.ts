import { describe, expect, test } from 'vitest';
import { reportUnlessMutationSuperseded, TerminalMutationSupersededError } from './mutation';

describe('terminal mutation fences', () => {
  test('does not publish a synchronous stale transaction as composition health', () => {
    const published: unknown[] = [];
    let caught: unknown;
    const report = (error: unknown) => published.push(error);
    const runFakeMutation = () => {
      throw new TerminalMutationSupersededError();
    };
    try {
      runFakeMutation();
    } catch (error) {
      caught = error;
      reportUnlessMutationSuperseded(error, report);
    }
    expect(String(caught)).toContain('Terminal mutation was superseded');
    expect(published).toEqual([]);

    const actualFailure = new Error('composition failed');
    reportUnlessMutationSuperseded(actualFailure, report);
    expect(published).toEqual([actualFailure]);
  });
});
