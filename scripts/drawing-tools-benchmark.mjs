import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, verifyConsumerIdentity } from './consumer-identity.mjs';
import {
  DRAWING_MIX,
  BUDGETS,
  recordEvidenceAttempt,
  validateDrawingEvidence,
  verifyDrawingCheckpoint,
} from './drawing-tools-oracle.mjs';
import { installOwnedDomTracker } from './studies-resources.mjs';
import { loadBrowserCohort, browserLaunchOptions } from './multi-output-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'all';
assert.ok(['all', 'max', 'soak'].includes(mode), 'Use --mode=all|max|soak');
const port = 5202,
  origin = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const output = resolve(root, 'benchmark-results/v0.9/drawing-tools-' + mode + '-' + stamp + '.json');
mkdirSync(resolve(root, 'benchmark-results/v0.9'), { recursive: true });
const artifactDir = resolve(root, 'benchmark-results/v0.9/drawing-tools-' + mode + '-' + stamp);
const pixelDir = resolve(artifactDir, 'pixels');
mkdirSync(pixelDir, { recursive: true });
const journal = resolve(artifactDir, 'attempts.jsonl');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let server,
  browserServer,
  browser,
  context,
  page,
  cdp,
  stopRequested = false;
const report = {
  schema: 'filtix-drawing-tools-installed-evidence',
  version: 1,
  mode,
  status: 'running',
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  source: sourceIdentity(root),
  attemptJournal: relative(root, journal).replaceAll('\\', '/'),
  candidateArchives: [
    'analysis',
    'charts',
    'core',
    'datafeed',
    'drawings',
    'indicators',
    'react',
    'terminal',
  ].map((name) => {
    const path = `dist/packages/filtix-${name}-0.9.0.tgz`;
    return {
      path,
      sha256: existsSync(resolve(root, path)) ? digest(readFileSync(resolve(root, path))) : null,
    };
  }),
  environment: {
    node: process.version,
    platform: os.platform(),
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    browser: null,
    headless: true,
  },
  qualification:
    'Headless installed eight-archive consumer; submitted annotation Canvas calls and named screenshot pixels; no physical-device or frame-latency claim',
  fullOperationTiming: {
    budgetFields: ['sceneSync', 'restoreSync'],
    gatedMetric: 'operationWorkUpperBoundMs',
    formula: 'processingElapsedMs + sum(all submitted chart frame renderMs)',
    processingBoundary:
      'before constructor through completed initial/history ingestion, reference range, prepared drawing/workspace restore; excludes only final chart idle drain',
    qualification:
      'Conservative upper bound including provider/microtask waits and possibly double-counted render work; synchronousMs is exact measured API kickoff only, not the full-work budget metric',
  },
  declared: {
    mix: DRAWING_MIX,
    budgets: BUDGETS,
    maximumTargetHz: 10,
    mixedTargetHz: 4,
    sourceRows: 100000,
    visibleBars: 1000,
    series: 12,
    panes: 4,
    notesMaxLines: 3,
    fibonacciDefaultLevels: 7,
    fullCheckpoints: 12,
    mixedMinimumMs: 120000,
    mixedDeliveries: 300,
    addRemoveCycles: 25,
    remounts: 6,
  },
  installation: null,
  scene: null,
  warmup: null,
  samples: {
    sceneSync: [],
    sceneSettled: [],
    restoreSync: [],
    restoreSettled: [],
    updateWork: [],
    updateSettled: [],
    navigationWork: [],
    navigationSettled: [],
    tailSync: [],
    tailSettled: [],
    wheelInclusive: [],
  },
  raw: { warmup: [], scenes: [], restores: [], updates: [], navigation: [], tail: [], wheel: [] },
  cadence: {
    maximum: [],
    mixed: {
      elapsedMs: 0,
      deliveries: 0,
      targetIntervalMs: 250,
      targetAt: [],
      dispatchedAt: [],
      actualAt: [],
      pauses: [],
    },
  },
  checkpoints: [],
  lifecycle: { addRemoveCycles: 0, remounts: 0, actions: [] },
  resources: {},
  cleanup: {},
  servedAssets: [],
  errors: [],
  checks: {},
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const event = (name, detail = {}) => {
  report.lastEvent = { name, at: new Date().toISOString(), ...detail };
  save();
  console.log(JSON.stringify(report.lastEvent));
};
process.on('SIGINT', () => {
  stopRequested = true;
});
process.on('SIGTERM', () => {
  stopRequested = true;
});
const active = () => {
  if (stopRequested) throw Error('Workload interrupted');
};
async function portFree() {
  await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePort));
  });
}
async function startPreview() {
  await portFree();
  active();
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
  let log = '',
    startupError;
  server.on('error', (error) => {
    startupError = error;
  });
  server.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  server.stderr.on('data', (chunk) => {
    log += String(chunk);
  });
  report.ownedPreviewPid = server.pid;
  for (let i = 0; i < 150; i++) {
    active();
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw Error('Preview exited: ' + log);
    try {
      if ((await fetch(origin + '/?test&drawing-tools', { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* Startup probe. */
    }
    await sleep(100);
  }
  throw Error('Owned preview did not start: ' + log);
}
async function startBrowser() {
  const { chromium, details } = await loadBrowserCohort(root);
  report.environment.browserCohort = details;
  browserServer = await chromium.launchServer(browserLaunchOptions('chromium'));
  report.ownedBrowserPid = browserServer.process().pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1 });
  await context.addInitScript(installOwnedDomTracker, {
    consumerRootSelector: '#drawing-tools-host',
    terminalRootSelector: '[data-filtix-terminal-instance]',
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) =>
    report.errors.push({ kind: 'pageerror', message: error.stack || error.message }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text() });
  });
  const assetChecks = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script' || new URL(response.url()).origin !== origin) return;
    assetChecks.push(
      (async () => {
        const path = decodeURIComponent(new URL(response.url()).pathname);
        const local = resolve(root, 'examples/react-terminal/dist', '.' + path);
        const servedSha256 = digest(Buffer.from(await response.body()));
        const expectedSha256 = digest(readFileSync(local));
        assert.equal(servedSha256, expectedSha256, 'Served installed asset mismatch: ' + path);
        return { path, sha256: servedSha256 };
      })(),
    );
  });
  await page.goto(origin + '/?test&drawing-tools', { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.terminalHarness?.drawingTools));
  report.servedAssets = await Promise.all(assetChecks);
  assert.ok(report.servedAssets.length > 0, 'Executed installed consumer asset required');
}
async function sampleCheckpoint(label, full = true) {
  active();
  const checkpoint = { id: label, full, status: 'collecting', startedAt: new Date().toISOString() };
  report.checkpoints.push(checkpoint);
  save();
  try {
    const capture = await page.evaluate((id) => window.terminalHarness.drawingTools.checkpoint(id), label);
    checkpoint.generation = capture.generation;
    checkpoint.market = capture.market;
    checkpoint.document = capture.document;
    checkpoint.partial = capture.partial;
    checkpoint.captureError = capture.captureError ?? capture.captureFailure ?? null;
    checkpoint.cleanupError = capture.cleanupError ?? null;
    if (capture.source) {
      const actual = Buffer.from(JSON.stringify(capture.source.bars));
      const expected = Buffer.from(JSON.stringify(capture.source.expectedBars));
      checkpoint.source = {
        rows: capture.source.rows,
        sha256: digest(actual),
        expectedSha256: digest(expected),
        bars: [capture.source.bars[0], capture.source.bars.at(-1)],
        expectedBars: [capture.source.expectedBars[0], capture.source.expectedBars.at(-1)],
        provenance: capture.source.provenance,
        canonicalEncoding: 'JSON.stringify(all retained OHLCV rows in order)',
        canonicalBytes: actual.length,
        expectedCanonicalBytes: expected.length,
      };
    }
    checkpoint.observation = capture.observation;
    if (capture.captureFailure || capture.sourceFailure)
      throw Error(capture.captureFailure || capture.sourceFailure);
    checkpoint.status = 'captured-canvas';
    save();
    const pixelBytes = await page.locator('#drawing-tools-host').screenshot();
    assert.ok(
      pixelBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'Named screenshot is not PNG',
    );
    const pixelPath = resolve(pixelDir, label + '.png');
    writeFileSync(pixelPath, pixelBytes);
    checkpoint.observation.pixel = {
      pngSha256: digest(pixelBytes),
      width: pixelBytes.readUInt32BE(16),
      height: pixelBytes.readUInt32BE(20),
      bytes: pixelBytes.length,
      path: relative(root, pixelPath).replaceAll('\\', '/'),
      scope: '#drawing-tools-host screenshot',
    };
    checkpoint.status = 'collected';
    appendFileSync(journal, JSON.stringify({ kind: 'checkpoint', ...checkpoint }) + '\n');
    save();
    verifyDrawingCheckpoint(checkpoint);
    checkpoint.status = 'accepted';
    appendFileSync(journal, JSON.stringify({ kind: 'checkpoint', ...checkpoint }) + '\n');
    save();
    return checkpoint;
  } catch (error) {
    checkpoint.status = 'rejected';
    checkpoint.error = error instanceof Error ? error.message : String(error);
    appendFileSync(journal, JSON.stringify({ kind: 'checkpoint', ...checkpoint }) + '\n');
    save();
    throw error;
  }
}
async function resourceSample(label) {
  const prior = await page.evaluate(() => {
    const h = window.terminalHarness;
    const prior = h.drawingTools.counts();
    h.fixture.gate(true);
    return prior;
  });
  try {
    await page.evaluate(async () => {
      await window.terminalHarness.terminal?.chart.whenIdle();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    const prepared = await page.evaluate(() => window.__filtixOwnedDomTracker.prepare());
    for (let cycle = 0; cycle < 3; cycle++) {
      const turn = await page.evaluate(() => {
        const n = (window.__drawingGcTurn ?? 0) + 1;
        setTimeout(() => {
          window.__drawingGcTurn = n;
        }, 0);
        return n;
      });
      await page.waitForFunction((expected) => window.__drawingGcTurn === expected, turn);
      await cdp.send('HeapProfiler.collectGarbage');
    }
    const counters = await cdp.send('Memory.getDOMCounters');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const owned = await page.evaluate(() => window.__filtixOwnedDomTracker.sample());
    return { label, prepared, counters, heap: { usedSize: heap.usedSize, totalSize: heap.totalSize }, owned };
  } finally {
    await page.evaluate((was) => window.terminalHarness.fixture.gate(was), prior.gated);
  }
}
async function releaseFixtureCallbackForResourceSample(phase) {
  const attempt = { phase, status: 'collecting' };
  report.resources.fixtureCallbackRelease ??= {};
  report.resources.fixtureCallbackRelease[phase] = attempt;
  save();
  try {
    const { before, first, after, second } = await page.evaluate(() => {
      const fixture = window.terminalHarness.drawingTools;
      const capture = () => ({ html: fixture.host.innerHTML, counts: fixture.counts() });
      const before = capture();
      const first = fixture.obsoleteDelivery();
      const after = capture();
      const second = fixture.obsoleteDelivery();
      return { before, first, after, second };
    });
    attempt.callbackPresent = first !== null;
    attempt.beforeHtmlSha256 = digest(Buffer.from(before.html));
    attempt.afterHtmlSha256 = digest(Buffer.from(after.html));
    attempt.beforeCounts = before.counts;
    attempt.afterCounts = after.counts;
    attempt.secondDelivery = second;
    attempt.status = 'collected';
    save();
    assert.ok(
      first || (mode === 'soak' && phase === 'baseline'),
      phase + ': fixture obsolete callback required before resource sample',
    );
    if (first) {
      assert.deepEqual(first.before, before, phase + ': fixture callback before-state mismatch');
      assert.deepEqual(first.after, after, phase + ': fixture callback after-state mismatch');
    }
    assert.equal(after.html, before.html, phase + ': fixture callback mutated active HTML');
    assert.deepEqual(after.counts, before.counts, phase + ': fixture callback changed counts');
    assert.equal(second, null, phase + ': fixture callback not drained');
    attempt.status = 'accepted';
    save();
    return attempt;
  } catch (error) {
    attempt.status = 'rejected';
    attempt.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  }
}
function addTiming(kind, sample, raw) {
  sample.phase ??= kind;
  recordEvidenceAttempt(
    raw,
    sample,
    (candidate) => {
      assert.ok(
        Number.isFinite(candidate.synchronousMs) &&
          Number.isFinite(candidate.settledMs) &&
          Number.isFinite(candidate.libraryWorkMs) &&
          candidate.synchronousMs >= 0 &&
          candidate.settledMs >= candidate.synchronousMs,
        kind + ': finite timing',
      );
      assert.equal(candidate.frameSubmitted, true, kind + ': newly submitted frame required');
      assert.ok(
        Number.isFinite(candidate.renderMs) && candidate.renderMs > 0,
        kind + ': measured frame render work required',
      );
      if (candidate.scope)
        assert.ok(
          Array.isArray(candidate.frames) &&
            candidate.frames.length > 0 &&
            candidate.frames.every((frame) => Number.isFinite(frame.renderMs) && frame.renderMs > 0) &&
            Math.abs(candidate.frames.reduce((sum, frame) => sum + frame.renderMs, 0) - candidate.renderMs) <
              1e-6,
          kind + ': full multi-frame work incomplete',
        );
      if (candidate.scope)
        assert.ok(
          Number.isFinite(candidate.operationWorkUpperBoundMs) &&
            Number.isFinite(candidate.components?.processingElapsedMs) &&
            Number.isFinite(candidate.components?.finalIdleDrainMs) &&
            candidate.components.processingElapsedMs >= candidate.synchronousMs &&
            candidate.components.finalIdleDrainMs >= 0 &&
            Math.abs(
              candidate.operationWorkUpperBoundMs -
                candidate.components.processingElapsedMs -
                candidate.renderMs,
            ) < 1e-6,
          kind + ': complete operation work bound missing',
        );
    },
    () => appendFileSync(journal, JSON.stringify({ kind: 'timing', ...sample }) + '\n'),
  );
}
async function collectTiming(kind, raw, operation, metadata = {}) {
  const candidate = { phase: kind, status: 'collecting', ...metadata };
  raw.push(candidate);
  appendFileSync(journal, JSON.stringify({ kind: 'timing', ...candidate }) + '\n');
  save();
  try {
    Object.assign(candidate, await operation());
    if (candidate.status === 'rejected') throw Error(candidate.error || 'Browser timing collection rejected');
    addTiming(kind, candidate, raw);
    save();
    return candidate;
  } catch (error) {
    candidate.status = 'rejected';
    candidate.error ??= error instanceof Error ? error.message : String(error);
    appendFileSync(journal, JSON.stringify({ kind: 'timing', ...candidate }) + '\n');
    save();
    throw error;
  }
}
async function runMaximum() {
  await page.evaluate(() => window.terminalHarness.drawingTools.prepare(100000));
  report.warmup = await collectTiming('warmup', report.raw.warmup, () =>
    page.evaluate(() => window.terminalHarness.drawingTools.fullOperation('full-scene')),
  );
  assert.deepEqual(
    [report.warmup.rows, report.warmup.drawings, report.warmup.series, report.warmup.panes],
    [100000, 200, 12, 4],
  );
  const mounted = report.warmup;
  report.scene = {
    rows: mounted.rows,
    drawings: mounted.drawings,
    visibleBars: 1000,
    series: mounted.series,
    panes: mounted.panes,
    drawingMix: DRAWING_MIX,
    studies: await page.evaluate(() => window.terminalHarness.terminal.getStudies()),
    source: 'deterministic generated OHLCV outside timing',
    viewport: report.environment.viewport,
  };
  const doc = await page.evaluate(() => window.terminalHarness.terminal.getDrawings().toJSON());
  assert.equal(doc.drawings.length, 200);
  assert.ok(doc.drawings.every((drawing) => drawing.visible && drawing.paneId === 'price'));
  assert.ok(
    doc.drawings
      .filter((drawing) => drawing.type === 'fibonacci-retracement')
      .every((drawing) => drawing.levels.length === 7),
  );
  assert.ok(
    doc.drawings
      .filter((drawing) => drawing.type === 'text-note')
      .every((drawing) => drawing.text.split('\n').length <= 3),
  );
  const workspace = await page.evaluate(() => window.terminalHarness.terminal.getWorkspace());
  await sampleCheckpoint('maximum-after-warmup');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.terminalHarness.drawingTools.prepare(100000));
    const scene = await collectTiming('scene', report.raw.scenes, () =>
      page.evaluate(() => window.terminalHarness.drawingTools.fullOperation('full-scene')),
    );
    report.samples.sceneSync.push(scene.operationWorkUpperBoundMs);
    report.samples.sceneSettled.push(scene.settledMs);
    await page.evaluate(() => window.terminalHarness.drawingTools.prepare(100000));
    const restore = await collectTiming('restore', report.raw.restores, () =>
      page.evaluate(
        (document) => window.terminalHarness.drawingTools.fullOperation('full-workspace-restore', document),
        workspace,
      ),
    );
    report.samples.restoreSync.push(restore.operationWorkUpperBoundMs);
    report.samples.restoreSettled.push(restore.settledMs);
  }
  await sampleCheckpoint('maximum-after-full-workspace-restore');
  for (let i = 0; i < 100; i++) {
    active();
    const sample = await collectTiming(
      'update',
      report.raw.updates,
      () => page.evaluate((index) => window.terminalHarness.drawingTools.edit(index), i),
      { sequence: i },
    );
    assert.equal(sample.frameSubmitted, true, 'Effective drawing update must submit a frame');
    report.samples.updateWork.push(sample.libraryWorkMs);
    report.samples.updateSettled.push(sample.settledMs);
  }
  await sampleCheckpoint('maximum-after-updates');
  const phases = [
    { phase: 'replace', kinds: Array(100).fill('replace') },
    { phase: 'append-replace', kinds: Array.from({ length: 200 }, (_, i) => (i % 2 ? 'replace' : 'append')) },
  ];
  for (const phase of phases) {
    if (phase.phase === 'append-replace') {
      const reset = await page.evaluate(() => window.terminalHarness.drawingTools.mount(99900));
      assert.equal(reset.rows, 99900);
    }
    const times = [],
      dispatches = [],
      targets = [],
      phaseStart = Date.now();
    for (let i = 0; i < phase.kinds.length; i++) {
      active();
      const targetAt = phaseStart + i * 100;
      await sleep(Math.max(0, targetAt - Date.now()));
      const dispatchedAt = Date.now();
      const sample = await collectTiming(
        'tail',
        report.raw.tail,
        () =>
          page.evaluate(({ kind, i }) => window.terminalHarness.drawingTools.deliver(kind, i), {
            kind: phase.kinds[i],
            i,
          }),
        { deliveryPhase: phase.phase, targetAt, dispatchedAt, sequence: i },
      );
      assert.ok(Number.isFinite(sample.browserDeliveredAt), 'Browser tail delivery timestamp missing');
      report.samples.tailSync.push(sample.synchronousMs);
      report.samples.tailSettled.push(sample.settledMs);
      targets.push(targetAt);
      dispatches.push(dispatchedAt);
      times.push(sample.browserDeliveredAt);
    }
    report.cadence.maximum.push({
      phase: phase.phase,
      deliveries: times.length,
      targetIntervalMs: 100,
      targetAt: targets,
      actualAt: times,
      dispatchedAt: dispatches,
      elapsedMs: times.at(-1) - times[0],
      achievedHz: ((times.length - 1) * 1000) / (times.at(-1) - times[0]),
    });
    await sampleCheckpoint('maximum-after-' + phase.phase);
    event('maximum-tail-phase', { phase: phase.phase, deliveries: times.length });
  }
  for (let i = 0; i < 240; i++) {
    active();
    const sample = await collectTiming(
      'navigation',
      report.raw.navigation,
      () => page.evaluate((index) => window.terminalHarness.drawingTools.navigate(index), i),
      { sequence: i },
    );
    report.samples.navigationWork.push(sample.libraryWorkMs);
    report.samples.navigationSettled.push(sample.settledMs);
  }
  const canvas = page.locator('#drawing-tools-host canvas[data-filtix-layer="overlay"]');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'Wheel target canvas missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 24; i++) {
    active();
    const wheel = { sequence: i, status: 'collecting' };
    report.raw.wheel.push(wheel);
    appendFileSync(journal, JSON.stringify({ kind: 'wheel', ...wheel }) + '\n');
    save();
    try {
      wheel.beforeRange = await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange());
      const begin = Date.now();
      await page.mouse.wheel(0, i % 2 ? 80 : -80);
      await page.evaluate(() => window.terminalHarness.terminal.chart.whenIdle());
      wheel.automationInclusiveMs = Date.now() - begin;
      wheel.afterRange = await page.evaluate(() => window.terminalHarness.terminal.chart.getVisibleRange());
      recordEvidenceAttempt(
        report.raw.wheel,
        wheel,
        (candidate) => {
          assert.ok(Number.isFinite(candidate.automationInclusiveMs) && candidate.automationInclusiveMs >= 0);
          assert.notDeepEqual(
            candidate.afterRange,
            candidate.beforeRange,
            'Real wheel produced no chart change',
          );
        },
        () => appendFileSync(journal, JSON.stringify({ kind: 'wheel', ...wheel }) + '\n'),
      );
      report.samples.wheelInclusive.push(wheel.automationInclusiveMs);
    } catch (error) {
      if (wheel.status !== 'rejected') {
        wheel.status = 'rejected';
        wheel.error = error instanceof Error ? error.message : String(error);
        appendFileSync(journal, JSON.stringify({ kind: 'wheel', ...wheel }) + '\n');
      }
      save();
      throw error;
    }
  }
  await sampleCheckpoint('maximum-after-navigation-wheel');
  const limits = await page.evaluate(async () => {
    const store = window.terminalHarness.terminal.getDrawings();
    const fib = store.get('b4-fibonacci-retracement-0'),
      note = store.get('b4-text-note-0');
    store.update(fib.id, { levels: Array.from({ length: 32 }, (_, i) => ({ ratio: -10 + (i * 20) / 31 })) });
    store.update(note.id, { text: Array.from({ length: 20 }, (_, i) => 'Line ' + i).join('\n') });
    await window.terminalHarness.terminal.chart.whenIdle();
    const observed = {
      levels: store.get(fib.id).levels.length,
      lines: store.get(note.id).text.split('\n').length,
    };
    return observed;
  });
  assert.deepEqual(limits, { levels: 32, lines: 20 });
  await sampleCheckpoint('maximum-limits-32-levels-20-lines');
  await page.evaluate(async () => {
    const store = window.terminalHarness.terminal.getDrawings();
    store.update('b4-fibonacci-retracement-0', {
      levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => ({ ratio })),
    });
    store.update('b4-text-note-0', { text: 'Note 0\nSource' });
    await window.terminalHarness.terminal.chart.whenIdle();
  });
  report.maximumLimits = { ...limits, checkpointId: 'maximum-limits-32-levels-20-lines' };
  event('maximum-complete', {
    rows: 100000,
    samples: Object.fromEntries(
      Object.entries(report.samples).map(([name, values]) => [name, values.length]),
    ),
  });
}
async function runSoak() {
  const mounted = await page.evaluate(() => window.terminalHarness.drawingTools.mount(100000));
  if (!report.scene)
    report.scene = {
      rows: mounted.rows,
      drawings: mounted.drawingCount,
      visibleBars: 1000,
      series: mounted.series,
      panes: mounted.panes,
      drawingMix: DRAWING_MIX,
      studies: mounted.studies,
      source: 'deterministic generated OHLCV outside timing',
    };
  const baselineState = await page.evaluate(() =>
    window.terminalHarness.drawingTools.normalizeResourceState(),
  );
  await releaseFixtureCallbackForResourceSample('baseline');
  const baseline = await resourceSample('baseline-equivalent-200');
  report.resources.baseline = baseline;
  const baselineDrawings = await page.evaluate(
    () => window.terminalHarness.terminal.getDrawings().list().length,
  );
  await sampleCheckpoint('mixed-initial');
  const sessionStart = Date.now();
  let due = sessionStart,
    delivery = 0,
    checkpoints = 1,
    restoreSequence = 0;
  const recordPause = (kind, started, detail = {}) => {
    const ended = Date.now();
    due = ended + 250;
    report.cadence.mixed.pauses.push({
      kind,
      started,
      ended,
      afterDelivery: delivery,
      resetTargetAt: due,
      ...detail,
    });
  };
  while (
    Date.now() - sessionStart < 120000 ||
    delivery < 300 ||
    checkpoints < 12 ||
    report.lifecycle.addRemoveCycles < 25 ||
    report.lifecycle.remounts < 6
  ) {
    active();
    await sleep(Math.max(0, due - Date.now()));
    const dispatchedAt = Date.now();
    const sample = await collectTiming(
      'mixed-tail',
      report.raw.tail,
      () => page.evaluate((index) => window.terminalHarness.drawingTools.deliver('replace', index), delivery),
      { deliveryPhase: 'mixed', targetAt: due, dispatchedAt, sequence: delivery },
    );
    assert.ok(Number.isFinite(sample.browserDeliveredAt), 'Browser mixed delivery timestamp missing');
    report.cadence.mixed.targetAt.push(due);
    report.cadence.mixed.dispatchedAt.push(dispatchedAt);
    report.cadence.mixed.actualAt.push(sample.browserDeliveredAt);
    delivery++;
    due += 250;
    if (delivery % 16 === 0 && report.lifecycle.addRemoveCycles < 25) {
      const started = Date.now();
      const id = await page.evaluate(
        (index) => window.terminalHarness.drawingTools.addRemoveCycle(index),
        report.lifecycle.addRemoveCycles,
      );
      report.lifecycle.addRemoveCycles++;
      recordPause('add-remove', started, { id });
    }
    if (delivery % 34 === 0) {
      const started = Date.now();
      const restoreSuffix = restoreSequence === 0 ? '' : '-' + restoreSequence;
      if ((delivery / 34 - 1) % 10 === 6)
        await sampleCheckpoint('mixed-before-workspace-restore' + restoreSuffix);
      const action = await page.evaluate(
        (index) => window.terminalHarness.drawingTools.semantic(index),
        delivery / 34 - 1,
      );
      assert.equal(action.verified, true, 'Semantic action did not verify its effect');
      if (action.action === 'save-restore') {
        await sampleCheckpoint('mixed-after-workspace-restore' + restoreSuffix);
        restoreSequence++;
      }
      report.lifecycle.actions.push({ ...action, at: started });
      recordPause(action.action, started);
    }
    if (delivery % 45 === 0 && report.lifecycle.remounts < 6) {
      const started = Date.now();
      await page.evaluate(() => window.terminalHarness.drawingTools.mount(100000));
      report.lifecycle.remounts++;
      recordPause('remount', started);
    }
    if (delivery % 40 === 0 && checkpoints < 12) {
      const started = Date.now();
      await sampleCheckpoint('mixed-' + checkpoints);
      checkpoints++;
      recordPause('checkpoint', started);
      event('mixed-checkpoint', { checkpoints, delivery });
    }
  }
  await sampleCheckpoint('mixed-final');
  report.cadence.mixed.elapsedMs = Date.now() - sessionStart;
  report.cadence.mixed.deliveries = delivery;
  report.cadence.mixed.achievedHz =
    ((delivery - 1) * 1000) / (report.cadence.mixed.actualAt.at(-1) - report.cadence.mixed.actualAt[0]);
  const finalState = await page.evaluate(() => window.terminalHarness.drawingTools.normalizeResourceState());
  assert.deepEqual(finalState, baselineState, 'Resource endpoint workspace differs from baseline');
  await releaseFixtureCallbackForResourceSample('final');
  report.resources.final = await resourceSample('final-equivalent-200');
  const finalDrawings = await page.evaluate(
    () => window.terminalHarness.terminal.getDrawings().list().length,
  );
  const initial = report.resources.baseline,
    final = report.resources.final;
  const outside = Math.max(
    initial.owned.consumer.connectedOutside,
    final.owned.consumer.connectedOutside,
    initial.owned.terminal.connectedOutside,
    final.owned.terminal.connectedOutside,
  );
  const detached = Math.max(
    initial.owned.consumer.detached,
    final.owned.consumer.detached,
    initial.owned.terminal.detached,
    final.owned.terminal.detached,
  );
  const disposed = final.owned.terminal.generations
    .filter((generation) => !generation.rootConnected)
    .reduce((sum, generation) => sum + generation.total, 0);
  report.resources = {
    ...report.resources,
    protocol: 'authored-structural-weakref-v1',
    gcTurns: 3,
    baselineState,
    finalState,
    baselineDrawings,
    finalDrawings,
    growth: final.owned.consumer.total - initial.owned.consumer.total,
    terminalGrowth: final.owned.terminal.total - initial.owned.terminal.total,
    listenerGrowth: final.counters.jsEventListeners - initial.counters.jsEventListeners,
    retainedHeapDelta: final.heap.usedSize - initial.heap.usedSize,
    outside,
    detached,
    disposed,
    baseline: initial,
    final,
  };
  event('mixed-complete', {
    elapsedMs: report.cadence.mixed.elapsedMs,
    deliveries: delivery,
    checkpoints: report.checkpoints.filter((item) => item.id.startsWith('mixed')).length,
  });
}
async function verifyObsoleteAndDestroy() {
  const destroyed = await page.evaluate(() => window.terminalHarness.drawingTools.destroy());
  report.cleanup = {
    canvases: destroyed.canvases,
    subscriptions: destroyed.subscriptions,
    requests: destroyed.activeRequests,
    browserClosed: false,
    serverClosed: false,
  };
  const first = await page.evaluate(() => window.terminalHarness.drawingTools.obsoleteDelivery());
  assert.ok(first, 'Obsolete provider callback required');
  assert.deepEqual(first.after, first.before, 'Obsolete callback mutated host immediately');
  await sleep(800);
  const later = await page.evaluate(() => ({
    html: window.terminalHarness.drawingTools.host.innerHTML,
    counts: window.terminalHarness.drawingTools.counts(),
  }));
  assert.deepEqual(later, first.before, 'Obsolete callback mutated host after retry window');
  const second = await page.evaluate(() => window.terminalHarness.drawingTools.obsoleteDelivery());
  assert.equal(second, null);
  report.resources.obsoleteImmediateMutations = 0;
  report.resources.obsoleteDelayedMutations = 0;
  report.resources.secondDelivery = second;
  const afterTeardown = await resourceSample('after-obsolete-and-destroy');
  report.resources.afterTeardown = afterTeardown;
  report.resources.outside = Math.max(
    report.resources.outside ?? 0,
    afterTeardown.owned.consumer.connectedOutside,
    afterTeardown.owned.terminal.connectedOutside,
  );
  report.resources.detached = Math.max(
    report.resources.detached ?? 0,
    afterTeardown.owned.consumer.detached,
    afterTeardown.owned.terminal.detached,
  );
  report.resources.disposed = Math.max(
    report.resources.disposed ?? 0,
    ...afterTeardown.owned.terminal.generations
      .filter((generation) => !generation.rootConnected)
      .map((generation) => generation.total),
  );
  report.cleanup.canvases = later.counts.canvases;
  report.cleanup.subscriptions = later.counts.subscriptions;
  report.cleanup.requests = later.counts.activeRequests;
  assert.deepEqual(
    [report.cleanup.canvases, report.cleanup.subscriptions, report.cleanup.requests],
    [0, 0, 0],
  );
}
async function closeOwned() {
  try {
    await context?.close();
  } catch (error) {
    report.errors.push({ kind: 'context-close', message: String(error) });
  }
  try {
    await browser?.close();
  } catch (error) {
    report.errors.push({ kind: 'browser-close', message: String(error) });
  }
  try {
    await browserServer?.close();
    const owned = browserServer?.process();
    report.cleanup.browserClosed = Boolean(owned && (owned.exitCode !== null || owned.signalCode !== null));
  } catch (error) {
    report.errors.push({ kind: 'browser-server-close', message: String(error) });
  }
  if (server && server.exitCode === null && server.signalCode === null) {
    try {
      const exit = new Promise((resolveExit) => server.once('exit', resolveExit));
      server.kill();
      await Promise.race([
        exit,
        sleep(5000).then(() => {
          throw Error('Preview stop deadline');
        }),
      ]);
      report.cleanup.serverClosed = server.exitCode !== null || server.signalCode !== null;
    } catch (error) {
      report.errors.push({ kind: 'preview-close', message: String(error) });
    }
  } else report.cleanup.serverClosed = !server || server.exitCode !== null || server.signalCode !== null;
}
try {
  const installed = verifyConsumerIdentity(root, 'v0.9', report.sourceCommit);
  report.installation = { ...installed, identities: installed.identities };
  event('installed-identity-verified', { archives: installed.archives, members: installed.members });
  await startPreview();
  await startBrowser();
  if (mode !== 'soak') await runMaximum();
  if (mode !== 'max') await runSoak();
  await verifyObsoleteAndDestroy();
} catch (error) {
  report.errors.push({ kind: 'run', message: error?.stack || String(error) });
  process.exitCode = 1;
} finally {
  await closeOwned();
  if (mode === 'all' && report.errors.length === 0) {
    try {
      report.summary = validateDrawingEvidence(report);
      report.checks.all = true;
    } catch (error) {
      report.errors.push({ kind: 'oracle', message: error?.stack || String(error) });
      process.exitCode = 1;
    }
  }
  report.status = report.errors.length ? 'failed' : mode === 'all' ? 'pass' : 'partial';
  report.completedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify(
      {
        record: output,
        status: report.status,
        checks: report.checks,
        errors: report.errors.map((error) => error.message),
      },
      null,
      2,
    ),
  );
}
