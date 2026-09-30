import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CandlePoint } from '@filtrix.net/charts';
import type { HistoryReplay, HistoryReplayOptions, ReplayChange, ReplayState } from './types';
import { createHistoryReplay } from './replay';

const makeBars = (): CandlePoint[] => [
  { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 110 },
  { time: 3, open: 12, high: 14, low: 11, close: 13, volume: 120 },
];

function create(overrides: Partial<HistoryReplayOptions> = {}): {
  replay: HistoryReplay;
  changes: ReplayChange[];
  states: ReplayState[];
} {
  const changes: ReplayChange[] = [];
  const states: ReplayState[] = [];
  const replay = createHistoryReplay({
    bars: makeBars(),
    onChange: (change) => changes.push(change),
    onState: (state) => states.push(state),
    ...overrides,
  });
  return { replay, changes, states };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createHistoryReplay', () => {
  test('starts paused at position zero without notifying or scheduling', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onState = vi.fn();

    const replay = createHistoryReplay({ bars: makeBars(), onChange, onState });

    expect(replay.getState()).toEqual({
      status: 'paused',
      position: 0,
      total: 3,
      barsPerSecond: 4,
    });
    expect(Object.isFrozen(replay.getState())).toBe(true);
    expect(replay.getData()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('empty history starts ended and play remains a callback-free no-op', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onState = vi.fn();
    const replay = createHistoryReplay({ bars: [], onChange, onState });

    expect(replay.getState()).toEqual({
      status: 'ended',
      position: 0,
      total: 0,
      barsPerSecond: 4,
    });
    replay.play();

    expect(replay.getState().status).toBe('ended');
    expect(onChange).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    {
      name: 'non-array history',
      options: { bars: { length: 0 }, onChange: (): void => undefined },
    },
    {
      name: 'unknown time domain',
      options: { bars: [], timeDomain: 'local', onChange: (): void => undefined },
    },
    {
      name: 'missing OHLC fields',
      options: { bars: [{ time: 1 }], onChange: (): void => undefined },
    },
    {
      name: 'invalid OHLC relation',
      options: {
        bars: [{ time: 1, open: 10, high: 9, low: 8, close: 10 }],
        onChange: (): void => undefined,
      },
    },
    {
      name: 'duplicate times',
      options: {
        bars: [
          { time: 1, open: 10, high: 11, low: 9, close: 10 },
          { time: 1, open: 10, high: 11, low: 9, close: 10 },
        ],
        onChange: (): void => undefined,
      },
    },
    {
      name: 'missing change callback',
      options: { bars: [] },
    },
    {
      name: 'invalid state callback',
      options: { bars: [], onChange: (): void => undefined, onState: 1 },
    },
    {
      name: 'speed below range',
      options: { bars: [], barsPerSecond: 0.24, onChange: (): void => undefined },
    },
    {
      name: 'speed above range',
      options: { bars: [], barsPerSecond: 65, onChange: (): void => undefined },
    },
    {
      name: 'non-finite speed',
      options: { bars: [], barsPerSecond: Number.NaN, onChange: (): void => undefined },
    },
  ])('rejects $name atomically', ({ options }) => {
    expect(() => createHistoryReplay(options as unknown as HistoryReplayOptions)).toThrow();
  });

  test('accepts complete business-date bars and both speed boundaries', () => {
    const businessBars: CandlePoint[] = [
      { time: '2026-09-08', open: 1, high: 2, low: 1, close: 2 },
      { time: '2026-09-09', open: 2, high: 3, low: 2, close: 3 },
    ];

    const slow = createHistoryReplay({
      bars: businessBars,
      timeDomain: 'business-date',
      barsPerSecond: 0.25,
      onChange: (): void => undefined,
    });
    const fast = createHistoryReplay({
      bars: businessBars,
      timeDomain: 'business-date',
      barsPerSecond: 64,
      onChange: (): void => undefined,
    });

    expect(slow.getState().barsPerSecond).toBe(0.25);
    expect(fast.getState().barsPerSecond).toBe(64);
  });

  test('copies input and every revealed return value without exposing future bars', () => {
    const input = makeBars();
    const emitted: ReplayChange[] = [];
    const replay = createHistoryReplay({
      bars: input,
      onChange: (change) => emitted.push(change),
    });
    input[0]!.close = 999;
    input.push({ time: 4, open: 1, high: 1, low: 1, close: 1 });

    replay.step();
    expect(emitted[0]!.bars).toEqual([{ time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 }]);
    expect(replay.getData()).toHaveLength(1);

    (emitted[0]!.bars[0] as CandlePoint).close = 777;
    const firstRead = replay.getData() as CandlePoint[];
    firstRead[0]!.close = 555;
    firstRead.push({ time: 99, open: 1, high: 1, low: 1, close: 1 });

    expect(replay.getData()).toEqual([{ time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 }]);
    expect(replay.getState().total).toBe(3);
  });

  test('play reveals exactly one complete bar per timeout and ends without a timer', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const changes: ReplayChange[] = [];
    const replay = createHistoryReplay({
      bars: makeBars().slice(0, 2),
      onChange: (change) => {
        order.push(`change:${change.state.position}`);
        changes.push(change);
      },
      onState: (state) => order.push(`state:${state.position}:${state.status}`),
    });

    replay.play();
    expect(replay.getState().status).toBe('playing');
    expect(vi.getTimerCount()).toBe(1);
    order.length = 0;

    await vi.advanceTimersByTimeAsync(249);
    expect(changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'append',
      bars: [{ time: 1 }],
      state: { position: 1, status: 'playing' },
    });
    expect(order).toEqual(['change:1', 'state:1:playing']);
    expect(vi.getTimerCount()).toBe(1);

    order.length = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(changes[1]).toMatchObject({
      type: 'append',
      bars: [{ time: 2 }],
      state: { position: 2, status: 'ended' },
    });
    expect(order).toEqual(['change:2', 'state:2:ended']);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('pause cancels the active timer and play resumes from the same position', async () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();

    replay.play();
    await vi.advanceTimersByTimeAsync(100);
    replay.pause();
    expect(replay.getState()).toMatchObject({ status: 'paused', position: 0 });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(0);

    replay.play();
    await vi.advanceTimersByTimeAsync(250);
    expect(replay.getState()).toMatchObject({ status: 'playing', position: 1 });
    expect(states.map((state) => state.status)).toEqual(['playing', 'paused', 'playing', 'playing']);
  });

  test('step validates its count, pauses playback, and appends the requested batch once', () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();
    replay.play();
    changes.length = 0;
    states.length = 0;

    replay.step(2);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'append',
      bars: [{ time: 1 }, { time: 2 }],
      state: { status: 'paused', position: 2 },
    });
    expect(states).toEqual([changes[0]!.state]);
    expect(vi.getTimerCount()).toBe(0);

    replay.step();
    expect(replay.getState()).toMatchObject({ status: 'ended', position: 3 });
    changes.length = 0;
    states.length = 0;
    replay.step(10);
    expect(changes).toHaveLength(0);
    expect(states).toHaveLength(0);

    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => replay.step(count)).toThrow();
    }
  });

  test('seek always pauses and emits one reset with exactly the selected prefix', () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();

    replay.seek(2);
    expect(changes[0]).toMatchObject({
      type: 'reset',
      bars: [{ time: 1 }, { time: 2 }],
      state: { status: 'paused', position: 2 },
    });

    changes.length = 0;
    states.length = 0;
    replay.play();
    replay.seek(2);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'reset',
      bars: [{ time: 1 }, { time: 2 }],
      state: { status: 'paused', position: 2 },
    });
    expect(states.at(-1)).toEqual(changes[0]!.state);
    expect(vi.getTimerCount()).toBe(0);

    replay.seek(3);
    expect(replay.getState().status).toBe('ended');
    replay.seek(0);
    expect(replay.getState()).toMatchObject({ status: 'paused', position: 0 });
    expect(replay.getData()).toEqual([]);
  });

  test('invalid seek and speed requests leave an active timer unchanged', async () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();
    replay.play();
    await vi.advanceTimersByTimeAsync(100);
    const notifications = states.length;

    for (const position of [-1, 4, 1.5, Number.NaN]) {
      expect(() => replay.seek(position)).toThrow();
    }
    for (const speed of [0, 0.24, 65, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => replay.setSpeed(speed)).toThrow();
    }

    expect(replay.getState()).toMatchObject({
      status: 'playing',
      position: 0,
      barsPerSecond: 4,
    });
    expect(states).toHaveLength(notifications);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(149);
    expect(changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toHaveLength(1);
  });

  test('setSpeed reschedules one active timer from the call and updates paused state', async () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();
    replay.play();
    await vi.advanceTimersByTimeAsync(100);

    replay.setSpeed(8);
    expect(replay.getState().barsPerSecond).toBe(8);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(124);
    expect(changes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toHaveLength(1);

    replay.pause();
    replay.setSpeed(2);
    expect(replay.getState()).toMatchObject({ status: 'paused', barsPerSecond: 2 });
    expect(states.at(-1)).toEqual(replay.getState());
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a captured stale timer cannot reveal data after seek changes generation', () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const nativeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === 'function') callbacks.push(callback as () => void);
      return nativeSetTimeout(callback, delay);
    }) as typeof setTimeout);
    const { replay, changes, states } = create();

    replay.play();
    const staleTick = callbacks[0]!;
    replay.seek(0);
    changes.length = 0;
    states.length = 0;

    staleTick();

    expect(replay.getData()).toEqual([]);
    expect(replay.getState()).toMatchObject({ status: 'paused', position: 0 });
    expect(changes).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  test.each(['pause', 'destroy'] as const)(
    'a stale replaced timer cannot orphan the current timer before %s',
    (operation) => {
      vi.useFakeTimers();
      const callbacks: Array<() => void> = [];
      const nativeSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number) => {
        if (typeof callback === 'function') callbacks.push(callback as () => void);
        return nativeSetTimeout(callback, delay);
      }) as typeof setTimeout);
      const { replay, changes } = create();

      replay.play();
      const staleTick = callbacks[0]!;
      replay.setSpeed(8);
      expect(callbacks).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(1);

      staleTick();
      expect(changes).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);

      replay[operation]();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  test('a reentrant seek from onChange supersedes old state notification and scheduling', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let replay!: HistoryReplay;
    replay = createHistoryReplay({
      bars: makeBars(),
      onChange: (change) => {
        order.push(change.type);
        if (change.type === 'append') replay.seek(0);
      },
      onState: (state) => order.push(`state:${state.position}:${state.status}`),
    });

    replay.play();
    order.length = 0;
    await vi.advanceTimersByTimeAsync(250);

    expect(order).toEqual(['append', 'reset', 'state:0:paused']);
    expect(replay.getData()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('callback exceptions are isolated and later ticks remain usable', async () => {
    vi.useFakeTimers();
    const positions: number[] = [];
    const replay = createHistoryReplay({
      bars: makeBars().slice(0, 2),
      onChange: () => {
        throw new Error('consumer change failure');
      },
      onState: (state) => {
        positions.push(state.position);
        if (state.position > 0) throw new Error('consumer state failure');
      },
    });

    expect(() => replay.play()).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);

    expect(replay.getState()).toMatchObject({ status: 'ended', position: 2 });
    expect(positions).toEqual([0, 1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('reentrant destroy suppresses stale state notification and all later work', async () => {
    vi.useFakeTimers();
    const states: ReplayState[] = [];
    let replay!: HistoryReplay;
    replay = createHistoryReplay({
      bars: makeBars(),
      onChange: () => replay.destroy(),
      onState: (state) => states.push(state),
    });

    replay.play();
    states.length = 0;
    await vi.advanceTimersByTimeAsync(250);

    expect(states).toEqual([]);
    expect(replay.getState()).toMatchObject({ status: 'destroyed', position: 1 });
    expect(replay.getData()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('destroy is idempotent, keeps getters usable, rejects mutations, and emits nothing', () => {
    vi.useFakeTimers();
    const { replay, changes, states } = create();
    replay.step(2);
    changes.length = 0;
    states.length = 0;

    replay.destroy();
    replay.destroy();

    expect(replay.getState()).toMatchObject({ status: 'destroyed', position: 2 });
    expect(replay.getData()).toHaveLength(2);
    expect(changes).toEqual([]);
    expect(states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    expect(() => replay.play()).toThrow();
    expect(() => replay.pause()).toThrow();
    expect(() => replay.step()).toThrow();
    expect(() => replay.seek(0)).toThrow();
    expect(() => replay.setSpeed(2)).toThrow();
  });
});
