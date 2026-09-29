import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-grid-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalGridHarness));
}

async function mount(page: Page, width = 1000, height = 440): Promise<void> {
  await page.evaluate(({ width, height }) => (window as any).terminalGridHarness.uiMount(width, height), {
    width,
    height,
  });
  await expect(page.locator('[data-grid-ui-host] [data-filtix-grid-cell]')).toHaveCount(4);
}

async function state(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).terminalGridHarness.uiState());
}

test('host width chooses columns inside narrow and wide windows while cells and toolbar remain bounded', async ({
  page,
}) => {
  await ready(page);
  for (const windowWidth of [390, 1440]) {
    await page.setViewportSize({ width: windowWidth, height: 900 });
    await mount(page, 320);
    for (const width of [320, 390, 799, 800, 1200]) {
      await page.evaluate((value) => (window as any).terminalGridHarness.uiWidth(value), width);
      const region = page.locator('.filtix-terminal-grid-region');
      await expect(region).toHaveAttribute('data-columns', width >= 800 ? '2' : '1');
      const measured = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-grid-ui-host]')!;
        const shell = host.querySelector<HTMLElement>('.filtix-terminal-grid')!;
        const toolbar = host.querySelector<HTMLElement>('.filtix-terminal-grid-toolbar')!;
        const grid = host.querySelector<HTMLElement>('.filtix-terminal-grid-region')!;
        const cells = [...host.querySelectorAll<HTMLElement>('.filtix-terminal-grid-cell')];
        const hostRect = host.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        grid.scrollTop = grid.scrollHeight;
        return {
          hostWidth: hostRect.width,
          shellWidth: shellRect.width,
          toolbarRight: toolbarRect.right,
          gridTop: gridRect.top,
          toolbarBottom: toolbarRect.bottom,
          cellHeights: cells.map((cell) => cell.getBoundingClientRect().height),
          scrollHeight: grid.scrollHeight,
          clientHeight: grid.clientHeight,
          scrollTop: grid.scrollTop,
          pageWidth: document.documentElement.scrollWidth,
          windowWidth: innerWidth,
        };
      });
      expect(measured.hostWidth).toBeCloseTo(width, 0);
      expect(measured.shellWidth).toBeLessThanOrEqual(measured.hostWidth + 1);
      expect(measured.toolbarRight).toBeLessThanOrEqual(width + 1);
      expect(measured.gridTop).toBeGreaterThanOrEqual(measured.toolbarBottom - 1);
      expect(measured.cellHeights).toHaveLength(4);
      expect(measured.cellHeights.every((height: number) => height >= 359.5)).toBe(true);
      expect(measured.scrollHeight).toBeGreaterThan(measured.clientHeight);
      expect(measured.scrollTop).toBeGreaterThan(0);
      expect(measured.pageWidth).toBeLessThanOrEqual(measured.windowWidth + 1);
    }
    const cleanup = await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
    expect(cleanup).toMatchObject({ hostObservers: 0, children: 0 });
    expect(cleanup.provider.active).toBe(0);
  }
});

test('native layout and sync controls reflect canonical state without remounting retained charts', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const toolbar = page.locator('.filtix-terminal-grid-toolbar');
  const one = toolbar.locator('[data-grid-layout="1"]');
  const two = toolbar.locator('[data-grid-layout="2"]');
  const four = toolbar.locator('[data-grid-layout="4"]');
  await expect(one).toHaveAccessibleName(/1/);
  await expect(two).toHaveAccessibleName(/2/);
  await expect(four).toHaveAccessibleName(/4/);
  await expect(four).toHaveAttribute('aria-pressed', 'true');
  await two.click();
  await expect.poll(async () => (await state(page)).layout).toBe(2);
  await expect(two).toHaveAttribute('aria-pressed', 'true');
  await four.click();
  await expect.poll(async () => (await state(page)).layout).toBe(4);
  await toolbar.locator('[data-grid-viewport]').check();
  await toolbar.locator('[data-grid-crosshair]').check();
  await toolbar.locator('[data-grid-crosshair-match]').selectOption('nearest');
  expect((await state(page)).sync).toEqual({
    viewport: true,
    crosshair: true,
    crosshairMatch: 'nearest',
  });
  expect(await page.evaluate(() => (window as any).terminalGridHarness.uiRetained())).toEqual({
    terminal: true,
    node: true,
  });
  // Begin the keyboard sequence from explicit focus. A pointer click changes
  // Linux WebKit's native sequential-focus starting point, even for plain HTML buttons.
  await four.focus();
  await expect(four).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(two).toBeFocused();
  const outline = await two.evaluate((button) => {
    const style = getComputedStyle(button);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  const cleanup = await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
  expect(cleanup.hostObservers).toBe(0);
});

test('pointer and focus select a cell without stealing editor focus or crossing cell bounds', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const first = page.locator('[data-filtix-grid-cell="cell-1"]');
  const second = page.locator('[data-filtix-grid-cell="cell-2"]');
  for (const cell of [first, second]) {
    await expect(cell.locator('[data-terminal-symbol]')).toHaveCount(1);
    await expect(cell.locator('[data-terminal-interval]')).toHaveCount(1);
    await expect(cell.locator('[data-terminal-studies-toggle]')).toHaveCount(1);
    await expect(cell.locator('[data-terminal-drawings-toggle]')).toHaveCount(1);
    await expect(cell.locator('[data-terminal-alerts-toggle]')).toHaveCount(1);
  }
  await second.locator('[data-terminal-alerts-toggle]').click();
  const price = second.locator('[data-terminal-alert-price]');
  await price.fill('123');
  await expect(price).toBeFocused();
  await expect.poll(async () => (await state(page)).activeCellId).toBe('cell-2');
  const bounds = await page.evaluate(() => {
    const cell1 = document.querySelector<HTMLElement>('[data-filtix-grid-cell="cell-1"]')!;
    const cell2 = document.querySelector<HTMLElement>('[data-filtix-grid-cell="cell-2"]')!;
    const panel = cell2.querySelector<HTMLElement>('[data-terminal-alerts-panel]')!;
    const a = cell1.getBoundingClientRect();
    const b = cell2.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      firstRight: a.right,
      secondLeft: b.left,
      secondRight: b.right,
      panelLeft: p.left,
      panelRight: p.right,
    };
  });
  expect(bounds.panelLeft).toBeGreaterThanOrEqual(bounds.secondLeft - 1);
  expect(bounds.panelRight).toBeLessThanOrEqual(bounds.secondRight + 1);
  expect(bounds.panelLeft).toBeGreaterThanOrEqual(bounds.firstRight - 1);
  await first.locator('[data-terminal-symbol]').click();
  await expect(first.locator('[data-terminal-symbol]')).toBeFocused();
  await expect.poll(async () => (await state(page)).activeCellId).toBe('cell-1');
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('layout adoption retains a surviving field focus and moves hidden editor focus to the visible layout control', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const firstSymbol = page.locator('[data-filtix-grid-cell="cell-1"] [data-terminal-symbol]');
  await firstSymbol.focus();
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(2));
  await expect(firstSymbol).toBeFocused();
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(4));
  const fourth = page.locator('[data-filtix-grid-cell="cell-4"]');
  await fourth.locator('[data-terminal-alerts-toggle]').click();
  const price = fourth.locator('[data-terminal-alert-price]');
  await price.fill('123');
  await expect(price).toBeFocused();
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(1));
  await expect(page.locator('[data-grid-layout="1"]')).toBeFocused();
  expect((await state(page)).activeCellId).toBe('cell-1');
  await expect(fourth).toHaveCount(0);
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(4));
  const outside = page.locator('[data-grid-outside-focus]');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.dataset.gridOutsideFocus = '';
    button.textContent = 'Outside grid';
    document.body.append(button);
  });
  await outside.focus();
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(1));
  await expect(outside).toBeFocused();
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('a superseded adoption does not repair focus before its requested successor layout settles', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.uiSupersededFocusRepair());
  expect(result.initialFocused).toBe(true);
  expect(result.phaseTriggeredAt).toBe(1);
  expect(result.first).toMatch(/superseded/i);
  expect(result.staleFocusEvents).toBe(0);
  expect(result.intervention).toBeNull();
  expect(result.successor).toBe('ok');
  expect(result.finalLayout).toBe(1);
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('a successor queued by the post-activation state callback prevents stale focus repair', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const result = await page.evaluate(() =>
    (window as any).terminalGridHarness.uiSupersededFocusRepair('second'),
  );
  expect(result.initialFocused).toBe(true);
  expect(result.phaseTriggeredAt).toBe(2);
  expect(result.layoutFourNotifications).toBeGreaterThanOrEqual(2);
  expect(result.first).toMatch(/superseded/i);
  expect(result.staleFocusEvents).toBe(0);
  expect(result.intervention).toBeNull();
  expect(result.successor).toBe('ok');
  expect(result.finalLayout).toBe(1);
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('a host focus redirect during retained-cell repair selects the cell that actually receives focus', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const result = await page.evaluate(() =>
    (window as any).terminalGridHarness.uiRedirectedFocusDuringRepair(),
  );
  expect(result.redirects).toBe(1);
  expect(result.secondFocused).toBe(true);
  expect(result.layout).toBe(2);
  expect(result.layoutResult).toMatch(/ok|superseded/i);
  expect(result.activeCellId).toBe('cell-2');
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('four distinct workspaces park and return; hidden active cell falls back and invalid restore is atomic', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 1000, 820);
  const seeded = await page.evaluate(() => (window as any).terminalGridHarness.uiSeedDistinct());
  expect(seeded.cells.map((cell: any) => cell.workspace.query)).toEqual([
    { symbol: 'BTCUSDT', interval: '1m' },
    { symbol: 'ETHUSDT', interval: '5m' },
    { symbol: 'SOLUSDT', interval: '1h' },
    { symbol: 'ADAUSDT', interval: '1d' },
  ]);
  expect(seeded.cells[0].workspace.settings.theme).toBe('light');
  expect(seeded.cells[1].workspace.settings.theme).toBe('dark');
  expect(seeded.cells[1].workspace.layout.studiesOpen).toBe(true);
  expect(seeded.cells[2].workspace.studies.some((study: any) => study.kind === 'rsi')).toBe(true);
  expect(seeded.cells[2].workspace.layout.panes.some((pane: any) => pane.weight === 0.65)).toBe(true);
  expect(seeded.cells[3].workspace.markets.some((market: any) => market.drawings.drawings.length === 1)).toBe(
    true,
  );
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetActive('cell-4'));
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(1));
  expect((await state(page)).activeCellId).toBe('cell-1');
  await expect(page.locator('[data-grid-layout="1"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).terminalGridHarness.uiSetLayout(4));
  expect(await page.evaluate(() => (window as any).terminalGridHarness.uiWorkspace())).toEqual({
    ...seeded,
    activeCellId: 'cell-1',
  });
  const beforeInvalid = await page.evaluate(() => (window as any).terminalGridHarness.uiWorkspace());
  const failure = await page.evaluate(async () => {
    try {
      await (window as any).terminalGridHarness.uiRestore({});
      return null;
    } catch (error) {
      return String(error);
    }
  });
  expect(failure).toMatch(/grid|workspace|schema/i);
  expect(await page.evaluate(() => (window as any).terminalGridHarness.uiWorkspace())).toEqual(beforeInvalid);
  expect(await page.evaluate(() => (window as any).terminalGridHarness.uiRetained())).toEqual({
    terminal: true,
    node: true,
  });
  await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
});

test('twenty zero-size recovery cycles keep observer and rendering work finite and release the grid observer', async ({
  page,
}) => {
  await ready(page);
  await mount(page, 800, 440);
  await expect(page.locator('.filtix-terminal-grid-region')).toHaveAttribute('data-columns', '2');
  expect((await page.evaluate(() => (window as any).terminalGridHarness.uiStats())).hostObservers).toBe(1);
  for (let cycle = 0; cycle < 20; cycle++) {
    await page.evaluate(() => (window as any).terminalGridHarness.uiWidth(0, 0));
    await page.waitForTimeout(20);
    await page.evaluate(() => (window as any).terminalGridHarness.uiWidth(800, 440));
    await expect(page.locator('.filtix-terminal-grid-region')).toHaveAttribute('data-columns', '2');
  }
  const stats = await page.evaluate(() => (window as any).terminalGridHarness.uiStats());
  expect(stats.hostObservers).toBe(1);
  expect(stats.hostCallbacks).toBeGreaterThan(0);
  expect(stats.hostCallbacks).toBeLessThan(200);
  expect(stats.frames).toBeLessThan(2000);
  await expect(page.locator('[data-grid-layout="4"]')).toHaveAttribute('aria-pressed', 'true');
  const cleanup = await page.evaluate(() => (window as any).terminalGridHarness.uiDestroy());
  expect(cleanup).toMatchObject({ hostObservers: 0, children: 0 });
  expect(cleanup.provider.active).toBe(0);
  await expect(page.locator('.filtix-terminal-grid-toolbar')).toHaveCount(0);
});

test('a post-adoption grid observer failure leaves no mounted UI or provider subscription', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.uiConstructionFailure());
  expect(result.failure).toMatch(/injected grid host observer failure/);
  expect(result.hostObservers).toBe(0);
  expect(result.children).toBe(0);
  expect(result.provider.active).toBe(0);
  await expect(page.locator('[data-grid-ui-frame]')).toHaveCount(0);
});
