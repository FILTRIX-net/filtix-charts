import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve, sep } from 'node:path';

const port = 5191,
  origin = 'http://127.0.0.1:' + port;
const directory = 'benchmark-results/v0.4',
  output = directory + '/analysis-smoke.json';
const token = randomUUID(),
  startedAt = new Date().toISOString();
const entryFile = 'dist/showcase/analysis-benchmark.html';
const inputs = [
  'packages/charts/dist/index.js',
  'packages/analysis/dist/index.js',
  'packages/indicators/dist/index.js',
  'apps/showcase/analysis-benchmark.html',
  'apps/showcase/src/analysis-benchmark.ts',
  'apps/showcase/src/fixtures.ts',
];
const serverOutput = [];
let server, serverError, browser, result;
const hashBytes = (value) => createHash('sha256').update(value).digest('hex');
const hashFile = (file) => hashBytes(readFileSync(file));
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return {
    samples: sorted.length,
    median: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1) ?? null,
  };
};
function writeResult(value) {
  mkdirSync(directory, { recursive: true });
  if (existsSync(output)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(output, directory + '/analysis-smoke.previous-' + stamp + '.json');
  }
  writeFileSync(output, JSON.stringify(value, null, 2) + '\n');
}
function linkage() {
  for (const file of [...inputs, entryFile])
    if (!existsSync(file)) throw new Error('Missing build/input: ' + file);
  const observed = inputs.map((file) => ({ file, sha256: hashFile(file), mtimeMs: statSync(file).mtimeMs }));
  const entry = { file: entryFile, sha256: hashFile(entryFile), mtimeMs: statSync(entryFile).mtimeMs };
  if (observed.some((input) => input.mtimeMs > entry.mtimeMs))
    throw new Error('Stale showcase build; rebuild after package/harness/fixture inputs');
  return { entry, inputs: observed, runnerSha256: hashFile('scripts/analysis-benchmark.mjs') };
}
async function startPreview() {
  try {
    await fetch(origin, { signal: AbortSignal.timeout(700) });
    throw new Error('Refusing unowned preview on port ' + port);
  } catch (error) {
    if (String(error).includes('Refusing unowned')) throw error;
  }
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
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.on('error', (error) => {
    serverError = error;
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (serverError || server.exitCode !== null)
      throw new Error('Owned preview failed: ' + (serverError?.message ?? serverOutput.join('')));
    try {
      const response = await fetch(origin + '/analysis-benchmark.html?ready=' + token, {
        cache: 'no-store',
        signal: AbortSignal.timeout(700),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Owned preview readiness timed out: ' + serverOutput.join(''));
}
async function stopPreview() {
  // A signal-terminated child keeps exitCode=null and sets signalCode.
  // The success path and finally both call this idempotent cleanup.
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  const didExit = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!didExit) throw new Error('Owned preview did not terminate');
}
async function runPage(context, durationMs, label) {
  const page = await context.newPage(),
    errors = [],
    checks = [];
  page.on('pageerror', (error) => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ type: 'console', message: message.text() });
  });
  page.on('requestfailed', (request) =>
    errors.push({ type: 'requestfailed', message: request.url() + ': ' + request.failure()?.errorText }),
  );
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    if (response.status() >= 400)
      errors.push({ type: 'http', message: response.status() + ' ' + url.pathname });
    if (response.request().resourceType() !== 'script') return;
    const check = (async () => {
      const path = decodeURIComponent(url.pathname);
      const root = resolve('dist/showcase'),
        file = resolve(root, '.' + path);
      if (!file.startsWith(root + sep) || !path.startsWith('/assets/') || !existsSync(file))
        throw new Error('Unexpected script path: ' + path);
      const body = Buffer.from(await response.body()),
        sha256 = hashBytes(body);
      if (sha256 !== hashFile(file)) throw new Error('Served/local script mismatch: ' + path);
      return { path, sha256, bytes: body.byteLength };
    })();
    checks.push(
      check.then(
        (asset) => ({ asset }),
        (error) => ({ error }),
      ),
    );
  });
  try {
    const response = await page.goto(origin + '/analysis-benchmark.html?run=' + token + '&page=' + label);
    if (!response?.ok()) throw new Error('Benchmark page failed to load');
    const entrySha256 = hashBytes(Buffer.from(await response.body()));
    if (entrySha256 !== hashFile(entryFile)) throw new Error('Served/local entry mismatch');
    await page.waitForFunction(() => Boolean(window.analysisBenchmarkApi));
    const environment = await page.evaluate(() => window.analysisBenchmarkApi.environment());
    const prepared = await page.evaluate(() => window.analysisBenchmarkApi.prepare());
    const navigation = await page.evaluate((ms) => window.analysisBenchmarkApi.navigate(ms), durationMs);
    const replay = await page.evaluate(() => window.analysisBenchmarkApi.replay());
    const disposal = await page.evaluate(() => window.analysisBenchmarkApi.dispose());
    const settled = await Promise.all(checks),
      failure = settled.find((item) => item.error);
    if (failure) throw failure.error;
    const assets = [...new Map(settled.map((item) => [item.asset.path, item.asset])).values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    return { label, environment, entrySha256, assets, prepared, navigation, replay, disposal, errors };
  } finally {
    await page.close();
  }
}
function pageCorrect(run) {
  const nav = run.navigation;
  return (
    run.prepared.initialized &&
    run.prepared.stable &&
    run.prepared.canvases === 6 &&
    nav.samples.length > 0 &&
    nav.elapsedMs >= nav.requestedDurationMs &&
    nav.stable &&
    nav.samples.every(
      (sample) =>
        sample.aligned &&
        sample.mutations.every((value) => value === 1) &&
        sample.effective.every((value) => value === 1) &&
        sample.sceneDraws.every((value) => value === 1) &&
        Number.isFinite(sample.workMs) &&
        Number.isFinite(sample.rawLatencyMs) &&
        sample.workMs >= 0 &&
        sample.rawLatencyMs >= 0,
    ) &&
    run.replay.empty.correct &&
    run.replay.appended.correct &&
    run.replay.sought.correct &&
    run.replay.pausedPrefix.correct &&
    run.replay.appendMs.length === 1000 &&
    run.replay.appendMs.every((value) => Number.isFinite(value) && value >= 0) &&
    run.replay.appendCallbacks === 1000 &&
    [run.replay.constructorMs, run.replay.resetMs, run.replay.appendCallbackMs, run.replay.playWaitMs].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) &&
    run.replay.playedForward &&
    run.replay.pausedStable &&
    run.replay.destroyedStable &&
    run.replay.destroyed.status === 'destroyed' &&
    run.replay.chartsStable &&
    run.disposal.canvases === 0 &&
    run.errors.length === 0 &&
    run.assets.length > 0
  );
}
try {
  const buildLinkage = linkage();
  await startPreview();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const warmup = await runPage(context, 500, 'warmup'),
    runs = [];
  for (let i = 0; i < 10; i++) {
    console.log('Analysis scene: measured run ' + (i + 1) + '/10');
    runs.push(await runPage(context, 3000, 'run-' + (i + 1)));
  }
  await context.close();
  const work = runs.flatMap((run) => run.navigation.samples.map((sample) => sample.workMs));
  const rawLatency = runs.flatMap((run) => run.navigation.samples.map((sample) => sample.rawLatencyMs));
  const append = runs.flatMap((run) => run.replay.appendMs);
  const summary = {
    navigationWorkMs: stats(work),
    navigationRawLatencyMs: stats(rawLatency),
    replaySynchronousAppendMs: stats(append),
  };
  const perRun = runs.map((run) => ({
    label: run.label,
    work: stats(run.navigation.samples.map((sample) => sample.workMs)),
    rawLatency: stats(run.navigation.samples.map((sample) => sample.rawLatencyMs)),
    append: stats(run.replay.appendMs),
  }));
  const gates = {
    navigationP95AtMost16ms: summary.navigationWorkMs.p95 <= 16,
    navigationP99AtMost24ms: summary.navigationWorkMs.p99 <= 24,
    everyRunWithinNavigationBudgets: perRun.every((run) => run.work.p95 <= 16 && run.work.p99 <= 24),
    exactlyTenMeasuredRuns: runs.length === 10,
    everyMeasuredPageCorrect: runs.every(pageCorrect),
    warmupCorrect: pageCorrect(warmup),
    nonemptyFiniteNavigation:
      work.length > 0 && rawLatency.length === work.length && [...work, ...rawLatency].every(Number.isFinite),
    executedAssetsStable: runs.every(
      (run) =>
        JSON.stringify(run.assets) === JSON.stringify(warmup.assets) &&
        run.entrySha256 === buildLinkage.entry.sha256,
    ),
  };
  const failures = Object.entries(gates)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  result = {
    schemaVersion: 1,
    status: failures.length ? 'failed-gates' : 'complete',
    mode: 'headless-smoke',
    qualification:
      'Short headless built-package workload. Not a qualified reference or competitor comparison.',
    startedAt,
    completedAt: new Date().toISOString(),
    metadata: {
      browser: browser.version(),
      channel: 'installed Chrome',
      headless: true,
      port,
      os: platform() + ' ' + release(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      viewport: { width: 1440, height: 900 },
      dpr: 1,
      font: 'Consolas, monospace',
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
      buildLinkage,
      packages: Object.fromEntries(
        ['charts', 'analysis', 'indicators'].map((name) => [
          name,
          {
            version: JSON.parse(readFileSync('packages/' + name + '/package.json', 'utf8')).version,
            sha256: hashFile('packages/' + name + '/dist/index.js'),
          },
        ]),
      ),
      thresholds: { navigationP95Ms: 16, navigationP99Ms: 24 },
      scene: warmup.environment.scene,
      timing:
        'Navigation work = source semantic setter + instrumented synchronization callbacks (including target mutations exactly once) + one new lastRenderMs per chart. Target mutation times are diagnostic components and are not added again. rAF waits and post-submission oracles are excluded; raw asynchronous latency is separate.',
      replayScope:
        '100k-bar copied history; clear all five series, 1000 synchronous one-bar steps with real candle/EMA/indexed updates, then seek37, paced play/pause and destroy. Append timing includes controller and application callback work, excludes subsequent coalesced rendering; construction/reset timings are reported separately. Correctness snapshots occur outside the append loop.',
    },
    warmup,
    runs,
    perRun,
    samples: { workMs: work, rawLatencyMs: rawLatency, replayAppendMs: append },
    summary,
    gates,
    failures,
  };
  await browser.close();
  browser = undefined;
  await stopPreview();
  result.metadata.cleanup = { browserClosed: true, ownedPreviewExited: true };
  writeResult(result);
  console.log(JSON.stringify({ output, status: result.status, summary, gates, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  writeResult({
    schemaVersion: 1,
    status: 'aborted',
    mode: 'headless-smoke',
    startedAt,
    completedAt: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
    serverOutput,
  });
  throw error;
} finally {
  await browser?.close();
  await stopPreview();
}
