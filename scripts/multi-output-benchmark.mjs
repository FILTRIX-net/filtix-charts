import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import os from 'node:os';
import { verifyRendered, stats, studySeriesIds } from './multi-output-oracle.mjs';
import { verifyConsumerIdentity } from './consumer-identity.mjs';
import { installOwnedDomTracker } from './studies-resources.mjs';
import {
  browserLaunchOptions,
  captureCoherentTerminal,
  CoverageProcessRegistry,
  loadBrowserCohort,
  withFixtureGate,
} from './multi-output-coverage.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let chromium, firefox, webkit, browserCohort;
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'all';
assert.ok(['all', 'max', 'soak'].includes(mode));
const port = 5197,
  origin = 'http://127.0.0.1:' + port;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const stageDir = resolve(root, 'benchmark-results/v0.7');
const out = resolve(stageDir, 'multi-output-' + stamp + '.json');
mkdirSync(stageDir, { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
  );
const report = {
  schema: 'filtix-terminal-multi-output',
  version: 3,
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
  environment: {
    platform: os.platform(),
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
    browserCohort: null,
  },
  qualification:
    'headless actual-archive consumer measurement; deterministic synthetic source; selected 100k rendered samples plus full 500–750-row checkpoints; no physical-device, live-market, or native-background qualification',
  identities: [],
  events: [],
  maximum: { rebuilds: [], tail: [], wheel: [] },
  soak: { samples: [] },
  browserCoverage: [],
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
async function bounded(promise, ms, label, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(Error(label + ' deadline exceeded'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let finalized = false;
let stopRequested = false;
let coverageCancelled = false;
const coverageProcesses = new CoverageProcessRegistry(() => coverageCancelled || stopRequested || finalized);

const maximumStudies = [
  { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { kind: 'macd', fastPeriod: 5, slowPeriod: 35, signalPeriod: 5 },
  { kind: 'macd', fastPeriod: 20, slowPeriod: 50, signalPeriod: 10 },
  { kind: 'bollinger', period: 20, multiplier: 2 },
  { kind: 'bollinger', period: 500, multiplier: 2, fillOpacity: 0 },
  { kind: 'ema', period: 20, color: '#c27a50' },
  { kind: 'sma', period: 200, color: '#c7ef57' },
  { kind: 'ema', period: 50, color: '#66b9c7' },
];
const soakStudies = [
  { kind: 'macd', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  { kind: 'macd', fastPeriod: 5, slowPeriod: 35, signalPeriod: 5 },
  { kind: 'rsi', period: 14, color: '#a8a0dc' },
  { kind: 'bollinger', period: 20, multiplier: 2 },
  { kind: 'bollinger', period: 50, multiplier: 2.5, fillOpacity: 0.08 },
  { kind: 'ema', period: 20, color: '#c27a50' },
  { kind: 'sma', period: 200, color: '#c7ef57' },
  { kind: 'ema', period: 50, color: '#66b9c7' },
];
const studySeriesCount = (studies) =>
  studies.reduce(
    (total, study) => total + (study.kind === 'macd' ? 3 : study.kind === 'bollinger' ? 4 : 1),
    0,
  );
const oscillatorCount = (studies) =>
  studies.filter((study) => study.visible !== false && (study.kind === 'macd' || study.kind === 'rsi'))
    .length;
let server, browserServer, browser, context, page, cdp;
async function verifyPortFree() {
  await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePort));
  });
}
async function start() {
  const loadedCohort = await loadBrowserCohort(root);
  ({ chromium, firefox, webkit, details: browserCohort } = loadedCohort);
  report.environment.browserCohort = browserCohort;
  const installed = verifyConsumerIdentity(root, 'v0.7', report.sourceCommit);
  report.installation = {
    record: installed.record,
    sourceCommit: installed.sourceCommit,
    version: installed.version,
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
  browserServer = await chromium.launchServer(browserLaunchOptions('chromium'));
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
    window.studiesWorkload.snapshot([
      0, 18, 19, 24, 25, 32, 33, 34, 37, 38, 48, 49, 57, 58, 198, 199, 498, 499, 50000, 99998, 99999,
    ]),
  );
  assert.equal(result.bars.length, 100000);
  assert.equal(result.studies.length, 8);
  assert.equal(result.diagnostics.seriesCount, 22);
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
    verificationScope: 'selected rendered-output sampling; full retained OHLCV source hash',
    selectedIndices: result.rendered.map((observation) => observation.index),
    checkedRenderedPoints: points,
    ...observed,
  });
  event('maximum-oracle-pass', { label, rows: bars.length, points });
}
async function maximum() {
  await page.goto(origin + '/studies-test.html');
  await page.waitForFunction(() => window.studiesWorkload);
  const scene = await page.evaluate(
    (options) => window.studiesWorkload.mount(100000, options),
    maximumStudies,
  );
  assert.equal(scene.rows, 100000);
  assert.equal(scene.diagnostics.seriesCount, 22);
  assert.equal(scene.projection.panes.length, 5);
  report.maximum.scene = {
    rows: 100000,
    studies: maximumStudies,
    storedStudies: 8,
    studySeries: 20,
    series: 22,
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
    const beforeCounts = await page.evaluate(() => window.studiesWorkload.counts());
    for (let i = 0; i < events.length; i++) {
      const begin = Date.now();
      const sample = await page.evaluate(({ kind, i }) => window.studiesWorkload.deliver(kind, i), {
        kind: events[i],
        i,
      });
      report.maximum.tail.push({ ...sample, phase: label, dispatchedAt: begin });
      await pause(Math.max(0, 100 - (Date.now() - begin)));
    }
    const afterCounts = await page.evaluate(() => window.studiesWorkload.counts());
    assert.equal(
      afterCounts.historyRequests,
      beforeCounts.historyRequests,
      label + ': tail delivery cannot request retained history',
    );
    assert.equal(afterCounts.activeRequests, 0, label + ': no active history request after tail');
    (report.maximum.tailReadProof ??= []).push({
      label,
      events: events.length,
      before: beforeCounts,
      after: afterCounts,
      providerHistoryReads: 0,
    });
    event('maximum-tail-phase', { label, events: events.length });
  }
  await runEvents(Array(100).fill('replace'), '100k-replacements');
  await maximumSample('after-100k-tail-replacements');
  await page.evaluate((options) => window.studiesWorkload.mount(99900, options), maximumStudies);
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
    composition:
      report.maximum.scene.storedStudies === 8 &&
      report.maximum.scene.studySeries === 20 &&
      report.maximum.scene.series === 22 &&
      report.maximum.scene.panes === 5,
    rebuildSamples: report.maximum.rebuilds.length === 3,
    tailWork:
      report.maximum.tail.length === 300 &&
      report.maximum.tail.filter((sample) => sample.kind === 'append').length === 100 &&
      report.maximum.tail.filter((sample) => sample.kind === 'replace').length === 200,
    tailHistoryReads: report.maximum.tailReadProof.every((proof) => proof.providerHistoryReads === 0),
    wheelInputs: report.maximum.wheel.length === 24,
    frameObservations: report.maximum.frameGaps.length === 120,
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
  assert.equal(owned.consumer.detached, 0, label + ': no detached consumer nodes');
  assert.equal(owned.terminal.detached, 0, label + ': no detached terminal nodes');
  assert.equal(owned.terminal.rootCount, active ? 1 : 0, label + ': terminal root ownership');
  for (const generation of owned.terminal.generations)
    if (!generation.rootConnected)
      assert.equal(generation.total, 0, label + ': disposed generation ' + generation.id);
  if (!active) assert.equal(owned.terminal.total, 0, label + ': all terminal nodes released');
}

async function sample(label, full = false, flush = true, options = {}) {
  const { externalGate = false, recovery = false, negativeTailProbe = false } = options;
  await readyConsumer();
  const result = await page.evaluate(
    async ({ label, full, flush, externalGate }) => {
      const h = window.terminalHarness,
        t = h.terminal,
        f = h.fixture;
      const previousGate = f.stats().gated;
      if (externalGate && !previousGate) throw Error(label + ': external snapshot gate is not held');
      if (!externalGate) f.gate(true);
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
            throw Error(label + ': unflushed tail has invalid source revision');
          tailAsOf = tail.time + tail.revision * 250;
          const authoritativeTail = f.history(query, tailAsOf).find((bar) => bar.time === tail.time);
          if (!authoritativeTail) throw Error(label + ': unflushed tail missing from authority');
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
        if (!externalGate) f.gate(previousGate);
      }
    },
    { label, full, flush, externalGate },
  );
  assert.deepEqual(result.bars, result.truth, label + ': full source authority');
  if (recovery) {
    assert.equal(flush, false, 'Recovery checkpoint remains unflushed');
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
  const reservedSeries = studySeriesCount(visible);
  assert.equal(result.diagnostics.seriesCount, 1 + Number(result.state.settings.volume) + reservedSeries);
  assert.equal(result.panes.length, 1 + Number(result.state.settings.volume) + oscillatorCount(visible));
  let negativeProbe = null;
  if (negativeTailProbe) {
    assert.equal(externalGate, true, label + ': negative rendered-tail probe requires held gate');
    assert.equal(flush, false, label + ': negative rendered-tail probe runs before fresh delivery');
    const wrong = structuredClone(result);
    const tail = wrong.rendered.at(-1);
    const candidate = Object.entries(tail.points).find(
      ([id, point]) =>
        id !== 'terminal-price' && id !== 'terminal-volume' && point && Number.isFinite(point.value),
    );
    assert.ok(candidate, label + ': ready rendered tail value for negative probe');
    candidate[1].value += 1;
    const deliveriesBefore = await page.evaluate(() => window.terminalHarness.fixture.stats());
    assert.throws(
      () => verifyRendered(wrong, label + ' intentionally wrong rendered tail'),
      /diverged/,
      label + ': independent oracle rejects wrong rendered tail before repair',
    );
    const deliveriesAfter = await page.evaluate(() => window.terminalHarness.fixture.stats());
    assert.equal(
      deliveriesAfter.deliveries,
      deliveriesBefore.deliveries,
      label + ': no fresh delivery repairs wrong-tail probe',
    );
    assert.equal(
      deliveriesAfter.tailDeliveries,
      deliveriesBefore.tailDeliveries,
      label + ': no fresh tail delivery repairs wrong-tail probe',
    );
    negativeProbe = {
      outputId: candidate[0],
      index: tail.index,
      deliveriesBefore: deliveriesBefore.deliveries,
      deliveriesAfter: deliveriesAfter.deliveries,
      rejectedBeforeFreshDelivery: true,
    };
  }
  const checkedRenderedPoints = verifyRendered(result, label);
  const resourceObservation = await observeResources();
  const { bars, truth, ...observation } = result;
  const sampleRecord = {
    ...observation,
    full,
    rows: bars.length,
    checkedRenderedPoints,
    negativeProbe,
    actualHash: digest(JSON.stringify(bars)),
    authoritativeHash: digest(JSON.stringify(truth)),
    ...resourceObservation,
    at: new Date().toISOString(),
  };
  report.soak.samples.push(sampleRecord);
  assertOwnedDom(resourceObservation.ownedDom, true, label);
  event('soak-oracle-pass', { label, full, rows: bars.length, points: checkedRenderedPoints });
  return sampleRecord;
}
async function configure() {
  return await page.evaluate(async (options) => {
    const t = window.terminalHarness.terminal;
    for (const study of t.getStudies()) t.removeStudy(study.id);
    for (const option of options) t.addStudy(option);
    await t.chart.whenIdle();
    return t.getWorkspace();
  }, soakStudies);
}
async function soak() {
  await page.addInitScript(installOwnedDomTracker);
  await page.addInitScript(() => {
    window.__task4LongTasks = [];
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            window.__task4LongTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch {}
    }
  });
  await page.goto(origin + '/?source=fixture&test');
  await readyConsumer();
  const desktopScreenshot = resolve(stageDir, `multi-output-${stamp}-desktop.png`);
  const mobileScreenshot = resolve(stageDir, `multi-output-${stamp}-390px.png`);
  await page.locator('[data-terminal-studies-toggle]').click();
  const desktopRows = await page.evaluate(() => window.terminalHarness.terminal.getData().length);
  assert.ok(desktopRows >= 500, 'Desktop screenshot data must be fully hydrated');
  await page.screenshot({ path: desktopScreenshot, fullPage: true, caret: 'initial' });
  await page.locator('[data-terminal-studies-toggle]').click();
  report.soak.screenshots = {
    desktop: relative(root, desktopScreenshot),
    mobile: relative(root, mobileScreenshot),
    desktopRows,
    hydration: 'fixture live and chart idle before capture',
  };
  const original = await configure();
  const mixedDiagnostics = await page.evaluate(() => {
    const terminal = window.terminalHarness.terminal;
    return {
      series: terminal.chart.getDiagnostics().seriesCount,
      studies: terminal.getStudies().length,
    };
  });
  assert.deepEqual(mixedDiagnostics, { series: 20, studies: 8 });
  assert.equal(studySeriesCount(original.studies), 18);
  assert.equal(oscillatorCount(original.studies), 3);
  report.soak.scene = {
    storedStudies: 8,
    studySeries: 18,
    series: 20,
    panes: 5,
    studies: original.studies,
    expectedRows: '500..750 at full checkpoints',
  };
  const started = Date.now();
  report.soak.sessionStartedAt = new Date(started).toISOString();
  const deliveriesBefore = await page.evaluate(() => window.terminalHarness.fixture.stats().tailDeliveries);
  await sample('initial-mixed-eight-studies', true);
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
  let recoveryPriorGate;
  await withFixtureGate(page, async (previousGate) => {
    recoveryPriorGate = previousGate;
    const recoveryBefore = await page.evaluate(() => {
      const h = window.terminalHarness,
        t = h.terminal;
      const result = {
        times: t.getData().map((bar) => bar.time),
        query: t.getState().feed.query,
        disconnectedAt: Date.now(),
      };
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
      gate: { previous: previousGate, heldThroughSnapshot: false, restored: false },
    };
    const recoverySnapshot = await sample('recovery', true, false, { recovery: true });
    assert.equal(recoverySnapshot.statistics.gated, true, 'Recovery gate held through unflushed oracle');
    report.soak.recovery.gate.heldThroughSnapshot = true;
  });
  const recoveryRestoredGate = await page.evaluate(() => window.terminalHarness.fixture.stats().gated);
  assert.equal(recoveryRestoredGate, recoveryPriorGate, 'Recovery restores prior fixture gate');
  report.soak.recovery.gate.restored = true;
  report.soak.recovery.gate.after = recoveryRestoredGate;
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
  const legacyV2 = {
    ...original,
    version: 2,
    studies: original.studies.filter((study) => ['sma', 'ema', 'rsi'].includes(study.kind)),
  };
  await page.evaluate((saved) => window.terminalHarness.terminal.restoreWorkspace(saved), legacyV2);
  await sample('v2-migration', true);
  await page.evaluate((saved) => window.terminalHarness.terminal.restoreWorkspace(saved), original);
  await sample('v3-restore', true);
  const invalidPreviousGate = await page.evaluate(() => {
    const fixture = window.terminalHarness.fixture;
    const previous = fixture.stats().gated;
    fixture.gate(true);
    return previous;
  });
  try {
    const atomic = await page.evaluate(async () => {
      const h = window.terminalHarness,
        t = h.terminal,
        f = h.fixture;
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
      return { rejected, before, after: capture(), gate: f.stats().gated };
    });
    assert.equal(atomic.rejected, true);
    assert.equal(atomic.gate, true, 'Invalid restore remains delivery-gated');
    assert.deepEqual(atomic.after, atomic.before);
    report.soak.invalidRestore = {
      passed: true,
      gateHeldThroughRenderedOracle: true,
      beforeHash: digest(JSON.stringify(atomic.before)),
      afterHash: digest(JSON.stringify(atomic.after)),
    };
    const renderedCheckpoint = await sample('after-invalid-v3-restore', true, false, {
      externalGate: true,
      negativeTailProbe: true,
    });
    const originalSourceHash = digest(JSON.stringify(atomic.before.data));
    assert.equal(
      renderedCheckpoint.actualHash,
      originalSourceHash,
      'Invalid restore keeps original source revision',
    );
    report.soak.invalidRestore.renderedSourceHash = renderedCheckpoint.actualHash;
    report.soak.invalidRestore.originalSourceHash = originalSourceHash;
    report.soak.invalidRestore.renderedBeforeRepair = true;
  } finally {
    await page.evaluate((previous) => window.terminalHarness.fixture.gate(previous), invalidPreviousGate);
  }
  const stalePreviousGate = await page.evaluate(() => {
    const h = window.terminalHarness;
    const previous = h.fixture.stats().gated;
    h.fixture.gate(true);
    h.fixture.holdNextHistory();
    window.heldStudySwitch = h.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
    return previous;
  });
  try {
    await page.evaluate(() =>
      window.terminalHarness.terminal.setMarket({ symbol: 'SOLUSDT', interval: '5m' }),
    );
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
      // Longer than reconnectBaseMs: an obsolete callback must not schedule a retry.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const afterRetryWindow = capture();
      return {
        released,
        delivered,
        before,
        afterHistory,
        afterStream,
        afterRetryWindow,
        gate: h.fixture.stats().gated,
      };
    });
    assert.equal(stale.released, true);
    assert.ok(stale.delivered);
    assert.equal(stale.gate, true, 'Stale callbacks remain delivery-gated');
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
      gateHeldThroughRenderedOracle: true,
      beforeHash: digest(JSON.stringify(stale.before)),
      afterHistoryHash: digest(JSON.stringify(stale.afterHistory)),
      afterStreamHash: digest(JSON.stringify(stale.afterStream)),
      afterRetryWindowHash: digest(JSON.stringify(stale.afterRetryWindow)),
      state: stale.afterRetryWindow.state,
    };
    const renderedCheckpoint = await sample('rapid-switch-obsolete-callbacks', true, false, {
      externalGate: true,
      negativeTailProbe: true,
    });
    const originalSourceHash = digest(JSON.stringify(stale.before.data));
    assert.equal(
      renderedCheckpoint.actualHash,
      originalSourceHash,
      'Stale callbacks keep original source revision',
    );
    report.soak.obsoleteCallbacks.renderedSourceHash = renderedCheckpoint.actualHash;
    report.soak.obsoleteCallbacks.originalSourceHash = originalSourceHash;
    report.soak.obsoleteCallbacks.renderedBeforeRepair = true;
  } finally {
    await page.evaluate((previous) => window.terminalHarness.fixture.gate(previous), stalePreviousGate);
  }
  await page.evaluate(async (saved) => {
    const t = window.terminalHarness.terminal;
    await t.restoreWorkspace(saved);
    for (let i = 0; i < 25; i++) {
      const last = t.getStudies().at(-1);
      t.removeStudy(last.id);
      const id = t.addStudy({ kind: 'ema', period: 50, color: '#66b9c7' });
      t.updateStudy(id, { visible: false });
      t.updateStudy(id, { visible: true });
    }
    await t.restoreWorkspace(saved);
  }, original);
  report.soak.studyCycles = { addRemove: 25, hideShow: 25 };
  await sample('after-add-remove-cycles', false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-terminal-studies-toggle]').click();
  const uiIds = await page.evaluate(() => {
    const studies = window.terminalHarness.terminal.getStudies();
    return {
      macd: studies.find((study) => study.kind === 'macd').id,
      bollinger: studies.find((study) => study.kind === 'bollinger').id,
    };
  });
  const macdRow = page.locator(`[data-terminal-study-row="${uiIds.macd}"]`);
  const bollingerRow = page.locator(`[data-terminal-study-row="${uiIds.bollinger}"]`);
  const fast = macdRow.locator('[data-terminal-study-fast-period]');
  await fast.fill('10');
  await fast.focus();
  await pause(1100);
  assert.equal(await fast.inputValue(), '10');
  assert.equal(
    await fast.evaluate((element) => document.activeElement === element),
    true,
    'Streaming retains keyed MACD editor focus',
  );
  await fast.press('Tab');
  await macdRow.locator('[data-terminal-study-slow-period]').fill('30');
  await macdRow.locator('[data-terminal-study-slow-period]').press('Tab');
  await macdRow.locator('[data-terminal-study-signal-period]').fill('7');
  await macdRow.locator('[data-terminal-study-signal-period]').press('Tab');
  await macdRow.locator('[data-terminal-study-width]').selectOption('3');
  for (const [field, value] of [
    ['color', '#abcdef'],
    ['signal-color', '#fedcba'],
    ['positive-color', '#33cc77'],
    ['negative-color', '#ee5577'],
  ]) {
    const input = macdRow.locator(`[data-terminal-study-${field}]`);
    await input.fill(value);
    await input.press('Tab');
  }
  await bollingerRow.locator('[data-terminal-study-period]').fill('21');
  await bollingerRow.locator('[data-terminal-study-period]').press('Tab');
  await bollingerRow.locator('[data-terminal-study-multiplier]').fill('1.75');
  await bollingerRow.locator('[data-terminal-study-multiplier]').press('Tab');
  await bollingerRow.locator('[data-terminal-study-fill-opacity]').fill('0.2');
  await bollingerRow.locator('[data-terminal-study-fill-opacity]').press('Tab');
  await bollingerRow.locator('[data-terminal-study-width]').selectOption('4');
  for (const [field, value] of [
    ['color', '#aabbcc'],
    ['upper-color', '#88aaff'],
    ['lower-color', '#6688dd'],
    ['fill-color', '#4466aa'],
  ]) {
    const input = bollingerRow.locator(`[data-terminal-study-${field}]`);
    await input.fill(value);
    await input.press('Tab');
  }
  const configured = await page.evaluate((ids) => {
    const studies = window.terminalHarness.terminal.getStudies();
    return {
      macd: studies.find((study) => study.id === ids.macd),
      bollinger: studies.find((study) => study.id === ids.bollinger),
    };
  }, uiIds);
  assert.deepEqual(configured.macd, {
    ...configured.macd,
    fastPeriod: 10,
    slowPeriod: 30,
    signalPeriod: 7,
    color: '#abcdef',
    signalColor: '#fedcba',
    positiveColor: '#33cc77',
    negativeColor: '#ee5577',
    lineWidth: 3,
  });
  assert.deepEqual(configured.bollinger, {
    ...configured.bollinger,
    period: 21,
    multiplier: 1.75,
    color: '#aabbcc',
    upperColor: '#88aaff',
    lowerColor: '#6688dd',
    fillColor: '#4466aa',
    fillOpacity: 0.2,
    lineWidth: 4,
  });
  report.soak.nativeEditor = { uiIds, configured, keyboardFocusPreserved: true };
  await bollingerRow.locator('[data-terminal-study-visible]').uncheck();
  const hidden = await page.evaluate(async (hiddenId) => {
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
    return {
      study: t.getStudies().find((study) => study.id === hiddenId),
      series: t.chart.getDiagnostics().seriesCount,
      panes,
    };
  }, uiIds.bollinger);
  assert.equal(hidden.study.visible, false);
  assert.equal(hidden.series, 16);
  assert.equal(hidden.panes.length, 5);
  assert.ok(!hidden.panes.includes('terminal-' + hidden.study.id + '-pane'));
  report.soak.hiddenResources = {
    ...hidden,
    hiddenOutputIds: studySeriesIds(hidden.study),
    passed: true,
  };
  await sample('ui-hidden-study', true);
  await bollingerRow.locator('[data-terminal-study-visible]').check();
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
  const mobileRows = await page.evaluate(() => window.terminalHarness.terminal.getData().length);
  assert.ok(mobileRows >= 500, 'Mobile screenshot data must be fully hydrated');
  report.soak.screenshots.mobileRows = mobileRows;
  await page.screenshot({ path: mobileScreenshot, fullPage: true, caret: 'initial' });
  await page.locator('[data-terminal-studies-toggle]').click();
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  const saved = await page.evaluate(() => window.terminalHarness.terminal.getWorkspace());
  await page.evaluate(() =>
    window.terminalHarness.terminal.updateStudy(window.terminalHarness.terminal.getStudies()[0].id, {
      signalPeriod: 9,
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
  await sample('final-equivalent-mixed-eight-studies', true);
  report.soak.actualSessionMs = Date.now() - started;
  report.soak.sessionFinishedAt = new Date().toISOString();
  report.soak.tailDeliveries =
    (await page.evaluate(() => window.terminalHarness.fixture.stats().tailDeliveries)) - deliveriesBefore;
  report.soak.observations = await page.evaluate(() => ({
    longTasks: window.__task4LongTasks ?? [],
    visibility: window.terminalHarness.visibility,
    visibilityState: document.visibilityState,
  }));
  const fullCheckpoints = report.soak.samples.filter((sample) => sample.full);
  report.soak.fullOracleCheckpoints = fullCheckpoints.map((sample) => ({
    label: sample.label,
    rows: sample.rows,
    checkedRenderedPoints: sample.checkedRenderedPoints,
  }));
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
    composition:
      report.soak.scene.studySeries === 18 &&
      report.soak.scene.series === 20 &&
      report.soak.scene.panes === 5,
    duration: report.soak.actualSessionMs >= 120000,
    samples: report.soak.samples.length >= 12,
    fullOracles:
      fullCheckpoints.length >= 10 &&
      fullCheckpoints.every((sample) => sample.rows >= 500 && sample.rows <= 750),
    deliveries: report.soak.tailDeliveries >= 300,
    ownedConsumerNodes: report.soak.growth.ownedConsumerNodes <= 0,
    ownedTerminalNodes: report.soak.growth.ownedTerminalNodes <= 0,
    retainedOutside: report.soak.samples.every(
      (sample) =>
        sample.ownedDom.consumer.retainedOutside === 0 && sample.ownedDom.terminal.retainedOutside === 0,
    ),
    detached: report.soak.samples.every(
      (sample) => sample.ownedDom.consumer.detached === 0 && sample.ownedDom.terminal.detached === 0,
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
  report.checks.soak.studyCycles =
    report.soak.studyCycles.addRemove === 25 && report.soak.studyCycles.hideShow === 25;
  report.checks.soak.remounts = report.soak.remounts.length === 6;
  event('soak-measured', {
    actualSessionMs: report.soak.actualSessionMs,
    tailDeliveries: report.soak.tailDeliveries,
    growth: report.soak.growth,
    checks: report.checks.soak,
  });
  assert.ok(Object.values(report.checks.soak).every(Boolean), 'Installed-consumer soak gate failed');
}
async function crossBrowserCoverage() {
  const engines = [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ];
  for (const [name, engine] of engines) {
    coverageProcesses.assertActive('before ' + name + ' iteration');
    let owner;
    let record;
    try {
      owner = await coverageProcesses.launch(name, engine);
      coverageProcesses.assertActive('before ' + name + ' page');
      const coveragePage = await owner.browser.newPage({ viewport: { width: 1440, height: 1000 } });
      coverageProcesses.assertActive('after ' + name + ' page');
      const errors = [];
      coveragePage.on('pageerror', (error) => errors.push(error.stack || error.message));
      await coveragePage.goto(origin + '/?source=fixture&test');
      coverageProcesses.assertActive('after ' + name + ' navigation');
      await coveragePage.waitForFunction(
        () => {
          const terminal = window.terminalHarness?.terminal;
          return (
            terminal &&
            !terminal.getState().destroyed &&
            terminal.getState().feed.status === 'live' &&
            terminal.getState().error === null &&
            terminal.getData().length >= 500
          );
        },
        {},
        { timeout: 20000 },
      );
      coverageProcesses.assertActive('after ' + name + ' readiness');
      const desktop = await captureCoherentTerminal(coveragePage, 300);
      coverageProcesses.assertActive('after ' + name + ' coherent snapshot');
      assert.ok(
        desktop.bars.length >= 500 && desktop.bars.length <= 750,
        name + ': hydrated default fixture rows',
      );
      assert.equal(desktop.studies.length, 5, name + ': five-study demo');
      assert.equal(desktop.diagnostics.seriesCount, 12, name + ': ten study outputs plus price/volume');
      assert.equal(desktop.panes.length, 4, name + ': price, volume, MACD, RSI panes');
      assert.ok(desktop.coherence.holdMs >= 250, name + ': coherent snapshot spans timer interval');
      assert.equal(
        desktop.coherence.afterTimer.deliveries,
        desktop.coherence.beforeTimer.deliveries,
        name + ': delivery gate holds source revision across timer interval',
      );
      assert.equal(
        desktop.coherence.afterTimer.tailDeliveries,
        desktop.coherence.beforeTimer.tailDeliveries,
        name + ': no tail delivery during coherent extraction',
      );
      const renderedPoints = verifyRendered(desktop, name + ' installed consumer');
      await coveragePage.setViewportSize({ width: 390, height: 844 });
      coverageProcesses.assertActive('after ' + name + ' mobile viewport');
      await coveragePage.locator('[data-terminal-studies-toggle]').click();
      await coveragePage.locator('[data-terminal-study-fast-period]').first().scrollIntoViewIfNeeded();
      await coveragePage.locator('[data-terminal-study-fill-opacity]').first().scrollIntoViewIfNeeded();
      coverageProcesses.assertActive('after ' + name + ' mobile controls');
      const mobile = await coveragePage.evaluate(() => {
        const terminalRoot = document.querySelector('[data-filtix-terminal]');
        return {
          documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          terminalFits: terminalRoot.scrollWidth <= terminalRoot.clientWidth,
          fastFields: document.querySelectorAll('[data-terminal-study-fast-period]').length,
          fillFields: document.querySelectorAll('[data-terminal-study-fill-opacity]').length,
        };
      });
      coverageProcesses.assertActive('before ' + name + ' record');
      assert.ok(mobile.documentFits && mobile.terminalFits, name + ': 390px viewport overflow');
      assert.ok(mobile.fastFields > 0 && mobile.fillFields > 0, name + ': multi-output controls');
      assert.deepEqual(errors, [], name + ': browser page errors');
      record = {
        engine: name,
        version: owner.browser.version(),
        pid: owner.pid,
        executable: browserCohort[name],
        coherence: desktop.coherence,
        desktop: { width: 1440, height: 1000, rows: desktop.bars.length, renderedPoints },
        mobile: { width: 390, height: 844, ...mobile },
        cleanup: false,
      };
      report.browserCoverage.push(record);
      event('browser-coverage-pass', { engine: name, renderedPoints, pid: owner.pid });
    } finally {
      if (owner) {
        await coverageProcesses.close(owner);
        if (!finalized && record) {
          const processRecord = coverageProcesses.records().find((item) => item.pid === owner.pid);
          record.cleanup = processRecord?.closed === true && processRecord.processExited === true;
          record.forcedCleanup = processRecord?.forced ?? false;
        }
      }
    }
  }
  coverageProcesses.assertActive('after all coverage engines');
  report.checks.browserCoverage =
    report.browserCoverage.length === 3 &&
    report.browserCoverage.every(
      (item) =>
        item.desktop.rows >= 500 &&
        item.mobile.documentFits &&
        item.mobile.terminalFits &&
        item.cleanup === true,
    );
  assert.equal(report.checks.browserCoverage, true, 'Three-engine desktop/mobile coverage');
}

async function executeWorkload() {
  await bounded(start(), 60000, 'Startup');
  if (mode !== 'soak') await bounded(maximum(), 300000, 'Maximum workload');
  if (mode !== 'max') await bounded(soak(), 900000, 'Installed consumer session');
  if (mode === 'all')
    await bounded(crossBrowserCoverage(), 180000, 'Three-engine coverage', () => {
      coverageCancelled = true;
    });
  for (const item of report.identities)
    assert.equal(
      digest(readFileSync(resolve(root, item.path))),
      item.sha256,
      'Candidate changed: ' + item.path,
    );
  const finalInstall = verifyConsumerIdentity(root, 'v0.7', report.sourceCommit);
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
async function closeCoverageBrowsers() {
  try {
    await coverageProcesses.closeAll();
    report.cleanup.coverageBrowsers = {
      passed: coverageProcesses.records().every((item) => item.closed && item.processExited),
      processes: coverageProcesses.records(),
      launches: coverageProcesses.launches,
    };
  } catch (error) {
    report.errors.push('coverage browser cleanup: ' + String(error));
    report.cleanup.coverageBrowsers = {
      passed: false,
      processes: coverageProcesses.records(),
      launches: coverageProcesses.launches,
    };
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
  coverageCancelled = true;
  report.errors.push(error.stack || String(error));
  event('failure', { message: String(error) });
} finally {
  stopRequested = true;
  coverageCancelled = true;
  // Independent cleanup: a hung browser cannot prevent the owned preview or coverage browsers from exiting.
  await Promise.allSettled([closeBrowser(), closeCoverageBrowsers(), closePreview()]);
  finalized = true;
  report.finishedAt = new Date().toISOString();
  report.status =
    report.errors.length === 0 &&
    report.cleanup.browser &&
    report.cleanup.coverageBrowsers?.passed &&
    report.cleanup.preview
      ? 'pass'
      : 'fail';
  save();
  console.log(
    JSON.stringify({ status: report.status, evidence: relative(root, out), errors: report.errors }),
  );
  if (report.status !== 'pass') process.exitCode = 1;
}
