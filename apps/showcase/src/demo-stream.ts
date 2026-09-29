import type { CandlePoint } from '@filtix/core';
import { aggregateCandles, makeCandles } from './fixtures';

/** Demo-only producer: reveal a seeded fixture candle over eight price updates. */
export function createDemoStream(lastBar: CandlePoint, hours: number, seed: number): () => CandlePoint {
  let current = { ...lastBar };
  let target = { ...lastBar };
  let phase = 8;
  let state = seed >>> 0;
  return () => {
    if (phase === 8) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      // Generate at most 24 hourly bars, never copy or regenerate the loaded history.
      target = aggregateCandles(
        makeCandles(hours, {
          seed: state,
          price: current.close,
          start: Number(current.time) + hours * 3_600_000,
        }),
        hours,
      )[0]!;
      current = {
        time: target.time,
        open: target.open,
        high: target.open,
        low: target.open,
        close: target.open,
        volume: 0,
      };
      phase = 0;
    }
    phase++;
    // Visit both extrema before closing. This is a synthetic path, not market data.
    const first = target.close >= target.open ? target.low : target.high;
    const second = target.close >= target.open ? target.high : target.low;
    const close =
      phase === 2
        ? first
        : phase === 5
          ? second
          : phase === 8
            ? target.close
            : phase < 2
              ? target.open + ((first - target.open) * phase) / 2
              : phase < 5
                ? first + ((second - first) * (phase - 2)) / 3
                : second + ((target.close - second) * (phase - 5)) / 3;
    current = {
      ...current,
      high: Math.max(current.high, close),
      low: Math.min(current.low, close),
      close,
      volume: Math.round(((target.volume ?? 0) * phase) / 8),
    };
    return { ...current };
  };
}
