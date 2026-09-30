import { expect, test } from '@playwright/test';

const demos = [
  { path: '', canvas: '#chart canvas', count: 2 },
  { path: 'market.html', canvas: '#market-chart canvas', count: 2 },
  { path: 'drawings.html', canvas: '#study-chart canvas', count: 3 },
  { path: 'analysis.html', canvas: '#analysis-btc-chart canvas', count: 2 },
  { path: 'terminal.html', canvas: '[data-terminal-chart] canvas', count: 3 },
];
const rows = Array.from({ length: 120 }, (_, index) => {
  const time = Date.UTC(2026, 8, 1) + index * 60_000;
  return [time, '100', '102', '99', '101', '10', time + 59_999, '1000', 10, '5', '500', '0'];
});

test.beforeEach(async ({ page }) => {
  await page.route('https://data-api.binance.vision/**', (route) => route.fulfill({ json: rows }));
  await page.routeWebSocket('wss://data-stream.binance.vision/**', () => {});
});

for (const demo of demos) {
  test(`built ${demo.path || 'studio'} renders with working public navigation`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    const failedLocal: string[] = [];
    const prefix = new URL(baseURL!);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (new URL(response.url()).origin === prefix.origin && response.status() >= 400)
        failedLocal.push(response.url());
    });
    const response = await page.goto(demo.path || './');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/FILTRIX/);
    await expect(page.locator(demo.canvas)).toHaveCount(demo.count);
    const size = await page.locator(demo.canvas).first().boundingBox();
    expect(size!.width).toBeGreaterThan(40);
    expect(size!.height).toBeGreaterThan(40);
    if (demo.path === 'market.html') await expect(page.locator('#market-price')).toHaveText('101.00');
    if (demo.path === 'terminal.html')
      await expect(page.locator('[data-terminal-status]')).toHaveAttribute('data-ready', 'true');
    if (demo.path === 'analysis.html') await expect(page.locator('#analysis-position')).toHaveText('120');
    await expect(page.locator('a[href*="benchmark"]')).toHaveCount(0);
    const links = await page
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
    for (const link of new Set(links)) {
      const url = new URL(link);
      if (url.origin !== prefix.origin) continue;
      expect(url.pathname.startsWith(prefix.pathname)).toBe(true);
      expect((await page.request.get(url.href)).status()).toBe(200);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    expect(failedLocal).toEqual([]);
  });
}

for (const path of ['market.html', 'terminal.html']) {
  test(`${path} explains unavailable market data`, async ({ page }) => {
    await page.route('https://data-api.binance.vision/**', (route) =>
      route.fulfill({ status: 403, json: { msg: 'Market access denied by test source' } }),
    );
    await page.goto(path);
    const terminal = path === 'terminal.html';
    await expect(page.locator(terminal ? '[data-terminal-status]' : '#market-status')).toHaveText(
      'Unavailable',
    );
    await expect(page.locator(terminal ? '[data-terminal-error]' : '#market-error')).toContainText(
      'Market access denied by test source',
    );
    if (terminal) await expect(page.locator('[data-terminal-status]')).toHaveAttribute('data-ready', 'false');
    else await expect(page.locator('#market-price')).toHaveText('—');
  });
}
