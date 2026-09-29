import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

async function mixed(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as any).terminalTestApi.remountWithStudies([
      { kind: 'macd', fastPeriod: 3, slowPeriod: 6, signalPeriod: 2 },
      { kind: 'rsi', period: 3 },
      { kind: 'macd', fastPeriod: 4, slowPeriod: 7, signalPeriod: 2 },
      { kind: 'bollinger', period: 3, multiplier: 2 },
      { kind: 'bollinger', period: 4, multiplier: 2 },
      { kind: 'sma', period: 3 },
      { kind: 'ema', period: 4 },
      { kind: 'sma', period: 5 },
    ]),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

async function geometry(page: Page) {
  return page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const terminal = api.terminal;
    await terminal.chart.whenIdle();
    const root = document.querySelector<HTMLElement>('[data-filtix-terminal]')!;
    const toolbar = root.querySelector<HTMLElement>('[data-terminal-toolbar]')!;
    const body = root.querySelector<HTMLElement>('[data-terminal-body]') ?? root;
    const chart = root.querySelector<HTMLElement>('[data-terminal-chart]')!;
    const editor = root.querySelector<HTMLElement>('[data-terminal-studies-panel]')!;
    const footer = root.querySelector<HTMLElement>('[data-terminal-footer]')!;
    const r = root.getBoundingClientRect(),
      b = body.getBoundingClientRect(),
      c = chart.getBoundingClientRect(),
      e = editor.getBoundingClientRect();
    let projected: { panes: readonly { id: string; top: number; bottom: number }[] } | null = null;
    const detach = terminal.chart.attachPrimitive({
      draw() {},
      attach(host: { getProjection(): typeof projected }) {
        projected = host.getProjection();
      },
    });
    const price = projected!.panes.find((pane) => pane.id === 'price');
    detach();
    const top = c.top + (price?.top ?? 0);
    const bottom = c.top + (price?.bottom ?? 0);
    const unoccludedBottom =
      !editor.hidden && e.left < c.right && e.right > c.left ? Math.min(bottom, e.top) : bottom;
    return {
      root: {
        width: r.width,
        height: r.height,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
      },
      toolbar: toolbar.getBoundingClientRect().height,
      footer: footer.getBoundingClientRect().height,
      body: { width: b.width, height: b.height },
      chart: { width: c.width, height: c.height },
      price: Math.max(0, Math.min(unoccludedBottom, r.bottom, b.bottom) - Math.max(top, r.top, b.top)),
    };
  });
}

test('320x360 mixed editor keeps at least 96 CSS px of actual unoccluded price', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await ready(page);
  await mixed(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().studiesOpen))
    .toBe(true);
  const value = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  expect(value.version).toBe(5);
  expect(value.layout.maximizedPaneId).toBeNull();
  const focusBounds = await page.locator('[data-terminal-studies-focus-status]').evaluate((node) => {
    const heading = node.closest('[data-terminal-studies-head]')!.getBoundingClientRect();
    const text = node.getBoundingClientRect();
    return {
      within: text.left >= heading.left && text.right <= heading.right,
      oneLine: text.height <= parseFloat(getComputedStyle(node).lineHeight) + 1,
      unclipped: node.scrollWidth <= node.clientWidth + 1,
    };
  });
  expect(focusBounds).toEqual({ within: true, oneLine: true, unclipped: true });
  const g = await geometry(page);
  expect(g.price).toBeGreaterThanOrEqual(96);
  expect(g.root.scrollWidth).toBeLessThanOrEqual(g.root.width + 1);
  expect(g.toolbar).toBeLessThanOrEqual(g.root.height * 0.25 + 1);
  expect(g.footer).toBeLessThanOrEqual(g.root.height * 0.15 + 1);
});

test('resize target, view, grow, maximize, restore and reset are native coherent controls', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.terminal.addStudy({ kind: 'rsi', period: 3 }));
  const select = page.locator('[data-terminal-pane-select]');
  const view = page.locator('[data-terminal-layout-view]');
  await expect(select).toHaveCount(1);
  await expect(view).toHaveCount(1);
  await expect(page.getByText('Resize pane', { exact: true })).toHaveCount(1);
  await expect(page.getByText('View', { exact: true })).toHaveCount(1);
  await select.selectOption('terminal-study-1-pane');
  const before = await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout());
  await page.locator('[data-terminal-pane-grow]').click();
  const grown = await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout());
  expect(grown.panes.find((pane: any) => pane.id === 'terminal-study-1-pane').weight).not.toBe(
    before.panes.find((pane: any) => pane.id === 'terminal-study-1-pane').weight,
  );
  await page.locator('[data-terminal-pane-maximize]').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId))
    .toBe('terminal-study-1-pane');
  await page.locator('[data-terminal-pane-restore]').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId))
    .toBeNull();
  await view.selectOption('terminal-study-1-pane');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId))
    .toBe('terminal-study-1-pane');
  await page.locator('[data-terminal-layout-reset]').click();
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId),
  ).toBeNull();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#terminal-host')!.style.height = '100px';
  });
  await expect(page.locator('[data-terminal-pane-grow]')).toBeDisabled();
  await expect(page.locator('[data-terminal-pane-shrink]')).toBeDisabled();
});

test('short and zero hosts stay contained and recover with editor draft', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  await ready(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  const field = page.locator('[data-terminal-study-add-period]');
  await field.fill('37');
  await page.evaluate(() => {
    (window as any).terminalTestApi.appendBars(1);
  });
  expect(await field.inputValue()).toBe('37');
  expect(await field.evaluate((node) => node === document.activeElement)).toBe(true);
  const focusBounds = await page.locator('[data-terminal-studies-focus-status]').evaluate((node) => {
    const heading = node.closest('[data-terminal-studies-head]')!.getBoundingClientRect();
    const text = node.getBoundingClientRect();
    return {
      within: text.left >= heading.left && text.right <= heading.right,
      oneLine: text.height <= parseFloat(getComputedStyle(node).lineHeight) + 1,
      unclipped: node.scrollWidth <= node.clientWidth + 1,
    };
  });
  expect(focusBounds).toEqual({ within: true, oneLine: true, unclipped: true });
  let g = await geometry(page);
  expect(g.root.scrollHeight).toBeLessThanOrEqual(g.root.height + 1);
  expect(g.root.scrollWidth).toBeLessThanOrEqual(g.root.width + 1);
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '0px';
    host.style.height = '0px';
  });
  await page.waitForTimeout(100);
  g = await geometry(page);
  expect(g.root.width).toBe(0);
  expect(g.root.height).toBe(0);
  expect(Number.isFinite(g.price)).toBe(true);
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '390px';
    host.style.height = '844px';
  });
  await expect.poll(async () => (await geometry(page)).root.height).toBe(844);
  expect((await geometry(page)).chart.height).toBeGreaterThan(0);
  expect(await field.inputValue()).toBe('37');
});

test('both themes and supported host matrix keep editor contained and price visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await mixed(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  const cases = [
    { width: 1280, height: 720, mode: 'rail', minPrice: 96 },
    { width: 900, height: 500, mode: 'rail', minPrice: 96 },
    { width: 390, height: 844, mode: 'bottom', minPrice: 96 },
    { width: 320, height: 568, mode: 'bottom', minPrice: 96 },
    { width: 320, height: 360, mode: 'overlay', minPrice: 96 },
    { width: 800, height: 240, mode: 'overlay', minPrice: 0 },
    { width: 320, height: 240, mode: 'overlay', minPrice: 0 },
  ];
  for (const theme of ['dark', 'light']) {
    await page.locator('[data-terminal-theme]').selectOption(theme);
    for (const item of cases) {
      await page.evaluate(({ width, height }) => {
        const host = document.querySelector<HTMLElement>('#terminal-host')!;
        host.style.width = width + 'px';
        host.style.height = height + 'px';
      }, item);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.editorMode,
          ),
        )
        .toBe(item.mode);
      await expect
        .poll(async () => (await geometry(page)).toolbar)
        .toBeLessThanOrEqual(item.height * 0.25 + 1);
      const g = await geometry(page);
      expect(g.root.width).toBe(item.width);
      expect(g.root.height).toBe(item.height);
      expect(g.root.scrollWidth).toBeLessThanOrEqual(item.width + 1);
      expect(g.root.scrollHeight).toBeLessThanOrEqual(item.height + 1);
      expect(g.toolbar).toBeLessThanOrEqual(item.height * 0.25 + 1);
      expect(g.footer).toBeLessThanOrEqual(item.height * 0.15 + 1);
      expect(Number.isFinite(g.price)).toBe(true);
      expect(g.price).toBeGreaterThanOrEqual(item.minPrice);
      expect(g.chart.height).toBeGreaterThan(0);
      expect(
        await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId),
      ).toBeNull();
    }
  }
});

test('temporary focus is derived; resize and close restore canonical view', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await ready(page);
  await mixed(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.terminalEditingFocus,
      ),
    )
    .toBe('price');
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getPaneLayout().maximizedPaneId),
  ).toBe('price');
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace().layout.maximizedPaneId),
  ).toBeNull();
  await expect(page.locator('[data-terminal-layout-view] option[value=""]')).toHaveText(
    'Price focus while editing (all panes saved)',
  );
  await expect(page.locator('[data-terminal-studies-focus-status]')).toBeVisible();
  await expect(page.locator('[data-terminal-studies-focus-status]')).toHaveText(
    'Price focused while editing',
  );
  await expect(page.locator('[data-terminal-pane-restore]')).toHaveText('Close editor and restore panes');
  await page.locator('[data-terminal-pane-restore]').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().studiesOpen))
    .toBe(false);
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.getPaneLayout().maximizedPaneId),
  ).toBeNull();
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '1280px';
    host.style.height = '720px';
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.editorMode),
    )
    .toBe('rail');
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId),
  ).toBeNull();
  await page.locator('[data-terminal-pane-select]').selectOption('terminal-study-1-pane');
  await page.locator('[data-terminal-pane-maximize]').click();
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId),
  ).toBe('terminal-study-1-pane');
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.terminalEditingFocus,
    ),
  ).toBeUndefined();
  await page.locator('[data-terminal-layout-reset]').click();
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().studiesOpen)).toBe(
    false,
  );
});

test('editor keeps keyed draft, focus and scroll through streaming and breakpoint change', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await mixed(page);
  const toggle = page.locator('[data-terminal-studies-toggle]');
  await toggle.click();
  await expect(page.locator('[data-terminal-studies-heading]')).toBeFocused();
  const field = page.locator('[data-terminal-study-row="study-1"] [data-terminal-study-fast-period]');
  await field.fill('41');
  await field.evaluate((node: HTMLInputElement) => {
    (window as any).savedEditorField = node;
  });
  const scrollBefore = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-terminal-studies-panel]')!;
    panel.scrollTop = 80;
    return panel.scrollTop;
  });
  expect(scrollBefore).toBeGreaterThan(0);
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '1280px';
    host.style.height = '720px';
    (window as any).terminalTestApi.appendBars(1);
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.editorMode),
    )
    .toBe('rail');
  const scrollAfter = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-terminal-studies-panel]')!;
    return { top: panel.scrollTop, max: Math.max(0, panel.scrollHeight - panel.clientHeight) };
  });
  expect(scrollAfter.top).toBeCloseTo(Math.min(scrollBefore, scrollAfter.max), 0);
  expect(await field.inputValue()).toBe('41');
  expect(
    await field.evaluate(
      (node: HTMLInputElement) =>
        node === document.activeElement && node === (window as any).savedEditorField,
    ),
  ).toBe(true);
  await field.press('Escape');
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().studiesOpen)).toBe(
    false,
  );
  await toggle.click();
  await field.focus();
  await page.evaluate(() => (window as any).terminalTestApi.terminal.removeStudy('study-1'));
  expect(
    await page.evaluate(() =>
      document.activeElement?.matches(
        '[data-terminal-study-row] input,[data-terminal-study-row] select,[data-terminal-study-add]',
      ),
    ),
  ).toBe(true);
});

test('quiet feed pane selection refreshes resize boundaries immediately', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).terminalTestApi.terminal.addStudy({ kind: 'rsi', period: 3 }));
  const target = page.locator('[data-terminal-pane-select]');
  const shrink = page.locator('[data-terminal-pane-shrink]');
  const oscillator = 'terminal-study-1-pane';
  await page.evaluate(() => {
    (window as any).terminalTestApi.terminal.chart.resizePane('price', -Number.MAX_VALUE);
  });
  await target.selectOption('price');
  await expect(shrink).toBeDisabled();
  const quietBefore = await page.evaluate(() => (window as any).terminalTestApi.observedStates.length);
  await target.selectOption(oscillator);
  await expect(shrink).toBeEnabled();
  await target.selectOption('price');
  await expect(shrink).toBeDisabled();
  expect(await page.evaluate(() => (window as any).terminalTestApi.observedStates.length)).toBe(quietBefore);

  await page.evaluate((id) => {
    const terminal = (window as any).terminalTestApi.terminal;
    terminal.applyLayout({
      panes: [
        { id: 'price', weight: 2 },
        { id: 'terminal-volume-pane', weight: Number.MIN_VALUE },
        { id, weight: Number.MIN_VALUE },
      ],
      maximizedPaneId: null,
    });
  }, oscillator);
  const attainable = await page.evaluate((id) => {
    const chart = (window as any).terminalTestApi.terminal.chart;
    return { oscillator: chart.canResizePane(id, -8), price: chart.canResizePane('price', -8) };
  }, oscillator);
  expect(attainable).toEqual({ oscillator: false, price: true });
  await target.selectOption(oscillator);
  await expect(shrink).toBeDisabled();
  const inverseQuietBefore = await page.evaluate(() => (window as any).terminalTestApi.observedStates.length);
  await target.selectOption('price');
  await expect(shrink).toBeEnabled();
  await target.selectOption(oscillator);
  await expect(shrink).toBeDisabled();
  expect(await page.evaluate(() => (window as any).terminalTestApi.observedStates.length)).toBe(
    inverseQuietBefore,
  );
});

test('automatic price focus yields to a reentrant close from a chart observer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await mixed(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '1280px';
    host.style.height = '720px';
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.editorMode),
    )
    .toBe('rail');
  await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    let nestedCloses = 0;
    const unsubscribe = terminal.chart.subscribePaneLayoutChange((snapshot: any) => {
      if (snapshot.maximizedPaneId !== 'price' || nestedCloses > 0) return;
      nestedCloses++;
      unsubscribe();
      terminal.applyLayout({ studiesOpen: false });
    });
    (window as any).nestedPresentationCloses = () => nestedCloses;
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '320px';
    host.style.height = '360px';
  });
  await expect.poll(() => page.evaluate(() => (window as any).nestedPresentationCloses())).toBe(1);
  const settled = await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    const root = document.querySelector<HTMLElement>('[data-filtix-terminal]')!;
    return {
      canonicalOpen: terminal.getLayout().studiesOpen,
      canonicalMax: terminal.getLayout().maximizedPaneId,
      effectiveMax: terminal.chart.getPaneLayout().maximizedPaneId,
      editingFocus: root.dataset.terminalEditingFocus ?? null,
      viewLabel: root.querySelector<HTMLOptionElement>('[data-terminal-layout-view] option[value=""]')!
        .textContent,
      status: root.querySelector<HTMLElement>('[data-terminal-layout-status]')!.textContent,
      restoreDisabled: root.querySelector<HTMLButtonElement>('[data-terminal-pane-restore]')!.disabled,
    };
  });
  expect(settled).toEqual({
    canonicalOpen: false,
    canonicalMax: null,
    effectiveMax: null,
    editingFocus: null,
    viewLabel: 'All panes',
    status: '',
    restoreDisabled: true,
  });
});

test('price native resize uses caller adjacency without persisting the caller pane', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const settledBeforeCaller = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.terminal.applySettings({ volume: false });
    return { stateEvents: api.observedStates.length, historyRequests: api.historyRequests() };
  });
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.chart.addPane({
      id: 'caller',
      weight: 1,
      minHeight: 48,
    }),
  );
  expect(
    await page.evaluate(() => {
      const api = (window as any).terminalTestApi;
      return { stateEvents: api.observedStates.length, historyRequests: api.historyRequests() };
    }),
  ).toEqual(settledBeforeCaller);
  const target = page.locator('[data-terminal-pane-select]');
  const grow = page.locator('[data-terminal-pane-grow]');
  const shrink = page.locator('[data-terminal-pane-shrink]');
  await expect(target.locator('option')).toHaveCount(1);
  await expect(target.locator('option')).toHaveText('Price');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.chart.canResizePane('price', 8)))
    .toBe(true);
  await expect(grow).toBeEnabled();
  await expect(shrink).toBeEnabled();

  const before = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return {
      effective: api.terminal.chart.getPaneLayout(),
      workspace: api.terminal.getWorkspace(),
      stateEvents: api.observedStates.length,
      historyRequests: api.historyRequests(),
    };
  });
  await grow.click();
  const after = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    return {
      effective: api.terminal.chart.getPaneLayout(),
      workspace: api.terminal.getWorkspace(),
      stateEvents: api.observedStates.length,
      historyRequests: api.historyRequests(),
    };
  });
  expect(after.effective.panes.map((pane: any) => pane.id)).toEqual(['price', 'caller']);
  expect(after.effective.panes[0].weight).not.toBe(before.effective.panes[0].weight);
  expect(after.effective.panes[1].weight).not.toBe(before.effective.panes[1].weight);
  expect(after.workspace.layout.panes.some((pane: any) => pane.id === 'caller')).toBe(false);
  expect(after.workspace.layout.panes.find((pane: any) => pane.id === 'price').weight).toBe(
    after.effective.panes[0].weight,
  );
  expect(after.stateEvents).toBe(before.stateEvents + 1);
  expect(after.historyRequests).toBe(before.historyRequests);

  await page.evaluate(() => (window as any).terminalTestApi.terminal.chart.removePane('caller'));
  await expect(target.locator('option')).toHaveText('Price');
  await expect(grow).toBeDisabled();
  await expect(shrink).toBeDisabled();
  expect(
    await page.evaluate(() => {
      const api = (window as any).terminalTestApi;
      return { stateEvents: api.observedStates.length, historyRequests: api.historyRequests() };
    }),
  ).toEqual({ stateEvents: after.stateEvents, historyRequests: after.historyRequests });
});

test('native resize disabled states follow shared attainable limits at extreme weights', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const grow = page.locator('[data-terminal-pane-grow]');
  const shrink = page.locator('[data-terminal-pane-shrink]');
  for (const weight of [Number.MIN_VALUE, Number.MAX_VALUE]) {
    const probe = await page.evaluate((value) => {
      const api = (window as any).terminalTestApi;
      const terminal = api.terminal;
      terminal.applyLayout({
        panes: [
          { id: 'price', weight: value },
          { id: 'terminal-volume-pane', weight: value },
        ],
        maximizedPaneId: null,
      });
      const before = {
        effective: terminal.chart.getPaneLayout(),
        workspace: terminal.getWorkspace(),
        stateEvents: api.observedStates.length,
        historyRequests: api.historyRequests(),
      };
      const attainable = {
        grow: terminal.chart.canResizePane('price', 8),
        shrink: terminal.chart.canResizePane('price', -8),
      };
      const after = {
        effective: terminal.chart.getPaneLayout(),
        workspace: terminal.getWorkspace(),
        stateEvents: api.observedStates.length,
        historyRequests: api.historyRequests(),
      };
      return { before, attainable, after };
    }, weight);
    expect(probe.before.effective.panes[0].weight).toBe(weight);
    expect(probe.before.effective.panes[1].weight).toBe(weight);
    expect(probe.attainable).toEqual({ grow: false, shrink: false });
    expect(probe.after).toEqual(probe.before);
    await expect(grow).toBeDisabled();
    await expect(shrink).toBeDisabled();
  }
});

test('native resize availability follows settled chart size without a terminal action', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const grow = page.locator('[data-terminal-pane-grow]');
  const shrink = page.locator('[data-terminal-pane-shrink]');
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.chart.canResizePane('price', 8)))
    .toBe(true);
  await expect(grow).toBeEnabled();
  await expect(shrink).toBeEnabled();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#terminal-host')!.style.height = '100px';
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.chart.canResizePane('price', 8)))
    .toBe(false);
  await expect(grow).toBeDisabled();
  await expect(shrink).toBeDisabled();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#terminal-host')!.style.height = '900px';
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.chart.canResizePane('price', 8)))
    .toBe(true);
  await expect(grow).toBeEnabled();
  await expect(shrink).toBeEnabled();
});

test('native pane option nodes retain identity, selection and focus through unchanged refreshes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const paneId = await page.evaluate(() => {
    const id = (window as any).terminalTestApi.terminal.addStudy({ kind: 'rsi', period: 3 });
    return 'terminal-' + id + '-pane';
  });
  const target = page.locator('[data-terminal-pane-select]');
  await target.selectOption(paneId);
  await target.focus();
  await page.evaluate(() => {
    const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
    const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
    (window as any).savedNativeOptions = {
      resize,
      view,
      resizeOptions: [...resize.options],
      viewOptions: [...view.options],
      resizeTexts: [...resize.options].map((option) => option.firstChild),
      viewTexts: [...view.options].map((option) => option.firstChild),
    };
  });
  const unchanged = () =>
    page.evaluate(() => {
      const saved = (window as any).savedNativeOptions;
      const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
      const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
      return {
        sameResize: resize === saved.resize,
        sameView: view === saved.view,
        sameResizeOptions:
          resize.options.length === saved.resizeOptions.length &&
          [...resize.options].every((option, index) => option === saved.resizeOptions[index]),
        sameViewOptions:
          view.options.length === saved.viewOptions.length &&
          [...view.options].every((option, index) => option === saved.viewOptions[index]),
        sameResizeTexts:
          resize.options.length === saved.resizeTexts.length &&
          [...resize.options].every((option, index) => option.firstChild === saved.resizeTexts[index]),
        sameViewTexts:
          view.options.length === saved.viewTexts.length &&
          [...view.options].every((option, index) => option.firstChild === saved.viewTexts[index]),
        selected: resize.value,
        viewValue: view.value,
        focused: document.activeElement === resize,
      };
    });
  const expected = {
    sameResize: true,
    sameView: true,
    sameResizeOptions: true,
    sameViewOptions: true,
    sameResizeTexts: true,
    sameViewTexts: true,
    selected: paneId,
    viewValue: '',
    focused: true,
  };
  await page.evaluate(() => (window as any).terminalTestApi.appendBars(1));
  expect(await unchanged()).toEqual(expected);
  await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    terminal.applySettings({ followLatest: !terminal.getSettings().followLatest });
  });
  expect(await unchanged()).toEqual(expected);
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '1100px';
    host.style.height = '720px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.getBoundingClientRect().height,
      ),
    )
    .toBe(720);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await unchanged()).toEqual(expected);

  await page.evaluate(() => {
    const terminal = (window as any).terminalTestApi.terminal;
    terminal.addStudy({ kind: 'macd', fastPeriod: 3, slowPeriod: 6, signalPeriod: 2 });
    terminal.addStudy({ kind: 'macd', fastPeriod: 4, slowPeriod: 7, signalPeriod: 2 });
  });
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '320px';
    host.style.height = '360px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.terminalEditingFocus,
      ),
    )
    .toBe('price');
  expect(
    await page.evaluate(() => {
      const saved = (window as any).savedNativeOptions;
      const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
      return {
        sameAllOption: view.options[0] === saved.viewOptions[0],
        label: view.options[0]!.textContent,
        value: view.options[0]!.value,
      };
    }),
  ).toEqual({
    sameAllOption: true,
    label: 'Price focus while editing (all panes saved)',
    value: '',
  });
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#terminal-host')!;
    host.style.width = '1280px';
    host.style.height = '720px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector<HTMLElement>('[data-filtix-terminal]')!.dataset.terminalEditingFocus,
      ),
    )
    .toBeUndefined();
  expect(
    await page.evaluate(() => {
      const saved = (window as any).savedNativeOptions;
      const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
      return { sameAllOption: view.options[0] === saved.viewOptions[0], label: view.options[0]!.textContent };
    }),
  ).toEqual({ sameAllOption: true, label: 'All panes' });
});

test('native option reconciliation removes obsolete ids, updates labels and survives remount', async ({
  page,
}) => {
  await ready(page);
  const id = await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.addStudy({ kind: 'rsi', period: 3 }),
  );
  const paneId = 'terminal-' + id + '-pane';
  await page.evaluate((selected) => {
    const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
    const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
    (window as any).savedMembershipOptions = {
      resize,
      view,
      priceResize: resize.querySelector<HTMLOptionElement>('option[value="price"]'),
      volumeResize: resize.querySelector<HTMLOptionElement>('option[value="terminal-volume-pane"]'),
      studyResize: [...resize.options].find((option) => option.value === selected),
      priceView: view.querySelector<HTMLOptionElement>('option[value="price"]'),
      volumeView: view.querySelector<HTMLOptionElement>('option[value="terminal-volume-pane"]'),
      studyView: [...view.options].find((option) => option.value === selected),
    };
  }, paneId);
  const membership = () =>
    page.evaluate((selected) => {
      const saved = (window as any).savedMembershipOptions;
      const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
      const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
      return {
        ids: [...resize.options].map((option) => option.value),
        viewIds: [...view.options].map((option) => option.value),
        targetValue: resize.value,
        viewValue: view.value,
        priceResizeRetained: resize.querySelector('option[value="price"]') === saved.priceResize,
        volumeResizeRetained:
          resize.querySelector('option[value="terminal-volume-pane"]') === saved.volumeResize,
        priceViewRetained: view.querySelector('option[value="price"]') === saved.priceView,
        volumeViewRetained: view.querySelector('option[value="terminal-volume-pane"]') === saved.volumeView,
        studyResizeRetained:
          [...resize.options].find((option) => option.value === selected) === saved.studyResize,
        studyViewRetained: [...view.options].find((option) => option.value === selected) === saved.studyView,
        oldStudyDisconnected: !saved.studyResize.isConnected && !saved.studyView.isConnected,
        studyLabel: [...resize.options].find((option) => option.value === selected)?.textContent ?? null,
      };
    }, paneId);
  await page.locator('[data-terminal-pane-select]').selectOption(paneId);
  await page.locator('[data-terminal-layout-view]').selectOption(paneId);
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout().maximizedPaneId))
    .toBe(paneId);
  await page.evaluate(
    (studyId) => (window as any).terminalTestApi.terminal.updateStudy(studyId, { visible: false }),
    id,
  );
  expect(await membership()).toMatchObject({
    ids: ['price', 'terminal-volume-pane'],
    viewIds: ['', 'price', 'terminal-volume-pane'],
    targetValue: 'price',
    viewValue: '',
    priceResizeRetained: true,
    volumeResizeRetained: true,
    priceViewRetained: true,
    volumeViewRetained: true,
    oldStudyDisconnected: true,
  });
  await page.evaluate(
    (studyId) => (window as any).terminalTestApi.terminal.updateStudy(studyId, { visible: true }),
    id,
  );
  const restored = await membership();
  expect(restored.ids).toContain(paneId);
  expect(restored.studyResizeRetained).toBe(false);
  expect(restored.studyViewRetained).toBe(false);
  await page.evaluate(async (studyId) => {
    const terminal = (window as any).terminalTestApi.terminal;
    const workspace = terminal.getWorkspace();
    workspace.studies = workspace.studies.map((study: any) =>
      study.id === studyId
        ? {
            id: studyId,
            kind: 'macd',
            fastPeriod: 2,
            slowPeriod: 3,
            signalPeriod: 2,
            color: '#7aa2f7',
            signalColor: '#e0af68',
            positiveColor: '#73c991',
            negativeColor: '#ef7c8e',
            lineWidth: 2,
            visible: true,
          }
        : study,
    );
    const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
    const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
    (window as any).sameIdOptions = {
      resize: [...resize.options].find((option) => option.value === 'terminal-' + studyId + '-pane'),
      view: [...view.options].find((option) => option.value === 'terminal-' + studyId + '-pane'),
    };
    await terminal.restoreWorkspace(workspace);
  }, id);
  expect(await membership()).toMatchObject({
    studyLabel: 'MACD ' + id,
    priceResizeRetained: true,
    volumeResizeRetained: true,
    priceViewRetained: true,
    volumeViewRetained: true,
  });
  expect(
    await page.evaluate((selected) => {
      const same = (window as any).sameIdOptions;
      const resize = document.querySelector<HTMLSelectElement>('[data-terminal-pane-select]')!;
      const view = document.querySelector<HTMLSelectElement>('[data-terminal-layout-view]')!;
      return {
        resize: [...resize.options].find((option) => option.value === selected) === same.resize,
        view: [...view.options].find((option) => option.value === selected) === same.view,
      };
    }, paneId),
  ).toEqual({ resize: true, view: true });
  await page.evaluate(() => (window as any).terminalTestApi.remountWithStudies([]));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  expect(
    await page.evaluate(() => {
      const saved = (window as any).savedMembershipOptions;
      return {
        oldSelectsDisconnected: !saved.resize.isConnected && !saved.view.isConnected,
        freshResize: document.querySelector('[data-terminal-pane-select]') !== saved.resize,
        freshView: document.querySelector('[data-terminal-layout-view]') !== saved.view,
      };
    }),
  ).toEqual({ oldSelectsDisconnected: true, freshResize: true, freshView: true });
});

test('capture unique source-fingerprinted dark/light review frames', async ({ page, browserName }) => {
  if (browserName !== 'chromium') return;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await mixed(page);
  await page.locator('[data-terminal-studies-toggle]').click();
  const sourceFiles = [
    'packages/terminal/src/terminal.ts',
    'packages/terminal/src/study-controls.ts',
    'packages/terminal/src/responsive-layout.ts',
    'packages/terminal/src/terminal-layout-controls.ts',
    'tests/browser/terminal-layout-ui.spec.ts',
  ];
  const sourceHash = createHash('sha256');
  for (const file of sourceFiles) sourceHash.update(file).update(readFileSync(file));
  const evidenceStage = process.env.FILTIX_EVIDENCE_STAGE ?? 'v0.8';
  if (!/^v\d+\.\d+(?:\.\d+)?$/.test(evidenceStage)) {
    throw new Error('Invalid FILTIX_EVIDENCE_STAGE');
  }
  const folder = join(
    'benchmark-results',
    evidenceStage,
    'task-3-' + Date.now() + '-' + randomBytes(3).toString('hex'),
  );
  mkdirSync(folder, { recursive: true });
  const captures: Array<{
    name: string;
    theme: string;
    width: number;
    height: number;
    price: number;
    path: string;
  }> = [];
  for (const theme of ['dark', 'light']) {
    await page.locator('[data-terminal-theme]').selectOption(theme);
    for (const item of [
      { name: 'wide', width: 1280, height: 720 },
      { name: 'narrow', width: 390, height: 844 },
      { name: 'compact', width: 320, height: 360 },
      { name: 'short', width: 320, height: 240 },
    ]) {
      await page.evaluate(({ width, height }) => {
        const host = document.querySelector<HTMLElement>('#terminal-host')!;
        host.style.width = width + 'px';
        host.style.height = height + 'px';
      }, item);
      await expect
        .poll(async () => (await geometry(page)).toolbar)
        .toBeLessThanOrEqual(item.height * 0.25 + 1);
      const g = await geometry(page);
      const path = join(folder, theme + '-' + item.name + '-' + item.width + 'x' + item.height + '.png');
      await page.locator('#terminal-host').screenshot({ path });
      captures.push({ name: item.name, theme, width: item.width, height: item.height, price: g.price, path });
    }
  }
  writeFileSync(
    join(folder, 'metadata.json'),
    JSON.stringify(
      {
        sourceSha256: sourceHash.digest('hex'),
        sourceFiles,
        host: 'terminal-test.html #terminal-host',
        browser: browserName,
        captures,
      },
      null,
      2,
    ),
  );
});

test('narrow toolbar shows full native pane selector captions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const result = await page.locator('[data-terminal-layout-controls] label > span').evaluateAll((nodes) => {
    const toolbar = document.querySelector<HTMLElement>('[data-terminal-toolbar]')!.getBoundingClientRect();
    return nodes.map((node) => {
      const rect = node.getBoundingClientRect(),
        style = getComputedStyle(node);
      return {
        text: node.textContent,
        width: rect.width,
        height: rect.height,
        clipped: style.clip !== 'auto' || style.position === 'absolute',
        withinToolbar:
          rect.left >= toolbar.left &&
          rect.right <= toolbar.right &&
          rect.top >= toolbar.top &&
          rect.bottom <= toolbar.bottom,
      };
    });
  });
  expect(result.map((item) => item.text)).toEqual(['Resize pane', 'View']);
  expect(
    result.every((item) => item.width > 20 && item.height > 8 && !item.clipped && item.withinToolbar),
  ).toBe(true);
});
