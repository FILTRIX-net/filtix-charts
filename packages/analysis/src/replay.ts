import { ChartError, SeriesStore } from '@filtix/core';
import type { CandlePoint, SeriesPoint, TimeDomain } from '@filtix/charts';
import type { HistoryReplay, HistoryReplayOptions, ReplayChange, ReplayState, ReplayStatus } from './types';

const DEFAULT_BARS_PER_SECOND = 4;
const MIN_BARS_PER_SECOND = 0.25;
const MAX_BARS_PER_SECOND = 64;

function replayError(code: string, message: string): ChartError {
  return new ChartError(code, message);
}

function assertSpeed(barsPerSecond: number): void {
  if (
    typeof barsPerSecond !== 'number' ||
    !Number.isFinite(barsPerSecond) ||
    barsPerSecond < MIN_BARS_PER_SECOND ||
    barsPerSecond > MAX_BARS_PER_SECOND
  ) {
    throw replayError(
      'INVALID_REPLAY_SPEED',
      `barsPerSecond must be a finite number from ${MIN_BARS_PER_SECOND} through ${MAX_BARS_PER_SECOND}`,
    );
  }
}

function copyBar(point: CandlePoint): CandlePoint {
  const result: CandlePoint = {
    time: point.time,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
  };
  if (point.volume !== undefined) result.volume = point.volume;
  return result;
}

function validateAndCopyBars(bars: readonly CandlePoint[], timeDomain: TimeDomain): readonly CandlePoint[] {
  if (!Array.isArray(bars)) {
    throw replayError('INVALID_REPLAY_BARS', 'Replay bars must be an array');
  }

  const validator = new SeriesStore('candlestick', timeDomain);
  validator.setData(bars as readonly SeriesPoint[]);

  const history = new Array<CandlePoint>(validator.length);
  for (let index = 0; index < validator.length; index += 1) {
    const point = validator.pointAt(index);
    if (point === null || !('open' in point)) {
      throw replayError('INVALID_REPLAY_BARS', 'Replay history requires complete OHLC bars');
    }
    history[index] = Object.freeze(copyBar(point));
  }
  return Object.freeze(history);
}

function validateOptions(options: HistoryReplayOptions): {
  history: readonly CandlePoint[];
  barsPerSecond: number;
  onChange: HistoryReplayOptions['onChange'];
  onState: HistoryReplayOptions['onState'];
} {
  if (options === null || typeof options !== 'object') {
    throw replayError('INVALID_REPLAY_OPTIONS', 'Replay options must be an object');
  }
  if (typeof options.onChange !== 'function') {
    throw replayError('INVALID_REPLAY_CALLBACK', 'onChange must be a function');
  }
  if (options.onState !== undefined && typeof options.onState !== 'function') {
    throw replayError('INVALID_REPLAY_CALLBACK', 'onState must be a function when supplied');
  }

  const barsPerSecond = options.barsPerSecond ?? DEFAULT_BARS_PER_SECOND;
  assertSpeed(barsPerSecond);
  const history = validateAndCopyBars(options.bars, options.timeDomain ?? 'utc-ms');
  return {
    history,
    barsPerSecond,
    onChange: options.onChange,
    onState: options.onState,
  };
}

export function createHistoryReplay(options: HistoryReplayOptions): HistoryReplay {
  const validated = validateOptions(options);
  const history = validated.history;
  const total = history.length;
  const onChange = validated.onChange;
  const onState = validated.onState;

  let status: ReplayStatus = total === 0 ? 'ended' : 'paused';
  let position = 0;
  let barsPerSecond = validated.barsPerSecond;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const getState = (): ReplayState =>
    Object.freeze({
      status,
      position,
      total,
      barsPerSecond,
    });

  const copyRange = (from: number, to: number): CandlePoint[] => {
    const result = new Array<CandlePoint>(to - from);
    for (let index = from; index < to; index += 1) {
      result[index - from] = copyBar(history[index]!);
    }
    return result;
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const callState = (state: ReplayState): void => {
    if (onState === undefined) return;
    try {
      onState(state);
    } catch {
      // Consumer callbacks are isolated from controller state.
    }
  };

  const notifyChange = (
    type: ReplayChange['type'],
    bars: readonly CandlePoint[],
    operationGeneration: number,
  ): void => {
    const state = getState();
    const change: ReplayChange = Object.freeze({ type, bars, state });
    try {
      onChange(change);
    } catch {
      // Consumer callbacks are isolated from controller state.
    }
    if (generation !== operationGeneration || status === 'destroyed') return;
    callState(state);
  };

  const assertLive = (): void => {
    if (status === 'destroyed') {
      throw replayError('REPLAY_DESTROYED', 'History replay has been destroyed');
    }
  };

  const schedule = (timerGeneration: number): void => {
    if (generation !== timerGeneration || status !== 'playing' || position >= total) return;
    const scheduledTimer = setTimeout(() => {
      if (timer === scheduledTimer) timer = null;
      if (generation !== timerGeneration || status !== 'playing' || position >= total) {
        return;
      }

      const start = position;
      position += 1;
      status = position === total ? 'ended' : 'playing';
      notifyChange('append', copyRange(start, position), timerGeneration);

      if (generation === timerGeneration && status === 'playing') {
        schedule(timerGeneration);
      }
    }, 1000 / barsPerSecond);
    timer = scheduledTimer;
  };

  return {
    play(): void {
      assertLive();
      if (status === 'playing' || status === 'ended') return;

      generation += 1;
      const operationGeneration = generation;
      status = 'playing';
      callState(getState());
      if (generation === operationGeneration && status === 'playing') {
        schedule(operationGeneration);
      }
    },

    pause(): void {
      assertLive();
      if (status !== 'playing') return;

      generation += 1;
      clearTimer();
      status = 'paused';
      callState(getState());
    },

    step(count = 1): void {
      assertLive();
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw replayError('INVALID_REPLAY_STEP', 'Replay step count must be a positive safe integer');
      }
      if (position >= total) return;

      generation += 1;
      const operationGeneration = generation;
      clearTimer();
      const start = position;
      position = Math.min(total, position + count);
      status = position === total ? 'ended' : 'paused';
      notifyChange('append', copyRange(start, position), operationGeneration);
    },

    seek(nextPosition: number): void {
      assertLive();
      if (!Number.isInteger(nextPosition) || nextPosition < 0 || nextPosition > total) {
        throw replayError(
          'INVALID_REPLAY_POSITION',
          `Replay position must be an integer from 0 through ${total}`,
        );
      }

      generation += 1;
      const operationGeneration = generation;
      clearTimer();
      position = nextPosition;
      status = position === total ? 'ended' : 'paused';
      notifyChange('reset', copyRange(0, position), operationGeneration);
    },

    setSpeed(nextBarsPerSecond: number): void {
      assertLive();
      assertSpeed(nextBarsPerSecond);

      generation += 1;
      const operationGeneration = generation;
      const wasPlaying = status === 'playing';
      clearTimer();
      barsPerSecond = nextBarsPerSecond;
      callState(getState());
      if (wasPlaying && generation === operationGeneration && status === 'playing') {
        schedule(operationGeneration);
      }
    },

    getData(): readonly CandlePoint[] {
      return copyRange(0, position);
    },

    getState,

    destroy(): void {
      if (status === 'destroyed') return;
      generation += 1;
      clearTimer();
      status = 'destroyed';
    },
  };
}
