import { copyDrawingDocument, decodeDrawingDocument } from '@filtix/drawings';
import {
  copyPriceAlertDocument,
  createEmptyPriceAlertDocument,
  decodePriceAlertDocument,
} from '@filtix/alerts';
import type { MarketQuery } from '@filtix/datafeed';
import { copyLayout, defaultLayout, resolveLayout, visiblePaneIds } from './layout';
import { copyStudies, legacyEma, resolveStoredStudies } from './studies';
import type {
  TerminalSettings,
  TerminalWorkspace,
  TerminalWorkspaceMarket,
  TerminalWorkspaceV1,
} from './types';

const DEFAULT_SETTINGS: TerminalSettings = Object.freeze({
  theme: 'dark',
  followLatest: true,
  volume: true,
  emaPeriod: 20,
});
const SETTING_KEYS = new Set(['theme', 'followLatest', 'volume', 'emaPeriod']);
const WORKSPACE_SETTING_KEYS = new Set(['theme', 'followLatest', 'volume']);
const WORKSPACE_KEYS_V1 = new Set(['schema', 'version', 'providerId', 'query', 'settings', 'markets']);
const WORKSPACE_KEYS_V2 = new Set([
  'schema',
  'version',
  'providerId',
  'query',
  'settings',
  'studies',
  'markets',
]);
const WORKSPACE_KEYS_V4 = new Set([...WORKSPACE_KEYS_V2, 'layout']);
const WORKSPACE_KEYS_V5 = new Set([...WORKSPACE_KEYS_V4, 'alerts']);

export interface TerminalCatalog {
  symbols: string[];
  intervals: string[];
}

export interface WorkspaceDecodeContext extends TerminalCatalog {
  providerId: string;
  legacyAlertScopeId: string;
  requiredAlertScopeId?: string;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
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

function requireKeys(value: Record<string, unknown>, required: ReadonlySet<string>, label: string): void {
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} field is required: ${key}`);
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    fail(`${label} must be a nonblank string without surrounding whitespace`);
  return value;
}

export function resolveQuery(value: unknown): MarketQuery {
  const candidate = record(value, 'Market query');
  const keys = new Set(['symbol', 'interval']);
  exactKeys(candidate, keys, 'market query');
  requireKeys(candidate, keys, 'Market query');
  return {
    symbol: nonblank(candidate.symbol, 'Market symbol'),
    interval: nonblank(candidate.interval, 'Market interval'),
  };
}

export function resolveSettings(
  partial: Partial<TerminalSettings> = {},
  base: TerminalSettings = DEFAULT_SETTINGS,
): TerminalSettings {
  const candidate = record(partial, 'Terminal settings');
  exactKeys(candidate, SETTING_KEYS, 'terminal settings');
  const next = { ...base, ...candidate } as Record<string, unknown>;
  if (next.theme !== 'dark' && next.theme !== 'light') fail('Terminal theme must be dark or light');
  if (typeof next.followLatest !== 'boolean') fail('followLatest must be a boolean');
  if (typeof next.volume !== 'boolean') fail('volume must be a boolean');
  if (
    next.emaPeriod !== null &&
    (!Number.isInteger(next.emaPeriod) || (next.emaPeriod as number) < 2 || (next.emaPeriod as number) > 500)
  )
    fail('EMA period must be null or an integer from 2 to 500');
  return {
    theme: next.theme,
    followLatest: next.followLatest,
    volume: next.volume,
    emaPeriod: next.emaPeriod as number | null,
  };
}

function workspaceSettings(value: unknown): Omit<TerminalSettings, 'emaPeriod'> {
  const candidate = record(value, 'Workspace settings');
  exactKeys(candidate, WORKSPACE_SETTING_KEYS, 'workspace settings');
  requireKeys(candidate, WORKSPACE_SETTING_KEYS, 'Workspace settings');
  const resolved = resolveSettings({ ...candidate, emaPeriod: null });
  return { theme: resolved.theme, followLatest: resolved.followLatest, volume: resolved.volume };
}

function catalogValues(values: readonly string[] | undefined, fallback: string, label: string): string[] {
  if (values === undefined) return [fallback];
  if (!Array.isArray(values) || values.length === 0) fail(`${label} catalog must be a nonempty array`);
  const result = values.map((value) => nonblank(value, label));
  if (new Set(result).size !== result.length) fail(`${label} catalog values must be unique`);
  return result;
}

export function resolveCatalog(
  queryValue: MarketQuery,
  symbolValues?: readonly string[],
  intervalValues?: readonly string[],
): TerminalCatalog {
  const query = resolveQuery(queryValue);
  const symbols = catalogValues(symbolValues, query.symbol, 'Symbol');
  const intervals = catalogValues(intervalValues, query.interval, 'Interval');
  if (!symbols.includes(query.symbol) || !intervals.includes(query.interval))
    fail('Supplied catalogs must include the active query');
  if (symbols.length * intervals.length > 32)
    fail('Terminal catalogs may contain at most 32 symbol and interval combinations');
  return { symbols, intervals };
}

function marketKey(query: MarketQuery): string {
  return JSON.stringify([query.symbol, query.interval]);
}

function decodeMarkets(value: unknown, context: WorkspaceDecodeContext): TerminalWorkspaceMarket[] {
  if (!Array.isArray(value)) fail('Workspace markets must be an array');
  if (value.length > 32) fail('Workspace may contain at most 32 markets');
  const length = value.length;
  for (let index = 0; index < length; index++)
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail('Workspace markets must be dense');
  const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    entries.push(value[index]);
    if (value.length !== length) fail('Workspace market array length changed');
  }
  const seen = new Set<string>();
  const markets: TerminalWorkspaceMarket[] = [];
  for (let index = 0; index < length; index++) {
    const entry = entries[index];
    const market = record(entry, `Workspace market ${index + 1}`);
    const keys = new Set(['query', 'drawings']);
    exactKeys(market, keys, 'workspace market');
    requireKeys(market, keys, 'Workspace market');
    const marketQuery = resolveQuery(market.query);
    if (!context.symbols.includes(marketQuery.symbol) || !context.intervals.includes(marketQuery.interval))
      fail('Workspace market is outside the terminal catalogs');
    const key = marketKey(marketQuery);
    if (seen.has(key)) fail('Workspace contains a duplicate market entry');
    seen.add(key);
    markets.push({
      query: marketQuery,
      drawings: decodeDrawingDocument(market.drawings, { timeDomain: 'utc-ms', maxDrawings: 200 }),
    });
    if (value.length !== length) fail('Workspace market array length changed');
  }
  if (value.length !== length) fail('Workspace market array length changed');
  for (let index = 0; index < length; index++)
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail('Workspace markets must be dense');
  return markets;
}

export function decodeWorkspace(value: unknown, context: WorkspaceDecodeContext): TerminalWorkspace {
  const document = record(value, 'Terminal workspace');
  if (
    document.schema !== 'filtix-terminal' ||
    (document.version !== 1 &&
      document.version !== 2 &&
      document.version !== 3 &&
      document.version !== 4 &&
      document.version !== 5)
  )
    fail('Unsupported terminal workspace document');
  exactKeys(
    document,
    document.version === 1
      ? WORKSPACE_KEYS_V1
      : document.version === 5
        ? WORKSPACE_KEYS_V5
        : document.version === 4
          ? WORKSPACE_KEYS_V4
          : WORKSPACE_KEYS_V2,
    'terminal workspace',
  );
  requireKeys(
    document,
    document.version === 1
      ? WORKSPACE_KEYS_V1
      : document.version === 5
        ? WORKSPACE_KEYS_V5
        : document.version === 4
          ? WORKSPACE_KEYS_V4
          : WORKSPACE_KEYS_V2,
    'Terminal workspace',
  );
  const providerId = nonblank(document.providerId, 'Workspace provider id');
  if (providerId !== context.providerId) fail('Workspace provider does not match this terminal');
  const query = resolveQuery(document.query);
  if (!context.symbols.includes(query.symbol) || !context.intervals.includes(query.interval))
    fail('Workspace query is outside the terminal catalogs');

  let settings: Omit<TerminalSettings, 'emaPeriod'>;
  let studies;
  if (document.version === 1) {
    const settingsValue = record(document.settings, 'Workspace settings');
    exactKeys(settingsValue, SETTING_KEYS, 'workspace settings');
    requireKeys(settingsValue, SETTING_KEYS, 'Workspace settings');
    const legacySettings = resolveSettings(settingsValue as Partial<TerminalSettings>);
    settings = {
      theme: legacySettings.theme,
      followLatest: legacySettings.followLatest,
      volume: legacySettings.volume,
    };
    studies = legacySettings.emaPeriod === null ? [] : [legacyEma(legacySettings.emaPeriod)];
  } else {
    settings = workspaceSettings(document.settings);
    studies = resolveStoredStudies(document.studies, document.version === 2 ? 2 : 3);
  }
  const layout =
    document.version >= 4
      ? resolveLayout(document.layout, defaultLayout(studies), visiblePaneIds(studies, settings.volume), true)
      : defaultLayout(studies);
  const markets = decodeMarkets(document.markets, context);
  if (!markets.some((market) => marketKey(market.query) === marketKey(query)))
    fail('Workspace must include its active market entry');
  const alerts =
    document.version === 5
      ? decodePriceAlertDocument(document.alerts, {
          providerId,
          ...(context.requiredAlertScopeId ? { scopeId: context.requiredAlertScopeId } : {}),
        })
      : createEmptyPriceAlertDocument({ providerId, scopeId: context.legacyAlertScopeId });
  for (const alert of alerts.alerts) {
    if (!context.symbols.includes(alert.query.symbol) || !context.intervals.includes(alert.query.interval))
      fail('Workspace alert query is outside the terminal catalogs');
  }

  return {
    schema: 'filtix-terminal',
    version: 5,
    providerId,
    query,
    settings,
    studies,
    layout,
    markets,
    alerts,
  };
}

export function copySettings(settings: TerminalSettings): TerminalSettings {
  return { ...settings };
}

export function copyQuery(query: MarketQuery): MarketQuery {
  return { ...query };
}

export function copyWorkspaceDocument(workspace: TerminalWorkspace): TerminalWorkspace {
  return {
    schema: 'filtix-terminal',
    version: 5,
    providerId: workspace.providerId,
    query: copyQuery(workspace.query),
    settings: { ...workspace.settings },
    studies: copyStudies(workspace.studies),
    layout: copyLayout(workspace.layout),
    markets: workspace.markets.map((market) => ({
      query: copyQuery(market.query),
      drawings: copyDrawingDocument(market.drawings),
    })),
    alerts: copyPriceAlertDocument(workspace.alerts),
  };
}

export function queryKey(providerId: string, query: MarketQuery): string {
  return JSON.stringify([providerId, query.symbol, query.interval]);
}
