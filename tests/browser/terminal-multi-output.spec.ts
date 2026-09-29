import { expect, test, type Page } from '@playwright/test';

const evidenceStage = process.env.FILTIX_EVIDENCE_STAGE ?? 'v0.8';
if (!/^v\d+\.\d+(?:\.\d+)?$/.test(evidenceStage)) throw new Error('Invalid FILTIX_EVIDENCE_STAGE');

type Bar = { time: number; close: number };
type Point = { time: number; value: number } | null;

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

function seededEma(values: Array<number | null>, period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  let segment: number[] = [];
  let current: number | null = null;
  const alpha = 2 / (period + 1);
  values.forEach((value, index) => {
    if (value === null) {
      segment = [];
      current = null;
      return;
    }
    if (current === null) {
      segment.push(value);
      if (segment.length < period) return;
      if (segment.length === period) {
        current = segment.reduce((sum, item) => sum + item, 0) / period;
        output[index] = current;
      }
      return;
    }
    current = alpha * value + (1 - alpha) * current;
    output[index] = current;
  });
  return output;
}

function macdOracle(closes: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  const fast = seededEma(closes, fastPeriod);
  const slow = seededEma(closes, slowPeriod);
  const macd = closes.map((_, index) =>
    fast[index] === null || slow[index] === null ? null : fast[index]! - slow[index]!,
  );
  const signal = seededEma(macd, signalPeriod);
  return {
    macd,
    signal,
    histogram: macd.map((value, index) =>
      value === null || signal[index] === null ? null : value - signal[index]!,
    ),
  };
}

function bollingerOracle(closes: number[], period: number, multiplier: number) {
  return closes.map((_, index) => {
    if (index + 1 < period) return null;
    const window = closes.slice(index + 1 - period, index + 1);
    const middle = window.reduce((sum, value) => sum + value, 0) / period;
    const variance = window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
    const spread = multiplier * Math.sqrt(variance);
    return { middle, upper: middle + spread, lower: middle - spread };
  });
}

function expectValue(actual: any, bar: Bar, expected: number | null): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual.time).toBe(bar.time);
  expect(actual.value).toBeCloseTo(expected, 9);
}

test('renders every MACD and Bollinger output against independent history oracles', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
      { kind: 'bollinger', period: 3, multiplier: 2 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');

  const snapshot = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const bars = api.terminal.getData();
    const points = [];
    for (const bar of bars) points.push(await api.pointsAt(bar.time));
    return {
      bars,
      points,
      workspace: api.terminal.getWorkspace(),
      diagnostics: api.terminal.chart.getDiagnostics(),
    };
  });
  const bars = snapshot.bars as Bar[];
  const closes = bars.map((bar) => bar.close);
  const expectedMacd = macdOracle(closes, 2, 3, 2);
  const expectedBollinger = bollingerOracle(closes, 3, 2);
  snapshot.points.forEach((points: any, index: number) => {
    expectValue(points['terminal-study-1-macd'], bars[index]!, expectedMacd.macd[index]!);
    expectValue(points['terminal-study-1-signal'], bars[index]!, expectedMacd.signal[index]!);
    expectValue(points['terminal-study-1-histogram'], bars[index]!, expectedMacd.histogram[index]!);
    const band = expectedBollinger[index];
    expectValue(points['terminal-study-2-middle'], bars[index]!, band?.middle ?? null);
    expectValue(points['terminal-study-2-upper'], bars[index]!, band?.upper ?? null);
    expectValue(points['terminal-study-2-lower'], bars[index]!, band?.lower ?? null);
    if (!band) expect(points['terminal-study-2-fill']).toBeNull();
    else {
      expect(points['terminal-study-2-fill'].time).toBe(bars[index]!.time);
      expect(points['terminal-study-2-fill'].upper).toBeCloseTo(band.upper, 9);
      expect(points['terminal-study-2-fill'].lower).toBeCloseTo(band.lower, 9);
    }
  });
  expect(snapshot.workspace.version).toBe(5);
  expect(snapshot.diagnostics.seriesCount).toBe(9);
});

test('validates compound patches atomically and reserves the exact maximum composition', async ({ page }) => {
  await ready(page);
  const patch = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const id = terminal.addStudy({ kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const before = terminal.getWorkspace();
    let error = '';
    try {
      terminal.updateStudy(id, { fastPeriod: 30 });
    } catch (cause) {
      error = String(cause);
    }
    const afterInvalid = terminal.getWorkspace();
    terminal.updateStudy(id, { fastPeriod: 30, slowPeriod: 40 });
    terminal.updateStudy(id, { visible: false });
    return { id, error, before, afterInvalid, final: terminal.getWorkspace() };
  });
  expect(patch.error).toMatch(/fast|slow/i);
  expect(patch.afterInvalid).toEqual(patch.before);
  expect(patch.final.studies.at(-1)).toMatchObject({
    id: patch.id,
    kind: 'macd',
    fastPeriod: 30,
    slowPeriod: 40,
    visible: false,
  });

  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
      { kind: 'macd', fastPeriod: 2, slowPeriod: 4, signalPeriod: 2 },
      { kind: 'macd', fastPeriod: 3, slowPeriod: 5, signalPeriod: 2 },
      { kind: 'bollinger', period: 3, multiplier: 2 },
      { kind: 'bollinger', period: 4, multiplier: 2, fillOpacity: 0 },
      { kind: 'sma', period: 2 },
      { kind: 'ema', period: 3 },
      { kind: 'sma', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getDiagnostics().seriesCount),
  ).toBe(22);
  const overflow = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const before = terminal.getWorkspace();
    let error = '';
    try {
      terminal.addStudy({ kind: 'sma', period: 5 });
    } catch (cause) {
      error = String(cause);
    }
    return { error, before, after: terminal.getWorkspace() };
  });
  expect(overflow.error).toMatch(/eight|series/i);
  expect(overflow.after).toEqual(overflow.before);
});

test('keyed native editor exposes variant fields, preserves focus on ticks, and remains reachable at 390px', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      { kind: 'bollinger', period: 20, multiplier: 2 },
    ]);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.locator('#terminal-host').screenshot({
    path: 'benchmark-results/' + evidenceStage + '/terminal-multi-output-desktop-' + Date.now() + '.png',
  });
  await page.evaluate(() => {
    const host = document.getElementById('terminal-host')!;
    host.style.width = '390px';
    host.style.height = '800px';
  });

  const fast = page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-fast-period]');
  await expect(fast).toHaveValue('12');
  await expect(
    page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-positive-color]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-terminal-study-row="study-2"] [data-terminal-study-multiplier]'),
  ).toHaveValue('2');
  const fillOpacity = page.locator('[data-terminal-study-row="study-2"] [data-terminal-study-fill-opacity]');
  await expect(fillOpacity).toBeVisible();

  await fast.focus();
  await fast.fill('30');
  await page.evaluate(() => (window as any).terminalTestApi.reviseTail(190, 22));
  await expect(fast).toBeFocused();
  await expect(fast).toHaveValue('30');

  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.updateStudy('study-1', {
      fastPeriod: 10,
      slowPeriod: 30,
    }),
  );
  await expect(fast).toHaveValue('10');

  await fillOpacity.scrollIntoViewIfNeeded();
  await expect(fillOpacity).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.locator('[data-terminal-study-add-kind]').selectOption('macd');
  await expect(page.locator('[data-terminal-study-add-fast-period]')).toBeVisible();
  await expect(page.locator('[data-terminal-study-add-signal-color]')).toBeVisible();
  await page.locator('#terminal-host').screenshot({
    path: 'benchmark-results/' + evidenceStage + '/terminal-multi-output-390px-' + Date.now() + '.png',
  });
});

test('v2 migration and invalid v4 multi-output restore complete before terminal side effects', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const current = terminal.getWorkspace();
    const legacyV2 = {
      ...current,
      version: 2,
      studies: current.studies.filter(
        (study: any) => study.kind === 'sma' || study.kind === 'ema' || study.kind === 'rsi',
      ),
    };
    delete (legacyV2 as Record<string, unknown>).layout;
    delete (legacyV2 as Record<string, unknown>).alerts;
    await terminal.restoreWorkspace(legacyV2);
    const migrated = terminal.getWorkspace();
    const before = structuredClone(migrated);
    const activeBefore = api.activeQueries();
    const historyBefore = api.historyRequests();
    const diagnosticsBefore = terminal.chart.getDiagnostics();
    const invalid = structuredClone(migrated);
    invalid.studies = [
      {
        id: 'study-9',
        kind: 'macd',
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        color: '#7aa2f7',
        positiveColor: '#73c991',
        negativeColor: '#ef7c8e',
        lineWidth: 2,
        visible: true,
      },
    ];
    let error = '';
    try {
      await terminal.restoreWorkspace(invalid);
    } catch (cause) {
      error = String(cause);
    }
    return {
      migrated,
      before,
      after: terminal.getWorkspace(),
      activeBefore,
      activeAfter: api.activeQueries(),
      historyBefore,
      historyAfter: api.historyRequests(),
      diagnosticsBefore,
      diagnosticsAfter: terminal.chart.getDiagnostics(),
      error,
    };
  });
  expect(result.migrated.version).toBe(5);
  expect(result.after).toEqual(result.before);
  expect(result.activeAfter).toEqual(result.activeBefore);
  expect(result.historyAfter).toBe(result.historyBefore);
  expect(result.diagnosticsAfter.seriesCount).toBe(result.diagnosticsBefore.seriesCount);
  expect(result.error).toMatch(/signalColor|required/i);
});

test('multi-output tail and style paths invoke calculators only at the tail and never rehydrate', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
      { kind: 'bollinger', period: 3, multiplier: 2 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.resetFeedDataReads();
    api.resetStudyCalculatorCounts();
    const beforeSeries = api.terminal.chart.getDiagnostics().seriesCount;
    api.reviseTail(181, 31);
    api.reviseTail(183, 32);
    api.appendBars(1);
    api.terminal.updateStudy('study-1', {
      signalColor: '#112233',
      positiveColor: '#445566',
      negativeColor: '#778899',
    });
    api.terminal.updateStudy('study-2', { fillColor: '#abcdef', fillOpacity: 0 });
    return {
      feedReads: api.feedDataReads(),
      counts: api.studyCalculatorCounts(),
      beforeSeries,
      afterSeries: api.terminal.chart.getDiagnostics().seriesCount,
    };
  });
  expect(result.feedReads).toBe(0);
  expect(result.counts).toEqual({ create: 0, setData: 0, getData: 0, update: 6 });
  expect(result.afterSeries).toBe(result.beforeSeries);
});

test('late volume failure removes successful MACD and Bollinger prefixes and restores the committed scene', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithStudies([{ kind: 'sma', period: 3 }]));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.applySettings({ volume: false });
    const before = terminal.getWorkspace();
    terminal.chart.addSeries('line', { id: 'terminal-volume' });
    const candidate = structuredClone(before);
    candidate.settings.volume = true;
    candidate.layout.panes.push({ id: 'terminal-study-1-pane', weight: 0.3, minHeight: 72 });
    candidate.studies = [
      {
        id: 'study-1',
        kind: 'macd',
        fastPeriod: 2,
        slowPeriod: 3,
        signalPeriod: 2,
        color: '#7aa2f7',
        signalColor: '#e0af68',
        positiveColor: '#73c991',
        negativeColor: '#ef7c8e',
        lineWidth: 2,
        visible: true,
      },
      {
        id: 'study-2',
        kind: 'bollinger',
        period: 3,
        multiplier: 2,
        color: '#c7ef57',
        upperColor: '#7aa2f7',
        lowerColor: '#7aa2f7',
        fillColor: '#7aa2f7',
        fillOpacity: 0.12,
        lineWidth: 2,
        visible: true,
      },
    ];
    let error = '';
    try {
      await terminal.restoreWorkspace(candidate);
    } catch (cause) {
      error = String(cause);
    }
    terminal.chart.removeSeries('terminal-volume');
    const bars = terminal.getData();
    await terminal.chart.whenIdle();
    const points = await api.pointsAt(bars.at(-1).time);
    return {
      error,
      before,
      after: terminal.getWorkspace(),
      stateError: terminal.getState().error,
      ready: document.querySelector('[data-terminal-status]')?.getAttribute('data-ready'),
      leaked: Object.keys(points).filter((id) => id.includes('-macd') || id.includes('-middle')),
      scalarPresent: Object.prototype.hasOwnProperty.call(points, 'terminal-study-1'),
    };
  });
  expect(result.error).toMatch(/already exists|duplicate/i);
  expect(result.after).toEqual(result.before);
  expect(result.stateError).toMatch(/already exists|duplicate/i);
  expect(result.ready).toBe('false');
  expect(result.leaked).toEqual([]);
  expect(result.scalarPresent).toBe(true);
});

test('multi-output observer reentry removes complete groups and destroy fences the next committed group', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithStudies([]));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const removed = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.armStudyObserver('remove', 'study-1');
    const id = api.terminal.addStudy({
      kind: 'macd',
      fastPeriod: 2,
      slowPeriod: 3,
      signalPeriod: 2,
    });
    return {
      id,
      studies: api.terminal.getStudies(),
      series: api.terminal.chart.getDiagnostics().seriesCount,
    };
  });
  expect(removed.id).toBe('study-1');
  expect(removed.studies).toEqual([]);
  expect(removed.series).toBe(2);

  const destroyed = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.armStudyObserver('destroy');
    const id = api.terminal.addStudy({ kind: 'bollinger', period: 3, multiplier: 2 });
    return { id, state: api.terminal.getState(), studies: api.terminal.getStudies() };
  });
  expect(destroyed.id).toBe('study-2');
  expect(destroyed.state.destroyed).toBe(true);
  expect(destroyed.studies).toHaveLength(1);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('correction backfill recovery and market switches rebuild every multi-output series coherently', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
      { kind: 'bollinger', period: 3, multiplier: 2 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.reviseTail(177, 31);
    api.reviseTail(171, 32);
    api.appendBars(1);
    await api.terminal.loadMore();
    api.correctLoadedBar(3, 144, 41);
    api.disconnectAndAppend(2);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.evaluate(async () => {
    const terminal = (window as any).terminalTestApi.terminal;
    await terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
    await terminal.setMarket({ symbol: 'BTCUSDT', interval: '1m' });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const rendered = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
  const bars = rendered.bars as Bar[];
  const closes = bars.map((bar) => bar.close);
  const macd = macdOracle(closes, 2, 3, 2);
  const bb = bollingerOracle(closes, 3, 2);
  bars.forEach((bar, index) => {
    expectValue(rendered.series['terminal-study-1-macd'][index], bar, macd.macd[index]!);
    expectValue(rendered.series['terminal-study-1-signal'][index], bar, macd.signal[index]!);
    expectValue(rendered.series['terminal-study-1-histogram'][index], bar, macd.histogram[index]!);
    expectValue(rendered.series['terminal-study-2-middle'][index], bar, bb[index]?.middle ?? null);
    expectValue(rendered.series['terminal-study-2-upper'][index], bar, bb[index]?.upper ?? null);
    expectValue(rendered.series['terminal-study-2-lower'][index], bar, bb[index]?.lower ?? null);
  });
});

test('MACD histogram paints positive and negative values with their configured sign colors', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const closes = Array.from({ length: 60 }, (_, index) => {
      const cycle = [100, 116, 91, 124, 84, 109];
      return cycle[index % cycle.length]! + Math.floor(index / cycle.length);
    });
    (window as any).terminalTestApi.remountWithStudyPattern(closes, [
      {
        kind: 'macd',
        fastPeriod: 2,
        slowPeriod: 4,
        signalPeriod: 2,
        positiveColor: '#22cc66',
        negativeColor: '#ee3355',
      },
    ]);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const samples = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.chart.fitContent();
    await terminal.chart.whenIdle();
    const rendered = await api.renderedStudies();
    const histogram = rendered.series['terminal-study-1-histogram']
      .map((point: any, index: number) => ({ point, bar: rendered.bars[index] }))
      .filter((entry: any) => entry.point !== null && entry.point.value !== 0);
    const positive = histogram
      .filter((entry: any) => entry.point.value > 0)
      .sort((left: any, right: any) => right.point.value - left.point.value)[0];
    const negative = histogram
      .filter((entry: any) => entry.point.value < 0)
      .sort((left: any, right: any) => left.point.value - right.point.value)[0];
    const canvas = document.querySelector<HTMLCanvasElement>(
      '#terminal-host canvas[data-filtix-layer="scene"]',
    )!;
    const context = canvas.getContext('2d')!;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const sample = (entry: any) => {
      const x = terminal.chart.timeToCoordinate(entry.bar.time)!;
      const valueY = terminal.chart.priceToCoordinate(entry.point.value, 'terminal-study-1-pane')!;
      const zeroY = terminal.chart.priceToCoordinate(0, 'terminal-study-1-pane')!;
      const y = valueY + (zeroY - valueY) * 0.45;
      return Array.from(
        context.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data.slice(0, 3),
      );
    };
    return { positive: sample(positive), negative: sample(negative) };
  });
  const distance = (left: number[], right: number[]) =>
    Math.hypot(...left.map((value, index) => value - right[index]!));
  const blend = (foreground: number[]) =>
    foreground.map((value, index) => Math.round(value * 0.72 + [21, 23, 21][index]! * 0.28));
  const positiveTarget = blend([0x22, 0xcc, 0x66]);
  const negativeTarget = blend([0xee, 0x33, 0x55]);
  expect(distance(samples.positive, positiveTarget)).toBeLessThan(distance(samples.positive, negativeTarget));
  expect(distance(samples.negative, negativeTarget)).toBeLessThan(distance(samples.negative, positiveTarget));
});

test('same-market restore keeps same-id RSI and MACD outputs on a dedicated oscillator pane', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithStudies([{ kind: 'rsi', period: 2 }]));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');

  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const paneId = 'terminal-study-1-pane';
    const snapshot = async () => {
      const rendered = await api.renderedStudies();
      const primary = (Object.values(rendered.series)[0] as any[]).filter(Boolean).at(-1);
      return {
        paneCoordinate: terminal.chart.priceToCoordinate(primary?.value, paneId),
        rendered,
      };
    };
    const restoreStudies = async (studies: any[]) => {
      const workspace = terminal.getWorkspace();
      await terminal.restoreWorkspace({ ...workspace, studies });
      await terminal.chart.whenIdle();
      return snapshot();
    };
    const macd = await restoreStudies([
      {
        id: 'study-1',
        kind: 'macd',
        fastPeriod: 2,
        slowPeriod: 3,
        signalPeriod: 2,
        color: '#7aa2f7',
        signalColor: '#e0af68',
        positiveColor: '#73c991',
        negativeColor: '#ef7c8e',
        lineWidth: 2,
        visible: true,
      },
    ]);
    terminal.updateStudy('study-1', { signalColor: '#112233' });
    api.reviseTail(191, 23);
    await terminal.chart.whenIdle();
    const macdAfterTail = await snapshot();
    const rsi = await restoreStudies([
      {
        id: 'study-1',
        kind: 'rsi',
        period: 2,
        color: '#a8a0dc',
        lineWidth: 2,
        visible: true,
      },
    ]);
    terminal.updateStudy('study-1', { color: '#223344' });
    api.reviseTail(192, 24);
    await terminal.chart.whenIdle();
    const rsiAfterTail = await snapshot();
    return { macd, macdAfterTail, rsi, rsiAfterTail };
  });

  expect(result.macd.paneCoordinate).not.toBeNull();
  expect(Object.keys(result.macd.rendered.series)).toEqual([
    'terminal-study-1-macd',
    'terminal-study-1-signal',
    'terminal-study-1-histogram',
  ]);
  expect(result.macdAfterTail.paneCoordinate).not.toBeNull();
  expect(
    Object.values(result.macdAfterTail.rendered.series).every((points: any) => points.at(-1) !== null),
  ).toBe(true);
  expect(result.rsi.paneCoordinate).not.toBeNull();
  expect(Object.keys(result.rsi.rendered.series)).toEqual(['terminal-study-1']);
  expect(result.rsiAfterTail.paneCoordinate).not.toBeNull();
  expect((result.rsiAfterTail.rendered.series['terminal-study-1'] as any[]).at(-1)).not.toBeNull();
});

test('hostile own __proto__ workspace fields reject before transport, resources, registry, or allocator effects', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const before = terminal.getWorkspace();
    const activeBefore = api.activeQueries();
    const historyBefore = api.historyRequests();
    const diagnosticsBefore = terminal.chart.getDiagnostics();
    const hostile = structuredClone(before);
    hostile.settings.theme = 'light';
    Object.defineProperty(hostile.settings, '__proto__', {
      value: { unexpected: true },
      enumerable: true,
      configurable: true,
    });
    let error = '';
    try {
      await terminal.restoreWorkspace(hostile);
    } catch (cause) {
      error = String(cause);
    }
    const after = terminal.getWorkspace();
    const activeAfter = api.activeQueries();
    const historyAfter = api.historyRequests();
    const diagnosticsAfter = terminal.chart.getDiagnostics();
    const nextId = terminal.addStudy({ kind: 'sma', period: 3 });
    return {
      error,
      before,
      after,
      activeBefore,
      activeAfter,
      historyBefore,
      historyAfter,
      diagnosticsBefore,
      diagnosticsAfter,
      nextId,
    };
  });

  expect(result.error).toMatch(/field|__proto__/i);
  expect(result.after).toEqual(result.before);
  expect(result.activeAfter).toEqual(result.activeBefore);
  expect(result.historyAfter).toBe(result.historyBefore);
  expect(result.diagnosticsAfter).toEqual(result.diagnosticsBefore);
  expect(result.nextId).toBe('study-1');
});

test('native Type and Width selects stay readable and keyboard-operable in both themes and widths', async ({
  page,
  browserName,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.locator('[data-terminal-studies-toggle]').click();
  const host = page.locator('#terminal-host');
  const type = page.locator('[data-terminal-study-add-kind]');
  const width = page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-width]');

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(
      (value) => (window as any).terminalTestApi.terminal.applySettings({ theme: value }),
      theme,
    );
    for (const layout of [
      { name: 'desktop', width: 900, height: 700 },
      { name: '390px', width: 390, height: 800 },
    ]) {
      await page.evaluate(({ width, height }) => {
        const target = document.getElementById('terminal-host')!;
        target.style.width = width + 'px';
        target.style.height = height + 'px';
      }, layout);
      await type.selectOption('sma');
      await type.focus();
      await type.press('ArrowDown');
      await expect(type).toBeFocused();
      await expect(type).toHaveValue('ema');
      await width.selectOption('1');
      await width.focus();
      await width.press('ArrowDown');
      await expect(width).toBeFocused();
      await expect(width).toHaveValue('2');
      await width.scrollIntoViewIfNeeded();
      const styles = await page.evaluate(() => {
        const selectors = [
          document.querySelector('[data-terminal-symbol]')!,
          document.querySelector('[data-terminal-interval]')!,
          document.querySelector('[data-terminal-theme]')!,
          document.querySelector('[data-terminal-study-add-kind]')!,
          document.querySelector('[data-terminal-study-row="study-1"] [data-terminal-study-width]')!,
        ];
        return selectors.map((element) => {
          const style = getComputedStyle(element);
          return {
            colorScheme: style.colorScheme,
            color: style.color,
            backgroundColor: style.backgroundColor,
          };
        });
      });
      expect(styles.every((style) => style.colorScheme === theme)).toBe(true);
      expect(styles.every((style) => style.color !== style.backgroundColor)).toBe(true);
      await host.screenshot({
        path:
          'benchmark-results/' +
          evidenceStage +
          '/terminal-multi-output-fix-1-' +
          Date.now() +
          '-' +
          browserName +
          '-' +
          theme +
          '-' +
          layout.name +
          '.png',
      });
    }
  }
});
