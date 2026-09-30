import type {
  PriceAlertEvent,
  PriceAlertMonitor,
  PriceAlertMonitorState,
  PriceAlertStore,
} from '@filtrix.net/alerts';
import type { MarketQuery } from '@filtrix.net/datafeed';
import type { TerminalApi, TerminalOptions, TerminalState, TerminalWorkspace } from './types';

export type TerminalGridLayout = 1 | 2 | 4;
export type TerminalGridCellId = 'cell-1' | 'cell-2' | 'cell-3' | 'cell-4';

export interface TerminalGridSync {
  viewport: boolean;
  crosshair: boolean;
  crosshairMatch: 'exact' | 'nearest';
}

export interface TerminalGridCellWorkspace {
  id: TerminalGridCellId;
  workspace: TerminalWorkspace;
}

export interface TerminalGridWorkspace {
  schema: 'filtix-terminal-grid';
  version: 1;
  providerId: string;
  layout: TerminalGridLayout;
  activeCellId: TerminalGridCellId;
  sync: TerminalGridSync;
  cells: readonly TerminalGridCellWorkspace[];
}

export interface TerminalGridCellState {
  id: TerminalGridCellId;
  mounted: boolean;
  query: MarketQuery;
  terminal: TerminalState | null;
}

export interface TerminalGridState {
  layout: TerminalGridLayout;
  activeCellId: TerminalGridCellId;
  sync: TerminalGridSync;
  cells: readonly TerminalGridCellState[];
  alertState: PriceAlertMonitorState;
  error: string | null;
  destroyed: boolean;
}

export interface TerminalGridOptions {
  provider: TerminalOptions['provider'];
  query: TerminalOptions['query'];
  symbols?: TerminalOptions['symbols'];
  intervals?: TerminalOptions['intervals'];
  settings?: TerminalOptions['settings'];
  studies?: TerminalOptions['studies'];
  feed?: TerminalOptions['feed'];
  layout?: TerminalGridLayout;
  sync?: Partial<TerminalGridSync>;
  alerts?: {
    monitor?: PriceAlertMonitor;
    stores?: Readonly<Record<TerminalGridCellId, PriceAlertStore>>;
  };
  onState?(state: TerminalGridState): void;
  onAlert?(cellId: TerminalGridCellId, event: PriceAlertEvent): void;
}

export interface TerminalGridApi {
  getState(): TerminalGridState;
  setLayout(layout: TerminalGridLayout): Promise<void>;
  setActiveCell(cellId: TerminalGridCellId): void;
  setSync(sync: Partial<TerminalGridSync>): void;
  getTerminal(cellId: TerminalGridCellId): TerminalApi | null;
  getWorkspace(): TerminalGridWorkspace;
  restoreWorkspace(value: unknown): Promise<void>;
  destroy(): void;
}
