import { createTerminal } from '@filtrix.net/terminal';
const host = document.getElementById('study-host');
const query = { symbol: 'TEST', interval: '1m' };
const start = Date.UTC(2026, 8, 1);
let terminal,
  bars = [],
  handlers,
  activeRequests = 0,
  activeSubscriptions = 0,
  historyRequests = 0;
let projection = null,
  detachProjection;
const row = (index) => {
  const open = 100 + (index % 97) / 10 + (index % 7) / 3;
  const close = open + ((index % 5) - 2) * 0.17;
  return {
    time: start + index * 60000,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100 + (index % 113),
    revision: 1,
  };
};
const provider = {
  id: 'filtix-study-workload',
  revisionMode: 'monotonic',
  maxPageSize: 10000,
  async getHistory(request) {
    historyRequests++;
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
      activeRequests--;
    }
  },
  subscribe(q, next) {
    handlers = next;
    activeSubscriptions++;
    queueMicrotask(() => {
      if (handlers === next) next.onOpen();
    });
    return () => {
      if (handlers === next) handlers = null;
      activeSubscriptions--;
    };
  },
};
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = terminal.getState();
    if (state.error || state.feed.status === 'error') throw Error(state.error || state.feed.error?.message);
    if (state.feed.status === 'live') {
      await terminal.chart.whenIdle();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Maximum-data terminal did not become live');
}
async function mount(count, studies) {
  detachProjection?.();
  terminal?.destroy();
  bars = Array.from({ length: count }, (_, index) => row(index));
  terminal = createTerminal(host, {
    provider,
    query,
    studies,
    feed: { initialLimit: Math.min(count, 10000), pageSize: 10000, maxBars: 100000, staleAfterMs: 120000 },
  });
  await ready();
  while (terminal.getData().length < count) {
    await terminal.loadMore();
    await ready();
  }
  terminal.chart.setVisibleRange({ from: count - 1000, to: count });
  detachProjection = terminal.chart.attachPrimitive({
    draw(ctx, value) {
      projection = {
        panes: value.panes.map((pane) => ({ ...pane })),
        plotWidth: value.plotWidth,
        plotHeight: value.plotHeight,
      };
    },
  });
  await terminal.chart.whenIdle();
  return {
    state: terminal.getState(),
    diagnostics: terminal.chart.getDiagnostics(),
    projection,
    rows: terminal.getData().length,
  };
}
function mutate(index, revision) {
  const previous = bars[index];
  const close = previous.close + (revision % 2 ? 0.03 : -0.02);
  return {
    ...previous,
    close,
    high: Math.max(previous.high, close),
    low: Math.min(previous.low, close),
    revision: previous.revision + 1,
  };
}
async function correction(index) {
  const bar = mutate(index, index + bars[index].revision);
  bars[index] = bar;
  const begin = performance.now();
  terminal.applyCorrections([bar]);
  const synchronousMs = performance.now() - begin;
  await terminal.chart.whenIdle();
  return { kind: 'correction', index, synchronousMs, settledMs: performance.now() - begin };
}
async function deliver(kind, sequence) {
  let bar;
  if (kind === 'append') {
    bar = row(bars.length);
    bars.push(bar);
  } else {
    const index = bars.length - 1;
    bar = mutate(index, sequence);
    bars[index] = bar;
  }
  const begin = performance.now();
  handlers.onBar({ ...bar });
  const synchronousMs = performance.now() - begin;
  await terminal.chart.whenIdle();
  return { kind, time: bar.time, synchronousMs, settledMs: performance.now() - begin };
}
async function layout(operation, argument) {
  const before = terminal.getLayout();
  const beforeRange = terminal.chart.getVisibleRange();
  const beforeCounts = counts();
  const start = performance.now();
  if (operation === 'apply') terminal.applyLayout(argument);
  else if (operation === 'reset') terminal.resetLayout();
  else if (operation === 'resize') terminal.chart.resizePane(argument.id, argument.deltaCssPixels);
  else throw new TypeError('Unknown layout operation');
  const synchronousMs = performance.now() - start;
  await terminal.chart.whenIdle();
  const settledMs = performance.now() - start;
  return {
    operation,
    before,
    after: terminal.getLayout(),
    effective: terminal.chart.getPaneLayout(),
    beforeRange,
    afterRange: terminal.chart.getVisibleRange(),
    beforeCounts,
    afterCounts: counts(),
    diagnostics: terminal.chart.getDiagnostics(),
    projection,
    synchronousMs,
    settledMs,
  };
}
function getLayout() {
  return { preferences: terminal.getLayout(), effective: terminal.chart.getPaneLayout() };
}
function counts() {
  return { historyRequests, activeRequests, activeSubscriptions };
}
async function snapshot(indices) {
  const data = terminal.getData();
  const fields = ['time', 'open', 'high', 'low', 'close', 'volume', 'revision'];
  if (
    data.length !== bars.length ||
    !data.every((bar, i) => fields.every((key) => bar[key] === bars[i][key]))
  )
    throw Error('Maximum scene source mismatch');
  const previous = terminal.chart.getVisibleRange();
  const follow = terminal.getSettings().followLatest;
  terminal.chart.setVisibleRange({ from: -1, to: bars.length });
  await terminal.chart.whenIdle();
  let observed;
  const off = terminal.chart.subscribeCrosshairMove((event) => {
    observed = event;
  });
  const rendered = [];
  try {
    terminal.chart.setCrosshairTime(null);
    await terminal.chart.whenIdle();
    for (const index of indices) {
      observed = null;
      terminal.chart.setCrosshairTime(bars[index].time);
      await terminal.chart.whenIdle();
      rendered.push({ index, time: observed?.time, points: observed?.points ?? {} });
    }
  } finally {
    off();
    terminal.chart.setCrosshairTime(null);
    terminal.chart.setVisibleRange(previous);
    terminal.chart.applyOptions({ followLatest: follow });
    await terminal.chart.whenIdle();
  }
  return {
    bars: bars.map((bar) => ({ ...bar })),
    rendered,
    studies: terminal.getStudies(),
    diagnostics: terminal.chart.getDiagnostics(),
    projection,
    state: terminal.getState(),
    activeRequests,
    activeSubscriptions,
    historyRequests,
  };
}
function destroy() {
  detachProjection?.();
  detachProjection = null;
  terminal?.destroy();
  return { canvases: host.querySelectorAll('canvas').length, activeRequests, activeSubscriptions };
}
window.studiesWorkload = {
  mount,
  correction,
  deliver,
  snapshot,
  counts,
  layout,
  getLayout,
  destroy,
  get terminal() {
    return terminal;
  },
  get projection() {
    return projection;
  },
};
