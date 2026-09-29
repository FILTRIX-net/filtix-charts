import { expect, test, type Page } from '@playwright/test';

const key = 'filtix.charts.analysis.v1';
const start = Date.UTC(2026, 5, 1);
async function seek(page: Page, position: number) {
  await page.locator('#analysis-seek').evaluate((element, value) => {
    (element as HTMLInputElement).value = String(value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, position);
  await expect(page.locator('#analysis-position')).toHaveText(String(position));
  await page.evaluate(() => window.analysisTestApi!.idle());
}
const snapshot = (page: Page) => page.evaluate(() => window.analysisTestApi!.snapshot());

test('analysis reveals only timestamp-eligible bars and deterministic derived data on seek', async ({
  page,
}) => {
  await page.goto('/analysis.html?test=1');
  await expect(page.locator('#analysis-title')).toHaveText('History. On your terms.');
  await expect(page.locator('#analysis-position')).toHaveText('120');
  await seek(page, 42);
  const first = await snapshot(page);
  expect(first.series.btc).toHaveLength(42);
  expect(first.series.eth).toHaveLength(40);
  for (const points of Object.values(first.series))
    expect(points.every((point) => Number(point.time) <= start + 41 * 3600000)).toBe(true);
  await seek(page, 250);
  await seek(page, 42);
  expect((await snapshot(page)).series).toEqual(first.series);
  await seek(page, 0);
  for (const points of Object.values((await snapshot(page)).series)) expect(points).toHaveLength(0);
  await expect(page.locator('#analysis-base')).toContainText('Reveal history');
  await page.locator('#analysis-step').click();
  await expect(page.locator('#analysis-position')).toHaveText('1');
});

test('play pause speed and linked view controls operate real chart instances', async ({ page }) => {
  await page.goto('/analysis.html?test=1');
  await page.locator('#analysis-speed').selectOption('16');
  await page.locator('#analysis-play').click();
  await expect.poll(async () => (await snapshot(page)).state.position).toBeGreaterThan(122);
  await page.locator('#analysis-play').click();
  const stopped = (await snapshot(page)).state.position;
  await page.waitForTimeout(220);
  expect((await snapshot(page)).state.position).toBe(stopped);
  const range = { from: start + 10 * 3600000, to: start + 50 * 3600000 };
  await page.evaluate((range) => window.analysisTestApi!.setRange(0, range), range);
  await page.evaluate(() => window.analysisTestApi!.idle());
  expect(
    (await snapshot(page)).ranges.every((actual) => actual?.from === range.from && actual.to === range.to),
  ).toBe(true);
  await page.locator('#analysis-sync').uncheck();
  await page.evaluate((range) => window.analysisTestApi!.setRange(0, range), {
    from: start + 20 * 3600000,
    to: start + 60 * 3600000,
  });
  await page.evaluate(() => window.analysisTestApi!.idle());
  expect((await snapshot(page)).ranges[1]).toEqual(range);
});

test('saved analysis restores a paused workspace and invalid saves are atomic', async ({ page }) => {
  await page.goto('/analysis.html?test=1');
  await seek(page, 100);
  await page.locator('#analysis-speed').selectOption('16');
  await page.locator('#analysis-sync').uncheck();
  await page.locator('#analysis-follow').uncheck();
  await page.locator('#analysis-theme').click();
  await page.locator('#analysis-save').click();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
  await page.reload();
  await page.locator('#analysis-load').click();
  await expect(page.locator('#analysis-position')).toHaveText('100');
  await expect(page.locator('#analysis-speed')).toHaveValue('16');
  await expect(page.locator('#analysis-sync')).not.toBeChecked();
  await expect(page.locator('#analysis-follow')).not.toBeChecked();
  expect((await snapshot(page)).state.status).toBe('paused');
  await page.locator('#analysis-save').click();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual(saved);
  const invalid = { ...saved, theme: 'dark', position: null };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key,
    value: invalid,
  });
  await page.locator('#analysis-load').click();
  await expect(page.locator('#analysis-error')).toBeVisible();
  await expect(page.locator('#analysis-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#analysis-save').click();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual(saved);
});

test('analysis controls fit mobile and destroying the page releases owned canvases', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/analysis.html?test=1');
  await expect(page.locator('#analysis-position')).toHaveText('120');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#analysis-step').click();
  await expect(page.locator('#analysis-position')).toHaveText('121');
  await page.evaluate(() => window.analysisTestApi!.destroy());
  await expect(page.locator('[data-filtix-root]')).toHaveCount(0);
});
