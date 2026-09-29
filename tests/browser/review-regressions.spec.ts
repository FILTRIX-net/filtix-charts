import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
  await page.evaluate(async () => {
    await window.testApi.chart.whenIdle();
    window.testApi.chart.destroy();
  });
});

test('normal and dense line/area paths preserve implicit union gaps with an explicit bridge option', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const results: Array<{ kind: string; dense: boolean; gapWidth: number; bridgedWidth: number }> = [];
    for (const kind of ['line', 'area'] as const)
      for (const dense of [false, true]) {
        const chart = window.testApi.createChart(host, { width: 800, height: 400, followLatest: false });
        const target = chart.addSeries(kind, {
          color: '#13579b',
          lastValueVisible: false,
          priceLineVisible: false,
        });
        const end = dense ? 4096 : 2;
        target.setData([
          { time: 0, value: 10 },
          { time: end, value: 20 },
        ]);
        chart.fitContent();
        await chart.whenIdle();
        const context = host.querySelector('canvas')!.getContext('2d')!;
        const begin = context.beginPath,
          move = context.moveTo,
          line = context.lineTo,
          stroke = context.stroke.bind(context) as () => void;
        let xs: number[] = [],
          widths: number[] = [];
        context.beginPath = function () {
          xs = [];
          begin.call(this);
        };
        context.moveTo = function (x, y) {
          xs.push(x);
          move.call(this, x, y);
        };
        context.lineTo = function (x, y) {
          xs.push(x);
          line.call(this, x, y);
        };
        context.stroke = function () {
          if (this.strokeStyle === '#13579b' && xs.length) widths.push(Math.max(...xs) - Math.min(...xs));
          stroke();
        };
        // Changing another series introduces shared slots after target run metadata already exists.
        chart.addSeries('histogram').setData(Array.from({ length: end + 1 }, (_, time) => ({ time })));
        chart.fitContent();
        await chart.whenIdle();
        const gapWidth = Math.max(0, ...widths);
        widths = [];
        target.applyOptions({ connectGaps: true });
        await chart.whenIdle();
        results.push({ kind, dense, gapWidth, bridgedWidth: Math.max(0, ...widths) });
        chart.destroy();
      }
    return results;
  });
  expect(results).toHaveLength(4);
  for (const row of results) {
    expect(row.gapWidth, JSON.stringify(row)).toBeLessThanOrEqual(1);
    expect(row.bridgedWidth, JSON.stringify(row)).toBeGreaterThan(100);
  }
});

test('axis and crosshair labels honor the first populated series millitick precision', async ({ page }) => {
  const labels = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, { width: 800, height: 400 });
    const labels: Array<{ layer: string; text: string }> = [];
    for (const canvas of host.querySelectorAll('canvas')) {
      const context = canvas.getContext('2d')!,
        original = context.fillText;
      context.fillText = function (text, x, y, maxWidth) {
        if (x > 700 && /^\d+\.\d+$/.test(text)) labels.push({ layer: canvas.dataset.filtixLayer!, text });
        if (maxWidth === undefined) original.call(this, text, x, y);
        else original.call(this, text, x, y, maxWidth);
      };
    }
    chart.addSeries('line', { tickSize: 0.001, pricePrecision: 3 }).setData([
      { time: 0, value: 1.001 },
      { time: 1, value: 1.009 },
    ]);
    chart.fitContent();
    await chart.whenIdle();
    const root = host.querySelector<HTMLElement>('[data-filtix-root]')!,
      rect = root.getBoundingClientRect();
    root.dispatchEvent(
      new PointerEvent('pointermove', { clientX: rect.left + 100, clientY: rect.top + 180, bubbles: true }),
    );
    await chart.whenIdle();
    chart.destroy();
    return labels;
  });
  expect(labels.filter((label) => label.layer === 'scene').length).toBeGreaterThan(2);
  expect(labels.some((label) => label.layer === 'overlay')).toBe(true);
  for (const label of labels) expect(label.text).toMatch(/^\d+\.\d{3}$/);
});

test('history replacement uses the nearest surviving anchor and preserves exact prepended anchors', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const chart = window.testApi.createChart(host, { followLatest: false });
    const series = chart.addSeries('line');
    const values = (times: number[]) => times.map((time) => ({ time, value: 1 }));
    const results = [];
    for (const replacement of [
      [0, 9, 20, 30, 40, 50],
      [0, 11, 20, 30, 40, 50],
      [-10, 0, 10, 20, 30, 40, 50],
    ]) {
      series.setData(values([0, 10, 20, 30, 40, 50]));
      chart.setVisibleRange({ from: 1, to: 3 });
      series.setData(values(replacement));
      await chart.whenIdle();
      results.push(chart.getVisibleRange());
    }
    chart.destroy();
    return results;
  });
  expect(results).toEqual([
    { from: 1, to: 3 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
  ]);
});

test('axis-only plots reject all coordinates and recover after resizing', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('#host')!;
    const results = [];
    for (const dimensions of [
      { width: 800, height: 20 },
      { width: 50, height: 400 },
      { width: 1, height: 1 },
    ]) {
      const chart = window.testApi.createChart(host, dimensions);
      chart.addSeries('line').setData([
        { time: 0, value: 1 },
        { time: 1, value: 2 },
      ]);
      chart.fitContent();
      await chart.whenIdle();
      const empty = [
        chart.timeToCoordinate(0),
        chart.coordinateToTime(8),
        chart.priceToCoordinate(1),
        chart.coordinateToPrice(10),
      ];
      chart.applyOptions({ width: 800, height: 400 });
      await chart.whenIdle();
      const x = chart.timeToCoordinate(0);
      results.push({ empty, recovered: x !== null && chart.coordinateToTime(x) === 0 });
      chart.destroy();
    }
    return results;
  });
  for (const result of results) expect(result).toEqual({ empty: [null, null, null, null], recovered: true });
});

test('timing probes are opt-in and can be enabled and disabled without a remount', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const chart = window.testApi.createChart(document.querySelector<HTMLElement>('#host')!);
    const series = chart.addSeries('line');
    await chart.whenIdle();
    const original = performance.now.bind(performance);
    let probes = 0;
    performance.now = () => {
      probes++;
      return original();
    };
    try {
      series.setData([
        { time: 0, value: 1 },
        { time: 1, value: 2 },
      ]);
      await chart.whenIdle();
      const off = {
        probes,
        timing: [chart.getDiagnostics().lastIngestMs, chart.getDiagnostics().lastRenderMs],
      };
      chart.applyOptions({ diagnostics: true });
      series.update({ time: 2, value: 3 });
      await chart.whenIdle();
      const enabledProbes = probes;
      chart.applyOptions({ diagnostics: false });
      probes = 0;
      series.update({ time: 3, value: 4 });
      await chart.whenIdle();
      return {
        off,
        enabledProbes,
        disabled: {
          probes,
          timing: [chart.getDiagnostics().lastIngestMs, chart.getDiagnostics().lastRenderMs],
        },
      };
    } finally {
      performance.now = original;
      chart.destroy();
    }
  });
  expect(result.off).toEqual({ probes: 0, timing: [0, 0] });
  expect(result.enabledProbes).toBeGreaterThan(0);
  expect(result.disabled).toEqual({ probes: 0, timing: [0, 0] });
});
