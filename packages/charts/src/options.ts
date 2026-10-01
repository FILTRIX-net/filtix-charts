import { ChartError } from '@filtrix.net/core';
import { darkTheme, lightTheme } from './themes';
import type {
  ChartExportOptions,
  ChartOptions,
  ChartTheme,
  PaneOptions,
  SeriesOptions,
  SeriesType,
} from './types';
const fail = (message: string): never => {
  throw new ChartError('INVALID_OPTIONS', message);
};
export function clean<T extends object>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Options must be an object');
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
function positive(value: unknown, name: string, zero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0))
    fail(`${name} must be ${zero ? 'nonnegative' : 'positive'} and finite`);
}
function string(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a nonempty string`);
}
function color(value: unknown, name: string) {
  string(value, name);
  if (typeof CSS !== 'undefined' && !CSS.supports('color', value as string)) fail(`${name} is not a color`);
}
function known(options: object, names: string[]) {
  for (const name of Object.keys(options)) if (!names.includes(name)) fail(`Unknown option ${name}`);
}
export function chartOptions(old: ChartOptions, patch: ChartOptions): ChartOptions {
  patch = clean(patch);
  known(patch, [
    'theme',
    'timeDomain',
    'locale',
    'timeZone',
    'autoSize',
    'width',
    'height',
    'crosshair',
    'followLatest',
    'diagnostics',
    'ariaLabel',
    'maxPixelRatio',
    'legend',
    'attribution',
  ]);
  const next = { attribution: true, ...old, ...patch };
  if (patch.legend !== undefined) {
    if (patch.legend === null || typeof patch.legend !== 'object' || Array.isArray(patch.legend))
      fail('legend must be a plain object');
    const prototype = Object.getPrototypeOf(patch.legend);
    if (prototype !== Object.prototype && prototype !== null) fail('legend must be a plain object');
    const partial = clean(patch.legend);
    known(partial, ['visible', 'maxRows']);
    if (partial.visible !== undefined && typeof partial.visible !== 'boolean')
      fail('legend.visible must be boolean');
    if (
      partial.maxRows !== undefined &&
      (!Number.isInteger(partial.maxRows) || partial.maxRows < 1 || partial.maxRows > 4)
    )
      fail('legend.maxRows must be an integer from 1 to 4');
    next.legend = { visible: old.legend?.visible ?? true, maxRows: old.legend?.maxRows ?? 2, ...partial };
  } else {
    next.legend = { visible: old.legend?.visible ?? true, maxRows: old.legend?.maxRows ?? 2 };
  }
  if (next.timeDomain !== undefined && !['utc-ms', 'business-date'].includes(next.timeDomain))
    fail('Invalid time domain');
  for (const key of ['width', 'height'] as const) if (next[key] !== undefined) positive(next[key], key, true);
  if (next.maxPixelRatio !== undefined) positive(next.maxPixelRatio, 'maxPixelRatio');
  for (const key of ['autoSize', 'crosshair', 'followLatest', 'diagnostics', 'attribution'] as const)
    if (next[key] !== undefined && typeof next[key] !== 'boolean') fail(`${key} must be boolean`);
  for (const key of ['locale', 'timeZone', 'ariaLabel'] as const)
    if (next[key] !== undefined) string(next[key], key);
  try {
    new Intl.DateTimeFormat(next.locale ?? 'en-US', { timeZone: next.timeZone ?? 'UTC' });
  } catch {
    fail('Invalid locale or time zone');
  }
  if (patch.theme !== undefined) {
    if (typeof patch.theme === 'string') {
      if (!['dark', 'light'].includes(patch.theme)) fail('Invalid theme');
    } else {
      const partial = clean(patch.theme);
      known(partial, Object.keys(darkTheme));
      for (const [key, value] of Object.entries(partial)) {
        if (key === 'fontSize') positive(value, key);
        else if (key === 'fontFamily') string(value, key);
        else color(value, key);
      }
      next.theme = {
        ...(typeof old.theme === 'object' ? old.theme : old.theme === 'light' ? lightTheme : darkTheme),
        ...partial,
      };
    }
  }
  return next;
}
export function exportWatermark(options: ChartExportOptions | undefined, attribution: boolean): boolean {
  if (options === undefined) return attribution;
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    fail('Export options must be a plain object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) fail('Export options must be a plain object');
  for (const key of Reflect.ownKeys(options))
    if (key !== 'watermark') fail(`Unknown export option ${String(key)}`);
  const watermark = options.watermark;
  if (watermark !== undefined && typeof watermark !== 'boolean') fail('watermark must be boolean');
  return watermark ?? attribution;
}
export function resolveTheme(options: ChartOptions): ChartTheme {
  return {
    ...(options.theme === 'light' ? lightTheme : darkTheme),
    ...(typeof options.theme === 'object' ? options.theme : {}),
  };
}
export function paneOptions(patch: PaneOptions): Required<Omit<PaneOptions, 'id'>> {
  patch = clean(patch);
  known(patch, ['id', 'weight', 'scale', 'minHeight']);
  if (patch.id !== undefined) string(patch.id, 'id');
  if (patch.weight !== undefined) positive(patch.weight, 'weight');
  if (patch.minHeight !== undefined) positive(patch.minHeight, 'minHeight');
  if (patch.scale !== undefined && !['linear', 'log'].includes(patch.scale)) fail('Invalid scale');
  return { weight: patch.weight ?? 1, scale: patch.scale ?? 'linear', minHeight: patch.minHeight ?? 48 };
}
export function seriesOptions(type: SeriesType, patch: SeriesOptions, defaults = false): SeriesOptions {
  patch = clean(patch);
  known(patch, [
    'id',
    'paneId',
    'title',
    'color',
    'upColor',
    'downColor',
    'lineWidth',
    'pricePrecision',
    'tickSize',
    'lastValueVisible',
    'priceLineVisible',
    'connectGaps',
    'fillOpacity',
  ]);
  for (const key of ['id', 'paneId'] as const) if (patch[key] !== undefined) string(patch[key], key);
  if (patch.title !== undefined && typeof patch.title !== 'string') fail('title must be a string');
  for (const key of ['color', 'upColor', 'downColor'] as const)
    if (patch[key] !== undefined) color(patch[key], key);
  for (const key of ['lineWidth', 'tickSize'] as const)
    if (patch[key] !== undefined) positive(patch[key], key);
  if (
    patch.pricePrecision !== undefined &&
    (!Number.isInteger(patch.pricePrecision) || patch.pricePrecision < 0 || patch.pricePrecision > 12)
  )
    fail('pricePrecision must be an integer from 0 to 12');
  for (const key of ['lastValueVisible', 'priceLineVisible', 'connectGaps'] as const)
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') fail(`${key} must be boolean`);
  if (patch.fillOpacity !== undefined) {
    if (type !== 'band') fail('fillOpacity is only supported by band series');
    if (
      typeof patch.fillOpacity !== 'number' ||
      !Number.isFinite(patch.fillOpacity) ||
      patch.fillOpacity < 0 ||
      patch.fillOpacity > 1
    )
      fail('fillOpacity must be a finite number from 0 to 1');
  }
  if (type === 'band') {
    if (patch.lastValueVisible === true || patch.priceLineVisible === true)
      fail('Band series cannot show scalar annotations');
    return defaults
      ? { fillOpacity: 0.14, lastValueVisible: false, priceLineVisible: false, ...patch }
      : patch;
  }
  return patch;
}
