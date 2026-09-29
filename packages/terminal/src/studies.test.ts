import { describe, expect, test } from 'vitest';

import {
  StudyIdAllocator,
  canReserveStudyKind,
  resolveStoredStudies,
  resolveStudyOptions,
  resolveStudyPatch,
  validateStudyCaps,
} from './studies';
import type { TerminalBollingerStudy, TerminalMacdStudy, TerminalSingleStudy, TerminalStudy } from './types';

const single = (
  id: string,
  kind: TerminalSingleStudy['kind'] = 'sma',
  visible = true,
): TerminalSingleStudy => ({
  id,
  kind,
  period: kind === 'rsi' ? 14 : 20,
  color: kind === 'sma' ? '#c7ef57' : kind === 'ema' ? '#c27a50' : '#a8a0dc',
  lineWidth: 2,
  visible,
});

const macd = (id: string, visible = true): TerminalMacdStudy => ({
  id,
  kind: 'macd',
  fastPeriod: 12,
  slowPeriod: 26,
  signalPeriod: 9,
  color: '#7aa2f7',
  signalColor: '#e0af68',
  positiveColor: '#73c991',
  negativeColor: '#ef7c8e',
  lineWidth: 2,
  visible,
});

const bollinger = (id: string, visible = true, fillOpacity = 0.12): TerminalBollingerStudy => ({
  id,
  kind: 'bollinger',
  period: 20,
  multiplier: 2,
  color: '#c7ef57',
  upperColor: '#7aa2f7',
  lowerColor: '#7aa2f7',
  fillColor: '#7aa2f7',
  fillOpacity,
  lineWidth: 2,
  visible,
});

describe('terminal study descriptors', () => {
  test('resolves exact per-kind defaults and snapshots caller getters once', () => {
    const reads = new Map<string, number>();
    const input: Record<string, unknown> = {};
    const values: Record<string, unknown> = {
      kind: 'macd',
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      color: '#AABBCC',
    };
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });

    expect(resolveStudyOptions(input)).toEqual({
      kind: 'macd',
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      color: '#aabbcc',
      signalColor: '#e0af68',
      positiveColor: '#73c991',
      negativeColor: '#ef7c8e',
      lineWidth: 2,
      visible: true,
    });
    expect(Object.fromEntries(reads)).toEqual({
      kind: 1,
      fastPeriod: 1,
      slowPeriod: 1,
      signalPeriod: 1,
      color: 1,
    });
    expect(resolveStudyOptions({ kind: 'bollinger', period: 20, multiplier: 2 })).toEqual({
      kind: 'bollinger',
      period: 20,
      multiplier: 2,
      color: '#c7ef57',
      upperColor: '#7aa2f7',
      lowerColor: '#7aa2f7',
      fillColor: '#7aa2f7',
      fillOpacity: 0.12,
      lineWidth: 2,
      visible: true,
    });
  });

  test('rejects own __proto__ data and getter fields across options, patches, and stored studies', () => {
    const hostileOption = JSON.parse('{"kind":"sma","period":20,"__proto__":{"unexpected":true}}') as Record<
      string,
      unknown
    >;
    const hostilePatch = JSON.parse('{"__proto__":{"unexpected":true}}') as Record<string, unknown>;
    const hostileStored = JSON.parse(JSON.stringify(single('study-1'))) as Record<string, unknown>;
    Object.defineProperty(hostileStored, '__proto__', {
      value: { unexpected: true },
      enumerable: true,
      configurable: true,
    });
    let hostileReads = 0;
    const getterOption = { kind: 'sma', period: 20 } as Record<string, unknown>;
    Object.defineProperty(getterOption, '__proto__', {
      enumerable: true,
      get() {
        hostileReads += 1;
        return { unexpected: true };
      },
    });

    expect(() => resolveStudyOptions(hostileOption)).toThrow(/field|__proto__/i);
    expect(() => resolveStudyPatch(single('study-1'), hostilePatch)).toThrow(/field|__proto__/i);
    expect(() => resolveStoredStudies([hostileStored])).toThrow(/field|__proto__/i);
    expect(() => resolveStudyOptions(getterOption)).toThrow(/field|__proto__/i);
    expect(hostileReads).toBe(1);
  });

  test.each([
    null,
    [],
    { kind: 'macd', fastPeriod: 12, slowPeriod: 26 },
    { kind: 'macd', fastPeriod: 26, slowPeriod: 26, signalPeriod: 9 },
    { kind: 'macd', fastPeriod: 27, slowPeriod: 26, signalPeriod: 9 },
    { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: null },
    { kind: 'macd', fastPeriod: '12', slowPeriod: 26, signalPeriod: 9 },
    { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, period: 20 },
    { kind: 'bollinger', period: 20, multiplier: 0 },
    { kind: 'bollinger', period: 20, multiplier: 10.1 },
    { kind: 'bollinger', period: 20, multiplier: Number.NaN },
    { kind: 'bollinger', period: 20, multiplier: 2, fillOpacity: -0.01 },
    { kind: 'bollinger', period: 20, multiplier: 2, fillOpacity: 1.01 },
    { kind: 'bollinger', period: 20, multiplier: 2, fillOpacity: undefined },
    { kind: 'bollinger', period: 20, multiplier: 2, signalColor: '#abcdef' },
    { kind: 'sma', period: 20, multiplier: 2 },
    { kind: 'sma', period: 20, color: '#abc' },
    { kind: 'sma', period: 20, visible: undefined },
  ])('rejects malformed or foreign option fields %#', (value) => {
    expect(() => resolveStudyOptions(value)).toThrow();
  });

  test('resolves patches against the current variant and validates the complete merged MACD pair', () => {
    const current = macd('study-1');
    expect(() => resolveStudyPatch(current, { fastPeriod: 30 })).toThrow(/fast|slow/i);
    expect(resolveStudyPatch(current, { fastPeriod: 30, slowPeriod: 40, signalColor: '#FFCC00' })).toEqual({
      ...current,
      fastPeriod: 30,
      slowPeriod: 40,
      signalColor: '#ffcc00',
    });
    expect(resolveStudyPatch(current, {})).toEqual(current);
    for (const patch of [
      null,
      [],
      { id: 'study-1' },
      { kind: 'macd' },
      { period: 20 },
      { multiplier: 2 },
      { fastPeriod: undefined },
      { positiveColor: null },
    ])
      expect(() => resolveStudyPatch(current, patch)).toThrow();
    expect(() => resolveStudyPatch(bollinger('study-2'), { signalPeriod: 9 })).toThrow(/field/i);
  });

  test('validates strict stored variants, identities, and missing persisted styles', () => {
    expect(resolveStoredStudies([macd('study-1'), bollinger('study-2')])).toEqual([
      macd('study-1'),
      bollinger('study-2'),
    ]);
    const missingSignalStyle = { ...macd('study-1') } as Record<string, unknown>;
    delete missingSignalStyle.signalColor;
    expect(() => resolveStoredStudies([missingSignalStyle])).toThrow(/signalColor|required/i);
    expect(() => resolveStoredStudies([{ ...bollinger('study-2'), positiveColor: '#73c991' }])).toThrow(
      /field/i,
    );
    expect(() => resolveStoredStudies([macd('study-1')], 2)).toThrow(/kind|v2|macd/i);
    expect(resolveStoredStudies([single('study-1')], 2)).toEqual([single('study-1')]);
  });

  test('applies stored, oscillator, and study-series caps to hidden reservations', () => {
    const maximum: TerminalStudy[] = [
      macd('study-1'),
      macd('study-2'),
      macd('study-3', false),
      bollinger('study-4'),
      bollinger('study-5', false, 0),
      single('study-6', 'sma'),
      single('study-7', 'ema'),
      single('study-8', 'sma'),
    ];
    expect(() => validateStudyCaps(maximum)).not.toThrow();
    expect(canReserveStudyKind(maximum.slice(0, 7), 'sma')).toBe(true);
    expect(canReserveStudyKind(maximum, 'sma')).toBe(false);
    expect(() => validateStudyCaps([...maximum.slice(0, 3), single('study-9', 'rsi', false)])).toThrow(
      /three.*oscillator|pane/i,
    );
    expect(() =>
      validateStudyCaps([
        bollinger('study-1'),
        bollinger('study-2'),
        bollinger('study-3'),
        bollinger('study-4'),
        bollinger('study-5', false, 0),
        single('study-6'),
      ]),
    ).toThrow(/twenty.*series|series/i);
    expect(() => validateStudyCaps([...maximum, single('study-9')])).toThrow(/eight/i);
  });

  test('allocator advances only on committed allocation or restored high water and fails at exhaustion', () => {
    const allocator = new StudyIdAllocator();
    expect(allocator.allocate()).toBe('study-1');
    allocator.advanceFrom([{ id: 'study-40' }, { id: 'terminal-ema' }]);
    expect(allocator.allocate()).toBe('study-41');
    allocator.advanceFrom([{ id: 'study-2' }]);
    expect(allocator.allocate()).toBe('study-42');
    const exhausted = new StudyIdAllocator(Number.MAX_SAFE_INTEGER);
    expect(() => exhausted.allocate()).toThrow(/exhaust/i);
  });
});
