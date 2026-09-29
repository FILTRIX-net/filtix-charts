import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/drawing-test.html');
  await page.waitForFunction(() => !!window.drawingApi);
  await page.evaluate(() => window.drawingApi.chart.whenIdle());
});

test('advanced tools complete after their required clicks', async ({ page }) => {
  for (const [tool, count] of [
    ['text-note', 1],
    ['fibonacci-retracement', 2],
    ['parallel-channel', 3],
  ] as const) {
    await page.evaluate((value) => window.drawingApi.layer.setTool(value), tool);
    for (let i = 0; i < count; i++) {
      await page.mouse.click(220 + i * 100, 180 + i * 35);
      expect(
        await page.evaluate(
          (value) => window.drawingApi.layer.store.list().filter((d) => d.type === value).length,
          tool,
        ),
      ).toBe(i === count - 1 ? 1 : 0);
    }
    const result = await page.evaluate(
      (value) => ({
        drawing: window.drawingApi.layer.store.list().find((d) => d.type === value),
        state: window.drawingApi.layer.getState(),
      }),
      tool,
    );
    expect(result.drawing?.points).toHaveLength(count);
    expect(result.state.tool).toBe('select');
  }
});

test('locked drawing selects without moving and hidden drawing restores by ID', async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.drawingApi,
      p = api.projection();
    const id = api.layer.store.add({
      type: 'horizontal-line',
      locked: true,
      points: [{ time: api.data[20]!.time, price: p.yToPrice(220)! }],
    });
    return { id, original: api.layer.store.get(id) };
  });
  await page.mouse.move(300, 220);
  await page.mouse.down();
  await page.mouse.move(300, 180);
  await page.mouse.up();
  expect(await page.evaluate(() => window.drawingApi.layer.getState().selectedId)).toBe(result.id);
  expect(await page.evaluate((id) => window.drawingApi.layer.store.get(id), result.id)).toEqual(
    result.original,
  );
  await page.evaluate((id) => window.drawingApi.layer.store.update(id, { visible: false }), result.id);
  expect(await page.evaluate(() => window.drawingApi.layer.getState().selectedId)).toBe(result.id);
  await page.evaluate((id) => window.drawingApi.layer.store.update(id, { visible: true }), result.id);
  expect(await page.evaluate((id) => window.drawingApi.layer.store.get(id)?.visible, result.id)).toBe(true);
});

test('new tool handles edit one real anchor and one undo restores it', async ({ page }) => {
  for (const tool of ['fibonacci-retracement', 'parallel-channel', 'text-note'] as const) {
    const setup = await page.evaluate((type) => {
      const api = window.drawingApi,
        p = api.projection();
      const points = [
        { time: api.data[20]!.time, price: p.yToPrice(180)! },
        { time: api.data[30]!.time, price: p.yToPrice(240)! },
        { time: api.data[40]!.time, price: p.yToPrice(160)! },
      ].slice(0, type === 'text-note' ? 1 : type === 'parallel-channel' ? 3 : 2);
      const id = api.layer.store.add({ type, points });
      return {
        id,
        original: api.layer.store.get(id)!,
        handles: points.map((point) => ({
          x: p.timeToX(point.time)!,
          y: p.priceToY(point.price)!,
        })),
      };
    }, tool);
    for (let index = 0; index < setup.handles.length; index++) {
      const handle = setup.handles[index]!;
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 24, handle.y + 15, { steps: 4 });
      await page.mouse.up();
      const changed = await page.evaluate((id) => window.drawingApi.layer.store.get(id), setup.id);
      expect(changed?.points[index]).not.toEqual(setup.original.points[index]);
      expect(changed?.points.filter((point, i) => i !== index)).toEqual(
        setup.original.points.filter((point, i) => i !== index),
      );
      await page.keyboard.press('Control+z');
      expect(await page.evaluate((id) => window.drawingApi.layer.store.get(id), setup.id)).toEqual(
        setup.original,
      );
    }
    await page.evaluate((id) => window.drawingApi.layer.store.remove(id), setup.id);
  }
});

test('magnet snaps inside threshold, ignores farther points, and survives provider reentry', async ({
  page,
}) => {
  const setup = await page.evaluate(() => {
    const api = window.drawingApi,
      p = api.projection();
    api.layer.destroy();
    const store = api.createDrawingStore();
    const target = { time: api.data[30]!.time, price: p.yToPrice(200)! };
    let reenter = false,
      calls = 0;
    api.layer = api.createDrawingLayer(api.chart, {
      store,
      magnet: true,
      snapDistance: 10,
      snapProvider: () => {
        calls++;
        if (reenter) {
          reenter = false;
          store.add({ type: 'horizontal-line', points: [target] });
        }
        return [{ ...target, field: 'close' }];
      },
    });
    (window as unknown as { armSnapReentry?: () => void }).armSnapReentry = () => {
      reenter = true;
    };
    return { target, x: p.timeToX(target.time)!, y: p.priceToY(target.price)! };
  });
  await page.evaluate(() => window.drawingApi.layer.setTool('horizontal-line'));
  await page.mouse.click(setup.x, setup.y + 8);
  const snapped = await page.evaluate(() => window.drawingApi.layer.store.list()[0]!);
  expect(snapped.points[0]).toEqual(setup.target);
  await page.evaluate(() => window.drawingApi.layer.setTool('horizontal-line'));
  await page.mouse.click(setup.x, setup.y + 16);
  const unsnapped = await page.evaluate(() => window.drawingApi.layer.store.list()[1]!);
  expect(unsnapped.points[0]!.price).not.toBe(setup.target.price);
  await page.evaluate(() => {
    const api = window.drawingApi;
    (window as unknown as { armSnapReentry?: () => void }).armSnapReentry?.();
    api.layer.setTool('horizontal-line');
  });
  await page.mouse.click(setup.x, setup.y);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list().length)).toBe(3);
});

test('advanced unfinished gestures cancel on Escape, blur, and store removal', async ({ page }) => {
  await page.evaluate(() => window.drawingApi.layer.setTool('parallel-channel'));
  await page.mouse.click(220, 180);
  await page.mouse.click(320, 230);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
  await page.evaluate(() => window.drawingApi.layer.setTool('fibonacci-retracement'));
  await page.mouse.click(220, 180);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.click(320, 230);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
  await page.evaluate(() => {
    const api = window.drawingApi;
    api.layer.setTool('parallel-channel');
  });
  await page.mouse.click(220, 180);
  const id = await page.evaluate(() => {
    const api = window.drawingApi;
    return api.layer.store.add({
      type: 'horizontal-line',
      points: [{ time: api.data[20]!.time, price: 100 }],
    });
  });
  await page.evaluate((value) => window.drawingApi.layer.store.remove(value), id);
  await page.mouse.click(320, 230);
  expect(await page.evaluate(() => window.drawingApi.layer.store.list())).toEqual([]);
});

test('three-click channel uses frozen logarithmic coordinates after viewport changes', async ({ page }) => {
  const setup = await page.evaluate(async () => {
    const api = window.drawingApi;
    api.layer.destroy();
    api.chart.addPane({ id: 'log', scale: 'log', weight: 3 });
    api.chart
      .addSeries('line', { paneId: 'log' })
      .setData(api.data.map((bar, i) => ({ time: bar.time, value: 10 + i * 3 })));
    api.layer = api.createDrawingLayer(api.chart, { paneId: 'log' });
    await api.chart.whenIdle();
    const p = api.projection();
    const points = [
      { x: p.timeToX(api.data[20]!.time)!, y: p.priceToY(40, 'log')! },
      { x: p.timeToX(api.data[30]!.time)!, y: p.priceToY(80, 'log')! },
      { x: p.timeToX(api.data[40]!.time)!, y: p.priceToY(60, 'log')! },
    ];
    const root = document.querySelector<HTMLElement>('[data-filtix-root]')!;
    const actual: Array<{ time: number | string | null; price: number | null }> = [];
    window.addEventListener(
      'pointerup',
      (event) => {
        const rect = root.getBoundingClientRect();
        actual.push({
          time: p.xToTime(event.clientX - rect.left),
          price: p.yToPrice(event.clientY - rect.top, 'log'),
        });
      },
      true,
    );
    (window as unknown as { frozenClicks?: typeof actual }).frozenClicks = actual;
    return { points };
  });
  await page.evaluate(() => window.drawingApi.layer.setTool('parallel-channel'));
  await page.mouse.click(setup.points[0]!.x, setup.points[0]!.y);
  await page.evaluate(() => window.drawingApi.chart.setVisibleRange({ from: 10, to: 60 }));
  await page.mouse.click(setup.points[1]!.x, setup.points[1]!.y);
  await page.mouse.click(setup.points[2]!.x, setup.points[2]!.y);
  const result = await page.evaluate(() => ({
    points: window.drawingApi.layer.store.list()[0]?.points,
    expected: (
      window as unknown as { frozenClicks: Array<{ time: number | string | null; price: number | null }> }
    ).frozenClicks,
  }));
  expect(result.points?.map((point) => point.time)).toEqual(result.expected.map((point) => point.time));
  result.points?.forEach((point, i) => expect(point.price).toBeCloseTo(result.expected[i]!.price!, 9));
});

test('magnet snaps handles and never queries provider for body translation', async ({ page }) => {
  const setup = await page.evaluate(() => {
    const api = window.drawingApi,
      p = api.projection();
    api.layer.destroy();
    const target = { time: api.data[25]!.time, price: p.yToPrice(180)! };
    let calls = 0;
    api.layer = api.createDrawingLayer(api.chart, {
      magnet: true,
      snapProvider: () => {
        calls++;
        return [{ ...target, field: 'high' }];
      },
    });
    const points = [
      { time: api.data[20]!.time, price: p.yToPrice(200)! },
      { time: api.data[40]!.time, price: p.yToPrice(270)! },
    ];
    const id = api.layer.store.add({ type: 'trend-line', points });
    (window as unknown as { snapCalls?: () => number }).snapCalls = () => calls;
    return {
      id,
      target,
      first: { x: p.timeToX(points[0]!.time)!, y: p.priceToY(points[0]!.price)! },
      snap: { x: p.timeToX(target.time)!, y: p.priceToY(target.price)! },
      body: {
        x: (p.timeToX(points[0]!.time)! + p.timeToX(points[1]!.time)!) / 2,
        y: (p.priceToY(points[0]!.price)! + p.priceToY(points[1]!.price)!) / 2,
      },
    };
  });
  await page.mouse.move(setup.first.x, setup.first.y);
  await page.mouse.down();
  await page.mouse.move(setup.snap.x, setup.snap.y + 6);
  await page.mouse.up();
  expect((await page.evaluate((id) => window.drawingApi.layer.store.get(id), setup.id))?.points[0]).toEqual(
    setup.target,
  );
  const before = await page.evaluate(() => (window as unknown as { snapCalls: () => number }).snapCalls());
  const body = await page.evaluate((id) => {
    const api = window.drawingApi,
      p = api.projection(),
      points = api.layer.store.get(id)!.points;
    return {
      x: (p.timeToX(points[0]!.time)! + p.timeToX(points[1]!.time)!) / 2,
      y: (p.priceToY(points[0]!.price)! + p.priceToY(points[1]!.price)!) / 2,
    };
  }, setup.id);
  await page.mouse.move(body.x, body.y);
  await page.mouse.down();
  await page.mouse.move(body.x + 20, body.y + 10);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as unknown as { snapCalls: () => number }).snapCalls())).toBe(
    before,
  );
});

test('PNG includes committed Fibonacci but excludes selection and unfinished channel', async ({ page }) => {
  const before = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await window.drawingApi.chart.exportImage()).arrayBuffer())),
  );
  await page.evaluate(() => window.drawingApi.layer.setTool('fibonacci-retracement'));
  await page.mouse.click(220, 180);
  await page.mouse.click(420, 290);
  const selected = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await window.drawingApi.chart.exportImage()).arrayBuffer())),
  );
  expect(selected).not.toEqual(before);
  await page.evaluate(() => window.drawingApi.layer.select(null));
  const plain = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await window.drawingApi.chart.exportImage()).arrayBuffer())),
  );
  expect(selected).toEqual(plain);
  await page.evaluate(() => window.drawingApi.layer.setTool('parallel-channel'));
  await page.mouse.click(500, 190);
  await page.mouse.click(600, 240);
  await page.mouse.move(650, 310);
  const preview = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await window.drawingApi.chart.exportImage()).arrayBuffer())),
  );
  expect(preview).toEqual(plain);
});

test('channel fills its projected polygon and Fibonacci paints ratio and price labels', async ({ page }) => {
  const paint = await page.evaluate(async () => {
    const api = window.drawingApi,
      p = api.projection();
    const a = { time: api.data[20]!.time, price: p.yToPrice(200)! };
    const b = { time: api.data[40]!.time, price: p.yToPrice(200)! };
    const c = { time: api.data[20]!.time, price: p.yToPrice(300)! };
    api.layer.store.add({ type: 'parallel-channel', points: [a, b, c] });
    await api.chart.whenIdle();
    const canvas = document.querySelectorAll('canvas')[1]!;
    const centerX = (p.timeToX(a.time)! + p.timeToX(b.time)!) / 2;
    const centerY = (p.priceToY(a.price)! + p.priceToY(c.price)!) / 2;
    const alpha = canvas
      .getContext('2d')!
      .getImageData(Math.round(centerX * p.dpr), Math.round(centerY * p.dpr), 1, 1).data[3];
    const labels: string[] = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      labels.push(String(text));
      return original.call(this, text, ...args);
    };
    try {
      api.layer.store.add({
        type: 'fibonacci-retracement',
        points: [
          { time: api.data[20]!.time, price: p.yToPrice(180)! },
          { time: api.data[40]!.time, price: p.yToPrice(300)! },
        ],
      });
      await api.chart.whenIdle();
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }
    return { alpha, labels };
  });
  expect(paint.alpha).toBeGreaterThan(0);
  expect(paint.labels.some((label) => label.includes('% · '))).toBe(true);
});

test('a default price-pane layer edits a saved logarithmic channel handle in its own pane', async ({
  page,
}) => {
  const setup = await page.evaluate(async () => {
    const api = window.drawingApi;
    api.chart.addSeries('line').setData(
      api.data.map((bar, index) => ({
        time: bar.time,
        value: index % 2 === 0 ? 1 : 1000,
      })),
    );
    api.chart.addPane({ id: 'log', scale: 'log', weight: 3 });
    api.chart.addSeries('line', { paneId: 'log' }).setData(
      api.data.map((bar, index) => ({
        time: bar.time,
        value: 1.1 ** (index * 0.7),
      })),
    );
    await api.chart.whenIdle();
    const p = api.projection();
    const points = [
      { time: api.data[20]!.time, price: 10 },
      { time: api.data[40]!.time, price: 10 },
      { time: api.data[60]!.time, price: 12 },
    ];
    const id = api.layer.store.add({ type: 'parallel-channel', paneId: 'log', points });
    const x = p.timeToX(points[2]!.time)!,
      y = p.priceToY(points[2]!.price, 'log')!;
    const expected = p.yToPrice(y - 12, 'log')!;
    return {
      id,
      x,
      y,
      original: points,
      trueGap: Math.abs(p.priceToY(10, 'log')! - p.priceToY(expected, 'log')!),
      wrongGap: Math.abs(p.priceToY(10, 'price')! - p.priceToY(expected, 'price')!),
    };
  });
  expect(setup.trueGap).toBeGreaterThan(2);
  expect(setup.wrongGap).toBeLessThan(2);
  await page.mouse.move(setup.x, setup.y);
  await page.mouse.down();
  await page.mouse.move(setup.x, setup.y - 12, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate((id) => window.drawingApi.layer.store.get(id)!, setup.id);
  expect(after.points[0]).toEqual(setup.original[0]);
  expect(after.points[1]).toEqual(setup.original[1]);
  expect(after.points[2]!.price).toBeGreaterThan(setup.original[2]!.price);
  await page.keyboard.press('Control+z');
  expect((await page.evaluate((id) => window.drawingApi.layer.store.get(id)!, setup.id)).points).toEqual(
    setup.original,
  );
});
