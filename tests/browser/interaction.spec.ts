import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(() => window.testApi.chart.whenIdle());
});

test('two touch pointers zoom around their midpoint and cancellation restores ordinary dragging', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const chart = window.testApi.chart;
    chart.setVisibleRange({ from: 100, to: 400 });
    await chart.whenIdle();
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!,
      rect = root.getBoundingClientRect();
    const dispatch = (type: string, id: number, x: number, pointerType = 'touch') =>
      root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType,
          button: 0,
          buttons: 1,
          clientX: rect.left + x,
          clientY: rect.top + 160,
        }),
      );
    const before = chart.getVisibleRange(),
      anchor = chart.coordinateToTime(500);
    dispatch('pointerdown', 1, 300);
    dispatch('pointerdown', 2, 700);
    dispatch('pointermove', 1, 250);
    dispatch('pointermove', 2, 750);
    await chart.whenIdle();
    const zoom = chart.getVisibleRange(),
      afterAnchor = chart.coordinateToTime(500);
    dispatch('pointercancel', 1, 250);
    dispatch('pointercancel', 2, 750);
    dispatch('pointerdown', 3, 500, 'mouse');
    dispatch('pointermove', 3, 600, 'mouse');
    dispatch('pointerup', 3, 600, 'mouse');
    await chart.whenIdle();
    return { before, zoom, anchor, afterAnchor, pan: chart.getVisibleRange() };
  });
  expect(result.zoom.to - result.zoom.from).toBeLessThan(result.before.to - result.before.from);
  expect(result.afterAnchor).toBe(result.anchor);
  expect(result.pan.from).not.toBe(result.zoom.from);
});

test('dragging a pane divider changes vertical geometry while preserving the shared time range', async ({
  page,
}) => {
  const before = await page.evaluate(async () => {
    const { chart, data } = window.testApi;
    const pane = chart.addPane({ id: 'secondary', weight: 1 });
    chart.addSeries('line', { paneId: pane.id }).setData(data.map((p) => ({ time: p.time, value: p.close })));
    await chart.whenIdle();
    let bottom = 0;
    for (let y = 0; y < 600; y++) if (chart.coordinateToPrice(y, 'price') !== null) bottom = y;
    return { bottom, range: chart.getVisibleRange() };
  });
  await page.mouse.move(450, before.bottom + 2.5);
  await page.mouse.down();
  await page.mouse.move(450, before.bottom + 62.5, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(async () => {
    const { chart } = window.testApi;
    await chart.whenIdle();
    let bottom = 0;
    for (let y = 0; y < 600; y++) if (chart.coordinateToPrice(y, 'price') !== null) bottom = y;
    return { bottom, range: chart.getVisibleRange() };
  });
  expect(after.bottom).toBeGreaterThan(before.bottom + 40);
  expect(after.range).toEqual(before.range);
});
