import { afterEach, expect, test, vi } from 'vitest';
import type { ChartApi } from '@filtrix.net/charts';
import * as chartInternal from '@filtrix.net/charts/internal';
import type { FeedChange, FeedSession, MarketDataProvider } from '@filtrix.net/datafeed';
import * as indicatorInternal from '@filtrix.net/indicators/internal';
import { prepareTerminalWithDependencies } from './terminal';

vi.mock('./study-controls', () => ({
  createStudyControls: (doc: Document) => ({
    toggle: doc.createElement('button'),
    panel: doc.createElement('div'),
    render() {},
    setOpen() {},
    setEditingFocus() {},
    destroy() {},
  }),
}));
vi.mock('./drawing-controls', () => ({
  createDrawingControls: (doc: Document) => ({
    toggle: doc.createElement('button'),
    refresh() {},
    destroy() {},
  }),
}));
vi.mock('./alert-controls', () => ({
  createAlertControls: (doc: Document) => ({
    toggle: doc.createElement('button'),
    panel: doc.createElement('div'),
    refresh() {},
    destroy() {},
  }),
}));
vi.mock('./terminal-layout-controls', () => ({
  createTerminalLayoutControls: (doc: Document) => ({
    root: doc.createElement('div'),
    refreshAvailability() {},
    render() {},
    destroy() {},
  }),
}));
vi.mock('./layout-runtime', () => ({
  TerminalLayoutRuntime: class {
    ownMembership<T>(work: () => T): T {
      return work();
    }
    sync() {}
    destroy() {}
  },
}));
vi.mock('./responsive-layout', () => ({
  presentationFor: () => ({
    mode: 'rail',
    editorHeight: 0,
    effectiveMaximizedPaneId: null,
    editingFocus: false,
  }),
}));
vi.mock('@filtrix.net/drawings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@filtrix.net/drawings')>()),
  createDrawingLayer: () => ({
    getState: () => ({ tool: 'select', magnet: false, selectedId: null }),
    destroy() {},
  }),
}));

class ElementStub extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly style = {
    cssText: '',
    getPropertyValue: () => '',
    getPropertyPriority: () => '',
    setProperty() {},
  };
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  parent: ElementStub | null = null;
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  constructor(readonly ownerDocument: DocumentStub) {
    super();
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
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(selector: string): ElementStub[] {
    const key = selector === '[data-terminal-action]' ? 'terminalAction' : '';
    const result: ElementStub[] = [];
    for (const child of this.children) {
      if (key in child.dataset) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector: string): ElementStub | null {
    const key = selector === '[data-terminal-footer]' ? 'terminalFooter' : '';
    for (const child of this.children) {
      if (key in child.dataset) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  getBoundingClientRect() {
    return { width: 1200, height: 800 };
  }
}
class DocumentStub {
  readonly defaultView = {};
  createElement() {
    return new ElementStub(this);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('an injected chart wrapper keeps terminal page resets on the array path even with positive capability', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const doc = new DocumentStub();
  const host = doc.createElement() as unknown as HTMLElement;
  const series: Array<{ id: string; setData: ReturnType<typeof vi.fn> }> = [];
  const chart = {
    addSeries(_type: string, options: { id: string }) {
      const handle = {
        id: options.id,
        setData: vi.fn(),
        update: vi.fn(),
        remove() {},
        applyOptions() {},
        getData: () => [],
      };
      series.push(handle);
      return handle;
    },
    subscribePaneLayoutChange: () => () => {},
    getPaneLayout: () => ({ panes: [{ id: 'price' }], maximizedPaneId: null }),
    destroy() {},
  } as unknown as ChartApi;
  let change: (event: FeedChange) => void = () => {};
  const feed = {
    load: async () => {},
    destroy() {},
    getState: () => ({
      status: 'idle',
      query: null,
      bars: 0,
      loadingMore: false,
      hasMore: false,
      lastUpdateAt: null,
      retryCount: 0,
      error: null,
    }),
  } as unknown as FeedSession;
  const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
  const owned = vi.spyOn(indicatorInternal, 'prepareOwnedBatch');
  const privateSet = vi.spyOn(chartInternal, 'setOwnedStudyColumns');
  const prepared = prepareTerminalWithDependencies(
    host,
    {
      provider: { id: 'owned-construction-fixture' },
      query: { symbol: 'TEST', interval: '1m' },
      settings: { volume: false, emaPeriod: 2 },
    } as Parameters<typeof prepareTerminalWithDependencies>[1],
    undefined,
    {
      createChart: () => chart,
      createFeedSession: ((options: { onChange(event: FeedChange): void }) => {
        change = options.onChange;
        return feed;
      }) as Parameters<typeof prepareTerminalWithDependencies>[3]['createFeedSession'],
    },
  );
  try {
    prepared.startNow();
    const ema = series.find((item) => item.id === 'terminal-ema');
    expect(ema).toBeDefined();
    ema!.setData.mockClear();
    change({
      type: 'reset',
      reason: 'initial',
      bars: [
        { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 2, open: 2, high: 2, low: 2, close: 2, volume: 2 },
      ],
    });
    expect(capability).not.toHaveBeenCalled();
    expect(owned).not.toHaveBeenCalled();
    expect(privateSet).not.toHaveBeenCalled();
    expect(ema!.setData).toHaveBeenCalledTimes(1);
    expect(ema!.setData).toHaveBeenCalledWith([{ time: 1 }, { time: 2, value: 1.5 }]);
  } finally {
    prepared.destroy();
  }
});

test('caller-supplied dependency objects with identical factories keep volume rebuilds on public setters', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  let chart: ChartApi;
  let change: (event: FeedChange) => void = () => {};
  const feed = {
    load: async () => {},
    destroy() {},
    getState: () => ({
      status: 'idle',
      query: null,
      bars: 0,
      loadingMore: false,
      hasMore: false,
      lastUpdateAt: null,
      retryCount: 0,
      error: null,
    }),
  } as unknown as FeedSession;
  const createChartFactory = (() => chart) as NonNullable<
    Parameters<typeof prepareTerminalWithDependencies>[3]['createChart']
  >;
  const createFeedFactory = ((options: { onChange(event: FeedChange): void }) => {
    change = options.onChange;
    return feed;
  }) as Parameters<typeof prepareTerminalWithDependencies>[3]['createFeedSession'];
  const dependencies = { createChart: createChartFactory, createFeedSession: createFeedFactory };
  const capability = vi.spyOn(chartInternal, 'hasOwnedStudyColumnCapability').mockReturnValue(true);
  const provider: MarketDataProvider = {
    id: 'owned-volume-fallback-fixture',
    revisionMode: 'arrival',
    maxPageSize: 64,
    async getHistory() {
      return { bars: [], exhausted: true };
    },
    subscribe() {
      return () => {};
    },
  };
  const bars = [
    { time: 1, open: 1, high: 2, low: 0, close: 1, volume: -0 },
    { time: 2, open: 2, high: 3, low: 1, close: 2, volume: 7 },
  ];

  for (const supplied of [dependencies, { ...dependencies }]) {
    const doc = new DocumentStub();
    const host = doc.createElement() as unknown as HTMLElement;
    const series: Array<{ id: string; setData: ReturnType<typeof vi.fn> }> = [];
    chart = {
      addPane: () => ({ id: 'terminal-volume-pane', remove() {} }),
      addSeries(_type: string, options: { id: string }) {
        const handle = {
          id: options.id,
          setData: vi.fn(),
          update: vi.fn(),
          remove() {},
          applyOptions() {},
          getData: () => [],
        };
        series.push(handle);
        return handle;
      },
      subscribePaneLayoutChange: () => () => {},
      getPaneLayout: () => ({ panes: [{ id: 'price' }], maximizedPaneId: null }),
      destroy() {},
    } as unknown as ChartApi;
    const prepared = prepareTerminalWithDependencies(
      host,
      {
        provider,
        query: { symbol: 'TEST', interval: '1m' },
        settings: { volume: true },
        studies: [{ kind: 'sma', period: 2 }],
      },
      undefined,
      supplied,
    );
    try {
      prepared.startNow();
      change({ type: 'reset', reason: 'initial', bars });
      const price = series.find((item) => item.id === 'terminal-price');
      const volume = series.find((item) => item.id === 'terminal-volume');
      expect(price?.setData).toHaveBeenCalledWith(bars);
      expect(volume?.setData).toHaveBeenCalledWith([
        { time: 1, value: -0 },
        { time: 2, value: 7 },
      ]);
      expect(volume?.setData).toHaveBeenCalledTimes(1);
      expect(capability).not.toHaveBeenCalled();
    } finally {
      prepared.destroy();
    }
  }
});
