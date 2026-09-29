import { createChart, type ChartApi, type PaneHandle, type SeriesHandle } from '@filtix/charts';
import { hasOwnedStudyColumnCapability, setOwnedPriceVolumeData } from '@filtix/charts/internal';
import {
  createFeedSession,
  type FeedChange,
  type FeedSession,
  type FeedState,
  type MarketBar,
  type MarketQuery,
} from '@filtix/datafeed';
import {
  createDrawingLayer,
  createDrawingStore,
  copyDrawingDocument,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingStore,
  type DrawingTool,
} from '@filtix/drawings';
import {
  createPriceAlertMonitor,
  createPriceAlertStore,
  type PriceAlertEvent,
  type PriceAlertMonitor,
  type PriceAlertStore,
} from '@filtix/alerts';
import {
  prepareAlertMembershipReplacement,
  preparePriceAlertStoreRestore,
  type PreparedAlertMembership,
  type PreparedPriceAlertStoreRestore,
} from '@filtix/alerts/internal';
import {
  copyLayout,
  defaultLayout,
  reconcileLayout,
  resolveLayout,
  sameLayout,
  visiblePaneIds,
} from './layout';
import { TerminalLayoutRuntime } from './layout-runtime';
import { presentationFor, type TerminalPresentation } from './responsive-layout';
import { createTerminalLayoutControls, type TerminalLayoutControls } from './terminal-layout-controls';
import { createStudyControls, type TerminalStudyControls } from './study-controls';
import { createDrawingControls, type TerminalDrawingControls } from './drawing-controls';
import { createAlertControls, type TerminalAlertControls } from './alert-controls';
import { createTerminalPreparationLifecycle, type PreparedTerminal } from './terminal-preparation';
import {
  isTerminalMutationSuperseded,
  reportUnlessMutationSuperseded,
  TerminalMutationSupersededError,
} from './mutation';
import { TerminalStudyRuntime, type TerminalStudyRuntimeFactories } from './study-runtime';
import {
  LEGACY_EMA_ID,
  StudyIdAllocator,
  copyStudies,
  legacyEma,
  projectedEmaPeriod,
  resolveStudyId,
  resolveStudyOptions,
  resolveStudyPatch,
  sameStudy,
  studyCalculationChanged,
  validateStudyCaps,
} from './studies';
import {
  copyQuery,
  copySettings,
  copyWorkspaceDocument,
  decodeWorkspace,
  queryKey,
  resolveCatalog,
  resolveQuery,
  resolveSettings,
} from './codec';
import type {
  TerminalApi,
  TerminalOptions,
  TerminalLayout,
  TerminalLayoutPatch,
  TerminalSettings,
  TerminalState,
  TerminalStudy,
  TerminalStudyOptions,
  TerminalStudyPatch,
  TerminalWorkspace,
} from './types';

let nextInstance = 0;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyFeedState(state: FeedState): FeedState {
  return {
    ...state,
    query: state.query ? { ...state.query } : null,
    error: state.error ? { ...state.error } : null,
  };
}

function emptyFeedState(): FeedState {
  return {
    status: 'idle',
    query: null,
    bars: 0,
    loadingMore: false,
    hasMore: false,
    lastUpdateAt: null,
    retryCount: 0,
    error: null,
  };
}

interface TerminalElements {
  root: HTMLDivElement;
  style: HTMLStyleElement;
  chart: HTMLDivElement;
  body: HTMLDivElement;
  symbol: HTMLSelectElement;
  interval: HTMLSelectElement;
  theme: HTMLSelectElement;
  volume: HTMLInputElement;
  ema: HTMLInputElement;
  status: HTMLSpanElement;
  error: HTMLDivElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
  remove: HTMLButtonElement;
  magnet: HTMLButtonElement;
  toolButtons: Map<DrawingTool, HTMLButtonElement>;
  toolbar: HTMLDivElement;
}

function option(doc: Document, value: string): HTMLOptionElement {
  const item = doc.createElement('option');
  item.value = value;
  item.textContent = value;
  return item;
}

function button(doc: Document, label: string, action: string): HTMLButtonElement {
  const item = doc.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.dataset.terminalAction = action;
  return item;
}

function labelled(doc: Document, text: string, control: HTMLElement): HTMLLabelElement {
  const label = doc.createElement('label');
  const caption = doc.createElement('span');
  caption.textContent = text;
  if (text === 'Volume' || text === 'EMA') caption.dataset.terminalCompactLabel = '';
  label.append(caption, control);
  return label;
}

function createElements(
  doc: Document,
  symbols: readonly string[],
  intervals: readonly string[],
  settings: TerminalSettings,
): TerminalElements {
  const root = doc.createElement('div');
  const instance = `filtix-terminal-${++nextInstance}`;
  root.dataset.filtixTerminal = '';
  root.dataset.filtixTerminalInstance = instance;
  root.dataset.theme = settings.theme;
  root.style.cssText =
    'width:100%;height:100%;min-width:0;min-height:0;display:grid;grid-template-rows:max-content minmax(0,1fr) max-content;overflow:hidden;background:var(--filtix-terminal-bg,#151715);color:var(--filtix-terminal-text,#f4eddc);font:var(--filtix-terminal-font,500 13px/1.25 ui-sans-serif,system-ui,sans-serif);container-type:inline-size;';
  const scope = `[data-filtix-terminal-instance="${instance}"]`;
  const style = doc.createElement('style');
  style.textContent = `
${scope}{--filtix-terminal-bg:#151715;--filtix-terminal-panel:#20231f;--filtix-terminal-text:#f4eddc;--filtix-terminal-muted:#9a9f91;--filtix-terminal-accent:#c7ef57;--filtix-terminal-copper:#c27a50;--filtix-terminal-border:#353a33;color-scheme:dark}
${scope}[data-theme="light"]{--filtix-terminal-bg:#f3efe4;--filtix-terminal-panel:#fffaf0;--filtix-terminal-text:#1b1d19;--filtix-terminal-muted:#686d63;--filtix-terminal-accent:#6b8e16;--filtix-terminal-copper:#9a5838;--filtix-terminal-border:#cfc8b8;color-scheme:light}
${scope} *{box-sizing:border-box}
${scope} [data-terminal-toolbar]{display:flex;flex-wrap:wrap;align-content:start;gap:6px;padding:8px;max-height:25%;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;border-bottom:1px solid var(--filtix-terminal-border);background:var(--filtix-terminal-panel)}
${scope} label{display:flex;align-items:center;gap:5px;color:var(--filtix-terminal-muted);white-space:nowrap}
${scope} button,${scope} select,${scope} input{min-height:34px;border:1px solid var(--filtix-terminal-border);border-radius:4px;background:var(--filtix-terminal-bg);color:var(--filtix-terminal-text);font:inherit}
${scope} button{padding:5px 9px;cursor:pointer}
${scope} button[aria-pressed="true"]{border-color:var(--filtix-terminal-accent);color:var(--filtix-terminal-accent)}
${scope} button:focus-visible,${scope} select:focus-visible,${scope} input:focus-visible{outline:2px solid var(--filtix-terminal-accent);outline-offset:1px}
${scope} [data-terminal-studies-toggle]{margin-left:auto}
${scope} [data-terminal-studies-panel]{min-width:0;min-height:0;max-width:100%;max-height:100%;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;padding:8px;border-left:1px solid var(--filtix-terminal-border);background:color-mix(in srgb,var(--filtix-terminal-panel) 92%,var(--filtix-terminal-accent) 8%)}
${scope} [data-terminal-studies-heading]{position:sticky;top:-8px;z-index:2;padding:8px 0;background:var(--filtix-terminal-panel);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--filtix-terminal-accent);margin-bottom:7px}
${scope} [data-terminal-studies-error]{min-height:0;margin-bottom:6px;color:var(--filtix-terminal-copper);font-size:11px}
${scope} [data-terminal-studies-error]:empty{display:none}
${scope} [data-terminal-studies-add],${scope} [data-terminal-study-row]{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,82px),1fr));gap:6px;align-items:end;min-width:0}
${scope} [data-terminal-study-add]{align-self:end}
${scope} [data-terminal-studies-panel] [hidden]{display:none!important}
${scope} [data-terminal-studies-panel] input[type="checkbox"]{width:18px;min-height:18px;height:18px;align-self:center;justify-self:center;margin:8px auto;accent-color:var(--filtix-terminal-accent)}
${scope} [data-terminal-studies-panel] input[type="color"]{min-width:42px;padding:3px}
${scope} [data-terminal-studies-list]{display:grid;gap:7px;margin-top:8px}
${scope} [data-terminal-study-row]{padding-top:7px;border-top:1px solid var(--filtix-terminal-border)}
${scope} [data-terminal-study-name]{grid-column:1/-1;align-self:center;font-weight:800;color:var(--filtix-terminal-text)}
${scope} [data-terminal-studies-panel] label{display:grid;gap:2px;min-width:0;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
${scope} [data-terminal-studies-panel] input,${scope} [data-terminal-studies-panel] select{width:100%;min-width:0}
${scope} [data-terminal-studies-panel] select{appearance:auto;background-color:var(--filtix-terminal-bg);color:var(--filtix-terminal-text)}
${scope} [data-terminal-drawings-panel]{position:absolute;z-index:5;top:8px;right:8px;width:min(356px,calc(100% - 16px));max-height:min(72%,520px);min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px;border:1px solid var(--filtix-terminal-border);border-top:2px solid var(--filtix-terminal-accent);border-radius:5px;background:var(--filtix-terminal-panel);box-shadow:0 12px 30px #0005}
${scope} [data-terminal-drawings-panel][hidden],${scope} [data-terminal-drawings-panel] [hidden]{display:none!important}
${scope} [data-terminal-drawings-head]{position:sticky;top:-10px;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:2px 0 8px;background:var(--filtix-terminal-panel);border-bottom:1px solid var(--filtix-terminal-border);color:var(--filtix-terminal-accent);letter-spacing:.08em;text-transform:uppercase;font-size:11px}
${scope} [data-terminal-drawings-panel] label{display:grid;gap:3px;min-width:0;white-space:normal;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
${scope} [data-terminal-drawings-panel] input,${scope} [data-terminal-drawings-panel] select,${scope} [data-terminal-drawings-panel] textarea{width:100%;min-width:0;background:var(--filtix-terminal-bg);color:var(--filtix-terminal-text);border:1px solid var(--filtix-terminal-border);border-radius:4px;font:inherit}
${scope} [data-terminal-drawings-panel] textarea{min-height:68px;resize:vertical;padding:6px}
${scope} [data-terminal-drawings-panel] input[type="checkbox"]{width:18px;height:18px;min-height:18px;accent-color:var(--filtix-terminal-accent)}
${scope} [data-terminal-drawing-fields]{display:grid;gap:9px;margin-top:9px}
${scope} [data-terminal-drawing-common],${scope} [data-terminal-drawing-note]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
${scope} [data-terminal-drawing-note] label:first-child{grid-column:1/-1}
${scope} [data-terminal-drawing-fibonacci]{display:grid;gap:7px;border-top:1px solid var(--filtix-terminal-border);padding-top:8px}
${scope} [data-terminal-drawing-fibonacci]>strong{font-size:11px;color:var(--filtix-terminal-accent);text-transform:uppercase;letter-spacing:.08em}
${scope} [data-terminal-level-list]{display:grid;gap:6px}
${scope} [data-terminal-fibonacci-level]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:7px;background:color-mix(in srgb,var(--filtix-terminal-bg) 90%,var(--filtix-terminal-accent) 10%);border:1px solid var(--filtix-terminal-border);border-radius:4px}
${scope} [data-terminal-fibonacci-level] button{align-self:end}
${scope} [data-terminal-drawing-actions]{display:flex;flex-wrap:wrap;gap:6px;border-top:1px solid var(--filtix-terminal-border);padding-top:9px}
${scope} [data-terminal-drawing-apply]{border-color:var(--filtix-terminal-accent);color:var(--filtix-terminal-accent)}
${scope} [data-terminal-drawing-error]{color:var(--filtix-terminal-copper);font-size:11px;line-height:1.35}
${scope} [data-terminal-drawing-error]:empty{display:none}
${scope} [data-terminal-drawing-empty]{margin:10px 0 0;color:var(--filtix-terminal-muted);font-size:11px}
${scope} [data-terminal-drawings-panel] textarea:focus-visible{outline:2px solid var(--filtix-terminal-accent);outline-offset:1px}
${scope} [data-terminal-alerts-panel]{position:absolute;z-index:6;top:8px;right:8px;width:min(440px,calc(100% - 16px));max-height:min(84%,640px);overflow:auto;overscroll-behavior:contain;padding:10px;border:1px solid var(--filtix-terminal-border);border-top:2px solid var(--filtix-terminal-accent);border-radius:5px;background:var(--filtix-terminal-panel);box-shadow:0 12px 30px #0005}
${scope} [data-terminal-alerts-panel][hidden]{display:none!important}
${scope} [data-terminal-alerts-heading]{position:sticky;top:-10px;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;background:var(--filtix-terminal-panel);color:var(--filtix-terminal-accent)}
${scope} [data-terminal-alerts-notice]{color:var(--filtix-terminal-muted);font-size:11px;line-height:1.4}
${scope} [data-terminal-alert-form],${scope} [data-terminal-alert-row]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:8px 0;border-top:1px solid var(--filtix-terminal-border)}
${scope} [data-terminal-alerts-panel] label{display:grid;gap:2px;min-width:0;white-space:normal;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
${scope} [data-terminal-alerts-panel] input,${scope} [data-terminal-alerts-panel] select{width:100%;min-width:0}
${scope} [data-terminal-alert-add],${scope} [data-terminal-alert-save]{border-color:var(--filtix-terminal-accent);color:var(--filtix-terminal-accent)}
${scope} [data-terminal-alert-status],${scope} [data-terminal-alert-transport]{font-size:11px;color:var(--filtix-terminal-muted)}
${scope} [data-terminal-alert-error],${scope} [data-terminal-alert-row-error]{grid-column:1/-1;color:var(--filtix-terminal-copper);font-size:11px;overflow-wrap:anywhere}
${scope} [data-terminal-alert-error]:empty,${scope} [data-terminal-alert-row-error]:empty{display:none}
${scope} [data-terminal-alert-events]{display:grid;gap:4px;padding-top:8px;border-top:1px solid var(--filtix-terminal-border);font-size:11px}
${scope} [data-terminal-alert-events]>strong{color:var(--filtix-terminal-accent)}
${scope} [data-terminal-alert-event]{overflow-wrap:anywhere;color:var(--filtix-terminal-text)}
${scope} [data-terminal-body]{position:relative;display:grid;min-width:0;min-height:0;overflow:hidden}
${scope}[data-editor-mode="rail"][data-editor-open="true"] [data-terminal-body]{grid-template-columns:minmax(0,1fr) clamp(280px,30%,360px);grid-template-rows:minmax(0,1fr)}
${scope}[data-editor-mode="bottom"][data-editor-open="true"] [data-terminal-body]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) var(--terminal-editor-height,0px)}
${scope}[data-editor-mode="overlay"][data-editor-open="true"] [data-terminal-studies-panel]{position:absolute;left:0;right:0;bottom:0;height:var(--terminal-editor-height,0px);z-index:3;border-top:1px solid var(--filtix-terminal-border)}
${scope} [data-terminal-chart]{position:relative;min-width:0;min-height:0;overflow:hidden}
${scope} [data-terminal-layout-controls]{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0;width:100%;padding-top:5px;border-top:1px solid var(--filtix-terminal-border)}
${scope} [data-terminal-layout-controls] select{max-width:180px;min-width:0}
${scope} [data-terminal-layout-status]{color:var(--filtix-terminal-accent);font-size:11px}
${scope} [data-terminal-studies-head]{position:sticky;top:-8px;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--filtix-terminal-panel)}
${scope} [data-terminal-studies-close]{min-height:28px}
${scope} [data-terminal-studies-head] [data-terminal-studies-heading]{margin:0;flex:none}
${scope} [data-terminal-studies-focus-status]{min-width:0;flex:1;color:var(--filtix-terminal-accent);font-size:10px;line-height:1.15;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${scope} [data-terminal-footer]{display:flex;gap:10px;align-items:center;min-height:0;max-height:15%;overflow:auto;padding:5px 9px;border-top:1px solid var(--filtix-terminal-border);color:var(--filtix-terminal-muted)}
${scope} [data-terminal-status][data-ready="true"]{color:var(--filtix-terminal-accent)}
${scope} [data-terminal-error]{margin-left:auto;color:var(--filtix-terminal-copper);overflow-wrap:anywhere;min-width:0}
${scope} [data-terminal-error]:empty{display:none}
@container(max-width:480px){${scope} [data-terminal-studies-add],${scope} [data-terminal-study-row]{grid-template-columns:repeat(2,minmax(0,1fr))}${scope} [data-terminal-study-name],${scope} [data-terminal-study-add],${scope} [data-terminal-study-remove]{grid-column:1/-1}${scope} [data-terminal-toolbar]{gap:4px;padding:6px}${scope} [data-terminal-toolbar] label>span:not([data-terminal-compact-label]){position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}${scope} button{padding-inline:7px}${scope} [data-terminal-toolbar] button{padding-inline:5px}}
`;

  const toolbar = doc.createElement('div');
  toolbar.dataset.terminalToolbar = '';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Chart workspace controls');

  const symbol = doc.createElement('select');
  symbol.dataset.terminalSymbol = '';
  symbol.setAttribute('aria-label', 'Instrument');
  symbol.append(...symbols.map((value) => option(doc, value)));
  const interval = doc.createElement('select');
  interval.dataset.terminalInterval = '';
  interval.setAttribute('aria-label', 'Interval');
  interval.append(...intervals.map((value) => option(doc, value)));
  const theme = doc.createElement('select');
  theme.dataset.terminalTheme = '';
  theme.setAttribute('aria-label', 'Theme');
  theme.append(option(doc, 'dark'), option(doc, 'light'));
  theme.value = settings.theme;
  const volume = doc.createElement('input');
  volume.type = 'checkbox';
  volume.checked = settings.volume;
  volume.dataset.terminalVolume = '';
  volume.setAttribute('aria-label', 'Show volume');
  const ema = doc.createElement('input');
  ema.type = 'number';
  ema.min = '2';
  ema.max = '500';
  ema.inputMode = 'numeric';
  ema.value = settings.emaPeriod === null ? '' : String(settings.emaPeriod);
  ema.dataset.terminalEma = '';
  ema.setAttribute('aria-label', 'EMA period; blank disables');

  const tools: Array<[DrawingTool, string]> = [
    ['select', 'Select'],
    ['trend-line', 'Trend'],
    ['horizontal-line', 'Horizontal'],
    ['rectangle', 'Rectangle'],
    ['measure', 'Measure'],
    ['fibonacci-retracement', 'Fib'],
    ['parallel-channel', 'Channel'],
    ['text-note', 'Note'],
  ];
  const toolButtons = new Map<DrawingTool, HTMLButtonElement>();
  for (const [tool, label] of tools) {
    const item = button(doc, label, `tool-${tool}`);
    item.dataset.terminalTool = tool;
    item.setAttribute('aria-label', `${label} drawing tool`);
    item.setAttribute('aria-pressed', String(tool === 'select'));
    toolButtons.set(tool, item);
  }
  const magnet = button(doc, 'Magnet', 'magnet');
  magnet.dataset.terminalMagnet = '';
  magnet.setAttribute('aria-label', 'Snap drawing anchors to OHLC');
  magnet.setAttribute('aria-pressed', 'false');
  const undo = button(doc, 'Undo', 'undo');
  const redo = button(doc, 'Redo', 'redo');
  const remove = button(doc, 'Delete', 'delete');
  const latest = button(doc, 'Latest', 'latest');
  const fit = button(doc, 'Fit', 'fit');
  const history = button(doc, 'History', 'history');
  const retry = button(doc, 'Retry', 'retry');
  toolbar.append(
    labelled(doc, 'Instrument', symbol),
    labelled(doc, 'Interval', interval),
    labelled(doc, 'Theme', theme),
    labelled(doc, 'Volume', volume),
    labelled(doc, 'EMA', ema),
    ...toolButtons.values(),
    magnet,
    undo,
    redo,
    remove,
    latest,
    fit,
    history,
    retry,
  );

  const body = doc.createElement('div');
  body.dataset.terminalBody = '';
  const chart = doc.createElement('div');
  chart.dataset.terminalChart = '';
  body.append(chart);
  const footer = doc.createElement('div');
  footer.dataset.terminalFooter = '';
  const status = doc.createElement('span');
  status.dataset.terminalStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = doc.createElement('div');
  error.dataset.terminalError = '';
  error.setAttribute('role', 'alert');
  footer.append(status, error);
  root.append(style, toolbar, body, footer);
  return {
    root,
    style,
    chart,
    body,
    symbol,
    interval,
    theme,
    volume,
    ema,
    status,
    error,
    undo,
    redo,
    remove,
    magnet,
    toolButtons,
    toolbar,
  };
}

interface TerminalDependencies {
  createChart?: typeof createChart;
  createFeedSession: typeof createFeedSession;
  studyFactories?: Partial<TerminalStudyRuntimeFactories>;
}

const DEFAULT_DEPENDENCIES: TerminalDependencies = { createFeedSession };
type ConstructedTerminal = PreparedTerminal & { startNow(options?: { alertLease?: () => void }): void };

export function prepareTerminalWithDependencies(
  host: HTMLElement,
  options: TerminalOptions,
  workspace: TerminalWorkspace | undefined,
  dependencies: TerminalDependencies,
): ConstructedTerminal {
  const defaultPriceVolumeDependencies = dependencies === DEFAULT_DEPENDENCIES;
  if (!host?.ownerDocument?.defaultView) throw new TypeError('A browser HTMLElement host is required');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Terminal options are required');
  const provider = options.provider;
  const queryValue = options.query;
  const symbolValues = options.symbols;
  const intervalValues = options.intervals;
  const settingsValue = options.settings;
  const studyValues = options.studies;
  const feedOptions = options.feed;
  const alertOptions = options.alerts;
  const alertObserver = options.onAlert;
  const stateObserver = options.onState;
  if (!provider || typeof provider !== 'object') throw new TypeError('A market data provider is required');
  const providerIdValue = provider.id;
  const providerId =
    typeof providerIdValue === 'string' && providerIdValue.trim() === providerIdValue && providerIdValue
      ? providerIdValue
      : null;
  if (!providerId)
    throw new TypeError('Provider id must be a nonblank string without surrounding whitespace');
  const stableProviderId: string = providerId;
  if (stateObserver !== undefined && typeof stateObserver !== 'function')
    throw new TypeError('onState must be a function');
  if (alertObserver !== undefined && typeof alertObserver !== 'function')
    throw new TypeError('onAlert must be a function');
  if (
    alertOptions !== undefined &&
    (!alertOptions || typeof alertOptions !== 'object' || Array.isArray(alertOptions))
  )
    throw new TypeError('alerts must be an object');
  const suppliedAlertStore = alertOptions?.store;
  const suppliedAlertMonitor = alertOptions?.monitor;
  if (
    (suppliedAlertStore !== undefined &&
      (suppliedAlertStore === null ||
        typeof suppliedAlertStore !== 'object' ||
        Array.isArray(suppliedAlertStore))) ||
    (suppliedAlertMonitor !== undefined &&
      (suppliedAlertMonitor === null ||
        typeof suppliedAlertMonitor !== 'object' ||
        Array.isArray(suppliedAlertMonitor)))
  )
    throw new TypeError('alerts store and monitor must be objects when supplied');
  const requestedQuery = resolveQuery(queryValue);
  const catalog = resolveCatalog(requestedQuery, symbolValues, intervalValues);
  const savedWorkspace = workspace === undefined ? null : copyWorkspaceDocument(workspace);
  if (savedWorkspace && savedWorkspace.providerId !== stableProviderId)
    throw new TypeError('Saved workspace provider does not match terminal');
  const initialQuery = savedWorkspace ? resolveQuery(savedWorkspace.query) : requestedQuery;
  if (!catalog.symbols.includes(initialQuery.symbol) || !catalog.intervals.includes(initialQuery.interval))
    throw new TypeError('Saved workspace query is outside the terminal catalogs');
  const suppliedStudies = Object.prototype.hasOwnProperty.call(options, 'studies');
  const suppliedLegacySetting =
    settingsValue !== undefined && Object.prototype.hasOwnProperty.call(settingsValue, 'emaPeriod');
  if (suppliedStudies && suppliedLegacySetting)
    throw new TypeError('studies and an explicit settings.emaPeriod cannot be supplied together');
  if (suppliedStudies && !Array.isArray(studyValues)) throw new TypeError('studies must be an array');
  if (suppliedStudies && studyValues!.length > 8)
    throw new RangeError('Terminal supports at most eight studies');
  let settings = resolveSettings(settingsValue);
  const allocator = new StudyIdAllocator();
  let studies: TerminalStudy[];
  if (suppliedStudies) {
    studies = (studyValues as readonly TerminalStudyOptions[]).map((value) => {
      const resolved = resolveStudyOptions(value);
      return { id: allocator.allocate(), ...resolved };
    });
    validateStudyCaps(studies);
    settings = { ...settings, emaPeriod: null };
  } else {
    studies = settings.emaPeriod === null ? [] : [legacyEma(settings.emaPeriod)];
  }
  if (savedWorkspace) {
    studies = copyStudies(savedWorkspace.studies);
    settings = { ...savedWorkspace.settings, emaPeriod: projectedEmaPeriod(studies) };
    allocator.advanceFrom(studies);
  }
  let layout = savedWorkspace
    ? copyLayout(savedWorkspace.layout)
    : Object.hasOwn(options, 'layout')
      ? resolveLayout(options.layout, defaultLayout(studies), visiblePaneIds(studies, settings.volume))
      : defaultLayout(studies);
  const doc = host.ownerDocument;
  const elements = createElements(doc, catalog.symbols, catalog.intervals, settings);
  elements.symbol.value = initialQuery.symbol;
  elements.interval.value = initialQuery.interval;
  host.append(elements.root);

  let chart: ChartApi | null = null;
  let layoutRuntime: TerminalLayoutRuntime | null = null;
  let priceSeries: SeriesHandle | null = null;
  let volumePane: PaneHandle | null = null;
  let volumeSeries: SeriesHandle | null = null;
  let studyRuntime: TerminalStudyRuntime | null = null;
  let studyControls: TerminalStudyControls | null = null;
  let drawingControls: TerminalDrawingControls | null = null;
  let alertControls: TerminalAlertControls | null = null;
  let alertStore: PriceAlertStore | null = null;
  let alertMonitor: PriceAlertMonitor | null = null;
  const ownsAlertStore = suppliedAlertStore === undefined;
  const ownsAlertMonitor = suppliedAlertMonitor === undefined;
  let releaseAlertLease = () => {};
  let unsubscribeAlertEvents = () => {};
  let layoutControls: TerminalLayoutControls | null = null;
  let rootResizeObserver: ResizeObserver | null = null;
  let lastPresenterTarget: string | null | undefined;
  let drawingStore: DrawingStore | null = null;
  let drawingLayer: DrawingLayer | null = null;
  let feed: FeedSession | null = null;
  let dead = false;
  let started = false;
  let generation = 1;
  let actionRevision = 0;
  let mutationRevision = 0;
  let repairBudget: { remaining: number } | null = null;
  let compositionRepairDepth = 0;
  let compositionNeedsRepair = false;
  let currentQuery = copyQuery(initialQuery);
  let renderedTailTime: number | null = null;
  let cachedFeed = emptyFeedState();
  let ingestionError: string | null = null;
  let actionError: string | null = null;
  let finalWorkspace: TerminalWorkspace | null = null;
  const drawingDocuments = new Map<string, { query: MarketQuery; document: DrawingDocument }>();
  if (savedWorkspace)
    for (const market of savedWorkspace.markets)
      drawingDocuments.set(queryKey(stableProviderId, market.query), {
        query: copyQuery(market.query),
        document: copyDrawingDocument(market.drawings),
      });
  const removeListeners: Array<() => void> = [];

  function assertAlive(): void {
    if (dead) throw new Error('Terminal has been destroyed');
  }

  function assertStarted(): void {
    assertAlive();
    if (!started) throw new Error('Terminal has not been started');
  }

  function onAlertEvent(event: PriceAlertEvent): void {
    if (dead || !started) return;
    alertControls?.recordEvent(event);
    try {
      alertObserver?.(event);
    } catch {
      /* Isolate application alert observers. */
    }
  }

  function currentError(): string | null {
    return ingestionError ?? actionError;
  }

  function terminalState(): TerminalState {
    return {
      feed: copyFeedState(cachedFeed),
      settings: copySettings(settings),
      studies: copyStudies(studies),
      layout: copyLayout(layout),
      error: currentError(),
      destroyed: dead,
    };
  }

  function renderState(): void {
    if (dead) return;
    const problem = currentError() ?? cachedFeed.error?.message ?? null;
    const ready = cachedFeed.status === 'live' && currentError() === null;
    if (elements.root.dataset.theme !== settings.theme) elements.root.dataset.theme = settings.theme;
    if (elements.status.dataset.ready !== String(ready)) elements.status.dataset.ready = String(ready);
    const status = ready
      ? 'Live'
      : cachedFeed.status === 'loading'
        ? 'Loading'
        : cachedFeed.status === 'reconnecting'
          ? 'Reconnecting'
          : cachedFeed.status === 'stale'
            ? 'Stale'
            : cachedFeed.status === 'error'
              ? 'Unavailable'
              : cachedFeed.status;
    if (elements.status.textContent !== status) elements.status.textContent = status;
    if (elements.error.textContent !== (problem ?? '')) elements.error.textContent = problem ?? '';
    if (elements.theme.value !== settings.theme) elements.theme.value = settings.theme;
    if (elements.volume.checked !== settings.volume) elements.volume.checked = settings.volume;
    const ema = settings.emaPeriod === null ? '' : String(settings.emaPeriod);
    if (elements.ema.value !== ema) elements.ema.value = ema;
    studyControls?.setOpen(layout.studiesOpen);
    studyControls?.render(studies, currentError());
    refreshPresentation();
    const history = drawingStore?.getHistoryState() ?? { canUndo: false, canRedo: false };
    if (elements.undo.disabled !== !history.canUndo) elements.undo.disabled = !history.canUndo;
    if (elements.redo.disabled !== !history.canRedo) elements.redo.disabled = !history.canRedo;
    const removeDisabled = drawingLayer?.getState().selectedId === null;
    if (elements.remove.disabled !== removeDisabled) elements.remove.disabled = removeDisabled;
    drawingControls?.refresh();
  }

  function notifyState(): void {
    renderState();
    if (dead || !stateObserver) return;
    try {
      stateObserver(terminalState());
    } catch {
      // Public observers are isolated from terminal ownership.
    }
  }

  function ownPaneMutation<T>(work: () => T): T {
    return layoutRuntime ? layoutRuntime.ownMembership(work) : work();
  }
  function setPresentationStyle(element: HTMLElement, property: string, value: string): void {
    if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property))
      element.style.setProperty(property, value);
  }
  function presentation(candidate: TerminalLayout): TerminalPresentation | null {
    if (!chart || dead) return null;
    const root = elements.root.getBoundingClientRect();
    setPresentationStyle(elements.toolbar, 'max-height', Math.max(0, root.height * 0.25) + 'px');
    setPresentationStyle(
      elements.root.querySelector<HTMLElement>('[data-terminal-footer]')!,
      'max-height',
      Math.max(0, root.height * 0.15) + 'px',
    );
    const body = elements.body.getBoundingClientRect();
    const value = presentationFor(root.width, body.height, chart.getPaneLayout(), candidate);
    if (elements.root.dataset.editorMode !== value.mode) elements.root.dataset.editorMode = value.mode;
    const editorOpen = String(candidate.studiesOpen);
    if (elements.root.dataset.editorOpen !== editorOpen) elements.root.dataset.editorOpen = editorOpen;
    if (value.editingFocus) {
      if (elements.root.dataset.terminalEditingFocus !== 'price')
        elements.root.dataset.terminalEditingFocus = 'price';
    } else if (elements.root.dataset.terminalEditingFocus !== undefined)
      delete elements.root.dataset.terminalEditingFocus;
    setPresentationStyle(elements.body, '--terminal-editor-height', value.editorHeight + 'px');
    studyControls?.setEditingFocus(value.editingFocus);
    return value;
  }
  function refreshPresentation(): void {
    const token = mutationRevision;
    const feedGeneration = generation;
    const value = presentation(layout);
    if (!value || !chart || dead || token !== mutationRevision || feedGeneration !== generation) return;
    if (lastPresenterTarget !== value.effectiveMaximizedPaneId) {
      if (chart.getPaneLayout().maximizedPaneId !== value.effectiveMaximizedPaneId)
        layoutRuntime?.sync(layout, value.effectiveMaximizedPaneId);
      // Chart observers can synchronously issue a newer terminal command during sync.
      if (dead || token !== mutationRevision || feedGeneration !== generation) return;
      lastPresenterTarget = value.effectiveMaximizedPaneId;
    }
    layoutControls?.render(layout, studies, visiblePaneIds(studies, settings.volume), value.editingFocus);
  }
  function syncLayout(candidate: TerminalLayout = layout): void {
    const value = presentation(candidate);
    if (!dead && value) {
      layoutRuntime?.sync(candidate, value.effectiveMaximizedPaneId);
      lastPresenterTarget = value.effectiveMaximizedPaneId;
    }
  }
  function checkMutation(token: number, feedGeneration: number): void {
    assertAlive();
    if (token !== mutationRevision || feedGeneration !== generation)
      throw new TerminalMutationSupersededError();
  }
  // A shared budget also bounds repair started by a callback during another repair.
  function repairUntilStable(work: (token: number, feedGeneration: number) => void): void {
    const previousBudget = repairBudget;
    const budget = (repairBudget ??= { remaining: 8 });
    try {
      while (!dead) {
        if (budget.remaining-- <= 0) throw new Error('Terminal repair did not settle within 8 attempts');
        const token = mutationRevision;
        const feedGeneration = generation;
        try {
          work(token, feedGeneration);
        } catch (error) {
          if (dead) return;
          // A stale pass may collide with the newer registry; only the latest pass is authoritative.
          if (token === mutationRevision && feedGeneration === generation) throw error;
        }
        if (token === mutationRevision && feedGeneration === generation) return;
      }
    } finally {
      repairBudget = previousBudget;
    }
  }
  function repairLayout(): void {
    repairUntilStable(() => syncLayout());
  }
  function commitLayout(candidate: TerminalLayout, external = false): void {
    const changed = !sameLayout(layout, candidate);
    if (external) {
      if (!changed) return;
      ++mutationRevision;
      layout = copyLayout(candidate);
      notifyState();
      return;
    }
    const token = ++mutationRevision;
    const feedGeneration = generation;
    try {
      syncLayout(candidate);
      checkMutation(token, feedGeneration);
    } catch (error) {
      if (!dead) repairLayout();
      throw error;
    }
    if (!changed) return;
    layout = copyLayout(candidate);
    notifyState();
  }
  function applyLayout(patch: TerminalLayoutPatch): void {
    assertStarted();
    commitLayout(resolveLayout(patch, layout, visiblePaneIds(studies, settings.volume)));
  }

  function failComposition(error: unknown): void {
    if (dead) return;
    ingestionError = message(error);
    notifyState();
  }

  function failAction(error: unknown): void {
    if (dead) return;
    actionError = message(error);
    notifyState();
  }

  function safeRender(work: () => void, canonicalRepair = false): void {
    if (dead) return;
    try {
      if (canonicalRepair && compositionNeedsRepair) {
        // A failed rollback can leave canonical panes/series missing. Rebuild the latest
        // composition under the shared repair budget before declaring data ready.
        repairComposition(true);
        if (!dead && !compositionNeedsRepair) ingestionError = null;
        return;
      }
      const token = mutationRevision;
      const feedGeneration = generation;
      work();
      if (
        canonicalRepair &&
        !dead &&
        !compositionNeedsRepair &&
        token === mutationRevision &&
        feedGeneration === generation
      )
        ingestionError = null;
    } catch (error) {
      failComposition(error);
    }
  }

  function addVolume(): void {
    if (!chart || volumeSeries) return;
    const pane = ownPaneMutation(() =>
      chart!.addPane({ id: 'terminal-volume-pane', weight: 0.26, minHeight: 64 }),
    );
    let series: SeriesHandle;
    try {
      series = chart.addSeries('histogram', {
        id: 'terminal-volume',
        paneId: pane.id,
        title: 'Volume',
        color: '#9a9f91',
        lastValueVisible: false,
        priceLineVisible: false,
      });
    } catch (error) {
      ownPaneMutation(() => pane.remove());
      throw error;
    }
    volumePane = pane;
    volumeSeries = series;
  }

  function removeVolume(): void {
    const series = volumeSeries;
    const pane = volumePane;
    volumeSeries = null;
    volumePane = null;
    let failure: unknown;
    try {
      series?.remove();
    } catch (error) {
      failure = error;
    }
    try {
      ownPaneMutation(() => pane?.remove());
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
  function rebuild(bars: readonly MarketBar[]): void {
    // The shared owned-column capability is the live built-in UTC chart check.
    if (defaultPriceVolumeDependencies && volumeSeries && hasOwnedStudyColumnCapability(chart!)) {
      setOwnedPriceVolumeData(chart!, priceSeries!, volumeSeries, bars);
    } else {
      priceSeries!.setData(bars);
      volumeSeries?.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume })));
    }
    studyRuntime!.rebuild(studies, bars);
    renderedTailTime = bars.length ? bars[bars.length - 1]!.time : null;
  }

  function incremental(bar: MarketBar): void {
    priceSeries!.update(bar);
    volumeSeries?.update({ time: bar.time, value: bar.volume });
    studyRuntime!.update(bar);
    renderedTailTime = bar.time;
  }
  function retry(): Promise<void> {
    if (dead) return Promise.reject(new Error('Terminal has been destroyed'));
    if (!started) return Promise.reject(new Error('Terminal has not been started'));
    actionError = null;
    return feed!.retry();
  }

  function onFeedChange(change: FeedChange): void {
    if (dead || !started) return;
    if (change.type === 'reset') {
      safeRender(() => rebuild(change.bars), true);
      return;
    }
    if (renderedTailTime !== null && change.bar.time < renderedTailTime) {
      safeRender(() => rebuild(feed!.getData()), true);
      return;
    }
    safeRender(() => incremental(change.bar));
  }

  function drawingKey(query: MarketQuery): string {
    return queryKey(stableProviderId, query);
  }

  function saveActiveDrawings(): void {
    if (!drawingStore) return;
    drawingDocuments.set(drawingKey(currentQuery), {
      query: copyQuery(currentQuery),
      document: copyDrawingDocument(drawingStore.toJSON()),
    });
  }

  function syncDrawingState(state: ReturnType<DrawingLayer['getState']>): void {
    if (dead) return;
    for (const [tool, item] of elements.toolButtons)
      item.setAttribute('aria-pressed', String(state.tool === tool));
    elements.magnet.setAttribute('aria-pressed', String(state.magnet));
    renderState();
  }

  function replaceDrawingContext(query: MarketQuery, document?: DrawingDocument): void {
    (drawingLayer as DrawingLayer | null)?.destroy();
    drawingLayer = null;
    drawingStore = createDrawingStore({ timeDomain: 'utc-ms', maxDrawings: 200, maxHistory: 100 });
    const saved = document ?? drawingDocuments.get(drawingKey(query))?.document;
    if (saved) drawingStore.restore(saved);
    drawingLayer = createDrawingLayer(chart!, {
      store: drawingStore,
      onState: syncDrawingState,
      snapProvider(request) {
        if (
          request.paneId !== 'price' ||
          typeof request.point.time !== 'number' ||
          !Number.isFinite(request.point.time)
        )
          return [];
        const bar = feed?.getBar(request.point.time);
        if (!bar) return [];
        return (['open', 'high', 'low', 'close'] as const).map((field) => ({
          field,
          time: bar.time,
          price: bar[field],
        }));
      },
    });
    syncDrawingState(drawingLayer.getState());
  }

  function clearMarketSeries(): void {
    priceSeries!.setData([]);
    volumeSeries?.setData([]);
    studyRuntime!.clear();
    renderedTailTime = null;
  }

  function allowedQuery(value: unknown): MarketQuery {
    const query = resolveQuery(value);
    if (!catalog.symbols.includes(query.symbol) || !catalog.intervals.includes(query.interval))
      throw new TypeError('Market query is outside the terminal catalogs');
    return query;
  }

  async function loadChangedMarket(query: MarketQuery, saveCurrent: boolean): Promise<void> {
    assertStarted();
    if (query.symbol === currentQuery.symbol && query.interval === currentQuery.interval) return;
    if (saveCurrent) saveActiveDrawings();
    const token = ++generation;
    actionError = null;
    clearMarketSeries();
    currentQuery = copyQuery(query);
    elements.symbol.value = query.symbol;
    elements.interval.value = query.interval;
    replaceDrawingContext(query);
    if (dead || token !== generation || !feed) return;
    await feed.load(copyQuery(query));
    if (dead || token !== generation) return;
  }

  function makeWorkspace(): TerminalWorkspace {
    if (!dead) saveActiveDrawings();
    return copyWorkspaceDocument({
      schema: 'filtix-terminal',
      version: 5,
      providerId: stableProviderId,
      query: copyQuery(currentQuery),
      settings: {
        theme: settings.theme,
        followLatest: settings.followLatest,
        volume: settings.volume,
      },
      studies: copyStudies(studies),
      layout: copyLayout(layout),
      markets: [...drawingDocuments.values()].map((entry) => ({
        query: copyQuery(entry.query),
        drawings: copyDrawingDocument(entry.document),
      })),
      alerts: alertStore!.toJSON(),
    });
  }

  function sameStudies(left: readonly TerminalStudy[], right: readonly TerminalStudy[]): boolean {
    return (
      left.length === right.length &&
      left.every((study, index) => {
        const other = right[index];
        return other !== undefined && sameStudy(study, other);
      })
    );
  }

  function needsStudyHistory(previous: readonly TerminalStudy[], next: readonly TerminalStudy[]): boolean {
    const before = new Map(previous.map((study) => [study.id, study]));
    return next.some((study) => {
      const old = before.get(study.id);
      return study.visible && (!old?.visible || studyCalculationChanged(old, study));
    });
  }

  function registryForLegacyPeriod(value: number | null): TerminalStudy[] {
    const next = copyStudies(studies);
    const index = next.findIndex((study) => study.id === LEGACY_EMA_ID);
    if (value === null) {
      if (index >= 0) next.splice(index, 1);
    } else if (index >= 0) {
      const current = next[index]!;
      if (current.kind !== 'ema') throw new Error('Reserved terminal-ema study must have ema kind');
      next[index] = { ...current, period: value, visible: true };
    } else {
      next.push(legacyEma(value));
    }
    validateStudyCaps(next);
    return next;
  }

  function repairComposition(restorePrice = false, restoreDrawings = false): void {
    compositionRepairDepth++;
    compositionNeedsRepair = true;
    try {
      repairUntilStable((token, feedGeneration) => {
        const savedSettings = copySettings(settings);
        const savedStudies = copyStudies(studies);
        const savedLayout = copyLayout(layout);
        const savedQuery = copyQuery(currentQuery);
        const bars = feed ? feed.getData() : [];
        if (restoreDrawings) replaceDrawingContext(savedQuery);
        checkMutation(token, feedGeneration);
        chart!.applyOptions({ theme: savedSettings.theme, followLatest: savedSettings.followLatest });
        removeVolume();
        checkMutation(token, feedGeneration);
        if (savedSettings.volume) {
          addVolume();
          checkMutation(token, feedGeneration);
          volumeSeries!.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume })));
        }
        studyRuntime!.restore(savedStudies, bars);
        checkMutation(token, feedGeneration);
        if (restorePrice) {
          priceSeries!.setData(bars);
          renderedTailTime = bars.length ? bars[bars.length - 1]!.time : null;
        }
        syncLayout(savedLayout);
        checkMutation(token, feedGeneration);
      });
      if (!dead) compositionNeedsRepair = false;
    } catch (error) {
      // An inner repair may have succeeded before this outer pass failed.
      compositionNeedsRepair = true;
      throw error;
    } finally {
      compositionRepairDepth--;
    }
  }

  function commitStudies(
    next: readonly TerminalStudy[],
    notify = true,
    barsOverride?: readonly MarketBar[],
    beforeCommit?: () => void,
  ): void {
    const candidate = copyStudies(next);
    validateStudyCaps(candidate);
    if (sameStudies(studies, candidate)) return;
    const candidateLayout = reconcileLayout(layout, candidate, settings.volume);
    const token = ++mutationRevision;
    const feedGeneration = generation;
    const bars =
      barsOverride ??
      ((compositionRepairDepth > 0 || needsStudyHistory(studies, candidate)) && feed ? feed.getData() : []);
    try {
      if (compositionRepairDepth > 0) studyRuntime!.restore(candidate, bars);
      else studyRuntime!.apply(studies, candidate, bars, () => (feed ? feed.getData() : []));
      checkMutation(token, feedGeneration);
      syncLayout(candidateLayout);
      checkMutation(token, feedGeneration);
    } catch (error) {
      if (!dead) repairComposition();
      throw token !== mutationRevision || feedGeneration !== generation
        ? new TerminalMutationSupersededError()
        : error;
    }
    beforeCommit?.();
    studies = candidate;
    settings = { ...settings, emaPeriod: projectedEmaPeriod(studies) };
    layout = candidateLayout;
    actionError = null;
    if (notify) notifyState();
  }

  function applyResolvedSettings(next: TerminalSettings, emit = true, resolvedStudies = studies): void {
    assertStarted();
    const nextStudies = copyStudies(resolvedStudies);
    const settingsChanged =
      settings.theme !== next.theme ||
      settings.followLatest !== next.followLatest ||
      settings.volume !== next.volume;
    const studiesChanged = !sameStudies(studies, nextStudies);
    if (!settingsChanged && !studiesChanged) return;
    const candidateLayout = reconcileLayout(layout, nextStudies, next.volume);
    const token = ++mutationRevision;
    const feedGeneration = generation;
    let rollbackBars: readonly MarketBar[] | null = null;
    const getRollbackBars = () => (rollbackBars ??= feed ? feed.getData() : []);
    const needBars =
      compositionRepairDepth > 0 ||
      (settings.volume !== next.volume && next.volume) ||
      needsStudyHistory(studies, nextStudies);
    const bars = needBars ? getRollbackBars() : [];
    try {
      chart!.applyOptions({ theme: next.theme, followLatest: next.followLatest });
      if (compositionRepairDepth > 0) studyRuntime!.restore(nextStudies, bars);
      else studyRuntime!.apply(studies, nextStudies, bars, getRollbackBars);
      checkMutation(token, feedGeneration);
      if (settings.volume !== next.volume) {
        if (next.volume) {
          addVolume();
          checkMutation(token, feedGeneration);
          volumeSeries!.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume })));
          studyRuntime!.reconcileVolumeOrder(nextStudies);
        } else removeVolume();
      }
      checkMutation(token, feedGeneration);
      syncLayout(candidateLayout);
      checkMutation(token, feedGeneration);
    } catch (error) {
      if (!dead) repairComposition();
      throw token !== mutationRevision || feedGeneration !== generation
        ? new TerminalMutationSupersededError()
        : error;
    }
    studies = nextStudies;
    settings = {
      theme: next.theme,
      followLatest: next.followLatest,
      volume: next.volume,
      emaPeriod: projectedEmaPeriod(studies),
    };
    layout = candidateLayout;
    actionError = null;
    if (emit) notifyState();
  }
  function addStudy(value: TerminalStudyOptions): string {
    assertStarted();
    const resolved = resolveStudyOptions(value);
    const id = allocator.next();
    const next = [...studies, { id, ...resolved }];
    validateStudyCaps(next);
    try {
      commitStudies(next, true, undefined, () => allocator.commit(id));
    } catch (error) {
      reportUnlessMutationSuperseded(error, failComposition);
      throw error;
    }
    return id;
  }

  function updateStudy(idValue: string, value: TerminalStudyPatch): void {
    assertStarted();
    const id = resolveStudyId(idValue);
    const index = studies.findIndex((study) => study.id === id);
    if (index < 0) throw new Error(`Unknown study: ${id}`);
    const current = studies[index]!;
    const updated = resolveStudyPatch(current, value);
    if (sameStudies([current], [updated])) return;
    const next = copyStudies(studies);
    next[index] = updated;
    try {
      commitStudies(next);
    } catch (error) {
      reportUnlessMutationSuperseded(error, failComposition);
      throw error;
    }
  }

  function removeStudy(idValue: string): boolean {
    assertStarted();
    const id = resolveStudyId(idValue);
    const index = studies.findIndex((study) => study.id === id);
    if (index < 0) return false;
    const next = copyStudies(studies);
    next.splice(index, 1);
    try {
      commitStudies(next);
    } catch (error) {
      reportUnlessMutationSuperseded(error, failComposition);
      throw error;
    }
    return true;
  }
  function listen(target: EventTarget, event: string, listener: EventListener): void {
    target.addEventListener(event, listener);
    removeListeners.push(() => target.removeEventListener(event, listener));
  }

  async function uiAction(work: () => void | Promise<void>): Promise<void> {
    if (dead || !started) return;
    const revision = ++actionRevision;
    try {
      await work();
      if (!dead && revision === actionRevision) {
        actionError = null;
        notifyState();
      }
    } catch (error) {
      if (!dead && revision === actionRevision) failAction(error);
    }
  }

  try {
    alertStore =
      suppliedAlertStore ??
      createPriceAlertStore({
        providerId: stableProviderId,
        scopeId: savedWorkspace?.alerts.scopeId ?? `${elements.root.dataset.filtixTerminalInstance}:alerts`,
      });
    if (alertStore.toJSON().providerId !== stableProviderId)
      throw new TypeError('Alert store provider does not match terminal');
    if (ownsAlertStore && savedWorkspace) alertStore.restore(savedWorkspace.alerts);
    alertMonitor = suppliedAlertMonitor ?? createPriceAlertMonitor({ provider });
    chart = (dependencies.createChart ?? createChart)(elements.chart, {
      timeDomain: 'utc-ms',
      theme: settings.theme,
      followLatest: settings.followLatest,
      autoSize: true,
      ariaLabel: 'FILTIX financial terminal chart',
    });
    layoutRuntime = new TerminalLayoutRuntime(
      chart,
      () => layout,
      () => visiblePaneIds(studies, settings.volume),
      (candidate) => commitLayout(candidate, true),
    );
    priceSeries = chart.addSeries('candlestick', {
      id: 'terminal-price',
      title: 'Price',
      upColor: '#c7ef57',
      downColor: '#c27a50',
    });
    if (settings.volume) addVolume();
    studyRuntime = new TerminalStudyRuntime(
      chart,
      dependencies.studyFactories,
      ownPaneMutation,
      dependencies.createChart === undefined,
    );
    studyRuntime.apply([], studies, []);
    syncLayout();
    replaceDrawingContext(initialQuery);
    feed = dependencies.createFeedSession({
      ...(feedOptions ?? {}),
      provider,
      onChange: onFeedChange,
      onState(state) {
        if (dead || !started) return;
        cachedFeed = copyFeedState(state);
        notifyState();
      },
    });

    studyControls = createStudyControls(doc, {
      setOpen(studiesOpen) {
        applyLayout({ studiesOpen });
      },
      add(value) {
        try {
          addStudy(value);
        } catch (error) {
          if (!isTerminalMutationSuperseded(error) && !currentError()) failAction(error);
        }
      },
      update(id, value) {
        try {
          updateStudy(id, value);
        } catch (error) {
          if (!isTerminalMutationSuperseded(error) && !currentError()) failAction(error);
        }
      },
      remove(id) {
        try {
          removeStudy(id);
        } catch (error) {
          if (!isTerminalMutationSuperseded(error) && !currentError()) failAction(error);
        }
      },
    });
    layoutControls = createTerminalLayoutControls(doc, chart, {
      apply(patch) {
        uiAction(() => applyLayout(patch));
      },
      reset() {
        uiAction(() => api.resetLayout());
      },
      close() {
        uiAction(() => applyLayout({ studiesOpen: false }));
      },
    });
    drawingControls = createDrawingControls(doc, elements.body, {
      store: () => drawingStore,
      layer: () => drawingLayer,
    });
    alertControls = createAlertControls(doc, {
      store: () => alertStore!,
      monitor: () => alertMonitor!,
      symbols: catalog.symbols,
      intervals: catalog.intervals,
      currentQuery: () => currentQuery,
    });
    elements.toolbar.append(
      studyControls.toggle,
      drawingControls.toggle,
      alertControls.toggle,
      layoutControls.root,
    );
    elements.body.append(studyControls.panel);
    elements.body.append(alertControls.panel);
    // Caller-owned pane membership can change without a canonical terminal delta.
    removeListeners.push(chart.subscribePaneLayoutChange(() => layoutControls?.refreshAvailability()));
    studyControls.render(studies, currentError());
    rootResizeObserver = new ResizeObserver(() => refreshPresentation());
    rootResizeObserver.observe(elements.root);

    listen(elements.symbol, 'change', () => {
      void uiAction(() =>
        loadChangedMarket({ symbol: elements.symbol.value, interval: elements.interval.value }, true),
      );
    });
    listen(elements.interval, 'change', () => {
      void uiAction(() =>
        loadChangedMarket({ symbol: elements.symbol.value, interval: elements.interval.value }, true),
      );
    });
    listen(elements.theme, 'change', () => {
      uiAction(() =>
        applyResolvedSettings(resolveSettings({ theme: elements.theme.value as 'dark' | 'light' }, settings)),
      );
    });
    listen(elements.volume, 'change', () => {
      uiAction(() => applyResolvedSettings(resolveSettings({ volume: elements.volume.checked }, settings)));
    });
    listen(elements.ema, 'change', () => {
      uiAction(() => {
        const value = elements.ema.value.trim();
        const next = resolveSettings({ emaPeriod: value === '' ? null : Number(value) }, settings);
        applyResolvedSettings(next, true, registryForLegacyPeriod(next.emaPeriod));
      });
    });
    for (const [tool, item] of elements.toolButtons)
      listen(item, 'click', () => uiAction(() => drawingLayer!.setTool(tool)));
    listen(elements.magnet, 'click', () =>
      uiAction(() => drawingLayer!.setMagnet(!drawingLayer!.getState().magnet)),
    );
    const actions = new Map(
      [...elements.root.querySelectorAll<HTMLButtonElement>('[data-terminal-action]')].map((item) => [
        item.dataset.terminalAction!,
        item,
      ]),
    );
    listen(actions.get('undo')!, 'click', () =>
      uiAction(() => {
        drawingStore!.undo();
      }),
    );
    listen(actions.get('redo')!, 'click', () =>
      uiAction(() => {
        drawingStore!.redo();
      }),
    );
    listen(actions.get('delete')!, 'click', () =>
      uiAction(() => {
        const selected = drawingLayer!.getState().selectedId;
        if (selected) drawingStore!.remove(selected);
      }),
    );
    listen(actions.get('latest')!, 'click', () => uiAction(() => chart!.scrollToLatest()));
    listen(actions.get('fit')!, 'click', () => uiAction(() => chart!.fitContent()));
    listen(actions.get('history')!, 'click', () => uiAction(() => feed!.loadMore()));
    listen(actions.get('retry')!, 'click', () => uiAction(retry));
    renderState();
  } catch (error) {
    dead = true;
    started = false;
    generation += 1;
    for (const remove of removeListeners.splice(0)) remove();
    alertControls?.destroy();
    unsubscribeAlertEvents();
    releaseAlertLease();
    if (ownsAlertMonitor) alertMonitor?.destroy();
    if (ownsAlertStore) alertStore?.destroy();
    feed?.destroy();
    (drawingLayer as DrawingLayer | null)?.destroy();
    rootResizeObserver?.disconnect();
    rootResizeObserver = null;
    layoutControls?.destroy();
    layoutControls = null;
    drawingControls?.destroy();
    drawingControls = null;
    studyControls?.destroy();
    layoutRuntime?.destroy();
    try {
      chart?.destroy();
    } catch {
      // Preserve the initiating constructor error when chart cleanup also fails.
    } finally {
      studyRuntime?.releaseAfterChartDestroy();
      studyRuntime = null;
      elements.root.remove();
    }
    throw error;
  }

  function disposeTerminal(): void {
    if (dead) return;
    saveActiveDrawings();
    finalWorkspace = makeWorkspace();
    dead = true;
    started = false;
    generation += 1;
    for (const remove of removeListeners.splice(0)) remove();
    alertControls?.destroy();
    alertControls = null;
    unsubscribeAlertEvents();
    releaseAlertLease();
    if (ownsAlertMonitor) alertMonitor?.destroy();
    if (ownsAlertStore) alertStore?.destroy();
    (drawingLayer as DrawingLayer | null)?.destroy();
    drawingLayer = null;
    drawingStore = null;
    feed?.destroy();
    if (feed) cachedFeed = copyFeedState(feed.getState());
    feed = null;
    rootResizeObserver?.disconnect();
    rootResizeObserver = null;
    layoutControls?.destroy();
    layoutControls = null;
    drawingControls?.destroy();
    drawingControls = null;
    studyControls?.destroy();
    studyControls = null;
    layoutRuntime?.destroy();
    layoutRuntime = null;
    try {
      chart?.destroy();
    } finally {
      // The owning chart retires composition once; release only our references.
      studyRuntime?.releaseAfterChartDestroy();
      studyRuntime = null;
      priceSeries = null;
      volumeSeries = null;
      volumePane = null;
      renderedTailTime = null;
      drawingDocuments.clear();
      cachedFeed = { ...cachedFeed, status: 'destroyed', loadingMore: false, error: null };
      ingestionError = null;
      actionError = null;
      elements.root.remove();
    }
  }

  let lifecycle: ReturnType<typeof createTerminalPreparationLifecycle>;

  const api: TerminalApi = {
    getLayout() {
      return copyLayout(layout);
    },
    applyLayout,
    resetLayout() {
      assertStarted();
      commitLayout(defaultLayout(studies));
    },
    get chart() {
      return chart!;
    },
    setMarket(value) {
      if (dead) return Promise.reject(new Error('Terminal has been destroyed'));
      if (!started) return Promise.reject(new Error('Terminal has not been started'));
      let query: MarketQuery;
      try {
        query = allowedQuery(value);
      } catch (error) {
        return Promise.reject(error);
      }
      return loadChangedMarket(query, true);
    },
    retry,
    loadMore() {
      if (dead) return Promise.reject(new Error('Terminal has been destroyed'));
      if (!started) return Promise.reject(new Error('Terminal has not been started'));
      return feed!.loadMore();
    },
    applyCorrections(bars) {
      assertStarted();
      feed!.applyCorrections(bars);
    },
    getState() {
      return terminalState();
    },
    getData() {
      assertAlive();
      return feed!.getData();
    },
    addStudy,
    updateStudy,
    removeStudy,
    getStudies() {
      return copyStudies(studies);
    },
    applySettings(partial) {
      assertStarted();
      const next = resolveSettings(partial, settings);
      const nextStudies = Object.prototype.hasOwnProperty.call(partial, 'emaPeriod')
        ? registryForLegacyPeriod(next.emaPeriod)
        : studies;
      try {
        applyResolvedSettings(next, true, nextStudies);
      } catch (error) {
        reportUnlessMutationSuperseded(error, failComposition);
        throw error;
      }
    },
    getSettings() {
      return copySettings(settings);
    },
    getWorkspace() {
      return finalWorkspace ? copyWorkspaceDocument(finalWorkspace) : makeWorkspace();
    },
    getAlerts() {
      return alertStore!;
    },
    getAlertState() {
      return alertMonitor!.getState();
    },
    async restoreWorkspace(value) {
      assertStarted();
      const mutationToken = ++mutationRevision;
      const feedGeneration = generation;
      const previousStore = alertStore!;
      const previousRelease = releaseAlertLease;
      const previousEventUnsubscribe = unsubscribeAlertEvents;
      const currentAlertScopeId = previousStore.toJSON().scopeId;
      const decoded = decodeWorkspace(value, {
        providerId: stableProviderId,
        ...catalog,
        legacyAlertScopeId: currentAlertScopeId,
        ...(ownsAlertStore ? {} : { requiredAlertScopeId: currentAlertScopeId }),
      });
      checkMutation(mutationToken, feedGeneration);
      const nextDocuments = new Map<string, { query: MarketQuery; document: DrawingDocument }>();
      for (const market of decoded.markets)
        nextDocuments.set(drawingKey(market.query), {
          query: copyQuery(market.query),
          document: copyDrawingDocument(market.drawings),
        });
      const feedQuery = cachedFeed.query;
      const changed =
        decoded.query.symbol !== currentQuery.symbol ||
        decoded.query.interval !== currentQuery.interval ||
        (feedQuery !== null &&
          (decoded.query.symbol !== feedQuery.symbol || decoded.query.interval !== feedQuery.interval));
      const nextSettings: TerminalSettings = {
        ...decoded.settings,
        emaPeriod: projectedEmaPeriod(decoded.studies),
      };
      const adoptedStudies = copyStudies(decoded.studies);
      const adoptedLayout = copyLayout(decoded.layout);
      const adoptedQuery = copyQuery(decoded.query);
      const previousBars = feed ? feed.getData() : [];
      const candidateBars = changed ? [] : previousBars;
      saveActiveDrawings();
      checkMutation(mutationToken, feedGeneration);
      let replacementStore: PriceAlertStore | null = null;
      let replacementEventUnsubscribe = () => {};
      let membership: PreparedAlertMembership | null = null;
      let inPlace: PreparedPriceAlertStoreRestore | null = null;
      try {
        if (decoded.alerts.scopeId === currentAlertScopeId) {
          inPlace = preparePriceAlertStoreRestore(previousStore, decoded.alerts);
        } else {
          replacementStore = createPriceAlertStore({
            providerId: stableProviderId,
            scopeId: decoded.alerts.scopeId,
          });
          replacementStore.restore(decoded.alerts);
          replacementEventUnsubscribe = replacementStore.subscribeEvents(onAlertEvent);
          membership = prepareAlertMembershipReplacement(alertMonitor!, {
            retire: [previousRelease],
            attach: [replacementStore],
          });
        }
        checkMutation(mutationToken, feedGeneration);
      } catch (error) {
        inPlace?.abort();
        membership?.abort();
        replacementEventUnsubscribe();
        replacementStore?.destroy();
        throw error;
      }
      let drawingTouched = false;
      let replacementLease = previousRelease;
      const adopt = (): void => {
        studies = adoptedStudies;
        settings = nextSettings;
        layout = adoptedLayout;
        allocator.advanceFrom(studies);
        drawingDocuments.clear();
        for (const [key, entry] of nextDocuments) drawingDocuments.set(key, entry);
        actionError = null;
        currentQuery = adoptedQuery;
        if (replacementStore) {
          alertStore = replacementStore;
          releaseAlertLease = replacementLease;
          unsubscribeAlertEvents = replacementEventUnsubscribe;
        }
      };
      try {
        chart!.applyOptions({ theme: nextSettings.theme, followLatest: nextSettings.followLatest });
        if (compositionRepairDepth > 0) studyRuntime!.restore(decoded.studies, candidateBars);
        else studyRuntime!.apply(studies, decoded.studies, candidateBars, () => previousBars);
        checkMutation(mutationToken, feedGeneration);
        if (settings.volume !== nextSettings.volume) {
          if (nextSettings.volume) {
            addVolume();
            checkMutation(mutationToken, feedGeneration);
            volumeSeries!.setData(candidateBars.map((bar) => ({ time: bar.time, value: bar.volume })));
            studyRuntime!.reconcileVolumeOrder(decoded.studies);
          } else removeVolume();
        }
        checkMutation(mutationToken, feedGeneration);
        if (changed) {
          priceSeries!.setData([]);
          volumeSeries?.setData([]);
          studyRuntime!.clear();
          renderedTailTime = null;
        }
        syncLayout(decoded.layout);
        checkMutation(mutationToken, feedGeneration);
        const activeDocument = nextDocuments.get(drawingKey(decoded.query))!.document;
        drawingTouched = true;
        replaceDrawingContext(decoded.query, activeDocument);
        checkMutation(mutationToken, feedGeneration);
        if (membership) {
          replacementLease = membership.commit()[0]!;
          adopt();
        } else {
          inPlace!.commit({
            assertCurrent: () => checkMutation(mutationToken, feedGeneration),
            adopt,
          });
        }
      } catch (error) {
        inPlace?.abort();
        membership?.abort();
        replacementEventUnsubscribe();
        replacementStore?.destroy();
        let failure = error;
        if (!dead) {
          try {
            repairComposition(true, drawingTouched);
          } catch (repairError) {
            failure = repairError;
          }
        }
        if (failure === error && (mutationToken !== mutationRevision || feedGeneration !== generation))
          failure = new TerminalMutationSupersededError();
        reportUnlessMutationSuperseded(failure, failComposition);
        throw failure;
      }
      elements.symbol.value = currentQuery.symbol;
      elements.interval.value = currentQuery.interval;
      if (replacementStore) {
        previousEventUnsubscribe();
        alertControls?.refresh();
        membership!.activate();
        previousRelease();
        previousStore.destroy();
      } else {
        alertControls?.refresh();
        inPlace!.activate();
      }
      if (dead || mutationToken !== mutationRevision) return;
      if (!changed) {
        notifyState();
        return;
      }
      const token = ++generation;
      if (dead || !feed) return;
      // No callbacks occur between canonical adoption and this real loading transition.
      // Geometry was already synchronized and fenced against the previous canonical snapshot.
      await feed.load(copyQuery(currentQuery));
      if (dead || token !== generation) return;
    },
    setTool(tool: DrawingTool) {
      assertStarted();
      drawingLayer!.setTool(tool);
    },
    getDrawings() {
      assertAlive();
      return drawingStore!;
    },
    destroy() {
      lifecycle.destroy();
    },
  };
  Object.freeze(api);

  lifecycle = createTerminalPreparationLifecycle({
    attach() {
      const lease = alertMonitor!.attach(alertStore!);
      if (alertMonitor!.getState().destroyed) {
        lease();
        throw new Error('Alert monitor was destroyed during attachment');
      }
      return lease;
    },
    acceptLease(lease) {
      releaseAlertLease = lease;
    },
    activate() {
      unsubscribeAlertEvents = alertStore!.subscribeEvents(onAlertEvent);
      if (dead) return;
      started = true;
      void feed!.load(copyQuery(initialQuery)).catch((error) => failComposition(error));
    },
    dispose() {
      disposeTerminal();
    },
  });
  return {
    api,
    startNow(options) {
      if (options?.alertLease && (!suppliedAlertStore || !suppliedAlertMonitor))
        throw new TypeError('Adopted alert lease requires supplied store and monitor');
      lifecycle.startNow(options);
    },
    start(options) {
      if (options?.alertLease && (!suppliedAlertStore || !suppliedAlertMonitor))
        return Promise.reject(new TypeError('Adopted alert lease requires supplied store and monitor'));
      return lifecycle.start(options);
    },
    getAlertLease() {
      return dead ? null : lifecycle.getAlertLease() ? releaseAlertLease : null;
    },
    destroy() {
      lifecycle.destroy();
    },
  };
}
export function prepareTerminal(
  host: HTMLElement,
  options: TerminalOptions,
  workspace?: TerminalWorkspace,
): PreparedTerminal {
  return prepareTerminalWithDependencies(host, options, workspace, DEFAULT_DEPENDENCIES);
}

export function createTerminalWithDependencies(
  host: HTMLElement,
  options: TerminalOptions,
  dependencies: TerminalDependencies,
): TerminalApi {
  const prepared = prepareTerminalWithDependencies(host, options, undefined, dependencies);
  try {
    // Preserve the synchronous constructor failure path while history continues asynchronously.
    prepared.startNow();
    return prepared.api;
  } catch (error) {
    prepared.destroy();
    throw error;
  }
}
export function createTerminal(host: HTMLElement, options: TerminalOptions): TerminalApi {
  return createTerminalWithDependencies(host, options, DEFAULT_DEPENDENCIES);
}
