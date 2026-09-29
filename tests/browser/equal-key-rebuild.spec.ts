import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(async () => {
    await window.testApi.chart.whenIdle();
    window.testApi.chart.destroy();
  });
});

test('equal-key OHLCV line and area replacement updates values gaps and crosshair without global sorting', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, { width: 800, height: 400, followLatest: false });
    const candles = chart.addSeries('candlestick', { id: 'candles' });
    const line = chart.addSeries('line', { id: 'line', color: '#00aa00', lineWidth: 2 });
    const area = chart.addSeries('area', { id: 'area', color: '#0000aa', lineWidth: 2 });
    const untouched = chart.addSeries('line', { id: 'untouched', color: '#ff00ff', lineWidth: 2 });
    const times = [0, 1000, 2000, 3000, 4000];
    const candleData = times.map((time, index) => ({
      time,
      open: 10 + index,
      high: 13 + index,
      low: 9 + index,
      close: 12 + index,
      volume: 20 + index,
    }));
    candles.setData(candleData);
    line.setData([
      { time: 0, value: 10 },
      { time: 1000, value: 11 },
      { time: 2000 },
      { time: 3000, value: 13 },
      { time: 4000, value: 14 },
    ]);
    area.setData([
      { time: 0, value: 30 },
      { time: 1000 },
      { time: 2000, value: 32 },
      { time: 3000, value: 33 },
      { time: 4000, value: 34 },
    ]);
    untouched.setData([
      { time: 0, value: 40 },
      { time: 1000, value: 41 },
      { time: 3000, value: 43 },
      { time: 4000, value: 44 },
    ]);
    chart.fitContent();
    await chart.whenIdle();

    const context = host.querySelector('canvas')!.getContext('2d')!;
    const originalStroke = context.stroke;
    let untouchedStrokes = 0;
    context.stroke = function (this: CanvasRenderingContext2D, path?: Path2D) {
      if (String(this.strokeStyle).toLowerCase() === '#ff00ff') untouchedStrokes += 1;
      if (path === undefined) (originalStroke as () => void).call(this);
      else (originalStroke as (path: Path2D) => void).call(this, path);
    };
    const originalSort = Array.prototype.sort;
    let sorts = 0;
    Array.prototype.sort = function (this: unknown[], compareFn?: (left: unknown, right: unknown) => number) {
      sorts += 1;
      return originalSort.call(this, compareFn);
    } as typeof originalSort;
    try {
      candles.setData(
        candleData.map((bar) => ({
          ...bar,
          open: bar.open + 10,
          high: bar.high + 10,
          low: bar.low + 10,
          close: bar.close + 10,
          volume: bar.volume + 5,
        })),
      );
      line.setData([
        { time: 0, value: 20 },
        { time: 1000 },
        { time: 2000, value: 22 },
        { time: 3000, value: 23 },
        { time: 4000, value: 24 },
      ]);
      area.setData([
        { time: 0, value: 50 },
        { time: 1000, value: 51 },
        { time: 2000, value: 52 },
        { time: 3000 },
        { time: 4000, value: 54 },
      ]);
    } finally {
      Array.prototype.sort = originalSort;
    }
    await chart.whenIdle();
    context.stroke = originalStroke;

    let crosshair: any = null;
    chart.subscribeCrosshairMove((event) => {
      crosshair = event;
    });
    const points: Record<string, any> = {};
    for (const time of times) {
      chart.setCrosshairTime(time);
      await chart.whenIdle();
      points[String(time)] = crosshair?.points ?? {};
    }
    const output = {
      sorts,
      untouchedStrokes,
      candles: candles.getData(),
      line: line.getData(),
      area: area.getData(),
      untouched: untouched.getData(),
      points,
    };
    chart.destroy();
    return output;
  });

  expect(result.sorts).toBe(0);
  expect(result.untouchedStrokes).toBeGreaterThanOrEqual(2);
  expect(result.candles[1]).toMatchObject({ close: 23, volume: 26 });
  expect(result.points['1000'].candles).toMatchObject({ close: 23, volume: 26 });
  expect(result.points['1000'].line).toBeNull();
  expect(result.points['1000'].area).toEqual({ time: 1000, value: 51 });
  expect(result.points['2000'].line).toEqual({ time: 2000, value: 22 });
  expect(result.points['3000'].area).toBeNull();
  expect(result.untouched).toEqual([
    { time: 0, value: 40 },
    { time: 1000, value: 41 },
    { time: 3000, value: 43 },
    { time: 4000, value: 44 },
  ]);
});

test('equal keys preserve manual fractions and normalize near-pinned follow range with data metadata', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, {
      width: 800,
      height: 400,
      followLatest: true,
    });
    const line = chart.addSeries('line', { id: 'line' });
    const other = chart.addSeries('line', { id: 'other' });
    const values = (offset: number) =>
      Array.from({ length: 10 }, (_, time) => ({ time, value: time + offset }));
    line.setData(values(10));
    other.setData(values(30));
    chart.setVisibleRange({ from: 4.25, to: 8.995 });
    chart.setCrosshairTime(5);
    await chart.whenIdle();
    const rangeEvents: any[] = [];
    const crosshairEvents: any[] = [];
    chart.subscribeVisibleRangeChange((range, meta) => rangeEvents.push({ range, meta }));
    chart.subscribeCrosshairMove((event, meta) => crosshairEvents.push({ event, meta }));
    line.setData(values(20));
    await chart.whenIdle();
    const pinned = chart.getVisibleRange();
    const pinnedRangeEvents = structuredClone(rangeEvents);
    const pinnedCrosshairEvents = structuredClone(crosshairEvents);

    chart.applyOptions({ followLatest: false });
    chart.setVisibleRange({ from: 2.25, to: 6.75 });
    await chart.whenIdle();
    rangeEvents.length = 0;
    crosshairEvents.length = 0;
    line.setData(values(40));
    await chart.whenIdle();
    const output = {
      pinned,
      pinnedRangeEvents,
      pinnedCrosshairEvents,
      manual: chart.getVisibleRange(),
      manualRangeEvents: structuredClone(rangeEvents),
      manualCrosshairEvents: structuredClone(crosshairEvents),
    };
    chart.destroy();
    return output;
  });

  expect(result.pinned.from).toBeCloseTo(4.255, 10);
  expect(result.pinned.to).toBe(9);
  expect(result.pinnedRangeEvents).toHaveLength(1);
  expect(result.pinnedRangeEvents[0].meta.cause).toBe('data');
  expect(result.pinnedCrosshairEvents.at(-1).meta.cause).toBe('data');
  expect(result.pinnedCrosshairEvents.at(-1).event.points.line).toEqual({ time: 5, value: 25 });
  expect(result.manual).toEqual({ from: 2.25, to: 6.75 });
  expect(result.manualRangeEvents).toEqual([]);
  expect(result.manualCrosshairEvents.at(-1).meta.cause).toBe('data');
  expect(result.manualCrosshairEvents.at(-1).event.points.line).toEqual({ time: 5, value: 45 });
});

test('interior key changes use the union fallback in UTC and business-date domains', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const cases = [
      {
        domain: 'utc-ms' as const,
        shared: [0, 1000, 2000, 3000],
        replacement: [0, 1000, 2100, 3000],
        oldInterior: 2000,
        newInterior: 2100,
      },
      {
        domain: 'business-date' as const,
        shared: ['2024-01-01', '2024-01-02', '2024-01-04', '2024-01-05'],
        replacement: ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-05'],
        oldInterior: '2024-01-04',
        newInterior: '2024-01-03',
      },
    ];
    const outputs = [];
    for (const entry of cases) {
      const chart = window.testApi.createChart(host, {
        width: 800,
        height: 400,
        timeDomain: entry.domain,
      });
      const target = chart.addSeries('line', { id: 'target' });
      const survivor = chart.addSeries('line', { id: 'survivor' });
      target.setData(entry.shared.map((time, index) => ({ time, value: 10 + index })) as any);
      survivor.setData(entry.shared.map((time, index) => ({ time, value: 30 + index })) as any);
      chart.fitContent();
      await chart.whenIdle();
      const originalSort = Array.prototype.sort;
      let sorts = 0;
      Array.prototype.sort = function (this: unknown[], ...args: Parameters<typeof originalSort>) {
        sorts += 1;
        return originalSort.apply(this, args as any);
      } as typeof originalSort;
      try {
        target.setData(entry.replacement.map((time, index) => ({ time, value: 20 + index })) as any);
      } finally {
        Array.prototype.sort = originalSort;
      }
      await chart.whenIdle();
      let crosshair: any = null;
      chart.subscribeCrosshairMove((event) => {
        crosshair = event;
      });
      chart.setCrosshairTime(entry.oldInterior as any);
      await chart.whenIdle();
      const oldPoints = structuredClone(crosshair?.points ?? {});
      chart.setCrosshairTime(entry.newInterior as any);
      await chart.whenIdle();
      outputs.push({
        domain: entry.domain,
        sorts,
        data: target.getData(),
        oldPoints,
        newPoints: structuredClone(crosshair?.points ?? {}),
      });
      chart.destroy();
    }
    return outputs;
  });

  for (const result of results) {
    expect(result.sorts).toBeGreaterThan(0);
    expect(result.oldPoints.target).toBeNull();
    expect(result.oldPoints.survivor).toBeDefined();
    expect(result.newPoints.target).toBeDefined();
  }
  expect(results[0]!.data.map((point: any) => point.time)).toEqual([0, 1000, 2100, 3000]);
  expect(results[1]!.data.map((point: any) => point.time)).toEqual([
    '2024-01-01',
    '2024-01-02',
    '2024-01-03',
    '2024-01-05',
  ]);
});

test('superset replacements extend the union once and keep range, gaps, and cursor aligned', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, { width: 800, height: 400, followLatest: false });
    const first = chart.addSeries('line', { id: 'first' });
    const second = chart.addSeries('line', { id: 'second' });
    first.setData([
      { time: 100, value: 1 },
      { time: 300, value: 3 },
      { time: 400, value: 4 },
    ]);
    second.setData([
      { time: 100, value: 10 },
      { time: 200, value: 20 },
      { time: 400, value: 40 },
    ]);
    chart.setVisibleRange({ from: 1, to: 3 });
    chart.setCrosshairTime(300);
    await chart.whenIdle();
    let cursor: any = null;
    chart.subscribeCrosshairMove((event) => {
      cursor = event;
    });
    const originalSort = Array.prototype.sort;
    let sorts = 0;
    Array.prototype.sort = function (this: unknown[], ...args: Parameters<typeof originalSort>) {
      sorts++;
      return originalSort.apply(this, args as any);
    } as typeof originalSort;
    try {
      first.setData([
        { time: 0, value: 0 },
        { time: 100, value: 11 },
        { time: 250 },
        { time: 300, value: 33 },
        { time: 400, value: 44 },
      ]);
      second.setData([
        { time: 0, value: 5 },
        { time: 100, value: 15 },
        { time: 200, value: 25 },
        { time: 250, value: 35 },
        { time: 400, value: 45 },
      ]);
    } finally {
      Array.prototype.sort = originalSort;
    }
    await chart.whenIdle();
    const after = {
      sorts,
      range: chart.getVisibleRange(),
      visibleTimes: chart.getVisibleTimeRange(),
      cursorTime: cursor?.time,
      cursorPoints: structuredClone(cursor?.points ?? {}),
      visibleCoordinates: [200, 250, 300].map((time) => chart.timeToCoordinate(time)),
    };
    chart.setCrosshairTime(250);
    await chart.whenIdle();
    const gapPoints = structuredClone(cursor?.points ?? {});
    chart.destroy();
    return { after, gapPoints };
  });

  expect(result.after.sorts).toBe(0);
  expect(result.after.range).toEqual({ from: 2, to: 4 });
  expect(result.after.visibleTimes).toEqual({ from: 200, to: 300 });
  expect(result.after.cursorTime).toBe(300);
  expect(result.after.cursorPoints.first).toEqual({ time: 300, value: 33 });
  expect(result.after.cursorPoints.second).toBeNull();
  expect(result.after.visibleCoordinates.every((x) => x !== null)).toBe(true);
  expect(result.gapPoints.first).toBeNull();
  expect(result.gapPoints.second).toEqual({ time: 250, value: 35 });
});

test('same-key replacement remains atomic when logarithmic validation fails', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, { width: 800, height: 400 });
    const pane = chart.addPane({ id: 'log', scale: 'log' });
    const line = chart.addSeries('line', { id: 'line', paneId: pane.id });
    const before = [
      { time: 0, value: 1 },
      { time: 1000, value: 2 },
      { time: 2000, value: 4 },
    ];
    line.setData(before);
    chart.fitContent();
    chart.setCrosshairTime(1000);
    await chart.whenIdle();
    let error = '';
    try {
      line.setData([
        { time: 0, value: 1 },
        { time: 1000, value: -2 },
        { time: 2000, value: 4 },
      ]);
    } catch (cause) {
      error = String(cause);
    }
    let crosshair: any = null;
    chart.subscribeCrosshairMove((event) => {
      crosshair = event;
    });
    chart.setCrosshairTime(null);
    chart.setCrosshairTime(1000);
    await chart.whenIdle();
    const output = {
      error,
      data: line.getData(),
      range: chart.getVisibleRange(),
      point: crosshair?.points.line,
    };
    chart.destroy();
    return output;
  });
  expect(result.error).toMatch(/logarithmic|positive/i);
  expect(result.data).toEqual([
    { time: 0, value: 1 },
    { time: 1000, value: 2 },
    { time: 2000, value: 4 },
  ]);
  expect(result.point).toEqual({ time: 1000, value: 2 });
  expect(result.range).toEqual({ from: 0, to: 2 });
});
