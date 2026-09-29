import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/band-test.html');
  await page.waitForFunction(() => !!window.bandTestApi);
  await page.evaluate(() => window.bandTestApi.chart.whenIdle());
});

test('band API validates options, bounds, log panes, domains, crosshair, updates, and removed handles', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.bandTestApi;
    let chart = api.reset({ width: 500, height: 320, crosshair: true });
    const errorCodes: string[] = [];
    for (const options of [
      { lastValueVisible: true },
      { priceLineVisible: true },
      { fillOpacity: -0.1 },
      { fillOpacity: 1.1 },
    ]) {
      try {
        chart.addSeries('band', options);
      } catch (error) {
        errorCodes.push((error as { code?: string }).code ?? '');
      }
    }
    const band = chart.addSeries('band', {
      id: 'envelope',
      color: '#3366aa',
      fillOpacity: 0.2,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    band.setData([
      { time: 1, lower: 10, upper: 20 },
      { time: 2, lower: 11, upper: 19 },
    ]);
    band.update({ time: 2, lower: 12, upper: 21 });
    const beforeInvalid = JSON.stringify(band.getData());
    try {
      band.update({ time: 2, lower: 22, upper: 21 });
    } catch (error) {
      errorCodes.push((error as { code?: string }).code ?? '');
    }
    const invalidUnchanged = JSON.stringify(band.getData()) === beforeInvalid;
    const getterReads = { time: 0, lower: 0, upper: 0 };
    band.update({
      get time() {
        getterReads.time += 1;
        return getterReads.time === 1 ? 3 : 0;
      },
      get lower() {
        getterReads.lower += 1;
        return getterReads.lower === 1 ? 13 : 30;
      },
      get upper() {
        getterReads.upper += 1;
        return getterReads.upper === 1 ? 23 : 20;
      },
    });
    let crosshair: any = null;
    chart.subscribeCrosshairMove((event) => {
      crosshair = event;
    });
    chart.fitContent();
    chart.setCrosshairTime(3);
    await chart.whenIdle();

    const logPane = chart.addPane({ id: 'log-band', scale: 'log' });
    const logBand = chart.addSeries('band', { paneId: logPane.id });
    logBand.setData([{ time: 1, lower: 1, upper: 2 }]);
    const logBefore = JSON.stringify(logBand.getData());
    try {
      logBand.update({ time: 2, lower: 0, upper: 2 });
    } catch (error) {
      errorCodes.push((error as { code?: string }).code ?? '');
    }
    const linearPane = chart.addPane({ id: 'linear-band' });
    const negative = chart.addSeries('band', { paneId: linearPane.id });
    negative.setData([{ time: 1, lower: -2, upper: 2 }]);
    try {
      linearPane.applyOptions({ scale: 'log' });
    } catch (error) {
      errorCodes.push((error as { code?: string }).code ?? '');
    }
    await chart.whenIdle();
    const linearStillMapsNegative = chart.priceToCoordinate(-1, linearPane.id) !== null;
    const utc = {
      data: band.getData(),
      crosshair: crosshair?.points.envelope,
      unchanged: invalidUnchanged,
      logUnchanged: JSON.stringify(logBand.getData()) === logBefore,
      linearStillMapsNegative,
      getterReads,
    };
    band.remove();
    let removed = false;
    try {
      band.getData();
    } catch (error) {
      removed = (error as { code?: string }).code === 'REMOVED';
    }

    chart.destroy();
    chart = api.reset({ timeDomain: 'business-date', crosshair: true });
    const dated = chart.addSeries('band', { id: 'dated' });
    dated.setData([
      { time: '2026-09-10', lower: 4, upper: 8 },
      { time: '2026-09-11', lower: 5, upper: 9 },
    ]);
    let datedCrosshair: any = null;
    chart.subscribeCrosshairMove((event) => {
      datedCrosshair = event;
    });
    chart.fitContent();
    chart.setCrosshairTime('2026-09-11');
    await chart.whenIdle();
    return {
      errorCodes,
      utc,
      removed,
      datedTime: datedCrosshair?.time,
      datedPoint: datedCrosshair?.points.dated,
      canvases: api.canvasMetrics().count,
    };
  });

  expect(result.errorCodes).toEqual([
    'INVALID_OPTIONS',
    'INVALID_OPTIONS',
    'INVALID_OPTIONS',
    'INVALID_OPTIONS',
    'INVALID_DATA',
    'INVALID_LOG_DATA',
    'INVALID_LOG_DATA',
  ]);
  expect(result.utc).toEqual({
    data: [
      { time: 1, lower: 10, upper: 20 },
      { time: 2, lower: 12, upper: 21 },
      { time: 3, lower: 13, upper: 23 },
    ],
    crosshair: { time: 3, lower: 13, upper: 23 },
    unchanged: true,
    logUnchanged: true,
    linearStillMapsNegative: true,
    getterReads: { time: 1, lower: 1, upper: 1 },
  });
  expect(result.removed).toBe(true);
  expect(result.datedTime).toBe('2026-09-11');
  expect(result.datedPoint).toEqual({ time: '2026-09-11', lower: 5, upper: 9 });
  expect(result.canvases).toBe(2);
});

test('equal-key band replacement preserves range and refreshes the controlled crosshair', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const chart = window.bandTestApi.reset({ followLatest: false, crosshair: true });
    const band = chart.addSeries('band', { id: 'equal-band' });
    band.setData(Array.from({ length: 10 }, (_, time) => ({ time, lower: time + 10, upper: time + 20 })));
    chart.setVisibleRange({ from: 2.25, to: 6.75 });
    chart.setCrosshairTime(5);
    await chart.whenIdle();
    const before = chart.getVisibleRange();
    const revision = chart.getChangeRevision();
    const ranges: unknown[] = [];
    let crosshair: any = null;
    chart.subscribeVisibleRangeChange((range) => ranges.push(range));
    chart.subscribeCrosshairMove((event) => {
      crosshair = event;
    });
    band.setData(Array.from({ length: 10 }, (_, time) => ({ time, lower: time + 30, upper: time + 40 })));
    await chart.whenIdle();
    return {
      before,
      after: chart.getVisibleRange(),
      ranges,
      revisionAdvanced: chart.getChangeRevision() > revision,
      point: crosshair?.points['equal-band'],
    };
  });
  expect(result.after).toEqual(result.before);
  expect(result.ranges).toEqual([]);
  expect(result.revisionAdvanced).toBe(true);
  expect(result.point).toEqual({ time: 5, lower: 35, upper: 45 });
});

test('band fill stays between boundaries, breaks at gaps, and paints behind price strokes', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.bandTestApi;
    const range = chart.addSeries('band', { color: '#ffffff', fillOpacity: 0 });
    range.setData(Array.from({ length: 5 }, (_, time) => ({ time, lower: 0, upper: 40 })));
    const band = chart.addSeries('band', { color: '#0044cc', fillOpacity: 0.6 });
    band.setData([
      { time: 0, lower: 10, upper: 30 },
      { time: 1, lower: 10, upper: 30 },
      { time: 2 },
      { time: 4, lower: 10, upper: 30 },
    ]);
    let invalidApply = '';
    try {
      band.applyOptions({ color: '#ff0000', lastValueVisible: true });
    } catch (error) {
      invalidApply = (error as { code?: string }).code ?? '';
    }
    const line = chart.addSeries('line', { color: '#ff0000', lineWidth: 4 });
    line.setData(Array.from({ length: 5 }, (_, time) => ({ time, value: 20 })));
    chart.fitContent();
    await chart.whenIdle();
    const x0 = chart.timeToCoordinate(0)!;
    const x1 = chart.timeToCoordinate(1)!;
    const x2 = chart.timeToCoordinate(2)!;
    const x3 = chart.timeToCoordinate(3)!;
    const yInside = chart.priceToCoordinate(25)!;
    const yOutside = chart.priceToCoordinate(35)!;
    const yLine = chart.priceToCoordinate(20)!;
    return {
      interior: window.bandTestApi.scenePixel((x0 + x1) / 2, yInside),
      explicitGap: window.bandTestApi.scenePixel(x2, yInside),
      implicitGap: window.bandTestApi.scenePixel(x3, yInside),
      exterior: window.bandTestApi.scenePixel((x0 + x1) / 2, yOutside),
      line: window.bandTestApi.scenePixel(x1, yLine),
      invalidApply,
    };
  });
  expect(result.invalidApply).toBe('INVALID_OPTIONS');
  expect(result.interior[2]!).toBeGreaterThan(result.interior[0]!);
  expect(result.explicitGap.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.implicitGap.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.exterior.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.line[0]).toBeGreaterThan(220);
  expect(result.line[1]).toBeLessThan(80);
  expect(result.line[2]).toBeLessThan(80);
});

test('connectGaps, zero opacity, pane clipping, DPR, and export use the shared scene', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.bandTestApi;
    const chart = api.reset({ width: 480, height: 320, maxPixelRatio: 2 });
    const pane = chart.addPane({ id: 'lower', minHeight: 100 });
    const range = chart.addSeries('band', { paneId: pane.id, fillOpacity: 0 });
    range.setData(Array.from({ length: 5 }, (_, time) => ({ time, lower: 0, upper: 40 })));
    const connected = chart.addSeries('band', {
      paneId: pane.id,
      color: '#008800',
      fillOpacity: 1,
      connectGaps: true,
    });
    connected.setData([
      { time: 0, lower: 10, upper: 30 },
      { time: 1, lower: 10, upper: 30 },
      { time: 2 },
      { time: 4, lower: 10, upper: 30 },
    ]);
    const invisible = chart.addSeries('band', { paneId: pane.id, color: '#ff0000', fillOpacity: 0 });
    invisible.setData(Array.from({ length: 5 }, (_, time) => ({ time, lower: 12, upper: 28 })));
    chart.fitContent();
    await chart.whenIdle();
    const x = chart.timeToCoordinate(2)!;
    const y = chart.priceToCoordinate(20, pane.id)!;
    const screen = api.scenePixel(x, y);
    const abovePane = api.scenePixel(x, 5);
    const exported = await api.exportPixel(x, y);
    return { screen, abovePane, exported, metrics: api.canvasMetrics() };
  });
  expect(result.screen[1]!).toBeGreaterThan(result.screen[0]!);
  expect(result.abovePane.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.exported.rgba).toEqual(result.screen);
  expect(result.metrics.count).toBe(2);
  expect(result.metrics.width / result.metrics.cssWidth).toBeCloseTo(Math.min(result.metrics.dpr, 2), 5);
  expect(result.exported.width).toBe(result.metrics.width);
  expect(result.exported.height).toBe(result.metrics.height);
});

test('dense band geometry preserves a narrow envelope and independent extrema', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.bandTestApi;
    const chart = api.reset({ width: 180, height: 300 });
    const band = chart.addSeries('band', { color: '#000000', fillOpacity: 1 });
    const points = Array.from({ length: 1000 }, (_, time) => ({ time, lower: 49, upper: 51 }));
    points[500] = { time: 500, lower: 10, upper: 51 };
    points[501] = { time: 501, lower: 49, upper: 90 };
    band.setData(points);
    chart.fitContent();
    await chart.whenIdle();
    const spikeX = chart.timeToCoordinate(501)!;
    const ordinaryX = chart.timeToCoordinate(800)!;
    const upperRegion = api.regionCoverage(
      spikeX - 3,
      spikeX + 3,
      chart.priceToCoordinate(85)!,
      chart.priceToCoordinate(60)!,
    );
    const lowerRegion = api.regionCoverage(
      chart.timeToCoordinate(500)! - 3,
      chart.timeToCoordinate(500)! + 3,
      chart.priceToCoordinate(40)!,
      chart.priceToCoordinate(15)!,
    );
    const ordinaryHighRegion = api.regionCoverage(
      ordinaryX - 3,
      ordinaryX + 3,
      chart.priceToCoordinate(85)!,
      chart.priceToCoordinate(60)!,
    );
    return {
      upperSpike: api.darkestScenePixel(spikeX, chart.priceToCoordinate(75)!),
      lowerSpike: api.darkestScenePixel(chart.timeToCoordinate(500)!, chart.priceToCoordinate(25)!),
      ordinaryHigh: api.scenePixel(ordinaryX, chart.priceToCoordinate(75)!),
      ordinaryBand: api.darkestScenePixel(ordinaryX, chart.priceToCoordinate(50)!),
      upperRegion,
      lowerRegion,
      ordinaryHighRegion,
    };
  });
  expect(result.upperSpike[0]).toBeLessThan(250);
  expect(result.lowerSpike[0]).toBeLessThan(250);
  expect(result.upperRegion.nonBackground).toBeGreaterThan(0);
  expect(result.lowerRegion.nonBackground).toBeGreaterThan(0);
  expect(result.ordinaryHighRegion.nonBackground).toBe(0);
  expect(result.ordinaryHigh.slice(0, 3)).toEqual([255, 255, 255]);
  expect(result.ordinaryBand[0]).toBeLessThan(100);
});

test('default fill opacity is visible while explicit zero stays transparent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { chart } = window.bandTestApi;
    const range = chart.addSeries('band', { fillOpacity: 0 });
    range.setData([
      { time: 0, lower: 0, upper: 40 },
      { time: 1, lower: 0, upper: 40 },
    ]);
    const band = chart.addSeries('band', { color: '#000000' });
    band.setData([
      { time: 0, lower: 10, upper: 30 },
      { time: 1, lower: 10, upper: 30 },
    ]);
    chart.fitContent();
    await chart.whenIdle();
    const x = (chart.timeToCoordinate(0)! + chart.timeToCoordinate(1)!) / 2;
    return window.bandTestApi.scenePixel(x, chart.priceToCoordinate(20)!);
  });
  expect(result[0]).toBeGreaterThanOrEqual(215);
  expect(result[0]).toBeLessThanOrEqual(225);
  expect(result[1]).toBe(result[0]);
  expect(result[2]).toBe(result[0]);
});
