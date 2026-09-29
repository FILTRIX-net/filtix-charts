import { expect, test, type Page } from '@playwright/test';

type BrowserBar = { time: number; close: number };

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

test('study API normalizes instances and exposes compact controls', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const id = terminal.addStudy({ kind: 'sma', period: 3 });
    terminal.updateStudy(id, { color: '#AABBCC', lineWidth: 3, visible: false });
    return {
      id,
      studies: terminal.getStudies(),
      state: terminal.getState(),
      workspace: terminal.getWorkspace(),
    };
  });
  expect(result.id).toBe('study-1');
  expect(result.studies.at(-1)).toEqual({
    id: 'study-1',
    kind: 'sma',
    period: 3,
    color: '#aabbcc',
    lineWidth: 3,
    visible: false,
  });
  expect(result.state.studies).toEqual(result.studies);
  expect(result.workspace).toMatchObject({ version: 5, studies: result.studies });
  await expect(page.locator('[data-terminal-studies-toggle]')).toBeVisible();
});
function sma(values: number[], period: number): Array<number | null> {
  return values.map((_, index) =>
    index + 1 < period
      ? null
      : values.slice(index + 1 - period, index + 1).reduce((sum, value) => sum + value, 0) / period,
  );
}

function ema(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    value = alpha * values[index]! + (1 - alpha) * value;
    output[index] = value;
  }
  return output;
}

function rsi(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index]! - values[index - 1]!;
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  gain /= period;
  loss /= period;
  const value = () =>
    gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
  output[period] = value();
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index]! - values[index - 1]!;
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    output[index] = value();
  }
  return output;
}

function expectSeries(bars: BrowserBar[], actual: Array<any>, expected: Array<number | null>): void {
  expect(actual).toHaveLength(bars.length);
  actual.forEach((point, index) => {
    const value = expected[index];
    if (value === null || value === undefined) expect(point).toBeNull();
    else {
      expect(point.time).toBe(bars[index]!.time);
      expect(point.value).toBeCloseTo(value, 9);
    }
  });
}

test('renders independent SMA EMA and Wilder RSI values including warmup gaps', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 4 },
      { kind: 'rsi', period: 3 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const rendered = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
  const bars = rendered.bars as BrowserBar[];
  const closes = bars.map((bar) => bar.close);
  expectSeries(bars, rendered.series['terminal-study-1'], sma(closes, 3));
  expectSeries(bars, rendered.series['terminal-study-2'], ema(closes, 4));
  expectSeries(bars, rendered.series['terminal-study-3'], rsi(closes, 3));
  expect(rendered.diagnostics.seriesCount).toBe(5);
});

test('tail replacement append correction backfill and recovery keep all study outputs coherent', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 3 },
      { kind: 'rsi', period: 3 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.reviseTail(177, 31);
    api.reviseTail(171, 32);
    api.appendBars(1);
  });
  await page.evaluate(() => (window as any).terminalTestApi.terminal.loadMore());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getData().length))
    .toBe(19);
  await page.evaluate(() => (window as any).terminalTestApi.correctLoadedBar(3, 144, 41));
  await page.evaluate(() => (window as any).terminalTestApi.disconnectAndAppend(2));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const rendered = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
  const bars = rendered.bars as BrowserBar[];
  const closes = bars.map((bar) => bar.close);
  expectSeries(bars, rendered.series['terminal-study-1'], sma(closes, 3));
  expectSeries(bars, rendered.series['terminal-study-2'], ema(closes, 3));
  expectSeries(bars, rendered.series['terminal-study-3'], rsi(closes, 3));
});

test('legacy EMA projection, caps, visibility resources and monotonic IDs stay coherent', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const legacy = terminal.getStudies()[0];
    terminal.updateStudy('terminal-ema', { visible: false });
    const hiddenSettings = terminal.getSettings();
    terminal.applySettings({ emaPeriod: 7 });
    const shown = terminal.getStudies().find((study: any) => study.id === 'terminal-ema');
    terminal.removeStudy('terminal-ema');
    const ordinary = terminal.addStudy({ kind: 'ema', period: 9 });
    terminal.removeStudy(ordinary);
    const afterRemoval = terminal.addStudy({ kind: 'sma', period: 4 });
    const snapshot = terminal.getStudies();
    snapshot[0].period = 499;
    return {
      legacy,
      hiddenSettings,
      shown,
      ordinary,
      afterRemoval,
      projected: terminal.getSettings().emaPeriod,
      defensive: terminal.getStudies(),
      count: terminal.chart.getDiagnostics().seriesCount,
    };
  });
  expect(result.legacy.id).toBe('terminal-ema');
  expect(result.hiddenSettings.emaPeriod).toBeNull();
  expect(result.shown).toMatchObject({ period: 7, visible: true });
  expect(result.ordinary).toBe('study-1');
  expect(result.afterRemoval).toBe('study-2');
  expect(result.projected).toBeNull();
  expect(result.defensive[0].period).toBe(4);
  expect(result.count).toBe(3);

  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'rsi', period: 2 },
      { kind: 'rsi', period: 3 },
      { kind: 'rsi', period: 4 },
      { kind: 'sma', period: 2 },
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 2 },
      { kind: 'ema', period: 3 },
      { kind: 'ema', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const capErrors = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const before = terminal.getStudies();
    const messages: string[] = [];
    for (const value of [
      { kind: 'sma', period: 5 },
      { kind: 'rsi', period: 5 },
    ]) {
      try {
        terminal.addStudy(value);
      } catch (error) {
        messages.push(String(error));
      }
    }
    return { before, after: terminal.getStudies(), messages };
  });
  expect(capErrors.after).toEqual(capErrors.before);
  expect(capErrors.messages.join(' ')).toMatch(/eight|three RSI/i);
});

test('unrelated public and toolbar settings retain a styled hidden legacy EMA', async ({ page }) => {
  await ready(page);
  const setup = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.updateStudy('terminal-ema', {
      period: 11,
      color: '#abcdef',
      lineWidth: 4,
      visible: false,
    });
    terminal.addStudy({ kind: 'ema', period: 9, color: '#123456', lineWidth: 3 });
    const before = terminal.getWorkspace();
    const bars = terminal.getData();
    await terminal.chart.whenIdle();
    const beforePoints = await api.pointsAt(bars.at(-1).time);
    const publicResults = [];
    for (const patch of [{ theme: 'light' }, { volume: false }, { followLatest: false }, {}]) {
      const notifications = api.observedStates.length;
      terminal.applySettings(patch);
      await terminal.chart.whenIdle();
      publicResults.push({
        workspace: terminal.getWorkspace(),
        settings: terminal.getSettings(),
        points: await api.pointsAt(bars.at(-1).time),
        notifications: api.observedStates.length - notifications,
      });
      await terminal.restoreWorkspace(before);
    }
    return { before, beforePoints, publicResults };
  });

  const expectedPublicSettings = [
    { ...setup.before.settings, theme: 'light' },
    { ...setup.before.settings, volume: false },
    { ...setup.before.settings, followLatest: false },
    setup.before.settings,
  ];
  for (const [index, result] of setup.publicResults.entries()) {
    expect(result.workspace).toEqual({ ...setup.before, settings: expectedPublicSettings[index] });
    expect(result.workspace.studies).toEqual(setup.before.studies);
    expect(result.settings.emaPeriod).toBeNull();
    expect(result.points).not.toHaveProperty('terminal-ema');
    expect(result.points['terminal-study-1']).toEqual(setup.beforePoints['terminal-study-1']);
    expect(result.notifications).toBe(index === 3 ? 0 : 1);
  }

  await page.locator('[data-terminal-theme]').selectOption('light');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getSettings().theme))
    .toBe('light');
  const uiTheme = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const bars = terminal.getData();
    await terminal.chart.whenIdle();
    return {
      workspace: terminal.getWorkspace(),
      settings: terminal.getSettings(),
      points: await api.pointsAt(bars.at(-1).time),
    };
  });
  expect(uiTheme.workspace).toEqual({
    ...setup.before,
    settings: { ...setup.before.settings, theme: 'light' },
  });
  expect(uiTheme.settings.emaPeriod).toBeNull();
  expect(uiTheme.points).not.toHaveProperty('terminal-ema');
  expect(uiTheme.points['terminal-study-1']).toEqual(setup.beforePoints['terminal-study-1']);

  await page.evaluate(
    (workspace) => (window as any).terminalTestApi.terminal.restoreWorkspace(workspace),
    setup.before,
  );
  await page.locator('[data-terminal-volume]').uncheck();
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getSettings().volume))
    .toBe(false);
  const uiVolume = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const bars = terminal.getData();
    await terminal.chart.whenIdle();
    return {
      workspace: terminal.getWorkspace(),
      settings: terminal.getSettings(),
      points: await api.pointsAt(bars.at(-1).time),
    };
  });
  expect(uiVolume.workspace).toEqual({
    ...setup.before,
    settings: { ...setup.before.settings, volume: false },
  });
  expect(uiVolume.settings.emaPeriod).toBeNull();
  expect(uiVolume.points).not.toHaveProperty('terminal-ema');
  expect(uiVolume.points['terminal-study-1']).toEqual(setup.beforePoints['terminal-study-1']);

  const capacity = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    for (let period = 2; period <= 7; period += 1) terminal.addStudy({ kind: 'sma', period, visible: false });
    let error = '';
    try {
      terminal.addStudy({ kind: 'sma', period: 8, visible: false });
    } catch (cause) {
      error = String(cause);
    }
    return { error, studies: terminal.getStudies() };
  });
  expect(capacity.error).toMatch(/eight/i);
  expect(capacity.studies).toHaveLength(8);
  expect(capacity.studies.slice(0, 2)).toEqual(setup.before.studies);

  const explicit = await page.evaluate(async (workspace) => {
    const terminal = (window as any).terminalTestApi.terminal;
    await terminal.restoreWorkspace(workspace);
    terminal.applySettings({ emaPeriod: 37 });
    const enabled = terminal.getStudies();
    const enabledSettings = terminal.getSettings();
    terminal.applySettings({ emaPeriod: null });
    return {
      enabled,
      enabledSettings,
      removed: terminal.getStudies(),
      removedSettings: terminal.getSettings(),
    };
  }, setup.before);
  expect(explicit.enabled).toEqual([
    { ...setup.before.studies[0], period: 37, visible: true },
    setup.before.studies[1],
  ]);
  expect(explicit.enabledSettings.emaPeriod).toBe(37);
  expect(explicit.removed).toEqual([setup.before.studies[1]]);
  expect(explicit.removedSettings.emaPeriod).toBeNull();
});
test('v1 migration and invalid current restore/settings are atomic and transport silent', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const current = terminal.getWorkspace();
    const legacy = {
      schema: 'filtix-terminal',
      version: 1,
      providerId: current.providerId,
      query: current.query,
      settings: { ...current.settings, emaPeriod: 6 },
      markets: current.markets,
    };
    await terminal.restoreWorkspace(legacy);
    const migrated = terminal.getWorkspace();
    const before = structuredClone(migrated);
    const activeBefore = api.activeQueries();
    const invalid = structuredClone(migrated);
    invalid.studies.push({
      id: 'study-1',
      kind: 'sma',
      period: 1,
      color: '#c7ef57',
      lineWidth: 2,
      visible: true,
    });
    let restoreError = '';
    try {
      await terminal.restoreWorkspace(invalid);
    } catch (error) {
      restoreError = String(error);
    }
    let settingsError = '';
    try {
      terminal.applySettings({ emaPeriod: 1 });
    } catch (error) {
      settingsError = String(error);
    }
    return {
      migrated,
      before,
      after: terminal.getWorkspace(),
      activeBefore,
      activeAfter: api.activeQueries(),
      restoreError,
      settingsError,
    };
  });
  expect(result.migrated).toMatchObject({
    version: 5,
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: [{ id: 'terminal-ema', kind: 'ema', period: 6 }],
  });
  expect(result.after).toEqual(result.before);
  expect(result.activeAfter).toEqual(result.activeBefore);
  expect(result.restoreError).toMatch(/period/i);
  expect(result.settingsError).toMatch(/EMA period/i);
});

test('study panel retains focused editor and remains reachable at 390px', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const host = document.getElementById('terminal-host')!;
    host.style.width = '390px';
    host.style.height = '800px';
  });
  await page.locator('[data-terminal-studies-toggle]').click();
  const period = page.locator('[data-terminal-study-period]').first();
  await period.focus();
  await period.fill('31');
  await page.evaluate(() => (window as any).terminalTestApi.reviseTail(190, 22));
  await expect(period).toBeFocused();
  await expect(period).toHaveValue('31');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-terminal-studies-panel]')).toBeVisible();
});

test('validation and no-op mutations are silent while effective mutations notify once', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const initial = api.observedStates.length;
    terminal.updateStudy('terminal-ema', {});
    terminal.updateStudy('terminal-ema', { period: 3 });
    terminal.removeStudy('study-999');
    const afterNoops = api.observedStates.length;
    let invalid = '';
    try {
      terminal.addStudy({ kind: 'sma', period: 1 });
    } catch (error) {
      invalid = String(error);
    }
    const afterInvalid = api.observedStates.length;
    terminal.updateStudy('terminal-ema', { lineWidth: 3 });
    return { initial, afterNoops, afterInvalid, final: api.observedStates.length, invalid };
  });
  expect(result.afterNoops).toBe(result.initial);
  expect(result.afterInvalid).toBe(result.initial);
  expect(result.final).toBe(result.initial + 1);
  expect(result.invalid).toMatch(/period/i);
});

test('committed add returns normally when its observer removes it or destroys the terminal', async ({
  page,
}) => {
  await ready(page);
  const removed = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.armStudyObserver('remove', 'study-1');
    const id = api.terminal.addStudy({ kind: 'sma', period: 5 });
    return { id, studies: api.terminal.getStudies() };
  });
  expect(removed.id).toBe('study-1');
  expect(removed.studies.some((study: any) => study.id === removed.id)).toBe(false);

  const destroyed = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.armStudyObserver('destroy');
    let id = '';
    let error = '';
    try {
      id = api.terminal.addStudy({ kind: 'ema', period: 6 });
    } catch (cause) {
      error = String(cause);
    }
    return { id, error, state: api.terminal.getState(), studies: api.terminal.getStudies() };
  });
  expect(destroyed.id).toBe('study-2');
  expect(destroyed.error).toBe('');
  expect(destroyed.state.destroyed).toBe(true);
  expect(destroyed.studies.some((study: any) => study.id === 'study-2')).toBe(true);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('failed allocation does not consume an ID and malformed constructor conflict has no side effects', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'rsi', period: 2 },
      { kind: 'rsi', period: 3 },
      { kind: 'rsi', period: 4 },
      { kind: 'sma', period: 2 },
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 2 },
      { kind: 'ema', period: 3 },
      { kind: 'ema', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    let error = '';
    try {
      api.terminal.addStudy({ kind: 'sma', period: 10 });
    } catch (cause) {
      error = String(cause);
    }
    api.terminal.removeStudy('study-8');
    const next = api.terminal.addStudy({ kind: 'sma', period: 10 });
    return { error, next, conflict: api.constructorConflict() };
  });
  expect(result.error).toMatch(/eight/i);
  expect(result.next).toBe('study-9');
  expect(result.conflict.error).toMatch(/studies.*emaPeriod|emaPeriod.*studies/i);
  expect(result.conflict.children).toBe(0);
  expect(result.conflict.subscriptionsAfter).toBe(result.conflict.subscriptionsBefore);
});

test('oversized constructor studies reject before descriptor access or ownership', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalTestApi.constructorOverlength());
  expect(result.error).toMatch(/eight/i);
  expect(result.descriptorAccesses).toBe(0);
  expect(result.children).toBe(0);
  expect(result.subscriptionsAfter).toBe(result.subscriptionsBefore);
});
test('tail and style changes keep transport and chart resource counts stable', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 4 },
      { kind: 'rsi', period: 3 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const before = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return { history: api.historyRequests(), diagnostics: api.terminal.chart.getDiagnostics() };
  });
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.reviseTail(188, 33);
    api.reviseTail(181, 34);
    api.appendBars(1);
    api.terminal.updateStudy('study-1', { color: '#ABCDEF', lineWidth: 4 });
  });
  const after = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return { history: api.historyRequests(), diagnostics: api.terminal.chart.getDiagnostics() };
  });
  expect(after.history).toBe(before.history);
  expect(after.diagnostics.seriesCount).toBe(before.diagnostics.seriesCount);
  expect(await page.locator('canvas').count()).toBe(3);
});

test('hide show and remove release and recreate bounded series and RSI panes', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'rsi', period: 3 },
      { kind: 'rsi', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getDiagnostics().seriesCount),
  ).toBe(5);
  for (let index = 0; index < 3; index++) {
    await page.evaluate(() =>
      (window as any).terminalTestApi.terminal.updateStudy('study-2', { visible: false }),
    );
    expect(
      await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getDiagnostics().seriesCount),
    ).toBe(4);
    expect(
      await page.evaluate(() =>
        (window as any).terminalTestApi.terminal.chart.priceToCoordinate(50, 'terminal-study-2-pane'),
      ),
    ).toBeNull();
    await page.evaluate(() =>
      (window as any).terminalTestApi.terminal.updateStudy('study-2', { visible: true }),
    );
    expect(
      await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getDiagnostics().seriesCount),
    ).toBe(5);
  }
  await page.evaluate(() => (window as any).terminalTestApi.terminal.removeStudy('study-2'));
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getDiagnostics().seriesCount),
  ).toBe(4);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTestApi.terminal.chart.priceToCoordinate(50, 'terminal-study-2-pane'),
    ),
  ).toBeNull();
});

test('restored high-water IDs never move backward and exhaustion is prompt and atomic', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const workspace = structuredClone(terminal.getWorkspace());
    workspace.studies = [
      {
        id: 'study-40',
        kind: 'sma',
        period: 3,
        color: '#c7ef57',
        lineWidth: 2,
        visible: false,
      },
    ];
    await terminal.restoreWorkspace(workspace);
    const first = terminal.addStudy({ kind: 'ema', period: 3, visible: false });
    terminal.removeStudy(first);
    workspace.studies = [
      {
        id: 'study-2',
        kind: 'sma',
        period: 3,
        color: '#c7ef57',
        lineWidth: 2,
        visible: false,
      },
    ];
    await terminal.restoreWorkspace(workspace);
    const second = terminal.addStudy({ kind: 'ema', period: 3, visible: false });
    const exhausted = structuredClone(terminal.getWorkspace());
    exhausted.studies = [
      {
        id: 'study-9007199254740991',
        kind: 'sma',
        period: 3,
        color: '#c7ef57',
        lineWidth: 2,
        visible: false,
      },
    ];
    await terminal.restoreWorkspace(exhausted);
    const before = terminal.getStudies();
    let error = '';
    try {
      terminal.addStudy({ kind: 'sma', period: 4, visible: false });
    } catch (cause) {
      error = String(cause);
    }
    return { first, second, before, after: terminal.getStudies(), error };
  });
  expect(result.first).toBe('study-41');
  expect(result.second).toBe('study-42');
  expect(result.after).toEqual(result.before);
  expect(result.error).toMatch(/exhaust/i);
});

test('creating legacy EMA at the study cap rejects silently and atomically', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'rsi', period: 2 },
      { kind: 'rsi', period: 3 },
      { kind: 'rsi', period: 4 },
      { kind: 'sma', period: 2 },
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 2 },
      { kind: 'ema', period: 3 },
      { kind: 'ema', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const before = api.terminal.getWorkspace();
    const notifications = api.observedStates.length;
    let error = '';
    try {
      api.terminal.applySettings({ emaPeriod: 20 });
    } catch (cause) {
      error = String(cause);
    }
    return {
      before,
      after: api.terminal.getWorkspace(),
      notifications,
      afterNotifications: api.observedStates.length,
      error,
      stateError: api.terminal.getState().error,
    };
  });
  expect(result.after).toEqual(result.before);
  expect(result.afterNotifications).toBe(result.notifications);
  expect(result.error).toMatch(/eight/i);
  expect(result.stateError).toBeNull();
});

test('failed RSI composition leaves prior registry and pane topology intact', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithStudies([{ kind: 'rsi', period: 3 }]));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    terminal.chart.addSeries('line', { id: 'terminal-study-2' });
    const before = terminal.getStudies();
    let error = '';
    try {
      terminal.addStudy({ kind: 'rsi', period: 4 });
    } catch (cause) {
      error = String(cause);
    }
    let paneReusable = false;
    try {
      const pane = terminal.chart.addPane({ id: 'terminal-study-2-pane' });
      paneReusable = true;
      pane.remove();
    } catch {}
    return { before, after: terminal.getStudies(), error, paneReusable };
  });
  expect(result.error).toMatch(/already exists|duplicate/i);
  expect(result.after).toEqual(result.before);
  expect(result.paneReusable).toBe(true);
});

test('RSI resolves flat rising and falling histories to 50 100 and 0', async ({ page }) => {
  await ready(page);
  const cases = [
    { closes: Array.from({ length: 60 }, () => 100), expected: 50 },
    { closes: Array.from({ length: 60 }, (_, index) => 100 + index), expected: 100 },
    { closes: Array.from({ length: 60 }, (_, index) => 200 - index), expected: 0 },
  ];
  for (const item of cases) {
    await page.evaluate(
      ({ closes }) =>
        (window as any).terminalTestApi.remountWithStudyPattern(closes, [{ kind: 'rsi', period: 2 }]),
      item,
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
      .toBe('live');
    const rendered = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
    expect(rendered.series['terminal-study-1'].at(-1).value).toBeCloseTo(item.expected, 10);
  }
});

test('period and style updates preserve unrelated calculated values', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 4 },
      { kind: 'rsi', period: 3 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const before = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
  await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    terminal.updateStudy('study-1', { period: 5 });
    terminal.updateStudy('study-2', { color: '#ABCDEF', lineWidth: 4 });
    terminal.updateStudy('study-3', { visible: false });
    terminal.updateStudy('study-3', { period: 5 });
    terminal.updateStudy('study-3', { visible: true });
  });
  const after = await page.evaluate(() => (window as any).terminalTestApi.renderedStudies());
  expect(after.series['terminal-study-2']).toEqual(before.series['terminal-study-2']);
  const bars = after.bars as BrowserBar[];
  const closes = bars.map((bar) => bar.close);
  expectSeries(bars, after.series['terminal-study-1'], sma(closes, 5));
  expectSeries(bars, after.series['terminal-study-3'], rsi(closes, 5));
});

test('public study inputs are defensive and malformed lookup IDs reject silently', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    const options = { kind: 'sma', period: 4, color: '#AABBCC' };
    const id = terminal.addStudy(options);
    const patch = { color: '#CCDDEE', visible: false };
    terminal.updateStudy(id, patch);
    const notifications = api.observedStates.length;
    const errors: string[] = [];
    for (const bad of [null, 'study-01', 'study-9007199254740992']) {
      try {
        terminal.updateStudy(bad, { period: 5 });
      } catch (cause) {
        errors.push(String(cause));
      }
      try {
        terminal.removeStudy(bad);
      } catch (cause) {
        errors.push(String(cause));
      }
    }
    let unknownUpdate = '';
    try {
      terminal.updateStudy('study-999', { period: 5 });
    } catch (cause) {
      unknownUpdate = String(cause);
    }
    const unknownRemove = terminal.removeStudy('study-999');
    const state = terminal.getState();
    state.studies[0].period = 499;
    const workspace = terminal.getWorkspace();
    workspace.studies[0].period = 498;
    return {
      options,
      patch,
      id,
      errors,
      unknownUpdate,
      unknownRemove,
      notifications,
      afterNotifications: api.observedStates.length,
      studies: terminal.getStudies(),
    };
  });
  expect(result.options).toEqual({ kind: 'sma', period: 4, color: '#AABBCC' });
  expect(result.patch).toEqual({ color: '#CCDDEE', visible: false });
  expect(result.errors).toHaveLength(6);
  expect(result.unknownUpdate).toMatch(/unknown/i);
  expect(result.unknownRemove).toBe(false);
  expect(result.afterNotifications).toBe(result.notifications);
  expect(result.studies.find((study: any) => study.id === result.id)).toMatchObject({
    color: '#ccddee',
    visible: false,
  });
  expect(result.studies[0].period).toBe(3);
});

test('destroy retains bounded study snapshots while rejecting further study mutations', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const before = terminal.getStudies();
    terminal.destroy();
    const errors: string[] = [];
    for (const run of [
      () => terminal.addStudy({ kind: 'sma', period: 4 }),
      () => terminal.updateStudy('terminal-ema', { period: 4 }),
      () => terminal.removeStudy('terminal-ema'),
    ])
      try {
        run();
      } catch (cause) {
        errors.push(String(cause));
      }
    return { before, after: terminal.getStudies(), state: terminal.getState(), errors };
  });
  expect(result.after).toEqual(result.before);
  expect(result.state.studies).toEqual(result.before);
  expect(result.state.destroyed).toBe(true);
  expect(result.errors).toHaveLength(3);
  expect(result.errors.join(' ')).toMatch(/destroyed/i);
});

test('late restore failure rolls back a successful study prefix and publishes sticky not-ready error', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.chart.addSeries('line', { id: 'terminal-study-2' });
    const before = terminal.getWorkspace();
    const candidate = structuredClone(before);
    candidate.studies = [
      { id: 'study-1', kind: 'sma', period: 3, color: '#c7ef57', lineWidth: 2, visible: true },
      { id: 'study-2', kind: 'ema', period: 4, color: '#c27a50', lineWidth: 2, visible: true },
    ];
    let error = '';
    try {
      await terminal.restoreWorkspace(candidate);
    } catch (cause) {
      error = String(cause);
    }
    const bars = terminal.getData();
    api.reviseTail(188, 33);
    await terminal.chart.whenIdle();
    const points = await api.pointsAt(bars.at(-1).time);
    const afterFailure = terminal.getWorkspace();
    terminal.chart.removeSeries('terminal-study-2');
    const allocated = terminal.addStudy({ kind: 'sma', period: 4, visible: false });
    return {
      error,
      before,
      afterFailure,
      stateError: terminal.getState().error,
      ready: document.querySelector('[data-terminal-status]')?.getAttribute('data-ready'),
      leakedPrefix: Object.prototype.hasOwnProperty.call(points, 'terminal-study-1'),
      allocated,
    };
  });
  expect(result.error).toMatch(/already exists|duplicate/i);
  expect(result.afterFailure).toEqual(result.before);
  expect(result.stateError).toMatch(/already exists|duplicate/i);
  expect(result.ready).toBe('false');
  expect(result.leakedPrefix).toBe(false);
  expect(result.allocated).toBe('study-1');
});

test('late overlay failure rolls back completed RSI reordering and the successful prefix', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'rsi', period: 3 },
      { kind: 'rsi', period: 4 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.chart.addSeries('line', { id: 'terminal-study-4' });
    const before = terminal.getWorkspace();
    const candidate = structuredClone(before);
    candidate.studies = [
      before.studies[1],
      before.studies[0],
      { id: 'study-3', kind: 'sma', period: 3, color: '#c7ef57', lineWidth: 2, visible: true },
      { id: 'study-4', kind: 'ema', period: 4, color: '#c27a50', lineWidth: 2, visible: true },
    ];
    let error = '';
    try {
      await terminal.restoreWorkspace(candidate);
    } catch (cause) {
      error = String(cause);
    }
    await terminal.chart.whenIdle();
    const bars = terminal.getData();
    const points = await api.pointsAt(bars.at(-1).time);
    const paneExists = (id: string) => {
      try {
        const pane = terminal.chart.addPane({ id });
        pane.remove();
        return false;
      } catch {
        return true;
      }
    };
    terminal.chart.removeSeries('terminal-study-4');
    return {
      error,
      before,
      after: terminal.getWorkspace(),
      stateError: terminal.getState().error,
      oldSeriesPresent:
        Object.prototype.hasOwnProperty.call(points, 'terminal-study-1') &&
        Object.prototype.hasOwnProperty.call(points, 'terminal-study-2'),
      leakedPrefix: Object.prototype.hasOwnProperty.call(points, 'terminal-study-3'),
      oldPanesPresent: paneExists('terminal-study-1-pane') && paneExists('terminal-study-2-pane'),
    };
  });
  expect(result.error).toMatch(/already exists|duplicate/i);
  expect(result.after).toEqual(result.before);
  expect(result.stateError).toMatch(/already exists|duplicate/i);
  expect(result.oldSeriesPresent).toBe(true);
  expect(result.leakedPrefix).toBe(false);
  expect(result.oldPanesPresent).toBe(true);
});
test('late settings failure restores studies and volume topology while keeping a sticky error', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    terminal.applySettings({ volume: false });
    const before = terminal.getWorkspace();
    terminal.chart.addSeries('line', { id: 'terminal-volume' });
    let error = '';
    try {
      terminal.applySettings({ theme: 'light', volume: true, emaPeriod: 7 });
    } catch (cause) {
      error = String(cause);
    }
    terminal.chart.removeSeries('terminal-volume');
    let paneReusable = false;
    try {
      const pane = terminal.chart.addPane({ id: 'terminal-volume-pane' });
      paneReusable = true;
      pane.remove();
    } catch {}
    return {
      error,
      before,
      after: terminal.getWorkspace(),
      stateError: terminal.getState().error,
      ready: document.querySelector('[data-terminal-status]')?.getAttribute('data-ready'),
      paneReusable,
    };
  });
  expect(result.error).toMatch(/already exists|duplicate/i);
  expect(result.after).toEqual(result.before);
  expect(result.stateError).toMatch(/already exists|duplicate/i);
  expect(result.ready).toBe('false');
  expect(result.paneReusable).toBe(true);
});

test('focused study drafts yield to authoritative updates and keyed rows follow restored order', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 4 },
      { kind: 'rsi', period: 3 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.locator('[data-terminal-studies-toggle]').click();
  const firstPeriod = page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-period]');
  await firstPeriod.focus();
  await firstPeriod.fill('31');
  await page.evaluate(() => (window as any).terminalTestApi.terminal.updateStudy('study-1', { period: 40 }));
  await expect(firstPeriod).toBeFocused();
  await expect(firstPeriod).toHaveValue('40');
  await firstPeriod.blur();
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getStudies()[0].period)).toBe(40);

  await page.evaluate(async () => {
    const terminal = (window as any).terminalTestApi.terminal;
    const workspace = structuredClone(terminal.getWorkspace());
    workspace.studies = [workspace.studies[2], workspace.studies[0], workspace.studies[1]];
    await terminal.restoreWorkspace(workspace);
  });
  expect(
    await page
      .locator('[data-terminal-study-row]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-terminal-study-row'))),
  ).toEqual(['study-3', 'study-1', 'study-2']);
  const focusedRemoval = page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-period]');
  await focusedRemoval.focus();
  await page.evaluate(() => (window as any).terminalTestApi.terminal.removeStudy('study-1'));
  await expect(page.locator('[data-terminal-study-row="study-1"]')).toHaveCount(0);
});

test('tail and style paths do not read FeedSession history after hydration', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.resetFeedDataReads());
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.reviseTail(181, 31);
    api.reviseTail(183, 32);
    api.appendBars(1);
    api.terminal.updateStudy('terminal-ema', { color: '#ABCDEF', lineWidth: 4 });
  });
  expect(await page.evaluate(() => (window as any).terminalTestApi.feedDataReads())).toBe(0);
});

test('terminal styles do not affect matching elements outside their instance', async ({ page }) => {
  await ready(page);
  const position = await page.evaluate(() => {
    const outside = document.createElement('div');
    outside.dataset.terminalChart = '';
    document.body.append(outside);
    return getComputedStyle(outside).position;
  });
  expect(position).toBe('static');
});
