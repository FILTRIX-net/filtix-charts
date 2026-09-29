import { test, expect } from '@playwright/test';

test('streamed candles render like the same final data loaded at once', async ({ page }) => {
  await page.goto('/test.html');
  await page.waitForFunction(() => !!window.testApi);

  const result = await page.evaluate(async () => {
    await window.testApi.chart.whenIdle();
    window.testApi.chart.destroy();

    const history = [
      { time: 1_700_000_000_000, open: 100, high: 106, low: 97, close: 104, volume: 18 },
      { time: 1_700_000_060_000, open: 104, high: 108, low: 101, close: 102, volume: 23 },
      { time: 1_700_000_120_000, open: 102, high: 112, low: 100, close: 110, volume: 31 },
      { time: 1_700_000_180_000, open: 110, high: 113, low: 105, close: 107, volume: 16 },
      { time: 1_700_000_240_000, open: 107, high: 109, low: 96, close: 99, volume: 42 },
      { time: 1_700_000_300_000, open: 99, high: 105, low: 95, close: 103, volume: 27 },
      { time: 1_700_000_360_000, open: 103, high: 116, low: 101, close: 114, volume: 36 },
      { time: 1_700_000_420_000, open: 114, high: 117, low: 108, close: 109, volume: 21 },
    ];
    const tail = [
      { time: 1_700_000_480_000, open: 109, high: 121, low: 107, close: 119, volume: 39 },
      { time: 1_700_000_540_000, open: 119, high: 123, low: 111, close: 113, volume: 34 },
      { time: 1_700_000_600_000, open: 113, high: 118, low: 104, close: 106, volume: 45 },
      { time: 1_700_000_660_000, open: 106, high: 115, low: 102, close: 112, volume: 29 },
      { time: 1_700_000_720_000, open: 112, high: 126, low: 110, close: 124, volume: 48 },
      { time: 1_700_000_780_000, open: 124, high: 128, low: 115, close: 117, volume: 37 },
    ];
    const replacements = [
      { time: 1_700_000_480_000, open: 109, high: 114, low: 108, close: 112, volume: 7 },
      { time: 1_700_000_540_000, open: 119, high: 122, low: 116, close: 120, volume: 9 },
      { time: 1_700_000_600_000, open: 113, high: 116, low: 109, close: 114, volume: 11 },
      { time: 1_700_000_660_000, open: 106, high: 110, low: 103, close: 108, volume: 8 },
      { time: 1_700_000_720_000, open: 112, high: 118, low: 111, close: 116, volume: 12 },
      { time: 1_700_000_780_000, open: 124, high: 127, low: 120, close: 122, volume: 10 },
    ];

    const mount = () => {
      const host = document.createElement('div');
      document.body.append(host);
      const chart = window.testApi.createChart(host, {
        width: 720,
        height: 420,
        autoSize: false,
        followLatest: false,
        maxPixelRatio: 1,
        theme: 'dark',
      });
      const series = chart.addSeries('candlestick', {
        lastValueVisible: true,
        priceLineVisible: true,
      });
      return { host, chart, series };
    };

    const loaded = mount();
    const streamed = mount();
    try {
      loaded.series.setData([...history, ...tail]);
      streamed.series.setData(history);
      for (let index = 0; index < tail.length; index++) {
        streamed.series.update(replacements[index]!);
        streamed.series.update(tail[index]!);
      }

      const finalRange = { from: 0, to: history.length + tail.length - 1 };
      loaded.chart.setVisibleRange(finalRange);
      streamed.chart.setVisibleRange(finalRange);
      await Promise.all([loaded.chart.whenIdle(), streamed.chart.whenIdle()]);

      const coordinateValues = tail.flatMap((point) => [point.low, point.high, point.open, point.close]);
      const loadedPixels = loaded.host
        .querySelector<HTMLCanvasElement>('[data-filtix-layer="scene"]')!
        .getContext('2d')!
        .getImageData(0, 0, 720, 420).data;
      const streamedPixels = streamed.host
        .querySelector<HTMLCanvasElement>('[data-filtix-layer="scene"]')!
        .getContext('2d')!
        .getImageData(0, 0, 720, 420).data;
      let mismatchedPixelBytes = 0;
      for (let index = 0; index < loadedPixels.length; index++) {
        if (loadedPixels[index] !== streamedPixels[index]) mismatchedPixelBytes++;
      }

      return {
        expected: [...history, ...tail],
        loadedData: loaded.series.getData(),
        streamedData: streamed.series.getData(),
        loadedRange: loaded.chart.getVisibleRange(),
        streamedRange: streamed.chart.getVisibleRange(),
        loadedCoordinates: coordinateValues.map((price) => loaded.chart.priceToCoordinate(price)),
        streamedCoordinates: coordinateValues.map((price) => streamed.chart.priceToCoordinate(price)),
        mismatchedPixelBytes,
      };
    } finally {
      loaded.chart.destroy();
      streamed.chart.destroy();
      loaded.host.remove();
      streamed.host.remove();
    }
  });

  expect(result.loadedData).toEqual(result.expected);
  expect(result.streamedData).toEqual(result.expected);
  expect(result.streamedRange).toEqual(result.loadedRange);
  expect(result.streamedCoordinates).toEqual(result.loadedCoordinates);
  expect(result.mismatchedPixelBytes).toBe(0);
});
