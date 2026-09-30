import { afterEach, describe, expect, test, vi } from 'vitest';
import * as drawings from '@filtrix.net/drawings';
import { copyWorkspaceDocument, decodeWorkspace } from './codec';
import { createTerminalGridWithDependencies, type GridDependencies } from './grid';
import type { TerminalGridApi, TerminalGridState } from './grid-types';
import type { PreparedTerminal } from './terminal-preparation';
import type { TerminalApi, TerminalState } from './types';

// Only the DOM surface used by grid ownership and its native controls. Real grid,
// controls, workspace codecs, stores and membership remain under test.
class ElementStub extends EventTarget {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add() {} };
  className = '';
  textContent = '';
  value = '';
  checked = false;
  children: ElementStub[] = [];
  parent: ElementStub | null = null;
  constructor(readonly ownerDocument: DocumentStub) {
    super();
  }
  get childNodes() {
    return this.children;
  }
  get isConnected(): boolean {
    return this.parent !== null;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  append(...nodes: ElementStub[]) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: ElementStub[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  contains(node: ElementStub): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  getBoundingClientRect() {
    return { width: 1200, height: 800 };
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
}
class DocumentStub {
  activeElement: ElementStub | null = null;
  defaultView = {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  createElement() {
    return new ElementStub(this);
  }
}
function find(root: ElementStub, key: string, value?: string): ElementStub {
  if (Object.hasOwn(root.dataset, key) && (value === undefined || root.dataset[key] === value)) return root;
  for (const child of root.children) {
    try {
      return find(child, key, value);
    } catch {
      /* Search the next subtree. */
    }
  }
  throw new Error(`Missing control ${key}:${value}`);
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness(onState?: (state: TerminalGridState) => void) {
  vi.stubGlobal('HTMLElement', ElementStub);
  vi.stubGlobal('Element', ElementStub);
  const host = new ElementStub(new DocumentStub());
  const preparations: { emit: () => void; workspaceRead: ReturnType<typeof vi.fn> }[] = [];
  const prepare: NonNullable<GridDependencies['prepareTerminal']> = (_host, options, saved) => {
    const workspace =
      saved ??
      decodeWorkspace(
        {
          schema: 'filtix-terminal',
          version: 1,
          providerId: 'controls-fixture',
          query: options.query,
          settings: { theme: 'dark', followLatest: true, volume: true, emaPeriod: null },
          markets: [
            {
              query: options.query,
              drawings: {
                schema: 'filtix-drawings',
                version: 1,
                timeDomain: 'utc-ms',
                drawings: [
                  {
                    id: 'line',
                    type: 'horizontal-line',
                    paneId: 'price',
                    points: [{ time: 1, price: 10 }],
                    style: { color: '#123456', lineWidth: 2, fillOpacity: 0.2 },
                  },
                ],
              },
            },
          ],
        },
        {
          providerId: 'controls-fixture',
          symbols: ['BTCUSDT'],
          intervals: ['1m'],
          legacyAlertScopeId: options.alerts!.store!.toJSON().scopeId,
        },
      );
    const state: TerminalState = {
      layout: workspace.layout,
      settings: { ...workspace.settings, emaPeriod: null },
      studies: workspace.studies,
      error: null,
      destroyed: false,
      feed: {
        status: 'idle',
        retryCount: 0,
        query: null,
        bars: 0,
        hasMore: false,
        loadingMore: false,
        lastUpdateAt: null,
        error: null,
      },
    };
    const workspaceRead = vi.fn(() => copyWorkspaceDocument(workspace));
    let lease: (() => void) | null = null;
    const prepared: PreparedTerminal = {
      api: {
        getWorkspace: workspaceRead,
        getState: () => structuredClone(state),
        chart: {},
      } as unknown as TerminalApi,
      async start(startOptions) {
        lease = startOptions?.alertLease ?? null;
      },
      getAlertLease: () => lease,
      destroy() {
        lease?.();
        lease = null;
      },
    };
    preparations.push({ emit: () => options.onState?.(structuredClone(state)), workspaceRead });
    return prepared;
  };
  const grid = createTerminalGridWithDependencies(
    host as unknown as HTMLElement,
    {
      provider: {
        id: 'controls-fixture',
        revisionMode: 'arrival',
        maxPageSize: 10000,
        async getHistory() {
          return { bars: [], exhausted: true };
        },
        subscribe() {
          return () => {};
        },
      },
      query: { symbol: 'BTCUSDT', interval: '1m' },
      layout: 4,
      ...(onState ? { onState } : {}),
    },
    { prepareTerminal: prepare },
  );
  cleanups.push(() => grid.destroy());
  return { grid, host, preparations };
}

describe('native grid controls state projection', () => {
  test('feed-only control refreshes do not read or decode complete terminal workspaces', () => {
    const { grid, host, preparations } = harness();
    const copy = vi.spyOn(drawings, 'copyDrawingDocument');
    preparations.forEach((item) => item.workspaceRead.mockClear());
    for (let index = 0; index < 10; index++) preparations[index % 4]!.emit();
    expect(preparations.map((item) => item.workspaceRead.mock.calls.length)).toEqual([0, 0, 0, 0]);
    expect(copy).not.toHaveBeenCalled();
    grid.setActiveCell('cell-3');
    const viewport = find(host, 'gridViewport');
    viewport.checked = true;
    viewport.dispatchEvent(new Event('change'));
    const match = find(host, 'gridCrosshairMatch');
    match.value = 'nearest';
    match.dispatchEvent(new Event('change'));
    expect(find(host, 'gridActiveCell').textContent).toBe('ACTIVE 3');
    expect(find(host, 'gridLayout', '4').getAttribute('aria-pressed')).toBe('true');
    expect(viewport.checked).toBe(true);
    expect(match.value).toBe('nearest');
    expect(copy).not.toHaveBeenCalled();
    expect(grid.getState().sync).toEqual({ viewport: true, crosshair: false, crosshairMatch: 'nearest' });
    expect(copy).toHaveBeenCalled(); // Public reads still take the full defensive-copy path.
  });

  test('public workspaces and state remain independent and onState reentry remains observable', () => {
    let current: TerminalGridApi | undefined;
    const observed: TerminalGridState[] = [];
    const { grid, preparations, host } = harness((state) => {
      observed.push(state);
      if (current && state.activeCellId === 'cell-2') current.setActiveCell('cell-4');
    });
    current = grid;
    const workspace = grid.getWorkspace();
    workspace.cells[0]!.workspace.markets[0]!.drawings.drawings[0]!.points[0]!.price = 999;
    workspace.cells[0]!.workspace.query.symbol = 'MUTATED';
    expect(grid.getWorkspace().cells[0]!.workspace.markets[0]!.drawings.drawings[0]!.points[0]!.price).toBe(
      10,
    );
    expect(grid.getWorkspace().cells[0]!.workspace.query.symbol).toBe('BTCUSDT');
    const state = grid.getState();
    state.sync.viewport = true;
    state.cells[0]!.query.symbol = 'MUTATED';
    state.cells[0]!.terminal!.settings.theme = 'light';
    expect(grid.getState().cells[0]!.query.symbol).toBe('BTCUSDT');
    expect(grid.getState().cells[0]!.terminal!.settings.theme).toBe('dark');
    expect(grid.getState().sync.viewport).toBe(false);
    observed.length = 0;
    preparations[0]!.emit();
    expect(observed).toHaveLength(1);
    grid.setActiveCell('cell-2');
    expect(observed.map((item) => item.activeCellId)).toEqual(['cell-1', 'cell-2', 'cell-4']);
    expect(find(host, 'gridActiveCell').textContent).toBe('ACTIVE 4');
    observed[0]!.cells[0]!.query.symbol = 'MUTATED';
    expect(grid.getState().cells[0]!.query.symbol).toBe('BTCUSDT');
  });

  test('controls reflect adopted generations and ignore retired terminal callbacks', async () => {
    const { grid, preparations, host } = harness();
    const old = preparations[0]!;
    const workspace = grid.getWorkspace();
    workspace.layout = 2;
    workspace.activeCellId = 'cell-2';
    workspace.sync.crosshairMatch = 'nearest';
    await grid.restoreWorkspace(workspace);
    expect(find(host, 'gridLayout', '2').getAttribute('aria-pressed')).toBe('true');
    expect(find(host, 'gridActiveCell').textContent).toBe('ACTIVE 2');
    expect(find(host, 'gridCrosshairMatch').value).toBe('nearest');
    const copy = vi.spyOn(drawings, 'copyDrawingDocument');
    old.emit();
    preparations.at(-1)!.emit();
    expect(copy).not.toHaveBeenCalled();
    expect(find(host, 'gridActiveCell').textContent).toBe('ACTIVE 2');
    grid.destroy();
    old.emit();
    preparations.at(-1)!.emit();
    expect(host.children).toHaveLength(0);
  });
});
