import type {
  TerminalBollingerStudy,
  TerminalBollingerStudyOptions,
  TerminalMacdStudy,
  TerminalMacdStudyOptions,
  TerminalSingleStudy,
  TerminalSingleStudyOptions,
  TerminalStudy,
  TerminalStudyKind,
  TerminalStudyPatch,
} from './types';

export const MAX_STUDIES = 8;
export const MAX_OSCILLATOR_STUDIES = 3;
export const MAX_STUDY_SERIES = 20;
export const LEGACY_EMA_ID = 'terminal-ema';

const SINGLE_OPTION_KEYS = new Set(['kind', 'period', 'color', 'lineWidth', 'visible']);
const MACD_OPTION_KEYS = new Set([
  'kind',
  'fastPeriod',
  'slowPeriod',
  'signalPeriod',
  'color',
  'signalColor',
  'positiveColor',
  'negativeColor',
  'lineWidth',
  'visible',
]);
const BOLLINGER_OPTION_KEYS = new Set([
  'kind',
  'period',
  'multiplier',
  'color',
  'upperColor',
  'lowerColor',
  'fillColor',
  'fillOpacity',
  'lineWidth',
  'visible',
]);
const SINGLE_STORED_KEYS = new Set(['id', ...SINGLE_OPTION_KEYS]);
const MACD_STORED_KEYS = new Set(['id', ...MACD_OPTION_KEYS]);
const BOLLINGER_STORED_KEYS = new Set(['id', ...BOLLINGER_OPTION_KEYS]);
const SINGLE_PATCH_KEYS = new Set(['period', 'color', 'lineWidth', 'visible']);
const MACD_PATCH_KEYS = new Set([
  'fastPeriod',
  'slowPeriod',
  'signalPeriod',
  'color',
  'signalColor',
  'positiveColor',
  'negativeColor',
  'lineWidth',
  'visible',
]);
const BOLLINGER_PATCH_KEYS = new Set([
  'period',
  'multiplier',
  'color',
  'upperColor',
  'lowerColor',
  'fillColor',
  'fillOpacity',
  'lineWidth',
  'visible',
]);
const DEFAULT_COLORS = Object.freeze({
  sma: '#c7ef57',
  ema: '#c27a50',
  rsi: '#a8a0dc',
  macd: '#7aa2f7',
  bollinger: '#c7ef57',
});
const MACD_DEFAULTS = Object.freeze({
  signalColor: '#e0af68',
  positiveColor: '#73c991',
  negativeColor: '#ef7c8e',
});
const BOLLINGER_DEFAULTS = Object.freeze({
  upperColor: '#7aa2f7',
  lowerColor: '#7aa2f7',
  fillColor: '#7aa2f7',
  fillOpacity: 0.12,
});
const GENERIC_ID = /^study-([1-9]\d*)$/;

type TerminalSingleStudyWithoutId = Omit<TerminalSingleStudy, 'id'>;
type TerminalMacdStudyWithoutId = Omit<TerminalMacdStudy, 'id'>;
type TerminalBollingerStudyWithoutId = Omit<TerminalBollingerStudy, 'id'>;
export type ResolvedTerminalStudyOptions =
  | TerminalSingleStudyWithoutId
  | TerminalMacdStudyWithoutId
  | TerminalBollingerStudyWithoutId;

function fail(message: string): never {
  throw new TypeError(message);
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`Unknown ${label.toLowerCase()} field`);
    result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unknown ${label} field: ${key}`);
}

function required(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of keys)
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} field is required: ${key}`);
}

function resolveKind(value: unknown, legacyOnly = false): TerminalStudyKind {
  if (value === 'sma' || value === 'ema' || value === 'rsi') return value;
  if (!legacyOnly && (value === 'macd' || value === 'bollinger')) return value;
  fail(
    legacyOnly
      ? 'Workspace v2 study kind must be sma, ema, or rsi'
      : 'Study kind must be sma, ema, rsi, macd, or bollinger',
  );
}

function period(value: unknown, label = 'Study period'): number {
  if (!Number.isInteger(value) || (value as number) < 2 || (value as number) > 500)
    fail(`${label} must be an integer from 2 to 500`);
  return value as number;
}

function multiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10)
    fail('Bollinger multiplier must be a finite number greater than 0 and at most 10');
  return value;
}

function fillOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    fail('Bollinger fillOpacity must be a finite number from 0 to 1');
  return value;
}

function color(value: unknown, label = 'Study color'): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
    fail(`${label} must use #RRGGBB hexadecimal notation`);
  return value.toLowerCase();
}

function lineWidth(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4)
    fail('Study lineWidth must be an integer from 1 to 4');
  return value as number;
}

function visible(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('Study visible must be a boolean');
  return value;
}

function validateMacdPeriods(fast: number, slow: number): void {
  if (fast >= slow) fail('MACD fastPeriod must be less than slowPeriod');
}

function optionColor(
  candidate: Record<string, unknown>,
  key: string,
  fallback: string,
  label: string,
): string {
  return Object.prototype.hasOwnProperty.call(candidate, key) ? color(candidate[key], label) : fallback;
}

function optionWidth(candidate: Record<string, unknown>): number {
  return Object.prototype.hasOwnProperty.call(candidate, 'lineWidth') ? lineWidth(candidate.lineWidth) : 2;
}

function optionVisible(candidate: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(candidate, 'visible') ? visible(candidate.visible) : true;
}

function resolveSingleOptions(
  candidate: Record<string, unknown>,
  kind: TerminalSingleStudyOptions['kind'],
): TerminalSingleStudyWithoutId {
  exactKeys(candidate, SINGLE_OPTION_KEYS, 'study options');
  if (!Object.prototype.hasOwnProperty.call(candidate, 'period')) fail('Study period is required');
  return {
    kind,
    period: period(candidate.period),
    color: optionColor(candidate, 'color', DEFAULT_COLORS[kind], 'Study color'),
    lineWidth: optionWidth(candidate),
    visible: optionVisible(candidate),
  };
}

function resolveMacdOptions(candidate: Record<string, unknown>): TerminalMacdStudyWithoutId {
  exactKeys(candidate, MACD_OPTION_KEYS, 'study options');
  for (const key of ['fastPeriod', 'slowPeriod', 'signalPeriod'])
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) fail(`Study ${key} is required`);
  const fastPeriod = period(candidate.fastPeriod, 'MACD fastPeriod');
  const slowPeriod = period(candidate.slowPeriod, 'MACD slowPeriod');
  const signalPeriod = period(candidate.signalPeriod, 'MACD signalPeriod');
  validateMacdPeriods(fastPeriod, slowPeriod);
  return {
    kind: 'macd',
    fastPeriod,
    slowPeriod,
    signalPeriod,
    color: optionColor(candidate, 'color', DEFAULT_COLORS.macd, 'MACD color'),
    signalColor: optionColor(candidate, 'signalColor', MACD_DEFAULTS.signalColor, 'MACD signalColor'),
    positiveColor: optionColor(candidate, 'positiveColor', MACD_DEFAULTS.positiveColor, 'MACD positiveColor'),
    negativeColor: optionColor(candidate, 'negativeColor', MACD_DEFAULTS.negativeColor, 'MACD negativeColor'),
    lineWidth: optionWidth(candidate),
    visible: optionVisible(candidate),
  };
}

function resolveBollingerOptions(candidate: Record<string, unknown>): TerminalBollingerStudyWithoutId {
  exactKeys(candidate, BOLLINGER_OPTION_KEYS, 'study options');
  for (const key of ['period', 'multiplier'])
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) fail(`Study ${key} is required`);
  return {
    kind: 'bollinger',
    period: period(candidate.period),
    multiplier: multiplier(candidate.multiplier),
    color: optionColor(candidate, 'color', DEFAULT_COLORS.bollinger, 'Bollinger middle color'),
    upperColor: optionColor(candidate, 'upperColor', BOLLINGER_DEFAULTS.upperColor, 'Bollinger upperColor'),
    lowerColor: optionColor(candidate, 'lowerColor', BOLLINGER_DEFAULTS.lowerColor, 'Bollinger lowerColor'),
    fillColor: optionColor(candidate, 'fillColor', BOLLINGER_DEFAULTS.fillColor, 'Bollinger fillColor'),
    fillOpacity: Object.prototype.hasOwnProperty.call(candidate, 'fillOpacity')
      ? fillOpacity(candidate.fillOpacity)
      : BOLLINGER_DEFAULTS.fillOpacity,
    lineWidth: optionWidth(candidate),
    visible: optionVisible(candidate),
  };
}

export function resolveStudyId(value: unknown): string {
  if (value === LEGACY_EMA_ID) return value;
  if (typeof value !== 'string') fail('Study id must be terminal-ema or study-N');
  const match = GENERIC_ID.exec(value);
  if (!match) fail('Study id must be terminal-ema or a canonical positive study-N');
  const numeric = Number(match[1]);
  if (!Number.isSafeInteger(numeric)) fail('Study id must contain a safe positive integer');
  return value;
}

export function resolveStudyOptions(value: unknown): ResolvedTerminalStudyOptions {
  const candidate = snapshotRecord(value, 'Study options');
  if (!Object.prototype.hasOwnProperty.call(candidate, 'kind')) fail('Study kind is required');
  const kind = resolveKind(candidate.kind);
  if (kind === 'macd') return resolveMacdOptions(candidate);
  if (kind === 'bollinger') return resolveBollingerOptions(candidate);
  return resolveSingleOptions(candidate, kind);
}

function resolveStoredStudy(value: unknown, version: 2 | 3): TerminalStudy {
  const candidate = snapshotRecord(value, 'Stored study');
  if (!Object.prototype.hasOwnProperty.call(candidate, 'kind')) fail('Stored study field is required: kind');
  const kind = resolveKind(candidate.kind, version === 2);
  const allowed =
    kind === 'macd' ? MACD_STORED_KEYS : kind === 'bollinger' ? BOLLINGER_STORED_KEYS : SINGLE_STORED_KEYS;
  exactKeys(candidate, allowed, 'stored study');
  required(candidate, allowed, 'Stored study');
  const id = resolveStudyId(candidate.id);
  if (id === LEGACY_EMA_ID && kind !== 'ema') fail('Reserved terminal-ema study must have ema kind');
  if (kind === 'macd') {
    const fastPeriod = period(candidate.fastPeriod, 'MACD fastPeriod');
    const slowPeriod = period(candidate.slowPeriod, 'MACD slowPeriod');
    validateMacdPeriods(fastPeriod, slowPeriod);
    return {
      id,
      kind,
      fastPeriod,
      slowPeriod,
      signalPeriod: period(candidate.signalPeriod, 'MACD signalPeriod'),
      color: color(candidate.color, 'MACD color'),
      signalColor: color(candidate.signalColor, 'MACD signalColor'),
      positiveColor: color(candidate.positiveColor, 'MACD positiveColor'),
      negativeColor: color(candidate.negativeColor, 'MACD negativeColor'),
      lineWidth: lineWidth(candidate.lineWidth),
      visible: visible(candidate.visible),
    };
  }
  if (kind === 'bollinger')
    return {
      id,
      kind,
      period: period(candidate.period),
      multiplier: multiplier(candidate.multiplier),
      color: color(candidate.color, 'Bollinger middle color'),
      upperColor: color(candidate.upperColor, 'Bollinger upperColor'),
      lowerColor: color(candidate.lowerColor, 'Bollinger lowerColor'),
      fillColor: color(candidate.fillColor, 'Bollinger fillColor'),
      fillOpacity: fillOpacity(candidate.fillOpacity),
      lineWidth: lineWidth(candidate.lineWidth),
      visible: visible(candidate.visible),
    };
  return {
    id,
    kind,
    period: period(candidate.period),
    color: color(candidate.color),
    lineWidth: lineWidth(candidate.lineWidth),
    visible: visible(candidate.visible),
  };
}

export function resolveStudyPatch(current: TerminalStudy, value: unknown): TerminalStudy {
  const patch = snapshotRecord(value, 'Study patch');
  const allowed =
    current.kind === 'macd'
      ? MACD_PATCH_KEYS
      : current.kind === 'bollinger'
        ? BOLLINGER_PATCH_KEYS
        : SINGLE_PATCH_KEYS;
  exactKeys(patch, allowed, 'study patch');
  return resolveStoredStudy({ ...copyStudy(current), ...patch }, 3);
}

export function studySeriesCost(kind: TerminalStudyKind): number {
  if (kind === 'macd') return 3;
  if (kind === 'bollinger') return 4;
  return 1;
}

function oscillatorCost(kind: TerminalStudyKind): number {
  return kind === 'rsi' || kind === 'macd' ? 1 : 0;
}

export function validateStudyCaps(studies: readonly TerminalStudy[]): void {
  if (studies.length > MAX_STUDIES) fail('Terminal supports at most eight studies');
  const oscillators = studies.reduce((sum, study) => sum + oscillatorCost(study.kind), 0);
  if (oscillators > MAX_OSCILLATOR_STUDIES)
    fail('Terminal supports at most three oscillator pane reservations');
  const series = studies.reduce((sum, study) => sum + studySeriesCost(study.kind), 0);
  if (series > MAX_STUDY_SERIES) fail('Terminal supports at most twenty reserved study series');
}

export function canReserveStudyKind(studies: readonly TerminalStudy[], kind: TerminalStudyKind): boolean {
  if (studies.length >= MAX_STUDIES) return false;
  const oscillators =
    studies.reduce((sum, study) => sum + oscillatorCost(study.kind), 0) + oscillatorCost(kind);
  if (oscillators > MAX_OSCILLATOR_STUDIES) return false;
  const series = studies.reduce((sum, study) => sum + studySeriesCost(study.kind), 0) + studySeriesCost(kind);
  return series <= MAX_STUDY_SERIES;
}

export function resolveStoredStudies(value: unknown, version: 2 | 3 = 3): TerminalStudy[] {
  if (!Array.isArray(value)) fail('Workspace studies must be an array');
  if (value.length > MAX_STUDIES) fail('Terminal supports at most eight studies');
  const studies = value.map((entry) => resolveStoredStudy(entry, version));
  const ids = new Set<string>();
  for (const study of studies) {
    if (ids.has(study.id)) fail('Workspace contains a duplicate study id');
    ids.add(study.id);
  }
  validateStudyCaps(studies);
  return studies;
}

export function copyStudy(study: TerminalStudy): TerminalStudy {
  return { ...study };
}

export function copyStudies(studies: readonly TerminalStudy[]): TerminalStudy[] {
  return studies.map(copyStudy);
}

export function sameStudy(left: TerminalStudy, right: TerminalStudy): boolean {
  if (
    left.id !== right.id ||
    left.kind !== right.kind ||
    left.color !== right.color ||
    left.lineWidth !== right.lineWidth ||
    left.visible !== right.visible
  )
    return false;
  if (left.kind === 'macd')
    return (
      right.kind === 'macd' &&
      left.fastPeriod === right.fastPeriod &&
      left.slowPeriod === right.slowPeriod &&
      left.signalPeriod === right.signalPeriod &&
      left.signalColor === right.signalColor &&
      left.positiveColor === right.positiveColor &&
      left.negativeColor === right.negativeColor
    );
  if (left.kind === 'bollinger')
    return (
      right.kind === 'bollinger' &&
      left.period === right.period &&
      left.multiplier === right.multiplier &&
      left.upperColor === right.upperColor &&
      left.lowerColor === right.lowerColor &&
      left.fillColor === right.fillColor &&
      left.fillOpacity === right.fillOpacity
    );
  return right.kind !== 'macd' && right.kind !== 'bollinger' && left.period === right.period;
}

export function studyCalculationChanged(left: TerminalStudy, right: TerminalStudy): boolean {
  if (left.kind !== right.kind) return true;
  if (left.kind === 'macd')
    return (
      right.kind !== 'macd' ||
      left.fastPeriod !== right.fastPeriod ||
      left.slowPeriod !== right.slowPeriod ||
      left.signalPeriod !== right.signalPeriod
    );
  if (left.kind === 'bollinger')
    return right.kind !== 'bollinger' || left.period !== right.period || left.multiplier !== right.multiplier;
  return right.kind === 'macd' || right.kind === 'bollinger' || left.period !== right.period;
}

export function legacyEma(periodValue: number): TerminalSingleStudy {
  return {
    id: LEGACY_EMA_ID,
    kind: 'ema',
    period: period(periodValue),
    color: DEFAULT_COLORS.ema,
    lineWidth: 2,
    visible: true,
  };
}

export function projectedEmaPeriod(studies: readonly TerminalStudy[]): number | null {
  const study = studies.find((entry) => entry.id === LEGACY_EMA_ID);
  return study?.kind === 'ema' && study.visible ? study.period : null;
}

function genericNumber(id: string): number | null {
  const match = GENERIC_ID.exec(id);
  if (!match) return null;
  const result = Number(match[1]);
  return Number.isSafeInteger(result) ? result : null;
}

export class StudyIdAllocator {
  constructor(private highWater = 0) {
    if (!Number.isSafeInteger(highWater) || highWater < 0)
      fail('Study allocator high water must be a nonnegative safe integer');
  }

  next(): string {
    if (this.highWater >= Number.MAX_SAFE_INTEGER) fail('Study id allocator is exhausted');
    return `study-${this.highWater + 1}`;
  }

  commit(id: string): void {
    if (id !== this.next()) fail('Study allocation commit is stale');
    this.highWater += 1;
  }

  allocate(): string {
    const id = this.next();
    this.commit(id);
    return id;
  }

  advanceFrom(entries: readonly { id: string }[]): void {
    let next = this.highWater;
    for (const entry of entries) {
      const value = genericNumber(entry.id);
      if (value !== null) next = Math.max(next, value);
    }
    this.highWater = next;
  }
}
