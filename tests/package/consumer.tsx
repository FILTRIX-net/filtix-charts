import { createRef } from 'react';
import {
  createChart,
  measurePaneLayout,
  type PaneLayoutOptions,
  type PaneLayoutPatch,
  type ChartPaneLayout,
  type ChartPaneLayoutPatch,
  type MeasuredPaneLayout,
  type MeasuredChartPaneLayout,
  type ChartApi,
  type CandlePoint,
  type ChartOptions,
  type ChartLegendOptions,
  type BandPoint,
  type SeriesHandle,
} from '@filtrix.net/charts';
import { SeriesStore, utcMillis } from '@filtrix.net/core';
import {
  createIndicator,
  ema,
  macd,
  bollingerBands,
  createMacd,
  createBollingerBands,
  type IndicatorPoint,
  type MacdOptions,
  type MacdResult,
  type BollingerBandsOptions,
  type BollingerBandsResult,
  type StreamingMacd,
  type StreamingBollingerBands,
} from '@filtrix.net/indicators';
import { FiltrixChart, FiltixChart, type FiltrixChartProps, type FiltixChartProps } from '@filtrix.net/react';

const legacyChart: typeof FiltrixChart = FiltixChart;
const legacyProps: FiltixChartProps = {};
const canonicalProps: FiltrixChartProps = legacyProps;
void legacyChart;
void canonicalProps;

const legend: ChartLegendOptions = { visible: true, maxRows: 2 };
const options: ChartOptions = { theme: 'dark', timeDomain: 'utc-ms', legend };
const candles: CandlePoint[] = [
  { time: utcMillis(1_780_272_000_000), open: 10, high: 12, low: 9, close: 11 },
];
const store = new SeriesStore('candlestick');
store.setData(candles);
const average = ema(
  candles.map(({ time, close }) => ({ time, value: close })),
  20,
);
const live = createIndicator('ema', 20);
live.setData(average);
const ref = createRef<ChartApi | null>();
export const component = (
  <FiltrixChart
    ref={ref}
    options={options}
    onReady={(chart) => {
      chart.addSeries('candlestick').setData(candles);
    }}
  />
);
export function mount(host: HTMLElement): ChartApi {
  const chart = createChart(host, options);
  chart.applyOptions({ legend: { visible: false } });
  chart.applyOptions({ legend: { visible: true, maxRows: 1 } });
  chart.addSeries('line').setData(average);
  return chart;
}
import type { UtcMillis as ChartsUtcMillis } from '@filtrix.net/charts';
const brandedTime: ChartsUtcMillis = utcMillis(1_780_272_000_000);
// @ts-expect-error A raw number must pass the explicit validation helper.
const invalidBrandedTime: ChartsUtcMillis = 123;
void invalidBrandedTime;
void brandedTime;

import {
  createBinanceProvider,
  createFeedSession,
  getFeedSessionResourceSnapshot,
  type FeedSessionResourceSnapshot,
  type MarketDataProvider,
  type FeedState,
  type FeedSession,
  type MarketBar,
} from '@filtrix.net/datafeed';

// Unsupported instrumentation is compiled separately from the stable FeedSession API.
export function inspectFeedResources(feed: FeedSession): FeedSessionResourceSnapshot {
  const snapshot = getFeedSessionResourceSnapshot(feed);
  // @ts-expect-error Resource counts are read-only diagnostics.
  snapshot.retainedBars = 0;
  return snapshot;
}
const provider: MarketDataProvider = createBinanceProvider();
const session = createFeedSession({
  provider,
  onChange(change) {
    if (change.type === 'update') void change.bar.close;
    else void change.bars.length;
  },
});
const indexedSession: FeedSession = session;
const indexedBar: MarketBar | null = indexedSession.getBar(1_780_272_000_000);
// @ts-expect-error Exact feed lookup requires a numeric UTC timestamp.
indexedSession.getBar('2026-06-01');
void indexedBar;
const feedState: FeedState = session.getState();
void feedState;
session.destroy();

import {
  createDrawingStore,
  createDrawingLayer,
  decodeDrawingDocument,
  copyDrawingDocument,
  requiredAnchorCount,
  DEFAULT_DRAWING_STYLE,
  DEFAULT_FIBONACCI_LEVELS,
  type DrawingDocument,
  type DrawingDocumentV1,
  type DrawingInput,
  type DrawingPatch,
  type DrawingLayerOptions,
  type DrawingLayerState,
  type DrawingSnapProvider,
  type DrawingSnapCandidate,
  type FibonacciDrawing,
  type ParallelChannelDrawing,
  type TextNoteDrawing,
} from '@filtrix.net/drawings';
import type { ChartPrimitive, PrimitiveProjection } from '@filtrix.net/charts';
const drawingStore = createDrawingStore();
const drawingInputs: DrawingInput[] = [
  { type: 'horizontal-line', points: [{ time: 0, price: 10 }] },
  {
    type: 'trend-line',
    points: [
      { time: 0, price: 10 },
      { time: 1, price: 11 },
    ],
  },
  {
    type: 'rectangle',
    points: [
      { time: 0, price: 10 },
      { time: 1, price: 11 },
    ],
  },
  {
    type: 'measure',
    points: [
      { time: 0, price: 10 },
      { time: 1, price: 11 },
    ],
  },
  {
    type: 'fibonacci-retracement',
    points: [
      { time: 0, price: 10 },
      { time: 1, price: 11 },
    ],
    levels: [{ ratio: 0 }, { ratio: 1, color: '#7aa2f7', lineWidth: 2, lineStyle: 'dashed' }],
    locked: true,
    visible: false,
  },
  {
    type: 'parallel-channel',
    points: [
      { time: 0, price: 10 },
      { time: 1, price: 11 },
      { time: 0, price: 9 },
    ],
  },
  { type: 'text-note', points: [{ time: 0, price: 10 }], text: 'Market structure', fontSize: 12 },
];
const drawingIds = drawingInputs.map((input) => drawingStore.add(input));
const fibonacciPatch: DrawingPatch = { levels: DEFAULT_FIBONACCI_LEVELS, locked: false, visible: true };
drawingStore.update(drawingIds[4]!, fibonacciPatch);
drawingStore.update(drawingIds[6]!, { text: 'Updated note', fontSize: 14, style: DEFAULT_DRAWING_STYLE });
const channelAnchors: number = requiredAnchorCount('parallel-channel');
for (const drawing of drawingStore.list()) {
  if (drawing.type === 'fibonacci-retracement') {
    const resolved: FibonacciDrawing = drawing;
    const ratio: number = resolved.levels[0]!.ratio;
    void ratio;
  } else if (drawing.type === 'parallel-channel') {
    const resolved: ParallelChannelDrawing = drawing;
    void resolved.points[2];
  } else if (drawing.type === 'text-note') {
    const resolved: TextNoteDrawing = drawing;
    const text: string = resolved.text;
    const fontSize: number = resolved.fontSize;
    void [text, fontSize];
  }
}
const drawingDocument: DrawingDocument = drawingStore.toJSON();
const documentVersion: 2 = drawingDocument.version;
const legacyDrawings: DrawingDocumentV1 = {
  schema: 'filtix-drawings',
  version: 1,
  timeDomain: 'utc-ms',
  drawings: [
    {
      id: 'legacy-line',
      type: 'horizontal-line',
      paneId: 'price',
      points: [{ time: 0, price: 10 }],
      style: DEFAULT_DRAWING_STYLE,
    },
  ],
};
const migratedDrawings: DrawingDocument = decodeDrawingDocument(legacyDrawings, { timeDomain: 'utc-ms' });
const copiedDrawings: DrawingDocument = copyDrawingDocument(migratedDrawings);
// @ts-expect-error Historical drawing documents cannot contain new v2-only types.
const invalidLegacyDrawingType: DrawingDocumentV1['drawings'][number]['type'] = 'fibonacci-retracement';
// @ts-expect-error Canonical documents require migration from version 1.
const invalidCurrentDrawingDocument: DrawingDocument = legacyDrawings;
// @ts-expect-error Drawing identity and kind are immutable through update patches.
const invalidDrawingPatch: DrawingPatch = { type: 'text-note' };
void [
  channelAnchors,
  documentVersion,
  copiedDrawings,
  invalidLegacyDrawingType,
  invalidCurrentDrawingDocument,
  invalidDrawingPatch,
];
const primitive: ChartPrimitive = {
  draw(_context, projection: PrimitiveProjection, mode) {
    void projection.logicalIndexToTime(0);
    void mode;
  },
};
export function mountStudy(host: HTMLElement) {
  const chart = mount(host);
  const snapProvider: DrawingSnapProvider = (request) => {
    const candidates: DrawingSnapCandidate[] = [{ ...request.point, field: 'close' }];
    return request.paneId === 'price' ? candidates : [];
  };
  const layerOptions: DrawingLayerOptions = {
    store: drawingStore,
    snapProvider,
    snapDistance: 10,
    magnet: true,
    onState(state: DrawingLayerState) {
      const enabled: boolean = state.magnet;
      void enabled;
    },
  };
  const layer = createDrawingLayer(chart, layerOptions);
  layer.setMagnet(false);
  const layerState: DrawingLayerState = layer.getState();
  const magnet: boolean = layerState.magnet;
  layer.setTool('fibonacci-retracement');
  layer.setTool('parallel-channel');
  layer.setTool('text-note');
  void magnet;
  const detach = chart.attachPrimitive(primitive);
  return { chart, layer, detach, drawingDocument };
}

import {
  createChartSync,
  createHistoryReplay,
  buildIndexedComparison,
  type ChartSyncOptions,
  type ReplayChange,
} from '@filtrix.net/analysis';
import type { ChartChangeMeta, TimeRange } from '@filtrix.net/charts';
const comparison = buildIndexedComparison([{ id: 'sample', points: [{ time: 0, value: 100 }] }]);
const replay = createHistoryReplay({
  bars: candles,
  onChange(change: ReplayChange) {
    void change.state.position;
  },
});
replay.step();
replay.destroy();
void comparison;
const filteredSyncOptions: ChartSyncOptions = { causes: ['interaction', 'api'] as const };
const initializationOnlySyncOptions: ChartSyncOptions = { causes: [] };
const invalidSyncOptions: ChartSyncOptions = {
  // @ts-expect-error A propagation origin is not an accepted event cause.
  causes: ['sync'],
};
void initializationOnlySyncOptions;
void invalidSyncOptions;
export function filteredAnalysisSync(first: ChartApi, second: ChartApi) {
  return createChartSync([first, second], filteredSyncOptions);
}
export function mountAnalysis(first: HTMLElement, second: HTMLElement) {
  const a = mount(first),
    b = mount(second);
  const sync = createChartSync([a, b], { crosshairMatch: 'nearest' });
  const range: TimeRange | null = a.getVisibleTimeRange();
  if (range) b.setVisibleTimeRange(range, { origin: sync });
  a.setCrosshairTime(0, { match: 'exact' });
  const off = a.subscribeCrosshairMove((event, meta: ChartChangeMeta) => {
    void event.time;
    void meta.revision;
  });
  void a.timeDomain;
  void a.getChangeRevision();
  return { a, b, sync, off };
}

import {
  createTerminal,
  createTerminalGrid,
  type TerminalSingleStudyOptions,
  type TerminalMacdStudyOptions,
  type TerminalBollingerStudyOptions,
  type TerminalSingleStudy,
  type TerminalMacdStudy,
  type TerminalBollingerStudy,
  type TerminalStudyPatch,
  type TerminalWorkspace,
  type TerminalWorkspaceV1,
  type TerminalWorkspaceV2,
  type TerminalWorkspaceV3,
  type TerminalWorkspaceV4,
  type TerminalWorkspaceV4WithDrawingsV2,
  type TerminalPaneId,
  type TerminalPaneLayout,
  type TerminalLayout,
  type TerminalLayoutPatch,
  type TerminalApi,
  type TerminalGridApi,
  type TerminalGridCellId,
  type TerminalGridCellState,
  type TerminalGridCellWorkspace,
  type TerminalGridLayout,
  type TerminalGridOptions,
  type TerminalGridState,
  type TerminalGridSync,
  type TerminalGridWorkspace,
} from '@filtrix.net/terminal';
export function mountTerminal(host: HTMLElement) {
  const single: TerminalSingleStudyOptions = { kind: 'ema', period: 20 };
  const momentum: TerminalMacdStudyOptions = {
    kind: 'macd',
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    positiveColor: '#73c991',
    negativeColor: '#ef7c8e',
  };
  const envelope: TerminalBollingerStudyOptions = {
    kind: 'bollinger',
    period: 20,
    multiplier: 2,
    fillOpacity: 0.12,
  };
  const terminal = createTerminal(host, {
    provider,
    query: { symbol: 'BTCUSDT', interval: '1m' },
    studies: [single, momentum, envelope],
    layout: { panes: [{ id: 'price', weight: 1 }], studiesOpen: false },
  });
  const extraId = terminal.addStudy(momentum);
  const compoundPatch: TerminalStudyPatch = { fastPeriod: 30, slowPeriod: 40, signalColor: '#ffcc00' };
  terminal.updateStudy(extraId, compoundPatch);
  terminal.removeStudy(extraId);
  for (const study of terminal.getStudies()) {
    if (study.kind === 'macd') {
      const resolved: TerminalMacdStudy = study;
      const fields: [number, number, number, string] = [
        resolved.fastPeriod,
        resolved.slowPeriod,
        resolved.signalPeriod,
        resolved.negativeColor,
      ];
      void fields;
    } else if (study.kind === 'bollinger') {
      const resolved: TerminalBollingerStudy = study;
      const fields: [number, number, number, string] = [
        resolved.period,
        resolved.multiplier,
        resolved.fillOpacity,
        resolved.upperColor,
      ];
      void fields;
    } else {
      const resolved: TerminalSingleStudy = study;
      const period: number = resolved.period;
      void period;
    }
  }
  const workspace: TerminalWorkspace = terminal.getWorkspace();
  const version: 5 = workspace.version;
  const { alerts, ...legacyWorkspace } = workspace;
  const current: TerminalWorkspaceV4WithDrawingsV2 = { ...legacyWorkspace, version: 4 };
  const legacyVersion: 4 = current.version;
  void [alerts, legacyVersion];
  const stateLayout: TerminalLayout = terminal.getState().layout;
  const id: TerminalPaneId = 'price';
  const pane: TerminalPaneLayout = { id, weight: 2, minHeight: 160 };
  const patch: TerminalLayoutPatch = { panes: [pane], maximizedPaneId: null, studiesOpen: true };
  terminal.applyLayout(patch);
  const savedLayout: TerminalLayout = terminal.getLayout();
  terminal.resetLayout();
  void [current, stateLayout, savedLayout];
  void version;
  return terminal;
}

const closes: IndicatorPoint[] = candles.map(({ time, close }) => ({ time, value: close }));
const macdOptions: MacdOptions = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };
const bollingerOptions: BollingerBandsOptions = { period: 20, multiplier: 2 };
const macdOutput: MacdResult<IndicatorPoint[]> = macd(closes, macdOptions);
const bandsOutput: BollingerBandsResult<IndicatorPoint[]> = bollingerBands(closes, bollingerOptions);
const streamingMacd: StreamingMacd = createMacd(macdOptions, 'utc-ms');
const streamingBands: StreamingBollingerBands = createBollingerBands(bollingerOptions, 'utc-ms');
streamingMacd.setData(closes);
streamingBands.setData(closes);
const latestMacd: MacdResult<IndicatorPoint> = streamingMacd.update(closes[0]!);
const latestBands: BollingerBandsResult<IndicatorPoint> = streamingBands.update(closes[0]!);
const copiedMacd: MacdResult<IndicatorPoint[]> = streamingMacd.getData();
const copiedBands: BollingerBandsResult<IndicatorPoint[]> = streamingBands.getData();
void [latestMacd, latestBands, copiedMacd, copiedBands];

export function mountMultiOutput(host: HTMLElement) {
  const chart = mount(host);
  chart.addSeries('line').setData(macdOutput.macd);
  chart.addSeries('line').setData(bandsOutput.middle);
  const bandPoints: BandPoint[] = [{ time: candles[0]!.time, lower: 9, upper: 12 }];
  const fill: SeriesHandle = chart.addSeries('band', {
    color: '#7aa2f7',
    fillOpacity: 0.12,
    lastValueVisible: false,
    priceLineVisible: false,
  });
  fill.setData(bandPoints);
  fill.update({ time: candles[0]!.time, lower: 8, upper: 13 });
  const off = chart.subscribeCrosshairMove((event) => {
    const point = event.points[fill.id];
    if (point && 'upper' in point && 'lower' in point) {
      const spread: number = point.upper - point.lower;
      void spread;
    }
  });
  return { chart, fill, off };
}

export function legacyWorkspaces(workspace: TerminalWorkspace, markets: TerminalWorkspaceV1['markets']) {
  const version1: TerminalWorkspaceV1 = {
    schema: workspace.schema,
    version: 1,
    providerId: workspace.providerId,
    query: workspace.query,
    settings: { ...workspace.settings, emaPeriod: null },
    markets,
  };
  const version2: TerminalWorkspaceV2 = {
    schema: workspace.schema,
    version: 2,
    providerId: workspace.providerId,
    query: workspace.query,
    settings: workspace.settings,
    studies: workspace.studies.filter(
      (study): study is TerminalSingleStudy =>
        study.kind === 'sma' || study.kind === 'ema' || study.kind === 'rsi',
    ),
    markets,
  };
  const version3: TerminalWorkspaceV3 = {
    schema: workspace.schema,
    version: 3,
    providerId: workspace.providerId,
    query: workspace.query,
    settings: workspace.settings,
    studies: workspace.studies,
    markets,
  };
  const version4: TerminalWorkspaceV4 = {
    ...version3,
    version: 4,
    layout: workspace.layout,
  };
  const historicalVersion: 3 = version3.version;
  void historicalVersion;
  return { version1, version2, version3, version4 };
}

const historicalWorkspaceDrawing: TerminalWorkspaceV4['markets'][number]['drawings'] = legacyDrawings;
const currentWorkspaceDrawing: TerminalWorkspaceV4WithDrawingsV2['markets'][number]['drawings'] =
  drawingDocument;
// @ts-expect-error Historical V4 retains drawing version 1, even when canonical workspace is also V4.
const invalidHistoricalWorkspaceDrawing: TerminalWorkspaceV4['markets'][number]['drawings'] = drawingDocument;
// @ts-expect-error Current V4 drawing documents must be migrated to drawing version 2.
const invalidCurrentWorkspaceDrawing: TerminalWorkspaceV4WithDrawingsV2['markets'][number]['drawings'] =
  legacyDrawings;
void [
  historicalWorkspaceDrawing,
  currentWorkspaceDrawing,
  invalidHistoricalWorkspaceDrawing,
  invalidCurrentWorkspaceDrawing,
];

// The historical schema must not broaden when the current study union grows.
// @ts-expect-error Workspace v2 cannot contain multi-output study kinds.
const invalidLegacyKind: TerminalWorkspaceV2['studies'][number]['kind'] = 'macd';
// @ts-expect-error Study kind is immutable through the patch API.
const invalidStudyPatch: TerminalStudyPatch = { kind: 'macd' };
void [invalidLegacyKind, invalidStudyPatch];

export function mountPaneLayout(host: HTMLElement) {
  const chart = mount(host);
  chart.addPane({ id: 'volume' });
  const pane: PaneLayoutOptions = { id: 'price', weight: 2, minHeight: 120 };
  const panePatch: PaneLayoutPatch = { id: pane.id, weight: pane.weight };
  const patch: ChartPaneLayoutPatch = { panes: [panePatch], maximizedPaneId: null };
  chart.applyPaneLayout(patch, { origin: { consumer: 'installed' } });
  const canGrow: boolean = chart.canResizePane('price', 8);
  if (canGrow) chart.resizePane('price', 8);
  // @ts-expect-error CSS pixel delta must be numeric.
  chart.canResizePane('price', '8');
  const layout: ChartPaneLayout = chart.getPaneLayout();
  const measured: MeasuredChartPaneLayout = measurePaneLayout(layout, 480);
  const rectangle: MeasuredPaneLayout | undefined = measured.panes[0];
  const off = chart.subscribePaneLayoutChange((current: ChartPaneLayout, meta: ChartChangeMeta) => {
    const id: string | null = current.maximizedPaneId;
    void [id, meta.revision, meta.origin, meta.cause];
  });
  // @ts-expect-error Layout preference batches cannot change a pane scale.
  const invalid: PaneLayoutPatch = { id: 'price', scale: 'log' };
  void invalid;
  return { chart, layout, rectangle, off };
}

// The historical v3 surface remains separate from the current schema.
// @ts-expect-error Workspace v3 has no persisted layout.
type LegacyLayout = TerminalWorkspaceV3['layout'];
// @ts-expect-error Current workspace version is exactly 5.
const invalidCurrentVersion: TerminalWorkspace['version'] = 3;
void invalidCurrentVersion;

import {
  createPriceAlertStore,
  createPriceAlertMonitor,
  type PriceAlertStore,
  type PriceAlertMonitorState,
  type PriceAlertEvent,
} from '@filtrix.net/alerts';
export function mountTerminalAlerts(host: HTMLElement) {
  const alertStore: PriceAlertStore = createPriceAlertStore({ providerId: provider.id, scopeId: 'consumer' });
  const monitor = createPriceAlertMonitor({ provider });
  const events: PriceAlertEvent[] = [];
  const terminal = createTerminal(host, {
    provider,
    query: { symbol: 'BTCUSDT', interval: '1m' },
    alerts: { store: alertStore, monitor },
    onAlert(event) {
      events.push(event);
    },
  });
  const id = terminal.getAlerts().add({
    query: { symbol: 'BTCUSDT', interval: '1m' },
    price: 100,
    condition: 'crosses-up',
    frequency: 'repeat',
    label: 'Threshold',
  });
  terminal.getAlerts().pause(id);
  terminal.getAlerts().rearm(id);
  const state: PriceAlertMonitorState = terminal.getAlertState();
  void [state, events];
  return () => {
    terminal.destroy();
    monitor.destroy();
    alertStore.destroy();
  };
}

export function mountTerminalGrid(host: HTMLElement): TerminalGridApi {
  return createTerminalGrid(host, {
    provider,
    query: { symbol: 'BTCUSDT', interval: '1m' },
    layout: 2,
    sync: { viewport: false, crosshairMatch: 'nearest' },
    onState(state) {
      const cell: TerminalGridCellState | undefined = state.cells[0];
      void cell;
    },
    onAlert(cellId, event) {
      const owner: TerminalGridCellId = cellId;
      const occurrence: number = event.occurrence;
      void [owner, occurrence];
    },
  });
}

// Public grid signatures compile against package exports without source aliases.
export async function terminalGridContracts(grid: TerminalGridApi, options: TerminalGridOptions) {
  const layout: TerminalGridLayout = 4;
  const activeCellId: TerminalGridCellId = 'cell-4';
  const sync: TerminalGridSync = { viewport: true, crosshair: true, crosshairMatch: 'nearest' };
  const state: TerminalGridState = grid.getState();
  const workspace: TerminalGridWorkspace = grid.getWorkspace();
  const schema: 'filtix-terminal-grid' = workspace.schema;
  const version: 1 = workspace.version;
  const cell: TerminalGridCellWorkspace | undefined = workspace.cells[0];
  const cellState: TerminalGridCellState | undefined = state.cells[0];
  const terminal: TerminalApi | null = grid.getTerminal(activeCellId);
  const alertState: PriceAlertMonitorState = state.alertState;
  const nextOptions: TerminalGridOptions = {
    ...options,
    layout,
    sync,
    onState(nextState) {
      const nextLayout: TerminalGridLayout = nextState.layout;
      void nextLayout;
    },
    onAlert(cellId, event) {
      const typedCellId: TerminalGridCellId = cellId;
      const typedEvent: PriceAlertEvent = event;
      void [typedCellId, typedEvent];
    },
  };
  await grid.setLayout(layout);
  grid.setActiveCell(activeCellId);
  grid.setSync({ viewport: false });
  await grid.restoreWorkspace(workspace);
  // @ts-expect-error Only 1, 2 and 4 visible cells are supported.
  const invalidLayout: TerminalGridLayout = 3;
  // @ts-expect-error Cell identifiers are stable and bounded.
  const invalidCellId: TerminalGridCellId = 'cell-5';
  // @ts-expect-error Canonical grid documents cannot contain historical workspace versions.
  const invalidCellVersion: TerminalGridCellWorkspace['workspace']['version'] = 4;
  // @ts-expect-error Saved cell collections are read-only at the public boundary.
  workspace.cells.push(cell!);
  void [schema, version, cell, cellState, terminal, alertState, nextOptions];
  void [invalidLayout, invalidCellId, invalidCellVersion];
}
