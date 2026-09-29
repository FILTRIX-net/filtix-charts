import type { CandlePoint, ValuePoint } from '@filtix/core';

export interface FixtureOptions {
  seed?: number;
  price?: number;
  start?: number;
  step?: number;
}
export function makeCandles(count: number, options: FixtureOptions = {}): CandlePoint[] {
  let state = options.seed ?? 73;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const start = options.start ?? Date.UTC(2026, 5, 1);
  const step = options.step ?? 3_600_000;
  let close = options.price ?? 62_400;
  const result: CandlePoint[] = [];
  for (let i = 0; i < count; i++) {
    const open = close;
    const move = (random() - 0.485) * 0.014 + Math.sin(i / 37) * 0.0007;
    close = Math.max(0.01, open * (1 + move));
    const wick = open * (0.0008 + random() * 0.005);
    result.push({
      time: start + i * step,
      open,
      high: Math.max(open, close) + wick * random(),
      low: Math.min(open, close) - wick * random(),
      close,
      volume: Math.round(40 + random() * 740 + Math.abs(move) * 90_000),
    });
  }
  return result;
}
export function aggregateCandles(source: readonly CandlePoint[], factor: number): CandlePoint[] {
  const output: CandlePoint[] = [];
  for (let i = 0; i < source.length; i += factor) {
    const group = source.slice(i, i + factor);
    const first = group[0]!,
      last = group[group.length - 1]!;
    output.push({
      time: first.time,
      open: first.open,
      high: Math.max(...group.map((p) => p.high)),
      low: Math.min(...group.map((p) => p.low)),
      close: last.close,
      volume: group.reduce((sum, p) => sum + (p.volume ?? 0), 0),
    });
  }
  return output;
}
export const closeValues = (points: readonly CandlePoint[]): ValuePoint[] =>
  points.map((p) => ({ time: p.time, value: p.close }));
export const symbols = [
  { id: 'BTC', pair: 'BTC / USD', name: 'Bitcoin', price: 62_400, seed: 73, color: '#f4a94e' },
  { id: 'ETH', pair: 'ETH / USD', name: 'Ethereum', price: 3_280, seed: 112, color: '#8b9de8' },
  { id: 'SOL', pair: 'SOL / USD', name: 'Solana', price: 145, seed: 38, color: '#9acfc7' },
  { id: 'AAPL', pair: 'AAPL / USD', name: 'Apple', price: 198, seed: 201, color: '#d9dde3' },
] as const;
