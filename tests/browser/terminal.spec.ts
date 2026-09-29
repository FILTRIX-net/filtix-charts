import { expect, test, type Page } from '@playwright/test';

type BrowserBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function ready(page: Page) {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

function baselineEma(bars: readonly BrowserBar[], period: number) {
  let current: number | undefined;
  let seed = 0;
  return bars.map((bar, index) => {
    if (index < period) {
      seed += bar.close / period;
      if (index === period - 1) current = seed;
    } else {
      current = (2 / (period + 1)) * bar.close + (1 - 2 / (period + 1)) * current!;
    }
    return current;
  });
}

test('historical stream revisions rebuild price, volume and EMA from the authoritative snapshot', async ({
  page,
}) => {
  await ready(page);
  const before = await page.evaluate(() => (window as any).terminalTestApi.terminal.getData());
  const corrected = before.at(-5)!;
  await page.evaluate(
    (time) => (window as any).terminalTestApi.reviseHistorical(time, 500, 77),
    corrected.time,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (time) =>
          (window as any).terminalTestApi.terminal.getData().find((bar: BrowserBar) => bar.time === time)
            ?.close,
        corrected.time,
      ),
    )
    .toBe(500);
  const result = await page.evaluate(async (time) => {
    const api = (window as any).terminalTestApi;
    await api.terminal.chart.whenIdle();
    const bars = api.terminal.getData();
    return {
      atCorrection: await api.pointsAt(time),
      atTail: await api.pointsAt(bars.at(-1).time),
      bars,
    };
  }, corrected.time);
  expect(result.atCorrection['terminal-price']).toMatchObject({ close: 500 });
  expect(result.atCorrection['terminal-volume']).toEqual({ time: corrected.time, value: 77 });
  const expected = baselineEma(result.bars, 3).at(-1)!;
  expect(result.atTail['terminal-ema'].value).toBeCloseTo(expected, 10);

  await page.evaluate(() => {
    (window as any).terminalTestApi.reviseTail(210, 31);
    (window as any).terminalTestApi.reviseTail(212, 32);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getData().at(-1).close))
    .toBe(212);
  const tail = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    await api.terminal.chart.whenIdle();
    const bars = api.terminal.getData();
    return { bars, points: await api.pointsAt(bars.at(-1).time) };
  });
  expect(tail.points['terminal-price']).toMatchObject({ close: 212, volume: 32 });
  expect(tail.points['terminal-volume'].value).toBe(32);
  expect(tail.points['terminal-ema'].value).toBeCloseTo(baselineEma(tail.bars, 3).at(-1)!, 10);
});

test('rapid switches fence late history and obsolete stream callbacks', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.remount();
    api.holdNextHistory();
    api.pendingSwitch = api.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
  });
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'BTCUSDT', interval: '5m' }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const expected = await page.evaluate(() => (window as any).terminalTestApi.terminal.getData());
  await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.releaseHeldHistory();
    api.emitObsolete();
    await api.pendingSwitch;
    await api.terminal.chart.whenIdle();
  });
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getData())).toEqual(expected);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.query)).toEqual({
    symbol: 'BTCUSDT',
    interval: '5m',
  });
});

test('a market switch started by onState remains authoritative over the outer switch', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.armObserverSwitch({ symbol: 'BTCUSDT', interval: '5m' });
    await api.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
    await api.waitObserverAction();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return {
      feed: api.terminal.getState().feed.query,
      workspace: api.terminal.getWorkspace().query,
      selected: {
        symbol: document.querySelector<HTMLSelectElement>('[data-terminal-symbol]')!.value,
        interval: document.querySelector<HTMLSelectElement>('[data-terminal-interval]')!.value,
      },
      first: api.terminal.getData()[0],
      active: api.activeQueries(),
    };
  });
  expect(result.feed).toEqual({ symbol: 'BTCUSDT', interval: '5m' });
  expect(result.workspace).toEqual(result.feed);
  expect(result.selected).toEqual(result.feed);
  expect(result.first).toMatchObject({ open: 148, close: 149 });
  expect(result.active).toEqual(['BTCUSDT:5m']);
});

test('valid restore publishes one coherent workspace and fences observer reentry', async ({ page }) => {
  await ready(page);
  const captured = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const workspace = api.workspaceFor({ symbol: 'ETHUSDT', interval: '5m' }, { theme: 'light' });
    const active = workspace.markets.find(
      (market: any) => market.query.symbol === 'ETHUSDT' && market.query.interval === '5m',
    );
    active.drawings.drawings.push({
      id: 'restored-line',
      type: 'horizontal-line',
      paneId: 'price',
      points: [{ time: 1_788_223_200_000, price: 321 }],
      style: { color: '#c7ef57', lineWidth: 2, fillOpacity: 0.12 },
      locked: false,
      visible: true,
    });
    api.armWorkspaceCapture();
    await api.terminal.restoreWorkspace(workspace);
    return api.capturedWorkspaces.at(-1);
  });
  expect(captured.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
  expect(captured.settings.theme).toBe('light');
  const capturedActive = captured.markets.find(
    (market: any) => market.query.symbol === 'ETHUSDT' && market.query.interval === '5m',
  );
  expect(capturedActive.drawings.drawings.map((drawing: any) => drawing.id)).toEqual(['restored-line']);

  await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const workspace = api.workspaceFor({ symbol: 'BTCUSDT', interval: '1m' }, { theme: 'dark' });
    api.armObserverSwitch({ symbol: 'ETHUSDT', interval: '1m' });
    await api.terminal.restoreWorkspace(workspace);
    await api.waitObserverAction();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.query)).toEqual({
    symbol: 'ETHUSDT',
    interval: '1m',
  });
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace().query)).toEqual({
    symbol: 'ETHUSDT',
    interval: '1m',
  });
  expect(await page.evaluate(() => (window as any).terminalTestApi.activeQueries())).toEqual(['ETHUSDT:1m']);

  await page.evaluate(() => (window as any).terminalTestApi.remount());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const restoreResult = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const workspace = api.workspaceFor({ symbol: 'ETHUSDT', interval: '5m' }, { theme: 'light' });
    api.armObserverDestroy();
    try {
      await api.terminal.restoreWorkspace(workspace);
      return 'settled';
    } catch (error) {
      return String(error);
    }
  });
  expect(restoreResult).toBe('settled');
  await expect(page.locator('[data-filtix-terminal]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().destroyed)).toBe(true);
  expect(await page.evaluate(() => (window as any).terminalTestApi.activeSubscriptions())).toBe(0);
});
test('changed-market callbacks never report prior live data as current readiness', async ({ page }) => {
  await ready(page);
  const switched = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.armConsistencyCapture();
    await api.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
    return api.consistencyCaptures.at(-1);
  });
  expect(switched.state.feed).toMatchObject({ status: 'loading', query: switched.workspace.query });
  expect(switched.workspace.query).toEqual({ symbol: 'ETHUSDT', interval: '1m' });
  expect(switched.data).toEqual([]);

  const restored = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const workspace = api.workspaceFor({ symbol: 'BTCUSDT', interval: '5m' }, { theme: 'light' });
    api.armConsistencyCapture();
    await api.terminal.restoreWorkspace(workspace);
    return api.consistencyCaptures.at(-1);
  });
  expect(restored.state.feed).toMatchObject({ status: 'loading', query: restored.workspace.query });
  expect(restored.workspace.query).toEqual({ symbol: 'BTCUSDT', interval: '5m' });
  expect(restored.data).toEqual([]);
});

test('ingestion failure stays not-ready across unrelated actions until canonical repair', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithOverflow());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().error))
    .toContain('volume');
  await expect(page.locator('[data-terminal-status]')).not.toHaveAttribute('data-ready', 'true');
  const failure = await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().error);
  await page.locator('[data-terminal-action="fit"]').click();
  await page.locator('[data-terminal-tool="select"]').click();
  await page.locator('[data-terminal-theme]').selectOption('light');
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().error)).toBe(failure);
  await expect(page.locator('[data-terminal-status]')).not.toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => (window as any).terminalTestApi.repairOverflow());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().error))
    .toBeNull();
  await expect(page.locator('[data-terminal-status]')).toHaveAttribute('data-ready', 'true');
});

test('NUL-containing market pairs keep isolated drawings and workspace entries', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithCollisionCatalog());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(async () => {
    const terminal = (window as any).terminalTestApi.terminal;
    const first = { symbol: 'A', interval: 'B\u0000C' };
    const second = { symbol: 'A\u0000B', interval: 'C' };
    const bars = terminal.getData();
    terminal.getDrawings().add({
      id: 'first-pair',
      type: 'horizontal-line',
      points: [{ time: bars[0].time, price: bars[0].close }],
    });
    await terminal.setMarket(second);
    const leaked = terminal
      .getDrawings()
      .list()
      .map((drawing: any) => drawing.id);
    const secondBars = terminal.getData();
    terminal.getDrawings().add({
      id: 'second-pair',
      type: 'horizontal-line',
      points: [{ time: secondBars[0].time, price: secondBars[0].close }],
    });
    const workspace = terminal.getWorkspace();
    await terminal.restoreWorkspace(workspace);
    await terminal.setMarket(first);
    return {
      leaked,
      markets: workspace.markets.map((market: any) => market.query),
      restored: terminal
        .getDrawings()
        .list()
        .map((drawing: any) => drawing.id),
    };
  });
  expect(result.leaked).toEqual([]);
  expect(result.markets).toHaveLength(2);
  expect(result.restored).toEqual(['first-pair']);
});

test('replacing drawing context cancels a pending tool and presses Select immediately', async ({ page }) => {
  await ready(page);
  await page.locator('[data-terminal-tool="rectangle"]').click();
  await page.locator('[data-filtix-root]').click({ position: { x: 180, y: 120 } });
  await expect(page.locator('[data-terminal-tool="rectangle"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  await expect(page.locator('[data-terminal-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-terminal-tool="rectangle"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().list())).toEqual(
    [],
  );

  await page.locator('[data-terminal-tool="rectangle"]').click();
  const workspace = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  await page.evaluate((value) => (window as any).terminalTestApi.terminal.restoreWorkspace(value), workspace);
  await expect(page.locator('[data-terminal-tool="select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-terminal-tool="rectangle"]')).toHaveAttribute('aria-pressed', 'false');
});
test('workspace restore is atomic and drawing undo cannot cross markets', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const bars = api.terminal.getData();
    api.terminal.getDrawings().add({
      id: 'btc-line',
      type: 'trend-line',
      points: [
        { time: bars[1].time, price: bars[1].close },
        { time: bars[3].time, price: bars[3].close },
      ],
    });
  });
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    const bars = api.terminal.getData();
    api.terminal.getDrawings().add({
      id: 'eth-line',
      type: 'horizontal-line',
      points: [{ time: bars[2].time, price: bars[2].close }],
    });
  });
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'BTCUSDT', interval: '1m' }),
  );
  expect(
    await page.evaluate(() =>
      (window as any).terminalTestApi.terminal
        .getDrawings()
        .list()
        .map((item: any) => item.id),
    ),
  ).toEqual(['btc-line']);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().undo())).toBe(true);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().list())).toEqual(
    [],
  );

  const before = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  const message = await page.evaluate(async () => {
    const terminal = (window as any).terminalTestApi.terminal;
    const invalid = structuredClone(terminal.getWorkspace());
    invalid.markets.push(structuredClone(invalid.markets[0]));
    try {
      await terminal.restoreWorkspace(invalid);
      return '';
    } catch (error) {
      return String(error);
    }
  });
  expect(message).toMatch(/duplicate/i);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace())).toEqual(before);
});

test('composition failures are visible and destroy fences pending callbacks', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.throwFromObserver = true;
    api.terminal.chart.removeSeries('terminal-price');
    api.reviseTail(240, 41);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().error))
    .toMatch(/series does not exist|removed/i);
  expect(await page.locator('[data-terminal-error]').getAttribute('role')).toBe('alert');

  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.remount();
    api.holdNextHistory();
    api.pendingSwitch = api.terminal.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
  });
  await page.evaluate(() => (window as any).terminalTestApi.terminal.destroy());
  const cached = await page.evaluate(() => ({
    state: (window as any).terminalTestApi.terminal.getState(),
    settings: (window as any).terminalTestApi.terminal.getSettings(),
    workspace: (window as any).terminalTestApi.terminal.getWorkspace(),
  }));
  await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.releaseHeldHistory();
    api.emitObsolete();
    await api.pendingSwitch;
  });
  expect(cached.state.destroyed).toBe(true);
  expect(cached.workspace.schema).toBe('filtix-terminal');
  await expect(page.locator('[data-filtix-terminal]')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).terminalTestApi.activeSubscriptions())).toBe(0);
  expect(
    await page.evaluate(async () => {
      try {
        await (window as any).terminalTestApi.terminal.setMarket({ symbol: '', interval: '' });
        return '';
      } catch (error) {
        return String(error);
      }
    }),
  ).toMatch(/destroyed/i);
  expect(
    await page.evaluate(() => {
      try {
        (window as any).terminalTestApi.terminal.getData();
        return '';
      } catch (error) {
        return String(error);
      }
    }),
  ).toMatch(/destroyed/i);
});

test('corrections, backfill and reconnect keep every rendered series on one snapshot', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.terminal.loadMore());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getData().length))
    .toBe(18);
  await page.evaluate(() => (window as any).terminalTestApi.correctLoadedBar(4, 333, 88));
  let bars = await page.evaluate(() => (window as any).terminalTestApi.terminal.getData());
  expect(bars[4]).toMatchObject({ close: 333, volume: 88 });
  await page.evaluate(() => (window as any).terminalTestApi.disconnectAndAppend(2));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getData().length))
    .toBe(20);
  const rendered = await page.evaluate(() => (window as any).terminalTestApi.renderedSeries());
  bars = rendered.bars;
  expect(rendered.price).toEqual(
    bars.map(({ time, open, high, low, close, volume }: BrowserBar) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    })),
  );
  expect(rendered.volume).toEqual(bars.map((bar: BrowserBar) => ({ time: bar.time, value: bar.volume })));
  const expectedEma = baselineEma(bars, 3);
  expect(rendered.ema).toEqual(
    bars.map((bar: BrowserBar, index: number) =>
      expectedEma[index] === undefined ? null : { time: bar.time, value: expectedEma[index] },
    ),
  );
});

test('bounded failure stays visible and a reentrant destroy releases ownership', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.remountWithCap(3));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.evaluate(() => (window as any).terminalTestApi.appendBars(1));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.error?.code))
    .toBe('LIMIT');
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getData().length)).toBe(3);
  await expect(page.locator('[data-terminal-status]')).not.toHaveAttribute('data-ready', 'true');

  await page.evaluate(() => (window as any).terminalTestApi.remount());
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.destroyFromObserver = true;
    api.reviseTail(260, 45);
  });
  await expect(page.locator('[data-filtix-terminal]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).terminalTestApi.activeSubscriptions())).toBe(0);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getState().destroyed)).toBe(true);
});
test('toolbar controls remain operable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 844 });
  await ready(page);
  await page.evaluate(() => {
    const host = document.getElementById('terminal-host')!;
    host.style.width = '390px';
    host.style.height = '800px';
  });
  await page.locator('[data-terminal-symbol]').selectOption('ETHUSDT');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.query?.symbol))
    .toBe('ETHUSDT');
  await expect(page.locator('label:has([data-terminal-symbol]) > span')).toHaveCSS('position', 'absolute');
  await expect(page.locator('label:has([data-terminal-volume]) > span')).not.toHaveCSS(
    'position',
    'absolute',
  );
  await expect(page.locator('label:has([data-terminal-ema]) > span')).not.toHaveCSS('position', 'absolute');
  await page.locator('[data-terminal-theme]').selectOption('light');
  await expect(page.locator('[data-filtix-terminal]')).toHaveAttribute('data-theme', 'light');
  await page.locator('[data-terminal-tool="rectangle"]').click();
  expect(
    await page.evaluate(
      () => (window as any).terminalTestApi.terminal.getDrawings().getHistoryState().canUndo,
    ),
  ).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-terminal-chart]')).toBeVisible();
});
