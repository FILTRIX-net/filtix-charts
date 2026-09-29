import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, verifyConsumerIdentity } from './consumer-identity.mjs';
import { loadBrowserCohort, browserLaunchOptions } from './multi-output-coverage.mjs';
import { installOwnedDomTracker } from './studies-resources.mjs';
import {
  ALERTS_BUDGETS,
  ALERTS_DECLARED,
  buildAlertsFixture,
  buildMaxDelivery,
  buildSoakDelivery,
  nearestRank,
  referenceEvents,
  validateAlertsEvidence,
} from './alerts-oracle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'all';
assert.ok(['all', 'max', 'soak'].includes(mode), 'Use --mode=all|max|soak');
const port = 5204;
const origin = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const resultDirectory = resolve(root, 'benchmark-results/v0.10');
const output = resolve(resultDirectory, `alerts-${mode}-${stamp}.json`);
const artifactDirectory = resolve(resultDirectory, `alerts-${mode}-${stamp}`);
const journal = resolve(artifactDirectory, 'attempts.jsonl');
mkdirSync(artifactDirectory, { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const relativePath = (path) => relative(root, path).replaceAll('\\', '/');
const candidatePackages = [
  'analysis',
  'alerts',
  'charts',
  'core',
  'datafeed',
  'drawings',
  'indicators',
  'react',
  'terminal',
];
let preview, browserServer, browser, context, page, cdp;
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
});
process.once('SIGTERM', () => {
  interrupted = true;
});
function active() {
  if (interrupted) throw Error('Alert workload interrupted');
}

const report = {
  schema: 'filtix-alerts-installed-evidence',
  version: 1,
  mode,
  status: 'running',
  startedAt: new Date().toISOString(),
  source: sourceIdentity(root),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
  attemptJournal: relativePath(journal),
  candidateArchives: candidatePackages.map((name) => {
    const path = resolve(root, `dist/packages/filtix-${name}-0.10.0.tgz`);
    return {
      name: `@filtix/${name}`,
      path: relativePath(path),
      sha256: existsSync(path) ? digest(readFileSync(path)) : null,
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
    browserCohort: null,
    headless: true,
  },
  declared: { ...ALERTS_DECLARED, budgets: ALERTS_BUDGETS },
  fixture: null,
  installation: null,
  servedAssets: [],
  warmup: null,
  maxPhases: [],
  soak: null,
  timings: null,
  resources: null,
  cleanup: {
    ownedSessions: null,
    subscriptions: null,
    timers: null,
    listeners: null,
    browserClosed: false,
    serverClosed: false,
  },
  errors: [],
  checks: {},
};
function save() {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
function attempt(kind, value) {
  appendFileSync(journal, JSON.stringify({ kind, at: new Date().toISOString(), ...value }) + '\n');
}
function fail(kind, error) {
  report.errors.push({ kind, message: error?.stack || String(error) });
  attempt('failure', { phase: kind, message: error?.stack || String(error) });
}

// Installed before the app's module import. Native clocks remain available for benchmark-only turns.
function installAppTimerTracker() {
  const host = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  const timeouts = new Set();
  const intervals = new Set();
  window.__filtixAlertsNativeClocks = host;
  window.setTimeout = function (callback, delay, ...args) {
    let handle;
    handle = host.setTimeout(
      function (...values) {
        timeouts.delete(handle);
        if (typeof callback === 'function') callback.apply(this, values);
        else window.eval(String(callback));
      },
      delay,
      ...args,
    );
    timeouts.add(handle);
    return handle;
  };
  window.setInterval = function (callback, delay, ...args) {
    const handle = host.setInterval(
      function (...values) {
        if (typeof callback === 'function') callback.apply(this, values);
        else window.eval(String(callback));
      },
      delay,
      ...args,
    );
    intervals.add(handle);
    return handle;
  };
  window.clearTimeout = function (handle) {
    timeouts.delete(handle);
    intervals.delete(handle);
    return host.clearTimeout(handle);
  };
  window.clearInterval = function (handle) {
    timeouts.delete(handle);
    intervals.delete(handle);
    return host.clearInterval(handle);
  };
  window.__filtixAlertsTimerTracker = Object.freeze({
    sample() {
      return {
        timeouts: timeouts.size,
        intervals: intervals.size,
        outstanding: timeouts.size + intervals.size,
      };
    },
  });
}

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
  preview = spawn(
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
  report.ownedPreviewPid = preview.pid;
  let log = '';
  let startupError;
  preview.on('error', (error) => {
    startupError = error;
  });
  preview.stdout.on('data', (bytes) => {
    log += String(bytes);
  });
  preview.stderr.on('data', (bytes) => {
    log += String(bytes);
  });
  for (let attemptIndex = 0; attemptIndex < 150; attemptIndex++) {
    active();
    if (startupError) throw startupError;
    if (preview.exitCode !== null) throw Error(`Owned preview exited: ${log}`);
    try {
      if ((await fetch(origin + '/?test&alerts', { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* Startup probe. */
    }
    await sleep(100);
  }
  throw Error(`Owned preview did not start: ${log}`);
}
async function startBrowser() {
  const { chromium, details } = await loadBrowserCohort(root);
  report.environment.browserCohort = details;
  browserServer = await chromium.launchServer(browserLaunchOptions('chromium'));
  report.ownedBrowserPid = browserServer.process().pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1 });
  await context.addInitScript(installAppTimerTracker);
  await context.addInitScript(installOwnedDomTracker, {
    consumerRootSelector: '#alerts-workload-host',
    terminalRootSelector: '[data-filtix-terminal-instance]',
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) => fail('pageerror', error));
  page.on('console', (message) => {
    if (message.type() === 'error') fail('console', message.text());
  });
  const assetChecks = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script' || new URL(response.url()).origin !== origin) return;
    assetChecks.push(
      (async () => {
        const path = decodeURIComponent(new URL(response.url()).pathname);
        const local = resolve(root, 'examples/react-terminal/dist', '.' + path);
        const sha256 = digest(Buffer.from(await response.body()));
        assert.equal(sha256, digest(readFileSync(local)), `Served installed asset differs: ${path}`);
        return { path, sha256 };
      })(),
    );
  });
  await page.goto(origin + '/?test&alerts', { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.terminalHarness?.alerts));
  report.servedAssets = await Promise.all(assetChecks);
  assert.ok(report.servedAssets.length > 0, 'Executed installed consumer asset required');
}

function normalizeInstallation(installed) {
  return {
    version: '0.10.0',
    archives: installed.archives
      .map((archive) => ({
        name: archive.name,
        path: archive.path,
        sha256: archive.sha256,
        members: [...archive.members].sort((left, right) => left.path.localeCompare(right.path)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    memberCount: installed.archives.reduce((sum, archive) => sum + archive.members.length, 0),
    identities: installed.identities,
  };
}

function cadence(deliveries, targetIntervalMs) {
  const first = deliveries[0]?.actualAt;
  const last = deliveries.at(-1)?.actualAt;
  const windowMs = last - first;
  return {
    targetHz: 1000 / targetIntervalMs,
    observedHz: windowMs > 0 ? ((deliveries.length - 1) * 1000) / windowMs : null,
    windowMs,
    lateBatches: deliveries.filter((item) => item.actualAt - item.intendedAt > targetIntervalMs).length,
    largestDispatchLagMs: Math.max(0, ...deliveries.map((item) => item.actualAt - item.intendedAt)),
  };
}

async function prepareFixture() {
  report.fixture = buildAlertsFixture();
  const started = now();
  const prepared = await page.evaluate(
    (fixture) => window.terminalHarness.alerts.prepare(fixture),
    report.fixture,
  );
  const ready = await page.evaluate(() => window.terminalHarness.alerts.ready());
  report.timings = { activationMs: now() - started, sync: null, settled: null };
  assert.equal(ready.monitor.queries.length, 32);
  assert.ok(ready.monitor.queries.every((query) => query.status === 'monitoring'));
  assert.equal(
    prepared.documents.reduce((sum, document) => sum + document.alerts.length, 0),
    400,
  );
  attempt('activation', {
    activationMs: report.timings.activationMs,
    provider: ready.provider,
    resources: ready.resources,
  });
  save();
}

function plans() {
  const fixture = report.fixture;
  const warmup = Array.from({ length: 32 }, (_, batch) => buildMaxDelivery(fixture, -1, batch));
  const max = Array.from({ length: 3 }, (_, phase) => ({
    phase,
    deliveries: Array.from({ length: 3125 }, (_, batch) => buildMaxDelivery(fixture, phase, batch)),
  }));
  const expected = referenceEvents(fixture, max);
  const soak = Array.from({ length: 3000 }, (_, batch) => buildSoakDelivery(fixture, batch));
  return { warmup, max, expected, soak };
}

async function dispatch(plan, intendedAt) {
  active();
  const until = intendedAt - now();
  if (until > 0) await sleep(until);
  const actualAt = now();
  const result = await page.evaluate(
    (delivery) => window.terminalHarness.alerts.deliverBatch(delivery),
    plan,
  );
  return {
    ...plan,
    intendedAt,
    actualAt,
    browserAt: result.browserAt,
    syncMs: result.syncMs,
    settledMs: result.settledMs,
    preparedBars: result.preparedBars,
    evidenceMaterializedAfterTiming: result.evidenceMaterializedAfterTiming,
    events: result.events,
    terminalEvents: result.terminalEvents,
  };
}

async function runWarmup(warmup) {
  const started = now();
  const deliveries = [];
  report.warmup = { status: 'collecting', deliveries };
  attempt('warmup-start', { batches: 32 });
  for (const [batch, plan] of warmup.entries()) {
    const result = await dispatch(plan, started + batch * 10);
    assert.equal(result.events.length, 0, 'Warmup must not cross any threshold');
    const { events, terminalEvents, ...raw } = result;
    deliveries.push(raw);
    attempt('warmup-delivery', { batch, delivery: raw, events, terminalEvents });
  }
  report.warmup.status = 'accepted';
  save();
}

async function runMaximum(max, expected) {
  for (const plannedPhase of max) {
    const phaseIndex = plannedPhase.phase;
    const phase = {
      phase: phaseIndex,
      status: 'collecting',
      targetIntervalMs: 10,
      deliveries: [],
      expectedEvents: expected.filter((event) => event.phase === phaseIndex),
      observedEvents: [],
      terminalObservedEvents: [],
      subscriptions: null,
      documents: null,
    };
    report.maxPhases.push(phase);
    attempt('max-start', { phase: phaseIndex, batches: 3125 });
    const started = now();
    for (const [batch, plan] of plannedPhase.deliveries.entries()) {
      const result = await dispatch(plan, started + batch * 10);
      const { events, terminalEvents, ...raw } = result;
      phase.deliveries.push(raw);
      phase.observedEvents.push(...events);
      phase.terminalObservedEvents.push(...terminalEvents);
      attempt('max-delivery', { phase: phaseIndex, batch, delivery: raw, events, terminalEvents });
    }
    const snapshot = await page.evaluate(() => window.terminalHarness.alerts.snapshot());
    phase.documents = snapshot.documents;
    phase.subscriptions = report.fixture.queries.map((query) => {
      const observed = snapshot.provider.byQuery.find(
        (item) => item.query[0] === query.symbol && item.query[1] === query.interval,
      );
      return { query, active: observed?.active ?? 0, delivered: observed?.delivered ?? 0 };
    });
    phase.cadence = cadence(phase.deliveries, 10);
    phase.status = 'accepted';
    attempt('max-complete', {
      phase: phaseIndex,
      events: phase.observedEvents.length,
      subscriptions: phase.subscriptions,
      documents: phase.documents,
    });
    save();
  }
  const deliveries = report.maxPhases.flatMap((phase) => phase.deliveries);
  const syncSamples = deliveries.map((item) => item.syncMs);
  const settledSamples = deliveries.map((item) => item.settledMs);
  const terminalCallbackSamples = report.maxPhases.flatMap((phase) =>
    phase.terminalObservedEvents.map((event) => event.callbackLatencyMs),
  );
  report.timings.sync = {
    samples: syncSamples,
    p95: nearestRank(syncSamples, 0.95),
    p99: nearestRank(syncSamples, 0.99),
  };
  report.timings.settled = {
    samples: settledSamples,
    p95: nearestRank(settledSamples, 0.95),
    p99: nearestRank(settledSamples, 0.99),
  };
  report.timings.terminalCallbacks = {
    samples: terminalCallbackSamples,
    p95: nearestRank(terminalCallbackSamples, 0.95),
    p99: nearestRank(terminalCallbackSamples, 0.99),
  };
  save();
}

async function resourceSample(label) {
  active();
  await page.evaluate(async () => {
    await window.terminalHarness.terminal?.chart?.whenIdle?.();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  const prepared = await page.evaluate(() => window.__filtixOwnedDomTracker.prepare());
  const gcRounds = [];
  for (let turn = 1; turn <= 3; turn++) {
    await page.evaluate(
      (expected) =>
        new Promise((resolveTurn) => {
          window.__filtixAlertsNativeClocks.setTimeout(() => {
            window.__filtixAlertsGcTurn = expected;
            resolveTurn();
          }, 0);
        }),
      turn,
    );
    await cdp.send('HeapProfiler.collectGarbage');
    gcRounds.push({ turn, observed: await page.evaluate(() => window.__filtixAlertsGcTurn) });
  }
  const counters = await cdp.send('Memory.getDOMCounters');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const owned = await page.evaluate(() => window.__filtixOwnedDomTracker.sample());
  const fixture = await page.evaluate(() => window.terminalHarness.alerts.snapshot());
  return {
    label,
    gcRounds,
    prepared,
    counters,
    heap: { usedSize: heap.usedSize, totalSize: heap.totalSize },
    owned,
    ...fixture.resources,
    provider: fixture.provider,
    documents: fixture.documents,
  };
}

async function runSoak(soakPlans) {
  const baseline = await page.evaluate(() => window.terminalHarness.alerts.snapshot());
  const initialObsolete = await page.evaluate(() => window.terminalHarness.alerts.probeObsolete());
  report.resources ??= {};
  report.resources.initialObsolete = initialObsolete;
  attempt('obsolete-callback-released-before-initial-gc', { obsolete: initialObsolete });
  assert.deepEqual(
    initialObsolete,
    initialObsolete.available === false
      ? { available: false }
      : {
          available: true,
          newEvents: 0,
          documentsUnchanged: true,
          monitorUnchanged: true,
          subscriptionsUnchanged: true,
        },
    'Initial retired provider callback caused a stale effect',
  );
  const initial = await resourceSample('initial-equivalent');
  report.resources = {
    ...report.resources,
    initial,
    final: null,
    afterDestroy: null,
    postDestroy: null,
    gcTurns: 3,
    gcRounds: [],
  };
  const soak = {
    status: 'collecting',
    targetIntervalMs: 40,
    elapsedMs: null,
    ruleCycles: 0,
    mounts: 0,
    deliveries: [],
    cycleAttempts: [],
    mountAttempts: [],
    initialDocuments: baseline.documents,
    finalDocuments: null,
    events: [],
  };
  report.soak = soak;
  save();
  const start = now();
  let nextCycle = 0;
  let nextMount = 0;
  for (const [batch, plan] of soakPlans.entries()) {
    const result = await dispatch(plan, start + batch * 40);
    const { events, terminalEvents, ...raw } = result;
    soak.deliveries.push(raw);
    soak.events.push(...events);
    attempt('soak-delivery', { batch, delivery: raw, events, terminalEvents });
    if (nextCycle < 25 && batch >= Math.floor(((nextCycle + 1) * soakPlans.length) / 26)) {
      const actualAt = now();
      const observation = await page.evaluate(
        (index) => window.terminalHarness.alerts.ruleCycle(index),
        nextCycle,
      );
      assert.deepEqual(
        observation.document,
        baseline.documents[3],
        'Rule cycle did not restore its original store document',
      );
      soak.cycleAttempts.push({ index: nextCycle, actualAt, observation });
      attempt('rule-cycle', { index: nextCycle, actualAt, observation });
      nextCycle++;
    }
    if (nextMount < 6 && batch >= Math.floor(((nextMount + 1) * soakPlans.length) / 7)) {
      const actualAt = now();
      const observation = await page.evaluate(
        (index) => window.terminalHarness.alerts.mountCycle(index),
        nextMount,
      );
      soak.mountAttempts.push({ index: nextMount, actualAt, observation });
      attempt('mount-cycle', { index: nextMount, actualAt, observation });
      nextMount++;
    }
  }
  const remaining = start + 120_000 - now();
  if (remaining > 0) await sleep(remaining);
  soak.elapsedMs = now() - start;
  soak.cadence = cadence(soak.deliveries, 40);
  soak.ruleCycles = nextCycle;
  soak.mounts = nextMount;
  const endpoint = await page.evaluate(() => window.terminalHarness.alerts.snapshot());
  soak.finalDocuments = endpoint.documents;
  assert.deepEqual(soak.finalDocuments, soak.initialDocuments, 'Soak endpoint rule documents differ');
  const obsolete = await page.evaluate(() => window.terminalHarness.alerts.probeObsolete());
  assert.deepEqual(
    obsolete,
    {
      available: true,
      newEvents: 0,
      documentsUnchanged: true,
      monitorUnchanged: true,
      subscriptionsUnchanged: true,
    },
    'Retired provider callback caused a stale effect',
  );
  report.cleanup.obsolete = obsolete;
  attempt('obsolete-callback-released-before-final-gc', { obsolete });
  const final = await resourceSample('final-equivalent');
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
    final,
    gcRounds: final.gcRounds,
    growth: final.owned.consumer.total - initial.owned.consumer.total,
    terminalGrowth: final.owned.terminal.total - initial.owned.terminal.total,
    listenerGrowth: final.counters.jsEventListeners - initial.counters.jsEventListeners,
    retainedHeapDelta: final.heap.usedSize - initial.heap.usedSize,
    outside,
    detached,
    disposed,
  };
  soak.status = 'accepted';
  attempt('soak-complete', {
    elapsedMs: soak.elapsedMs,
    ruleCycles: nextCycle,
    mounts: nextMount,
    resources: report.resources,
  });
  save();
}

async function destroyFixture() {
  if (!page) return;
  if (!report.cleanup.obsolete)
    report.cleanup.obsolete = await page.evaluate(() => window.terminalHarness.alerts.probeObsolete());
  const destroyed = await page.evaluate(() => window.terminalHarness.alerts.cleanup());
  report.resources ??= {};
  report.resources.afterDestroy = destroyed.resources;
  const postDestroy = await resourceSample('post-destroy');
  report.resources.postDestroy = postDestroy;
  report.cleanup.provider = destroyed.provider;
  const monitor = destroyed.resources?.monitors[0]?.snapshot;
  report.cleanup.ownedSessions = monitor?.runtimeEntries ?? null;
  report.cleanup.subscriptions = postDestroy.providerSubscriptions;
  report.cleanup.timers = postDestroy.appTimers;
  const baselineListeners = report.resources.staticBaseline?.counters.jsEventListeners;
  report.cleanup.listeners = destroyed.resources
    ? destroyed.resources.stores.reduce(
        (sum, item) =>
          sum +
          item.snapshot.changeListeners +
          item.snapshot.eventListeners +
          item.snapshot.admissionListeners +
          item.snapshot.lifecycleListeners,
        0,
      ) +
      (monitor?.observerListeners ?? 0) +
      Math.max(0, postDestroy.counters.jsEventListeners - baselineListeners)
    : null;
  attempt('cleanup', { obsolete: report.cleanup.obsolete, destroyed, postDestroy, cleanup: report.cleanup });
  save();
}

async function closeOwned() {
  try {
    await context?.close();
  } catch (error) {
    fail('context-close', error);
  }
  try {
    await browser?.close();
  } catch (error) {
    fail('browser-close', error);
  }
  try {
    await browserServer?.close();
    const process = browserServer?.process();
    report.cleanup.browserClosed = Boolean(
      process && (process.exitCode !== null || process.signalCode !== null),
    );
  } catch (error) {
    fail('browser-server-close', error);
  }
  if (preview && preview.exitCode === null && preview.signalCode === null) {
    try {
      const exit = new Promise((resolveExit) => preview.once('exit', resolveExit));
      preview.kill();
      await Promise.race([
        exit,
        sleep(5000).then(() => {
          throw Error('Preview stop deadline');
        }),
      ]);
      report.cleanup.serverClosed = preview.exitCode !== null || preview.signalCode !== null;
    } catch (error) {
      fail('preview-close', error);
    }
  } else report.cleanup.serverClosed = !preview || preview.exitCode !== null || preview.signalCode !== null;
}

try {
  verifyConsumerIdentity(root, 'v0.10', report.sourceCommit);
  report.installation = normalizeInstallation(
    JSON.parse(readFileSync(resolve(root, 'benchmark-results/v0.10/consumer-install.json'), 'utf8')),
  );
  attempt('installed-identity', {
    archives: report.installation.archives.map((archive) => ({
      name: archive.name,
      sha256: archive.sha256,
      members: archive.members.length,
    })),
  });
  await startPreview();
  await startBrowser();
  report.resources = { staticBaseline: await resourceSample('static-baseline') };
  attempt('static-baseline', { resources: report.resources.staticBaseline });
  await prepareFixture();
  const planned = plans(); // Full raw source and oracle are generated before any timed delivery window.
  await runWarmup(planned.warmup);
  if (mode !== 'soak') await runMaximum(planned.max, planned.expected);
  if (mode !== 'max') await runSoak(planned.soak);
  await destroyFixture();
} catch (error) {
  fail('run', error);
  process.exitCode = 1;
  try {
    await destroyFixture();
  } catch (cleanupError) {
    fail('fixture-close', cleanupError);
  }
} finally {
  await closeOwned();
  if (mode === 'all' && report.errors.length === 0) {
    try {
      verifyConsumerIdentity(root, 'v0.10', report.sourceCommit);
      report.status = 'pass';
      report.summary = validateAlertsEvidence(report);
      report.checks.all = true;
    } catch (error) {
      fail('oracle', error);
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
        errors: report.errors.map((item) => item.message),
      },
      null,
      2,
    ),
  );
}
