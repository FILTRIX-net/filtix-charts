import { expect, test } from '@playwright/test';

const layoutKey = 'filtix.charts.study.v1';
const readSaved = (page: import('@playwright/test').Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), layoutKey);

test('study tools create real annotations, undo and export on a responsive chart', async ({ page }) => {
  await page.goto('/drawings.html');
  await expect(page.locator('#study-title')).toHaveText('Bitcoin study');
  await expect(page.locator('[data-study-drawing]')).toHaveCount(3);
  await page.locator('[data-tool="horizontal-line"]').click();
  await page.locator('#study-chart [data-filtix-root]').click({ position: { x: 260, y: 150 } });
  await expect(page.locator('[data-study-drawing]')).toHaveCount(4);
  await page.locator('#study-undo').click();
  await expect(page.locator('[data-study-drawing]')).toHaveCount(3);
  await page.locator('#study-redo').click();
  await expect(page.locator('[data-study-drawing]')).toHaveCount(4);
  const download = page.waitForEvent('download');
  await page.locator('#study-export').click();
  expect((await download).suggestedFilename()).toBe('FILTIX-study.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#study-clear').click();
  await expect(page.locator('[data-study-drawing]')).toHaveCount(0);
  await page.locator('#study-undo').click();
  await expect(page.locator('[data-study-drawing]')).toHaveCount(4);
});

test('saved study restores edited anchors, theme and viewport across a page reload', async ({ page }) => {
  await page.goto('/drawings.html');
  await expect(page.locator('[data-study-drawing]')).toHaveCount(3);
  await page.locator('[data-study-drawing]').first().click();
  const original = Number(await page.locator('#study-price-a').inputValue());
  const changed = String(Math.round(original + 100));
  await page.locator('#study-price-a').fill(changed);
  await page.locator('#study-price-a').press('Tab');
  await expect(page.locator('#study-price-a')).toHaveValue(changed);
  await page.locator('#study-theme').click();
  await page.locator('#study-save').click();
  const saved = await readSaved(page);
  expect(saved.theme).toBe('light');
  expect(saved.drawings.drawings[0].points[0].price).toBe(Number(changed));
  await page.reload();
  await page.locator('#study-load').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('[data-study-drawing]').first().click();
  await expect(page.locator('#study-price-a')).toHaveValue(changed);
  await page.locator('#study-save').click();
  expect(await readSaved(page)).toEqual(saved);
});

test('invalid saved layout cannot partially alter theme, viewport or drawings', async ({ page }) => {
  await page.goto('/drawings.html');
  await expect(page.locator('[data-study-drawing]')).toHaveCount(3);
  await page.locator('#study-save').click();
  const original = await readSaved(page);
  const invalid = structuredClone(original);
  invalid.theme = 'light';
  invalid.range = { from: 0, to: 50 };
  invalid.drawings.drawings[0].points[0].price = null;
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: layoutKey,
    value: invalid,
  });
  await page.locator('#study-load').click();
  await expect(page.locator('#study-error')).toBeVisible();
  await expect(page.locator('#study-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('[data-study-drawing]')).toHaveCount(3);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');
  await page.locator('#study-save').click();
  expect(await readSaved(page)).toEqual(original);
});

test('keyboard selection retains focus in the annotation list', async ({ page }) => {
  await page.goto('/drawings.html');
  const first = page.locator('[data-study-drawing="sample-trend"]');
  await first.focus();
  await first.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-study-drawing="sample-level"]')).toBeFocused();
});
