import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('real chart timeline adoption matches a fresh chart across outside additions and fallback paths', async ({
  page,
}, testInfo) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);

  const results = await page.evaluate(async () => {
    await window.testApi.chart.whenIdle();
    window.testApi.chart.destroy();
    // Reused and fresh canvases have different readback histories; create both with the same readback policy.
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: any, settings: any) {
      return originalGetContext.call(
        this,
        type,
        type === '2d' ? { ...settings, willReadFrequently: true } : settings,
      );
    } as typeof originalGetContext;

    const domains = [
      {
        name: 'utc-ms' as const,
        base: [1000, 2000, 3000, 4000],
        before: 500,
        earliest: 250,
        after: 4500,
        latest: 5000,
        interior: 2500,
      },
      {
        name: 'business-date' as const,
        base: ['2024-01-30', '2024-02-01', '2024-02-05', '2024-02-07'],
        before: '2024-01-29',
        earliest: '2024-01-26',
        after: '2024-02-08',
        latest: '2024-02-09',
        interior: '2024-02-02',
      },
    ];
    const output = [];
    try {
      for (const domain of domains) {
        const mount = () => {
          const host = document.createElement('div');
          host.style.cssText = 'width:640px;height:360px;';
          document.body.append(host);
          const chart = window.testApi.createChart(host, {
            width: 640,
            height: 360,
            autoSize: false,
            followLatest: false,
            maxPixelRatio: 1,
            timeDomain: domain.name,
            theme: 'dark',
            crosshair: true,
          });
          const line = chart.addSeries('line', { id: 'line', color: '#ef4444', lineWidth: 2 });
          const sparseLine = chart.addSeries('line', {
            id: 'sparse-line',
            color: '#f59e0b',
            lineWidth: 2,
          });
          const area = chart.addSeries('area', { id: 'area', color: '#22c55e', lineWidth: 2 });
          const band = chart.addSeries('band', { id: 'band', color: '#3b82f6', fillOpacity: 0.25 });
          let cursor: any = null;
          chart.subscribeCrosshairMove((event) => {
            cursor = event;
          });
          return { host, chart, line, sparseLine, area, band, cursor: () => cursor };
        };
        const stableLine = [
          { time: domain.base[0]!, value: 40 },
          { time: domain.base[1]! },
          { time: domain.base[3]!, value: 44 },
        ];
        const stableArea = [
          { time: domain.base[0]!, value: 31 },
          { time: domain.base[1]! },
          { time: domain.base[3]!, value: 35 },
        ];
        const stableBand = [
          { time: domain.base[0]!, lower: 14, upper: 22 },
          { time: domain.base[2]! },
          { time: domain.base[3]!, lower: 17, upper: 26 },
        ];
        const stages = [
          { name: 'base', times: [...domain.base], gap: false },
          { name: 'prepend', times: [domain.before, ...domain.base], gap: false },
          { name: 'append', times: [domain.before, ...domain.base, domain.after], gap: false },
          {
            name: 'both-ends',
            times: [domain.earliest, domain.before, ...domain.base, domain.after, domain.latest],
            gap: false,
          },
          {
            name: 'same-keys-presence',
            times: [domain.earliest, domain.before, ...domain.base, domain.after, domain.latest],
            gap: true,
          },
          {
            name: 'interior-insert',
            times: [
              domain.earliest,
              domain.before,
              domain.base[0]!,
              domain.base[1]!,
              domain.interior,
              domain.base[2]!,
              domain.base[3]!,
              domain.after,
              domain.latest,
            ],
            gap: true,
          },
          {
            name: 'interior-remove',
            times: [domain.earliest, domain.before, ...domain.base, domain.after, domain.latest],
            gap: true,
          },
        ];
        const lineData = (stage: (typeof stages)[number]) =>
          stage.times.map((time, index) =>
            stage.gap && time === domain.base[1] ? { time } : { time, value: 8 + index * 2 },
          );
        const pixels = (host: HTMLElement, layer: 'scene' | 'overlay') =>
          host
            .querySelector<HTMLCanvasElement>(`[data-filtix-layer="${layer}"]`)!
            .getContext('2d')!
            .getImageData(0, 0, 640, 360).data;
        const attributes = (host: HTMLElement, layer: 'scene' | 'overlay') => {
          const context = host
            .querySelector<HTMLCanvasElement>(`[data-filtix-layer="${layer}"]`)!
            .getContext('2d')!;
          return typeof context.getContextAttributes === 'function' ? context.getContextAttributes() : null;
        };
        const mismatches = (left: Uint8ClampedArray, right: Uint8ClampedArray) => {
          let count = 0;
          for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) count++;
          return count;
        };
        const incremental = mount();
        try {
          incremental.sparseLine.setData(stableLine as any);
          incremental.area.setData(stableArea as any);
          incremental.band.setData(stableBand as any);
          for (const stage of stages) {
            const fresh = mount();
            try {
              const finalLine = lineData(stage);
              incremental.line.setData(finalLine as any);
              fresh.sparseLine.setData(stableLine as any);
              fresh.area.setData(stableArea as any);
              fresh.band.setData(stableBand as any);
              fresh.line.setData(finalLine as any);
              const range = { from: 0, to: stage.times.length - 1 };
              incremental.chart.setVisibleRange(range);
              fresh.chart.setVisibleRange(range);
              await Promise.all([incremental.chart.whenIdle(), fresh.chart.whenIdle()]);
              const positiveTime = domain.base[0]!;
              const gapTime = domain.base[1]!;
              const cursor = [];
              for (const time of [positiveTime, gapTime]) {
                incremental.chart.setCrosshairTime(time as any);
                fresh.chart.setCrosshairTime(time as any);
                await Promise.all([incremental.chart.whenIdle(), fresh.chart.whenIdle()]);
                cursor.push({
                  incremental: structuredClone(incremental.cursor()),
                  fresh: structuredClone(fresh.cursor()),
                });
              }
              const scene = pixels(incremental.host, 'scene');
              let nonuniformScene = false;
              for (let index = 4; index < scene.length; index += 4)
                if (
                  scene[index] !== scene[0] ||
                  scene[index + 1] !== scene[1] ||
                  scene[index + 2] !== scene[2]
                ) {
                  nonuniformScene = true;
                  break;
                }
              output.push({
                domain: domain.name,
                stage: stage.name,
                expectedLine: finalLine,
                incrementalLine: incremental.line.getData(),
                freshLine: fresh.line.getData(),
                incrementalRange: incremental.chart.getVisibleRange(),
                freshRange: fresh.chart.getVisibleRange(),
                incrementalTimeRange: incremental.chart.getVisibleTimeRange(),
                freshTimeRange: fresh.chart.getVisibleTimeRange(),
                incrementalCoordinates: [positiveTime, gapTime].map((time) =>
                  incremental.chart.timeToCoordinate(time as any),
                ),
                freshCoordinates: [positiveTime, gapTime].map((time) =>
                  fresh.chart.timeToCoordinate(time as any),
                ),
                cursor,
                scenePixelMismatches: mismatches(scene, pixels(fresh.host, 'scene')),
                overlayPixelMismatches: mismatches(
                  pixels(incremental.host, 'overlay'),
                  pixels(fresh.host, 'overlay'),
                ),
                nonuniformScene,
                contextAttributes: {
                  incrementalScene: attributes(incremental.host, 'scene'),
                  freshScene: attributes(fresh.host, 'scene'),
                  incrementalOverlay: attributes(incremental.host, 'overlay'),
                  freshOverlay: attributes(fresh.host, 'overlay'),
                },
              });
            } finally {
              fresh.chart.destroy();
              fresh.host.remove();
            }
          }
        } finally {
          incremental.chart.destroy();
          incremental.host.remove();
        }
      }
      return output;
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  const receiptPath = testInfo.outputPath('timeline-adoption-parity.json');
  writeFileSync(receiptPath, JSON.stringify(results));
  await testInfo.attach('timeline-adoption-parity', { path: receiptPath, contentType: 'application/json' });

  expect(results).toHaveLength(14);
  for (const result of results) {
    const label = `${result.domain}/${result.stage}`;
    expect(result.incrementalLine, label).toEqual(result.expectedLine);
    expect(result.freshLine, label).toEqual(result.expectedLine);
    expect(result.incrementalRange, label).toEqual(result.freshRange);
    expect(result.incrementalTimeRange, label).toEqual(result.freshTimeRange);
    expect(result.incrementalCoordinates, label).toEqual(result.freshCoordinates);
    expect(result.cursor[0]!.incremental, label).toEqual(result.cursor[0]!.fresh);
    expect(result.cursor[1]!.incremental, label).toEqual(result.cursor[1]!.fresh);
    expect(result.cursor[0]!.incremental?.points.line, label).not.toBeNull();
    expect(result.cursor[0]!.incremental?.points['sparse-line'], label).not.toBeNull();
    expect(result.cursor[1]!.incremental?.points['sparse-line'], label).toBeNull();
    expect(result.cursor[1]!.incremental?.points.area, label).toBeNull();
    if (['same-keys-presence', 'interior-insert', 'interior-remove'].includes(result.stage))
      expect(result.cursor[1]!.incremental?.points.line, label).toBeNull();
    expect(result.nonuniformScene, label).toBe(true);
    expect(result.scenePixelMismatches, label).toBe(0);
    expect(result.overlayPixelMismatches, label).toBe(0);
    expect(result.contextAttributes.incrementalScene, label).toEqual(result.contextAttributes.freshScene);
    expect(result.contextAttributes.incrementalOverlay, label).toEqual(result.contextAttributes.freshOverlay);
  }
});
