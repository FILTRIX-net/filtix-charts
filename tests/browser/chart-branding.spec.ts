import { expect, test } from '@playwright/test';
import type { ChartExportOptions } from '../../packages/charts/src/types';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(() => window.testApi.chart.whenIdle());
});

test('attribution toggles atomically without changing coordinates or sibling charts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, data, createChart } = window.testApi;
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:300px';
    document.body.append(host);
    const other = createChart(host, { attribution: false });
    await other.whenIdle();
    const before = {
      x: chart.timeToCoordinate(data[20]!.time),
      y: chart.priceToCoordinate(100),
      range: chart.getVisibleRange(),
    };
    chart.applyOptions({ attribution: false });
    await chart.whenIdle();
    const hidden =
      document.querySelector('#host a') === null ||
      !(document.querySelector('#host a') as HTMLElement).getClientRects().length;
    chart.applyOptions({ attribution: undefined });
    await chart.whenIdle();
    const stillHidden = !(document.querySelector('#host a') as HTMLElement | null)?.getClientRects().length;
    const rejected: string[] = [];
    for (const attribution of [null, 0, 'false']) {
      try {
        chart.applyOptions({ attribution, width: 900 } as never);
      } catch (error) {
        rejected.push((error as { code: string }).code);
      }
    }
    chart.applyOptions({ attribution: true });
    await chart.whenIdle();
    const after = {
      x: chart.timeToCoordinate(data[20]!.time),
      y: chart.priceToCoordinate(100),
      range: chart.getVisibleRange(),
    };
    const otherHidden = !(host.querySelector('a') as HTMLElement | null)?.getClientRects().length;
    const width = document.querySelector('#host canvas')!.getBoundingClientRect().width;
    other.destroy();
    const cleanup = host.childElementCount;
    host.remove();
    return { before, after, hidden, stillHidden, rejected, width, otherHidden, cleanup };
  });
  expect(result.after).toEqual(result.before);
  expect(result).toMatchObject({
    hidden: true,
    stillHidden: true,
    rejected: ['INVALID_OPTIONS', 'INVALID_OPTIONS', 'INVALID_OPTIONS'],
    width: 1000,
    otherHidden: true,
    cleanup: 0,
  });
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeVisible();
});

test('badge follows first visible pane, theme, tiny sizes and suspension then cleans up', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.testApi;
    const snapshot = () => {
      const badge = document.querySelector('#host a') as HTMLElement;
      const box = badge.getBoundingClientRect();
      const style = getComputedStyle(badge);
      return {
        visible: !!badge.getClientRects().length,
        left: box.left,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        color: style.color,
        background: style.backgroundColor,
      };
    };
    const priceOnly = snapshot();
    chart.addPane({ id: 'volume' });
    await chart.whenIdle();
    const split = snapshot();
    chart.applyPaneLayout({ maximizedPaneId: 'volume' });
    await chart.whenIdle();
    const maximized = snapshot();
    chart.applyOptions({ theme: 'light' });
    await chart.whenIdle();
    const light = snapshot();
    chart.applyOptions({ theme: { text: '#123456', background: '#fedcba' } });
    await chart.whenIdle();
    const custom = snapshot();
    chart.applyOptions({ width: 100, height: 100 });
    await chart.whenIdle();
    const tiny = snapshot();
    chart.applyOptions({ width: 0, height: 0 });
    await chart.whenIdle();
    const suspended = snapshot();
    chart.applyOptions({ width: 360, height: 300 });
    await chart.whenIdle();
    const restored = snapshot();
    chart.destroy();
    chart.destroy();
    return {
      priceOnly,
      split,
      maximized,
      light,
      custom,
      tiny,
      suspended,
      restored,
      children: document.querySelector('#host')!.childElementCount,
    };
  });
  expect(result.priceOnly.visible).toBe(true);
  expect(result.priceOnly.width).toBeLessThanOrEqual(110);
  expect(result.priceOnly.bottom).toBeLessThan(572);
  expect(result.split.bottom).toBeLessThan(286);
  expect(result.split.top).toBeLessThan(result.priceOnly.top);
  expect(result.maximized.top).toBe(result.priceOnly.top);
  expect(result.light.color).not.toBe(result.priceOnly.color);
  expect(result.custom).toMatchObject({ color: 'rgb(18, 52, 86)', background: 'rgb(254, 220, 186)' });
  expect(result.tiny.visible).toBe(false);
  expect(result.suspended.visible).toBe(false);
  expect(result.restored.visible).toBe(true);
  expect(result.restored.bottom).toBeLessThan(272);
  expect(result.children).toBe(0);
});

test('invalid export options reject before waiting or painting and retain caller settings', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.testApi;
    let exportPaints = 0;
    chart.attachPrimitive({
      draw(_context, _projection, mode) {
        if (mode === 'export') exportPaints++;
      },
    });
    await chart.whenIdle();
    const before = chart.getDiagnostics();
    const invalid = [
      null,
      [],
      new Date(),
      1,
      'watermark',
      { unknown: false },
      { unknown: undefined },
      { watermark: null },
      { watermark: 0 },
      { watermark: 'false' },
      Object.assign(Object.create({ watermark: true }), {}),
      { [Symbol('unknown')]: true },
    ];
    const codes: string[] = [];
    for (const options of invalid) {
      try {
        await chart.exportImage(options as never);
      } catch (error) {
        codes.push((error as { code: string }).code);
      }
    }
    const after = chart.getDiagnostics();
    const paintsAfterInvalid = exportPaints;
    let reads = 0;
    const caller = Object.freeze({
      get watermark() {
        reads++;
        return false;
      },
    });
    await chart.exportImage(caller);
    const badgeVisible = !!(document.querySelector('#host a') as HTMLElement).getClientRects().length;
    return { count: invalid.length, codes, before, after, paintsAfterInvalid, reads, badgeVisible };
  });
  expect(result.codes).toEqual(Array(result.count).fill('INVALID_OPTIONS'));
  expect(result.after).toEqual(result.before);
  expect(result.paintsAfterInvalid).toBe(0);
  expect(result.reads).toBe(1);
  expect(result.badgeVisible).toBe(true);
});

for (const dpr of [1, 2]) {
  test.describe(`PNG watermark at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const withPrimitive of [false, true]) {
      test(`decoded pixels stay within brand area and never mutate live canvas (primitives ${withPrimitive})`, async ({
        page,
      }, testInfo) => {
        const result = await page.evaluate(
          async ({ withPrimitive }) => {
            const { chart } = window.testApi;
            if (withPrimitive)
              chart.attachPrimitive({
                draw(context, projection, mode) {
                  if (mode === 'export') {
                    context.fillStyle = '#ff00ff';
                    context.fillRect(0, 0, projection.width, projection.height);
                  }
                },
              });
            await chart.whenIdle();
            const live = document.querySelector<HTMLCanvasElement>('#host [data-filtix-layer="scene"]')!;
            const liveBefore = live.toDataURL();
            const liveLayers = [...document.querySelectorAll<HTMLCanvasElement>('#host canvas')];
            const liveLayersBefore = liveLayers.map((canvas) => canvas.toDataURL());
            const decode = async (options?: ChartExportOptions) => {
              const blob = await chart.exportImage(options);
              const bitmap = await createImageBitmap(blob);
              const canvas = document.createElement('canvas');
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              const context = canvas.getContext('2d')!;
              context.drawImage(bitmap, 0, 0);
              bitmap.close();
              return {
                pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
                url: canvas.toDataURL(),
                width: canvas.width,
                height: canvas.height,
              };
            };
            const bare = await decode({ watermark: false });
            const branded = await decode();
            const explicit = await decode({ watermark: true });
            if (bare.pixels.every((value, index) => value === branded.pixels[index]))
              throw new Error('Default PNG is missing the attribution watermark');
            chart.applyOptions({ attribution: false });
            await chart.whenIdle();
            const optedOut = await decode();
            const override = await decode({ watermark: true });
            const afterOverride = await decode({});
            const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
              a.every((value, index) => value === b[index]);
            let changed = 0,
              outside = 0;
            const ratio = bare.width / 1000;
            for (let i = 0; i < bare.pixels.length; i += 4) {
              if (
                bare.pixels.slice(i, i + 4).every((value, channel) => value === branded.pixels[i + channel])
              )
                continue;
              changed++;
              const x = (i / 4) % bare.width,
                y = Math.floor(i / 4 / bare.width);
              // Independent, generous CSS bound near lower-left; never touch axes or scene elsewhere.
              if (x < 8 * ratio || x >= 118 * ratio || y < 530 * ratio || y >= 562 * ratio) outside++;
            }
            return {
              changed,
              outside,
              width: bare.width,
              height: bare.height,
              plainEqualsLive: bare.url === liveBefore,
              liveUnchanged: liveLayers.every(
                (canvas, index) => canvas.toDataURL() === liveLayersBefore[index],
              ),
              defaultsEqualExplicit: same(branded.pixels, explicit.pixels),
              optedOutEqualBare: same(bare.pixels, optedOut.pixels),
              overrideEqualBranded: same(branded.pixels, override.pixels),
              afterOverrideEqualBare: same(bare.pixels, afterOverride.pixels),
              primitivePixel: [...bare.pixels.slice(0, 4)],
              brandedUrl: branded.url,
            };
          },
          { withPrimitive },
        );
        expect(result.width).toBe(1000 * dpr);
        expect(result.height).toBe(600 * dpr);
        expect(result.changed).toBeGreaterThan(40 * dpr);
        expect(result.outside).toBe(0);
        expect(result.liveUnchanged).toBe(true);
        expect(result.defaultsEqualExplicit).toBe(true);
        expect(result.optedOutEqualBare).toBe(true);
        expect(result.overrideEqualBranded).toBe(true);
        expect(result.afterOverrideEqualBare).toBe(true);
        if (withPrimitive) expect(result.primitivePixel).toEqual([255, 0, 255, 255]);
        else expect(result.plainEqualsLive).toBe(true);
        await testInfo.attach('export.png', {
          body: Buffer.from(result.brandedUrl.split(',')[1]!, 'base64'),
          contentType: 'image/png',
        });
      });
    }
  });
}

test('default attribution is a safe accessible link outside chart input', async ({ page }, testInfo) => {
  const badge = page.getByRole('link', { name: 'FILTRIX.NET', exact: true });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('href', 'https://filtrix.net/');
  await expect(badge).toHaveAttribute('target', '_blank');
  await expect(badge).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await badge.evaluate((node) => node.closest('[data-filtix-root]') === null)).toBe(true);
  await page.locator('[data-filtix-root]').focus();
  await page.keyboard.press('Tab');
  await expect(badge).toBeFocused();
  expect(await badge.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
  // Prevent navigation only; all pointer and keyboard input still reaches the real DOM.
  await badge.evaluate((node) => node.addEventListener('click', (event) => event.preventDefault()));
  const before = await page.evaluate(() => window.testApi.chart.getVisibleRange());
  await badge.click();
  await badge.press('ArrowLeft');
  await badge.press('+');
  await badge.press('Enter');
  await page.evaluate(() => window.testApi.chart.whenIdle());
  expect(await page.evaluate(() => window.testApi.chart.getVisibleRange())).toEqual(before);
  await testInfo.attach('desktop.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('failed construction removes owned DOM and scheduled work', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { createChart } = window.testApi;
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:300px';
    document.body.append(host);
    const originalMatchMedia = window.matchMedia;
    let error = '';
    try {
      window.matchMedia = () => {
        throw new Error('Unavailable media query');
      };
      createChart(host);
    } catch (caught) {
      error = (caught as Error).message;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
    const children = host.childElementCount;
    host.remove();
    return { error, children };
  });
  expect(result).toEqual({ error: 'Unavailable media query', children: 0 });
});

test('unchanged geometry and theme cause no badge DOM writes during data updates', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, series, data } = window.testApi;
    const anchor = document.querySelector('#host a')!;
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(anchor, { attributes: true, childList: true, subtree: true });
    chart.setVisibleRange({ from: 100, to: 300 });
    series.update({ ...data[data.length - 1]!, close: data[data.length - 1]!.close + 1 });
    await chart.whenIdle();
    const writes = records.length + observer.takeRecords().length;
    observer.disconnect();
    return { writes, canvases: document.querySelectorAll('#host canvas').length };
  });
  expect(result).toEqual({ writes: 0, canvases: 2 });
});

test('displaying the badge requests no remote resources', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(new URL(page.url()).origin)) requests.push(request.url());
  });
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(() => window.testApi.chart.whenIdle());
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeVisible();
  expect(requests).toEqual([]);
});

test('mobile attribution remains within plot bounds with visible focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(async () => {
    window.testApi.chart.applyOptions({ width: 360, height: 300, theme: 'light' });
    await window.testApi.chart.whenIdle();
  });
  const badge = page.getByRole('link', { name: 'FILTRIX.NET' });
  await badge.focus();
  const box = await badge.boundingBox();
  expect(box!.x + box!.width).toBeLessThan(288);
  expect(box!.y + box!.height).toBeLessThan(272);
  await testInfo.attach('mobile.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('React chart inherits attribution and forwards changes through its options prop', async ({ page }) => {
  await page.goto('/react-test.html');
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeVisible();
  await page.getByRole('button', { name: 'Change theme' }).click();
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeHidden();
  await page.getByRole('button', { name: 'Change theme' }).click();
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('[data-filtix-attribution]')).toHaveCount(0);
});

test('terminal inherits attribution and exposes opt-out on its chart API', async ({ page }) => {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => !!window.terminalTestApi);
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeVisible();
  await page.evaluate(async () => {
    window.terminalTestApi.terminal.chart.applyOptions({ attribution: false });
    await window.terminalTestApi.terminal.chart.whenIdle();
  });
  await expect(page.getByRole('link', { name: 'FILTRIX.NET' })).toBeHidden();
});
