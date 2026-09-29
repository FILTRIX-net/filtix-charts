import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);
});

test('Canvas legend titles stay inside the plot at 320 CSS pixels', async ({ page }) => {
  const observed = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:320px;height:220px';
    document.body.append(host);
    const original = CanvasRenderingContext2D.prototype.fillText;
    const calls: Array<{ text: string; x: number; width: number }> = [];
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (String(text).startsWith('Overlay')) {
        calls.push({ text: String(text), x, width: this.measureText(String(text)).width });
      }
      return original.call(this, text, x, y, maxWidth);
    };
    try {
      const chart = window.testApi.createChart(host, { autoSize: false, width: 320, height: 220 });
      for (let i = 0; i < 8; i++) chart.addSeries('line', { title: `Overlay ${i} extended indicator title` });
      await chart.whenIdle();
      chart.destroy();
      return calls;
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
      host.remove();
    }
  });
  expect(observed.length).toBeGreaterThan(0);
  expect(
    observed.every(({ x, width }) => x >= 12 && x + width <= 236),
    JSON.stringify(observed),
  ).toBe(true);
});

test('legend stays measured across widths, themes, fonts, patches and zero-size recovery', async ({
  page,
}) => {
  const observations = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:900px;height:220px';
    document.body.append(host);
    const calls: Array<{ text: string; x: number; y: number; width: number; font: string; color: string }> =
      [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^(Study|\+\d)/u.test(String(text)))
        calls.push({
          text: String(text),
          x,
          y,
          width: this.measureText(String(text)).width,
          font: this.font,
          color: String(this.fillStyle),
        });
      return original.call(this, text, x, y, maxWidth);
    };
    try {
      const caller = { maxRows: 1, visible: true };
      const chart = window.testApi.createChart(host, {
        autoSize: false,
        width: 320,
        height: 220,
        diagnostics: true,
        legend: caller,
      });
      for (let i = 0; i < 8; i++)
        chart.addSeries('line', { title: `Study ${i} indicator`, color: '#88aaff' });
      const capture = async () => {
        calls.length = 0;
        await chart.whenIdle();
        return calls.map((call) => ({ ...call }));
      };
      const narrow = await capture();
      caller.maxRows = 4;
      chart.applyOptions({ theme: 'light' });
      const copied = await capture();
      chart.applyOptions({ width: 390, legend: { maxRows: 2 } });
      const medium = await capture();
      chart.applyOptions({ width: 900, theme: 'dark' });
      const wide = await capture();
      chart.applyOptions({ width: 390, theme: { fontSize: 30 } });
      const largeFont = await capture();
      chart.applyOptions({ legend: { visible: false } });
      const hidden = await capture();
      let rejected = false;
      try {
        chart.applyOptions({ legend: { visible: true, maxRows: 0 } });
      } catch {
        rejected = true;
      }
      chart.applyOptions({ theme: 'light' });
      const atomic = await capture();
      chart.applyOptions({ legend: { visible: true }, width: 0, height: 0 });
      const zero = await capture();
      chart.applyOptions({ width: 390, height: 220 });
      const recovered = await capture();
      const canvasCount = host.querySelectorAll('canvas').length;
      chart.destroy();
      return {
        narrow,
        copied,
        medium,
        wide,
        largeFont,
        hidden,
        rejected,
        atomic,
        zero,
        recovered,
        canvasCount,
      };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
      host.remove();
    }
  });
  const bounded = (calls: typeof observations.narrow, right: number) =>
    calls.every((call) => call.x >= 12 && call.x + call.width <= right - 12 && call.y >= 6 && call.y <= 214);
  const truthful = (calls: typeof observations.narrow) => {
    const count = Number(calls.find((call) => /^\+\d+$/u.test(call.text))?.text.slice(1) ?? 0);
    return calls.filter((call) => call.text.startsWith('Study')).length + count === 8;
  };
  expect(observations.narrow.length).toBeGreaterThan(0);
  console.log(
    JSON.stringify({
      kind: 'legend-geometry',
      samples: Object.fromEntries(
        (['narrow', 'copied', 'medium', 'wide', 'largeFont', 'recovered'] as const).map((key) => [
          key,
          {
            count: observations[key].length,
            maxRight: Math.max(...observations[key].map((call) => call.x + call.width)),
            rows: new Set(observations[key].map((call) => call.y)).size,
            marker: observations[key].find((call) => /^\+\d+$/u.test(call.text))?.text ?? null,
          },
        ]),
      ),
    }),
  );
  expect(bounded(observations.narrow, 248)).toBe(true);
  expect(truthful(observations.narrow)).toBe(true);
  expect(
    observations.narrow
      .filter((call) => call.text.startsWith('Study'))
      .every((call) => call.color === '#88aaff'),
  ).toBe(true);
  expect(new Set(observations.copied.map((call) => call.y)).size).toBe(1);
  expect(bounded(observations.copied, 248)).toBe(true);
  expect(bounded(observations.medium, 318)).toBe(true);
  expect(truthful(observations.medium)).toBe(true);
  expect(bounded(observations.wide, 812)).toBe(true);
  expect(observations.wide.filter((call) => call.text.startsWith('Study'))).toHaveLength(8);
  expect(observations.largeFont.length).toBeGreaterThan(0);
  expect(observations.largeFont.every((call) => call.font.includes('30px'))).toBe(true);
  expect(bounded(observations.largeFont, 318)).toBe(true);
  expect(observations.hidden).toHaveLength(0);
  expect(observations.rejected).toBe(true);
  expect(observations.atomic).toHaveLength(0);
  expect(observations.zero).toHaveLength(0);
  expect(observations.recovered.length).toBeGreaterThan(0);
  expect(bounded(observations.recovered, 318)).toBe(true);
  expect(observations.canvasCount).toBe(2);
});

test('maximized-away pane titles disappear and streaming plus crosshair keep scene ownership', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:390px;height:300px';
    document.body.append(host);
    const calls: string[] = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (/^(Price title|Osc title)/u.test(String(text))) calls.push(String(text));
      return original.call(this, text, x, y, maxWidth);
    };
    try {
      const chart = window.testApi.createChart(host, {
        autoSize: false,
        width: 390,
        height: 300,
        diagnostics: true,
      });
      const price = chart.addSeries('line', { title: 'Price title' });
      price.setData([
        { time: 0, value: 1 },
        { time: 1000, value: 2 },
      ]);
      const pane = chart.addPane({ id: 'osc' });
      const osc = chart.addSeries('line', { paneId: pane.id, title: 'Osc title' });
      osc.setData([
        { time: 0, value: 3 },
        { time: 1000, value: 4 },
      ]);
      await chart.whenIdle();
      const initial = [...calls];
      calls.length = 0;
      chart.applyPaneLayout({ maximizedPaneId: pane.id });
      await chart.whenIdle();
      const maximized = [...calls];
      calls.length = 0;
      osc.update({ time: 2000, value: 5 });
      await chart.whenIdle();
      const streamed = [...calls];
      const before = chart.getDiagnostics().sceneDraws;
      chart.setCrosshairTime(1000);
      await chart.whenIdle();
      const after = chart.getDiagnostics().sceneDraws;
      const canvasCount = host.querySelectorAll('canvas').length;
      chart.destroy();
      return { initial, maximized, streamed, before, after, canvasCount };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
      host.remove();
    }
  });
  expect(result.initial).toContain('Price title');
  expect(result.initial).toContain('Osc title');
  expect(result.maximized).toContain('Osc title');
  expect(result.maximized).not.toContain('Price title');
  expect(result.streamed).toContain('Osc title');
  expect(result.after).toBe(result.before);
  expect(result.canvasCount).toBe(2);
});
