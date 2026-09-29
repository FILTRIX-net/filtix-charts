import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.goto('/drawing-test.html');
  await page.waitForFunction(() => !!window.drawingApi);
  await page.evaluate(() => window.drawingApi.chart.whenIdle());
});
for (const tool of ['trend-line', 'horizontal-line', 'rectangle', 'measure'] as const) {
  test(`${tool} creates only on completion and returns to selection`, async ({ page }) => {
    await page.evaluate((t) => window.drawingApi.layer.setTool(t), tool);
    await page.mouse.click(200, 200);
    if (tool !== 'horizontal-line') {
      expect(await page.evaluate(() => window.drawingApi.layer.store.list().length)).toBe(0);
      await page.mouse.move(400, 300);
      await page.mouse.click(400, 300);
    }
    const state = await page.evaluate(() => ({
      state: window.drawingApi.layer.getState(),
      drawing: window.drawingApi.layer.store.list()[0],
    }));
    expect(state.drawing?.type).toBe(tool);
    expect(state.drawing?.points).toHaveLength(tool === 'horizontal-line' ? 1 : 2);
    expect(state.state.tool).toBe('select');
    expect(state.state.selectedId).toBe(state.drawing?.id);
  });
}
test('endpoint and body drags preview locally and commit one undo entry', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('trend-line'));
  await page.mouse.click(200, 200);
  await page.mouse.click(400, 300);
  const original = await page.evaluate(() => window.drawingApi.layer.store.list()[0]!);
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(250, 150, { steps: 12 });
  expect(await page.evaluate(() => window.drawingApi.layer.store.list()[0])).toEqual(original);
  await page.mouse.up();
  expect(await page.evaluate(() => window.drawingApi.layer.store.list()[0])).not.toEqual(original);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list()[0])).toEqual(original);
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(350, 220, { steps: 12 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.drawingApi.layer.store.list()[0]!);
  expect(moved.points[0]!.time).not.toBe(original.points[0]!.time);
  expect(moved.points[1]!.time).not.toBe(original.points[1]!.time);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list()[0])).toEqual(original);
});
test('Escape cancels creation and drag without history and Delete supports redo', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('rectangle'));
  await page.mouse.click(200, 200);
  await page.mouse.move(400, 300);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.drawingApi.layer.getState().canUndo)).toBe(false);
  await page.evaluate(() => window.drawingApi.layer.setTool('horizontal-line'));
  await page.mouse.click(300, 250);
  const original = await page.evaluate(() => window.drawingApi.layer.store.list());
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(350, 200);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual(original);
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual(original);
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
});
test('unclaimed pan and wheel pass through while drawing gestures preserve range', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.chart.setVisibleRange({ from: 20, to: 70 }));
  const range = await page.evaluate(() => window.drawingApi.chart.getVisibleRange());
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(400, 200);
  await page.mouse.up();
  const panned = await page.evaluate(() => window.drawingApi.chart.getVisibleRange());
  expect(panned).not.toEqual(range);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => page.evaluate(() => window.drawingApi.chart.getVisibleRange())).not.toEqual(panned);
  const zoomed = await page.evaluate(() => window.drawingApi.chart.getVisibleRange());
  await page.evaluate(() => window.drawingApi.layer.setTool('trend-line'));
  await page.mouse.click(200, 200);
  await page.mouse.click(400, 300);
  expect(await page.evaluate(() => window.drawingApi.chart.getVisibleRange())).toEqual(zoomed);
});
test('destroy during an unfinished gesture removes the owned canvas and stops notifications', async ({
  page,
}) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('trend-line'));
  await page.mouse.click(200, 200);
  await page.mouse.move(300, 300);
  const before = await page.evaluate(() => {
    const api = window.drawingApi;
    api.layer.destroy();
    api.layer.destroy();
    return api.notices();
  });
  await page.mouse.click(400, 400);
  const result = await page.evaluate(() => {
    const api = window.drawingApi;
    api.layer.store.add({ type: 'horizontal-line', points: [{ time: api.data[0]!.time, price: 100 }] });
    let code = '';
    try {
      api.layer.setTool('select');
    } catch (e) {
      code = (e as { code: string }).code;
    }
    return { notices: api.notices(), canvases: document.querySelectorAll('canvas').length, code };
  });
  expect(result).toEqual({ notices: before, canvases: 2, code: 'DESTROYED' });
});
test('active drawing tools yield to pane divider and other panes', async ({ page }) => {
  const before = await page.evaluate(async () => {
    const { chart, data, layer } = window.drawingApi;
    chart.addPane({ id: 'secondary' });
    chart
      .addSeries('line', { paneId: 'secondary' })
      .setData(data.map((p) => ({ time: p.time, value: p.close })));
    await chart.whenIdle();
    layer.setTool('rectangle');
    return { pane: window.drawingApi.projection().panes[0]!, range: chart.getVisibleRange() };
  });
  await page.mouse.move(450, before.pane.bottom + 1);
  await page.mouse.down();
  await page.mouse.move(450, before.pane.bottom + 50, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => ({
    pane: window.drawingApi.projection().panes[0]!,
    range: window.drawingApi.chart.getVisibleRange(),
    count: window.drawingApi.layer.store.list().length,
  }));
  expect(after.pane.bottom).toBeGreaterThan(before.pane.bottom + 30);
  expect(after.range).toEqual(before.range);
  expect(after.count).toBe(0);
  await page.mouse.click(300, after.pane.bottom + 70);
  await page.mouse.click(400, after.pane.bottom + 90);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
});

test('horizontal levels render and drag after their provenance time is unloaded', async ({ page }) => {
  const start = await page.evaluate(async () => {
    const { chart, layer, data } = window.drawingApi;
    const price = chart.coordinateToPrice(240)!;
    const id = layer.store.add({
      type: 'horizontal-line',
      points: [{ time: (Number(data[0]!.time) - 86400000) as (typeof data)[number]['time'], price }],
    });
    await chart.whenIdle();
    return { id, source: layer.store.get(id)! };
  });
  await page.mouse.move(250, 240);
  await page.mouse.down();
  await page.mouse.move(700, 190, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate((id) => window.drawingApi.layer.store.get(id)!, start.id);
  expect(moved.points[0]!.time).toBe(start.source.points[0]!.time);
  expect(moved.points[0]!.price).toBeGreaterThan(start.source.points[0]!.price);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate((id) => window.drawingApi.layer.store.get(id), start.id)).toEqual(start.source);
});

test('log pane body movement preserves price ratios and endpoint bar spacing', async ({ page }) => {
  const before = await page.evaluate(async () => {
    const api = window.drawingApi;
    api.layer.destroy();
    api.chart.addPane({ id: 'log', scale: 'log', weight: 3 });
    api.chart
      .addSeries('line', { paneId: 'log' })
      .setData(api.data.map((p, i) => ({ time: p.time, value: 10 + i * 3 })));
    api.layer = api.createDrawingLayer(api.chart, { paneId: 'log' });
    const id = api.layer.store.add({
      type: 'trend-line',
      paneId: 'log',
      points: [
        { time: api.data[30]!.time, price: 60 },
        { time: api.data[60]!.time, price: 150 },
      ],
    });
    await api.chart.whenIdle();
    const p = api.projection();
    return {
      id,
      x: (p.timeToX(api.data[30]!.time)! + p.timeToX(api.data[60]!.time)!) / 2,
      y: (p.priceToY(60, 'log')! + p.priceToY(150, 'log')!) / 2,
    };
  });
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 30, before.y - 20, { steps: 10 });
  await page.mouse.up();
  const result = await page.evaluate((id) => {
    const api = window.drawingApi,
      d = api.layer.store.get(id)!,
      p = api.projection();
    return {
      ratio: d.points[1]!.price / d.points[0]!.price,
      first: d.points[0]!.price,
      gap: p.timeToLogicalIndex(d.points[1]!.time)! - p.timeToLogicalIndex(d.points[0]!.time)!,
    };
  }, before.id);
  expect(result.ratio).toBeCloseTo(2.5, 9);
  expect(result.first).toBeGreaterThan(60);
  expect(result.gap).toBe(30);
});

test('offscreen shapes clip to their pane and unloaded endpoints hide then reappear', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.drawingApi;
    api.chart.setVisibleRange({ from: 30, to: 70 });
    api.layer.store.add({
      type: 'trend-line',
      points: [
        { time: api.data[10]!.time, price: api.chart.coordinateToPrice(240)! },
        { time: api.data[90]!.time, price: api.chart.coordinateToPrice(240)! },
      ],
    });
    async function ink() {
      await api.chart.whenIdle();
      const canvas = document.querySelectorAll('canvas')[1]!,
        context = canvas.getContext('2d')!;
      const image = context.getImageData(0, 0, canvas.width, canvas.height),
        pane = api.projection().panes[0]!,
        dpr = api.projection().dpr;
      let inside = 0,
        outside = 0;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          if (image.data[(y * image.width + x) * 4 + 3]) {
            if (x < pane.right * dpr && y < pane.bottom * dpr) inside++;
            else outside++;
          }
      return { inside, outside };
    }
    const shown = await ink();
    api.series.setData(api.data.filter((_, i) => i !== 10));
    const hidden = await ink();
    api.series.setData(api.data);
    const restored = await ink();
    return { shown, hidden, restored, count: api.layer.store.list().length };
  });
  expect(result.shown.inside).toBeGreaterThan(500);
  expect(result.shown.outside).toBe(0);
  expect(result.hidden.inside).toBe(0);
  expect(result.restored.inside).toBeGreaterThan(500);
  expect(result.count).toBe(1);
});

test('PNG excludes selection and unfinished previews', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('rectangle'));
  await page.mouse.click(200, 200);
  await page.mouse.click(400, 300);
  const result = await page.evaluate(async () => {
    const api = window.drawingApi;
    const selected = Array.from(new Uint8Array(await (await api.chart.exportImage()).arrayBuffer()));
    api.layer.select(null);
    const plain = Array.from(new Uint8Array(await (await api.chart.exportImage()).arrayBuffer()));
    return { selected, plain };
  });
  expect(result.selected).toEqual(result.plain);
  await page.evaluate(() => window.drawingApi.layer.setTool('trend-line'));
  await page.mouse.click(500, 200);
  await page.mouse.move(650, 400);
  const preview = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await window.drawingApi.chart.exportImage()).arrayBuffer())),
  );
  expect(preview).toEqual(result.plain);
});

test('business-date defaults and mismatched supplied stores leave no attachment leak', async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.drawingApi,
      container = document.createElement('div');
    container.style.cssText = 'width:500px;height:300px';
    document.body.append(container);
    const chart = api.createChart(container, { timeDomain: 'business-date' });
    chart.addSeries('line').setData([
      { time: '2026-09-04', value: 1 },
      { time: '2026-09-07', value: 2 },
    ]);
    const layer = api.createDrawingLayer(chart),
      domain = layer.store.timeDomain;
    layer.destroy();
    let code = '';
    try {
      api.createDrawingLayer(chart, { store: api.createDrawingStore() });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    const canvases = container.querySelectorAll('canvas').length;
    chart.destroy();
    container.remove();
    return { domain, code, canvases };
  });
  expect(result).toEqual({ domain: 'business-date', code: 'INVALID_TIME_DOMAIN', canvases: 2 });
});

test('reentrant store observers destroy safely without later layer notifications', async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.drawingApi;
    api.layer.destroy();
    const store = api.createDrawingStore();
    let notices = 0;
    store.subscribe(() => api.layer.destroy());
    api.layer = api.createDrawingLayer(api.chart, { store, onState: () => notices++ });
    store.add({ type: 'horizontal-line', points: [{ time: api.data[0]!.time, price: 100 }] });
    store.undo();
    return { notices, canvases: document.querySelectorAll('canvas').length, count: store.list().length };
  });
  expect(result).toEqual({ notices: 0, canvases: 2, count: 0 });
});
test('axis presses that end outside the chart cannot strand drawing navigation arbitration', async ({
  page,
}) => {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 81,
        button: 0,
        clientX: 990,
        clientY: 200,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 81, button: 0, clientX: 1100, clientY: 200 }),
    );
    window.drawingApi.layer.setTool('horizontal-line');
  });
  await page.mouse.click(300, 200);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list().length)).toBe(1);
});

test('extra pointers cannot start chart pinch during an owned edit and cancellation keeps history', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.drawingApi;
    const id = api.layer.store.add({
      type: 'horizontal-line',
      points: [{ time: api.data[0]!.time, price: api.chart.coordinateToPrice(240)! }],
    });
    const source = api.layer.store.get(id),
      root = document.querySelector<HTMLElement>('[data-filtix-root]')!,
      range = api.chart.getVisibleRange();
    const dispatch = (type: string, pointerId: number, x: number, y: number) =>
      root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: 'touch',
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
        }),
      );
    dispatch('pointerdown', 31, 300, 240);
    dispatch('pointerdown', 32, 600, 240);
    dispatch('pointermove', 31, 200, 200);
    dispatch('pointermove', 32, 800, 200);
    dispatch('pointercancel', 31, 200, 200);
    dispatch('pointerup', 32, 800, 200);
    await api.chart.whenIdle();
    const after = api.layer.store.get(id),
      unchanged = api.chart.getVisibleRange();
    api.layer.store.undo();
    return { source, after, range, unchanged, count: api.layer.store.list().length };
  });
  expect(result.after).toEqual(result.source);
  expect(result.unchanged).toEqual(result.range);
  expect(result.count).toBe(0);
});

test('body edit freezes the projection and does not copy the store on pointer moves', async ({ page }) => {
  const before = await page.evaluate(() => {
    const api = window.drawingApi,
      p = api.projection();
    const id = api.layer.store.add({
      type: 'trend-line',
      points: [
        { time: api.data[20]!.time, price: api.chart.coordinateToPrice(200)! },
        { time: api.data[50]!.time, price: api.chart.coordinateToPrice(300)! },
      ],
    });
    return {
      id,
      x: (p.timeToX(api.data[20]!.time)! + p.timeToX(api.data[50]!.time)!) / 2,
      dx: p.timeToX(api.data[30]!.time)! - p.timeToX(api.data[20]!.time)!,
    };
  });
  await page.mouse.move(before.x, 250);
  await page.mouse.down();
  await page.evaluate(() => {
    const api = window.drawingApi,
      original = api.layer.store.list;
    (window as unknown as { drawingListCalls: number }).drawingListCalls = 0;
    api.layer.store.list = () => {
      (window as unknown as { drawingListCalls: number }).drawingListCalls++;
      return original();
    };
    api.chart.setVisibleRange({ from: 10, to: 70 });
  });
  await page.mouse.move(before.x + before.dx, 220, { steps: 20 });
  expect(
    await page.evaluate(() => (window as unknown as { drawingListCalls: number }).drawingListCalls),
  ).toBe(0);
  await page.mouse.up();
  const result = await page.evaluate((id) => {
    const api = window.drawingApi,
      d = api.layer.store.get(id)!;
    return { times: d.points.map((p) => p.time), expected: [api.data[30]!.time, api.data[60]!.time] };
  }, before.id);
  expect(result.times).toEqual(result.expected);
});
test('blur cancels navigation bookkeeping before a new drawing tool starts', async ({ page }) => {
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 82,
        button: 0,
        clientX: 200,
        clientY: 200,
      }),
    );
    window.dispatchEvent(new Event('blur'));
    window.drawingApi.layer.setTool('horizontal-line');
  });
  await page.mouse.click(300, 200);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list().length)).toBe(1);
});

test('missing panes retain hidden drawings and render again when the pane returns', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.drawingApi;
    function pane() {
      api.chart.addPane({ id: 'secondary' });
      api.chart
        .addSeries('line', { paneId: 'secondary' })
        .setData(api.data.map((p) => ({ time: p.time, value: p.close })));
    }
    pane();
    await api.chart.whenIdle();
    const projection = api.projection(),
      bounds = projection.panes.find((p) => p.id === 'secondary')!;
    api.layer.store.add({
      type: 'horizontal-line',
      paneId: 'secondary',
      points: [
        {
          time: api.data[0]!.time,
          price: projection.yToPrice((bounds.top + bounds.bottom) / 2, 'secondary')!,
        },
      ],
    });
    async function ink() {
      await api.chart.whenIdle();
      const c = document.querySelectorAll('canvas')[1]!;
      return c
        .getContext('2d')!
        .getImageData(0, 0, c.width, c.height)
        .data.some((value, index) => index % 4 === 3 && value > 0);
    }
    const shown = await ink();
    api.chart.removePane('secondary');
    const hidden = await ink();
    pane();
    const returned = await ink();
    return { shown, hidden, returned, count: api.layer.store.list().length };
  });
  expect(result).toEqual({ shown: true, hidden: false, returned: true, count: 1 });
});

test('default style updates the unfinished drawing while existing drawings keep their style', async ({
  page,
}) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('horizontal-line'));
  await page.mouse.click(200, 200);
  await page.evaluate(() => window.drawingApi.layer.setTool('rectangle'));
  await page.mouse.click(300, 250);
  await page.evaluate(() =>
    window.drawingApi.layer.setStyle({ color: '#ff0000', lineWidth: 3, fillOpacity: 0.4 }),
  );
  await page.mouse.click(500, 350);
  const drawings = await page.evaluate(() => window.drawingApi.layer.store.list());
  expect(drawings[0]!.style).toEqual({ color: '#c7ee92', lineWidth: 1.5, fillOpacity: 0.12 });
  expect(drawings[1]!.style).toEqual({ color: '#ff0000', lineWidth: 3, fillOpacity: 0.4 });
});

test('owned drag blocks wheel zoom and commits geometry under the released pointer', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('trend-line'));
  await page.mouse.click(200, 200);
  await page.mouse.click(400, 300);
  const before = await page.evaluate(() => {
    const api = window.drawingApi,
      p = api.projection(),
      d = api.layer.store.list()[0]!;
    const step = p.timeToX(api.data[1]!.time)! - p.timeToX(api.data[0]!.time)!;
    return {
      range: api.chart.getVisibleRange(),
      points: d.points.map((point) => ({
        time: p.logicalIndexToTime(p.timeToLogicalIndex(point.time)! + Math.round(50 / step)),
        price: p.yToPrice(p.priceToY(point.price)! - 30)!,
      })),
    };
  });
  await page.mouse.move(300, 250);
  await page.mouse.down();
  await page.mouse.move(350, 220);
  const wheel = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 350,
      clientY: 220,
      deltaY: -200,
    });
    root.dispatchEvent(event);
    return { prevented: event.defaultPrevented, range: window.drawingApi.chart.getVisibleRange() };
  });
  expect(wheel.prevented).toBe(true);
  expect(wheel.range).toEqual(before.range);
  await page.mouse.up();
  const points = await page.evaluate(() => window.drawingApi.layer.store.list()[0]!.points);
  expect(points.map((p) => p.time)).toEqual(before.points.map((p) => p.time));
  points.forEach((p, i) => expect(p.price).toBeCloseTo(before.points[i]!.price, 9));
});

test('two-click preview blocks wheel until completion and keeps the second anchor under its click', async ({
  page,
}) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('rectangle'));
  await page.mouse.click(200, 200);
  await page.mouse.move(400, 300);
  const before = await page.evaluate(() => ({
    range: window.drawingApi.chart.getVisibleRange(),
    time: window.drawingApi.chart.coordinateToTime(400),
    price: window.drawingApi.chart.coordinateToPrice(300),
  }));
  const wheel = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
      deltaY: -200,
    });
    root.dispatchEvent(event);
    return { prevented: event.defaultPrevented, range: window.drawingApi.chart.getVisibleRange() };
  });
  expect(wheel.prevented).toBe(true);
  expect(wheel.range).toEqual(before.range);
  await page.mouse.click(400, 300);
  const point = await page.evaluate(() => window.drawingApi.layer.store.list()[0]!.points[1]!);
  expect(point.time).toBe(before.time);
  expect(point.price).toBeCloseTo(before.price!, 9);
  const after = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    root.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -200 }),
    );
    return window.drawingApi.chart.getVisibleRange();
  });
  expect(after).not.toEqual(before.range);
});
