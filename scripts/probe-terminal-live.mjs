import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const result = {
  startedAt: new Date().toISOString(),
  source: 'Public Binance Spot',
  query: { symbol: 'BTCUSDT', interval: '1m' },
  status: 'running',
};
const path = 'benchmark-results/v0.5/live-probe-' + stamp + '.json';
mkdirSync('benchmark-results/v0.5', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  let frames = 0;
  cdp.on('Network.webSocketFrameReceived', (event) => {
    try {
      if (JSON.parse(event.response.payloadData).e === 'kline') frames++;
    } catch {}
  });
  await page.goto('http://127.0.0.1:5195/?test=1');
  await page.waitForFunction(
    () => {
      const state = window.terminalHarness?.terminal?.getState();
      return state?.feed.status === 'live' && !state.error;
    },
    {},
    { timeout: 35_000 },
  );
  const deadline = Date.now() + 15_000;
  while (frames < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  assert.ok(frames >= 3, 'At least3 actual WebSocket kline frames');
  result.snapshot = await page.evaluate(async () => {
    const t = window.terminalHarness.terminal;
    await t.chart.whenIdle();
    const data = t.getData();
    return {
      state: t.getState(),
      rows: data.length,
      oldest: data[0].time,
      latest: data.at(-1),
      diagnostics: t.chart.getDiagnostics(),
      canvases: document.querySelectorAll('canvas').length,
    };
  });
  assert.ok(result.snapshot.rows >= 500);
  assert.equal(result.snapshot.canvases, 3);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'docs/assets/terminal-live.png', fullPage: true });
  result.websocketKlineFrames = frames;
  result.archiveInstallation = JSON.parse(
    readFileSync('benchmark-results/v0.5/consumer-install.json', 'utf8'),
  ).candidateRecord;
  result.installedDatafeedSha256 = createHash('sha256')
    .update(readFileSync('examples/react-terminal/node_modules/@filtix/datafeed/dist/index.js'))
    .digest('hex');
  result.teardown = await page.evaluate(() => {
    window.terminalHarness.terminal.destroy();
    return document.querySelectorAll('canvas').length;
  });
  assert.equal(result.teardown, 0);
  result.status = 'pass';
} catch (error) {
  result.status = 'fail';
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  result.finishedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: result.status,
      artifact: path,
      rows: result.snapshot?.rows,
      frames: result.websocketKlineFrames,
      error: result.error,
    }),
  );
}
