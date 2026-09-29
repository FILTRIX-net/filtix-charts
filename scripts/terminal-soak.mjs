import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createServer } from 'node:net';
const root = fileURLToPath(new URL('../', import.meta.url));
const minutes = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? 60);
assert.ok(Number.isFinite(minutes) && minutes >= 2 && minutes <= 120);
const duration = minutes * 60_000;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = resolve(root, 'benchmark-results/v0.5/terminal-soak-' + stamp + '.json');
const origin = 'http://127.0.0.1:5195';
const profile = resolve(root, '.superpowers/terminal-soak-profile-' + stamp);
mkdirSync(profile, { recursive: true });
mkdirSync(resolve(root, 'benchmark-results/v0.5'), { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
  );
const identities = [];
const report = {
  schema: 'filtix-terminal-soak',
  version: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  requestedMinutes: minutes,
  qualification:
    minutes >= 60
      ? 'real elapsed sustained-session desktop smoke'
      : 'short preflight, not hour qualification',
  platform: os.platform(),
  os: os.release(),
  cpu: os.cpus()[0]?.model,
  identities,
  events: [],
  samples: [],
  errors: [],
  visibility: [],
  checks: {},
  limitations: [
    'No physical mobile/laptop hardware qualification',
    'Synthetic wall-clock authority; live Binance checked separately',
    'Forward recovery plus explicitly delivered older corrections; no arbitrary historical correction discovery',
  ],
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const event = (name, detail = {}) => {
  report.events.push({ name, at: new Date().toISOString(), ...detail });
  save();
  console.log(
    JSON.stringify({
      event: name,
      label: detail.label,
      status: detail.status,
      rows: detail.rows,
      rendered: detail.rendered,
      elapsedMs: detail.elapsedMs,
      hiddenMs: detail.hiddenMs,
      actualSessionMs: detail.actualSessionMs,
    }),
  );
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let serverLog = '';
let spawnError;
let chrome;
let browser;
let page;
let context;
let cdp;
let cover;
let begin;
const waitFor = async (fn, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error('Condition timed out');
};
const ready = () =>
  page.waitForFunction(
    () => {
      const t = window.terminalHarness?.terminal;
      return t && !t.getState().destroyed && t.getState().feed.status === 'live' && !t.getState().error;
    },
    {},
    { timeout: 30_000 },
  );
async function sample(label, full = false) {
  await page.bringToFront();
  await ready();
  const start = Date.now();
  const result = await page.evaluate(
    async ({ label, full }) => {
      const h = window.terminalHarness,
        t = h.terminal,
        f = h.fixture;
      f.gate(true);
      try {
        const state = t.getState(),
          query = state.feed.query;
        const now = f.flush(query);
        await t.chart.whenIdle();
        const data = t.getData();
        const truth = f
          .history(query, now)
          .filter((b) => b.time >= data[0].time && b.time <= data.at(-1).time);
        const dataMatches = JSON.stringify(data) === JSON.stringify(truth);
        const view = t.chart.getVisibleRange();
        const follow = t.getSettings().followLatest;
        t.chart.setVisibleRange({ from: -1, to: data.length });
        await t.chart.whenIdle();
        const values = [];
        let event;
        const off = t.chart.subscribeCrosshairMove((value) => (event = value));
        const indices = full
          ? data.map((_, i) => i)
          : [0, Math.min(19, data.length - 1), Math.floor(data.length / 2), data.length - 1];
        try {
          t.chart.setCrosshairTime(null);
          await t.chart.whenIdle();
          for (const i of indices) {
            event = undefined;
            t.chart.setCrosshairTime(data[i].time);
            await t.chart.whenIdle();
            values.push({
              index: i,
              time: event?.time,
              price: event?.points['terminal-price'] ?? null,
              volume: event?.points['terminal-volume'] ?? null,
              ema: event?.points['terminal-ema'] ?? null,
            });
          }
        } finally {
          off();
          t.chart.setCrosshairTime(null);
          t.chart.setVisibleRange(view);
          t.chart.applyOptions({ followLatest: follow });
          await t.chart.whenIdle();
        }
        return {
          label,
          now,
          state: t.getState(),
          stats: f.stats(),
          data,
          truth,
          dataMatches,
          rendered: values,
          diagnostics: t.chart.getDiagnostics(),
          canvases: document.querySelectorAll('canvas').length,
          visibility: document.visibilityState,
        };
      } finally {
        f.gate(false);
      }
    },
    { label, full },
  );
  assert.equal(result.dataMatches, true, label + ': complete authoritative OHLCV mismatch');
  const period = result.state.settings.emaPeriod;
  let sum = 0;
  let emaValue;
  const expected = [];
  for (let i = 0; i < result.truth.length; i++) {
    const v = result.truth[i].close;
    if (period === null) {
      expected.push(null);
      continue;
    }
    if (i < period) {
      sum += v;
      if (i === period - 1) emaValue = sum / period;
    } else emaValue = v * (2 / (period + 1)) + emaValue * (1 - 2 / (period + 1));
    expected.push(emaValue ?? null);
  }
  for (const value of result.rendered) {
    const bar = result.truth[value.index];
    assert.equal(value.time, bar.time, label + ': rendered time');
    assert.ok(value.price, label + ': missing candle');
    for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'])
      assert.equal(value.price[key], bar[key], label + ': rendered ' + key);
    if (result.state.settings.volume) assert.equal(value.volume?.value, bar.volume, label + ': volume');
    const wanted = expected[value.index];
    if (wanted === null) assert.equal(value.ema, null, label + ': EMA warmup');
    else
      assert.ok(
        Math.abs(value.ema?.value - wanted) <= Math.max(1e-9, Math.abs(wanted) * 1e-12),
        label + ': EMA divergence',
      );
  }
  assert.equal(result.canvases, 3, label + ': owned canvases');
  assert.equal(result.stats.activeSubscriptions, 1);
  assert.ok(result.stats.activeRequests <= 1);
  assert.equal(result.state.error, null);
  await cdp.send('HeapProfiler.collectGarbage');
  const resources = await cdp.send('Memory.getDOMCounters');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const { data, truth, ...summary } = result;
  report.samples.push({
    ...summary,
    elapsedMs: Date.now() - begin,
    samplingMs: Date.now() - start,
    rows: data.length,
    actualHash: digest(JSON.stringify(data)),
    authoritativeHash: digest(JSON.stringify(truth)),
    checkedRenderedPoints: result.rendered.length,
    resources,
    heap: { usedSize: heap.usedSize, totalSize: heap.totalSize },
    full,
  });
  event('oracle-pass', {
    label,
    rows: data.length,
    rendered: result.rendered.length,
    elapsedMs: Date.now() - begin,
  });
}
async function hiddenRecovery(ms, label) {
  await page.bringToFront();
  await ready();
  const before = await page.evaluate(() => {
    const h = window.terminalHarness;
    const d = h.terminal.getData();
    h.fixture.setConnected(false);
    return {
      query: h.terminal.getState().feed.query,
      lastTime: d.at(-1).time,
      firstTime: d[0].time,
      times: d.map((b) => b.time),
      rows: d.length,
    };
  });
  await cover.bringToFront();
  await waitFor(() => page.evaluate(() => document.visibilityState === 'hidden'));
  const hiddenAt = Date.now();
  event('background-start', { label, before, hiddenAt });
  await delay(ms);
  await page.evaluate(() => window.terminalHarness.fixture.setConnected(true));
  await page.bringToFront();
  await waitFor(() => page.evaluate(() => document.visibilityState === 'visible'));
  await ready();
  const after = await page.evaluate(() => {
    const h = window.terminalHarness;
    const d = h.terminal.getData();
    return {
      lastTime: d.at(-1).time,
      firstTime: d[0].time,
      times: d.map((b) => b.time),
      rows: d.length,
      events: h.visibility,
    };
  });
  assert.ok(
    after.lastTime > before.lastTime,
    'Background return must include wall-clock candles created while hidden',
  );
  assert.ok(after.rows >= before.rows, 'Recovery must preserve loaded backfill');
  assert.equal(after.firstTime, before.firstTime, 'Recovery lost earliest history');
  const recovered = new Set(after.times);
  assert.ok(
    before.times.every((time) => recovered.has(time)),
    'Recovery lost loaded timestamps',
  );
  report.visibility = after.events;
  event('background-recovered', { label, hiddenMs: Date.now() - hiddenAt, before, after });
  await sample(label, true);
}
try {
  save();
  const artifactFiles = [
    ...files(resolve(root, 'examples/react-terminal/dist')),
    ...files(resolve(root, 'examples/react-terminal/node_modules/@filtix')).filter((p) =>
      /dist[\\/]index\.js$/.test(p),
    ),
    ...['core', 'charts', 'indicators', 'react', 'datafeed', 'drawings', 'analysis', 'terminal'].map((name) =>
      resolve(root, 'dist/packages/filtix-' + name + '-0.5.0.tgz'),
    ),
    resolve(root, 'benchmark-results/v0.5/consumer-install.json'),
    resolve(root, 'scripts/terminal-soak.mjs'),
    resolve(root, 'examples/react-terminal/package-lock.json'),
  ];
  identities.push(
    ...artifactFiles.map((path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: digest(readFileSync(path)),
      bytes: readFileSync(path).length,
    })),
  );

  const install = JSON.parse(
    readFileSync(resolve(root, 'benchmark-results/v0.5/consumer-install.json'), 'utf8'),
  );
  for (const item of install.archives)
    assert.equal(digest(readFileSync(item.path)), item.sha256, 'Installed archive identity mismatch');
  report.installationRecord = install.candidateRecord;
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(5195, '127.0.0.1', () => probe.close(resolve));
  });
  server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5195', '--strictPort'],
    { cwd: resolve(root, 'examples/react-terminal'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  server.stdout.on('data', (s) => (serverLog += s));
  server.stderr.on('data', (s) => (serverLog += s));
  server.on('error', (error) => {
    spawnError = error;
  });

  await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw Error(serverLog);
    if (!serverLog.includes('Local:')) return false;
    try {
      return (await fetch(origin)).ok;
    } catch {
      return false;
    }
  });
  const chromePath =
    process.env.FILTIX_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  chrome = spawn(
    chromePath,
    [
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=10,10',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  chrome.on('error', (error) => {
    spawnError = error;
  });
  let cdpPort;
  let cdpPath;
  await waitFor(async () => {
    if (spawnError) throw spawnError;
    try {
      [cdpPort, cdpPath] = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      return Boolean(cdpPort && cdpPath);
    } catch {
      return false;
    }
  });
  const endpoint = 'http://127.0.0.1:' + cdpPort;
  const version = await (await fetch(endpoint + '/json/version')).json();
  assert.ok(version.webSocketDebuggerUrl.endsWith(cdpPath), 'Owned profile CDP identity');
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  report.browser = browser.version();
  context = browser.contexts()[0];
  page = context.pages()[0];
  cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) => {
    report.errors.push({ kind: 'pageerror', message: String(error), at: Date.now() });
    save();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      report.errors.push({ kind: 'console', message: message.text(), at: Date.now() });
      save();
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/?source=fixture&test=1');
  await page.bringToFront();
  await ready();
  cover = await context.newPage();
  await cover.goto('about:blank');
  await page.bringToFront();
  begin = Date.now();
  report.sessionStart = begin;
  event('session-start', { durationMs: duration });
  await sample('initial', true);
  await page.evaluate(async () => {
    const h = window.terminalHarness;
    const oldFirst = h.terminal.getData()[0].time;
    await h.terminal.loadMore();
    if (h.terminal.getData()[0].time >= oldFirst) throw Error('Backfill did not extend oldest history');
    const data = h.terminal.getData();
    h.terminal
      .getDrawings()
      .add({ type: 'horizontal-line', points: [{ time: data.at(-1).time, price: data.at(-1).close }] });
    h.terminal.applySettings({ theme: 'light', emaPeriod: 34 });
  });
  await sample('backfill-settings', true);
  await page.evaluate(() => {
    const h = window.terminalHarness;
    const t = h.terminal;
    h.fixture.correct(t.getState().feed.query, t.getData()[20].time);
  });
  await sample('historical-stream-correction', true);
  await hiddenRecovery(minutes >= 60 ? 180_000 : 65_000, 'native-background-gap');
  await page.evaluate(async () => {
    const h = window.terminalHarness;
    const saved = h.terminal.getWorkspace();
    h.fixture.setDelay(150);
    const attempts = [];
    for (let i = 0; i < 18; i++)
      attempts.push(
        h.terminal.setMarket({
          symbol: ['ETHUSDT', 'SOLUSDT', 'BTCUSDT'][i % 3],
          interval: ['5m', '1h', '1m'][i % 3],
        }),
      );
    await Promise.all(attempts);
    h.fixture.setDelay(12);
    await h.terminal.restoreWorkspace(saved);
  });
  const staleEvidence = await page.evaluate(async () => {
    const h = window.terminalHarness,
      t = h.terminal,
      f = h.fixture,
      saved = t.getWorkspace();
    f.holdNextHistory();
    const old = t.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
    await t.setMarket({ symbol: 'SOLUSDT', interval: '1h' });
    f.gate(true);
    const before = { state: t.getState(), data: t.getData(), stats: f.stats() };
    const delivered = await f.releaseLateHistory();
    await old;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = { state: t.getState(), data: t.getData(), stats: f.stats() };
    if (
      !delivered ||
      JSON.stringify(before.state) !== JSON.stringify(after.state) ||
      JSON.stringify(before.data) !== JSON.stringify(after.data) ||
      before.stats.requests !== after.stats.requests ||
      before.stats.subscriptions !== after.stats.subscriptions
    )
      throw Error('Cancelled old history mutated active market before restore');
    const stale = f.deliverLate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterStream = { state: t.getState(), data: t.getData(), stats: f.stats() };
    if (
      !stale ||
      JSON.stringify(after.state) !== JSON.stringify(afterStream.state) ||
      JSON.stringify(after.data) !== JSON.stringify(afterStream.data) ||
      after.stats.requests !== afterStream.stats.requests ||
      after.stats.subscriptions !== afterStream.stats.subscriptions
    )
      throw Error('Cancelled old stream mutated active market or reconnected');
    f.gate(false);
    await t.restoreWorkspace(saved);
    return {
      oldHistoryCompleted: delivered,
      staleStream: stale,
      unchangedActiveQuery: after.state.feed.query,
      requests: afterStream.stats.requests,
      subscriptions: afterStream.stats.subscriptions,
    };
  });
  event('stale-callback-oracle-pass', staleEvidence);
  await sample('rapid-switch-restored', true);
  await page.evaluate(() => {
    const h = window.terminalHarness,
      t = h.terminal;
    const bar = h.fixture.correct(t.getState().feed.query, t.getData()[30].time, false);
    t.applyCorrections([bar]);
  });
  await sample('explicit-older-correction', true);
  let secondHidden = false;
  let sampleIndex = 0;
  while (Date.now() - begin < duration) {
    if (minutes >= 60 && !secondHidden && Date.now() - begin >= duration / 2) {
      secondHidden = true;
      await hiddenRecovery(330_000, 'extended-native-background-gap');
      continue;
    }
    await delay(Math.min(45_000, Math.max(1, duration - (Date.now() - begin))));
    await sample('sustained-' + ++sampleIndex, false);
  }
  await sample('final', true);
  report.actualSessionMs = Date.now() - begin;
  assert.ok(report.actualSessionMs >= duration);
  const chartBox = await page.locator('[data-terminal-chart]').boundingBox();
  assert.ok(chartBox);
  await page.mouse.move(chartBox.x + chartBox.width / 2, chartBox.y + chartBox.height / 2);
  const interactionMs = [];
  for (let i = 0; i < 24; i++) {
    const previousRange = await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange());
    const started = Date.now();
    await page.mouse.wheel(0, i % 2 ? 100 : -100);
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await window.terminalHarness.terminal.chart.whenIdle();
    });
    interactionMs.push(Date.now() - started);
    assert.notDeepEqual(
      await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange()),
      previousRange,
      'Wheel must change visible range',
    );
  }
  const frameGaps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const gaps = [];
        let before;
        const tick = (time) => {
          if (before !== undefined) gaps.push(time - before);
          before = time;
          if (gaps.length >= 120) resolve(gaps);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  report.checks.foregroundPerformance = {
    workload: '250ms synthetic tail updates,24 real wheel actions,120 foreground rAF gaps',
    inputToSettledMs: interactionMs,
    p95InputToSettledMs: p95(interactionMs),
    frameGapsMs: frameGaps,
    p95FrameGapMs: p95(frameGaps),
    qualification: 'Desktop smoke; timings include automation dispatch and two frame settlement',
  };
  assert.ok(p95(interactionMs) < 150, 'Desktop interaction smoke budget150ms');
  // Mobile viewport usability is emulation on this desktop, not device qualification.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.terminalHarness.terminal.applySettings({ theme: 'dark' }));
  await page.screenshot({ path: resolve(root, 'docs/assets/terminal-mobile.png'), fullPage: true });
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.scrollWidth <= layout.width + 1, 'Mobile horizontal overflow');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.getByLabel('Show volume', { exact: true }).uncheck();
  await page.getByLabel('Show volume', { exact: true }).check();
  await page.getByLabel('EMA period; blank disables', { exact: true }).fill('21');
  await page.getByLabel('EMA period; blank disables', { exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Horizontal drawing tool', exact: true }).click();
  const mobileBox = await page.locator('[data-terminal-chart]').boundingBox();
  assert.ok(mobileBox);
  const countBefore = await page.evaluate(() => window.terminalHarness.terminal.getDrawings().list().length);
  await page.mouse.click(mobileBox.x + mobileBox.width * 0.4, mobileBox.y + mobileBox.height * 0.3);
  await page.waitForFunction(
    (before) => window.terminalHarness.terminal.getDrawings().list().length === before + 1,
    countBefore,
  );
  await page.getByRole('button', { name: 'Select drawing tool', exact: true }).click();
  await page.locator('[data-terminal-chart] [tabindex="0"]').focus();
  const mobileRange = await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange());
  await page.keyboard.press('ArrowLeft');
  assert.notDeepEqual(
    await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange()),
    mobileRange,
    'Mobile keyboard navigation must change range',
  );
  assert.equal(await page.evaluate(() => window.terminalHarness.terminal.getSettings().emaPeriod), 21);
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await ready();
  report.checks.mobileViewport = {
    ...layout,
    interaction: 'Theme, volume, EMA, drawing placement, keyboard navigation, Save/Restore',
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(root, 'docs/assets/terminal-desktop.png'), fullPage: true });
  const beforeDestroy = await cdp.send('Memory.getDOMCounters');
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await page.evaluate(() => window.terminalHarness.fixture.clearFaults());
  await delay(1000);
  const teardown = await page.evaluate(() => ({
    active: window.terminalHarness.terminal,
    stats: window.terminalHarness.fixture.stats(),
    canvases: document.querySelectorAll('canvas').length,
  }));
  assert.equal(teardown.active, null);
  assert.equal(teardown.canvases, 0);
  assert.equal(teardown.stats.activeSubscriptions, 0);
  assert.equal(teardown.stats.activeRequests, 0);
  await cdp.send('HeapProfiler.collectGarbage');
  report.checks.teardown = { ...teardown, beforeDestroy, after: await cdp.send('Memory.getDOMCounters') };
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
    await ready();
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  }
  await page.evaluate(() => window.terminalHarness.fixture.clearFaults());
  await delay(500);
  const remount = await page.evaluate(() => ({
    stats: window.terminalHarness.fixture.stats(),
    canvases: document.querySelectorAll('canvas').length,
  }));
  assert.equal(remount.canvases, 0);
  assert.equal(remount.stats.activeSubscriptions, 0);
  assert.equal(remount.stats.activeRequests, 0);
  report.checks.strictModeRemount = remount;
  assert.deepEqual(report.errors, [], 'No browser errors accepted');
  const first = report.samples[0],
    last = report.samples.at(-1);
  assert.ok(last.resources.nodes <= first.resources.nodes + 200, 'DOM node growth exceeds terminal budget');
  assert.ok(
    last.resources.jsEventListeners <= first.resources.jsEventListeners + 20,
    'Listener growth exceeds terminal budget',
  );
  assert.ok(
    last.heap.usedSize - first.heap.usedSize < 12 * 1024 * 1024,
    'Retained heap growth exceeds 12MiB smoke budget',
  );
  report.checks.resourceBounds = {
    nodes: 200,
    listeners: 20,
    retainedHeapGrowthBytes: 12 * 1024 * 1024,
    observedHeapGrowth: last.heap.usedSize - first.heap.usedSize,
  };
  for (const identity of identities)
    assert.equal(
      digest(readFileSync(resolve(root, identity.path))),
      identity.sha256,
      'Artifacts changed during run: ' + identity.path,
    );
  report.status = 'checks-passed';
} catch (error) {
  report.status = 'fail';
  report.failure = error.stack ?? String(error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  const bounded = async (name, operation) => {
    let timer;
    try {
      const value = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(name + ' timed out')), 8000);
        }),
      ]);
      cleanup.push({ name, result: 'pass', value });
    } catch (error) {
      cleanup.push({ name, result: 'fail', error: String(error) });
      report.status = 'fail';
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  if (page && !page.isClosed())
    await bounded('terminal-dispose', async () => {
      report.finalState = await page.evaluate(() => {
        const h = window.terminalHarness;
        const before = h?.terminal?.getState();
        h?.terminal?.destroy();
        h?.fixture.clearFaults();
        return {
          before,
          stats: h?.fixture.stats(),
          canvases: document.querySelectorAll('canvas').length,
          visibility: h?.visibility,
        };
      });
    });
  if (browser)
    await bounded('browser-close', async () => {
      try {
        await (await browser.newBrowserCDPSession()).send('Browser.close');
      } catch (error) {
        if (browser.isConnected()) throw error;
      } finally {
        await browser.close();
      }
    });
  const stop = async (child) => {
    if (!child) return { notStarted: true };
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    return { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode };
  };
  await bounded('owned-chrome-exit', () => stop(chrome));
  await bounded('owned-preview-exit', () => stop(server));
  report.cleanup = cleanup;
  report.finishedAt = new Date().toISOString();
  if (begin) report.elapsedMs = Date.now() - begin;
  if (report.status === 'checks-passed') report.status = 'pass';
  event('complete', { status: report.status, actualSessionMs: report.actualSessionMs });
  console.log(JSON.stringify({ status: report.status, artifact: relative(root, output) }));
}
