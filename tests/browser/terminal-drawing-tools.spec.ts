import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

async function openEditor(page: Page): Promise<void> {
  if (!(await page.locator('[data-terminal-drawings-panel]').isVisible()))
    await page.locator('[data-terminal-drawings-toggle]').click();
  await expect(page.locator('[data-terminal-drawings-panel]')).toBeVisible();
}

async function addDrawing(page: Page, type: 'text-note' | 'fibonacci-retracement'): Promise<string> {
  return page.evaluate((drawingType) => {
    const terminal = (window as any).terminalTestApi.terminal;
    const bars = terminal.getData();
    const points =
      drawingType === 'text-note'
        ? [{ time: bars.at(-10).time, price: bars.at(-10).close }]
        : [
            { time: bars.at(-10).time, price: bars.at(-10).close },
            { time: bars.at(-3).time, price: bars.at(-3).close },
          ];
    return terminal.getDrawings().add({ type: drawingType, points });
  }, type);
}

async function drawing(page: Page, id: string): Promise<any> {
  return page.evaluate((value) => (window as any).terminalTestApi.terminal.getDrawings().get(value), id);
}

test('terminal toolbar exposes all advanced tools and transient magnet', async ({ page }) => {
  await ready(page);
  for (const tool of ['fibonacci-retracement', 'parallel-channel', 'text-note']) {
    const button = page.locator('[data-terminal-tool="' + tool + '"]');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  const magnet = page.locator('[data-terminal-magnet]');
  await magnet.click();
  await expect(magnet).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-terminal-tool="select"]').click();
  await expect(magnet).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  await expect(magnet).toHaveAttribute('aria-pressed', 'false');
});

test('hidden locked note remains recoverable from selector after workspace restore', async ({ page }) => {
  await ready(page);
  const id = await addDrawing(page, 'text-note');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  await page.locator('[data-terminal-drawing-locked]').check();
  await page.locator('[data-terminal-drawing-visible]').uncheck();
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect.poll(() => drawing(page, id)).toMatchObject({ locked: true, visible: false });
  const workspace = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  await page.evaluate(async (value) => {
    const api = (window as any).terminalTestApi;
    await api.terminal.restoreWorkspace(value);
  }, workspace);
  await openEditor(page);
  await expect(page.locator('[data-terminal-drawing-object] option[value="' + id + '"]')).toHaveCount(1);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  await expect(page.locator('[data-terminal-drawing-visible]')).not.toBeChecked();
  await page.locator('[data-terminal-drawing-visible]').check();
  await page.locator('[data-terminal-drawing-locked]').uncheck();
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect.poll(() => drawing(page, id)).toMatchObject({ locked: false, visible: true });
});

test('invalid note draft survives stream and theme, then undo reconciles an authoritative edit', async ({
  page,
}) => {
  await ready(page);
  const id = await addDrawing(page, 'text-note');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const text = page.locator('[data-terminal-drawing-text]');
  await text.fill('');
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect(page.locator('[data-terminal-drawing-error]')).toContainText('text');
  await text.focus();
  await page.evaluate(() => (window as any).terminalTestApi.appendBars(1));
  await page.evaluate(() => (window as any).terminalTestApi.terminal.applySettings({ theme: 'light' }));
  await expect(text).toHaveValue('');
  await expect(text).toBeFocused();
  await text.fill('Edited note');
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect.poll(() => drawing(page, id)).toMatchObject({ text: 'Edited note' });
  await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().undo());
  await expect(text).toHaveValue('Note');
});

test('Fibonacci rows reject duplicate and empty drafts, retain overrides and inherit cleared color', async ({
  page,
}) => {
  await ready(page);
  const id = await addDrawing(page, 'fibonacci-retracement');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const rows = page.locator('[data-terminal-fibonacci-level]');
  await expect(rows).toHaveCount(7);
  await rows.nth(1).locator('[data-terminal-level-ratio]').fill('0');
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect(page.locator('[data-terminal-drawing-error]')).toContainText('unique');
  await rows.nth(1).locator('[data-terminal-level-ratio]').fill('');
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect(page.locator('[data-terminal-drawing-error]')).toContainText('ratio');
  await rows.nth(1).locator('[data-terminal-level-ratio]').fill('0.236');
  await rows.nth(1).locator('[data-terminal-level-color]').fill('#ff5500');
  await rows.nth(1).locator('[data-terminal-level-width]').fill('3');
  await rows.nth(1).locator('[data-terminal-level-style]').selectOption('dashed');
  await page.locator('[data-terminal-drawing-apply]').click();
  expect((await drawing(page, id)).levels[1]).toEqual({
    ratio: 0.236,
    color: '#ff5500',
    lineWidth: 3,
    lineStyle: 'dashed',
  });
  await page.locator('[data-terminal-drawing-color]').fill('#00aa55');
  await page.locator('[data-terminal-drawing-apply]').click();
  expect((await drawing(page, id)).levels[0].color).toBeUndefined();
  expect((await drawing(page, id)).levels[1].color).toBe('#ff5500');
  await rows.nth(1).locator('[data-terminal-level-color]').fill('');
  await page.locator('[data-terminal-drawing-apply]').click();
  expect((await drawing(page, id)).levels[1].color).toBeUndefined();
  await page.locator('[data-terminal-level-remove]').first().click();
  await page.locator('[data-terminal-level-add]').click();
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect.poll(async () => (await drawing(page, id)).levels.length).toBe(7);
});

test('drawings and editor selection are isolated by market and keyboard text editing stays local', async ({
  page,
}) => {
  await ready(page);
  const id = await addDrawing(page, 'text-note');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const text = page.locator('[data-terminal-drawing-text]');
  await text.fill('Keyboard');
  await text.press('Control+z');
  expect(await drawing(page, id)).not.toBeNull();
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  await expect(page.locator('[data-terminal-drawing-object] option[value="' + id + '"]')).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'BTCUSDT', interval: '1m' }),
  );
  await expect.poll(() => drawing(page, id)).not.toBeNull();
  await expect(page.locator('[data-terminal-drawing-object]')).toHaveValue('');
});

test('invalid numeric draft keeps focus, selection and panel scroll through stream and theme, then external edit reconciles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await ready(page);
  const id = await addDrawing(page, 'text-note');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const width = page.locator('[data-terminal-drawing-width]');
  await width.fill('-');
  await page.locator('[data-terminal-drawing-apply]').click();
  await expect(page.locator('[data-terminal-drawing-error]')).toContainText('Width');
  await width.focus();
  await width.evaluate((element: HTMLInputElement) => element.setSelectionRange(0, 1));
  const beforeScroll = await page
    .locator('[data-terminal-drawings-panel]')
    .evaluate((element: HTMLElement) => {
      element.scrollTop = 80;
      return element.scrollTop;
    });
  expect(beforeScroll).toBeGreaterThan(0);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.appendBars(1);
    api.terminal.applySettings({ theme: 'light' });
  });
  await expect(width).toHaveValue('-');
  await expect(width).toBeFocused();
  expect(
    await width.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]),
  ).toEqual([0, 1]);
  expect(
    await page
      .locator('[data-terminal-drawings-panel]')
      .evaluate((element: HTMLElement) => element.scrollTop),
  ).toBe(beforeScroll);
  expect((await drawing(page, id)).style.lineWidth).toBe(1.5);
  await page.evaluate(
    (value) =>
      (window as any).terminalTestApi.terminal.getDrawings().update(value, { style: { lineWidth: 3 } }),
    id,
  );
  await expect(width).toHaveValue('3');
  await page.evaluate((value) => (window as any).terminalTestApi.terminal.getDrawings().remove(value), id);
  await expect(page.locator('[data-terminal-drawing-fields]')).toBeHidden();
  await expect(page.locator('[data-terminal-drawing-object]')).toHaveValue('');
});

test('terminal magnet snaps a real price-pane click to the indexed OHLC high without full feed reads', async ({
  page,
}) => {
  await ready(page);
  const target = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const chart = api.terminal.chart;
    const bar = api.terminal.getData().at(-10);
    let projection: any;
    const detach = chart.attachPrimitive({
      attach(host: any) {
        projection = host.getProjection();
      },
      draw() {},
    });
    await chart.whenIdle();
    const point = { time: bar.time, price: bar.high };
    const x = projection.timeToX(bar.time);
    const y = projection.priceToY(bar.high, 'price');
    detach();
    api.resetFeedDataReads();
    return { point, x, y };
  });
  expect(target.x).not.toBeNull();
  expect(target.y).not.toBeNull();
  await page.locator('[data-terminal-magnet]').click();
  await page.locator('[data-terminal-tool="horizontal-line"]').click();
  const bounds = await page.locator('[data-terminal-chart]').boundingBox();
  await page.mouse.click(bounds!.x + target.x, bounds!.y + target.y - 5);
  const actual = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return { drawings: api.terminal.getDrawings().list(), dataReads: api.feedDataReads() };
  });
  expect(actual.drawings).toHaveLength(1);
  expect(actual.drawings[0].points[0]).toEqual(target.point);
  expect(actual.dataReads).toBe(0);
});

for (const width of [320, 390, 1280]) {
  for (const theme of ['dark', 'light'] as const) {
    test('drawing editor remains reachable at ' + width + 'px in ' + theme + ' theme', async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await ready(page);
      await page.evaluate(
        (value) => (window as any).terminalTestApi.terminal.applySettings({ theme: value }),
        theme,
      );
      const id = await addDrawing(page, 'text-note');
      await openEditor(page);
      await page.locator('[data-terminal-drawing-object]').selectOption(id);
      await page.locator('[data-terminal-drawing-text]').fill('Responsive note');
      await page.evaluate(() => (window as any).terminalTestApi.appendBars(1));
      await expect(page.locator('[data-terminal-drawing-text]')).toHaveValue('Responsive note');
      const geometry = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('[data-filtix-terminal]')!.getBoundingClientRect();
        const chart = document.querySelector<HTMLElement>('[data-terminal-chart]')!.getBoundingClientRect();
        const panel = document
          .querySelector<HTMLElement>('[data-terminal-drawings-panel]')!
          .getBoundingClientRect();
        return {
          root: { left: root.left, right: root.right },
          chart: { width: chart.width, height: chart.height },
          panel: { left: panel.left, right: panel.right },
        };
      });
      expect(geometry.chart.width).toBeGreaterThan(200);
      expect(geometry.chart.height).toBeGreaterThan(250);
      expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.root.left);
      expect(geometry.panel.right).toBeLessThanOrEqual(geometry.root.right);
      await page.locator('[data-terminal-drawings-close]').click();
      await expect(page.locator('[data-terminal-drawings-panel]')).toBeHidden();
      await page.locator('[data-terminal-tool="text-note"]').click();
      const chartBounds = await page.locator('[data-terminal-chart]').boundingBox();
      await page.mouse.click(
        chartBounds!.x + chartBounds!.width / 2,
        chartBounds!.y + chartBounds!.height / 2,
      );
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().list())).length,
        )
        .toBe(2);
    });
  }
}

test('workspace restore preserves each market drawing but clears transient object selection', async ({
  page,
}) => {
  await ready(page);
  const btc = await addDrawing(page, 'text-note');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(btc);
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  const eth = await addDrawing(page, 'fibonacci-retracement');
  await page.locator('[data-terminal-drawing-object]').selectOption(eth);
  const workspace = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  await page.evaluate((value) => (window as any).terminalTestApi.terminal.restoreWorkspace(value), workspace);
  await expect(page.locator('[data-terminal-drawing-object]')).toHaveValue('');
  await expect(page.locator('[data-terminal-drawing-object] option[value="' + eth + '"]')).toHaveCount(1);
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'BTCUSDT', interval: '1m' }),
  );
  await expect(page.locator('[data-terminal-drawing-object] option[value="' + btc + '"]')).toHaveCount(1);
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().list())).map(
        (item: any) => item.type,
      ),
    )
    .toEqual(['text-note']);
});

test('destroy removes drawing editor controls and remount owns one new editor', async ({ page }) => {
  await ready(page);
  await openEditor(page);
  await page.evaluate(() => (window as any).terminalTestApi.terminal.destroy());
  await expect(page.locator('[data-terminal-drawings-panel]')).toHaveCount(0);
  await expect(page.locator('[data-terminal-drawings-toggle]')).toHaveCount(0);
  await page.evaluate(() => (window as any).terminalTestApi.remount());
  await expect(page.locator('[data-terminal-drawings-toggle]')).toHaveCount(1);
  await expect(page.locator('[data-terminal-drawings-panel]')).toHaveCount(1);
});

test('Fibonacci level rows keep their native input identity when another level is added or removed', async ({
  page,
}) => {
  await ready(page);
  const id = await addDrawing(page, 'fibonacci-retracement');
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const levelKey = await page
    .locator('[data-terminal-fibonacci-level]')
    .nth(1)
    .getAttribute('data-level-key');
  const ratio = page.locator(
    '[data-terminal-fibonacci-level][data-level-key="' + levelKey + '"] [data-terminal-level-ratio]',
  );
  await ratio.focus();
  await ratio.evaluate((element: HTMLInputElement) => {
    element.setSelectionRange(0, 3);
    (window as any).retainedLevelRatio = element;
  });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-terminal-level-add]')!.click());
  await expect(ratio).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        (window as any).retainedLevelRatio === document.querySelectorAll('[data-terminal-level-ratio]')[1],
    ),
  ).toBe(true);
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('[data-terminal-level-remove]')!.click(),
  );
  await expect(ratio).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        (window as any).retainedLevelRatio === document.querySelectorAll('[data-terminal-level-ratio]')[0],
    ),
  ).toBe(true);
  expect(
    await ratio.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]),
  ).toEqual([0, 3]);
});

test('Measure exposes its rendered fill opacity and one Apply creates one undo step', async ({ page }) => {
  await ready(page);
  const id = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const bars = terminal.getData();
    return terminal.getDrawings().add({
      type: 'measure',
      points: [
        { time: bars.at(-10).time, price: bars.at(-10).close },
        { time: bars.at(-3).time, price: bars.at(-3).close },
      ],
    });
  });
  const original = await drawing(page, id);
  await openEditor(page);
  await page.locator('[data-terminal-drawing-object]').selectOption(id);
  const fill = page.locator('[data-terminal-drawing-fill]');
  await expect(fill).toBeVisible();
  await fill.fill('0.4');
  await page.locator('[data-terminal-drawing-apply]').click();
  expect((await drawing(page, id)).style.fillOpacity).toBe(0.4);
  const undo = await page.evaluate((value) => {
    const store = (window as any).terminalTestApi.terminal.getDrawings();
    store.undo();
    return store.get(value);
  }, id);
  expect(undo).toEqual(original);
  await page.evaluate(() => (window as any).terminalTestApi.terminal.getDrawings().undo());
  expect(await drawing(page, id)).toBeNull();
});
