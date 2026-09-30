// Installed-archive-only workload. Loaded by main.tsx solely for ?test&drawing-tools.
import { createTerminal } from '@filtrix.net/terminal';

const host = document.createElement('div');
host.id = 'drawing-tools-host';
host.style.cssText = 'width:1440px;height:900px;max-width:100vw;max-height:100vh';
document.body.replaceChildren(host);
const query = { symbol: 'BTCUSDT', interval: '1m' };
const firstTime = Date.UTC(2026, 0, 1);
const kinds = [
  ['trend-line', 30],
  ['horizontal-line', 30],
  ['rectangle', 30],
  ['measure', 30],
  ['fibonacci-retracement', 30],
  ['parallel-channel', 25],
  ['text-note', 25],
];
const studies = [
  { kind: 'ema', period: 20, color: '#c27a50' },
  { kind: 'sma', period: 200, color: '#c7ef57' },
  { kind: 'bollinger', period: 20, multiplier: 2, fillColor: '#7aa2f7', fillOpacity: 0.12 },
  { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { kind: 'rsi', period: 14 },
];
let terminal = null,
  bars = [],
  stream = null,
  generation = 0,
  gated = true;
let activeRequests = 0,
  requests = 0,
  subscriptions = 0,
  deliveries = 0;
let obsolete = null,
  checkpointBusy = false;
let providerEvents = [];
let providerHistoryWork = [];
let preparedDocument = null;
const copy = (value) => structuredClone(value);
function row(i) {
  const open = 100 + 3 * Math.sin(i / 100) + (i % 17) / 10;
  const close = open + Math.sin(i / 11) * 0.6;
  return {
    time: firstTime + i * 60000,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100 + (i % 113),
    revision: 1,
  };
}
const provider = {
  id: 'filtix-drawing-tools-workload-v1',
  revisionMode: 'monotonic',
  maxPageSize: 10000,
  async getHistory(request) {
    const historyStart = performance.now();
    requests++;
    activeRequests++;
    try {
      const selected = bars.filter(
        (bar) =>
          (request.before === undefined || bar.time < request.before) &&
          (request.from === undefined || bar.time >= request.from),
      );
      const page =
        request.from === undefined ? selected.slice(-request.limit) : selected.slice(0, request.limit);
      return { bars: page.map((bar) => ({ ...bar })), exhausted: page.length === selected.length };
    } finally {
      providerHistoryWork.push(performance.now() - historyStart);
      activeRequests--;
    }
  },
  subscribe(_query, handlers) {
    subscriptions++;
    stream = handlers;
    queueMicrotask(() => {
      if (stream === handlers) handlers.onOpen();
    });
    return () => {
      if (stream === handlers) stream = null;
      subscriptions--;
      obsolete = handlers;
    };
  },
};
async function ready() {
  for (let i = 0; i < 200; i++) {
    const state = terminal.getState();
    if (state.error || state.feed.status === 'error') throw Error(state.error || state.feed.error?.message);
    if (state.feed.status === 'live') {
      await terminal.chart.whenIdle();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Drawing tools terminal did not become live');
}
function drawingMix(count) {
  const start = Math.max(0, count - 850),
    scene = [];
  for (const [type, amount] of kinds)
    for (let j = 0; j < amount; j++) {
      const i = start + ((scene.length * 4) % 700);
      const point = (offset, delta) => ({
        time: bars[i + offset].time,
        price: bars[i + offset].close + delta,
      });
      const points =
        type === 'horizontal-line' || type === 'text-note'
          ? [point(0, 0)]
          : type === 'parallel-channel'
            ? [point(0, -2), point(20, 2), point(5, 2)]
            : [point(0, -2), point(20, 2)];
      const item = {
        id: `b4-${type}-${j}`,
        type,
        paneId: 'price',
        points,
        visible: true,
        locked: false,
        style: { color: '#c7ef57', lineWidth: 1.5, fillOpacity: 0.12 },
      };
      if (type === 'fibonacci-retracement')
        item.levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => ({ ratio }));
      if (type === 'text-note') {
        item.text = `Note ${j}\nSource`;
        item.fontSize = 12;
      }
      scene.push(item);
    }
  return { schema: 'filtix-drawings', version: 2, timeDomain: 'utc-ms', drawings: scene };
}
async function mount(count = 100000, withDrawings = true) {
  if (terminal) terminal.destroy();
  generation++;
  gated = true;
  bars = Array.from({ length: count }, (_, i) => row(i));
  providerEvents = [];
  providerHistoryWork = [];
  terminal = createTerminal(host, {
    provider,
    query,
    symbols: ['BTCUSDT', 'ETHUSDT'],
    intervals: ['1m'],
    studies,
    feed: {
      initialLimit: Math.min(count, 10000),
      pageSize: 10000,
      maxBars: 100000,
      staleAfterMs: 120000,
      requestTimeoutMs: 30000,
    },
  });
  terminal.chart.applyOptions({ diagnostics: true });
  await ready();
  while (terminal.getData().length < count) {
    await terminal.loadMore();
    await ready();
  }
  terminal.chart.setVisibleRange({ from: count - 1000, to: count });
  await terminal.chart.whenIdle();
  if (withDrawings) {
    terminal.getDrawings().restore(drawingMix(count));
    await terminal.chart.whenIdle();
  }
  const d = terminal.chart.getDiagnostics();
  return {
    rows: terminal.getData().length,
    drawingCount: terminal.getDrawings().list().length,
    series: d.seriesCount,
    panes: terminal.chart.getPaneLayout().panes.length,
    range: terminal.chart.getVisibleRange(),
    generation,
    studies: terminal.getStudies(),
  };
}
function prepare(count = 100000) {
  terminal?.destroy();
  terminal = null;
  gated = true;
  bars = Array.from({ length: count }, (_, index) => row(index));
  preparedDocument = drawingMix(count);
  providerEvents = [];
  providerHistoryWork = [];
  return { rows: bars.length, firstTime, fixture: 'drawing-tools-v1' };
}
async function fullOperation(scope, workspace = null) {
  if (terminal || bars.length !== 100000 || !preparedDocument)
    throw Error('Full operation requires independently prepared 100k rows and no terminal');
  const started = performance.now();
  const parts = {
    constructorMs: 0,
    optionsMs: 0,
    initialHistoryWallMs: 0,
    historyCallsMs: [],
    historyRoundTripMs: [],
    rangeMs: 0,
    preDrawingIdleMs: 0,
    documentRestoreMs: 0,
    workspaceKickoffMs: 0,
    workspaceRoundTripMs: 0,
    processingElapsedMs: 0,
    finalIdleDrainMs: 0,
  };
  const frames = [];
  const native = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
  if (!native || typeof native.value !== 'function')
    throw Error('Native requestAnimationFrame descriptor unavailable');
  let previousCounters = null;
  let stage = 'install-frame-observer';
  let failure = null;
  let cleanupFailure = null;
  let result = null;
  Object.defineProperty(window, 'requestAnimationFrame', {
    ...native,
    value: function (callback) {
      return Reflect.apply(native.value, this, [
        (timestamp) => {
          try {
            callback(timestamp);
          } finally {
            if (terminal) {
              const d = terminal.chart.getDiagnostics();
              const counters = [d.sceneDraws, d.primitiveDraws, d.overlayDraws];
              if (!previousCounters || counters.some((value, index) => value !== previousCounters[index]))
                frames.push({
                  counters,
                  renderMs: d.lastRenderMs,
                  at: performance.timeOrigin + performance.now(),
                });
              previousCounters = counters;
            }
          }
        },
      ]);
    },
  });
  try {
    generation++;
    stage = 'construct-terminal';
    const createStart = performance.now();
    try {
      terminal = createTerminal(host, {
        provider,
        query,
        symbols: ['BTCUSDT', 'ETHUSDT'],
        intervals: ['1m'],
        studies: scope === 'full-scene' ? studies : [],
        feed: {
          initialLimit: 10000,
          pageSize: 10000,
          maxBars: 100000,
          staleAfterMs: 120000,
          requestTimeoutMs: 30000,
        },
      });
    } finally {
      parts.constructorMs = performance.now() - createStart;
    }
    stage = 'apply-diagnostics';
    const optionsStart = performance.now();
    try {
      terminal.chart.applyOptions({ diagnostics: true });
    } finally {
      parts.optionsMs = performance.now() - optionsStart;
    }
    stage = 'initial-history-and-study-rebuild';
    const initialHistoryStart = performance.now();
    try {
      await ready();
    } finally {
      parts.initialHistoryWallMs = performance.now() - initialHistoryStart;
    }
    while (terminal.getData().length < 100000) {
      stage = 'history-page-and-study-rebuild';
      const historyStart = performance.now();
      try {
        let request;
        try {
          request = terminal.loadMore();
        } finally {
          parts.historyCallsMs.push(performance.now() - historyStart);
        }
        await request;
        await ready();
      } finally {
        parts.historyRoundTripMs.push(performance.now() - historyStart);
      }
    }
    stage = 'set-reference-range';
    const rangeStart = performance.now();
    try {
      terminal.chart.setVisibleRange({ from: 99000, to: 100000 });
    } finally {
      parts.rangeMs = performance.now() - rangeStart;
    }
    stage = 'pre-drawing-idle';
    const preDrawingIdleStart = performance.now();
    try {
      await terminal.chart.whenIdle();
    } finally {
      parts.preDrawingIdleMs = performance.now() - preDrawingIdleStart;
    }
    if (scope === 'full-scene') {
      stage = 'restore-prepared-drawings';
      const drawingStart = performance.now();
      try {
        terminal.getDrawings().restore(preparedDocument);
      } finally {
        parts.documentRestoreMs = performance.now() - drawingStart;
      }
    } else if (scope === 'full-workspace-restore') {
      if (!workspace) throw Error('Full workspace snapshot missing');
      stage = 'restore-workspace';
      const restoreStart = performance.now();
      try {
        let pending;
        try {
          pending = terminal.restoreWorkspace(workspace);
        } finally {
          parts.workspaceKickoffMs = performance.now() - restoreStart;
        }
        await pending;
      } finally {
        parts.workspaceRoundTripMs = performance.now() - restoreStart;
      }
    } else throw Error('Unknown full operation scope');
    parts.processingElapsedMs = performance.now() - started;
    stage = 'final-idle-drain';
    const finalIdleStart = performance.now();
    try {
      await terminal.chart.whenIdle();
    } finally {
      parts.finalIdleDrainMs = performance.now() - finalIdleStart;
    }
    const settledMs = performance.now() - started;
    const diagnostics = terminal.chart.getDiagnostics();
    const renderWorkMs = frames.reduce((sum, frame) => sum + frame.renderMs, 0);
    const synchronousMs =
      parts.constructorMs +
      parts.optionsMs +
      parts.historyCallsMs.reduce((sum, value) => sum + value, 0) +
      parts.rangeMs +
      parts.documentRestoreMs +
      parts.workspaceKickoffMs;
    result = {
      scope,
      rows: terminal.getData().length,
      drawings: terminal.getDrawings().list().length,
      series: diagnostics.seriesCount,
      panes: terminal.chart.getPaneLayout().panes.length,
      synchronousMs,
      operationWorkUpperBoundMs: parts.processingElapsedMs + renderWorkMs,
      settledMs,
      beforeSettleMs: parts.processingElapsedMs,
      renderMs: renderWorkMs,
      libraryWorkMs: synchronousMs + renderWorkMs,
      frameSubmitted: frames.length > 0,
      frames,
      components: {
        ...parts,
        providerHistoryWorkMs: [...providerHistoryWork],
      },
    };
  } catch (error) {
    parts.processingElapsedMs ||= performance.now() - started;
    failure = { stage, message: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      Object.defineProperty(window, 'requestAnimationFrame', native);
    } catch (error) {
      cleanupFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      await terminal?.chart.whenIdle();
    } catch (error) {
      cleanupFailure ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (failure || cleanupFailure) {
    let rows = null,
      drawings = null;
    try {
      rows = terminal?.getData().length ?? null;
    } catch {
      /* Preserve primary error. */
    }
    try {
      drawings = terminal?.getDrawings().list().length ?? null;
    } catch {
      /* Preserve primary error. */
    }
    return {
      status: 'rejected',
      scope,
      failureStage: failure?.stage ?? 'observer-cleanup',
      error: failure?.message ?? cleanupFailure,
      cleanupError: cleanupFailure,
      partial: {
        elapsedMs: performance.now() - started,
        components: { ...parts, providerHistoryWorkMs: [...providerHistoryWork] },
        frames,
        rows,
        drawings,
      },
    };
  }
  return result;
}
function counts() {
  return {
    requests,
    activeRequests,
    subscriptions,
    deliveries,
    generation,
    gated,
    canvases: host.querySelectorAll('canvas').length,
  };
}
async function timed(work, kind) {
  const before = terminal.chart.getDiagnostics();
  const begin = performance.now();
  const value = work();
  const synchronousMs = performance.now() - begin;
  await terminal.chart.whenIdle();
  const settledMs = performance.now() - begin;
  const after = terminal.chart.getDiagnostics();
  const frameSubmitted =
    after.sceneDraws !== before.sceneDraws ||
    after.primitiveDraws !== before.primitiveDraws ||
    after.overlayDraws !== before.overlayDraws;
  return {
    kind,
    synchronousMs,
    settledMs,
    renderMs: frameSubmitted ? after.lastRenderMs : 0,
    libraryWorkMs: synchronousMs + (frameSubmitted ? after.lastRenderMs : 0),
    frameSubmitted,
    diagnostics: after,
    value,
  };
}
function edit(i) {
  const item = terminal.getDrawings().list()[i % 200];
  return timed(() => terminal.getDrawings().update(item.id, { style: { color: '#66b9c7' } }), 'update');
}
function navigate(i) {
  const n = bars.length,
    from = n - 1010 - (i % 20);
  return timed(() => terminal.chart.setVisibleRange({ from, to: from + 1000 }), 'navigation');
}
function replace(index) {
  const old = bars.at(-1),
    close = old.close + (index % 2 ? 0.03 : -0.02);
  const bar = {
    ...old,
    close,
    high: Math.max(old.high, close),
    low: Math.min(old.low, close),
    revision: old.revision + 1,
  };
  bars[bars.length - 1] = bar;
  providerEvents.push({ kind: 'replace', index: bars.length - 1, bar: { ...bar } });
  return bar;
}
function deliver(kind, index) {
  if (!stream) throw Error('No active stream');
  const sourceRowsBefore = bars.length;
  let bar;
  if (kind === 'append') {
    bar = row(bars.length);
    bars.push(bar);
    providerEvents.push({ kind: 'append', index: bars.length - 1, bar: { ...bar } });
  } else if (kind === 'replace') bar = replace(index);
  else throw Error('Unknown delivery');
  deliveries++;
  let browserDeliveredAt;
  return timed(() => {
    browserDeliveredAt = performance.timeOrigin + performance.now();
    stream.onBar({ ...bar });
  }, kind).then((sample) => ({
    ...sample,
    browserDeliveredAt,
    deliveredBar: { ...bar },
    sourceRowsBefore,
    sourceRowsAfter: bars.length,
  }));
}
function restore(document) {
  return timed(() => terminal.getDrawings().restore(document), 'restore');
}
function correction(index) {
  const old = bars[index],
    bar = { ...old, close: old.close + 0.07, high: old.high + 0.07, revision: old.revision + 1 };
  bars[index] = bar;
  providerEvents.push({ kind: 'correction', index, bar: { ...bar } });
  return timed(() => terminal.applyCorrections([bar]), 'correction');
}
function addRemoveCycle(index) {
  const store = terminal.getDrawings(),
    item = store.get(`b4-text-note-${index % 25}`);
  if (!item) throw Error('Cycle source missing');
  store.remove(item.id);
  store.add(item);
  if (store.list().length !== 200) throw Error('Cycle changed drawing count');
  return item.id;
}
async function semantic(index) {
  const store = terminal.getDrawings(),
    fib = store.get('b4-fibonacci-retracement-0'),
    note = store.get('b4-text-note-0');
  const outcome = (action, before, after, verified) => {
    if (!verified) throw Error('Semantic action had no verified effect: ' + action);
    return { action, before, after, verified: true };
  };
  switch (index % 10) {
    case 0: {
      const before = {
        visible: note.visible,
        selectedId: host.querySelector('[data-terminal-drawing-object]')?.value ?? null,
      };
      const button = host.querySelector('[data-terminal-drawings-toggle]');
      if (!button) throw Error('Native object control missing');
      button.click();
      const select = host.querySelector('[data-terminal-drawing-object]');
      select.value = note.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      store.update(note.id, { visible: false });
      const hidden = store.get(note.id).visible === false;
      const listed = [...select.options].some((option) => option.value === note.id);
      store.update(note.id, { visible: true });
      const after = { visible: store.get(note.id).visible, selectedId: select.value, hidden, listed };
      return outcome(
        'selection-hide-show',
        before,
        after,
        before.visible && after.visible && hidden && listed && after.selectedId === note.id,
      );
    }
    case 1: {
      store.update(note.id, { locked: !note.locked });
      const after = store.get(note.id).locked;
      return outcome('lock', { locked: note.locked }, { locked: after }, after !== note.locked);
    }
    case 2: {
      const color = fib.style.color === '#66b9c7' ? '#c7ef57' : '#66b9c7';
      store.update(fib.id, { style: { color } });
      return outcome(
        'style',
        { color: fib.style.color },
        { color: store.get(fib.id).style.color },
        store.get(fib.id).style.color !== fib.style.color,
      );
    }
    case 3: {
      const before = fib.levels[3].color ?? null;
      const color = before === '#e0af68' ? '#66b9c7' : '#e0af68';
      store.update(fib.id, {
        levels: fib.levels.map((level, i) => (i === 3 ? { ...level, color } : level)),
      });
      const after = store.get(fib.id).levels[3].color ?? null;
      return outcome('level', { color: before }, { color: after }, after !== before);
    }
    case 4: {
      const text = `Note ${index}\nSource`;
      store.update(note.id, { text });
      return outcome(
        'text',
        { text: note.text },
        { text: store.get(note.id).text },
        store.get(note.id).text !== note.text,
      );
    }
    case 5: {
      const before = JSON.stringify(store.toJSON());
      const undone = store.undo();
      const middle = JSON.stringify(store.toJSON());
      const redone = store.redo();
      const after = JSON.stringify(store.toJSON());
      return outcome(
        'undo-redo',
        { hashInput: before },
        { hashInput: after, middleChanged: middle !== before },
        undone && redone && middle !== before && after === before,
      );
    }
    case 6: {
      const before = JSON.stringify(store.toJSON());
      const saved = terminal.getWorkspace();
      await terminal.restoreWorkspace(saved);
      const after = JSON.stringify(terminal.getDrawings().toJSON());
      return outcome('save-restore', { hashInput: before }, { hashInput: after }, after === before);
    }
    case 7: {
      const before = { drawings: store.list().length, rows: terminal.getData().length };
      await terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
      const isolatedDrawings = terminal.getDrawings().list().length;
      await terminal.setMarket(query);
      while (terminal.getData().length < bars.length) {
        await terminal.loadMore();
        await ready();
      }
      terminal.chart.setVisibleRange({ from: bars.length - 1000, to: bars.length });
      await terminal.chart.whenIdle();
      const after = {
        drawings: terminal.getDrawings().list().length,
        rows: terminal.getData().length,
        isolatedDrawings,
      };
      return outcome(
        'market-isolation',
        before,
        after,
        before.drawings === 200 &&
          before.rows === 100000 &&
          isolatedDrawings === 0 &&
          after.drawings === 200 &&
          after.rows === 100000,
      );
    }
    case 8: {
      const old = bars[Math.max(0, bars.length - 40)];
      await correction(Math.max(0, bars.length - 40));
      const actual = terminal.getData()[bars.length - 40];
      return outcome(
        'correction',
        { bar: old },
        { expected: bars[bars.length - 40], actual },
        actual.close !== old.close && JSON.stringify(actual) === JSON.stringify(bars[bars.length - 40]),
      );
    }
    case 9: {
      const beforeWidth = host.getBoundingClientRect().width;
      const width = host.style.width;
      host.style.width = index % 2 ? '1390px' : '1400px';
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const duringWidth = host.getBoundingClientRect().width;
      host.style.width = width;
      await terminal.chart.whenIdle();
      return outcome(
        'resize',
        { width: beforeWidth },
        { width: host.getBoundingClientRect().width, duringWidth },
        duringWidth !== beforeWidth,
      );
    }
  }
}
function metricSnapshot() {
  return {
    document: terminal.getDrawings().toJSON(),
    data: terminal.getData(),
    generation,
    market: terminal.getState().feed.query,
    counts: counts(),
  };
}
async function normalizeResourceState() {
  if (!terminal || bars.length !== 100000) throw Error('Resource endpoint requires active 100k terminal');
  terminal.getDrawings().restore(drawingMix(100000));
  const selector = host.querySelector('[data-terminal-drawing-object]');
  if (!selector) throw Error('Native object selector missing');
  selector.value = '';
  selector.dispatchEvent(new Event('change', { bubbles: true }));
  const panel = host.querySelector('[data-terminal-drawings-panel]');
  if (!panel) throw Error('Native object panel missing');
  if (!panel.hidden) host.querySelector('[data-terminal-drawings-toggle]').click();
  host.style.width = '1440px';
  terminal.chart.setVisibleRange({ from: 99000, to: 100000 });
  await terminal.chart.whenIdle();
  const state = resourceState();
  if (
    !state.editorClosed ||
    state.selectedId !== null ||
    state.document.drawings.length !== 200 ||
    state.market.symbol !== query.symbol ||
    state.market.interval !== query.interval ||
    state.rows !== 100000 ||
    state.series !== 12 ||
    state.panes !== 4
  )
    throw Error('Noncanonical resource endpoint');
  return state;
}
function resourceState() {
  if (!terminal) throw Error('Resource endpoint requires active terminal');
  const selector = host.querySelector('[data-terminal-drawing-object]');
  const panel = host.querySelector('[data-terminal-drawings-panel]');
  return {
    editorClosed: Boolean(panel?.hidden),
    selectedId: selector?.value || null,
    market: terminal.getState().feed.query,
    rows: terminal.getData().length,
    series: terminal.chart.getDiagnostics().seriesCount,
    panes: terminal.chart.getPaneLayout().panes.length,
    range: terminal.chart.getVisibleRange(),
    viewport: { width: host.getBoundingClientRect().width, height: host.getBoundingClientRect().height },
    document: terminal.getDrawings().toJSON(),
  };
}
function captureCanvas(checkpointId) {
  if (checkpointBusy) throw Error('Overlapping drawing checkpoint');
  checkpointBusy = true;
  return (async () => {
    const chart = terminal.chart,
      current = terminal,
      startGeneration = generation;
    const initialDocument = current.getDrawings().toJSON();
    const root = host.querySelector('[data-filtix-terminal-instance]');
    const target = root?.querySelector('canvas[data-filtix-layer="annotation"]');
    if (!target || host.querySelectorAll('canvas[data-filtix-layer="annotation"]').length !== 1) {
      checkpointBusy = false;
      return {
        checkpointId,
        generation,
        market: current.getState().feed.query,
        document: initialDocument,
        captureFailure: 'Exact annotation canvas identity unavailable',
        partial: {
          targetCanvasFound: Boolean(target),
          beforeContext: {
            document: initialDocument,
            generation: startGeneration,
            market: current.getState().feed.query,
            sourceRows: current.getData().length,
          },
        },
      };
    }
    let before;
    let beforeContext = null;
    let afterContext = null;
    let committedDocument = null;
    let captureError = null;
    const proto = CanvasRenderingContext2D.prototype;
    const methods = [
      'clearRect',
      'save',
      'restore',
      'beginPath',
      'moveTo',
      'lineTo',
      'closePath',
      'rect',
      'clip',
      'arc',
      'stroke',
      'fill',
      'strokeRect',
      'fillRect',
      'fillText',
      'setLineDash',
    ];
    const saved = new Map(),
      groups = [];
    let depth = 0,
      group = null,
      path = [],
      clearCount = 0,
      markerSeen = false,
      orphanPaint = 0,
      projection = null,
      removeMarker = null;
    const paint = new Set(['stroke', 'fill', 'strokeRect', 'fillRect', 'fillText', 'arc']);
    const context = (snapshot) => ({
      document: snapshot.document,
      generation: snapshot.generation,
      market: snapshot.market,
      counts: snapshot.counts,
      sourceRows: snapshot.data.length,
      sourceBoundary: [snapshot.data[0], snapshot.data.at(-1)],
    });
    try {
      const snapshot = metricSnapshot();
      committedDocument = snapshot.document;
      beforeContext = context(snapshot);
      before = JSON.stringify(snapshot);
      for (const name of methods) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (!descriptor || typeof descriptor.value !== 'function')
          throw Error('Canvas descriptor unavailable: ' + name);
        saved.set(name, descriptor);
        Object.defineProperty(proto, name, {
          ...descriptor,
          value: function (...args) {
            if (this.canvas === target) {
              if (name === 'clearRect') {
                clearCount++;
                depth = 0;
                groups.length = 0;
                group = null;
                path = [];
              }
              if (name === 'save') {
                depth++;
                if (depth === 2) {
                  group = { sourceIndex: groups.length, calls: [] };
                  groups.push(group);
                }
              }
              if (name === 'beginPath') path = [];
              if (['moveTo', 'lineTo', 'rect', 'arc', 'closePath'].includes(name)) path.push([name, ...args]);
              if (group && depth >= 2 && paint.has(name))
                group.calls.push({
                  method: name,
                  args: copy(args),
                  path: copy(path),
                  strokeStyle: String(this.strokeStyle),
                  fillStyle: String(this.fillStyle),
                  lineWidth: this.lineWidth,
                  globalAlpha: this.globalAlpha,
                  lineDash: this.getLineDash(),
                  font: this.font,
                  textBaseline: this.textBaseline,
                });
              else if (!group && depth === 1 && paint.has(name)) orphanPaint++;
              if (name === 'restore') {
                if (depth === 2) group = null;
                depth--;
              }
            }
            return Reflect.apply(descriptor.value, this, args);
          },
        });
      }
      removeMarker = chart.attachPrimitive({
        draw(ctx, value, mode) {
          if (ctx.canvas !== target || mode !== 'screen') throw Error('Marker context mismatch');
          markerSeen = true;
          const document = current.getDrawings().toJSON();
          const anchors = document.drawings.flatMap((drawing) =>
            drawing.points.map((point, pointIndex) => ({
              sourceId: drawing.id,
              pointIndex,
              x: value.timeToX(point.time),
              y: value.priceToY(point.price, drawing.paneId),
              loadedIndex: value.timeToLogicalIndex(point.time),
            })),
          );
          const priceBasis = {};
          const textMetrics = {};
          const measureMetrics = {};
          const fibonacciMetrics = {};
          for (const pane of value.panes) {
            const values = document.drawings
              .filter((item) => item.paneId === pane.id)
              .flatMap((item) => item.points.map((point) => point.price));
            if (values.length < 2) continue;
            const low = Math.min(...values),
              high = Math.max(...values);
            if (low === high) continue;
            priceBasis[pane.id] = [
              { price: low, y: value.priceToY(low, pane.id) },
              { price: high, y: value.priceToY(high, pane.id) },
            ];
          }
          for (const drawing of document.drawings)
            if (drawing.type === 'text-note') {
              ctx.font = drawing.fontSize + 'px sans-serif';
              textMetrics[drawing.id] = drawing.text.split('\n').map((line) => ctx.measureText(line).width);
            }
          for (const drawing of document.drawings)
            if (drawing.type === 'measure') {
              const change = drawing.points[1].price - drawing.points[0].price;
              const percent =
                drawing.points[0].price === 0 ? null : (change / Math.abs(drawing.points[0].price)) * 100;
              const number = (n) => (n === null ? 'n/a' : Number(n.toPrecision(5)).toString());
              const label =
                number(change) +
                ' (' +
                number(percent) +
                '%) · ' +
                number(Math.abs(drawing.points[1].time - drawing.points[0].time) / 86400000) +
                'd';
              ctx.font = '12px sans-serif';
              measureMetrics[drawing.id] = { label, width: ctx.measureText(label).width };
            }
          for (const drawing of document.drawings)
            if (drawing.type === 'fibonacci-retracement') {
              ctx.font = '11px sans-serif';
              const pane = value.panes.find((item) => item.id === drawing.paneId);
              fibonacciMetrics[drawing.id] = drawing.levels.map((level) => {
                const a = drawing.points[0].price,
                  b = drawing.points[1].price;
                const price =
                  level.ratio === 0
                    ? a
                    : level.ratio === 1
                      ? b
                      : pane?.scale === 'log'
                        ? Math.exp(Math.log(a) + level.ratio * (Math.log(b) - Math.log(a)))
                        : level.ratio > 0 && level.ratio < 1
                          ? a * (1 - level.ratio) + b * level.ratio
                          : ((a / Math.max(Math.abs(a), Math.abs(b))) * (1 - level.ratio) +
                              (b / Math.max(Math.abs(a), Math.abs(b))) * level.ratio) *
                            Math.max(Math.abs(a), Math.abs(b));
                const label =
                  Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(price.toPrecision(6));
                return { label, width: ctx.measureText(label).width };
              });
            }
          projection = {
            width: value.width,
            height: value.height,
            plotWidth: value.plotWidth,
            plotHeight: value.plotHeight,
            dpr: value.dpr,
            timeDomain: value.timeDomain,
            theme: copy(value.theme),
            panes: value.panes.map((pane) => ({ ...pane })),
            visibleRange: chart.getVisibleRange(),
            anchors,
            priceBasis,
            textMetrics,
            measureMetrics,
            fibonacciMetrics,
          };
        },
      });
      await chart.whenIdle();
      if (
        !markerSeen ||
        clearCount !== 1 ||
        orphanPaint !== 0 ||
        groups.length !== current.getDrawings().list().length ||
        depth !== 0
      )
        throw Error('Incomplete annotation paint grouping');
      const afterSnapshot = metricSnapshot();
      afterContext = context(afterSnapshot);
      const after = JSON.stringify(afterSnapshot);
      if (current !== terminal || generation !== startGeneration || before !== after)
        throw Error('Incoherent drawing checkpoint');
      const document = current.getDrawings().toJSON();
      groups.forEach((group, index) => {
        group.sourceId = document.drawings[index].id;
      });
      return {
        checkpointId,
        generation,
        market: current.getState().feed.query,
        document,
        observation: { canvas: 'annotation', groups, projection, targetCanvas: target.dataset.filtixLayer },
      };
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
      try {
        afterContext ??= context(metricSnapshot());
        committedDocument ??= afterContext.document;
      } catch {
        /* Keep the earlier capture error and available context. */
      }
      groups.forEach((group, index) => {
        group.sourceId ??= committedDocument?.drawings[index]?.id ?? null;
      });
      return {
        checkpointId,
        generation,
        market: current.getState().feed.query,
        document: committedDocument,
        captureFailure: captureError,
        partial: {
          beforeContext,
          afterContext,
          groups,
          projection,
          clearCount,
          depth,
          markerSeen,
          orphanPaint,
          targetCanvas: target.dataset.filtixLayer,
        },
      };
    } finally {
      let cleanupError;
      try {
        removeMarker?.();
      } catch (error) {
        cleanupError = error;
      }
      for (const [name, descriptor] of saved) {
        try {
          Object.defineProperty(proto, name, descriptor);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      checkpointBusy = false;
      try {
        await chart.whenIdle();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError)
        return {
          checkpointId,
          generation,
          market: current.getState().feed.query,
          document: committedDocument,
          captureFailure: captureError ?? 'Canvas observer cleanup: ' + String(cleanupError),
          captureError,
          cleanupError: String(cleanupError),
          partial: {
            beforeContext,
            afterContext,
            groups,
            projection,
            clearCount,
            depth,
            markerSeen,
            orphanPaint,
            targetCanvas: target.dataset.filtixLayer,
          },
        };
    }
  })();
}
async function checkpoint(id) {
  const wasGated = gated;
  gated = true;
  try {
    await terminal.chart.whenIdle();
    const source = terminal.getData();
    const expected = bars.map((bar) => ({ ...bar }));
    let capture;
    try {
      capture = await captureCanvas(id);
    } catch (error) {
      capture = {
        checkpointId: id,
        generation,
        market: terminal.getState().feed.query,
        document: terminal.getDrawings().toJSON(),
        captureFailure: error instanceof Error ? error.message : String(error),
        partial: { capturePromiseRejected: true },
      };
    }
    const sourceFailure =
      source.length !== terminal.getData().length ? 'Source changed during checkpoint' : null;
    return {
      ...capture,
      source: {
        rows: source.length,
        bars: source,
        expectedBars: expected,
        provenance: {
          fixture: 'drawing-tools-v1',
          firstTime,
          preparedRows: expected.length - providerEvents.filter((event) => event.kind === 'append').length,
          events: providerEvents.map((event) => ({ ...event, bar: { ...event.bar } })),
        },
      },
      sourceFailure,
    };
  } finally {
    gated = wasGated;
  }
}
function obsoleteDelivery() {
  if (!obsolete) return null;
  const callback = obsolete;
  obsolete = null;
  const before = { html: host.innerHTML, counts: counts() };
  callback.onBar(row(bars.length - 1));
  callback.onOpen();
  callback.onClose();
  return { before, after: { html: host.innerHTML, counts: counts() } };
}
function destroy() {
  terminal?.destroy();
  terminal = null;
  generation++;
  gated = true;
  return counts();
}
window.terminalHarness = {
  get terminal() {
    return terminal;
  },
  fixture: {
    gate(value) {
      gated = value;
    },
    counts,
  },
  drawingTools: {
    mount,
    prepare,
    fullOperation,
    normalizeResourceState,
    resourceState,
    drawingMix: () => drawingMix(bars.length),
    counts,
    metricSnapshot,
    edit,
    navigate,
    deliver,
    restore,
    correction,
    addRemoveCycle,
    semantic,
    checkpoint,
    obsoleteDelivery,
    destroy,
    get host() {
      return host;
    },
  },
};
