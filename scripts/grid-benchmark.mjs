import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, verifyConsumerIdentity } from './consumer-identity.mjs';
import { loadBrowserCohort, browserLaunchOptions } from './multi-output-coverage.mjs';
import { installOwnedDomTracker } from './studies-resources.mjs';
import { buildGridScene, expectedCheckpoint } from './grid-oracle.mjs';
import { validateGridEvidence } from './grid-evidence.mjs';
import { collectEndpointReadiness } from './grid-resource-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'all';
assert.ok(['all', 'max', 'soak', 'full', 'capacity'].includes(mode), 'Use --mode=all|max|soak|full|capacity');
const port = 5205;
const origin = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const outputDir = resolve(root, 'benchmark-results/v0.11');
const artifactDir = resolve(outputDir, `grid-${mode}-${stamp}`);
mkdirSync(artifactDir, { recursive: true });
const output = resolve(outputDir, `grid-${mode}-${stamp}.json`);
const journal = resolve(artifactDir, 'attempts.jsonl');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const pathFromRoot = (path) => relative(root, path).replaceAll('\\', '/');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const nodeEpoch = () => performance.timeOrigin + performance.now();
const tuples = (bars) =>
  bars.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null]);
const barHash = (bars) => digest(Buffer.from(JSON.stringify(tuples(bars))));
const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
let preview, browserServer, browser, context, page, cdp;
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
});
process.once('SIGTERM', () => {
  interrupted = true;
});
function active() {
  if (interrupted) throw Error('Grid workload interrupted');
}
function save(force = false) {
  if (!force) return; // The append-only action journal persists receipts at 40 ms cadence.
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
function attempt(kind, detail) {
  appendFileSync(journal, JSON.stringify({ kind, at: new Date().toISOString(), ...detail }) + '\n');
}

const source = sourceIdentity(root);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
assert.equal(source.commit, sourceCommit);
assert.deepEqual(source.dirty, [], 'Official grid benchmark requires a clean committed source');
const installPointer = resolve(outputDir, 'consumer-install.json');
const installRecord = JSON.parse(readFileSync(installPointer, 'utf8'));
const installed = verifyConsumerIdentity(root, 'v0.11', sourceCommit);
const expectedIdentity = { source, installRecord, installed };
const installedByPath = new Map(installed.identities.map((item) => [item.path, item.sha256]));
const archives = installRecord.archives.map((archive) => {
  const name = archive.name.split('/')[1];
  return {
    name: archive.name,
    path: pathFromRoot(archive.path),
    sha256: archive.sha256,
    members: archive.members.map((member) => {
      const installedPath = `examples/react-terminal/node_modules/@filtix/${name}/${member.path.slice(8)}`;
      const installedSha256 = installedByPath.get(installedPath);
      assert.ok(installedSha256, `Installed identity missing ${installedPath}`);
      return { path: member.path, archiveSha256: member.sha256, installedSha256 };
    }),
  };
});
const verification = (phase) => ({
  phase,
  at: nodeEpoch(),
  sourceCommit,
  sourceSha256: digest(Buffer.from(JSON.stringify(source))),
  archivesSha256: digest(Buffer.from(JSON.stringify(archives))),
});
const report = {
  schema: 'filtix-grid-installed-evidence',
  version: 1,
  mode,
  status: 'collecting',
  startedAt: new Date().toISOString(),
  identity: {
    sourceCommit,
    sourceSha256: digest(Buffer.from(JSON.stringify(source))),
    sourceFiles: source.files,
    consumerRoot: 'examples/react-terminal',
    installRecordPath: pathFromRoot(installPointer),
    installRecord,
    installRecordSha256: digest(readFileSync(installPointer)),
    verifications: [verification('before')],
    installed: true,
    sourceAliases: false,
    archives,
  },
  environment: {
    node: process.version,
    platform: os.platform(),
    os: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    browser: null,
    browserCohort: null,
    headless: true,
    visibility: [],
  },
  scene: {
    providerId: 'filtix-grid-workload-v1',
    host: { width: 1600, height: 1000 },
    layout: 4,
    monitorQueryCount: 8,
    scopes: {},
  },
  checkpoints: [],
  actions: {
    warmup: [],
    constructions: [],
    restores: [],
    tailReplace: [],
    tailAppendReplace: [],
    interaction: [],
    wheel: [],
    syncExact: [],
    syncNearest: [],
    soak: [],
    lifecycle: [],
  },
  resources: [],
  providerRequests: [],
  capacity: {
    rules: 0,
    armedQueries: 0,
    restoreObservations: [],
    failedAtomicity: [],
    leaseObservations: [],
  },
  coverage: {
    maxCheckpoints: 0,
    maxRenderedObservations: 0,
    fullCheckpoints: 0,
    fullRenderedObservations: 0,
    renderedCoverageLabels: {
      maximum: { scope: 'maximum-sampled', exhaustive: false },
      full: { scope: 'full-256', exhaustive: true },
    },
    sourceHashes: [],
    drawingsVerified: 0,
    alertsVerified: 0,
    constructionSamples: 0,
    restoreSamples: 0,
    tailSamples: 0,
    interactionSamples: 0,
    wheelSamples: 0,
    syncSamples: 0,
    soakElapsedMs: 0,
    soakCadence: [],
    lifecycleCounts: { parkCycles: 0, activeChanges: 0, restores: 0, destroyRecreates: 0 },
  },
  cleanup: {
    finalResourceLabel: null,
    ownedZeroCounts: null,
    borrowedUsabilityObservations: [],
    ownershipControlObservations: [],
    portClosed: false,
    browserClosed: false,
  },
  failures: [],
};
save(true);

function installGridResourceTracker() {
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
  };
  const timeouts = new Set();
  const intervals = new Set();
  const observers = new Set();
  window.setTimeout = function (callback, delay, ...args) {
    let handle;
    handle = native.setTimeout(
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
    const handle = native.setInterval(
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
    native.clearTimeout(handle);
  };
  window.clearInterval = function (handle) {
    timeouts.delete(handle);
    intervals.delete(handle);
    native.clearInterval(handle);
  };
  for (const name of ['ResizeObserver', 'MutationObserver']) {
    const Original = native[name];
    if (!Original) continue;
    window[name] = class extends Original {
      constructor(...args) {
        super(...args);
        this.__gridObservedTargets = new Set();
      }
      observe(target, ...args) {
        this.__gridObservedTargets.add(target);
        observers.add(this);
        return super.observe(target, ...args);
      }
      unobserve(target) {
        this.__gridObservedTargets.delete(target);
        if (this.__gridObservedTargets.size === 0) observers.delete(this);
        return super.unobserve(target);
      }
      disconnect() {
        this.__gridObservedTargets.clear();
        observers.delete(this);
        return super.disconnect();
      }
    };
  }
  window.__gridResourceTracker = Object.freeze({
    sample() {
      return {
        timeouts: timeouts.size,
        intervals: intervals.size,
        timers: timeouts.size + intervals.size,
        observers: observers.size,
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
    {
      cwd: resolve(root, 'examples/react-terminal'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  let launchError;
  preview.on('error', (error) => {
    launchError = error;
  });
  preview.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  preview.stderr.on('data', (chunk) => {
    log += String(chunk);
  });
  report.ownedPreviewPid = preview.pid;
  for (let i = 0; i < 150; i++) {
    active();
    if (launchError) throw launchError;
    if (preview.exitCode !== null) throw Error('Grid preview exited: ' + log);
    try {
      if (
        (
          await fetch(origin + '/?source=fixture&view=grid&test&grid-test&grid-benchmark', {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      )
        return;
    } catch {
      /* Startup probe. */
    }
    await sleep(100);
  }
  throw Error('Owned grid preview did not start: ' + log);
}

async function startBrowser() {
  const { chromium, details } = await loadBrowserCohort(root);
  report.environment.browserCohort = details;
  browserServer = await chromium.launchServer(browserLaunchOptions('chromium'));
  report.ownedBrowserPid = browserServer.process().pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1 });
  await context.addInitScript(installGridResourceTracker);
  await context.addInitScript(() => {
    const transitions = [];
    const observe = () =>
      transitions.push({ state: document.visibilityState, at: performance.timeOrigin + performance.now() });
    document.addEventListener('visibilitychange', observe);
    observe();
    window.__gridVisibilityTransitions = transitions;
  });
  await context.addInitScript(installOwnedDomTracker, {
    consumerRootSelector: '#grid-benchmark-host',
    terminalRootSelector: '[data-filtix-terminal-instance]',
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on('pageerror', (error) => {
    report.failures.push({ kind: 'pageerror', message: error.stack || error.message });
    save();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      report.failures.push({ kind: 'console', message: message.text() });
      save();
    }
  });
  await page.goto(origin + '/?source=fixture&view=grid&test&grid-test&grid-benchmark', { waitUntil: 'load' });
  await page.waitForFunction(() => window.gridBenchmark?.ready === true);
  await page.waitForFunction(() => window.gridHarness?.counts()?.mounted === true);
  assert.equal(
    await page.evaluate(() => document.visibilityState),
    'visible',
    'Hidden-tab measurement rejected',
  );
  report.environment.visibility.push(...(await page.evaluate(() => window.__gridVisibilityTransitions)));
  await warmAutomation();
}

async function warmAutomation() {
  // First selector use installs Playwright's real utility-world listeners.
  // Include their native count in every subsequent empty/mounted baseline.
  const startedAt = nodeEpoch();
  const boundingBox = await page.locator('body').boundingBox();
  report.environment.automationPreparation = {
    kind: 'selector-geometry',
    selector: 'body',
    startedAt,
    completedAt: nodeEpoch(),
    boundingBox,
  };
}

async function fixture(method, arg) {
  active();
  const { result, visibility } = await page.evaluate(
    async ({ method, arg }) => ({
      result: await window.gridBenchmark[method](arg),
      visibility: window.__gridVisibilityTransitions,
    }),
    { method, arg },
  );
  report.environment.visibility = visibility;
  assert.ok(
    visibility.every((entry) => entry.state === 'visible'),
    'Hidden-tab measurement rejected',
  );
  return result;
}

async function action(category, spec) {
  active();
  const requested = structuredClone(spec);
  const pending = { id: spec.id, category, phase: spec.phase, status: 'collecting', requested };
  attempt('action', pending);
  try {
    const receipt = await fixture('act', spec);
    report.actions[category].push(receipt);
    attempt('action', { ...receipt, status: 'collected' });
    save();
    return receipt;
  } catch (error) {
    let witness = null;
    let witnessUnavailable = null;
    try {
      witness = await fixture('failureWitness', spec.id);
      if (witness === null) witnessUnavailable = 'Fixture returned no matching partial witness';
    } catch (witnessError) {
      witnessUnavailable = witnessError.stack || String(witnessError);
    }
    const failure = {
      kind: 'action',
      id: spec.id,
      category,
      requested,
      witness,
      witnessUnavailable,
      message: error.stack || String(error),
    };
    report.failures.push(failure);
    attempt('failure', failure);
    save(true);
    throw error;
  }
}

async function endpoint(label) {
  active();
  await fixture('settle');
  let collected;
  try {
    collected = await collectEndpointReadiness({
      label,
      scene: label.startsWith('full-') ? report.scene.scopes.full : report.scene.scopes.maximum,
      readPoll: (name) => fixture('resourceReadiness', name),
      readFull: (name) => fixture('resources', name),
      now: nodeEpoch,
      pause: sleep,
      onAttempt: (observation) => attempt('resource-readiness', observation),
      collectGc: async () => {
        const preparedAt = nodeEpoch();
        const prepared = await page.evaluate(() => window.__filtixOwnedDomTracker.prepare());
        const gcTurnReceipts = [];
        for (let turn = 0; turn < 3; turn++) {
          const token = await page.evaluate(() => {
            const next = (window.__gridGcTurn ?? 0) + 1;
            setTimeout(() => {
              window.__gridGcTurn = next;
            }, 0);
            return next;
          });
          await page.waitForFunction((expected) => window.__gridGcTurn === expected, token);
          await cdp.send('HeapProfiler.collectGarbage');
          gcTurnReceipts.push({ turn: turn + 1, at: nodeEpoch() });
        }
        const counters = await cdp.send('Memory.getDOMCounters');
        const countersAt = nodeEpoch();
        const heap = await cdp.send('Runtime.getHeapUsage');
        const heapAt = nodeEpoch();
        const domOwned = await page.evaluate(() => window.__filtixOwnedDomTracker.sample());
        const domOwnedAt = nodeEpoch();
        const resourceTracker = await page.evaluate(() => window.__gridResourceTracker.sample());
        const resourceTrackerAt = nodeEpoch();
        return {
          gcTurns: 3,
          preparedAt,
          prepared,
          gcTurnReceipts,
          counters,
          countersAt,
          heap,
          heapAt,
          domOwned,
          domOwnedAt,
          resourceTracker,
          resourceTrackerAt,
        };
      },
    });
  } catch (error) {
    const failure = {
      kind: 'resource-readiness',
      label,
      message: String(error),
      readiness: error.readiness ?? null,
    };
    report.failures.push(failure);
    attempt('failure', failure);
    save(true);
    throw error;
  }
  const { post, measurements, readiness } = collected;
  const { prepared, counters, heap, domOwned, resourceTracker } = measurements;
  const baseline = report.resources.find(
    (item) => item.sampleKind === 'three-gc-endpoint' && item.label.endsWith('empty-baseline'),
  );
  const listeners = counters.jsEventListeners;
  const timers = resourceTracker.timers;
  const observers = resourceTracker.observers;
  const owned = {
    feeds: post.provider.activeSubscriptions,
    listeners: Math.max(0, listeners - (baseline?.listeners ?? listeners)),
    timers: Math.max(0, timers - (baseline?.timers ?? timers)),
    observers: Math.max(0, observers - (baseline?.observers ?? observers)),
    dom: Math.max(
      0,
      domOwned.totalOwned.consumer - (baseline?.domOwned.totalOwned.consumer ?? domOwned.totalOwned.consumer),
    ),
  };
  const snapshot = {
    ...post,
    label,
    sampleKind: 'three-gc-endpoint',
    gcTurns: 3,
    heapUsedBytes: heap.usedSize,
    measuredAt: {
      prepared: measurements.preparedAt,
      gcTurns: measurements.gcTurnReceipts,
      domCounters: measurements.countersAt,
      heap: measurements.heapAt,
      ownedDom: measurements.domOwnedAt,
      resourceTracker: measurements.resourceTrackerAt,
      providerAndMonitor: post.at,
    },
    dom: {
      nodes: counters.nodes,
      detached: domOwned.consumer.detached + domOwned.terminal.detached,
      disposed: domOwned.terminal.detached,
      ...(Object.hasOwn(counters, 'detachedNodes') ? { cdpDetached: counters.detachedNodes } : {}),
    },
    prepared,
    domOwned,
    listeners,
    timers,
    observers,
    resourceTracker,
    owned,
    readiness,
  };
  report.resources.push(snapshot);
  if (label.endsWith('empty-final') || label === 'capacity-final') {
    report.cleanup.finalResourceLabel = label;
    report.cleanup.ownedZeroCounts = {
      ...owned,
      activeSubscriptions: post.provider.activeSubscriptions,
      pendingRequests: post.provider.pendingRequests,
      detachedConsumer: domOwned.consumer.detached,
      detachedTerminal: domOwned.terminal.detached,
    };
  }
  save(true);
  return snapshot;
}

async function checkpoint(scene, mutationLog, id, scope, indices) {
  active();
  const pending = { id, scope, status: 'collecting' };
  attempt('checkpoint', pending);
  try {
    const observed = await fixture('checkpoint', { id, indices });
    const expected = expectedCheckpoint(scene, mutationLog, {
      id,
      scope,
      indices,
      mutationPrefix: mutationLog.length,
    });
    for (const cell of observed.cells) {
      const bars = cell.source.bars;
      cell.source.terminalDataSha256 = barHash(bars);
      delete cell.source.bars;
    }
    const item = {
      id,
      scope,
      rowsPerCell: scope === 'maximum-sampled' ? 100000 : 256,
      expected,
      observed,
      status: 'collected',
    };
    report.checkpoints.push(item);
    report.coverage.sourceHashes.push(
      ...observed.cells.map((cell) => ({
        checkpointId: id,
        cellId: cell.id,
        expectedSha256: expected.cells.find((entry) => entry.id === cell.id)?.source.expectedSha256,
        terminalDataSha256: cell.source.terminalDataSha256,
      })),
    );
    if (scope === 'maximum-sampled') {
      report.coverage.maxCheckpoints++;
      report.coverage.maxRenderedObservations += observed.cells.reduce(
        (sum, cell) => sum + cell.rendered.length,
        0,
      );
    } else {
      report.coverage.fullCheckpoints++;
      report.coverage.fullRenderedObservations += observed.cells.reduce(
        (sum, cell) => sum + cell.rendered.length,
        0,
      );
    }
    report.coverage.drawingsVerified += observed.cells.reduce(
      (sum, cell) => sum + cell.drawings.geometry.length,
      0,
    );
    report.coverage.alertsVerified += observed.cells.reduce(
      (sum, cell) => sum + cell.alerts.document.alerts.length,
      0,
    );
    attempt('checkpoint', {
      id,
      scope,
      status: 'collected',
      hashes: observed.cells.map((cell) => cell.source.terminalDataSha256),
    });
    save(true);
    return item;
  } catch (error) {
    report.failures.push({ kind: 'checkpoint', id, message: error.stack || String(error) });
    attempt('failure', { phase: 'checkpoint', id, message: error.stack || String(error) });
    save(true);
    throw error;
  }
}

const maxIndices = (n) => [
  0,
  1,
  13,
  14,
  19,
  20,
  25,
  26,
  33,
  199,
  200,
  Math.floor(n / 2),
  n - 4,
  n - 3,
  n - 2,
  n - 1,
];
const fullIndices = Array.from({ length: 256 }, (_, index) => index);
const intervalMs = (interval) => {
  const value = /^([1-9]\d*)(m|h|d)$/.exec(interval);
  assert.ok(value, 'Unsupported fixed benchmark interval: ' + interval);
  return Number(value[1]) * { m: 60000, h: 3600000, d: 86400000 }[value[2]];
};
const clone = (value) => structuredClone(value);

function scopeRecord(scene, rowsPerCell) {
  return {
    seed: 20260922,
    providerId: scene.gridWorkspace.providerId,
    cells: scene.cells.map((cell) => ({
      id: cell.id,
      query: cell.query,
      rowsPerCell,
      studies: cell.studies,
      drawings: cell.drawings,
      alerts: cell.alerts,
      workspace: cell.workspace,
      seriesCount: 12,
      paneCount: 4,
      drawingCount: 50,
      alertCount: 25,
    })),
    sourceRows: scene.cells.map((cell) => ({
      cellId: cell.id,
      rows: clone(cell.rows),
      orderedMutations: [],
    })),
    monitorSources: clone(scene.monitorSources),
    alternateSources: clone(scene.alternateSources ?? []),
  };
}

function mutationsFor(scene, record) {
  const ordered = [];
  record.mutations = ordered;
  const rows = new Map(scene.cells.map((cell) => [cell.id, clone(cell.rows)]));
  const queries = new Map(scene.cells.map((cell) => [cell.id, clone(cell.query)]));
  const queryKey = (query) => JSON.stringify([query.symbol, query.interval]);
  const latestByQuery = new Map();
  for (const source of scene.monitorSources)
    latestByQuery.set(queryKey(source.query), clone(source.rows.at(-1)));
  for (const source of scene.alternateSources ?? [])
    latestByQuery.set(queryKey(source.query), clone(source.rows.at(-1)));
  for (const cell of scene.cells) latestByQuery.set(queryKey(cell.query), clone(cell.rows.at(-1)));
  const records = new Map(record.sourceRows.map((item) => [item.cellId, item]));
  return {
    ordered,
    rows,
    queries,
    latestByQuery,
    noteDeliveries(checkpointId, receipt, deliveries) {
      for (let index = 0; index < deliveries.length; index++) {
        const { query, bar } = deliveries[index];
        const key = queryKey(query);
        const previousPrice = latestByQuery.get(key)?.close;
        assert.ok(Number.isFinite(previousPrice), `Missing effective provider baseline for ${key}`);
        this.add(checkpointId, null, 'monitor-update', {
          deliveryId: `${receipt.id}:${index + 1}`,
          query: clone(query),
          bar: clone(bar),
          previousPrice,
          dispatchedAt: receipt.dispatchedAt,
        });
        latestByQuery.set(key, clone(bar));
      }
    },
    add(checkpointId, cellId, operation, detail = {}) {
      const entry = { checkpointId, sequence: ordered.length, operation, cellId, ...detail };
      ordered.push(entry);
      if (cellId) records.get(cellId).orderedMutations.push(entry);
      return entry;
    },
    reset(checkpointId, rowCount) {
      latestByQuery.clear();
      for (const source of scene.monitorSources)
        latestByQuery.set(queryKey(source.query), clone(source.rows.at(-1)));
      for (const source of scene.alternateSources ?? [])
        latestByQuery.set(queryKey(source.query), clone(source.rows.at(-1)));
      for (const cell of scene.cells) {
        rows.set(cell.id, clone(cell.rows.slice(0, rowCount)));
        this.add(checkpointId, cell.id, 'source-reset', { rowCount });
        latestByQuery.set(queryKey(cell.query), clone(rows.get(cell.id).at(-1)));
      }
      this.add(checkpointId, null, 'monitor-baseline-reset', {
        reason: 'public-destroy-recreate',
        baselines: [...latestByQuery].map(([key, bar]) => {
          const [symbol, interval] = JSON.parse(key);
          return { query: { symbol, interval }, bar: clone(bar) };
        }),
      });
    },
    append(checkpointId, cellId, bar) {
      rows.get(cellId).push(clone(bar));
      this.add(checkpointId, cellId, 'append', { index: rows.get(cellId).length - 1, bar: clone(bar) });
    },
    replace(checkpointId, cellId, bar) {
      const data = rows.get(cellId);
      const index = data.length - 1;
      data[index] = clone(bar);
      this.add(checkpointId, cellId, 'replace', { index, bar: clone(bar) });
    },
  };
}

function nextReplacement(bar, batch) {
  const close = bar.close + (batch % 2 ? 0.003 : -0.003);
  return {
    ...bar,
    close,
    high: Math.max(bar.high, bar.open, close) + 0.001,
    low: Math.min(bar.low, bar.open, close) - 0.001,
  };
}

function nextAppend(bar, query, batch) {
  const open = bar.close;
  const close = open + Math.sin(batch / 7) * 0.025;
  return {
    time: bar.time + intervalMs(query.interval),
    open,
    high: Math.max(open, close) + 0.5,
    low: Math.min(open, close) - 0.5,
    close,
    volume: 100 + (batch % 97),
  };
}

async function prepareScope(scene, label, preserveEvents = false) {
  active();
  const result = await fixture('prepare', {
    ...scene,
    __preserveEvents: preserveEvents,
    __benchmarkScope: label,
  });
  assert.equal(result.cells.length, 4);
  assert.equal(result.providerId, 'filtix-grid-workload-v1');
  attempt('prepare', { label, result });
  save();
  return result;
}

async function runBatches(category, scene, mutation, count, kind, checkpointId) {
  const phaseStart = nodeEpoch();
  for (let batch = 0; batch < count; batch++) {
    active();
    const targetAt = phaseStart + batch * 40;
    if (nodeEpoch() < targetAt) await sleep(targetAt - nodeEpoch());
    const deliveries = [];
    const replacements = [];
    for (const cell of scene.cells) {
      const rows = mutation.rows.get(cell.id);
      if (kind === 'append-replace') {
        const appended = nextAppend(rows.at(-1), mutation.queries.get(cell.id), batch);
        deliveries.push({ query: mutation.queries.get(cell.id), bar: appended });
        replacements.push({
          query: mutation.queries.get(cell.id),
          bar: nextReplacement(appended, batch + 1000),
        });
      } else {
        const replaced = nextReplacement(rows.at(-1), batch);
        deliveries.push({ query: mutation.queries.get(cell.id), bar: replaced });
      }
    }
    const receipt = await action(category, {
      id: `${category}-${batch + 1}`,
      kind: 'deliver',
      phase: category,
      targetAt,
      deliveries: [...deliveries, ...replacements],
      affectedCellIds: ids,
    });
    mutation.noteDeliveries(checkpointId, receipt, [...deliveries, ...replacements]);
    for (let index = 0; index < scene.cells.length; index++) {
      const cell = scene.cells[index];
      if (kind === 'append-replace') {
        mutation.append(checkpointId, cell.id, deliveries[index].bar);
        mutation.replace(checkpointId, cell.id, replacements[index].bar);
      } else mutation.replace(checkpointId, cell.id, deliveries[index].bar);
    }
    report.coverage.soakCadence.push({
      phase: category,
      targetAt,
      dispatchedAt: receipt.dispatchedAt,
      completedAt: receipt.settledAt,
    });
  }
  report.coverage.tailSamples = report.actions.tailReplace.length + report.actions.tailAppendReplace.length;
  save(true);
}

async function transitionRows(scene, mutation, rowCount, label) {
  const before = await fixture('resources', `${label}-before`);
  const savedWorkspace = await page.evaluate(() => window.gridBenchmark.grid.getWorkspace());
  const retirement = await fixture('retire');
  mutation.reset(label, rowCount);
  const reduced = clone(scene);
  reduced.gridWorkspace = savedWorkspace;
  for (const cell of reduced.cells) cell.rows = clone(mutation.rows.get(cell.id));
  const prepared = await prepareScope(reduced, label, true);
  const setup = await action('lifecycle', {
    id: `${label}-public-setup`,
    kind: 'construct',
    phase: 'explicit-untimed-source-reset',
    targetRows: rowCount,
  });
  const after = await fixture('resources', `${label}-after`);
  report.actions.lifecycle.push({
    id: label,
    kind: 'source-reset',
    rowCount,
    before,
    retirement,
    savedWorkspace,
    prepared,
    setup,
    after,
    budgeted: false,
  });
  save();
}

async function maxPhase(scene) {
  const record = scopeRecord(scene, 100000);
  report.scene.scopes.maximum = record;
  const mutation = mutationsFor(scene, record);
  const ordinaryDemo = await fixture('prepareEmpty');
  report.actions.lifecycle.push({
    id: 'max-ordinary-demo-fault-teardown',
    kind: 'ordinary-demo-fault-teardown',
    scope: 'maximum-sampled',
    observed: ordinaryDemo.ordinaryDemo,
    budgeted: false,
  });
  await endpoint('max-empty-baseline');
  await prepareScope(scene, 'maximum');
  const warmup = await action('warmup', {
    id: 'max-warmup',
    kind: 'construct',
    phase: 'warmup',
    targetRows: 100000,
  });
  attempt('warmup', { receipt: warmup });
  await fixture('retire');
  for (let index = 1; index <= 3; index++) {
    if (index > 1) await fixture('retire');
    await action('constructions', {
      id: `max-construction-${index}`,
      kind: 'construct',
      phase: 'maximum',
      targetRows: 100000,
    });
    await checkpoint(
      scene,
      mutation.ordered,
      `max-construction-${index}`,
      'maximum-sampled',
      maxIndices(100000),
    );
  }
  report.coverage.constructionSamples = report.actions.constructions.length;
  await endpoint('max-mounted-initial');
  await endpoint('max-layout-4');
  for (let index = 1; index <= 3; index++) {
    await action('restores', {
      id: `max-restore-${index}`,
      kind: 'restore',
      phase: 'maximum',
      targetRows: 100000,
    });
    await checkpoint(scene, mutation.ordered, `max-restore-${index}`, 'maximum-sampled', maxIndices(100000));
  }
  report.coverage.restoreSamples = report.actions.restores.length;
  const one = await fixture('act', {
    id: 'max-resource-layout-1',
    kind: 'layout',
    phase: 'resource-control',
    layout: 1,
  });
  await endpoint('max-layout-1');
  const four = await fixture('act', {
    id: 'max-resource-layout-4',
    kind: 'layout',
    phase: 'resource-control',
    layout: 4,
    targetRows: 100000,
  });
  await endpoint('max-layout-4-return');
  report.actions.lifecycle.push({ kind: 'resource-layout-control', one, four, budgeted: false });
  await runBatches('tailReplace', scene, mutation, 100, 'replace', 'max-replacements');
  await checkpoint(scene, mutation.ordered, 'max-replacements', 'maximum-sampled', maxIndices(100000));
  await transitionRows(scene, mutation, 99900, 'max-append-setup');
  await runBatches('tailAppendReplace', scene, mutation, 100, 'append-replace', 'max-append-replacements');
  assert.ok([...mutation.rows.values()].every((rows) => rows.length === 100000));
  await checkpoint(scene, mutation.ordered, 'max-append-replacements', 'maximum-sampled', maxIndices(100000));
  await interactions(scene, mutation);
  await checkpoint(scene, mutation.ordered, 'max-interactions', 'maximum-sampled', maxIndices(100000));
  await syncSamples(scene, mutation, 'exact');
  await checkpoint(scene, mutation.ordered, 'max-sync-exact', 'maximum-sampled', maxIndices(100000));
  await syncSamples(scene, mutation, 'nearest');
  await checkpoint(scene, mutation.ordered, 'max-sync-nearest', 'maximum-sampled', maxIndices(100000));
  return mutation;
}

async function interactions(scene, mutation) {
  const phaseStart = nodeEpoch();
  let serial = 0;
  for (const cell of scene.cells) {
    for (let index = 0; index < 60; index++) {
      const targetAt = phaseStart + serial++ * 40;
      if (nodeEpoch() < targetAt) await sleep(targetAt - nodeEpoch());
      let spec;
      if (index < 20) spec = { kind: 'gesture', gesture: 'pan', deltaX: index % 2 ? -18 : 18 };
      else if (index < 40) spec = { kind: 'gesture', gesture: 'zoom', deltaY: index % 2 ? -20 : 20 };
      else if (index < 50) {
        const drawing = cell.drawings.drawings[index - 40];
        const original = drawing.points[0];
        const point = { ...original, price: original.price + (index % 2 ? -0.025 : 0.025) };
        const patch = { points: [point, ...drawing.points.slice(1)] };
        spec = { kind: 'drawing', drawingId: drawing.id, patch };
        mutation.add('max-interactions', cell.id, 'drawing-edit', {
          drawingId: drawing.id,
          drawingPatch: patch,
        });
      } else {
        const pane = cell.workspace.layout.panes;
        const weight = pane[0].weight + (index % 2 ? -0.01 : 0.01);
        const panes = pane.map((item, paneIndex) => ({
          id: item.id,
          weight: paneIndex === 0 ? weight : item.weight,
        }));
        spec = { kind: 'pane', panes };
        mutation.add('max-interactions', cell.id, 'pane-edit', { paneWeights: panes });
      }
      const receipt = await action('interaction', {
        id: `interaction-${cell.id}-${index + 1}`,
        phase: 'maximum-interaction',
        targetAt,
        cellId: cell.id,
        affectedCellIds: ids,
        ...spec,
      });
      if (spec.kind === 'gesture')
        assert.notDeepEqual(
          receipt.effectiveObservation?.afterRange,
          receipt.effectiveObservation?.beforeRange,
          'Gesture must change range',
        );
    }
  }
  report.coverage.interactionSamples = report.actions.interaction.length;
  for (const cell of scene.cells) {
    for (let index = 0; index < 6; index++) {
      const id = `wheel-${cell.id}-${index + 1}`;
      const start = nodeEpoch();
      await fixture('beginExternal', {
        id,
        kind: 'wheel',
        phase: 'real-wheel',
        cellId: cell.id,
        targetAt: start,
      });
      const locator = page.locator(`[data-filtix-grid-cell="${cell.id}"] [data-filtix-root]`);
      const box = await locator.boundingBox();
      assert.ok(box && box.width > 100 && box.height > 100, 'Real wheel target must be visible');
      await page.mouse.move(box.x + Math.min(120, box.width / 3), box.y + Math.min(90, box.height / 3));
      await fixture('beginExternal', { id, stage: 'arm' });
      await page.mouse.wheel(0, index % 2 ? -40 : 40);
      const receipt = await fixture('finishExternal', { startedAt: start, completedAt: nodeEpoch() });
      receipt.automationCompleted = nodeEpoch();
      receipt.automationInclusiveMs = receipt.automationCompleted - receipt.automationStarted;
      assert.notDeepEqual(
        receipt.effectiveObservation.afterRange,
        receipt.effectiveObservation.beforeRange,
        'Real wheel was ineffective',
      );
      report.actions.wheel.push(receipt);
      attempt('wheel', { ...receipt, status: 'collected' });
      save();
    }
  }
  report.coverage.wheelSamples = report.actions.wheel.length;
}

async function syncSamples(scene, mutation, match) {
  const category = match === 'exact' ? 'syncExact' : 'syncNearest';
  const syncSetup = await fixture('act', {
    id: `${category}-setup`,
    kind: 'sync',
    phase: 'sync-setup-outside-samples',
    sync: { viewport: true, crosshair: true, crosshairMatch: match },
  });
  report.actions.lifecycle.push({ ...syncSetup, budgeted: false });
  const sources = scene.cells.map((cell) => mutation.rows.get(cell.id));
  const overlapFrom = Math.max(...sources.map((rows) => rows[0].time));
  const overlapTo = Math.min(...sources.map((rows) => rows.at(-1).time));
  const coarseStep = Math.max(...scene.cells.map((cell) => intervalMs(cell.query.interval)));
  const span = coarseStep * 12;
  const firstFrom = (overlapFrom + overlapTo) / 2 - (span + coarseStep * 11) / 2;
  assert.ok(firstFrom - coarseStep > overlapFrom && firstFrom + span + coarseStep * 11 < overlapTo);
  const prepared = await fixture('act', {
    id: `${category}-common-window-setup`,
    kind: 'range',
    phase: 'sync-setup-outside-samples',
    cellId: scene.cells[0].id,
    affectedCellIds: ids,
    range: { from: firstFrom - coarseStep, to: firstFrom - coarseStep + span },
  });
  report.actions.lifecycle.push({ ...prepared, budgeted: false });
  const samples = [];
  let rangeOrdinal = 0;
  for (const cell of scene.cells) {
    const rows = mutation.rows.get(cell.id);
    for (let index = 0; index < 6; index++) {
      if (index % 2 === 0) {
        const from = firstFrom + rangeOrdinal++ * coarseStep;
        samples.push({ cellId: cell.id, kind: 'range', range: { from, to: from + span } });
      } else {
        const range = samples.at(-1).range;
        const center = (range.from + range.to) / 2;
        let lo = 0,
          hi = rows.length;
        while (lo < hi) {
          const middle = lo + Math.floor((hi - lo) / 2);
          if (rows[middle].time < center) lo = middle + 1;
          else hi = middle;
        }
        const following = rows[Math.min(lo, rows.length - 1)];
        const preceding = rows[Math.max(0, lo - 1)];
        const selected = center - preceding.time <= following.time - center ? preceding : following;
        assert.ok(selected.time > range.from + coarseStep && selected.time < range.to - coarseStep);
        samples.push({ cellId: cell.id, kind: 'cursor', time: selected.time, match });
      }
    }
  }
  const start = nodeEpoch();
  for (let serial = 0; serial < samples.length; serial++) {
    const sample = samples[serial];
    const targetAt = start + serial * 40;
    if (nodeEpoch() < targetAt) await sleep(targetAt - nodeEpoch());
    await action(category, {
      id: `${category}-${sample.cellId}-${(serial % 6) + 1}`,
      phase: `sync-${match}`,
      targetAt,
      affectedCellIds: ids,
      ...sample,
    });
  }
  mutation.add(match === 'exact' ? 'max-sync-exact' : 'max-sync-nearest', null, 'sync', { match });
  report.coverage.syncSamples = report.actions.syncExact.length + report.actions.syncNearest.length;
  save();
}

async function soakPhase(scene, mutation) {
  const targetMs = 120000;
  const start = nodeEpoch();
  report.soakStartedAt = start;
  const queryKey = (query) => JSON.stringify([query.symbol, query.interval]);
  const monitorRows = mutation.latestByQuery;
  let batch = 0;
  let park = 0,
    activeChanges = 0,
    restores = 0,
    destroys = 0;
  const pauses = [];
  const pausedMs = () => pauses.reduce((sum, item) => sum + item.completedAt - item.startedAt, 0);
  while (
    nodeEpoch() - start - pausedMs() < targetMs ||
    park < 10 ||
    activeChanges < 20 ||
    restores < 10 ||
    destroys < 6
  ) {
    active();
    const targetAt = start + batch * 40;
    if (nodeEpoch() < targetAt) await sleep(targetAt - nodeEpoch());
    const deliveries = [];
    for (const cell of scene.cells) {
      const bar = nextReplacement(mutation.rows.get(cell.id).at(-1), batch + 2000);
      deliveries.push({ query: cell.query, bar });
    }
    for (const item of scene.monitorSources) {
      const key = queryKey(item.query);
      const chartBar = deliveries.find((entry) => queryKey(entry.query) === key)?.bar;
      const bar = nextReplacement(chartBar ?? monitorRows.get(key), batch + 2000);
      deliveries.push({ query: item.query, bar });
    }
    const receipt = await action('soak', {
      id: `soak-batch-${batch + 1}`,
      kind: 'deliver',
      phase: 'maximum-soak',
      targetAt,
      deliveries,
      affectedCellIds: ids,
    });
    mutation.noteDeliveries('max-soak', receipt, deliveries);
    for (let index = 0; index < 4; index++) {
      const cell = scene.cells[index];
      const last = deliveries.findLast(
        (entry) => entry.query.symbol === cell.query.symbol && entry.query.interval === cell.query.interval,
      );
      mutation.replace('max-soak', cell.id, last.bar);
    }
    report.coverage.soakCadence.push({
      phase: 'soak',
      targetAt,
      dispatchedAt: receipt.dispatchedAt,
      completedAt: receipt.settledAt,
    });
    batch++;
    if (batch % 30 === 0 && park < 10) {
      const pauseStart = nodeEpoch();
      const one = await fixture('act', {
        id: `soak-park-${park + 1}`,
        kind: 'layout',
        layout: 1,
        phase: 'soak-lifecycle',
      });
      await endpoint(`soak-layout-1-${park + 1}`);
      const four = await fixture('act', {
        id: `soak-unpark-${park + 1}`,
        kind: 'layout',
        layout: 4,
        phase: 'soak-lifecycle',
        targetRows: 100000,
      });
      await endpoint(`soak-layout-4-${park + 1}`);
      const resumed = await fixture('resources', `soak-resume-${park + 1}`);
      assert.ok(
        resumed.cells.every((item) => item.rows === 100000 && item.feed && !item.feed.destroyed),
        'Soak remount must restore four current 100k feeds',
      );
      report.actions.lifecycle.push({ kind: 'park-cycle', one, four, budgeted: false });
      report.resources.push(resumed);
      park++;
      pauses.push({ kind: 'park-cycle', startedAt: pauseStart, completedAt: nodeEpoch() });
    }
    if (batch % 17 === 0 && activeChanges < 20) {
      const pauseStart = nodeEpoch();
      const currentActive = await page.evaluate(() => window.gridBenchmark.grid.getState().activeCellId);
      const currentIndex = ids.indexOf(currentActive);
      assert.ok(currentIndex >= 0, 'Soak active cell must be one of the four mounted cells');
      const receipt = await fixture('act', {
        id: `soak-active-${activeChanges + 1}`,
        kind: 'active',
        cellId: ids[(currentIndex + 1) % ids.length],
        phase: 'soak-lifecycle',
      });
      assert.notEqual(
        receipt.semanticObservation.before.state.activeCellId,
        receipt.semanticObservation.after.state.activeCellId,
        'Soak active selection must change the observed active cell',
      );
      report.actions.lifecycle.push({ ...receipt, budgeted: false });
      activeChanges++;
      pauses.push({ kind: 'active-change', startedAt: pauseStart, completedAt: nodeEpoch() });
    }
    if (batch % 40 === 0 && restores < 10) {
      const pauseStart = nodeEpoch();
      const saved = await page.evaluate(() => window.gridBenchmark.grid.getWorkspace());
      const receipt = await fixture('act', {
        id: `soak-restore-${restores + 1}`,
        kind: 'restore',
        phase: 'soak-lifecycle',
        workspace: saved,
        targetRows: 100000,
      });
      report.actions.lifecycle.push({ ...receipt, budgeted: false });
      restores++;
      pauses.push({ kind: 'save-restore', startedAt: pauseStart, completedAt: nodeEpoch() });
    }
    if (batch % 60 === 0 && destroys < 6) {
      const pauseStart = nodeEpoch();
      const saved = await page.evaluate(() => window.gridBenchmark.grid.getWorkspace());
      const retired = await fixture('retire');
      const receipt = await fixture('act', {
        id: `soak-recreate-${destroys + 1}`,
        kind: 'construct',
        phase: 'soak-lifecycle',
        targetRows: 100000,
        workspace: saved,
      });
      report.actions.lifecycle.push({ kind: 'destroy-recreate', retired, receipt, budgeted: false });
      destroys++;
      pauses.push({ kind: 'destroy-recreate', startedAt: pauseStart, completedAt: nodeEpoch() });
    }
    if (batch % 20 === 0) save();
  }
  report.soakCompletedAt = nodeEpoch();
  report.coverage.soakElapsedMs = report.soakCompletedAt - start;
  report.coverage.lifecycleCounts = { parkCycles: park, activeChanges, restores, destroyRecreates: destroys };
  report.soakPauses = pauses;
  report.soakEffectiveRunningMs = report.coverage.soakElapsedMs - pausedMs();
  await checkpoint(scene, mutation.ordered, 'max-soak', 'maximum-sampled', maxIndices(100000));
  save();
}

async function fullPhase(scene) {
  const record = scopeRecord(scene, 256);
  report.scene.scopes.full = record;
  const mutation = mutationsFor(scene, record);
  const ordinaryDemo = await fixture('prepareEmpty');
  report.actions.lifecycle.push({
    id: 'full-ordinary-demo-fault-teardown',
    kind: 'ordinary-demo-fault-teardown',
    scope: 'full-256',
    observed: ordinaryDemo.ordinaryDemo,
    budgeted: false,
  });
  await endpoint('full-empty-baseline');
  await prepareScope(scene, 'bounded-full-256');
  await action('lifecycle', {
    id: 'full-initial-setup-action',
    kind: 'construct',
    phase: 'correctness-only',
    targetRows: 256,
  });
  await checkpoint(scene, mutation.ordered, 'full-initial-setup', 'full-256', fullIndices);
  await endpoint('full-mounted-initial');

  const replacements = scene.cells.map((cell, index) => ({
    query: cell.query,
    bar: nextReplacement(mutation.rows.get(cell.id).at(-1), index + 1),
  }));
  const replacementReceipt = await action('lifecycle', {
    id: 'full-tail-replacement-action',
    kind: 'deliver',
    phase: 'correctness-only',
    deliveries: replacements,
  });
  mutation.noteDeliveries('full-tail-replacement', replacementReceipt, replacements);
  scene.cells.forEach((cell, index) =>
    mutation.replace('full-tail-replacement', cell.id, replacements[index].bar),
  );
  await checkpoint(scene, mutation.ordered, 'full-tail-replacement', 'full-256', fullIndices);

  await transitionRows(scene, mutation, 255, 'full-append-255-setup');
  const appends = scene.cells.map((cell, index) => ({
    query: cell.query,
    bar: nextAppend(mutation.rows.get(cell.id).at(-1), cell.query, index + 1),
  }));
  const appendReceipt = await action('lifecycle', {
    id: 'full-append-255-to-256-action',
    kind: 'deliver',
    phase: 'correctness-only',
    deliveries: appends,
  });
  mutation.noteDeliveries('full-append-255-to-256', appendReceipt, appends);
  scene.cells.forEach((cell, index) =>
    mutation.append('full-append-255-to-256', cell.id, appends[index].bar),
  );
  await checkpoint(scene, mutation.ordered, 'full-append-255-to-256', 'full-256', fullIndices);

  for (const cell of scene.cells) {
    const drawing = cell.drawings.drawings[0];
    const patch = {
      points: drawing.points.map((point, index) => (index ? point : { ...point, price: point.price + 0.05 })),
    };
    await action('lifecycle', {
      id: `full-drawing-${cell.id}`,
      kind: 'drawing',
      phase: 'correctness-only',
      cellId: cell.id,
      drawingId: drawing.id,
      patch,
      affectedCellIds: [cell.id],
    });
    mutation.add('full-drawing-edit', cell.id, 'drawing-edit', {
      drawingId: drawing.id,
      drawingPatch: patch,
    });
  }
  await checkpoint(scene, mutation.ordered, 'full-drawing-edit', 'full-256', fullIndices);

  for (const cell of scene.cells) {
    const study = cell.studies.find((item) => item.kind === 'sma');
    const patch = { period: study.period + 1 };
    await action('lifecycle', {
      id: `full-study-${cell.id}`,
      kind: 'study',
      phase: 'correctness-only',
      cellId: cell.id,
      studyId: study.id,
      patch,
      affectedCellIds: [cell.id],
    });
    mutation.add('full-study-parameter-edit', cell.id, 'study-edit', {
      studyId: study.id,
      studyPatch: patch,
    });
  }
  await checkpoint(scene, mutation.ordered, 'full-study-parameter-edit', 'full-256', fullIndices);

  for (const cell of scene.cells) {
    const panes = cell.workspace.layout.panes.map((item, index) => ({
      id: item.id,
      weight: item.weight + (index === 0 ? 0.02 : 0),
    }));
    await action('lifecycle', {
      id: `full-pane-${cell.id}`,
      kind: 'pane',
      phase: 'correctness-only',
      cellId: cell.id,
      panes,
      affectedCellIds: [cell.id],
    });
    mutation.add('full-pane-edit', cell.id, 'pane-edit', { paneWeights: panes });
  }
  await checkpoint(scene, mutation.ordered, 'full-pane-edit', 'full-256', fullIndices);

  const alternatives = scene.alternateSources ?? [];
  assert.ok(alternatives.length >= 2, 'Full pass requires market and interval destination sources');
  const market = alternatives.find((item) => item.cellId === 'cell-2') ?? alternatives[1];
  const interval = alternatives.find((item) => item.cellId === 'cell-1') ?? alternatives[0];
  await action('lifecycle', {
    id: 'full-market-switch-action',
    kind: 'market',
    phase: 'correctness-only',
    cellId: market.cellId,
    query: market.query,
    targetRows: 256,
    affectedCellIds: ids,
  });
  mutation.queries.set(market.cellId, clone(market.query));
  mutation.rows.set(market.cellId, clone(market.rows));
  mutation.add('full-market-switch', market.cellId, 'market-switch', { query: clone(market.query) });
  await checkpoint(scene, mutation.ordered, 'full-market-switch', 'full-256', fullIndices);

  await action('lifecycle', {
    id: 'full-interval-switch-action',
    kind: 'market',
    phase: 'correctness-only',
    cellId: interval.cellId,
    query: interval.query,
    targetRows: 256,
    affectedCellIds: ids,
  });
  mutation.queries.set(interval.cellId, clone(interval.query));
  mutation.rows.set(interval.cellId, clone(interval.rows));
  mutation.add('full-interval-switch', interval.cellId, 'interval-switch', { query: clone(interval.query) });
  await checkpoint(scene, mutation.ordered, 'full-interval-switch', 'full-256', fullIndices);

  const parked = await action('lifecycle', {
    id: 'full-park-cell-4',
    kind: 'layout',
    phase: 'correctness-only',
    layout: 2,
  });
  const beforeParked = await page.evaluate(
    () =>
      window.gridBenchmark.grid.getWorkspace().cells.find((item) => item.id === 'cell-4').workspace.alerts,
  );
  const once = scene.fullParkedOnceDelivery;
  assert.ok(once?.expectedAlertId && once?.query && once?.bar, 'Oracle parked-once delivery required');
  const parkedKey = JSON.stringify([once.query.symbol, once.query.interval]);
  const previousParkedBar = mutation.latestByQuery.get(parkedKey);
  const parkedThreshold = beforeParked.alerts.find((rule) => rule.id === once.expectedAlertId)?.price;
  assert.ok(
    previousParkedBar && Number.isFinite(parkedThreshold),
    'Parked crossing baseline and rule required',
  );
  const parkedClose = Math.max(previousParkedBar.close + 1, parkedThreshold + 1);
  const parkedBar = {
    ...previousParkedBar,
    time: previousParkedBar.time + intervalMs(once.query.interval),
    open: previousParkedBar.close,
    close: parkedClose,
    high: parkedClose + 0.5,
    low: previousParkedBar.close - 0.1,
  };
  const parkedDelivery = await action('lifecycle', {
    id: 'full-parked-once-crossing',
    kind: 'deliver',
    phase: 'correctness-only',
    deliveries: [{ query: once.query, bar: parkedBar }],
  });
  mutation.noteDeliveries('full-parked-once-crossing-remount', parkedDelivery, [
    { query: once.query, bar: parkedBar },
  ]);
  const duringParked = await page.evaluate(
    () =>
      window.gridBenchmark.grid.getWorkspace().cells.find((item) => item.id === 'cell-4').workspace.alerts,
  );
  const remounted = await action('lifecycle', {
    id: 'full-remount-cell-4',
    kind: 'layout',
    phase: 'correctness-only',
    layout: 4,
    targetRows: 256,
  });
  const afterParked = await page.evaluate(
    () =>
      window.gridBenchmark.grid.getWorkspace().cells.find((item) => item.id === 'cell-4').workspace.alerts,
  );
  const parkedRule = (document) => document.alerts.find((rule) => rule.id === once.expectedAlertId);
  assert.equal(parkedRule(beforeParked)?.status, 'armed');
  assert.equal(parkedRule(duringParked)?.status, 'triggered');
  assert.equal(parkedRule(duringParked)?.triggerCount, 1);
  assert.deepEqual(
    parkedRule(afterParked),
    parkedRule(duringParked),
    'Parked once state must survive remount',
  );
  report.actions.lifecycle.push({
    kind: 'parked-once-proof',
    parked,
    beforeParked,
    duringParked,
    remounted,
    afterParked,
  });
  mutation.add('full-parked-once-crossing-remount', 'cell-4', 'parked-once-crossing', {
    query: once.query,
    alertId: once.expectedAlertId,
    previousPrice: previousParkedBar.close,
  });
  await checkpoint(scene, mutation.ordered, 'full-parked-once-crossing-remount', 'full-256', fullIndices);

  const saved = await page.evaluate(() => window.gridBenchmark.grid.getWorkspace());
  await action('lifecycle', {
    id: 'full-save-restore-action',
    kind: 'restore',
    phase: 'correctness-only',
    workspace: saved,
    targetRows: 256,
  });
  mutation.add('full-save-restore', null, 'save-restore');
  await checkpoint(scene, mutation.ordered, 'full-save-restore', 'full-256', fullIndices);

  const zero = await action('lifecycle', {
    id: 'full-zero-size',
    kind: 'size',
    phase: 'correctness-only',
    width: 0,
    height: 0,
  });
  assert.equal(
    zero.effectiveObservation?.afterRect?.width,
    0,
    'Zero-size fixture width must actually be zero',
  );
  assert.equal(
    zero.effectiveObservation?.afterRect?.height,
    0,
    'Zero-size fixture height must actually be zero',
  );
  const recovered = await action('lifecycle', {
    id: 'full-size-recovery',
    kind: 'size',
    phase: 'correctness-only',
    width: 1600,
    height: 1000,
  });
  assert.equal(recovered.effectiveObservation?.afterRect?.width, 1600, 'Recovered fixture width');
  assert.equal(recovered.effectiveObservation?.afterRect?.height, 1000, 'Recovered fixture height');
  mutation.add('full-zero-size-recovery', null, 'zero-size-recovery');
  await checkpoint(scene, mutation.ordered, 'full-zero-size-recovery', 'full-256', fullIndices);
  await checkpoint(scene, mutation.ordered, 'full-final-mounted', 'full-256', fullIndices);
  const resourceBefore = await fixture('resources', 'full-resource-equivalent-before');
  const sourcesBefore = await fixture('providerSources');
  const originalParkedSource = scene.cells.find(
    (cell) => JSON.stringify([cell.query.symbol, cell.query.interval]) === parkedKey,
  );
  assert.ok(originalParkedSource, 'Parked delivery must target an original fixed chart query');
  const parkedSourceBefore = sourcesBefore.sources.find(
    (item) => JSON.stringify([item.query.symbol, item.query.interval]) === parkedKey,
  );
  assert.equal(parkedSourceBefore?.rows, originalParkedSource.rows.length + 1);
  const retirement = await fixture('retire');
  const prepared = await prepareScope(scene, 'full-resource-equivalent-reset', true);
  const sourcesAfterPrepare = await fixture('providerSources');
  const parkedSourceAfter = sourcesAfterPrepare.sources.find(
    (item) => JSON.stringify([item.query.symbol, item.query.interval]) === parkedKey,
  );
  assert.equal(parkedSourceAfter?.rows, originalParkedSource.rows.length);
  assert.deepEqual(parkedSourceAfter?.lastBar, originalParkedSource.rows.at(-1));
  assert.ok(sourcesAfterPrepare.providerGeneration > sourcesBefore.providerGeneration);
  const resourceSetup = await fixture('act', {
    id: 'full-resource-equivalent-construct',
    kind: 'construct',
    phase: 'resource-control',
    workspace: scene.gridWorkspace,
    targetRows: 256,
  });
  const resourceAfter = await fixture('resources', 'full-resource-equivalent-after');
  report.actions.lifecycle.push({
    id: 'full-resource-equivalent-reset',
    kind: 'resource-equivalent-source-reset',
    scope: 'full-256',
    reason: 'post-checkpoint-provider-reset',
    rowCount: 256,
    before: resourceBefore,
    sourcesBefore,
    retirement,
    prepared,
    sourcesAfterPrepare,
    setup: resourceSetup,
    after: resourceAfter,
    budgeted: false,
  });
  await endpoint('full-mounted-final');
  const cleanup = await fixture('close');
  report.cleanup.borrowedUsabilityObservations.push({ scope: 'full-256', ...cleanup });
  await endpoint('full-empty-final');
  report.resources.push(...(await fixture('probeTransientLatest')));
  report.cleanup.ownershipControls = await fixture('ownershipControls');
  report.cleanup.ownershipControlObservations.push({
    scope: 'full-256',
    ...report.cleanup.ownershipControls,
  });
  await endpoint('full-controls-final');
  save();
}

function capacitySceneFor(scene) {
  const capacityScene = clone(scene);
  const baseline = scene.monitorSources[0].rows[0];
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];
  const intervals = ['1m', '5m', '1h', '15m', '30m', '2h', '4h', '1d'];
  const queries = symbols.flatMap((symbol) => intervals.map((interval) => ({ symbol, interval })));
  capacityScene.catalog = { symbols, intervals };
  capacityScene.monitorSources = queries.map((query) => ({ query, rows: [{ ...baseline }] }));
  for (let cellIndex = 0; cellIndex < 4; cellIndex++) {
    const cell = capacityScene.cells[cellIndex];
    const original = cell.alerts;
    const alerts = Array.from({ length: 100 }, (_, index) => ({
      ...clone(original.alerts[index % original.alerts.length]),
      id: `${original.scopeId}:${index + 1}`,
      query: queries[(cellIndex * 8 + index) % 32],
      status: 'armed',
      frequency: 'repeat',
      triggerCount: 0,
      lastTrigger: null,
    }));
    const document = { ...original, nextRuleId: 101, alerts };
    cell.alerts = document;
    cell.workspace.alerts = clone(document);
    capacityScene.gridWorkspace.cells[cellIndex].workspace.alerts = clone(document);
  }
  return { capacityScene, queries };
}

async function capacityPhase(scene) {
  const ordinaryDemo = await fixture('prepareEmpty');
  report.actions.lifecycle.push({
    id: 'capacity-ordinary-demo-fault-teardown',
    kind: 'ordinary-demo-fault-teardown',
    scope: 'capacity-400-rules-32-queries',
    observed: ordinaryDemo.ordinaryDemo,
    budgeted: false,
  });
  await endpoint('capacity-empty-baseline');
  const { capacityScene } = capacitySceneFor(scene);
  await prepareScope(capacityScene, 'capacity-400-rules-32-queries');
  const restored = await fixture('act', {
    id: 'capacity-restore',
    kind: 'construct',
    phase: 'correctness-only-capacity',
    targetRows: 256,
    targetLatestQueries: 32,
  });
  const admitted = await fixture('resources', 'capacity-admitted');
  const documents = await page.evaluate(() =>
    window.gridBenchmark.grid.getWorkspace().cells.map((cell) => cell.workspace.alerts),
  );
  report.capacity.rules = documents.reduce((sum, document) => sum + document.alerts.length, 0);
  report.capacity.armedQueries = new Set(
    documents.flatMap((document) =>
      document.alerts
        .filter((rule) => rule.status === 'armed')
        .map((rule) => JSON.stringify([rule.query.symbol, rule.query.interval])),
    ),
  ).size;
  report.capacity.restoreObservations.push({
    scope: 'capacity-400-rules-32-queries',
    restored,
    admitted,
    documents,
  });
  const failure = await page.evaluate(async () => {
    const benchmark = window.gridBenchmark;
    const document = benchmark.grid.getWorkspace();
    const before = {
      workspace: benchmark.grid.getWorkspace(),
      state: benchmark.grid.getState(),
      provider: benchmark.providerSnapshot(),
    };
    document.cells[0].workspace.alerts.alerts[0].query = { symbol: 'CAP33', interval: '1m' };
    let error = null;
    try {
      await benchmark.grid.restoreWorkspace(document);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      kind: 'catalog-boundary',
      attempted: document,
      error,
      before,
      after: {
        workspace: benchmark.grid.getWorkspace(),
        state: benchmark.grid.getState(),
        provider: benchmark.providerSnapshot(),
      },
    };
  });
  report.capacity.failedAtomicity.push({ scope: 'capacity-400-rules-32-queries', ...failure });
  const ruleFailure = await page.evaluate(async () => {
    const benchmark = window.gridBenchmark;
    const document = benchmark.grid.getWorkspace();
    const before = {
      workspace: benchmark.grid.getWorkspace(),
      state: benchmark.grid.getState(),
      provider: benchmark.providerSnapshot(),
    };
    const alerts = document.cells[0].workspace.alerts;
    alerts.alerts.push({ ...alerts.alerts[0], id: `${alerts.scopeId}:101` });
    alerts.nextRuleId = 102;
    let error = null;
    try {
      await benchmark.grid.restoreWorkspace(document);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      kind: 'rule-overflow',
      attempted: document,
      error,
      before,
      after: {
        workspace: benchmark.grid.getWorkspace(),
        state: benchmark.grid.getState(),
        provider: benchmark.providerSnapshot(),
      },
    };
  });
  report.capacity.failedAtomicity.push({ scope: 'capacity-400-rules-32-queries', ...ruleFailure });
  const leaseFailure = await page.evaluate(async () => {
    const benchmark = window.gridBenchmark;
    const saved = benchmark.grid.getWorkspace();
    const store = benchmark.grid.getTerminal('cell-1').getAlerts();
    const release = benchmark.monitor.attach(store);
    try {
      const before = {
        workspace: benchmark.grid.getWorkspace(),
        state: benchmark.grid.getState(),
        provider: benchmark.providerSnapshot(),
      };
      let error = null;
      try {
        await benchmark.grid.restoreWorkspace(saved);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return {
        kind: 'external-same-scope-lease',
        attempted: saved,
        error,
        before,
        after: {
          workspace: benchmark.grid.getWorkspace(),
          state: benchmark.grid.getState(),
          provider: benchmark.providerSnapshot(),
        },
      };
    } finally {
      release();
    }
  });
  report.capacity.failedAtomicity.push({ scope: 'capacity-400-rules-32-queries', ...leaseFailure });
  report.capacity.leaseObservations.push({
    scope: 'capacity-400-rules-32-queries',
    before: admitted.monitor,
    after: await fixture('resources', 'capacity-after-rejection'),
    externalLeaseAttempt: leaseFailure,
  });
  const cleanup = await fixture('close');
  report.cleanup.borrowedUsabilityObservations.push({ scope: 'capacity', ...cleanup });
  await endpoint('capacity-final');
  report.resources.push(...(await fixture('probeTransientLatest')));
  report.cleanup.ownershipControls = await fixture('ownershipControls');
  report.cleanup.ownershipControlObservations.push({
    scope: 'capacity-400-rules-32-queries',
    ...report.cleanup.ownershipControls,
  });
  await endpoint('capacity-controls-final');
  save();
}

async function closeAll() {
  if (page && !page.isClosed()) {
    try {
      report.providerRequests = await page.evaluate(() => window.gridBenchmark.requestLedger());
    } catch (error) {
      report.failures.push({ kind: 'request-ledger-unavailable', message: String(error) });
    }
    try {
      report.environment.visibility = await page.evaluate(() => window.__gridVisibilityTransitions ?? []);
      if (report.environment.visibility.some((entry) => entry.state !== 'visible'))
        report.failures.push({ kind: 'hidden-tab', transitions: report.environment.visibility });
    } catch (error) {
      report.failures.push({ kind: 'visibility-observation', message: String(error) });
    }
  } else {
    report.failures.push({
      kind: 'request-ledger-unavailable',
      message: 'Browser page unavailable before final request archive',
    });
  }
  try {
    await context?.close();
  } catch (error) {
    report.failures.push({ kind: 'context-close', message: String(error) });
  }
  try {
    await browser?.close();
  } catch (error) {
    report.failures.push({ kind: 'browser-close', message: String(error) });
  }
  try {
    await browserServer?.close();
  } catch (error) {
    report.failures.push({ kind: 'browser-server-close', message: String(error) });
  }
  report.cleanup.browserClosed = Boolean(browserServer);
  if (preview && preview.exitCode === null) {
    preview.kill();
    await new Promise((resolveExit) => {
      if (preview.exitCode !== null) return resolveExit();
      preview.once('exit', resolveExit);
      setTimeout(resolveExit, 5000);
    });
  }
  try {
    await portFree();
    report.cleanup.portClosed = true;
  } catch (error) {
    report.failures.push({ kind: 'port-close', message: String(error) });
  }
  save();
}

async function main() {
  let failure;
  try {
    await startPreview();
    await startBrowser();
    const maximum = mode === 'all' || mode === 'max' || mode === 'soak';
    const full = mode === 'all' || mode === 'full';
    const capacity = mode === 'all' || mode === 'capacity';
    if (maximum) {
      const scene = buildGridScene({ rowsPerCell: 100000, seed: 20260922 });
      const mutation = await maxPhase(scene);
      if (mode === 'all' || mode === 'soak') await soakPhase(scene, mutation);
      const resourceRestore = await fixture('act', {
        id: 'max-resource-equivalent-restore',
        kind: 'restore',
        phase: 'resource-control',
        workspace: scene.gridWorkspace,
        targetRows: 100000,
      });
      report.actions.lifecycle.push({
        kind: 'resource-equivalent-restore',
        receipt: resourceRestore,
        budgeted: false,
      });
      await endpoint('max-mounted-final');
      const cleanup = await fixture('close');
      report.cleanup.borrowedUsabilityObservations.push({ scope: 'maximum', ...cleanup });
      await endpoint('max-empty-final');
      report.resources.push(...(await fixture('probeTransientLatest')));
      report.cleanup.ownershipControls = await fixture('ownershipControls');
      report.cleanup.ownershipControlObservations.push({
        scope: 'maximum-sampled',
        ...report.cleanup.ownershipControls,
      });
      await endpoint('max-controls-final');
    }
    if (full) await fullPhase(buildGridScene({ rowsPerCell: 256, seed: 20260922 }));
    if (capacity) await capacityPhase(buildGridScene({ rowsPerCell: 256, seed: 20260922 }));
    report.cleanup.finalResourceLabel = report.resources.at(-1)?.label ?? null;
    const finalResource = report.resources.at(-1);
    if (finalResource?.sampleKind === 'three-gc-endpoint')
      report.cleanup.ownedZeroCounts = {
        ...finalResource.owned,
        activeSubscriptions: finalResource.provider.activeSubscriptions,
        pendingRequests: finalResource.provider.pendingRequests,
        detachedConsumer: finalResource.domOwned.consumer.detached,
        detachedTerminal: finalResource.domOwned.terminal.detached,
      };
  } catch (error) {
    failure = error;
    report.failures.push({ kind: 'runner', message: error.stack || String(error) });
    attempt('failure', { phase: 'runner', message: error.stack || String(error) });
  } finally {
    await closeAll();
    try {
      const afterSource = sourceIdentity(root);
      const afterInstalled = verifyConsumerIdentity(root, 'v0.11', sourceCommit);
      assert.deepEqual(afterSource, source, 'Source changed during installed grid measurement');
      assert.deepEqual(afterInstalled, installed, 'Installed cohort changed during grid measurement');
      report.identity.verifications.push(verification('after'));
    } catch (error) {
      report.failures.push({ kind: 'identity-after', message: error.stack || String(error) });
      failure ??= error;
    }
    const verdict = validateGridEvidence(report, { mode, expectedIdentity });
    report.validation = verdict;
    report.finishedAt = new Date().toISOString();
    report.status = !failure && verdict.valid && report.failures.length === 0 ? 'pass' : 'fail';
    save(true);
  }
  if (failure) throw failure;
  if (report.status !== 'pass') throw Error('Grid evidence rejected: ' + report.validation.errors.join('; '));
  console.log(JSON.stringify({ output: pathFromRoot(output), status: report.status }));
}

await main();
