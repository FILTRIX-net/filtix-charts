import { afterEach, expect, it, vi } from 'vitest';
import { timeKey } from '@filtix/core';
import { formatPrice, formatTime } from './renderer';
import type { Scene } from './types';

afterEach(() => vi.restoreAllMocks());

const makeScene = (options: Scene['options'] = {}): Scene => ({ options }) as Scene;
const nativeTime = (key: number, locale = 'en-US', timeZone = 'UTC') =>
  new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(key));

it('reuses UTC label formatting within each scene without changing native labels', () => {
  const keys = [Date.UTC(2024, 2, 10, 6, 59), Date.UTC(2024, 2, 10, 7), Date.UTC(2024, 10, 3, 6)];
  const expected = keys.map((key) => nativeTime(key));
  const DateTimeFormat = Intl.DateTimeFormat;
  const constructor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new DateTimeFormat(locales, options);
  });
  const scene = makeScene();
  for (let turn = 0; turn < 10; turn++) expect(keys.map((key) => formatTime(scene, key))).toEqual(expected);
  expect(constructor).toHaveBeenCalledTimes(1);
  expect(formatTime(makeScene(), keys[0]!)).toBe(expected[0]);
  expect(constructor).toHaveBeenCalledTimes(2);
});

it('reuses supported numeric formatting with the same native rounding and signed zero', () => {
  const values = [-0, 0, -1234.5678, 0.0001, 1234.5678];
  const expected = values.map((value) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
  );
  const nativeCalls = vi.spyOn(Number.prototype, 'toLocaleString');
  const NumberFormat = Intl.NumberFormat;
  const constructor = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) {
    return new NumberFormat(locales, options);
  });
  for (let turn = 0; turn < 10; turn++)
    expect(values.map((value) => formatPrice(value, { pricePrecision: 4 }))).toEqual(expected);
  expect(nativeCalls.mock.calls.length).toBe(0);
  expect(constructor).toHaveBeenCalledTimes(1);
});

it('observes locale and time-zone changes, including DST, with independent scene settings', () => {
  const key = Date.UTC(2024, 2, 10, 7);
  const scene = makeScene();
  expect(formatTime(scene, key)).toBe(nativeTime(key));
  scene.options = { locale: 'de-DE', timeZone: 'America/New_York' };
  expect(formatTime(scene, key)).toBe(nativeTime(key, 'de-DE', 'America/New_York'));
  scene.options.locale = 'ja-JP';
  expect(formatTime(scene, key)).toBe(nativeTime(key, 'ja-JP', 'America/New_York'));
  scene.options.timeZone = 'Asia/Tokyo';
  expect(formatTime(scene, key)).toBe(nativeTime(key, 'ja-JP', 'Asia/Tokyo'));
  expect(formatTime(makeScene(), key)).toBe(nativeTime(key));
  scene.options = { timeDomain: 'business-date' };
  expect(formatTime(scene, timeKey('2024-02-29', 'business-date'))).toBe('2024-02-29');
  scene.options = { locale: 'en-US', timeZone: 'UTC' };
  expect(formatTime(scene, key)).toBe(nativeTime(key));
  scene.options.timeZone = 'Invalid/Zone';
  expect(() => formatTime(scene, key)).toThrow(RangeError);
});

it('preserves all precision endpoints, tick rounding, exponential and native fallback behavior', () => {
  for (let precision = 0; precision <= 12; precision++)
    for (const value of [-0, -12.345678901234, 0.0000000123, 987654.123456])
      expect(formatPrice(value, { pricePrecision: precision })).toBe(
        value.toLocaleString('en-US', {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        }),
      );
  expect(formatPrice(1.23456, { tickSize: 0.001 })).toBe('1.235');
  expect(formatPrice(1e15)).toBe((1e15).toExponential(2));
  expect(formatPrice(12.345, { pricePrecision: 13 })).toBe(
    (12.345).toLocaleString('en-US', {
      minimumFractionDigits: 13,
      maximumFractionDigits: 13,
    }),
  );
  expect(() => formatPrice(1, { pricePrecision: -1 })).toThrow(RangeError);
});
