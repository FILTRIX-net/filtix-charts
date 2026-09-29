import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const port = 5190;
const origin = `http://127.0.0.1:${port}`;
const runToken = randomUUID();
const outputFile = 'benchmark-results/v0.3/drawings-smoke.json';
const serverOutput = [];
let server;
let browser;

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? null;
}

function stats(values) {
  return {
    samples: values.length,
    median: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: [...values].sort((left, right) => left - right).at(-1) ?? null,
  };
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function assertBuildLinkage() {
  const entry = 'dist/showcase/drawings-benchmark.html';
  const inputs = [
    'packages/charts/dist/index.js',
    'packages/drawings/dist/index.js',
    'apps/showcase/drawings-benchmark.html',
    'apps/showcase/src/drawings-benchmark.ts',
    'apps/showcase/src/fixtures.ts',
  ];
  for (const file of [...inputs, entry]) {
    if (!existsSync(file))
      throw new Error(`Missing built artifact ${file}; run the final build before benchmarking.`);
  }
  const newestInput = Math.max(...inputs.map((file) => statSync(file).mtimeMs));
  if (statSync(entry).mtimeMs < newestInput)
    throw new Error(
      'The showcase benchmark entry predates a package build; rebuild the showcase to prevent stale served assets.',
    );
  return { entry, inputs, entryMtimeMs: statSync(entry).mtimeMs, newestInputMtimeMs: newestInput };
}

async function assertPortAvailable() {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(600) });
    if (response) throw new Error(`Port ${port} already responds; refusing to reuse an unowned preview.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('already responds')) throw error;
  }
}

async function startPreview() {
  await assertPortAvailable();
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Owned preview exited: ${serverOutput.join('')}`);
    try {
      const response = await fetch(`${origin}/drawings-benchmark.html?ready=${runToken}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(600),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned preview did not become ready: ${serverOutput.join('')}`);
}

async function servedBuildIdentity() {
  const entryResponse = await fetch(`${origin}/drawings-benchmark.html?identity=${runToken}`, {
    cache: 'no-store',
  });
  if (!entryResponse.ok)
    throw new Error(`Could not fetch served benchmark entry: HTTP ${entryResponse.status}`);
  const entry = await entryResponse.text();
  const declaredAssets = (entry.match(/<(?:script|link)\b[^>]*>/g) ?? [])
    .filter((tag) => /\bsrc=|\brel=["']modulepreload["']/i.test(tag))
    .map((tag) => tag.match(/(?:src|href)=["']([^"']+)["']/i)?.[1])
    .filter((asset) => typeof asset === 'string');
  if (!declaredAssets.length)
    throw new Error('Served benchmark entry has no script or modulepreload assets.');
  return { entrySha256: sha256Bytes(entry), declaredAssets };
}

function collectExecutedScriptAssets(page) {
  const checks = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    const check = (async () => {
      const servedPath = decodeURIComponent(url.pathname);
      const localFile = `dist/showcase${servedPath}`;
      if (!existsSync(localFile))
        throw new Error(`Executed script is not a local production asset: ${servedPath}`);
      const servedHash = sha256Bytes(Buffer.from(await response.body()));
      const localHash = sha256File(localFile);
      if (servedHash !== localHash)
        throw new Error(`Served script hash differs from local build asset: ${servedPath}`);
      return { path: servedPath, sha256: servedHash };
    })();
    checks.push(
      check.then(
        (asset) => ({ asset }),
        (error) => ({ error }),
      ),
    );
  });
  return async () => {
    const settled = await Promise.all(checks);
    const failed = settled.find((entry) => 'error' in entry);
    if (failed && 'error' in failed) throw failed.error;
    const assets = settled.map((entry) => entry.asset);
    return [...new Map(assets.map((asset) => [asset.path, asset])).values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  };
}
async function stopPreview() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

async function measuredPage(context, durationMs, label) {
  const page = await context.newPage();
  const browserErrors = [];
  const executedScriptAssets = collectExecutedScriptAssets(page);
  page.on('pageerror', (error) => browserErrors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error')
      browserErrors.push({ kind: 'console', message: message.text(), location: message.location() });
  });
  try {
    await page.goto(`${origin}/drawings-benchmark.html?automated=1&run=${runToken}&label=${label}`, {
      waitUntil: 'load',
    });
    await page.waitForFunction(() => Boolean(window.drawingsBenchmarkApi));
    const environment = await page.evaluate(() => window.drawingsBenchmarkApi.environment());
    const prepared = await page.evaluate(() => window.drawingsBenchmarkApi.prepare());
    const navigation = await page.evaluate(
      (duration) => window.drawingsBenchmarkApi.navigate(duration),
      durationMs,
    );
    const disposal = await page.evaluate(() => window.drawingsBenchmarkApi.dispose());
    return {
      environment,
      prepared,
      navigation,
      disposal,
      browserErrors,
      executedScriptAssets: await executedScriptAssets(),
    };
  } finally {
    await page.close();
  }
}

try {
  const linkage = assertBuildLinkage();
  await startPreview();
  const servedAssets = await servedBuildIdentity();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const warmup = await measuredPage(context, 500, 'warmup');
  const runs = [];
  for (let index = 0; index < 10; index++) runs.push(await measuredPage(context, 3_000, `run-${index + 1}`));
  await context.close();

  const work = runs.flatMap((run) => run.navigation.workMs);
  const rawLatency = runs.flatMap((run) => run.navigation.rawLatencyMs);
  const allDisposed = runs.every((run) => run.disposal.canvases === 0);
  const allModels = runs.every(
    (run) =>
      run.navigation.modelCount === 200 &&
      run.prepared.modelCount === 200 &&
      run.prepared.visibleDrawingCount === 200,
  );
  const allVisible = runs.every((run) =>
    run.navigation.samples.every((sample) => sample.visibleDrawingCount === 200),
  );
  const allDraws = runs.every((run) =>
    run.navigation.samples.every((sample) => sample.primitiveDraws >= 1 && sample.sceneDraws >= 1),
  );
  const executedScriptAssets = [
    ...new Map(
      [warmup, ...runs].flatMap((run) => run.executedScriptAssets).map((asset) => [asset.path, asset]),
    ).values(),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const browserErrors = [warmup, ...runs].flatMap((run, index) =>
    run.browserErrors.map((error) => ({ page: index === 0 ? 'warmup' : `run-${index}`, ...error })),
  );
  const finiteNonemptySamples =
    work.length > 0 && rawLatency.length > 0 && [...work, ...rawLatency].every(Number.isFinite);
  const gates = {
    libraryWorkP95AtMost8ms: nearestRank(work, 0.95) <= 8,
    libraryWorkP99AtMost16ms: nearestRank(work, 0.99) <= 16,
    finiteNonemptySamples,
    modelCount200: allModels,
    all200DrawingsVisible: allVisible,
    relevantSceneAndPrimitivePaintObserved: allDraws,
    disposalZeroCanvases: allDisposed,
    noBrowserErrors: browserErrors.length === 0,
  };
  const failures = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => gate);
  const result = {
    schemaVersion: 1,
    status: failures.length ? 'failed-gates' : 'complete',
    mode: 'headless-smoke',
    qualification: 'Headless smoke only. It is not a reference performance result.',
    completedAt: new Date().toISOString(),
    metadata: {
      port,
      viewport: warmup.environment.viewport,
      devicePixelRatio: warmup.environment.devicePixelRatio,
      browser: browser.version(),
      browserChannel: 'installed Google Chrome',
      headless: true,
      userAgent: warmup.environment.userAgent,
      browserHardwareConcurrency: warmup.environment.hardwareConcurrency,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      fixture: {
        candles: 100_000,
        drawings: 200,
        types: warmup.environment.types,
        visibleBars: 1_000,
        corridor: warmup.environment.corridor,
      },
      buildLinkage: linkage,
      servedAssets,
      executedScriptAssets,
      packageBundleSha256: {
        charts: sha256File('packages/charts/dist/index.js'),
        drawings: sha256File('packages/drawings/dist/index.js'),
      },
      timing:
        'workMs is synchronous setVisibleRange duration plus diagnostics.lastRenderMs after whenIdle. rawLatencyMs is reported separately and includes the asynchronous wait.',
    },
    warmup,
    runs,
    browserErrors,
    samples: { workMs: work, rawLatencyMs: rawLatency },
    summary: { workMs: stats(work), rawLatencyMs: stats(rawLatency) },
    gates,
    failures,
  };
  mkdirSync('benchmark-results/v0.3', { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { file: outputFile, status: result.status, summary: result.summary, gates, failures },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await stopPreview();
}
