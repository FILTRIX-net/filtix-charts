import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(() => window.testApi.chart.whenIdle());
});
test('mounts scoped layers and destroys without touching caller DOM', async ({ page }) => {
  await expect(page.locator('#host canvas')).toHaveCount(2);
  const result = await page.evaluate(async () => {
    const { chart, series } = window.testApi;
    const marker = document.createElement('span');
    marker.textContent = 'owned by caller';
    document.querySelector('#host')!.append(marker);
    const idle = chart.whenIdle();
    chart.destroy();
    chart.destroy();
    await idle;
    let rejected = false;
    try {
      series.update({ time: 0, open: 1, high: 1, low: 1, close: 1 });
    } catch {
      rejected = true;
    }
    return {
      canvases: document.querySelectorAll('#host canvas').length,
      marker: marker.isConnected,
      rejected,
    };
  });
  expect(result).toEqual({ canvases: 0, marker: true, rejected: true });
});
test('invalid replacement and newest-bar update are atomic', async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const { series, chart, data } = window.testApi;
      const before = JSON.stringify(series.getData());
      let errors = 0;
      try {
        series.setData([data[0]!, data[0]!]);
      } catch {
        errors++;
      }
      const last = data[data.length - 1]!;
      try {
        series.update({ ...last, high: last.low - 1 });
      } catch {
        errors++;
      }
      await chart.whenIdle();
      return errors === 2 && JSON.stringify(series.getData()) === before;
    }),
  ).toBe(true);
});
test('theme patches preserve range and source data', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, series } = window.testApi;
    chart.setVisibleRange({ from: 100, to: 200 });
    await chart.whenIdle();
    const before = chart.getVisibleRange();
    const data = JSON.stringify(series.getData());
    chart.applyOptions({ theme: 'light' });
    await chart.whenIdle();
    return {
      sameRange: JSON.stringify(before) === JSON.stringify(chart.getVisibleRange()),
      sameData: data === JSON.stringify(series.getData()),
    };
  });
  expect(result).toEqual({ sameRange: true, sameData: true });
});
test('crosshair reports original candle and redraws only the overlay', async ({ page }) => {
  const position = await page.evaluate(async () => {
    const { chart, data } = window.testApi;
    chart.setVisibleRange({ from: 250, to: 400 });
    await chart.whenIdle();
    return {
      x: chart.timeToCoordinate(data[320]!.time)!,
      before: chart.getDiagnostics().sceneDraws,
      expected: data[320]!,
    };
  });
  await page.mouse.move(position.x, 180);
  await expect.poll(() => page.evaluate(() => window.testApi.crosshair?.time)).toBe(position.expected.time);
  const result = await page.evaluate(() => ({
    event: window.testApi.crosshair,
    draws: window.testApi.chart.getDiagnostics().sceneDraws,
    id: window.testApi.series.id,
  }));
  expect(result.event!.points[result.id]).toEqual(position.expected);
  expect(result.draws).toBe(position.before);
});
test('wheel zoom, drag pan and focused keyboard navigation work', async ({ page }) => {
  const initial = await page.evaluate(() => window.testApi.chart.getVisibleRange());
  await page.mouse.move(500, 220);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = window.testApi.chart.getVisibleRange();
        return r.to - r.from;
      }),
    )
    .toBeLessThan(initial.to - initial.from);
  const beforePan = await page.evaluate(() => window.testApi.chart.getVisibleRange());
  await page.mouse.move(500, 220);
  await page.mouse.down();
  await page.mouse.move(650, 220, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.testApi.chart.getVisibleRange().from))
    .not.toBe(beforePan.from);
  await page.locator('#host [tabindex="0"]').focus();
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => window.testApi.chart.getVisibleRange().from)).toBe(0);
});
test('tail updates coalesce and browsing history stays anchored', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, series, data } = window.testApi;
    chart.setVisibleRange({ from: 50, to: 150 });
    await chart.whenIdle();
    const before = chart.getVisibleRange();
    const draws = chart.getDiagnostics().sceneDraws;
    const last = data[data.length - 1]!;
    for (let i = 1; i <= 100; i++) series.update({ ...last, time: Number(last.time) + i * 3600000 });
    await chart.whenIdle();
    return {
      range: chart.getVisibleRange(),
      before,
      length: series.getData().length,
      draws: chart.getDiagnostics().sceneDraws - draws,
    };
  });
  expect(result.range).toEqual(result.before);
  expect(result.length).toBe(600);
  expect(result.draws).toBe(1);
});
test('panes enforce log policy atomically and remove owned series', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.testApi;
    const pane = chart.addPane({ id: 'oscillator' });
    const line = chart.addSeries('line', { paneId: pane.id });
    line.setData([
      { time: 0, value: -1 },
      { time: 1000, value: 2 },
    ]);
    let rejected = false;
    try {
      pane.applyOptions({ scale: 'log' });
    } catch {
      rejected = true;
    }
    pane.remove();
    await chart.whenIdle();
    let removed = false;
    try {
      line.getData();
    } catch {
      removed = true;
    }
    return { rejected, removed, series: chart.getDiagnostics().seriesCount };
  });
  expect(result).toEqual({ rejected: true, removed: true, series: 1 });
});
test('PNG export is a decoded image of the visible chart', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const blob = await window.testApi.chart.exportImage();
    const bmp = await createImageBitmap(blob);
    const result = { type: blob.type, width: bmp.width, height: bmp.height, size: blob.size };
    bmp.close();
    return result;
  });
  expect(result.type).toBe('image/png');
  expect(result.width).toBeGreaterThanOrEqual(1000);
  expect(result.height).toBeGreaterThanOrEqual(600);
  expect(result.size).toBeGreaterThan(1000);
});
test('zero-size suspension recovers and coordinate conversions round trip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart, data } = window.testApi;
    const target = data[200]!;
    const x = chart.timeToCoordinate(target.time)!;
    const time = chart.coordinateToTime(x);
    const y = chart.priceToCoordinate(target.close)!;
    const price = chart.coordinateToPrice(y)!;
    return {
      time,
      expected: target.time,
      delta: Math.abs(price - target.close),
      outside: chart.coordinateToTime(-1),
    };
  });
  expect(result.time).toBe(result.expected);
  expect(result.delta).toBeLessThan(1e-6);
  expect(result.outside).toBeNull();
  await page.locator('#host').evaluate((el) => {
    (el as HTMLElement).style.width = '0px';
  });
  await expect
    .poll(() =>
      page
        .locator('#host canvas')
        .first()
        .evaluate((el) => (el as HTMLCanvasElement).width),
    )
    .toBe(0);
  await page.locator('#host').evaluate((el) => {
    (el as HTMLElement).style.width = '640px';
  });
  await expect
    .poll(() =>
      page
        .locator('#host canvas')
        .first()
        .evaluate((el) => (el as HTMLCanvasElement).width),
    )
    .toBe(await page.evaluate(() => 640 * Math.min(devicePixelRatio, 2)));
});
test('business dates stay calendar-only and mixed domains fail', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.testApi.chart.destroy();
    const chart = window.testApi.createChart(document.querySelector('#host')!, {
      timeDomain: 'business-date',
      timeZone: 'Pacific/Honolulu',
    });
    const line = chart.addSeries('line');
    line.setData([
      { time: '2024-03-10', value: 2 },
      { time: '2024-03-11', value: 3 },
    ]);
    chart.fitContent();
    await chart.whenIdle();
    const x = chart.timeToCoordinate('2024-03-10')!;
    const time = chart.coordinateToTime(x);
    let errors = 0;
    try {
      line.update({ time: 123, value: 4 });
    } catch {
      errors++;
    }
    try {
      line.update({ time: '2024-02-30', value: 4 });
    } catch {
      errors++;
    }
    chart.destroy();
    return { time, errors };
  });
  expect(result).toEqual({ time: '2024-03-10', errors: 2 });
});
test('independent chart instances and queued destruction do not leak DOM', async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const { createChart, makeCandles } = window.testApi;
      for (let i = 0; i < 30; i++) {
        const el = document.createElement('div');
        el.style.cssText = 'width:300px;height:200px';
        document.body.append(el);
        const chart = createChart(el);
        const s = chart.addSeries('candlestick');
        s.setData(makeCandles(10));
        const pending = chart.whenIdle();
        chart.destroy();
        await pending;
        if (el.childElementCount !== 0) return false;
        el.remove();
      }
      return document.querySelectorAll('canvas').length === 2;
    }),
  ).toBe(true);
});

test('removed handles cannot control replacements with reused public IDs', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { chart } = window.testApi;
    const oldPane = chart.addPane({ id: 'reusable-pane' });
    const oldSeries = chart.addSeries('line', { id: 'reusable-series', paneId: oldPane.id });
    oldSeries.remove();
    const newSeries = chart.addSeries('line', { id: oldSeries.id, paneId: oldPane.id });
    newSeries.setData([{ time: 0, value: 1 }]);
    let rejected = 0;
    try {
      oldSeries.setData([{ time: 0, value: 99 }]);
    } catch {
      rejected++;
    }
    try {
      oldSeries.remove();
    } catch {
      rejected++;
    }
    const value = newSeries.getData()[0];
    oldPane.remove();
    const newPane = chart.addPane({ id: oldPane.id });
    const survivor = chart.addSeries('line', { paneId: newPane.id });
    try {
      oldPane.applyOptions({ scale: 'log' });
    } catch {
      rejected++;
    }
    try {
      oldPane.remove();
    } catch {
      rejected++;
    }
    survivor.setData([{ time: 0, value: -1 }]);
    return { rejected, value, survivor: survivor.getData()[0] };
  });
  expect(result).toEqual({ rejected: 4, value: { time: 0, value: 1 }, survivor: { time: 0, value: -1 } });
});
