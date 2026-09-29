import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = {
  startedAt: new Date().toISOString(),
  source: 'actual public transport, no mocks',
  origin: 'http://127.0.0.1:5173/market.html',
  responses: [],
  streams: [],
  frames: [],
  errors: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => evidence.errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().startsWith('https://data-api.binance.vision/'))
      evidence.responses.push({
        url: response.url(),
        status: response.status(),
        cors: response.headers()['access-control-allow-origin'],
      });
  });
  page.on('websocket', (socket) => {
    evidence.streams.push(socket.url());
    socket.on('framereceived', (event) => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value.e === 'kline')
          evidence.frames.push({
            receivedAt: new Date().toISOString(),
            symbol: value.s,
            interval: value.k.i,
            time: value.k.t,
            revision: value.k.n,
            close: value.k.c,
          });
      } catch {}
    });
  });
  await page.goto(evidence.origin);
  await page
    .locator('#market-status')
    .filter({ hasText: /^Live$/ })
    .waitFor({ timeout: 45000 });
  const deadline = Date.now() + 30000;
  while (evidence.frames.length < 3 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  if (evidence.frames.length < 3) throw new Error('Fewer than three actual stream frames');
  evidence.screen = await page.locator('.market-shell').innerText();
  evidence.price = await page.locator('#market-price').innerText();
  evidence.status = await page.locator('#market-status').innerText();
  evidence.bars = await page.locator('#market-bars').innerText();
  mkdirSync('docs/assets', { recursive: true });
  await page.screenshot({ path: 'docs/assets/market-dark.png', fullPage: true });
  await page.locator('#market-theme').click();
  await page.screenshot({ path: 'docs/assets/market-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/assets/market-mobile.png', fullPage: true });
  evidence.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (evidence.errors.length || evidence.mobileOverflow || evidence.status !== 'Live')
    throw new Error('Live-screen acceptance failed');
  evidence.result = 'pass';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  mkdirSync('docs/releases', { recursive: true });
  writeFileSync('docs/releases/v0.2-network.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  await browser.close();
}
