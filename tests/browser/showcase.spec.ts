import { test, expect } from '@playwright/test';

test('workspace controls compose a chart, export PNG, and expose its source values', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#chart canvas')).toHaveCount(2);
  await expect(page.locator('.demo-badge')).toBeVisible();
  await page.getByRole('button', { name: 'Show ETH / USD synthetic chart' }).click();
  await expect(page.locator('#pair')).toHaveText('ETH / USD');
  await page.getByRole('button', { name: '4H', exact: true }).click();
  await expect(page.locator('#interval-description')).toHaveText('4 hours');
  await page.getByLabel('Chart type').selectOption('area');
  await page.getByRole('button', { name: 'RSI 14', exact: true }).click();
  await expect(page.getByRole('button', { name: 'RSI 14', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('switch', { name: 'Logarithmic price' }).check();
  await page.getByRole('button', { name: 'Daylight' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'View accessible data table' }).click();
  await expect(page.locator('#data-rows tr')).toHaveCount(20);
  const sourceClose = await page.locator('#data-rows tr').first().locator('td').nth(4).textContent();
  await expect(page.locator('#current-price')).toHaveText(sourceClose!);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: false }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('filtrix-eth.png');
  await page.getByRole('button', { name: 'Integration', exact: true }).click();
  await expect(page.locator('#integration-code')).toContainText("addSeries('area'");
  await expect(page.locator('#integration-code')).toContainText("scale: 'log'");
  await expect(page.locator('#integration-code')).toContainText("createIndicator('rsi', 14)");
  await expect(page.locator('#integration-code')).toContainText('ariaLabel:');
  await expect(page.locator('#integration-code')).toContainText('diagnostics: true');
  await expect(page.locator('#integration-code')).toContainText("id: 'instrument'");
  await expect(page.locator('#integration-code')).toContainText('destroy: () => chart.destroy()');
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(page.locator('#chart canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('streaming changes source data and stops on request; mobile layout stays within viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#chart canvas')).toHaveCount(2);
  const original = await page.locator('#current-price').textContent();
  await page.getByRole('button', { name: 'Start stream' }).click();
  await expect(page.locator('#current-price')).not.toHaveText(original!);
  await page.getByRole('button', { name: 'Streaming', exact: true }).click();
  await expect(page.locator('#stream-toggle')).toHaveAttribute('aria-pressed', 'false');
  const paused = await page.locator('#current-price').textContent();
  // More than a feed interval proves the producer stopped, not just its label.
  await page.waitForTimeout(900);
  await expect(page.locator('#current-price')).toHaveText(paused!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('cached page lifecycle retains a working chart and pauses the demo feed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#chart canvas')).toHaveCount(2);
  await page.getByRole('button', { name: 'Start stream' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('#chart canvas')).toHaveCount(2);
  await expect(page.locator('#stream-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Daylight' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Show SOL / USD synthetic chart' }).click();
  await expect(page.locator('#pair')).toHaveText('SOL / USD');
  expect(errors).toEqual([]);
});

for (const scenario of [
  { asset: 'BTC', interval: '1H', hours: 1 },
  { asset: 'ETH', interval: '4H', hours: 4 },
  { asset: 'SOL', interval: '1D', hours: 24 },
]) {
  test(`streamed ${scenario.asset} ${scenario.interval} candles retain historical price variation`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-09-09T10:00:00Z') });
    await page.goto('/');
    await page.getByRole('button', { name: `Show ${scenario.asset} / USD synthetic chart` }).click();
    await page.getByRole('button', { name: scenario.interval, exact: true }).click();
    await page.clock.pauseAt(new Date('2026-09-09T10:01:00Z'));
    await page.locator('#table-toggle').dispatchEvent('click');
    const readRows = () =>
      page.locator('#data-rows tr').evaluateAll((rows) =>
        rows.map((row) => {
          const cells = Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '');
          return {
            time: Date.parse(cells[0]!.replace(' ', 'T') + ':00Z'),
            open: Number(cells[1]!.replaceAll(',', '')),
            high: Number(cells[2]!.replaceAll(',', '')),
            low: Number(cells[3]!.replaceAll(',', '')),
            close: Number(cells[4]!.replaceAll(',', '')),
            volume: Number(cells[5]!.replaceAll(',', '')),
          };
        }),
      );
    const history = await readRows();
    await page.locator('#stream-toggle').dispatchEvent('click');
    let previous = history[0]!;
    for (let tick = 0; tick < 8; tick++) {
      await page.clock.runFor(750);
      const point = (await readRows())[0]!;
      expect(point.time).toBe(history[0]!.time + scenario.hours * 3_600_000);
      expect(point.open).toBe(history[0]!.close);
      if (tick > 0) {
        expect(point.high).toBeGreaterThanOrEqual(previous.high);
        expect(point.low).toBeLessThanOrEqual(previous.low);
        expect(point.volume).toBeGreaterThanOrEqual(previous.volume);
      }
      previous = point;
      if (tick === 2) {
        await page.locator('#stream-toggle').dispatchEvent('click');
        await page.clock.runFor(1500);
        expect((await readRows())[0]).toEqual(point);
        // Rebuilding presentation must not reset the in-progress candle producer.
        await page.getByRole('button', { name: 'Daylight' }).dispatchEvent('click');
        await page.locator('#stream-toggle').dispatchEvent('click');
      }
    }
    // Exercise 30 bars, not only the first price-changing tick.
    await page.clock.runFor(180000 - 8 * 750);
    await page.locator('#stream-toggle').dispatchEvent('click');
    await page.clock.runFor(32);
    const streamed = await readRows();
    const relativeRange = (rows: typeof history) =>
      rows.slice(1).reduce((sum, point) => sum + (point.high - point.low) / point.open, 0) /
      (rows.length - 1);
    const closeSpan = (rows: typeof history) => {
      const closes = rows.slice(1).map((point) => point.close);
      return (Math.max(...closes) - Math.min(...closes)) / closes[0]!;
    };
    // Broad continuity bounds catch the old tiny bounded sine, without pinning a random sequence.
    expect(relativeRange(streamed)).toBeGreaterThan(relativeRange(history) * 0.25);
    expect(relativeRange(streamed)).toBeLessThan(relativeRange(history) * 4);
    expect(closeSpan(streamed)).toBeGreaterThan(closeSpan(history) * 0.15);
    for (let i = 0; i < streamed.length; i++) {
      const point = streamed[i]!;
      expect(point.time).toBeGreaterThan(history[0]!.time);
      expect(point.low).toBeLessThanOrEqual(Math.min(point.open, point.close));
      expect(point.high).toBeGreaterThanOrEqual(Math.max(point.open, point.close));
      expect(point.volume).toBeGreaterThan(0);
      if (i > 0) {
        expect(streamed[i - 1]!.time - point.time).toBe(scenario.hours * 3_600_000);
        expect(streamed[i - 1]!.open).toBe(point.close);
      }
    }
    await page.clock.runFor(1500);
    expect(await readRows()).toEqual(streamed);
    expect(errors).toEqual([]);
  });
}
