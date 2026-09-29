import { copyWorkspaceDocument, decodeWorkspace, queryKey } from './codec';
import type {
  TerminalGridCellId,
  TerminalGridCellWorkspace,
  TerminalGridLayout,
  TerminalGridSync,
  TerminalGridWorkspace,
} from './grid-types';

const CELL_IDS = ['cell-1', 'cell-2', 'cell-3', 'cell-4'] as const;
const GRID_KEYS = new Set(['schema', 'version', 'providerId', 'layout', 'activeCellId', 'sync', 'cells']);
const CELL_KEYS = new Set(['id', 'workspace']);
const SYNC_KEYS = new Set(['viewport', 'crosshair', 'crosshairMatch']);
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

export interface GridDecodeContext {
  providerId: string;
  symbols: string[];
  intervals: string[];
  legacyAlertScopeIds: Readonly<Record<TerminalGridCellId, string>>;
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

function exactFields(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!fields.has(key)) fail(`Unknown ${label} field: ${key}`);
  for (const key of fields) if (!own(value, key)) fail(`${label} field is required: ${key}`);
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    fail(`${label} must be a nonblank string without surrounding whitespace`);
  return value;
}

function cellId(value: unknown): TerminalGridCellId {
  if (typeof value !== 'string' || !CELL_IDS.some((id) => id === value))
    fail('Unknown terminal grid cell id');
  return value as TerminalGridCellId;
}

function sync(value: unknown): TerminalGridSync {
  const candidate = record(value, 'Terminal grid sync');
  exactFields(candidate, SYNC_KEYS, 'terminal grid sync');
  if (typeof candidate.viewport !== 'boolean' || typeof candidate.crosshair !== 'boolean')
    fail('Terminal grid sync toggles must be booleans');
  if (candidate.crosshairMatch !== 'exact' && candidate.crosshairMatch !== 'nearest')
    fail('Terminal grid crosshair match must be exact or nearest');
  return {
    viewport: candidate.viewport,
    crosshair: candidate.crosshair,
    crosshairMatch: candidate.crosshairMatch,
  };
}

function scopes(context: GridDecodeContext): Readonly<Record<TerminalGridCellId, string>> {
  const supplied = record(context.legacyAlertScopeIds, 'Legacy alert scope ids');
  exactFields(supplied, new Set(CELL_IDS), 'legacy alert scope ids');
  const result = Object.create(null) as Record<TerminalGridCellId, string>;
  const seen = new Set<string>();
  for (const id of CELL_IDS) {
    const scope = nonblank(supplied[id], 'Legacy alert scope id');
    if (seen.has(scope)) fail('Duplicate legacy alert scope id');
    seen.add(scope);
    result[id] = scope;
  }
  return result;
}

export function decodeGridWorkspace(value: unknown, context: GridDecodeContext): TerminalGridWorkspace {
  const document = record(value, 'Terminal grid workspace');
  exactFields(document, GRID_KEYS, 'terminal grid workspace');
  if (document.schema !== 'filtix-terminal-grid' || document.version !== 1)
    fail('Unsupported terminal grid workspace document');
  const providerId = nonblank(document.providerId, 'Terminal grid provider id');
  if (providerId !== context.providerId) fail('Terminal grid provider does not match this terminal');
  const layout = document.layout;
  if (layout !== 1 && layout !== 2 && layout !== 4) fail('Terminal grid layout must be 1, 2 or 4');
  const activeCellId = cellId(document.activeCellId);
  if (CELL_IDS.indexOf(activeCellId) >= layout) fail('Terminal grid active cell must be visible');
  const resolvedSync = sync(document.sync);
  const legacyAlertScopeIds = scopes(context);
  const sourceCells = document.cells;
  if (!Array.isArray(sourceCells) || sourceCells.length !== 4)
    fail('Terminal grid requires exactly four cells');
  const captured: unknown[] = [];
  for (let index = 0; index < CELL_IDS.length; index++) {
    if (!own(sourceCells, index)) fail('Terminal grid cells must be dense');
    captured.push(sourceCells[index]);
    if (sourceCells.length !== 4) fail('Terminal grid cell array length changed');
  }

  const byId = new Map<TerminalGridCellId, TerminalGridCellWorkspace>();
  const alertScopes = new Set<string>();
  const armedQueries = new Set<string>();
  let ruleCount = 0;
  for (const entry of captured) {
    const candidate = record(entry, 'Terminal grid cell');
    exactFields(candidate, CELL_KEYS, 'terminal grid cell');
    const id = cellId(candidate.id);
    if (byId.has(id)) fail('Duplicate terminal grid cell id');
    const workspace = decodeWorkspace(candidate.workspace, {
      providerId,
      symbols: context.symbols,
      intervals: context.intervals,
      legacyAlertScopeId: legacyAlertScopeIds[id],
    });
    if (alertScopes.has(workspace.alerts.scopeId)) fail('Duplicate terminal grid alert scope id');
    alertScopes.add(workspace.alerts.scopeId);
    ruleCount += workspace.alerts.alerts.length;
    if (ruleCount > 400) fail('Terminal grid exceeds 400 alert rules');
    for (const alert of workspace.alerts.alerts) {
      if (alert.status === 'armed') armedQueries.add(queryKey(providerId, alert.query));
      if (armedQueries.size > 32) fail('Terminal grid exceeds 32 armed alert queries');
    }
    byId.set(id, { id, workspace });
  }
  if (sourceCells.length !== 4 || CELL_IDS.some((_, index) => !own(sourceCells, index)))
    fail('Terminal grid cell array changed during validation');
  return {
    schema: 'filtix-terminal-grid',
    version: 1,
    providerId,
    layout: layout as TerminalGridLayout,
    activeCellId,
    sync: resolvedSync,
    cells: CELL_IDS.map((id) => byId.get(id)!),
  };
}

export function copyGridWorkspace(value: TerminalGridWorkspace): TerminalGridWorkspace {
  return {
    schema: 'filtix-terminal-grid',
    version: 1,
    providerId: value.providerId,
    layout: value.layout,
    activeCellId: value.activeCellId,
    sync: { ...value.sync },
    cells: value.cells.map((cell) => ({ id: cell.id, workspace: copyWorkspaceDocument(cell.workspace) })),
  };
}
