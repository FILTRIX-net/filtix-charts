import { createChart } from '@filtix/charts';
import { SeriesStore } from '@filtix/core';
import { createFeedSession } from '@filtix/datafeed';
import type {
  HistoryRequest,
  MarketBar,
  MarketDataProvider,
  MarketQuery,
  MarketStreamHandlers,
} from '@filtix/datafeed';
import { createTerminal, type TerminalApi, type TerminalOptions } from '@filtix/terminal';
import { createTerminalWithDependencies, prepareTerminal } from '../../../packages/terminal/src/terminal';

type Scenario = 'create' | 'prepare' | 'same-factories' | 'volume-off';
type CopierCall = { scenario: Scenario | null; rows: number; returned: boolean; error?: string };
type HistoryReceipt = { limit: number; before: number | null; from: number | null; returned: number };
type Sample = {
  index: number;
  time: number;
  resolved: number | string | null;
  visibleRange: { from: number | string; to: number | string } | null;
  price: unknown;
  volume: unknown;
  sma: unknown;
  volumeNegativeZero: boolean;
};
type ScenarioReceipt = {
  scenario: Scenario;
  history: HistoryReceipt[];
  feedBars: number[];
  copierRows: number[];
  samples: Sample[];
  subscriptionsBeforeDestroy: number;
  subscriptionsAfterDestroy: number | null;
  canvasesAfterDestroy: number | null;
};
type AdmissionReport = {
  primaryError: string | null;
  cleanupErrors: string[];
  calls: CopierCall[];
  scenarios: ScenarioReceipt[];
};

const start = Date.UTC(2026, 8, 28);
const bars: MarketBar[] = Array.from({ length: 128 }, (_, index) => {
  const open = 100 + index;
  return {
    time: start + index * 60_000,
    open,
    high: open + 2,
    low: open - 1,
    close: open + 1,
    volume: index === 63 ? -0 : index === 127 ? +0 : index + 1,
  };
});
const query: MarketQuery = { symbol: 'TEST', interval: '1m' };
function fail(message: string): never {
  throw new Error(message);
}
const errorText = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function sameBar(actual: MarketBar, expected: MarketBar): boolean {
  return (['time', 'open', 'high', 'low', 'close', 'volume'] as const).every((key) =>
    Object.is(actual[key], expected[key]),
  );
}

function providerFor(scenario: Scenario, history: HistoryReceipt[]) {
  const subscriptions = new Set<{ active: boolean; handlers: MarketStreamHandlers }>();
  const provider: MarketDataProvider = {
    id: `price-volume-admission-${scenario}`,
    revisionMode: 'arrival',
    maxPageSize: 64,
    async getHistory(request: HistoryRequest, signal: AbortSignal) {
      if (signal.aborted) fail(`${scenario}: history request was aborted`);
      if (request.symbol !== query.symbol || request.interval !== query.interval)
        fail(`${scenario}: unexpected history query`);
      const eligible = bars.filter(
        (bar) =>
          (request.before === undefined || bar.time < request.before) &&
          (request.from === undefined || bar.time >= request.from),
      );
      const selected =
        request.from === undefined ? eligible.slice(-request.limit) : eligible.slice(0, request.limit);
      history.push({
        limit: request.limit,
        before: request.before ?? null,
        from: request.from ?? null,
        returned: selected.length,
      });
      return {
        bars: selected.map((bar) => ({ ...bar })),
        exhausted: request.before !== undefined || eligible.length <= request.limit,
      };
    },
    subscribe(subscriptionQuery, handlers) {
      if (subscriptionQuery.symbol !== query.symbol || subscriptionQuery.interval !== query.interval)
        fail(`${scenario}: unexpected subscription query`);
      const subscription = { active: true, handlers };
      subscriptions.add(subscription);
      queueMicrotask(() => {
        if (subscription.active) handlers.onOpen();
      });
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
  };
  return { provider, subscriptions };
}

async function ready(terminal: TerminalApi, count: number, scenario: Scenario): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const state = terminal.getState();
    if (state.feed.status === 'live' && state.feed.bars === count && !state.feed.loadingMore) {
      await terminal.chart.whenIdle();
      return;
    }
    if (state.feed.status === 'error' || state.error)
      fail(
        `${scenario}: feed failed while waiting for ${count} bars: ${state.error ?? state.feed.error?.message}`,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  fail(`${scenario}: feed did not reach ${count} live bars`);
}

async function sample(
  terminal: TerminalApi,
  index: number,
  volumeEnabled: boolean,
  cleanupErrors: string[],
): Promise<Sample> {
  const bar = bars[index]!;
  const observed: Array<Record<string, unknown>> = [];
  const unsubscribe = terminal.chart.subscribeCrosshairMove((event) => {
    if (event.time === bar.time) observed.push(event.points as Record<string, unknown>);
  });
  try {
    terminal.chart.fitContent();
    const resolved = terminal.chart.setCrosshairTime(bar.time, { match: 'exact' });
    await terminal.chart.whenIdle();
    const points = observed.at(-1) ?? fail(`No crosshair points for row ${index}`);
    const price = points['terminal-price'] as MarketBar | null;
    const volume = points['terminal-volume'] as { time: number; value: number } | null | undefined;
    const study = terminal.getStudies().find((item) => item.kind === 'sma');
    if (!study) fail('The admitted SMA study is missing');
    const sma = points[`terminal-${study.id}`] as { time: number; value: number } | null;
    if (resolved !== bar.time || !price || !sameBar(price, bar))
      fail(`Price/cursor mismatch at row ${index}`);
    if (volumeEnabled) {
      if (!volume || volume.time !== bar.time || !Object.is(volume.value, bar.volume))
        fail(`Volume mismatch at row ${index}`);
    } else if (volume != null) fail(`Volume point exists while volume is disabled at row ${index}`);
    const expectedSma = (bars[index - 2]!.close + bars[index - 1]!.close + bar.close) / 3;
    if (!sma || sma.time !== bar.time || !Object.is(sma.value, expectedSma))
      fail(`SMA mismatch at row ${index}`);
    const visibleRange = terminal.chart.getVisibleTimeRange();
    if (
      !visibleRange ||
      typeof visibleRange.from !== 'number' ||
      typeof visibleRange.to !== 'number' ||
      visibleRange.from > bar.time ||
      visibleRange.to < bar.time
    )
      fail(`Crosshair row ${index} is not visible`);
    return {
      index,
      time: bar.time,
      resolved,
      visibleRange,
      price,
      volume: volume ?? null,
      sma,
      volumeNegativeZero: volume !== undefined && volume !== null && Object.is(volume.value, -0),
    };
  } finally {
    try {
      unsubscribe();
    } catch (error) {
      cleanupErrors.push(`crosshair row ${index}: ${errorText(error)}`);
    }
  }
}

async function runScenario(scenario: Scenario, calls: CopierCall[], report: AdmissionReport): Promise<void> {
  const receipt: ScenarioReceipt = {
    scenario,
    history: [],
    feedBars: [],
    copierRows: [],
    samples: [],
    subscriptionsBeforeDestroy: 0,
    subscriptionsAfterDestroy: null,
    canvasesAfterDestroy: null,
  };
  report.scenarios.push(receipt);
  const host = document.createElement('main');
  host.className = 'terminal-admission-host';
  document.body.append(host);
  const { provider, subscriptions } = providerFor(scenario, receipt.history);
  const volumeEnabled = scenario !== 'volume-off';
  const options: TerminalOptions = {
    provider,
    query,
    settings: { volume: volumeEnabled },
    studies: [{ kind: 'sma', period: 3 }],
    feed: {
      mode: 'history',
      initialLimit: 64,
      pageSize: 64,
      maxBars: 128,
      staleAfterMs: 120_000,
      requestTimeoutMs: 10_000,
    },
  };
  let terminal: TerminalApi | null = null;
  let prepared: ReturnType<typeof prepareTerminal> | null = null;
  try {
    if (scenario === 'prepare') {
      prepared = prepareTerminal(host, options);
      terminal = prepared.api;
      await prepared.start();
    } else if (scenario === 'same-factories') {
      // The new object deliberately contains the exact source factories.
      terminal = createTerminalWithDependencies(host, options, { createChart, createFeedSession });
    } else terminal = createTerminal(host, options);
    await ready(terminal, 64, scenario);
    receipt.feedBars.push(terminal.getState().feed.bars);
    const first = terminal.getData();
    if (first.length !== 64 || first.some((bar, index) => !sameBar(bar, bars[index + 64]!)))
      fail(`${scenario}: initial public feed bars differ`);
    receipt.samples.push(await sample(terminal, 127, volumeEnabled, report.cleanupErrors));
    await terminal.loadMore();
    await ready(terminal, 128, scenario);
    receipt.feedBars.push(terminal.getState().feed.bars);
    const second = terminal.getData();
    if (second.length !== 128 || second.some((bar, index) => !sameBar(bar, bars[index]!)))
      fail(`${scenario}: backfilled public feed bars differ`);
    receipt.samples.push(await sample(terminal, 63, volumeEnabled, report.cleanupErrors));
    receipt.samples.push(await sample(terminal, 127, volumeEnabled, report.cleanupErrors));
    if (
      receipt.history.length !== 2 ||
      receipt.history[0]!.limit !== 64 ||
      receipt.history[0]!.before !== null ||
      receipt.history[0]!.returned !== 64 ||
      receipt.history[1]!.limit !== 64 ||
      receipt.history[1]!.before !== bars[64]!.time ||
      receipt.history[1]!.returned !== 64
    )
      fail(`${scenario}: history request sequence differs`);
    receipt.copierRows = calls
      .filter((call) => call.scenario === scenario && call.returned)
      .map((call) => call.rows);
    const expectedRows = scenario === 'create' || scenario === 'prepare' ? [0, 64, 128] : [];
    if (JSON.stringify(receipt.copierRows) !== JSON.stringify(expectedRows))
      fail(
        `${scenario}: copier rows ${JSON.stringify(receipt.copierRows)} instead of ${JSON.stringify(expectedRows)}`,
      );
    receipt.subscriptionsBeforeDestroy = subscriptions.size;
    if (receipt.subscriptionsBeforeDestroy !== 1)
      fail(`${scenario}: expected one active stream subscription`);
  } finally {
    try {
      if (prepared) prepared.destroy();
      else terminal?.destroy();
    } catch (error) {
      report.cleanupErrors.push(`${scenario}: destroy: ${errorText(error)}`);
    }
    receipt.subscriptionsAfterDestroy = subscriptions.size;
    if (receipt.subscriptionsAfterDestroy !== 0)
      report.cleanupErrors.push(`${scenario}: ${receipt.subscriptionsAfterDestroy} subscriptions remain`);
    try {
      receipt.canvasesAfterDestroy = host.querySelectorAll('canvas').length;
      if (receipt.canvasesAfterDestroy !== 0)
        report.cleanupErrors.push(`${scenario}: ${receipt.canvasesAfterDestroy} canvases remain`);
      host.remove();
    } catch (error) {
      report.cleanupErrors.push(`${scenario}: host cleanup: ${errorText(error)}`);
    }
  }
}

async function run(): Promise<AdmissionReport> {
  const report: AdmissionReport = { primaryError: null, cleanupErrors: [], calls: [], scenarios: [] };
  let activeScenario: Scenario | null = null;
  const prototype = SeriesStore.prototype;
  let symbol: symbol | null = null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    const matches = Object.getOwnPropertySymbols(prototype).filter(
      (candidate) => candidate.description === 'derive-owned-volume',
    );
    if (matches.length !== 1)
      fail(
        `Expected one derive-owned-volume symbol on source SeriesStore.prototype; found ${matches.length}`,
      );
    symbol = matches[0]!;
    descriptor = Object.getOwnPropertyDescriptor(prototype, symbol);
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.configurable)
      fail('The source owned-volume copier is not a configurable method');
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(prototype, symbol, {
      ...descriptor,
      value: function (this: SeriesStore, ...args: unknown[]) {
        const call: CopierCall = {
          scenario: activeScenario,
          rows: this.length,
          returned: false,
        };
        report.calls.push(call);
        try {
          const result = Reflect.apply(original, this, args);
          call.returned = true;
          return result;
        } catch (error) {
          call.error = errorText(error);
          throw error;
        }
      },
    });
    for (const scenario of ['create', 'prepare', 'same-factories', 'volume-off'] as const) {
      activeScenario = scenario;
      await runScenario(scenario, report.calls, report);
    }
  } catch (error) {
    report.primaryError = errorText(error);
  } finally {
    if (symbol && descriptor) {
      try {
        Object.defineProperty(prototype, symbol, descriptor);
      } catch (error) {
        report.cleanupErrors.push(`restore copier descriptor: ${errorText(error)}`);
      }
    }
    activeScenario = null;
  }
  return report;
}

declare global {
  interface Window {
    terminalPriceVolumeAdmission: { run: typeof run };
  }
}

// The callable entry exists before any copier discovery or terminal construction.
window.terminalPriceVolumeAdmission = { run };
