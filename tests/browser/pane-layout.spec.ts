import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.goto('/pane-layout-test.html');
  await page.waitForFunction(() => !!window.paneLayoutTestApi);
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
});
test('batch validates atomically and emits one immutable committed snapshot', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    const before = chart.getPaneLayout();
    const delivered: unknown[] = [];
    const origin = {};
    chart.subscribePaneLayoutChange((value, meta) =>
      delivered.push({ value, meta, sameOrigin: meta.origin === origin }),
    );
    let rejected = 0;
    for (const patch of [
      {
        panes: [
          { id: 'price', weight: 2 },
          { id: 'missing', weight: 1 },
        ],
      },
      { panes: [{ id: 'price', weight: Number.NaN }] },
      {
        panes: [
          { id: 'price', weight: 2 },
          { id: 'price', minHeight: 200 },
        ],
      },
      { panes: [{ id: 'price', weight: 2, unknown: true }] },
      { panes: [{ weight: 2 }] },
      { panes: [{ id: 'price', minHeight: null }] },
      { maximizedPaneId: 'missing' },
    ]) {
      try {
        chart.applyPaneLayout(patch as never);
      } catch {
        rejected++;
      }
    }
    const unchanged = JSON.stringify(before) === JSON.stringify(chart.getPaneLayout());
    chart.applyPaneLayout({ panes: [{ id: 'price', weight: 2 }] }, { origin });
    chart.applyPaneLayout({ panes: [{ id: 'price', weight: 2 }] }, { origin });
    const snapshot = chart.getPaneLayout();
    return {
      rejected,
      unchanged,
      count: delivered.length,
      first: delivered[0],
      snapshot,
      before,
      frozen:
        Object.isFrozen(snapshot) && Object.isFrozen(snapshot.panes) && Object.isFrozen(snapshot.panes[0]!),
    };
  });
  expect(result.rejected).toBe(7);
  expect(result.unchanged).toBe(true);
  expect(result.count).toBe(1);
  const first = result.first as { meta: { cause: string }; sameOrigin: boolean };
  expect(first.meta.cause).toBe('api');
  expect(first.sameOrigin).toBe(true);
  expect(result.frozen).toBe(true);
  expect(result.snapshot.panes[0]!.weight).toBe(2);
  expect(result.before.panes[0]!.weight).toBe(1);
});
test('resizePane changes only adjacent heights and leaves source resources alive', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, price, volume, oscillator, measurePaneLayout } = window.paneLayoutTestApi;
    const before = chart.getPaneLayout();
    const geomBefore = measurePaneLayout(before, 600);
    const original = [price.getData(), volume.getData(), oscillator.getData()];
    const range = chart.getVisibleRange();
    let count = 0;
    chart.subscribePaneLayoutChange(() => count++);
    chart.resizePane('price', 24);
    const after = chart.getPaneLayout();
    const geomAfter = measurePaneLayout(after, 600);
    await chart.whenIdle();
    return {
      count,
      priceDelta: geomAfter.panes[0]!.height - geomBefore.panes[0]!.height,
      volumeDelta: geomAfter.panes[1]!.height - geomBefore.panes[1]!.height,
      oscillatorDelta: geomAfter.panes[2]!.height - geomBefore.panes[2]!.height,
      data: [price.getData(), volume.getData(), oscillator.getData()],
      original,
      range,
      afterRange: chart.getVisibleRange(),
      canvases: document.querySelectorAll('#host canvas').length,
    };
  });
  expect(result.count).toBe(1);
  expect(result.priceDelta).toBeCloseTo(24, 1);
  expect(result.volumeDelta).toBeCloseTo(-24, 1);
  expect(result.oscillatorDelta).toBeCloseTo(0, 5);
  expect(result.data).toEqual(result.original);
  expect(result.afterRange).toEqual(result.range);
  expect(result.canvases).toBe(2);
});
test('maximize suppresses other pane coordinates and restores original preferences', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    const before = chart.getPaneLayout();
    chart.applyPaneLayout({ maximizedPaneId: 'oscillator' });
    const hidden = chart.priceToCoordinate(11, 'price');
    const shown = chart.priceToCoordinate(50, 'oscillator');
    const maximized = chart.getPaneLayout();
    chart.applyPaneLayout({ maximizedPaneId: null });
    return { before, after: chart.getPaneLayout(), hidden, shown, maximized };
  });
  expect(result.hidden).toBeNull();
  expect(result.shown).not.toBeNull();
  expect(result.after).toEqual(result.before);
  expect(result.maximized.maximizedPaneId).toBe('oscillator');
});
test('separator keyboard and pointer preview commit through layout subscription', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  const first = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  await separator.focus();
  await page.keyboard.press('ArrowDown');
  const keyed = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  expect(keyed.panes[0]!.weight).not.toBe(first.panes[0]!.weight);
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 30);
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(keyed);
  await page.mouse.up();
  const final = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  expect(final.panes[0]!.weight).not.toBe(keyed.panes[0]!.weight);
});
test('reentrant listener replaces stale notification safely', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    const values: number[] = [];
    chart.subscribePaneLayoutChange((layout) => {
      if (layout.panes[0]!.weight === 2) chart.applyPaneLayout({ panes: [{ id: 'price', weight: 3 }] });
    });
    chart.subscribePaneLayoutChange((layout) => values.push(layout.panes[0]!.weight));
    chart.applyPaneLayout({ panes: [{ id: 'price', weight: 2 }] });
    return { values, weight: chart.getPaneLayout().panes[0]!.weight };
  });
  expect(result).toEqual({ values: [3], weight: 3 });
});

test('strict patch shape rejects symbols, own prototype keys, missing own IDs and explicit undefined', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    const before = chart.getPaneLayout();
    const bad = [
      { panes: [{ id: 'price', weight: undefined }] },
      { panes: [{ id: 'price', minHeight: Infinity }] },
      { panes: [{ id: 'price', weight: 0 }] },
      { panes: [{ id: 'price', weight: -1 }] },
      { panes: [{ id: 'price', weight: null }] },
      { panes: [{ id: 'price', [Symbol('extra')]: true }] },
      { panes: [Object.assign(Object.create({ id: 'price' }), { weight: 2 })] },
      { panes: [Object.defineProperty({ id: 'price' }, '__proto__', { value: 1, enumerable: true })] },
      { panes: undefined },
      { maximizedPaneId: undefined },
      { [Symbol('extra')]: true },
    ];
    let errors = 0;
    for (const patch of bad)
      try {
        chart.applyPaneLayout(patch as never);
      } catch {
        errors++;
      }
    return { errors, same: JSON.stringify(chart.getPaneLayout()) === JSON.stringify(before) };
  });
  expect(result).toEqual({ errors: 11, same: true });
});
test('pane handles and membership publish committed changes while data and host size stay silent', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { chart, host, volumePane, price } = window.paneLayoutTestApi;
    const events: { ids: string[]; cause: string; revision: number }[] = [];
    chart.subscribePaneLayoutChange((layout, meta) =>
      events.push({ ids: layout.panes.map((pane) => pane.id), cause: meta.cause, revision: meta.revision }),
    );
    volumePane.applyOptions({ weight: 0.5 });
    const extra = chart.addPane({ id: 'extra' });
    extra.remove();
    const count = events.length;
    price.update({ time: 4, value: 9 });
    host.style.height = '620px';
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await chart.whenIdle();
    return { events, count, finalCount: events.length, layout: chart.getPaneLayout() };
  });
  expect(result.count).toBe(3);
  expect(result.finalCount).toBe(3);
  expect(result.events.map((event) => event.cause)).toEqual(['api', 'api', 'api']);
  expect(result.events.map((event) => event.ids)).toEqual([
    ['price', 'volume', 'oscillator'],
    ['price', 'volume', 'oscillator', 'extra'],
    ['price', 'volume', 'oscillator'],
  ]);
  expect(result.events[0]!.revision).toBeLessThan(result.events[1]!.revision);
  expect(result.events[1]!.revision).toBeLessThan(result.events[2]!.revision);
  expect(result.layout.panes[1]!.weight).toBe(0.5);
});
test('resizePane grows the last pane using its previous neighbor', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart, measurePaneLayout } = window.paneLayoutTestApi;
    const before = measurePaneLayout(chart.getPaneLayout(), 600);
    chart.resizePane('oscillator', 20);
    const after = measurePaneLayout(chart.getPaneLayout(), 600);
    return before.panes.map((pane, i) => after.panes[i]!.height - pane.height);
  });
  expect(result[0]).toBeCloseTo(0, 5);
  expect(result[1]).toBeCloseTo(-20, 1);
  expect(result[2]).toBeCloseTo(20, 1);
});
test('maximized primitive projection exposes only the visible pane', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    let projection: (() => { panes: readonly { id: string; top: number; bottom: number }[] }) | null = null;
    const detach = chart.attachPrimitive({
      draw() {},
      attach(host) {
        projection = () => host.getProjection();
      },
    });
    chart.applyPaneLayout({ maximizedPaneId: 'oscillator' });
    const panes = projection!().panes.map((pane) => ({ id: pane.id, top: pane.top, bottom: pane.bottom }));
    detach();
    return panes;
  });
  expect(result).toEqual([{ id: 'oscillator', top: 0, bottom: 572 }]);
});
test('pointer cancellation discards preview without changing committed preferences', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const before = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await separator.evaluate((element) =>
    element.addEventListener(
      'pointerdown',
      (event) => {
        element.dataset.testPointerId = String((event as PointerEvent).pointerId);
      },
      { once: true },
    ),
  );
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 42);
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before);
  await separator.evaluate((element) =>
    element.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: Number(element.dataset.testPointerId), bubbles: true }),
    ),
  );
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before);
});
test('invalid external patch preserves an active preview; valid patch supersedes it', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 42);
  const state = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    try {
      chart.applyPaneLayout({ panes: [{ id: 'missing', weight: 2 }] });
    } catch {}
    return chart.getPaneLayout();
  });
  await page.mouse.up();
  const committed = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  expect(committed.panes[0]!.weight).not.toBe(state.panes[0]!.weight);
  const nextBox = await separator.boundingBox();
  await page.mouse.move(nextBox!.x + 100, nextBox!.y + 12);
  await page.mouse.down();
  await page.mouse.move(nextBox!.x + 100, nextBox!.y + 42);
  await page.evaluate(() =>
    window.paneLayoutTestApi.chart.applyPaneLayout({ panes: [{ id: 'price', weight: 7 }] }),
  );
  await page.mouse.up();
  expect((await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).panes[0]!.weight).toBe(
    7,
  );
});
test('destroy during layout callback stops older listeners and lets the successful call return', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    let second = 0;
    chart.subscribePaneLayoutChange(() => chart.destroy());
    chart.subscribePaneLayoutChange(() => second++);
    let returned = false;
    chart.applyPaneLayout({ panes: [{ id: 'price', weight: 2 }] });
    returned = true;
    return { returned, second, roots: document.querySelectorAll('[data-filtix-root]').length };
  });
  expect(result).toEqual({ returned: true, second: 0, roots: 0 });
});

test('second pointer cancels the gesture and a later pointer can start fresh', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const before = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  const initialSize = Number(await separator.getAttribute('aria-valuenow'));
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 35);
  await separator.evaluate((element) => {
    element.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 22, bubbles: true, button: 0 }));
    element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 22, bubbles: true, clientY: 100 }));
  });
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeCloseTo(initialSize, 4);
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before);
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 45);
  await page.mouse.up();
  const after = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  expect(after.panes[0]!.weight).not.toBe(before.panes[0]!.weight);
});

test('separator Home, End and shifted arrows use its reported attainable range', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const min = Number(await separator.getAttribute('aria-valuemin'));
  const max = Number(await separator.getAttribute('aria-valuemax'));
  const now = Number(await separator.getAttribute('aria-valuenow'));
  expect(min).toBeLessThan(now);
  expect(max).toBeGreaterThan(now);
  await separator.focus();
  await page.keyboard.press('End');
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeCloseTo(max, 4);
  await page.keyboard.press('Home');
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  const home = Number(await separator.getAttribute('aria-valuenow'));
  expect(home).toBeCloseTo(min, 4);
  await page.keyboard.press('Shift+ArrowDown');
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(Number(await separator.getAttribute('aria-valuenow')) - home).toBeCloseTo(32, 1);
});
test('Escape, capture loss, blur and host resize cancel previews without a layout event', async ({
  page,
}) => {
  const separator = page.getByRole('separator').first();
  const start = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  const box = await separator.boundingBox();
  const begin = async () => {
    const current = await separator.boundingBox();
    await page.mouse.move(current!.x + 100, current!.y + 12);
    await separator.evaluate((element) =>
      element.addEventListener(
        'pointerdown',
        (event) => {
          element.dataset.testPointerId = String((event as PointerEvent).pointerId);
        },
        { once: true },
      ),
    );
    await page.mouse.down();
    await page.mouse.move(current!.x + 100, current!.y + 38);
  };
  await begin();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(start);
  await begin();
  await separator.evaluate((element) => {
    const pointerId = Number(element.dataset.testPointerId);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(start);
  await begin();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(start);
  await begin();
  await page.evaluate(() => {
    window.paneLayoutTestApi.host.style.height = '640px';
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-filtix-chart]')!.getBoundingClientRect().height === 640,
  );
  await page.waitForFunction(() => {
    const { chart, measurePaneLayout } = window.paneLayoutTestApi;
    const expected = measurePaneLayout(chart.getPaneLayout(), 640).panes[0]!.height;
    const actual = Number(
      document.querySelector<HTMLElement>('[data-filtix-separator="0"]')!.getAttribute('aria-valuenow'),
    );
    return Math.abs(actual - expected) < 1e-6;
  });
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(start);
  expect(box).not.toBeNull();
});
test('zero-height host has finite recoverable geometry and no active separators', async ({ page }) => {
  await page.evaluate(() => {
    window.paneLayoutTestApi.host.style.height = '0px';
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-filtix-chart]')!.getBoundingClientRect().height === 0,
  );
  await expect
    .poll(() => page.evaluate(() => window.paneLayoutTestApi.chart.priceToCoordinate(10, 'price')))
    .toBeNull();
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  const atZero = await page.evaluate(() => ({
    price: window.paneLayoutTestApi.chart.priceToCoordinate(10, 'price'),
    controls: [...document.querySelectorAll<HTMLElement>('[role=separator]')].map((element) => ({
      disabled: element.getAttribute('aria-disabled'),
      now: Number(element.getAttribute('aria-valuenow')),
    })),
  }));
  expect(atZero.price).toBeNull();
  expect(
    atZero.controls.every((control) => control.disabled === 'true' && Number.isFinite(control.now)),
  ).toBe(true);
  await page.evaluate(() => {
    window.paneLayoutTestApi.host.style.height = '600px';
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-filtix-chart]')!.getBoundingClientRect().height === 600,
  );
  // CSS geometry can settle before ResizeObserver schedules the chart frame.
  await expect
    .poll(() => page.evaluate(() => window.paneLayoutTestApi.chart.priceToCoordinate(10, 'price')))
    .not.toBeNull();
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
});

test('valid chart option changes supersede a separator preview', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const before = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  const originalSize = Number(await separator.getAttribute('aria-valuenow'));
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 38);
  await page.evaluate(() => window.paneLayoutTestApi.chart.applyOptions({ theme: 'light' }));
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeCloseTo(originalSize, 4);
  await page.mouse.up();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before);
});

test('manual chart dimensions keep divider geometry inside the explicit wrapper', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createChart } = window.paneLayoutTestApi;
    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:500px;height:400px';
    document.body.append(container);
    const manual = createChart(container, { autoSize: false, width: 360, height: 200 });
    try {
      manual.addPane({ id: 'second' });
      await manual.whenIdle();
      const wrapper = container.querySelector<HTMLElement>('[data-filtix-chart]')!;
      const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
      const first = wrapper.getBoundingClientRect(),
        divider = separator.getBoundingClientRect();
      container.style.width = '700px';
      container.style.height = '500px';
      await manual.whenIdle();
      const still = wrapper.getBoundingClientRect();
      manual.applyOptions({ width: 380, height: 220 });
      await manual.whenIdle();
      const resized = wrapper.getBoundingClientRect(),
        newDivider = separator.getBoundingClientRect();
      return {
        first: [first.width, first.height],
        still: [still.width, still.height],
        resized: [resized.width, resized.height],
        withinFirst: divider.top >= first.top && divider.bottom <= first.bottom,
        withinResized: newDivider.top >= resized.top && newDivider.bottom <= resized.bottom,
      };
    } finally {
      manual.destroy();
      container.remove();
    }
  });
  expect(result.first).toEqual([360, 200]);
  expect(result.still).toEqual([360, 200]);
  expect(result.resized).toEqual([380, 220]);
  expect(result.withinFirst).toBe(true);
  expect(result.withinResized).toBe(true);
});

test('real mouse separator capture works beside an active drawing tool without pan or drawing', async ({
  page,
}) => {
  const before = await page.evaluate(() => {
    const { chart, createDrawingLayer } = window.paneLayoutTestApi;
    const layer = createDrawingLayer(chart);
    layer.setTool('trend-line');
    (window as any).paneDrawingLayer = layer;
    return { layout: chart.getPaneLayout(), range: chart.getVisibleRange() };
  });
  const separator = page.getByRole('separator').first();
  const box = await separator.boundingBox();
  await separator.evaluate((node) =>
    node.addEventListener(
      'pointerdown',
      (event) => {
        (node as HTMLElement).dataset.pointerId = String((event as PointerEvent).pointerId);
      },
      { once: true },
    ),
  );
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  const captured = await separator.evaluate((node) =>
    node.hasPointerCapture(Number((node as HTMLElement).dataset.pointerId)),
  );
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(async () => {
    const { chart } = window.paneLayoutTestApi;
    await chart.whenIdle();
    const layer = (window as any).paneDrawingLayer;
    const result = {
      layout: chart.getPaneLayout(),
      range: chart.getVisibleRange(),
      drawings: layer.store.list().length,
    };
    layer.destroy();
    return result;
  });
  expect(captured).toBe(true);
  expect(after.layout.panes[0]!.weight).not.toBe(before.layout.panes[0]!.weight);
  expect(after.range).toEqual(before.range);
  expect(after.drawings).toBe(0);
});

test('touch-emulated separator cancel rolls back and release commits without range change', async ({
  page,
  browserName,
}) => {
  if (browserName !== 'chromium') return;
  const separator = page.getByRole('separator').first();
  const box = await separator.boundingBox();
  const x = box!.x + box!.width / 2,
    y = box!.y + box!.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const before = await page.evaluate(() => ({
    layout: window.paneLayoutTestApi.chart.getPaneLayout(),
    range: window.paneLayoutTestApi.chart.getVisibleRange(),
  }));
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
    points: Array<{ x: number; y: number; id: number }>,
  ) => session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ x, y, id: 1 }]);
  await touch('touchMove', [{ x, y: y + 25, id: 1 }]);
  await touch('touchCancel', []);
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before.layout);
  await touch('touchStart', [{ x, y, id: 2 }]);
  await touch('touchMove', [{ x, y: y + 25, id: 2 }]);
  await touch('touchEnd', []);
  const after = await page.evaluate(() => ({
    layout: window.paneLayoutTestApi.chart.getPaneLayout(),
    range: window.paneLayoutTestApi.chart.getVisibleRange(),
  }));
  expect(after.layout.panes[0]!.weight).not.toBe(before.layout.panes[0]!.weight);
  expect(after.range).toEqual(before.range);
  await session.detach();
});

test('suppressed oscillator scene and drawing pixels disappear and restore', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, oscillator, createDrawingLayer } = window.paneLayoutTestApi;
    oscillator.applyOptions({ color: '#ff00ff' });
    const layer = createDrawingLayer(chart, { paneId: 'oscillator' });
    layer.store.add({
      type: 'horizontal-line',
      paneId: 'oscillator',
      points: [{ time: 2, price: 50 }],
      style: { color: '#ff00ff', lineWidth: 3 },
    });
    async function pixels() {
      await chart.whenIdle();
      const root = document.querySelector<HTMLElement>('[data-filtix-chart]')!;
      const count = (name: string) => {
        const canvas = root.querySelector<HTMLCanvasElement>('canvas[data-filtix-layer="' + name + '"]')!;
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let magenta = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i]! > 180 && data[i + 1]! < 90 && data[i + 2]! > 180 && data[i + 3]! > 0) magenta++;
        return magenta;
      };
      return { scene: count('scene'), drawing: count('annotation') };
    }
    const shown = await pixels();
    chart.applyPaneLayout({ maximizedPaneId: 'price' });
    const hidden = await pixels();
    chart.applyPaneLayout({ maximizedPaneId: null });
    const restored = await pixels();
    layer.destroy();
    return { shown, hidden, restored };
  });
  expect(result.shown.scene).toBeGreaterThan(0);
  expect(result.shown.drawing).toBeGreaterThan(0);
  expect(result.hidden.scene).toBe(0);
  expect(result.hidden.drawing).toBe(0);
  expect(result.restored.scene).toBeGreaterThan(0);
  expect(result.restored.drawing).toBeGreaterThan(0);
});

test('host size change and pointerup in one task cannot commit an old drag preview', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const before = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    (window as any).paneResizeEvents = 0;
    chart.subscribePaneLayoutChange(() => (window as any).paneResizeEvents++);
    return chart.getPaneLayout();
  });
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await separator.evaluate((element) =>
    element.addEventListener(
      'pointerdown',
      (event) => {
        element.dataset.testPointerId = String((event as PointerEvent).pointerId);
      },
      { once: true },
    ),
  );
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 38);
  const result = await page.evaluate((releaseY) => {
    const { chart, host } = window.paneLayoutTestApi;
    const element = document.querySelector<HTMLElement>('[data-filtix-separator="0"]')!;
    host.style.height = '640px';
    const hostHeight = host.clientHeight;
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: Number(element.dataset.testPointerId),
        clientY: releaseY,
        button: 0,
        buttons: 0,
      }),
    );
    return { hostHeight, layout: chart.getPaneLayout(), events: (window as any).paneResizeEvents };
  }, box!.y + 38);
  await page.mouse.up();
  expect(result.hostHeight).toBe(640);
  expect(result.layout).toEqual(before);
  expect(result.events).toBe(0);
  await page.waitForFunction(() => {
    const { chart, measurePaneLayout } = window.paneLayoutTestApi;
    const expected = measurePaneLayout(chart.getPaneLayout(), 640).panes[0]!.height;
    const actual = Number(
      document.querySelector<HTMLElement>('[data-filtix-separator="0"]')!.getAttribute('aria-valuenow'),
    );
    return Math.abs(actual - expected) < 1e-6;
  });
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).toEqual(before);
});

test('canResizePane uses the committed adjacent candidate without changing state', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    const before = chart.getPaneLayout();
    const revision = chart.getChangeRevision();
    let events = 0;
    chart.subscribePaneLayoutChange(() => events++);
    const first = chart.canResizePane('price', 8);
    const last = chart.canResizePane('oscillator', 8);
    const zero = chart.canResizePane('price', 0);
    let invalid = 0;
    for (const [id, delta] of [
      ['missing', 8],
      ['price', Number.NaN],
    ] as const)
      try {
        chart.canResizePane(id, delta);
      } catch {
        invalid++;
      }
    return {
      first,
      last,
      zero,
      invalid,
      events,
      same: JSON.stringify(chart.getPaneLayout()) === JSON.stringify(before),
      sameRevision: chart.getChangeRevision() === revision,
    };
  });
  expect(result).toEqual({
    first: true,
    last: true,
    zero: false,
    invalid: 2,
    events: 0,
    same: true,
    sameRevision: true,
  });
});

test('canResizePane reports no attainable change for maximize and subnormal steps', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    chart.applyPaneLayout({ maximizedPaneId: 'price' });
    const maximized = chart.canResizePane('price', 8);
    chart.applyPaneLayout({
      maximizedPaneId: null,
      panes: [
        { id: 'price', weight: Number.MIN_VALUE },
        { id: 'volume', weight: 2 * Number.MIN_VALUE },
        { id: 'oscillator', weight: 3 * Number.MIN_VALUE },
      ],
    });
    const unrepresentable = chart.canResizePane('price', 8);
    const attainable = chart.canResizePane('price', 70);
    return { maximized, unrepresentable, attainable };
  });
  expect(result).toEqual({ maximized: false, unrepresentable: false, attainable: true });
  await page.evaluate(() => {
    window.paneLayoutTestApi.host.style.height = '0px';
  });
  await expect
    .poll(() => page.evaluate(() => window.paneLayoutTestApi.chart.priceToCoordinate(10, 'price')))
    .toBeNull();
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.canResizePane('price', 8))).toBe(false);
  await page.evaluate(() => {
    window.paneLayoutTestApi.host.style.height = '600px';
  });
  await expect
    .poll(() => page.evaluate(() => window.paneLayoutTestApi.chart.priceToCoordinate(10, 'price')))
    .not.toBeNull();
  expect(
    await page.evaluate(() => {
      const { chart } = window.paneLayoutTestApi;
      chart.removePane('oscillator');
      chart.removePane('volume');
      return chart.canResizePane('price', 8);
    }),
  ).toBe(false);
});

test('canResizePane preserves an active drag preview and its eventual commit', async ({ page }) => {
  const separator = page.getByRole('separator').first();
  const before = await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout());
  const box = await separator.boundingBox();
  await page.mouse.move(box!.x + 100, box!.y + 12);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 36);
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  const previewBefore = Number(await separator.getAttribute('aria-valuenow'));
  const during = await page.evaluate(() => {
    const { chart } = window.paneLayoutTestApi;
    return { possible: chart.canResizePane('price', 8), committed: chart.getPaneLayout() };
  });
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  const previewAfter = Number(await separator.getAttribute('aria-valuenow'));
  await page.mouse.up();
  await page.evaluate(() => window.paneLayoutTestApi.chart.whenIdle());
  expect(previewBefore).toBeGreaterThan(0);
  expect(during.possible).toBe(true);
  expect(during.committed).toEqual(before);
  expect(previewAfter).toBe(previewBefore);
  expect(await page.evaluate(() => window.paneLayoutTestApi.chart.getPaneLayout())).not.toEqual(before);
});
