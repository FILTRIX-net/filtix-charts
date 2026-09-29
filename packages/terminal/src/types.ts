import type { ChartApi } from '@filtix/charts';
import type {
  FeedSessionOptions,
  FeedState,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
} from '@filtix/datafeed';
import type { DrawingDocument, DrawingDocumentV1, DrawingStore, DrawingTool } from '@filtix/drawings';

export type TerminalSingleStudyKind = 'sma' | 'ema' | 'rsi';
export type TerminalStudyKind = TerminalSingleStudyKind | 'macd' | 'bollinger';

export interface TerminalSingleStudyOptions {
  kind: TerminalSingleStudyKind;
  period: number;
  color?: string;
  lineWidth?: number;
  visible?: boolean;
}

export interface TerminalMacdStudyOptions {
  kind: 'macd';
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  color?: string;
  signalColor?: string;
  positiveColor?: string;
  negativeColor?: string;
  lineWidth?: number;
  visible?: boolean;
}

export interface TerminalBollingerStudyOptions {
  kind: 'bollinger';
  period: number;
  multiplier: number;
  color?: string;
  upperColor?: string;
  lowerColor?: string;
  fillColor?: string;
  fillOpacity?: number;
  lineWidth?: number;
  visible?: boolean;
}

export type TerminalStudyOptions =
  | TerminalSingleStudyOptions
  | TerminalMacdStudyOptions
  | TerminalBollingerStudyOptions;

export interface TerminalSingleStudy {
  id: string;
  kind: TerminalSingleStudyKind;
  period: number;
  color: string;
  lineWidth: number;
  visible: boolean;
}

export interface TerminalMacdStudy {
  id: string;
  kind: 'macd';
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  color: string;
  signalColor: string;
  positiveColor: string;
  negativeColor: string;
  lineWidth: number;
  visible: boolean;
}

export interface TerminalBollingerStudy {
  id: string;
  kind: 'bollinger';
  period: number;
  multiplier: number;
  color: string;
  upperColor: string;
  lowerColor: string;
  fillColor: string;
  fillOpacity: number;
  lineWidth: number;
  visible: boolean;
}

export type TerminalStudy = TerminalSingleStudy | TerminalMacdStudy | TerminalBollingerStudy;

export type TerminalSingleStudyPatch = Partial<
  Pick<TerminalSingleStudy, 'period' | 'color' | 'lineWidth' | 'visible'>
>;
export type TerminalMacdStudyPatch = Partial<
  Pick<
    TerminalMacdStudy,
    | 'fastPeriod'
    | 'slowPeriod'
    | 'signalPeriod'
    | 'color'
    | 'signalColor'
    | 'positiveColor'
    | 'negativeColor'
    | 'lineWidth'
    | 'visible'
  >
>;
export type TerminalBollingerStudyPatch = Partial<
  Pick<
    TerminalBollingerStudy,
    | 'period'
    | 'multiplier'
    | 'color'
    | 'upperColor'
    | 'lowerColor'
    | 'fillColor'
    | 'fillOpacity'
    | 'lineWidth'
    | 'visible'
  >
>;
export type TerminalStudyPatch =
  | TerminalSingleStudyPatch
  | TerminalMacdStudyPatch
  | TerminalBollingerStudyPatch;

export interface TerminalSettings {
  theme: 'dark' | 'light';
  followLatest: boolean;
  volume: boolean;
  emaPeriod: number | null;
}

export type TerminalPaneId = 'price' | 'terminal-volume-pane' | `terminal-${string}-pane`;
export interface TerminalPaneLayout {
  id: TerminalPaneId;
  weight: number;
  minHeight: number;
}
export interface TerminalLayout {
  panes: readonly TerminalPaneLayout[];
  maximizedPaneId: TerminalPaneId | null;
  studiesOpen: boolean;
}
export interface TerminalLayoutPatch {
  panes?: readonly { id: TerminalPaneId; weight?: number; minHeight?: number }[];
  maximizedPaneId?: TerminalPaneId | null;
  studiesOpen?: boolean;
}

export interface TerminalOptions {
  layout?: TerminalLayoutPatch;
  provider: MarketDataProvider;
  query: MarketQuery;
  symbols?: readonly string[];
  intervals?: readonly string[];
  settings?: Partial<TerminalSettings>;
  studies?: readonly TerminalStudyOptions[];
  feed?: Omit<FeedSessionOptions, 'provider' | 'onChange' | 'onState'>;
  alerts?: { store?: PriceAlertStore; monitor?: PriceAlertMonitor };
  onAlert?(event: PriceAlertEvent): void;
  onState?(state: TerminalState): void;
}

export interface TerminalState {
  layout: TerminalLayout;
  feed: FeedState;
  settings: TerminalSettings;
  studies: readonly TerminalStudy[];
  error: string | null;
  destroyed: boolean;
}

export interface TerminalWorkspaceMarket {
  query: MarketQuery;
  drawings: DrawingDocument;
}

export interface TerminalWorkspaceMarketV1 {
  query: MarketQuery;
  drawings: DrawingDocumentV1;
}

export interface TerminalWorkspaceV1 {
  schema: 'filtix-terminal';
  version: 1;
  providerId: string;
  query: MarketQuery;
  settings: TerminalSettings;
  markets: readonly TerminalWorkspaceMarketV1[];
}

export interface TerminalWorkspaceV2 {
  schema: 'filtix-terminal';
  version: 2;
  providerId: string;
  query: MarketQuery;
  settings: Omit<TerminalSettings, 'emaPeriod'>;
  studies: readonly TerminalSingleStudy[];
  markets: readonly TerminalWorkspaceMarketV1[];
}

export interface TerminalWorkspaceV3 {
  schema: 'filtix-terminal';
  version: 3;
  providerId: string;
  query: MarketQuery;
  settings: Omit<TerminalSettings, 'emaPeriod'>;
  studies: readonly TerminalStudy[];
  markets: readonly TerminalWorkspaceMarketV1[];
}

export interface TerminalWorkspaceV4 extends Omit<TerminalWorkspaceV3, 'version'> {
  version: 4;
  layout: TerminalLayout;
}
export interface TerminalWorkspaceV4WithDrawingsV2 extends Omit<TerminalWorkspaceV4, 'markets'> {
  markets: readonly TerminalWorkspaceMarket[];
}
export interface TerminalWorkspace extends Omit<TerminalWorkspaceV4WithDrawingsV2, 'version'> {
  version: 5;
  alerts: PriceAlertDocument;
}

export interface TerminalApi {
  getLayout(): TerminalLayout;
  applyLayout(patch: TerminalLayoutPatch): void;
  resetLayout(): void;
  readonly chart: ChartApi;
  setMarket(query: MarketQuery): Promise<void>;
  retry(): Promise<void>;
  loadMore(): Promise<void>;
  applyCorrections(bars: readonly MarketBar[]): void;
  getState(): TerminalState;
  getData(): readonly MarketBar[];
  addStudy(options: TerminalStudyOptions): string;
  updateStudy(id: string, patch: TerminalStudyPatch): void;
  removeStudy(id: string): boolean;
  getStudies(): readonly TerminalStudy[];
  applySettings(partial: Partial<TerminalSettings>): void;
  getSettings(): TerminalSettings;
  getWorkspace(): TerminalWorkspace;
  getAlerts(): PriceAlertStore;
  getAlertState(): PriceAlertMonitorState;
  restoreWorkspace(value: unknown): Promise<void>;
  setTool(tool: DrawingTool): void;
  getDrawings(): DrawingStore;
  destroy(): void;
}
import type {
  PriceAlertDocument,
  PriceAlertEvent,
  PriceAlertMonitor,
  PriceAlertMonitorState,
  PriceAlertStore,
} from '@filtix/alerts';
