import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const port = 5175;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: 'ignore', windowsHide: true },
);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Capture server failed to start');
    try {
      if ((await fetch('http://127.0.0.1:' + port)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Capture server timeout');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + port);
  await page.locator('#chart canvas').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('#loaded-points').textContent.includes('—'));
  mkdirSync('docs/assets', { recursive: true });
  await page.screenshot({ path: 'docs/assets/studio-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Daylight' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'docs/assets/studio-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Midnight' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'docs/assets/studio-mobile.png', fullPage: true });
  const matrixPage = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  matrixPage.on('pageerror', (error) => errors.push(error.message));
  await matrixPage.goto('http://127.0.0.1:' + port + '/test.html');
  await matrixPage.waitForFunction(() => !!window.testApi);
  await matrixPage.evaluate(async () => {
    const { chart, createChart, makeCandles } = window.testApi;
    chart.destroy();
    document.body.replaceChildren();
    document.body.style.cssText =
      'margin:0;padding:20px;background:#dce2df;display:grid;grid-template-columns:1fr 1fr;gap:16px;font:12px Consolas,monospace';
    for (const scenario of [
      '100k dense candles',
      'Sparse area with gaps',
      'Empty chart',
      'Flat negative OHLC',
    ]) {
      for (const theme of ['dark', 'light']) {
        const section = document.createElement('section');
        section.style.cssText =
          'padding:10px;border:1px solid #75827b;border-radius:5px;background:' +
          (theme === 'dark' ? '#11161c' : '#fafcfa');
        const heading = document.createElement('h2');
        heading.textContent = scenario + ' / ' + theme + ' / DPR 2';
        heading.style.cssText =
          'font:12px Consolas,monospace;margin:0 0 8px;color:' + (theme === 'dark' ? '#d7e4dd' : '#25352c');
        const host = document.createElement('div');
        host.style.height = '220px';
        section.append(heading, host);
        document.body.append(section);
        const current = createChart(host, { theme, maxPixelRatio: 2 });
        if (scenario === '100k dense candles') current.addSeries('candlestick').setData(makeCandles(100000));
        else if (scenario === 'Sparse area with gaps') {
          current
            .addSeries('area')
            .setData(
              makeCandles(70).map((p, index) =>
                index % 15 > 10 ? { time: p.time } : { time: p.time, value: p.close },
              ),
            );
        } else if (scenario === 'Flat negative OHLC')
          current.addSeries('ohlc').setData(
            Array.from({ length: 30 }, (_, index) => ({
              time: Date.UTC(2026, 8, 1) + index * 3600000,
              open: -2,
              high: -2,
              low: -2,
              close: -2,
            })),
          );
        current.fitContent();
        await current.whenIdle();
      }
    }
  });
  await matrixPage.screenshot({ path: 'docs/assets/engine-matrix.png', fullPage: true, scale: 'css' });

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Captured desktop dark/light and mobile previews without browser errors.');
} finally {
  await browser?.close();
  server.kill();
}
