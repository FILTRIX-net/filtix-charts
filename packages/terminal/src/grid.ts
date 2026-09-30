import {
  copyPriceAlertDocument,
  createPriceAlertMonitor,
  createPriceAlertStore,
  type PriceAlertEvent,
  type PriceAlertMonitor,
  type PriceAlertMonitorState,
  type PriceAlertStore,
} from '@filtrix.net/alerts';
import { prepareAlertMembershipReplacement } from '@filtrix.net/alerts/internal';
import { isChartError } from '@filtrix.net/core';
import type { MarketQuery } from '@filtrix.net/datafeed';
import { copyWorkspaceDocument, resolveCatalog, resolveQuery } from './codec';
import { copyGridWorkspace, decodeGridWorkspace } from './grid-codec';
import { createGridControls, type GridControls } from './grid-controls';
import { createGridLifecycle } from './grid-lifecycle';
import { createGridSyncController } from './grid-sync';
import type {
  TerminalGridApi,
  TerminalGridCellId,
  TerminalGridLayout,
  TerminalGridOptions,
  TerminalGridState,
  TerminalGridSync,
  TerminalGridWorkspace,
} from './grid-types';
import { isTerminalMutationSuperseded, TerminalMutationSupersededError } from './mutation';
import { prepareTerminal } from './terminal';
import type { PreparedTerminal } from './terminal-preparation';
import type { TerminalOptions, TerminalWorkspace } from './types';

const IDS = ['cell-1', 'cell-2', 'cell-3', 'cell-4'] as const;
const OPTION_KEYS = new Set([
  'provider',
  'query',
  'symbols',
  'intervals',
  'settings',
  'studies',
  'feed',
  'layout',
  'sync',
  'alerts',
  'onState',
  'onAlert',
]);
const ALERT_KEYS = new Set(['monitor', 'stores']);
const SYNC_KEYS = new Set(['viewport', 'crosshair', 'crosshairMatch']);
const DEFAULT_SYNC: TerminalGridSync = { viewport: false, crosshair: false, crosshairMatch: 'exact' };
const GRID_STYLE = `
.filtix-terminal-grid{--filtix-grid-bg:#151715;--filtix-grid-panel:#20231f;--filtix-grid-text:#f4eddc;--filtix-grid-muted:#9a9f91;--filtix-grid-accent:#c7ef57;--filtix-grid-border:#353a33;box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--filtix-grid-bg);color:var(--filtix-grid-text);font:500 12px/1.25 ui-sans-serif,system-ui,sans-serif;color-scheme:dark}
.filtix-terminal-grid[data-theme="light"]{--filtix-grid-bg:#f3efe4;--filtix-grid-panel:#fffaf0;--filtix-grid-text:#1b1d19;--filtix-grid-muted:#686d63;--filtix-grid-accent:#6b8e16;--filtix-grid-border:#cfc8b8;color-scheme:light}
.filtix-terminal-grid *{box-sizing:border-box}
.filtix-terminal-grid-toolbar{display:flex;align-items:center;gap:12px;flex:none;max-width:100%;min-width:0;min-height:46px;padding:6px 8px;overflow:auto;overscroll-behavior:contain;border-bottom:1px solid var(--filtix-grid-border);background:var(--filtix-grid-panel);white-space:nowrap}
.filtix-terminal-grid-control-group{display:flex;align-items:center;gap:5px;flex:none}
.filtix-terminal-grid-caption{margin-right:3px;color:var(--filtix-grid-muted);font-size:10px;font-weight:800;letter-spacing:.1em}
.filtix-terminal-grid-active{flex:none;padding:5px 8px;border-left:1px solid var(--filtix-grid-border);color:var(--filtix-grid-accent);font-size:10px;font-weight:800;letter-spacing:.08em}
.filtix-terminal-grid-toolbar label{display:flex;align-items:center;gap:4px;flex:none;color:var(--filtix-grid-muted)}
.filtix-terminal-grid-toolbar button,.filtix-terminal-grid-toolbar select{min-height:34px;border:1px solid var(--filtix-grid-border);border-radius:4px;background:var(--filtix-grid-bg);color:var(--filtix-grid-text);font:inherit}
.filtix-terminal-grid-toolbar button{min-width:34px;padding:5px 9px;cursor:pointer}
.filtix-terminal-grid-toolbar button[aria-pressed="true"]{border-color:var(--filtix-grid-accent);color:var(--filtix-grid-accent)}
.filtix-terminal-grid-toolbar input[type="checkbox"]{width:17px;height:17px;margin:0;accent-color:var(--filtix-grid-accent)}
.filtix-terminal-grid-toolbar select{max-width:106px;padding:4px 6px}
.filtix-terminal-grid-toolbar button:focus-visible,.filtix-terminal-grid-toolbar select:focus-visible,.filtix-terminal-grid-toolbar input:focus-visible{outline:2px solid var(--filtix-grid-accent);outline-offset:1px}
.filtix-terminal-grid-region{display:grid;flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;gap:8px;grid-template-columns:minmax(0,1fr);grid-auto-rows:minmax(360px,1fr);align-content:stretch;padding:8px}
.filtix-terminal-grid-region[data-columns="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.filtix-terminal-grid-cell{position:relative;min-width:0;min-height:360px;overflow:hidden;border:1px solid var(--filtix-grid-border)}
.filtix-terminal-grid-cell[data-active="true"]{border-color:var(--filtix-grid-accent)}
`;
let instanceNumber = 0;

interface GridSlot {
  id: TerminalGridCellId;
  workspace: TerminalWorkspace;
  store: PriceAlertStore;
  ownsStore: boolean;
  gridLease: () => void;
  terminalLease: (() => void) | null;
  terminal: PreparedTerminal | null;
  wrapper: HTMLDivElement | null;
  unsubscribeEvents: (() => void) | null;
}

interface StagedSlot extends Omit<GridSlot, 'gridLease' | 'terminalLease' | 'unsubscribeEvents'> {
  gridLease: (() => void) | null;
  terminalLease: (() => void) | null;
  unsubscribeEvents: (() => void) | null;
}

/** Source-private construction seam. Tests inject actual D2 preparation with faulting chart/feed constructors. */
export interface GridDependencies {
  prepareTerminal?: typeof prepareTerminal;
  prepareMembership?: typeof prepareAlertMembershipReplacement;
}

function record(value: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError(`Unknown ${label} field`);
    result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}

function cellIndex(value: TerminalGridCellId): number {
  const index = IDS.indexOf(value);
  if (index < 0) throw new TypeError('Unknown terminal grid cell id');
  return index;
}

function layoutValue(value: unknown): TerminalGridLayout {
  if (value !== 1 && value !== 2 && value !== 4)
    throw new TypeError('Terminal grid layout must be 1, 2 or 4');
  return value;
}

function syncValue(value: unknown, base: TerminalGridSync): TerminalGridSync {
  const fields = record(value, 'terminal grid sync', SYNC_KEYS);
  const next = { ...base, ...fields } as TerminalGridSync;
  if (typeof next.viewport !== 'boolean' || typeof next.crosshair !== 'boolean')
    throw new TypeError('Terminal grid sync toggles must be booleans');
  if (next.crosshairMatch !== 'exact' && next.crosshairMatch !== 'nearest')
    throw new TypeError('Terminal grid crosshair match must be exact or nearest');
  return next;
}

function copyMonitorState(value: PriceAlertMonitorState): PriceAlertMonitorState {
  return {
    providerId: value.providerId,
    destroyed: value.destroyed,
    queries: value.queries.map((entry) => ({
      query: { ...entry.query },
      status: entry.status,
      error: entry.error ? { ...entry.error } : null,
    })),
  };
}

function copyState(value: TerminalGridState): TerminalGridState {
  return {
    layout: value.layout,
    activeCellId: value.activeCellId,
    sync: { ...value.sync },
    cells: value.cells.map((cell) => ({
      id: cell.id,
      mounted: cell.mounted,
      query: { ...cell.query },
      terminal: cell.terminal
        ? {
            ...cell.terminal,
            layout: {
              ...cell.terminal.layout,
              panes: cell.terminal.layout.panes.map((pane) => ({ ...pane })),
            },
            feed: {
              ...cell.terminal.feed,
              query: cell.terminal.feed.query ? { ...cell.terminal.feed.query } : null,
              error: cell.terminal.feed.error ? { ...cell.terminal.feed.error } : null,
            },
            settings: { ...cell.terminal.settings },
            studies: cell.terminal.studies.map((study) => ({ ...study })),
          }
        : null,
    })),
    alertState: copyMonitorState(value.alertState),
    error: value.error,
    destroyed: value.destroyed,
  };
}

function frozenEvent(event: PriceAlertEvent): PriceAlertEvent {
  return Object.freeze({ ...event, query: Object.freeze({ ...event.query }) });
}

function mergedWorkspace(slot: Pick<GridSlot, 'workspace' | 'store' | 'terminal'>): TerminalWorkspace {
  const source = slot.terminal ? slot.terminal.api.getWorkspace() : slot.workspace;
  return copyWorkspaceDocument({ ...source, alerts: copyPriceAlertDocument(slot.store.toJSON()) });
}

function terminalOptions(
  provider: TerminalGridOptions['provider'],
  query: MarketQuery,
  catalog: { symbols: string[]; intervals: string[] },
  source: TerminalGridOptions,
  store: PriceAlertStore,
  monitor: PriceAlertMonitor,
  onState: () => void,
  initial: boolean,
): TerminalOptions {
  return {
    provider,
    query: { ...query },
    symbols: [...catalog.symbols],
    intervals: [...catalog.intervals],
    ...(source.feed === undefined ? {} : { feed: source.feed }),
    ...(initial && source.settings !== undefined ? { settings: source.settings } : {}),
    ...(initial && source.studies !== undefined ? { studies: source.studies } : {}),
    alerts: { store, monitor },
    onState,
  };
}

export function createTerminalGridWithDependencies(
  host: HTMLElement,
  sourceOptions: TerminalGridOptions,
  dependencies: GridDependencies = {},
): TerminalGridApi {
  if (!host?.ownerDocument?.defaultView) throw new TypeError('A browser HTMLElement host is required');
  const optionFields = record(sourceOptions, 'terminal grid options', OPTION_KEYS);
  if (!Object.hasOwn(optionFields, 'provider') || !Object.hasOwn(optionFields, 'query'))
    throw new TypeError('Terminal grid provider and query are required');
  const options = optionFields as unknown as TerminalGridOptions;
  const provider = options.provider;
  if (!provider || typeof provider !== 'object') throw new TypeError('A market data provider is required');
  const providerId = provider.id;
  if (typeof providerId !== 'string' || !providerId || providerId.trim() !== providerId)
    throw new TypeError('Provider id must be a nonblank string');
  const initialQuery = resolveQuery(options.query);
  const catalog = resolveCatalog(initialQuery, options.symbols, options.intervals);
  const initialLayout = layoutValue(options.layout ?? 1);
  const initialSync = syncValue(options.sync ?? {}, DEFAULT_SYNC);
  if (options.onState !== undefined && typeof options.onState !== 'function')
    throw new TypeError('onState must be a function');
  if (options.onAlert !== undefined && typeof options.onAlert !== 'function')
    throw new TypeError('onAlert must be a function');
  const alertOptions =
    options.alerts === undefined ? null : record(options.alerts, 'terminal grid alerts', ALERT_KEYS);
  const suppliedStoresValue = alertOptions?.stores;
  let suppliedStores: Readonly<Record<TerminalGridCellId, PriceAlertStore>> | null = null;
  if (suppliedStoresValue !== undefined) {
    const candidate = record(suppliedStoresValue, 'terminal grid stores', new Set(IDS));
    if (Reflect.ownKeys(candidate).length !== 4 || IDS.some((id) => !Object.hasOwn(candidate, id)))
      throw new TypeError('Supplied terminal grid stores require exactly four cell IDs');
    for (const id of IDS)
      if (!candidate[id] || typeof candidate[id] !== 'object' || Array.isArray(candidate[id]))
        throw new TypeError(`Supplied terminal grid store ${id} must be an object`);
    suppliedStores = candidate as unknown as Readonly<Record<TerminalGridCellId, PriceAlertStore>>;
  }
  const suppliedMonitor = alertOptions?.monitor as PriceAlertMonitor | undefined;
  if (suppliedMonitor !== undefined && (!suppliedMonitor || typeof suppliedMonitor !== 'object'))
    throw new TypeError('Alert monitor must be an object');
  if (suppliedMonitor && suppliedMonitor.getState().providerId !== providerId)
    throw new TypeError('Alert monitor provider does not match grid provider');
  if (instanceNumber >= Number.MAX_SAFE_INTEGER)
    throw new RangeError('Terminal grid instance scope limit exhausted');
  const instanceId = ++instanceNumber;
  const monitor = suppliedMonitor ?? createPriceAlertMonitor({ provider });
  const ownsMonitor = suppliedMonitor === undefined;
  const preparation = dependencies.prepareTerminal ?? prepareTerminal;
  const prepareMembership = dependencies.prepareMembership ?? prepareAlertMembershipReplacement;
  const lifecycle = createGridLifecycle();
  const shell = host.ownerDocument.createElement('div');
  shell.className = 'filtix-terminal-grid';
  shell.dataset.filtixTerminalGridShell = String(instanceId);
  shell.dataset.theme = options.settings?.theme === 'light' ? 'light' : 'dark';
  const style = host.ownerDocument.createElement('style');
  style.textContent = GRID_STYLE;
  const toolbar = host.ownerDocument.createElement('div');
  const region = host.ownerDocument.createElement('div');
  region.className = 'filtix-terminal-grid-region';
  region.dataset.filtixTerminalGrid = String(instanceId);
  shell.append(style, toolbar, region);
  let slots: GridSlot[] = [];
  let layout = initialLayout;
  let activeCellId: TerminalGridCellId = 'cell-1';
  let sync = initialSync;
  const gridSync = createGridSyncController();
  const syncedQueries = new WeakMap<PreparedTerminal, { feed: MarketQuery; current: MarketQuery }>();
  let error: string | null = null;
  let dead = false;
  let finalWorkspace: TerminalGridWorkspace | null = null;
  let finalState: TerminalGridState | null = null;
  let unsubscribeMonitor: (() => void) | null = null;
  let notifying = false;
  let notifyAgain = false;
  let controls: GridControls | null = null;
  let gridResizeObserver: ResizeObserver | null = null;
  let suppressedFocusTarget: HTMLElement | null = null;
  let observedWidth = -1;
  let observedHeight = -1;
  let observedLayout: TerminalGridLayout | null = null;

  function refreshColumns(): void {
    if (dead) return;
    const bounds = host.getBoundingClientRect();
    const width = bounds.width;
    const height = bounds.height;
    if (width <= 0 || height <= 0) return;
    if (width === observedWidth && height === observedHeight && layout === observedLayout) return;
    observedWidth = width;
    observedHeight = height;
    observedLayout = layout;
    region.dataset.columns = String(layout === 1 || width < 800 ? 1 : 2);
  }

  function refreshUi(): void {
    if (dead || !controls) return;
    const active = slots[cellIndex(activeCellId)];
    const theme =
      active?.terminal?.api.getState().settings.theme ?? active?.workspace.settings.theme ?? 'dark';
    if (shell.dataset.theme !== theme) shell.dataset.theme = theme;
    for (const slot of slots) {
      const selected = String(slot.id === activeCellId);
      if (slot.wrapper && slot.wrapper.dataset.active !== selected) slot.wrapper.dataset.active = selected;
    }
    refreshColumns();
    controls.refresh();
  }

  function selectInteractedCell(event: Event): void {
    if (
      dead ||
      (event.type === 'focusin' && event.target === suppressedFocusTarget) ||
      !(event.target instanceof Element)
    )
      return;
    const cell = event.target.closest<HTMLElement>('[data-filtix-grid-cell]');
    if (!cell || !region.contains(cell)) return;
    const id = cell.dataset.filtixGridCell as TerminalGridCellId;
    if (!IDS.includes(id) || cellIndex(id) >= layout || activeCellId === id) return;
    api.setActiveCell(id);
  }

  function disposeUi(): void {
    region.removeEventListener('pointerdown', selectInteractedCell);
    region.removeEventListener('focusin', selectInteractedCell);
    gridResizeObserver?.disconnect();
    gridResizeObserver = null;
    controls?.destroy();
    controls = null;
  }

  function readWorkspace(): TerminalGridWorkspace {
    return {
      schema: 'filtix-terminal-grid',
      version: 1,
      providerId,
      layout,
      activeCellId,
      sync: { ...sync },
      cells: slots.map((slot) => ({ id: slot.id, workspace: mergedWorkspace(slot) })),
    };
  }

  function readState(): TerminalGridState {
    return {
      layout,
      activeCellId,
      sync: { ...sync },
      cells: slots.map((slot) => ({
        id: slot.id,
        mounted: slot.terminal !== null,
        query: { ...(slot.terminal ? slot.terminal.api.getWorkspace().query : slot.workspace.query) },
        terminal: slot.terminal ? slot.terminal.api.getState() : null,
      })),
      alertState: copyMonitorState(monitor.getState()),
      error,
      destroyed: dead,
    };
  }

  function sameQuery(a: MarketQuery, b: MarketQuery): boolean {
    return a.symbol === b.symbol && a.interval === b.interval;
  }

  function syncReady(slot: GridSlot): boolean {
    const handle = slot.terminal;
    if (!handle) return false;
    const feed = handle.api.getState().feed;
    if (!feed.query || feed.bars <= 0) return false;
    try {
      handle.api.chart.getChangeRevision();
      if (handle.api.chart.getVisibleTimeRange() === null) return false;
    } catch (failure) {
      if (isChartError(failure) && failure.code === 'DESTROYED') return false;
      throw failure;
    }
    let queries = syncedQueries.get(handle);
    if (!queries || !sameQuery(queries.feed, feed.query)) {
      queries = { feed: { ...feed.query }, current: { ...handle.api.getWorkspace().query } };
      syncedQueries.set(handle, queries);
    }
    return sameQuery(queries.current, feed.query);
  }

  function refreshSync(): void {
    if (dead) return;
    gridSync.update(
      slots
        .slice(0, layout)
        .flatMap((slot) =>
          slot.terminal ? [{ id: slot.id, chart: slot.terminal.api.chart, ready: syncReady(slot) }] : [],
        ),
      activeCellId,
      sync,
    );
  }

  function notifyState(): void {
    if (dead) return;
    try {
      refreshSync();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (dead) return;
    refreshUi();
    if (!options.onState) return;
    if (notifying) {
      notifyAgain = true;
      return;
    }
    notifying = true;
    try {
      lifecycle.repair(() => {
        notifyAgain = false;
        try {
          options.onState!(copyState(readState()));
        } catch {
          /* Isolate host observers. */
        }
        if (notifyAgain) lifecycle.beginPreferenceMutation();
      });
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      notifying = false;
    }
  }

  function makeWrapper(): HTMLDivElement {
    const wrapper = host.ownerDocument.createElement('div');
    wrapper.dataset.filtixGridCell = '';
    wrapper.className = 'filtix-terminal-grid-cell';
    wrapper.style.minWidth = '0';
    wrapper.style.minHeight = '360px';
    return wrapper;
  }

  function makePrepared(
    id: TerminalGridCellId,
    store: PriceAlertStore,
    workspace: TerminalWorkspace | undefined,
    initial: boolean,
  ): { wrapper: HTMLDivElement; terminal: PreparedTerminal } {
    const wrapper = makeWrapper();
    wrapper.dataset.filtixGridCell = id;
    let handle: PreparedTerminal | null = null;
    const onState = () => {
      if (!dead && handle && slots[cellIndex(id)]?.terminal === handle) notifyState();
    };
    const terminal = preparation(
      wrapper,
      terminalOptions(
        provider,
        workspace?.query ?? initialQuery,
        catalog,
        options,
        store,
        monitor,
        onState,
        initial,
      ),
      workspace,
    );
    handle = terminal;
    return { wrapper, terminal };
  }

  function listenSlot(slot: GridSlot): void {
    const store = slot.store;
    const id = slot.id;
    slot.unsubscribeEvents = store.subscribeEvents((event) => {
      if (dead || slots[cellIndex(id)]?.store !== store) return;
      try {
        options.onAlert?.(id, frozenEvent(event));
      } catch {
        /* Isolate host observers. */
      }
    });
  }

  function cleanupStaging(staged: readonly StagedSlot[], destroyStores: boolean): void {
    for (const slot of staged) {
      try {
        slot.terminal?.destroy();
      } catch {
        /* Continue complete cleanup. */
      }
      try {
        slot.wrapper?.remove();
      } catch {
        /* Detached staging. */
      }
    }
    if (destroyStores)
      for (const slot of staged)
        if (slot.ownsStore)
          try {
            slot.store.destroy();
          } catch {
            /* Continue complete cleanup. */
          }
  }

  function releaseSlot(slot: GridSlot, destroyStore: boolean): void {
    try {
      slot.unsubscribeEvents?.();
    } catch {
      /* Continue cleanup. */
    }
    try {
      slot.terminal?.destroy();
    } catch {
      /* Continue cleanup. */
    }
    try {
      slot.terminalLease?.();
    } catch {
      /* Continue cleanup. */
    }
    try {
      slot.gridLease();
    } catch {
      /* Continue cleanup. */
    }
    try {
      slot.wrapper?.remove();
    } catch {
      /* Continue cleanup. */
    }
    if (destroyStore && slot.ownsStore)
      try {
        slot.store.destroy();
      } catch {
        /* Continue cleanup. */
      }
  }

  function adoptNodes(next: readonly (HTMLDivElement | null)[]): () => void {
    const prior = [...region.childNodes];
    try {
      region.replaceChildren(...next.filter((node): node is HTMLDivElement => node !== null));
    } catch (failure) {
      region.replaceChildren(...prior);
      throw failure;
    }
    return () => region.replaceChildren(...prior);
  }

  function restoreAdoptionFocus(priorFocus: HTMLElement | null, retained: boolean): void {
    if (!priorFocus || dead) return;
    const doc = host.ownerDocument;
    const current = doc.activeElement;
    if (current && current !== doc.body && current !== doc.documentElement) return;
    if (retained && priorFocus.isConnected) {
      suppressedFocusTarget = priorFocus;
      try {
        priorFocus.focus({ preventScroll: true });
      } finally {
        suppressedFocusTarget = null;
      }
    } else {
      toolbar.querySelector<HTMLButtonElement>(`[data-grid-layout="${layout}"]`)?.focus();
    }
  }

  async function startAdded(ticket: number, added: readonly GridSlot[]): Promise<void> {
    for (const slot of added) {
      lifecycle.assertStartupCurrent(ticket);
      if (
        slots[cellIndex(slot.id)]?.terminal !== slot.terminal ||
        slots[cellIndex(slot.id)]?.terminalLease !== slot.terminalLease
      )
        throw new TerminalMutationSupersededError();
      try {
        await slot.terminal!.start({ alertLease: slot.terminalLease! });
        lifecycle.assertStartupCurrent(ticket);
        if (
          slots[cellIndex(slot.id)]?.terminal !== slot.terminal ||
          slots[cellIndex(slot.id)]?.terminalLease !== slot.terminalLease
        )
          throw new TerminalMutationSupersededError();
        if (slot.terminal!.getAlertLease() !== slot.terminalLease)
          throw new Error('Prepared terminal did not adopt its exact alert lease');
      } catch (failure) {
        if (isTerminalMutationSuperseded(failure)) throw failure;
        if (!dead && slots[cellIndex(slot.id)]?.terminal === slot.terminal) {
          error = failure instanceof Error ? failure.message : String(failure);
          notifyState();
        }
      }
    }
  }

  function finishAdoption(
    ticket: number,
    old: readonly GridSlot[],
    next: readonly GridSlot[],
    added: readonly GridSlot[],
    replace: boolean,
    priorFocus: HTMLElement | null,
    retainedFocus: boolean,
  ): Promise<void> {
    // Old resources retire only after slots, DOM and generation all identify the new grid.
    try {
      try {
        refreshSync();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      for (const prior of old) {
        const current = next[cellIndex(prior.id)];
        if (replace || current?.terminal !== prior.terminal) {
          try {
            prior.terminal?.destroy();
          } catch {
            /* Continue retirement. */
          }
          try {
            prior.terminalLease?.();
          } catch {
            /* C consumed this exact token. */
          }
          try {
            prior.wrapper?.remove();
          } catch {
            /* Continue retirement. */
          }
        }
        if (replace) {
          try {
            prior.unsubscribeEvents?.();
          } catch {
            /* Continue retirement. */
          }
          try {
            prior.gridLease();
          } catch {
            /* C consumed this exact token. */
          }
          if (prior.ownsStore)
            try {
              prior.store.destroy();
            } catch {
              /* Continue retirement. */
            }
        }
      }
    } finally {
      lifecycle.finishActivation();
    }
    try {
      lifecycle.assertStartupCurrent(ticket);
    } catch (failure) {
      return Promise.reject(failure);
    }
    notifyState();
    try {
      lifecycle.assertStartupCurrent(ticket);
    } catch (failure) {
      return Promise.reject(failure);
    }
    restoreAdoptionFocus(priorFocus, retainedFocus);
    return startAdded(ticket, added);
  }

  async function mutate(
    nextLayout: TerminalGridLayout,
    document: TerminalGridWorkspace | null,
    ticket: number,
  ): Promise<void> {
    await lifecycle.waitForActivation(ticket);
    const old = slots;
    if (
      document === null &&
      nextLayout === layout &&
      old.every(
        (slot) =>
          cellIndex(slot.id) >= nextLayout ||
          (slot.terminal !== null && slot.terminal.getAlertLease() === slot.terminalLease),
      )
    )
      return;
    const replace = document !== null;
    const staged: StagedSlot[] = [];
    const added: StagedSlot[] = [];
    let transaction: ReturnType<typeof prepareAlertMembershipReplacement> | null = null;
    let adopted = false;
    try {
      if (replace) {
        for (const id of IDS) {
          const workspace = copyWorkspaceDocument(document.cells[cellIndex(id)]!.workspace);
          const store = createPriceAlertStore({ providerId, scopeId: workspace.alerts.scopeId });
          const slot: StagedSlot = {
            id,
            workspace,
            store,
            ownsStore: true,
            gridLease: null,
            terminalLease: null,
            terminal: null,
            wrapper: null,
            unsubscribeEvents: null,
          };
          staged.push(slot);
          store.restore(workspace.alerts);
          if (cellIndex(id) < nextLayout) {
            const mounted = makePrepared(id, store, workspace, false);
            slot.terminal = mounted.terminal;
            slot.wrapper = mounted.wrapper;
            added.push(slot);
          }
        }
      } else {
        for (const prior of old) {
          const visible = cellIndex(prior.id) < nextLayout;
          const retain =
            visible && prior.terminal !== null && prior.terminal.getAlertLease() === prior.terminalLease;
          const slot: StagedSlot = {
            ...prior,
            workspace: mergedWorkspace(prior),
            terminal: retain ? prior.terminal : null,
            wrapper: retain ? prior.wrapper : null,
            terminalLease: retain ? prior.terminalLease : null,
          };
          staged.push(slot);
          if (visible && !retain) {
            const mounted = makePrepared(prior.id, prior.store, slot.workspace, false);
            slot.terminal = mounted.terminal;
            slot.wrapper = mounted.wrapper;
            added.push(slot);
          }
        }
      }
      lifecycle.assertCurrent(ticket);
      const retire = replace
        ? [
            ...old.map((slot) => slot.gridLease),
            ...old.flatMap((slot) => (slot.terminalLease ? [slot.terminalLease] : [])),
          ]
        : old.flatMap((slot) =>
            staged[cellIndex(slot.id)]!.terminal !== slot.terminal && slot.terminalLease
              ? [slot.terminalLease]
              : [],
          );
      const attach = replace
        ? [...staged.map((slot) => slot.store), ...added.map((slot) => slot.store)]
        : added.map((slot) => slot.store);
      transaction = prepareMembership(monitor, { retire, attach });
      lifecycle.assertCurrent(ticket);
      const activeElement = host.ownerDocument.activeElement;
      const priorFocus =
        activeElement instanceof HTMLElement && region.contains(activeElement) ? activeElement : null;
      const retainedFocus = priorFocus !== null && staged.some((slot) => slot.wrapper?.contains(priorFocus));
      const rollbackNodes = adoptNodes(staged.map((slot) => slot.wrapper));
      let leases: readonly (() => void)[];
      try {
        leases = lifecycle.commit(ticket, transaction);
      } catch (failure) {
        rollbackNodes();
        throw failure;
      }
      adopted = true;
      let offset = 0;
      if (replace) for (const slot of staged) slot.gridLease = leases[offset++]!;
      for (const slot of added) slot.terminalLease = leases[offset++]!;
      slots = staged as GridSlot[];
      layout = nextLayout;
      activeCellId = replace
        ? document.activeCellId
        : cellIndex(activeCellId) < nextLayout
          ? activeCellId
          : 'cell-1';
      if (replace) sync = { ...document.sync };
      error = null;
      if (replace) for (const slot of slots) listenSlot(slot);
      await finishAdoption(ticket, old, slots, added as GridSlot[], replace, priorFocus, retainedFocus);
    } catch (failure) {
      if (!adopted) {
        transaction?.abort();
        if (replace) cleanupStaging(staged, true);
        else cleanupStaging(added, false);
      } else {
        lifecycle.finishActivation();
      }
      throw failure;
    }
  }

  // Initial creation uses the first ordinary prepared terminal as the exact
  // settings/study/layout template. Parked cells never allocate a chart.
  const initial: StagedSlot[] = [];
  let firstTicket = 0;
  let firstAdopted = false;
  let initialTransaction: ReturnType<typeof prepareAlertMembershipReplacement> | null = null;
  try {
    const seenStores = new Set<PriceAlertStore>();
    const seenScopes = new Set<string>();
    for (const id of IDS) {
      const store =
        suppliedStores?.[id] ??
        createPriceAlertStore({ providerId, scopeId: `grid-${instanceId}:${id}:alerts` });
      const document = store.toJSON();
      if (document.providerId !== providerId || seenStores.has(store) || seenScopes.has(document.scopeId))
        throw new TypeError(
          'Supplied terminal grid stores require distinct compatible identities and scopes',
        );
      seenStores.add(store);
      seenScopes.add(document.scopeId);
      initial.push({
        id,
        store,
        ownsStore: !suppliedStores,
        workspace: null as unknown as TerminalWorkspace,
        gridLease: null,
        terminalLease: null,
        terminal: null,
        wrapper: null,
        unsubscribeEvents: null,
      });
    }
    const first = makePrepared('cell-1', initial[0]!.store, undefined, true);
    initial[0]!.terminal = first.terminal;
    initial[0]!.wrapper = first.wrapper;
    const template = first.terminal.api.getWorkspace();
    for (const slot of initial)
      slot.workspace = copyWorkspaceDocument({
        ...template,
        alerts: copyPriceAlertDocument(slot.store.toJSON()),
      });
    for (let index = 1; index < initialLayout; index++) {
      const slot = initial[index]!;
      const mounted = makePrepared(slot.id, slot.store, slot.workspace, false);
      slot.terminal = mounted.terminal;
      slot.wrapper = mounted.wrapper;
    }
    const canonical = decodeGridWorkspace(
      {
        schema: 'filtix-terminal-grid',
        version: 1,
        providerId,
        layout: initialLayout,
        activeCellId,
        sync: initialSync,
        cells: initial.map((slot) => ({ id: slot.id, workspace: slot.workspace })),
      },
      {
        providerId,
        symbols: catalog.symbols,
        intervals: catalog.intervals,
        legacyAlertScopeIds: Object.fromEntries(
          initial.map((slot) => [slot.id, slot.store.toJSON().scopeId]),
        ) as Record<TerminalGridCellId, string>,
      },
    );
    for (let index = 0; index < 4; index++) initial[index]!.workspace = canonical.cells[index]!.workspace;
    firstTicket = lifecycle.beginMutation();
    initialTransaction = prepareMembership(monitor, {
      retire: [],
      attach: [
        ...initial.map((slot) => slot.store),
        ...initial.slice(0, initialLayout).map((slot) => slot.store),
      ],
    });
    host.append(shell);
    let rollback: () => void;
    try {
      rollback = adoptNodes(initial.map((slot) => slot.wrapper));
    } catch (failure) {
      shell.remove();
      throw failure;
    }
    let leases: readonly (() => void)[];
    try {
      leases = lifecycle.commit(firstTicket, initialTransaction);
    } catch (failure) {
      rollback();
      shell.remove();
      throw failure;
    }
    firstAdopted = true;
    for (let index = 0; index < 4; index++) initial[index]!.gridLease = leases[index]!;
    for (let index = 0; index < initialLayout; index++) initial[index]!.terminalLease = leases[index + 4]!;
    slots = initial as GridSlot[];
    for (const slot of slots) listenSlot(slot);
    unsubscribeMonitor = monitor.subscribe(() => {
      if (!dead) notifyState();
    });
    lifecycle.finishActivation();
    notifyState();
    for (const slot of slots.slice(0, initialLayout)) {
      try {
        lifecycle.assertStartupCurrent(firstTicket);
      } catch {
        break;
      }
      if (slots[cellIndex(slot.id)]?.terminal !== slot.terminal) break;
      void slot.terminal!.start({ alertLease: slot.terminalLease! }).catch((failure) => {
        if (dead || slots[cellIndex(slot.id)]?.terminal !== slot.terminal) return;
        error = failure instanceof Error ? failure.message : String(failure);
        notifyState();
      });
    }
  } catch (failure) {
    if (!firstAdopted) {
      initialTransaction?.abort();
      cleanupStaging(initial, true);
      shell.remove();
      if (ownsMonitor) monitor.destroy();
    } else {
      lifecycle.finishActivation();
      // Adoption is final. An operational callback failure belongs to the new grid.
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (!firstAdopted) throw failure;
  }

  const api: TerminalGridApi = {
    getState() {
      return copyState(finalState ?? readState());
    },
    setLayout(next) {
      if (dead) return Promise.reject(new Error('Terminal grid has been destroyed'));
      let parsed: TerminalGridLayout;
      try {
        parsed = layoutValue(next);
      } catch (failure) {
        return Promise.reject(failure);
      }
      const ticket = lifecycle.beginMutation();
      return mutate(parsed, null, ticket);
    },
    setActiveCell(id) {
      if (dead) throw new Error('Terminal grid has been destroyed');
      const index = cellIndex(id);
      if (index >= layout) throw new TypeError('Terminal grid active cell must be visible');
      if (activeCellId === id) return;
      lifecycle.beginPreferenceMutation();
      activeCellId = id;
      notifyState();
    },
    setSync(patch) {
      if (dead) throw new Error('Terminal grid has been destroyed');
      const next = syncValue(patch, sync);
      if (
        next.viewport === sync.viewport &&
        next.crosshair === sync.crosshair &&
        next.crosshairMatch === sync.crosshairMatch
      )
        return;
      lifecycle.beginPreferenceMutation();
      sync = next;
      notifyState();
    },
    getTerminal(id) {
      const index = cellIndex(id);
      return dead ? null : (slots[index]?.terminal?.api ?? null);
    },
    getWorkspace() {
      return copyGridWorkspace(finalWorkspace ?? readWorkspace());
    },
    restoreWorkspace(value) {
      if (dead) return Promise.reject(new Error('Terminal grid has been destroyed'));
      const beforeDecode = lifecycle.generation;
      let document: TerminalGridWorkspace;
      try {
        document = decodeGridWorkspace(value, {
          providerId,
          symbols: catalog.symbols,
          intervals: catalog.intervals,
          legacyAlertScopeIds: Object.fromEntries(
            slots.map((slot) => [slot.id, slot.store.toJSON().scopeId]),
          ) as Record<TerminalGridCellId, string>,
        });
      } catch (failure) {
        if (dead || lifecycle.generation !== beforeDecode)
          return Promise.reject(new TerminalMutationSupersededError());
        return Promise.reject(failure);
      }
      if (dead || lifecycle.generation !== beforeDecode)
        return Promise.reject(new TerminalMutationSupersededError());
      const ticket = lifecycle.beginMutation();
      return mutate(document.layout, document, ticket);
    },
    destroy() {
      if (dead) return;
      finalWorkspace = copyGridWorkspace(readWorkspace());
      finalState = copyState({ ...readState(), destroyed: true });
      dead = true;
      lifecycle.destroy(() => {
        try {
          gridSync.destroy();
        } catch {
          /* Continue complete resource cleanup. */
        }
        try {
          unsubscribeMonitor?.();
        } catch {
          /* Continue cleanup. */
        }
        disposeUi();
        for (const slot of slots) releaseSlot(slot, true);
        shell.remove();
        if (ownsMonitor) monitor.destroy();
      });
    },
  };
  try {
    // Native controls need only grid preferences. Public getState also reads each
    // terminal workspace and must retain its full defensive-copy semantics.
    controls = createGridControls(toolbar, {
      getState: () => ({ layout, activeCellId, sync: { ...sync } }),
      setLayout: api.setLayout,
      setActiveCell: api.setActiveCell,
      setSync: api.setSync,
    });
    region.addEventListener('pointerdown', selectInteractedCell);
    region.addEventListener('focusin', selectInteractedCell);
    gridResizeObserver = new host.ownerDocument.defaultView!.ResizeObserver(refreshColumns);
    gridResizeObserver.observe(host);
    refreshUi();
  } catch (failure) {
    api.destroy();
    throw failure;
  }
  return Object.freeze(api);
}

export function createTerminalGrid(host: HTMLElement, options: TerminalGridOptions): TerminalGridApi {
  return createTerminalGridWithDependencies(host, options);
}
