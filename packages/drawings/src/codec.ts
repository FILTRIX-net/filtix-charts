import { ChartError, timeKey, type ChartTime, type TimeDomain } from '@filtrix.net/core';
import { DEFAULT_DRAWING_STYLE, DEFAULT_FIBONACCI_LEVELS, requiredAnchorCount } from './spec';
import type {
  Drawing,
  DrawingDocument,
  DrawingInput,
  DrawingPoint,
  DrawingStyle,
  DrawingType,
  FibonacciLevel,
} from './types';

const TYPES: readonly DrawingType[] = [
  'trend-line',
  'horizontal-line',
  'rectangle',
  'measure',
  'fibonacci-retracement',
  'parallel-channel',
  'text-note',
];
const OLD_TYPES = new Set(TYPES.slice(0, 4));
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const OWN = Object.prototype.hasOwnProperty;
function fail(code: string, message: string): never {
  throw new ChartError(code, message);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_DRAWING', 'Drawing values must be objects');
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('INVALID_DRAWING', 'Unknown symbol field');
    result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value))
    if (!accepted.has(key)) fail('INVALID_DRAWING', 'Unknown ' + label + ' field: ' + key);
}
function required(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (!OWN.call(value, field)) fail('INVALID_DRAWING', field + ' is required');
}
function requireDense(entries: readonly unknown[], label: string): void {
  for (let index = 0; index < entries.length; index++)
    if (!OWN.call(entries, index)) fail('INVALID_DRAWING', label + ' entry is required: ' + index);
}
export function validDrawingId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    fail('INVALID_DRAWING_ID', label + ' must contain 1-80 ASCII letters, digits, _ or -');
  return value;
}
function validType(value: unknown, old = false): DrawingType {
  if (
    typeof value !== 'string' ||
    !TYPES.includes(value as DrawingType) ||
    (old && !OLD_TYPES.has(value as DrawingType))
  )
    fail('INVALID_DRAWING', 'Unknown drawing type');
  return value as DrawingType;
}
function validDomain(value: unknown): TimeDomain {
  if (value !== 'utc-ms' && value !== 'business-date')
    fail('INVALID_TIME_DOMAIN', 'Unknown time domain: ' + String(value));
  return value;
}
function point(value: unknown, domain: TimeDomain): DrawingPoint {
  const p = record(value);
  keys(p, ['time', 'price'], 'point');
  required(p, ['time', 'price']);
  if (typeof p.price !== 'number' || !Number.isFinite(p.price))
    fail('INVALID_DRAWING', 'Point price must be finite');
  timeKey(p.time as ChartTime, domain);
  return { time: p.time as ChartTime, price: p.price };
}
function style(value: unknown, partial: boolean): DrawingStyle | Partial<DrawingStyle> {
  const s = record(value);
  keys(s, ['color', 'lineWidth', 'fillOpacity'], 'style');
  if (!partial) required(s, ['color', 'lineWidth', 'fillOpacity']);
  const result: Partial<DrawingStyle> = {};
  if (OWN.call(s, 'color')) {
    if (typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(s.color))
      fail('INVALID_DRAWING_STYLE', 'Color must be #RRGGBB or #RRGGBBAA');
    result.color = s.color;
  }
  if (OWN.call(s, 'lineWidth')) {
    if (
      typeof s.lineWidth !== 'number' ||
      !Number.isFinite(s.lineWidth) ||
      s.lineWidth < 0.5 ||
      s.lineWidth > 8
    )
      fail('INVALID_DRAWING_STYLE', 'lineWidth must be finite and between 0.5 and 8');
    result.lineWidth = s.lineWidth;
  }
  if (OWN.call(s, 'fillOpacity')) {
    if (
      typeof s.fillOpacity !== 'number' ||
      !Number.isFinite(s.fillOpacity) ||
      s.fillOpacity < 0 ||
      s.fillOpacity > 1
    )
      fail('INVALID_DRAWING_STYLE', 'fillOpacity must be finite and between 0 and 1');
    result.fillOpacity = s.fillOpacity;
  }
  return result;
}
function levels(value: unknown): readonly FibonacciLevel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    fail('INVALID_DRAWING', 'Fibonacci levels require 1-32 entries');
  requireDense(value, 'Fibonacci level');
  const ratios = new Set<number>();
  return value.map((entry) => {
    const level = record(entry);
    keys(level, ['ratio', 'color', 'lineWidth', 'lineStyle'], 'level');
    required(level, ['ratio']);
    if (
      typeof level.ratio !== 'number' ||
      !Number.isFinite(level.ratio) ||
      level.ratio < -10 ||
      level.ratio > 10 ||
      ratios.has(level.ratio)
    )
      fail('INVALID_DRAWING', 'Fibonacci ratios must be unique finite values in [-10, 10]');
    ratios.add(level.ratio);
    const result: FibonacciLevel = { ratio: level.ratio };
    if (OWN.call(level, 'color')) result.color = style({ color: level.color }, true).color;
    if (OWN.call(level, 'lineWidth'))
      result.lineWidth = style({ lineWidth: level.lineWidth }, true).lineWidth;
    if (OWN.call(level, 'lineStyle')) {
      if (level.lineStyle !== 'solid' && level.lineStyle !== 'dashed' && level.lineStyle !== 'dotted')
        fail('INVALID_DRAWING_STYLE', 'Unknown level lineStyle');
      result.lineStyle = level.lineStyle;
    }
    return result;
  });
}
function noteText(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_DRAWING', 'Note text must be a string');
  const text = value.replace(/\r\n/g, '\n');
  if (!text.trim() || text.length > 2000 || text.split('\n').length > 20)
    fail('INVALID_DRAWING', 'Note text must contain content, at most 2000 code units and 20 lines');
  return text;
}
function fontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 8 || value > 48)
    fail('INVALID_DRAWING', 'fontSize must be finite and from 8 to 48');
  return value;
}
export function normalizeDrawingInput(
  value: unknown,
  domain: TimeDomain,
  id: string,
  complete = false,
  old = false,
): Drawing {
  const input = record(value);
  const type = validType(input.type, old);
  const allowed = [
    'id',
    'type',
    'paneId',
    'points',
    'style',
    ...(old ? [] : ['locked', 'visible']),
    ...(type === 'fibonacci-retracement' ? ['levels'] : []),
    ...(type === 'text-note' ? ['text', 'fontSize'] : []),
  ];
  keys(input, allowed, 'drawing');
  if (complete)
    required(input, [
      'id',
      'type',
      'paneId',
      'points',
      'style',
      ...(old ? [] : ['locked', 'visible']),
      ...(type === 'fibonacci-retracement' ? ['levels'] : []),
      ...(type === 'text-note' ? ['text', 'fontSize'] : []),
    ]);
  if (OWN.call(input, 'id') && (complete || input.id !== undefined) && validDrawingId(input.id) !== id)
    fail('INVALID_DRAWING_ID', 'Drawing id does not match');
  const paneId = input.paneId === undefined && !complete ? 'price' : validDrawingId(input.paneId, 'paneId');
  if (!Array.isArray(input.points) || input.points.length !== requiredAnchorCount(type))
    fail('INVALID_DRAWING', type + ' requires ' + requiredAnchorCount(type) + ' point(s)');
  requireDense(input.points, 'Drawing point');
  const points = input.points.map((entry) => point(entry, domain));
  if (
    points.length === 2 &&
    timeKey(points[0]!.time, domain) === timeKey(points[1]!.time, domain) &&
    points[0]!.price === points[1]!.price
  )
    fail('INVALID_DRAWING', 'Two-point drawings require distinct endpoints');
  const resolvedStyle =
    input.style === undefined && !complete
      ? { ...DEFAULT_DRAWING_STYLE }
      : complete
        ? (style(input.style, false) as DrawingStyle)
        : { ...DEFAULT_DRAWING_STYLE, ...style(input.style, true) };
  const locked = old ? false : input.locked === undefined && !complete ? false : input.locked;
  const visible = old ? true : input.visible === undefined && !complete ? true : input.visible;
  if (typeof locked !== 'boolean' || typeof visible !== 'boolean')
    fail('INVALID_DRAWING', 'locked and visible must be booleans');
  const base = { id, type, paneId, points, style: resolvedStyle, locked, visible };
  if (type === 'fibonacci-retracement')
    return {
      ...base,
      type,
      levels: levels(input.levels === undefined && !complete ? DEFAULT_FIBONACCI_LEVELS : input.levels),
    };
  if (type === 'text-note')
    return {
      ...base,
      type,
      text: noteText(input.text === undefined && !complete ? 'Note' : input.text),
      fontSize: fontSize(input.fontSize === undefined && !complete ? 12 : input.fontSize),
    };
  if (type === 'parallel-channel') return { ...base, type };
  return { ...base, type };
}
export function copyDrawing(drawing: Drawing): Drawing {
  const base = { ...drawing, points: drawing.points.map((p) => ({ ...p })), style: { ...drawing.style } };
  return drawing.type === 'fibonacci-retracement'
    ? { ...base, type: drawing.type, levels: drawing.levels.map((level) => ({ ...level })) }
    : base;
}
export function sameDrawing(a: Drawing, b: Drawing): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function decodeDrawingDocument(
  value: unknown,
  options?: { timeDomain?: TimeDomain; maxDrawings?: number },
): DrawingDocument {
  const document = record(value);
  keys(document, ['schema', 'version', 'timeDomain', 'drawings'], 'document');
  required(document, ['schema', 'version', 'timeDomain', 'drawings']);
  if (document.schema !== 'filtix-drawings' || (document.version !== 1 && document.version !== 2))
    fail('INVALID_DOCUMENT', 'Unsupported drawings document');
  const domain = validDomain(document.timeDomain);
  if (options?.timeDomain !== undefined && domain !== validDomain(options.timeDomain))
    fail('INVALID_TIME_DOMAIN', 'Document time domain does not match the store');
  const max = options?.maxDrawings === undefined ? 200 : options.maxDrawings;
  if (!Number.isInteger(max) || max < 1 || max > 1000)
    fail('INVALID_DRAWING', 'maxDrawings must be an integer from 1 to 1000');
  if (!Array.isArray(document.drawings)) fail('INVALID_DOCUMENT', 'Document drawings must be an array');
  if (document.drawings.length > max) fail('DRAWING_LIMIT', 'Document exceeds maximum drawing count');
  requireDense(document.drawings, 'Document drawing');
  const seen = new Set<string>();
  const drawings = document.drawings.map((entry) => {
    const input = record(entry);
    const id = validDrawingId(input.id);
    const drawing = normalizeDrawingInput(input, domain, id, true, document.version === 1);
    if (seen.has(id)) fail('DUPLICATE_DRAWING_ID', 'Duplicate drawing id: ' + id);
    seen.add(id);
    return drawing;
  });
  return { schema: 'filtix-drawings', version: 2, timeDomain: domain, drawings };
}
export function copyDrawingDocument(document: DrawingDocument): DrawingDocument {
  return decodeDrawingDocument(document, { timeDomain: document.timeDomain, maxDrawings: 1000 });
}
