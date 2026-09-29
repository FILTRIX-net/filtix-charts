import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import os from 'node:os';
import { verifyRendered, stats } from './studies-oracle.mjs';
import { verifyConsumerIdentity } from './consumer-identity.mjs';
import { installOwnedDomTracker } from './studies-resources.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'all';
assert.ok(['all', 'max', 'soak'].includes(mode));
const port = 5197,
  origin = 'http://127.0.0.1:' + port;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const out = resolve(root, 'benchmark-results/v0.6/studies-' + stamp + '.json');
mkdirSync(resolve(root, 'benchmark-results/v0.6'), { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
  );
const report = {
  schema: 'filtix-terminal-studies',
  version: 2,
  resourceMetric: {
    version: 'authored-structural-weakref-v1',
    scope:
      'consumer #root structural light DOM and terminal generations, including Element/Text/Comment and removed nodes; standalone Attr wrappers excluded',
    globalBlinkNodes: 'diagnostic only; native Editor undo retention is outside authored ownership',
    protocol: [
      'gate delivery and settle two frames',
      'drain/discover in one page turn',
      'three fixed primitive-only renderer turns, each followed by CDP collectGarbage',
      'capture raw counters/heap',
      'inspect weak references in another page turn',
      'restore prior delivery gate',
    ],
  },
  status: 'running',
  mode,
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  environment: { platform: os.platform(), os: os.release(), cpu: os.cpus()[0]?.model, node: process.version },
  qualification:
    'headless installed-package desktop smoke; synthetic source; no physical device or native background qualification',
  identities: [],
  events: [],
  maximum: { rebuilds: [], tail: [], wheel: [] },
  soak: { samples: [] },
  checks: {},
  cleanup: {},
  errors: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const event = (name, detail = {}) => {
  if (finalized) return;
  const record = { name, at: new Date().toISOString(), ...detail };
  report.events.push(record);
  save();
  console.log(JSON.stringify(record));
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label + ' deadline exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let finalized = false;
let stopRequested = false;

const studies = [
  { kind: 'ema', period: 20, color: '#c27a50' },
  { kind: 'ema', period: 50, color: '#66b9c7' },
  { kind: 'sma', period: 200, color: '#c7ef57' },
  { kind: 'sma', period: 7, color: '#efcf83' },
  { kind: 'ema', period: 9, color: '#e9b7b3' },
  { kind: 'rsi', period: 14, color: '#a8a0dc' },
  { kind: 'rsi', period: 7, color: '#66b9c7' },
  { kind: 'rsi', period: 21, color: '#efcf83' },
];
let server, browserServer, browser, context, page, cdp;
async function verifyPortFree() {
  await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePort));
  });
}
async function start() {
  const installed = verifyConsumerIdentity(root, 'v0.6', report.sourceCommit);
  report.installation = {
    record: installed.record,
    sourceCommit: installed.sourceCommit,
    archives: installed.archives,
    members: installed.members,
  };
  report.identities = installed.identities;
  await verifyPortFree();
  if (stopRequested) throw Error('Startup cancelled before preview launch');
  server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: resolve(root, 'examples/react-terminal'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  report.ownedPreviewPid = server.pid;
  let log = '';
  let spawnError;
  server.on('error', (error) => {
    spawnError = error;
  });
  server.stdout.on('data', (chunk) => {
    log += chunk;
  });
  server.stderr.on('data', (chunk) => {
    log += chunk;
  });
  let available = false;
  for (let i = 0; i < 100; i++) {
    if (stopRequested) throw Error('Measurement cancelled during startup');
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw Error('Preview exited: ' + log);
    try {
      available = (await fetch(origin + '/studies-test.html', { signal: AbortSignal.timeout(2000) })).ok;
      if (available) break;
    } catch {}
    await pause(100);
  }
  assert.ok(available, 'Owned preview ready');
  if (stopRequested) throw Error('Measurement cancelled before browser launch');
  browserServer = await chromium.launchServer({
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    headless: true,
  });
  report.ownedBrowserPid = browserServer.process().pid;
  if (stopRequested) {
    await closeBrowser();
    throw Error('Measurement cancelled during browser launch');
  }
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.stack || error.message));
  cdp = await context.newCDPSession(page);
  event('started', { mode, identities: report.identities.length });
}
async function maximumSample(label) {
  const result = await page.evaluate(() =>
    window.studiesWorkload.snapshot([0, 6, 7, 8, 13, 14, 19, 20, 31, 49, 50, 199, 200, 50000, 99998, 99999]),
  );
  assert.equal(result.bars.length, 100000);
  assert.equal(result.studies.length, 8);
  assert.equal(result.diagnostics.seriesCount, 10);
  assert.equal(result.projection.panes.length, 5);
  assert.equal(result.state.error, null);
  assert.equal(result.state.feed.status, 'live');
  const points = verifyRendered(result, label);
  const { bars, ...observed } = result;
  report.maximum.oracle ??= [];
  report.maximum.oracle.push({
    label,
    rows: bars.length,
    sourceHash: digest(JSON.stringify(bars)),
    sampled: true,
    checkedRenderedPoints: points,
    ...observed,
  });
  event('maximum-oracle-pass', { label, rows: bars.length, points });
}
async function maximum() {
  await page.goto(origin + '/studies-test.html');
  await page.waitForFunction(() => window.studiesWorkload);
  const scene = await page.evaluate((options) => window.studiesWorkload.mount(100000, options), studies);
  assert.equal(scene.rows, 100000);
  assert.equal(scene.diagnostics.seriesCount, 10);
  assert.equal(scene.projection.panes.length, 5);
  report.maximum.scene = {
    rows: 100000,
    studies,
    series: 10,
    panes: 5,
    visibleBars: 1000,
    hydration: '10 untimed history pages; timed full canonical correction rebuilds',
  };
  await page.evaluate(() => window.studiesWorkload.correction(27));
  for (let i = 0; i < 3; i++)
    report.maximum.rebuilds.push(
      await page.evaluate((index) => window.studiesWorkload.correction(index), 31 + i),
    );
  await maximumSample('after-three-canonical-rebuilds');
  async function runEvents(events, label) {
    for (let i = 0; i < events.length; i++) {
      const begin = Date.now();
      const sample = await page.evaluate(({ kind, i }) => window.studiesWorkload.deliver(kind, i), {
        kind: events[i],
        i,
      });
      report.maximum.tail.push({ ...sample, phase: label, dispatchedAt: begin });
      await pause(Math.max(0, 100 - (Date.now() - begin)));
    }
    event('maximum-tail-phase', { label, events: events.length });
  }
  await runEvents(Array(100).fill('replace'), '100k-replacements');
  await maximumSample('after-100k-tail-replacements');
  await page.evaluate((options) => window.studiesWorkload.mount(99900, options), studies);
  await runEvents(
    Array.from({ length: 200 }, (_, i) => (i % 2 ? 'replace' : 'append')),
    '99900-to-100000',
  );
  await maximumSample('after-appends-and-replacements');
  await page.mouse.move(700, 330);
  for (let i = 0; i < 24; i++) {
    const before = await page.evaluate(() => window.studiesWorkload.terminal.chart.getVisibleRange());
    const begin = Date.now();
    await page.mouse.wheel(0, i % 2 ? -40 : 40);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.evaluate(() => window.studiesWorkload.terminal.chart.whenIdle());
    const after = await page.evaluate(() => window.studiesWorkload.terminal.chart.getVisibleRange());
    assert.notDeepEqual(after, before, 'Wheel must change range');
    report.maximum.wheel.push({ ms: Date.now() - begin, before, after });
  }
  report.maximum.frameGaps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const gaps = [];
        let last;
        function next(time) {
          if (last !== undefined) gaps.push(time - last);
          last = time;
          if (gaps.length === 120) resolve(gaps);
          else requestAnimationFrame(next);
        }
        requestAnimationFrame(next);
      }),
  );
  const summary = {
    rebuildSync: stats(report.maximum.rebuilds.map((x) => x.synchronousMs)),
    rebuildSettled: stats(report.maximum.rebuilds.map((x) => x.settledMs)),
    tailSync: stats(report.maximum.tail.map((x) => x.synchronousMs)),
    tailSettled: stats(report.maximum.tail.map((x) => x.settledMs)),
    wheel: stats(report.maximum.wheel.map((x) => x.ms)),
    frameGaps: stats(report.maximum.frameGaps),
  };
  report.maximum.summary = summary;
  report.checks.maximum = {
    rebuildSync: summary.rebuildSync.p95 <= 1500,
    rebuildSettled: summary.rebuildSettled.p95 <= 2000,
    tailSync: summary.tailSync.p95 <= 16 && summary.tailSync.p99 <= 32,
    tailSettled: summary.tailSettled.p95 <= 50 && summary.tailSettled.p99 <= 100,
    wheel: summary.wheel.p95 < 150,
  };
  report.maximum.teardown = await page.evaluate(() => window.studiesWorkload.destroy());
  assert.deepEqual(report.maximum.teardown, { canvases: 0, activeRequests: 0, activeSubscriptions: 0 });
  event('maximum-measured', { checks: report.checks.maximum, summary });
  assert.ok(Object.values(report.checks.maximum).every(Boolean), 'Maximum workload budget failed');
}
async function readyConsumer() {
  await page.waitForFunction(
    () => {
      const t = window.terminalHarness?.terminal;
      return (
        t && !t.getState().destroyed && t.getState().feed.status === 'live' && t.getState().error === null
      );
    },
    {},
    { timeout: 20000 },
  );
  await page.evaluate(() => window.terminalHarness.terminal.chart.whenIdle());
}
async function observeResources() {
  const previousGate = await page.evaluate(() => {
    const h = window.terminalHarness;
    const prior = h.fixture.stats().gated;
    h.fixture.gate(true);
    return prior;
  });
  try {
    await page.evaluate(async () => {
      await window.terminalHarness.terminal?.chart.whenIdle();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    const resourcePreparation = await page.evaluate(() => {
      const elements = document.querySelectorAll('*');
      let attributeNodes = 0;
      for (const element of elements)
        for (const attribute of element.attributes) if (attribute.name) attributeNodes++;
      return { elements: elements.length, attributeNodes, owned: window.__filtixOwnedDomTracker.prepare() };
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      const turn = await page.evaluate(() => {
        const next = (window.__ownedDomCollectionTurn ?? 0) + 1;
        setTimeout(() => {
          window.__ownedDomCollectionTurn = next;
        }, 0);
        return next;
      });
      await page.waitForFunction((expected) => window.__ownedDomCollectionTurn === expected, turn);
      await cdp.send('HeapProfiler.collectGarbage');
    }
    const resources = await cdp.send('Memory.getDOMCounters');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const ownedDom = await page.evaluate(() => window.__filtixOwnedDomTracker.sample());
    return {
      resourcePreparation,
      resources,
      heap: { usedSize: heap.usedSize, totalSize: heap.totalSize },
      ownedDom,
    };
  } finally {
    await page.evaluate((prior) => window.terminalHarness.fixture.gate(prior), previousGate);
  }
}
function assertOwnedDom(owned, active, label) {
  assert.deepEqual(
    owned.coverage,
    {
      name: 'ownedStructuralDom',
      version: 1,
      nodeTypes: ['element', 'text', 'comment', 'other'],
      excludedNodeTypes: ['attr', 'shadow-dom'],
    },
    label + ': structural coverage',
  );
  assert.equal(owned.consumer.rootCount, 1, label + ': one consumer root');
  assert.equal(owned.consumer.retainedOutside, 0, label + ': no retained outside consumer nodes');
  assert.equal(owned.terminal.retainedOutside, 0, label + ': no retained outside terminal nodes');
  assert.equal(owned.terminal.rootCount, active ? 1 : 0, label + ': terminal root ownership');
  for (const generation of owned.terminal.generations)
    if (!generation.rootConnected)
      assert.equal(generation.total, 0, label + ': disposed generation ' + generation.id);
  if (!active) assert.equal(owned.terminal.total, 0, label + ': all terminal nodes released');
}

async function sample(label, full = false, flush = true) {
  await readyConsumer();
  const result = await page.evaluate(
    async ({ label, full, flush }) => {
      const h = window.terminalHarness,
        t = h.terminal,
        f = h.fixture;
      f.gate(true);
      try {
        const query = t.getState().feed.query,
          now = flush ? f.flush(query) : Date.now();
        await t.chart.whenIdle();
        const bars = t.getData();
        const truth = f
          .history(query, now)
          .filter((bar) => bar.time >= bars[0].time && bar.time <= bars.at(-1).time);
        let tailAsOf = null;
        if (!flush) {
          const tail = bars.at(-1);
          const duration = { '1m': 60000, '5m': 300000, '1h': 3600000 }[query.interval];
          if (!Number.isInteger(tail.revision) || tail.revision < 0 || tail.revision > duration / 250)
            throw Error('Recovery tail has invalid source revision');
          tailAsOf = tail.time + tail.revision * 250;
          const authoritativeTail = f.history(query, tailAsOf).find((bar) => bar.time === tail.time);
          if (!authoritativeTail) throw Error('Recovery tail missing from authority');
          truth[truth.length - 1] = authoritativeTail;
        }
        const previous = t.chart.getVisibleRange(),
          follow = t.getSettings().followLatest;
        t.chart.setVisibleRange({ from: -1, to: bars.length });
        await t.chart.whenIdle();
        let observed;
        const off = t.chart.subscribeCrosshairMove((event) => {
          observed = event;
        });
        const rendered = [];
        const indices = full
          ? bars.map((_, i) => i)
          : [
              0,
              Math.min(14, bars.length - 1),
              Math.min(199, bars.length - 1),
              Math.floor(bars.length / 2),
              bars.length - 1,
            ];
        try {
          t.chart.setCrosshairTime(null);
          await t.chart.whenIdle();
          for (const index of indices) {
            observed = null;
            t.chart.setCrosshairTime(bars[index].time);
            await t.chart.whenIdle();
            rendered.push({ index, time: observed?.time, points: observed?.points ?? {} });
          }
        } finally {
          off();
          t.chart.setCrosshairTime(null);
          t.chart.setVisibleRange(previous);
          t.chart.applyOptions({ followLatest: follow });
          await t.chart.whenIdle();
        }
        let panes;
        const detach = t.chart.attachPrimitive({
          draw(ctx, projection) {
            panes = projection.panes.map((p) => ({ id: p.id, top: p.top, bottom: p.bottom, scale: p.scale }));
          },
        });
        await t.chart.whenIdle();
        detach();
        await t.chart.whenIdle();
        return {
          label,
          now,
          flushed: flush,
          tailAsOf,
          bars,
          truth,
          rendered,
          studies: t.getStudies(),
          state: t.getState(),
          statistics: f.stats(),
          diagnostics: t.chart.getDiagnostics(),
          panes,
          canvases: document.querySelectorAll('canvas').length,
        };
      } finally {
        f.gate(false);
      }
    },
    { label, full, flush },
  );
  assert.deepEqual(result.bars, result.truth, label + ': full source authority');
  if (!flush) {
    assert.ok(
      result.tailAsOf >= report.soak.recovery.reconnectedAt - 250,
      'Recovered partial tail must reflect the reconnect history request',
    );
    assert.ok(result.tailAsOf <= result.now, 'Recovery revision cannot be from the future');
  }
  assert.equal(result.state.error, null);
  assert.equal(result.state.feed.status, 'live');
  assert.equal(result.canvases, 3);
  assert.equal(result.statistics.activeSubscriptions, 1);
  assert.ok(result.statistics.activeRequests <= 1);
  const visible = result.studies.filter((study) => study.visible);
  assert.equal(result.diagnostics.seriesCount, 1 + Number(result.state.settings.volume) + visible.length);
  assert.equal(
    result.panes.length,
    1 + Number(result.state.settings.volume) + visible.filter((s) => s.kind === 'rsi').length,
  );
  const checkedRenderedPoints = verifyRendered(result, label);
  const resourceObservation = await observeResources();
  const { bars, truth, ...observation } = result;
  report.soak.samples.push({
    ...observation,
    full,
    rows: bars.length,
    checkedRenderedPoints,
    actualHash: digest(JSON.stringify(bars)),
    authoritativeHash: digest(JSON.stringify(truth)),
    ...resourceObservation,
    at: new Date().toISOString(),
  });
  assertOwnedDom(resourceObservation.ownedDom, true, label);
  event('soak-oracle-pass', { label, full, rows: bars.length, points: checkedRenderedPoints });
}
async function configure() {
  return await page.evaluate(async (options) => {
    const t = window.terminalHarness.terminal;
    for (const study of t.getStudies()) t.removeStudy(study.id);
    for (const option of options) t.addStudy(option);
    await t.chart.whenIdle();
    return t.getWorkspace();
  }, studies);
}
async function soak() {
  await page.addInitScript(installOwnedDomTracker);
  await page.goto(origin + '/?source=fixture&test');
  await readyConsumer();
  await page.locator('[data-terminal-studies-toggle]').click();
  mkdirSync(resolve(root, 'docs/assets'), { recursive: true });
  await page.screenshot({
    path: resolve(root, 'docs/assets/terminal-studies-desktop.png'),
    fullPage: true,
    caret: 'initial',
  });
  await page.locator('[data-terminal-studies-toggle]').click();
  const original = await configure();
  const started = Date.now();
  report.soak.sessionStartedAt = new Date(started).toISOString();
  const deliveriesBefore = await page.evaluate(() => window.terminalHarness.fixture.stats().tailDeliveries);
  await sample('initial-eight-studies', true);
  const beforeBackfill = await page.evaluate(() =>
    window.terminalHarness.terminal.getData().map((bar) => bar.time),
  );
  await page.evaluate(() => window.terminalHarness.terminal.loadMore());
  const afterBackfill = await page.evaluate(() =>
    window.terminalHarness.terminal.getData().map((bar) => bar.time),
  );
  assert.ok(
    afterBackfill.length > beforeBackfill.length && afterBackfill[0] < beforeBackfill[0],
    'Backfill must add older rows',
  );
  assert.ok(
    beforeBackfill.every((time) => afterBackfill.includes(time)),
    'Backfill must preserve existing timestamps',
  );
  report.soak.backfill = { before: beforeBackfill, after: afterBackfill };
  await sample('backfill', true);
  await page.evaluate(() => {
    const h = window.terminalHarness,
      t = h.terminal,
      data = t.getData();
    const corrected = h.fixture.correct(t.getState().feed.query, data[10].time, false);
    t.applyCorrections([corrected]);
  });
  await sample('historical-correction', true);
  const recoveryBefore = await page.evaluate(() => {
    const h = window.terminalHarness,
      t = h.terminal;
    const result = {
      times: t.getData().map((bar) => bar.time),
      query: t.getState().feed.query,
      disconnectedAt: Date.now(),
    };
    h.fixture.gate(true);
    h.fixture.setConnected(false);
    return result;
  });
  const intervalMs = { '1m': 60000, '5m': 300000, '1h': 3600000 }[recoveryBefore.query.interval];
  const reconnectAt = recoveryBefore.times.at(-1) + intervalMs + 1000;
  event('recovery-disconnected', { resumeAfter: new Date(reconnectAt).toISOString() });
  await pause(Math.max(1300, reconnectAt - Date.now()));
  const reconnectedAt = await page.evaluate(() => {
    window.terminalHarness.fixture.setConnected(true);
    return Date.now();
  });
  await readyConsumer();
  const recoveryAfter = await page.evaluate(() => {
    const h = window.terminalHarness,
      t = h.terminal;
    const now = Date.now();
    return {
      times: t.getData().map((bar) => bar.time),
      expectedTail: h.fixture.history(t.getState().feed.query, now).at(-1).time,
      capturedAt: now,
      state: t.getState(),
    };
  });
  assert.equal(recoveryAfter.times[0], recoveryBefore.times[0], 'Recovery retained oldest backfilled row');
  assert.ok(
    recoveryBefore.times.every((time) => recoveryAfter.times.includes(time)),
    'Recovery retained all loaded timestamps',
  );
  assert.ok(
    recoveryAfter.times.at(-1) > recoveryBefore.times.at(-1),
    'Disconnect must produce a recovered new candle',
  );
  assert.equal(
    recoveryAfter.times.at(-1),
    recoveryAfter.expectedTail,
    'Recovery catches authoritative tail before any oracle flush',
  );
  report.soak.recovery = {
    before: recoveryBefore,
    after: recoveryAfter,
    reconnectedAt,
    checkedBeforeFlush: true,
  };
  await sample('recovery', true, false);
  await page.evaluate(async () => {
    const t = window.terminalHarness.terminal,
      s = t.getWorkspace();
    await t.restoreWorkspace({
      schema: s.schema,
      version: 1,
      providerId: s.providerId,
      query: s.query,
      settings: { ...s.settings, emaPeriod: 17 },
      markets: s.markets,
    });
  });
  await sample('v1-migration', true);
  await page.evaluate((saved) => window.terminalHarness.terminal.restoreWorkspace(saved), original);
  await sample('v2-restore', true);
  const atomic = await page.evaluate(async () => {
    const h = window.terminalHarness,
      t = h.terminal,
      f = h.fixture;
    f.gate(true);
    try {
      await t.chart.whenIdle();
      const capture = () => ({
        workspace: t.getWorkspace(),
        data: t.getData(),
        state: t.getState(),
        history: t.getDrawings().getHistoryState(),
        statistics: { requests: f.stats().requests, subscriptions: f.stats().subscriptions },
      });
      const before = capture(),
        invalid = structuredClone(before.workspace);
      invalid.settings.theme = 'light';
      invalid.studies.at(-1).period = 0;
      let rejected = false;
      try {
        await t.restoreWorkspace(invalid);
      } catch {
        rejected = true;
      }
      return { rejected, before, after: capture() };
    } finally {
      f.gate(false);
    }
  });
  assert.equal(atomic.rejected, true);
  assert.deepEqual(atomic.after, atomic.before);
  report.soak.invalidRestore = {
    passed: true,
    beforeHash: digest(JSON.stringify(atomic.before)),
    afterHash: digest(JSON.stringify(atomic.after)),
  };
  await page.evaluate(() => {
    const h = window.terminalHarness;
    h.fixture.gate(true);
    h.fixture.holdNextHistory();
    window.heldStudySwitch = h.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
  });
  await page.evaluate(() => window.terminalHarness.terminal.setMarket({ symbol: 'SOLUSDT', interval: '5m' }));
  await readyConsumer();
  const stale = await page.evaluate(async () => {
    const h = window.terminalHarness,
      t = h.terminal;
    const old = t.getStudies().at(-1);
    t.removeStudy(old.id);
    t.addStudy({ kind: old.kind, period: old.period, color: old.color });
    await t.chart.whenIdle();
    const capture = () => ({
      workspace: t.getWorkspace(),
      data: t.getData(),
      state: t.getState(),
      requests: h.fixture.stats().requests,
      subscriptions: h.fixture.stats().subscriptions,
    });
    const before = capture();
    const released = await h.fixture.releaseLateHistory();
    await window.heldStudySwitch;
    await t.chart.whenIdle();
    const afterHistory = capture();
    const delivered = h.fixture.deliverLate();
    await t.chart.whenIdle();
    const afterStream = capture();
    // Longer than the configured reconnectBaseMs: an obsolete callback must not schedule a retry.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const afterRetryWindow = capture();
    h.fixture.gate(false);
    return { released, delivered, before, afterHistory, afterStream, afterRetryWindow };
  });
  assert.equal(stale.released, true);
  assert.ok(stale.delivered);
  assert.deepEqual(stale.afterHistory, stale.before, 'Old history cannot change full current state');
  assert.deepEqual(
    stale.afterStream,
    stale.afterHistory,
    'Old stream callbacks cannot change full current state',
  );
  assert.deepEqual(
    stale.afterRetryWindow,
    stale.afterStream,
    'Old callbacks cannot schedule new transport work',
  );
  report.soak.obsoleteCallbacks = {
    passed: true,
    beforeHash: digest(JSON.stringify(stale.before)),
    afterHistoryHash: digest(JSON.stringify(stale.afterHistory)),
    afterStreamHash: digest(JSON.stringify(stale.afterStream)),
    afterRetryWindowHash: digest(JSON.stringify(stale.afterRetryWindow)),
    state: stale.afterRetryWindow.state,
  };
  await sample('rapid-switch-obsolete-callbacks', true);
  await page.evaluate(async (saved) => {
    const t = window.terminalHarness.terminal;
    await t.restoreWorkspace(saved);
    for (let i = 0; i < 25; i++) {
      const last = t.getStudies().at(-1);
      t.removeStudy(last.id);
      const id = t.addStudy({ kind: 'rsi', period: 21 });
      t.updateStudy(id, { visible: false });
      t.updateStudy(id, { visible: true });
    }
    await t.restoreWorkspace(saved);
  }, original);
  report.soak.addRemoveCycles = 25;
  await sample('after-add-remove-cycles', false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-terminal-studies-toggle]').click();
  const input = page.locator('[data-terminal-study-period]').first();
  await input.fill('37');
  await input.focus();
  await pause(1100);
  assert.equal(await input.inputValue(), '37');
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    'Streaming retains editor focus',
  );
  await input.press('Tab');
  assert.equal(await page.evaluate(() => window.terminalHarness.terminal.getStudies()[0].period), 37);
  await page.locator('[data-terminal-study-width]').first().selectOption('3');
  await page.locator('[data-terminal-study-color]').first().fill('#abcdef');
  await page.locator('[data-terminal-study-color]').first().press('Tab');
  const configured = await page.evaluate(() => window.terminalHarness.terminal.getStudies()[0]);
  assert.equal(configured.period, 37);
  assert.equal(configured.lineWidth, 3);
  assert.equal(configured.color, '#abcdef');
  await page.locator('[data-terminal-study-visible]').last().uncheck();
  const hidden = await page.evaluate(async () => {
    const t = window.terminalHarness.terminal;
    await t.chart.whenIdle();
    let panes;
    const detach = t.chart.attachPrimitive({
      draw(ctx, projection) {
        panes = projection.panes.map((pane) => pane.id);
      },
    });
    await t.chart.whenIdle();
    detach();
    await t.chart.whenIdle();
    return { study: t.getStudies().at(-1), series: t.chart.getDiagnostics().seriesCount, panes };
  });
  assert.equal(hidden.study.visible, false);
  assert.equal(hidden.series, 9);
  assert.equal(hidden.panes.length, 4);
  assert.ok(!hidden.panes.includes('terminal-' + hidden.study.id + '-pane'));
  report.soak.hiddenResources = { ...hidden, passed: true };
  await page.locator('[data-terminal-study-visible]').last().check();
  assert.equal(await page.locator('[data-terminal-study-add]').isDisabled(), true);
  await page.locator('[data-terminal-study-remove]').last().click();
  await page.locator('[data-terminal-study-add-kind]').selectOption('sma');
  await page.locator('[data-terminal-study-add-period]').fill('11');
  await page.locator('[data-terminal-study-add]').click();
  assert.equal(await page.evaluate(() => window.terminalHarness.terminal.getStudies().at(-1).period), 11);
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('[data-filtix-terminal]');
    return {
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      host: root.scrollWidth <= root.clientWidth,
    };
  });
  assert.ok(overflow.document && overflow.host);
  report.soak.narrowViewport = {
    requestedWidth: 390,
    focusPreserved: true,
    controlsPassed: true,
    ...overflow,
  };
  await page.screenshot({
    path: resolve(root, 'docs/assets/terminal-studies-mobile.png'),
    fullPage: true,
    caret: 'initial',
  });
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  const saved = await page.evaluate(() => window.terminalHarness.terminal.getWorkspace());
  await page.evaluate(() =>
    window.terminalHarness.terminal.updateStudy(window.terminalHarness.terminal.getStudies()[0].id, {
      period: 9,
    }),
  );
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await readyConsumer();
  assert.deepEqual(await page.evaluate(() => window.terminalHarness.terminal.getWorkspace()), saved);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sample('installed-ui-save-restore', true);
  await page.evaluate((saved) => window.terminalHarness.terminal.restoreWorkspace(saved), original);
  await readyConsumer();
  let index = 0;
  while (
    Date.now() - started < 120000 ||
    report.soak.samples.length < 11 ||
    (await page.evaluate(() => window.terminalHarness.fixture.stats().tailDeliveries)) - deliveriesBefore <
      300
  ) {
    await pause(5000);
    await sample('sustained-' + ++index, false);
  }
  await sample('final-equivalent-eight-studies', true);
  report.soak.actualSessionMs = Date.now() - started;
  report.soak.sessionFinishedAt = new Date().toISOString();
  report.soak.tailDeliveries =
    (await page.evaluate(() => window.terminalHarness.fixture.stats().tailDeliveries)) - deliveriesBefore;
  const first = report.soak.samples[0],
    last = report.soak.samples.at(-1);
  report.soak.growth = {
    nodes: last.resources.nodes - first.resources.nodes,
    ownedConsumerNodes: last.ownedDom.consumer.total - first.ownedDom.consumer.total,
    ownedTerminalNodes: last.ownedDom.terminal.total - first.ownedDom.terminal.total,
    listeners: last.resources.jsEventListeners - first.resources.jsEventListeners,
    retainedHeapBytes: last.heap.usedSize - first.heap.usedSize,
  };
  report.checks.soak = {
    duration: report.soak.actualSessionMs >= 120000,
    samples: report.soak.samples.length >= 12,
    deliveries: report.soak.tailDeliveries >= 300,
    ownedConsumerNodes: report.soak.growth.ownedConsumerNodes <= 0,
    ownedTerminalNodes: report.soak.growth.ownedTerminalNodes <= 0,
    retainedOutside: report.soak.samples.every(
      (sample) =>
        sample.ownedDom.consumer.retainedOutside === 0 && sample.ownedDom.terminal.retainedOutside === 0,
    ),
    disposedGenerations: report.soak.samples.every((sample) =>
      sample.ownedDom.terminal.generations.every(
        (generation) => generation.rootConnected || generation.total === 0,
      ),
    ),
    listeners: report.soak.growth.listeners <= 0,
    heap: report.soak.growth.retainedHeapBytes <= 12 * 1024 * 1024,
  };
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  const teardown = async () => {
    const capture = () =>
      page.evaluate(() => {
        const stats = window.terminalHarness.fixture.stats();
        return {
          canvases: document.querySelectorAll('canvas').length,
          activeRequests: stats.activeRequests,
          activeSubscriptions: stats.activeSubscriptions,
          requests: stats.requests,
          subscriptions: stats.subscriptions,
          hostHtml: document.querySelector('#root').innerHTML,
        };
      });
    const before = await capture();
    const attempt = {
      canvases: before.canvases,
      requests: before.activeRequests,
      subscriptions: before.activeSubscriptions,
      status: 'running',
    };
    (report.soak.teardownAttempts ??= []).push(attempt);
    assert.equal(before.canvases, 0);
    assert.equal(before.activeRequests, 0);
    assert.equal(before.activeSubscriptions, 0);
    // The fault-injection provider intentionally retains the unsubscribed
    // callback. Prove its fence, then consume that host-owned reference.
    const retainedByFaultFixture = await observeResources();
    attempt.faultFixture = {
      retainedBeforeRelease: retainedByFaultFixture,
      beforeHash: digest(JSON.stringify(before)),
    };
    const delivered = await page.evaluate(() => window.terminalHarness.fixture.deliverLate());
    attempt.faultFixture.delivered = delivered;
    assert.ok(delivered, 'Destroyed terminal has an obsolete fixture callback to exercise');
    const immediate = await capture();
    assert.deepEqual(immediate, before, 'Destroyed callback cannot change host or transport');
    await pause(800);
    const afterRetryWindow = await capture();
    assert.deepEqual(afterRetryWindow, before, 'Destroyed callback cannot schedule transport work');
    const remainingFault = await page.evaluate(() => window.terminalHarness.fixture.deliverLate());
    assert.equal(remainingFault, null, 'Destroyed callback cannot create a new retained fault slot');
    Object.assign(attempt, {
      canvases: before.canvases,
      requests: before.activeRequests,
      subscriptions: before.activeSubscriptions,
      faultFixture: {
        delivered,
        retainedBeforeRelease: retainedByFaultFixture,
        beforeHash: digest(JSON.stringify(before)),
        immediateHash: digest(JSON.stringify(immediate)),
        afterRetryWindowHash: digest(JSON.stringify(afterRetryWindow)),
        unchanged: true,
        remainingFault,
      },
      ...(await observeResources()),
      status: 'observed',
    });
    return attempt;
  };
  report.soak.teardown = await teardown();
  assertOwnedDom(report.soak.teardown.ownedDom, false, 'initial teardown');
  report.soak.remounts = [];
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
    await readyConsumer();
    await configure();
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
    const result = await teardown();
    report.soak.remounts.push(result);
    assertOwnedDom(result.ownedDom, false, 'remount teardown ' + i);
  }
  event('soak-measured', {
    actualSessionMs: report.soak.actualSessionMs,
    tailDeliveries: report.soak.tailDeliveries,
    growth: report.soak.growth,
    checks: report.checks.soak,
  });
  assert.ok(Object.values(report.checks.soak).every(Boolean), 'Installed-consumer soak gate failed');
}
async function executeWorkload() {
  await bounded(start(), 60000, 'Startup');
  if (mode !== 'soak') await bounded(maximum(), 300000, 'Maximum workload');
  if (mode !== 'max') await bounded(soak(), 900000, 'Installed consumer session');
  for (const item of report.identities)
    assert.equal(
      digest(readFileSync(resolve(root, item.path))),
      item.sha256,
      'Candidate changed: ' + item.path,
    );
  const finalInstall = verifyConsumerIdentity(root, 'v0.6', report.sourceCommit);
  assert.deepEqual(finalInstall.identities, report.identities, 'Candidate inventory changed');
  report.checks.identities = true;
  assert.equal(report.errors.length, 0, 'Browser errors');
}
async function stopProcess(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill();
  try {
    await bounded(done, 5000, label);
  } catch (error) {
    child.kill('SIGKILL');
    await bounded(done, 5000, label + ' forced cleanup');
    throw error;
  }
}
async function closeBrowser() {
  if (!browserServer) return;
  try {
    const child = browserServer.process();
    await bounded(browserServer.close(), 10000, 'Browser cleanup');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned browser exited');
    report.cleanup.browser = true;
  } catch (error) {
    report.cleanup.browser = false;
    report.errors.push('browser cleanup: ' + String(error));
    try {
      await bounded(browserServer.kill(), 5000, 'Owned browser forced cleanup');
    } catch (forced) {
      report.errors.push(String(forced));
    }
    // The process fallback must run even if Playwright's force-close promise hangs.
    try {
      await stopProcess(browserServer.process(), 'Owned browser process');
    } catch (forced) {
      report.errors.push(String(forced));
    }
  }
}
async function closePreview() {
  if (!server) return;
  try {
    await stopProcess(server, 'Owned preview');
    report.cleanup.preview = true;
  } catch (error) {
    report.errors.push('preview cleanup: ' + String(error));
    report.cleanup.preview = false;
  }
}
try {
  await bounded(executeWorkload(), 1200000, 'Entire measurement');
} catch (error) {
  stopRequested = true;
  report.errors.push(error.stack || String(error));
  event('failure', { message: String(error) });
} finally {
  // Independent cleanup: a hung browser cannot prevent the owned preview from exiting.
  await Promise.allSettled([closeBrowser(), closePreview()]);
  finalized = true;
  report.finishedAt = new Date().toISOString();
  report.status =
    report.errors.length === 0 && report.cleanup.browser && report.cleanup.preview ? 'pass' : 'fail';
  save();
  console.log(
    JSON.stringify({ status: report.status, evidence: relative(root, out), errors: report.errors }),
  );
  if (report.status !== 'pass') process.exitCode = 1;
}
