import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/primitive-test.html');
  await page.waitForFunction(() => !!window.primitiveTestApi);
  await page.evaluate(() => window.primitiveTestApi.chart.whenIdle());
});

test('attaches one ordered annotation layer and detaches it cleanly', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    const calls: string[] = [];
    const first = {
      draw() {
        calls.push('first');
      },
    };
    const second = {
      draw() {
        calls.push('second');
      },
    };
    const detachFirst = chart.attachPrimitive(first);
    const detachSecond = chart.attachPrimitive(second);
    await chart.whenIdle();
    const attached = {
      layers: [...document.querySelectorAll<HTMLCanvasElement>('#host canvas')].map(
        (canvas) => canvas.dataset.filtixLayer,
      ),
      calls: [...calls],
      diagnostics: chart.getDiagnostics(),
    };
    detachFirst();
    detachFirst();
    detachSecond();
    return { attached, remaining: document.querySelectorAll('#host canvas').length };
  });
  expect(result.attached.layers).toEqual(['scene', 'annotation', 'overlay']);
  expect(result.attached.calls).toEqual(['first', 'second']);
  expect(result.attached.diagnostics.primitiveCount).toBe(2);
  expect(result.attached.diagnostics.primitiveDraws).toBeGreaterThanOrEqual(2);
  expect(result.remaining).toBe(2);
});

test('projection is immutable and maps unloaded, offscreen values precisely', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, series, data } = window.primitiveTestApi;
    let saved: any;
    chart.setVisibleRange({ from: 250, to: 400 });
    await chart.whenIdle();
    const detach = chart.attachPrimitive({
      draw() {},
      attach(host) {
        saved = host.getProjection();
      },
    });
    await chart.whenIdle();
    const expectedFirst = data[0]!.time;
    const before = {
      time: saved.logicalIndexToTime(0),
      x: saved.timeToX(data[0]!.time),
      offscreen: saved.timeToX(data[0]!.time),
      highY: saved.priceToY(1e9),
      inverse: saved.yToPrice(-100),
      missing: saved.timeToLogicalIndex(123456789),
    };
    series.update({ ...data[data.length - 1]!, time: Number(data[data.length - 1]!.time) + 3600000 });
    await chart.whenIdle();
    const after = { oldLast: saved.logicalIndexToTime(500), currentLast: chart.getVisibleRange().to };
    detach();
    return { before, after, expectedFirst };
  });
  expect(result.before.time).toBe(result.expectedFirst);
  expect(result.before.x).toBeLessThan(0);
  expect(result.before.highY).not.toBeNull();
  expect(result.before.inverse).not.toBeNull();
  expect(result.before.missing).toBeNull();
  expect(result.after.oldLast).toBeNull();
});

test('crosshair movement leaves primitive paint clean while invalidation repaints only primitives', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    let host: any;
    chart.attachPrimitive({
      draw() {},
      attach(value) {
        host = value;
      },
    });
    await chart.whenIdle();
    const before = chart.getDiagnostics();
    host.invalidate();
    await chart.whenIdle();
    const afterInvalidation = chart.getDiagnostics();
    return { before, afterInvalidation };
  });
  expect(result.afterInvalidation.sceneDraws).toBe(result.before.sceneDraws);
  expect(result.afterInvalidation.primitiveDraws).toBeGreaterThan(result.before.primitiveDraws);
});

test('export includes primitive export paint and fails when export paint throws', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    chart.attachPrimitive({
      draw(context, projection, mode) {
        if (mode === 'export') {
          context.fillStyle = '#ff00ff';
          context.fillRect(0, 0, 20, 20);
        }
      },
    });
    const blob = await chart.exportImage();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixel = context.getImageData(2, 2, 1, 1).data;
    chart.attachPrimitive({
      draw(_context, _projection, mode) {
        if (mode === 'export') throw new Error('export');
      },
    });
    let rejected = false;
    try {
      await chart.exportImage();
    } catch {
      rejected = true;
    }
    return { pixel: [...pixel], rejected };
  });
  expect(result.pixel.slice(0, 3)).toEqual([255, 0, 255]);
  expect(result.rejected).toBe(true);
});

test('rejects duplicate and invalid primitives and runs cleanup once through destruction', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { chart } = window.primitiveTestApi;
    let cleanup = 0;
    const primitive = {
      draw() {},
      attach() {
        return () => {
          cleanup++;
        };
      },
    };
    chart.attachPrimitive(primitive);
    let duplicate = false,
      invalid = false;
    try {
      chart.attachPrimitive(primitive);
    } catch {
      duplicate = true;
    }
    try {
      chart.attachPrimitive({ draw: null } as any);
    } catch {
      invalid = true;
    }
    chart.destroy();
    return { cleanup, duplicate, invalid };
  });
  expect(result).toEqual({ cleanup: 1, duplicate: true, invalid: true });
});

test('rolls back a failed annotation context allocation and permits a later attach', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () {
      return null;
    };
    let rejected = false;
    try {
      chart.attachPrimitive({ draw() {} });
    } catch {
      rejected = true;
    }
    HTMLCanvasElement.prototype.getContext = original;
    const afterFailure = document.querySelectorAll('#host canvas').length;
    const detach = chart.attachPrimitive({ draw() {} });
    await chart.whenIdle();
    const result = {
      rejected,
      afterFailure,
      attached: document.querySelectorAll('#host canvas').length,
      primitiveCount: chart.getDiagnostics().primitiveCount,
    };
    detach();
    return result;
  });
  expect(result.rejected).toBe(true);
  expect(result.afterFailure).toBe(2);
  expect(result.attached).toBe(3);
  expect(result.primitiveCount).toBe(1);
});

test('preserves an invalidation requested from primitive draw for the next frame', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    let host: any;
    let draws = 0;
    chart.attachPrimitive({
      attach(value) {
        host = value;
      },
      draw() {
        draws++;
        if (draws === 1) host.invalidate();
      },
    });
    await chart.whenIdle();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { draws, primitiveDraws: chart.getDiagnostics().primitiveDraws };
  });
  expect(result.draws).toBe(2);
  expect(result.primitiveDraws).toBeGreaterThanOrEqual(2);
});

test('crosshair movement repaints only the overlay', async ({ page }) => {
  const before = await page.evaluate(async () => {
    const { chart } = window.primitiveTestApi;
    chart.attachPrimitive({ draw() {} });
    await chart.whenIdle();
    return chart.getDiagnostics();
  });
  await page.mouse.move(450, 220);
  await expect
    .poll(() => page.evaluate(() => window.primitiveTestApi.chart.getDiagnostics().overlayDraws))
    .toBeGreaterThan(before.overlayDraws);
  const after = await page.evaluate(() => window.primitiveTestApi.chart.getDiagnostics());
  expect(after.primitiveDraws).toBe(before.primitiveDraws);
});

test('runs reentrant attach cleanup exactly once when attachment destroys the chart', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.primitiveTestApi;
    let cleanup = 0;
    chart.attachPrimitive({
      draw() {},
      attach() {
        chart.destroy();
        return () => {
          cleanup++;
        };
      },
    });
    return { cleanup, canvases: document.querySelectorAll('#host canvas').length };
  });
  expect(result).toEqual({ cleanup: 1, canvases: 0 });
});
