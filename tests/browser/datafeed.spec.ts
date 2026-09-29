import { expect, test, type WebSocketRoute } from '@playwright/test';
function fixtureRows(symbol = 'BTCUSDT') {
  const start = Date.UTC(2026, 8, 1);
  const price = symbol === 'ETHUSDT' ? 200 : 100;
  return Array.from({ length: 120 }, (_, i) => [
    start + i * 60000,
    String(price),
    String(price + 2),
    String(price - 1),
    String(price + 1),
    '10',
    start + (i + 1) * 60000 - 1,
    '1000',
    10,
    '5',
    '500',
    '0',
  ]);
}

test('feed backfill preserves the displayed timestamp using stable chart handles', async ({ page }) => {
  await page.goto('/feed-test.html');
  await page.waitForFunction(() => Boolean(window.feedTestApi), undefined, { timeout: 3000 });
  await page.evaluate(async () => {
    await window.feedTestApi.feed.load({ symbol: 'BTCUSDT', interval: '1m' });
    window.feedTestApi.chart.setVisibleRange({ from: 4, to: 24 });
    await window.feedTestApi.chart.whenIdle();
  });
  const before = await page.evaluate(() => ({
    time: window.feedTestApi.chart.coordinateToTime(250),
    count: window.feedTestApi.price.getData().length,
  }));
  await page.evaluate(async () => {
    await window.feedTestApi.feed.loadMore();
    await window.feedTestApi.chart.whenIdle();
  });
  expect(await page.evaluate(() => window.feedTestApi.chart.coordinateToTime(250))).toBe(before.time);
  expect(await page.evaluate(() => window.feedTestApi.price.getData().length)).toBeGreaterThan(before.count);
});

test('obsolete query responses and callbacks cannot replace a newly selected instrument', async ({
  page,
}) => {
  await page.goto('/feed-test.html');
  await page.waitForFunction(() => Boolean(window.feedTestApi), undefined, { timeout: 3000 });
  await page.evaluate(() => window.feedTestApi.beginHeldLoad());
  await page.evaluate(() => window.feedTestApi.feed.load({ symbol: 'ETHUSDT', interval: '1m' }));
  const expected = await page.evaluate(() => window.feedTestApi.price.getData());
  await page.evaluate(async () => {
    await window.feedTestApi.releaseHeld();
    window.feedTestApi.emitObsolete();
    await window.feedTestApi.chart.whenIdle();
  });
  expect(await page.evaluate(() => window.feedTestApi.price.getData())).toEqual(expected);
  expect(await page.evaluate(() => window.feedTestApi.feed.getState().query?.symbol)).toBe('ETHUSDT');
});

test('reconnect fills missed bars and destroys owned chart/feed resources', async ({ page }) => {
  await page.goto('/feed-test.html');
  await page.waitForFunction(() => Boolean(window.feedTestApi), undefined, { timeout: 3000 });
  await page.evaluate(() => window.feedTestApi.feed.load({ symbol: 'BTCUSDT', interval: '1m' }));
  const initial = await page.evaluate(() => window.feedTestApi.price.getData().length);
  await page.evaluate(() => window.feedTestApi.missBarsAndReconnect(3));
  await expect.poll(() => page.evaluate(() => window.feedTestApi.price.getData().length)).toBe(initial + 3);
  await expect.poll(() => page.evaluate(() => window.feedTestApi.feed.getState().status)).toBe('live');
  expect(await page.evaluate(() => window.feedTestApi.statuses.includes('reconnecting'))).toBe(true);
  const state = await page.evaluate(() => ({
    data: window.feedTestApi.price.getData(),
    source: window.feedTestApi.latestSource(),
  }));
  expect(state.data.at(-1)).toMatchObject(state.source);
  await page.evaluate(() => window.feedTestApi.destroy());
  await expect(page.locator('[data-filtix-root]')).toHaveCount(0);
  expect(await page.evaluate(() => window.feedTestApi.activeSubscriptions())).toBe(0);
});

test('market screen renders adapter data, switches instruments and stays usable on mobile', async ({
  page,
}) => {
  await page.route('https://data-api.binance.vision/**', async (route) => {
    const query = new URL(route.request().url());
    const rows = fixtureRows(query.searchParams.get('symbol') ?? undefined);
    await route.fulfill({ json: rows, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.routeWebSocket('wss://data-stream.binance.vision/**', () => {});
  await page.goto('/market.html');
  await expect(page.locator('#market-status')).toHaveText('Live');
  await expect(page.locator('#market-price')).toHaveText('101.00');
  await expect(page.locator('#market-volume')).toHaveText('10.00');
  await expect(page.locator('#market-source')).toContainText('Binance Spot');
  await page.locator('#market-symbol').selectOption('ETHUSDT');
  await expect(page.locator('#market-price')).toHaveText('201.00');
  await expect(page.locator('#market-title')).toContainText('Ethereum');
  await page.locator('#market-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-filtix-root]')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.locator('#market-export').click();
  expect((await download).suggestedFilename()).toMatch(/ETHUSDT.*\.png$/);
});

test('market error explains the cause accessibly and retry restores real-provider mode', async ({ page }) => {
  let failed = true;
  await page.route('https://data-api.binance.vision/**', (route) =>
    failed
      ? route.fulfill({ status: 403, json: { msg: 'Market access denied by test source' } })
      : route.fulfill({ json: fixtureRows() }),
  );
  await page.routeWebSocket('wss://data-stream.binance.vision/**', () => {});
  await page.goto('/market.html');
  await expect(page.locator('#market-status')).toHaveText('Unavailable');
  await expect(page.locator('#market-error')).toHaveText('Market access denied by test source');
  await expect(page.locator('#market-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#market-price')).toHaveText('—');
  failed = false;
  await page.locator('#market-retry').click();
  await expect(page.locator('#market-status')).toHaveText('Live');
  await expect(page.locator('#market-price')).toHaveText('101.00');
  await expect(page.locator('#market-error')).toBeHidden();
});

test('destroy during ignored-abort history suppresses later notifications', async ({ page }) => {
  await page.goto('/feed-test.html');
  await page.waitForFunction(() => Boolean(window.feedTestApi), undefined, { timeout: 3000 });
  await page.evaluate(() => {
    window.feedTestApi.beginHeldLoad();
    window.feedTestApi.destroy();
  });
  const count = await page.evaluate(() => window.feedTestApi.notificationCount());
  await page.evaluate(async () => {
    await window.feedTestApi.releaseHeld();
    window.feedTestApi.emitObsolete();
  });
  expect(await page.evaluate(() => window.feedTestApi.notificationCount())).toBe(count);
  expect(await page.evaluate(() => window.feedTestApi.activeSubscriptions())).toBe(0);
  await expect(page.locator('[data-filtix-root]')).toHaveCount(0);
});

test('volume series follows reset, backfill and incremental candle replacement', async ({ page }) => {
  await page.goto('/feed-test.html');
  await page.waitForFunction(() => Boolean(window.feedTestApi), undefined, { timeout: 3000 });
  await page.evaluate(async () => {
    await window.feedTestApi.feed.load({ symbol: 'BTCUSDT', interval: '1m' });
    await window.feedTestApi.feed.loadMore();
    window.feedTestApi.emitLiveVolume(77);
    await window.feedTestApi.chart.whenIdle();
  });
  const data = await page.evaluate(() => ({
    candles: window.feedTestApi.price.getData(),
    volume: window.feedTestApi.volume.getData(),
  }));
  expect(data.candles).toHaveLength(80);
  expect(data.volume).toEqual(
    data.candles.map((bar) => ({ time: bar.time, value: 'volume' in bar ? bar.volume : undefined })),
  );
  expect(data.volume.at(-1)).toMatchObject({ value: 77 });
});

test('streaming does not overwrite the candle inspected by the crosshair', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  await page.route('https://data-api.binance.vision/**', (route) => route.fulfill({ json: fixtureRows() }));
  await page.routeWebSocket('wss://data-stream.binance.vision/**', (route) => {
    socket = route;
  });
  await page.goto('/market.html');
  await expect(page.locator('#market-status')).toHaveText('Live');
  await page.locator('[data-filtix-root]').hover({ position: { x: 180, y: 100 } });
  await expect(page.locator('#market-candle-time')).not.toHaveText('2026-09-01 01:59');
  const initial = await page.locator('#market-candle-time').innerText();
  await page.evaluate(() => {
    const target = document.getElementById('market-close')!;
    const observations: string[] = [];
    (window as unknown as { legendMutations: string[] }).legendMutations = observations;
    new MutationObserver(() => observations.push(target.textContent ?? '')).observe(target, {
      childList: true,
    });
  });
  socket!.send(
    JSON.stringify({
      e: 'kline',
      s: 'BTCUSDT',
      k: {
        s: 'BTCUSDT',
        i: '1m',
        t: Date.UTC(2026, 8, 1, 1, 59),
        o: '100',
        h: '106',
        l: '99',
        c: '105',
        v: '20',
        n: 11,
      },
    }),
  );
  await expect(page.locator('#market-price')).toHaveText('105.00');
  await expect(page.locator('#market-candle-time')).toHaveText(initial);
  await expect(page.locator('#market-close')).toHaveText('101.00');
  expect(
    await page.evaluate(() => (window as unknown as { legendMutations: string[] }).legendMutations),
  ).not.toContain('105.00');
  await page.locator('h1').hover();
  await expect(page.locator('#market-close')).toHaveText('105.00');
  await expect(page.locator('#market-volume')).toHaveText('20.00');
});
