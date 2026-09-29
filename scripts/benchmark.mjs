import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { cpus, platform, release, totalmem } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeCandles } from '../apps/showcase/src/fixtures.ts';

const quick = process.argv.includes('--quick');
const headed = !process.argv.includes('--headless');
const requestedReference = !quick && headed;
const measuredRuns = quick ? 2 : 10;
const navigationDurationMs = quick ? 1_000 : 30_000;
const streamDurationMs = quick ? 1_000 : 60_000;
const warmInteractionDurationMs = quick ? 500 : 2_000;
const port = 5_174;
const origin = 'http://127.0.0.1:' + port;
const outputArg = process.argv.find((arg) => arg.startsWith('--output-dir='))?.slice('--output-dir='.length);
if (outputArg && !/^benchmark-results(?:\/[a-z0-9.-]+)+$/.test(outputArg))
  throw new Error('Output directory must be a named subdirectory of benchmark-results');
if (outputArg?.split('/').some((part) => part === '..' || part === '.'))
  throw new Error('Output directory cannot contain traversal');
const resultDirectory = outputArg ?? 'benchmark-results';
const partialFile = resultDirectory + '/' + (requestedReference ? 'reference' : 'smoke') + '.partial.json';
const frozenProfileFile = 'benchmark-results/reference-profile.json';
const runToken = randomUUID();
const serverOutput = [];
let server;
let serverSpawnError;
let browser;
let context;
let result;

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile) => sorted[Math.ceil(sorted.length * percentile) - 1] ?? null;
  return {
    samples: sorted.length,
    median: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1) ?? null,
  };
};

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function observePowerProfile() {
  if (platform() !== 'win32') {
    return {
      available: false,
      activeSchemeGuid: null,
      activeSchemeName: null,
      source: 'powercfg /getactivescheme',
      effectiveOverlay: {
        available: false,
        value: null,
        reason: 'Windows power overlays are not applicable on this host.',
      },
      error: 'Reference performance qualification currently requires Windows.',
    };
  }
  try {
    const raw = execFileSync('powercfg.exe', ['/getactivescheme'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const guid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    const name = raw.match(/\(([^()]*)\)\s*$/)?.[1] ?? null;
    return {
      available: Boolean(guid),
      activeSchemeGuid: guid?.toLowerCase() ?? null,
      activeSchemeName: name,
      source: 'read-only powercfg /getactivescheme',
      effectiveOverlay: {
        available: false,
        value: null,
        reason: 'No documented read-only powercfg command exposes the effective Windows power-mode overlay.',
      },
      raw,
      error: guid ? null : 'The active power scheme GUID could not be parsed.',
    };
  } catch (error) {
    return {
      available: false,
      activeSchemeGuid: null,
      activeSchemeName: null,
      source: 'read-only powercfg /getactivescheme',
      effectiveOverlay: {
        available: false,
        value: null,
        reason: 'No documented read-only powercfg command exposes the effective Windows power-mode overlay.',
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function powerIdentity(power) {
  return {
    activeSchemeGuid: power.activeSchemeGuid,
    activeSchemeName: power.activeSchemeName,
    effectiveOverlay: power.effectiveOverlay.available ? power.effectiveOverlay.value : null,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function waitForOwnedServer() {
  try {
    await fetch(origin + '/benchmark.html', { signal: AbortSignal.timeout(750) });
    throw new Error(
      'Benchmark port ' +
        port +
        ' already responds. Stop the existing service; this runner will not measure an unowned preview server.',
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('already responds')) throw error;
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
    serverSpawnError = error;
    serverOutput.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverSpawnError) throw new Error('Owned Vite preview could not start:\n' + serverOutput.join(''));
    if (server.exitCode !== null)
      throw new Error(
        'Owned Vite preview exited before readiness (code ' +
          server.exitCode +
          '):\n' +
          serverOutput.join(''),
      );
    try {
      const response = await fetch(origin + '/benchmark.html?readiness=' + runToken, {
        cache: 'no-store',
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
      throw new Error('HTTP ' + response.status);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Owned Vite preview did not become ready:\n' + serverOutput.join(''));
}

function savePartial() {
  if (!result) return;
  mkdirSync(resultDirectory, { recursive: true });
  result.updatedAt = new Date().toISOString();
  writeFileSync(partialFile, JSON.stringify(result, null, 2) + '\n');
}

function profileIdentity(metadata) {
  return {
    os: metadata.os,
    cpu: metadata.cpu,
    logicalCpus: metadata.logicalCpus,
    totalMemoryBytes: metadata.totalMemoryBytes,
    browser: metadata.browser,
    userAgent: metadata.userAgent,
    gpu: metadata.gpu,
    viewport: metadata.viewport,
    devicePixelRatio: metadata.devicePixelRatio,
    font: metadata.font,
    power: powerIdentity(metadata.powerBefore),
  };
}

function profileBlockers(metadata) {
  const blockers = [];
  if (!requestedReference) blockers.push('Only the full visible run is a reference candidate.');
  if (platform() !== 'win32') blockers.push('The initial reference profile requires Windows.');
  if (!metadata.powerBefore.available) blockers.push('The active Windows power scheme is unknown.');
  if (!metadata.gpu || metadata.gpu === 'unavailable') blockers.push('GPU identity is unavailable.');
  if (!metadata.cpu) blockers.push('CPU identity is unavailable.');
  if (metadata.viewport.width !== 1_440 || metadata.viewport.height !== 900)
    blockers.push('Viewport is not 1440 x 900 CSS pixels.');
  if (metadata.devicePixelRatio !== 1) blockers.push('Device pixel ratio is not 1.');
  if (metadata.visibility !== 'visible') blockers.push('The initial document was hidden.');
  if (!metadata.focused) blockers.push('The initial document was not focused.');
  if (!metadata.font.loaded || !metadata.font.available)
    blockers.push('The explicit local benchmark font was not loaded and available.');
  return blockers;
}

function inspectConditions(value, path = 'result', failures = []) {
  if (!value || typeof value !== 'object') return failures;
  if ('conditions' in value && value.conditions && typeof value.conditions === 'object') {
    const conditions = value.conditions;
    if ('allVisible' in conditions && !conditions.allVisible)
      failures.push(path + '.conditions observed a hidden document.');
    if ('allFocused' in conditions && !conditions.allFocused)
      failures.push(path + '.conditions observed an unfocused document.');
    if ('visibility' in conditions && conditions.visibility !== 'visible')
      failures.push(path + '.conditions ended hidden.');
    if ('focused' in conditions && !conditions.focused) failures.push(path + '.conditions ended unfocused.');
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'tailVisibleSamples' || key === 'updates' || key === 'work' || key === 'settled') continue;
    if (nested && typeof nested === 'object') inspectConditions(nested, path + '.' + key, failures);
  }
  return failures;
}

function interactionReport(runs, fields) {
  const perRun = runs.map((run, index) => ({
    run: index + 1,
    ...Object.fromEntries(fields.map((field) => [field, stats(run[field])])),
  }));
  const pooled = Object.fromEntries(
    fields.map((field) => {
      const samples = runs.flatMap((run) => run[field]);
      return [field, { samples, summary: stats(samples) }];
    }),
  );
  return { runs, perRun, pooled };
}

async function freshPage(scenario, action) {
  const page = await context.newPage();
  try {
    await page.goto(origin + '/benchmark.html?automated=1&run=' + runToken, {
      waitUntil: 'load',
    });
    await page.waitForFunction(() => Boolean(window.benchmarkApi));
    await page.bringToFront();
    await page.evaluate(() => window.benchmarkApi.prepareEnvironment());
    const before = await page.evaluate(() => window.benchmarkApi.condition());
    const value = await action(page);
    const after = await page.evaluate(() => window.benchmarkApi.condition());
    result.conditionBoundaries.push({ scenario, before, after });
    return value;
  } finally {
    await page.close();
  }
}

async function scenarioRuns(name, warmupAction, measuredAction) {
  console.log('Warm-up: ' + name);
  const warmup = await freshPage(name + ':warmup', warmupAction);
  const runs = [];
  result.progress = { scenario: name, phase: 'measured', warmup, runs };
  savePartial();
  for (let index = 0; index < measuredRuns; index++) {
    console.log(name + ': measured run ' + (index + 1) + '/' + measuredRuns);
    runs.push(await freshPage(name + ':run-' + (index + 1), measuredAction));
    result.progress = { scenario: name, phase: 'measured', warmup, runs };
    savePartial();
  }
  return { warmup, runs };
}

try {
  mkdirSync(resultDirectory, { recursive: true });
  await waitForOwnedServer();
  browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  context = await browser.newContext({
    viewport: { width: 1_440, height: 900 },
    deviceScaleFactor: 1,
  });

  const powerBefore = observePowerProfile();
  const metadataPage = await context.newPage();
  await metadataPage.goto(origin + '/benchmark.html?automated=1&metadata=' + runToken, {
    waitUntil: 'load',
  });
  await metadataPage.waitForFunction(() => Boolean(window.benchmarkApi));
  await metadataPage.bringToFront();
  await metadataPage.evaluate(() => window.benchmarkApi.prepareEnvironment());
  const browserEnvironment = await metadataPage.evaluate(() => window.benchmarkApi.environment());
  await metadataPage.close();

  const metadata = {
    startedAt: new Date().toISOString(),
    requestedMode: requestedReference ? 'reference' : 'smoke',
    headed,
    quick,
    measuredRuns,
    durations: {
      navigationMsPerMeasuredRun: navigationDurationMs,
      streamMsPerMeasuredRun: streamDurationMs,
      streamFrequencyHz: 10,
      interactionWarmupMs: warmInteractionDurationMs,
    },
    warmupPolicy: 'one separate fresh-page warm-up before every measured scenario',
    browser: browser.version(),
    browserChannel: 'installed Google Chrome',
    os: platform() + ' ' + release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    powerBefore,
    operatorConditions: {
      visibleForegroundPageRequired: true,
      noConcurrentCpuOrGpuHeavyJobsRequired: true,
      automaticallyVerifiable: false,
    },
    ...browserEnvironment,
  };
  const initialBlockers = profileBlockers(metadata);
  const identity = profileIdentity(metadata);
  let frozenProfile;
  let profileStatus = 'not-applicable';

  if (requestedReference && initialBlockers.length === 0) {
    if (existsSync(frozenProfileFile)) {
      frozenProfile = JSON.parse(readFileSync(frozenProfileFile, 'utf8'));
      profileStatus = sameJson(frozenProfile.identity, identity) ? 'matched' : 'mismatch';
      if (profileStatus === 'mismatch')
        initialBlockers.push(
          'Current host profile differs from the frozen reference profile; the frozen file was preserved.',
        );
    } else {
      frozenProfile = {
        schemaVersion: 1,
        frozenAt: new Date().toISOString(),
        identity,
        note: 'Frozen before benchmark timings; subsequent mismatches are nonqualifying.',
      };
      writeFileSync(frozenProfileFile, JSON.stringify(frozenProfile, null, 2) + '\n');
      profileStatus = 'created';
    }
  }

  result = {
    schemaVersion: 2,
    status: 'running',
    updatedAt: new Date().toISOString(),
    mode: 'nonqualifying',
    metadata,
    qualification: {
      requestedReference,
      qualifying: false,
      profileStatus,
      frozenProfileFile: requestedReference ? frozenProfileFile : null,
      blockers: initialBlockers,
    },
    fixtures: [1_000, 10_000, 100_000].map((rows) => ({
      rows,
      seed: 73,
      price: 100,
      step: 60_000,
      sha256: createHash('sha256')
        .update(JSON.stringify(makeCandles(rows, { seed: 73, price: 100, step: 60_000 })))
        .digest('hex'),
    })),
    generatorSha256: sha256File('apps/showcase/src/fixtures.ts'),
    chartsBundleSha256: sha256File('packages/charts/dist/index.js'),
    indicatorsBundleSha256: sha256File('packages/indicators/dist/index.js'),
    conditionBoundaries: [],
    progress: null,
    loads: [],
    dense: null,
    matrix: [],
    navigation: null,
    stream: null,
    burst: null,
    practical: null,
    memory: null,
    summary: {},
    budgets: {},
    failures: [],
  };
  savePartial();

  for (const count of [1_000, 10_000, 100_000]) {
    const measured = await scenarioRuns(
      'ordinary-' + count,
      (page) => page.evaluate((rows) => window.benchmarkApi.load(rows), count),
      (page) => page.evaluate((rows) => window.benchmarkApi.load(rows), count),
    );
    const entry = {
      count,
      warmup: measured.warmup,
      runs: measured.runs,
      construction: stats(measured.runs.map((sample) => sample.constructionMs)),
      ingest: stats(measured.runs.map((sample) => sample.ingestMs)),
      settled: stats(measured.runs.map((sample) => sample.settledMs)),
    };
    result.loads.push(entry);
    savePartial();
  }

  const dense = await scenarioRuns(
    'dense-100000',
    (page) => page.evaluate(() => window.benchmarkApi.load(100_000, true)),
    (page) => page.evaluate(() => window.benchmarkApi.load(100_000, true)),
  );
  result.dense = {
    count: 100_000,
    warmup: dense.warmup,
    runs: dense.runs,
    construction: stats(dense.runs.map((sample) => sample.constructionMs)),
    ingest: stats(dense.runs.map((sample) => sample.ingestMs)),
    settled: stats(dense.runs.map((sample) => sample.settledMs)),
  };
  savePartial();

  for (const kind of ['flat', 'negative', 'gaps']) {
    const measured = await scenarioRuns(
      'matrix-' + kind,
      (page) => page.evaluate((matrixKind) => window.benchmarkApi.matrix(matrixKind), kind),
      (page) => page.evaluate((matrixKind) => window.benchmarkApi.matrix(matrixKind), kind),
    );
    result.matrix.push({
      kind,
      count: 1_000,
      warmup: measured.warmup,
      runs: measured.runs,
      construction: stats(measured.runs.map((entry) => entry.sample.constructionMs)),
      ingest: stats(measured.runs.map((entry) => entry.sample.ingestMs)),
      settled: stats(measured.runs.map((entry) => entry.sample.settledMs)),
      acceptance: 'correctness matrix; timings are reported but not gated',
    });
    savePartial();
  }

  const navigation = await scenarioRuns(
    'navigation',
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate((duration) => window.benchmarkApi.navigation(duration), warmInteractionDurationMs);
    },
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate((duration) => window.benchmarkApi.navigation(duration), navigationDurationMs);
    },
  );
  result.navigation = {
    warmup: navigation.warmup,
    ...interactionReport(navigation.runs, ['work', 'settled']),
  };
  savePartial();

  const stream = await scenarioRuns(
    'stream-10hz',
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate((duration) => window.benchmarkApi.stream(duration), warmInteractionDurationMs);
    },
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate((duration) => window.benchmarkApi.stream(duration), streamDurationMs);
    },
  );
  result.stream = {
    warmup: stream.warmup,
    ...interactionReport(stream.runs, ['updates', 'work']),
  };
  savePartial();

  const burst = await scenarioRuns(
    'burst-100-updates',
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate(() => window.benchmarkApi.burst());
    },
    async (page) => {
      await page.evaluate(() => window.benchmarkApi.load(100_000));
      return page.evaluate(() => window.benchmarkApi.burst());
    },
  );
  result.burst = {
    warmup: burst.warmup,
    runs: burst.runs,
    settled: stats(burst.runs.map((run) => run.settledMs)),
  };
  savePartial();

  const practical = await scenarioRuns(
    'practical-candles-volume-ema',
    (page) => page.evaluate(() => window.benchmarkApi.practical()),
    (page) => page.evaluate(() => window.benchmarkApi.practical()),
  );
  result.practical = {
    warmup: practical.warmup,
    runs: practical.runs,
    totalSettled: stats(practical.runs.map((run) => run.totalSettledMs)),
    additionalSceneSettled: stats(practical.runs.map((run) => run.additionalSceneSettledMs)),
    acceptance: 'diagnostic only; not equivalent to the single-candlestick performance gates',
  };
  savePartial();

  result.memory = await freshPage('lifecycle-30-cycles', (page) =>
    page.evaluate(() => window.benchmarkApi.memoryCycles()),
  );
  savePartial();

  const ten = result.loads.find((entry) => entry.count === 10_000);
  const hundred = result.loads.find((entry) => entry.count === 100_000);
  result.summary = {
    navigationWork: result.navigation.pooled.work.summary,
    navigationSettled: result.navigation.pooled.settled.summary,
    streamLatency: result.stream.pooled.updates.summary,
    streamWork: result.stream.pooled.work.summary,
    burstLatency: result.burst.settled,
  };
  result.budgets = {
    ingest10k: ten.ingest.p95 <= 25,
    ingest100k: hundred.ingest.p95 <= 150,
    settled10k: ten.settled.p95 <= 75,
    settled100k: hundred.settled.p95 <= 250,
    navigationWorkP95: result.summary.navigationWork.p95 <= 8,
    navigationWorkP99: result.summary.navigationWork.p99 <= 16,
    streamP95: result.summary.streamLatency.p95 <= 32,
    streamP99: result.summary.streamLatency.p99 <= 50,
    burstP95: result.summary.burstLatency.p95 <= 50,
    streamCorrect: result.stream.runs.every(
      (run) =>
        run.accepted === run.expectedAccepted &&
        run.finalMatches &&
        run.expectedLength === run.actualLength &&
        run.tailVisibleEveryUpdate &&
        run.finalTailCoordinate !== null,
    ),
    burstCorrect: result.burst.runs.every(
      (run) =>
        run.accepted === 100 &&
        run.length === run.expectedLength &&
        run.finalMatches &&
        run.sceneDraws <= 1 &&
        run.pendingFramesAfterDispatch <= 1 &&
        run.finalTailVisible &&
        run.finalTailCoordinate !== null,
    ),
    lifecycle: result.memory.ownedCanvases === 0,
  };
  result.failures = Object.entries(result.budgets)
    .filter(([, passed]) => !passed)
    .map(([budget]) => 'Budget or correctness gate failed: ' + budget);

  metadata.powerAfter = observePowerProfile();
  if (!sameJson(powerIdentity(metadata.powerBefore), powerIdentity(metadata.powerAfter)))
    result.qualification.blockers.push('The observed power profile changed during measurement.');
  result.qualification.blockers.push(...inspectConditions(result));
  for (const boundary of result.conditionBoundaries) {
    if (boundary.before.visibility !== 'visible' || boundary.after.visibility !== 'visible')
      result.qualification.blockers.push(boundary.scenario + ' crossed a hidden document boundary.');
    if (!boundary.before.focused || !boundary.after.focused)
      result.qualification.blockers.push(boundary.scenario + ' crossed an unfocused document boundary.');
  }
  result.qualification.blockers = [...new Set(result.qualification.blockers)];
  result.qualification.qualifying = requestedReference && result.qualification.blockers.length === 0;
  result.mode = result.qualification.qualifying ? 'reference' : quick || !headed ? 'smoke' : 'nonqualifying';
  result.status = 'complete';
  result.progress = null;
  result.completedAt = new Date().toISOString();

  const timestamp = result.completedAt.replace(/[:.]/g, '-');
  const finalFile =
    result.mode === 'reference'
      ? resultDirectory + '/reference.json'
      : result.mode === 'smoke'
        ? resultDirectory + '/smoke.json'
        : resultDirectory + '/nonqualifying-' + timestamp + '.json';
  writeFileSync(finalFile, JSON.stringify(result, null, 2) + '\n');
  savePartial();
  console.log(
    JSON.stringify(
      {
        file: finalFile,
        partialFile,
        mode: result.mode,
        qualification: result.qualification,
        summary: result.summary,
        budgets: result.budgets,
        failures: result.failures,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (result) {
    result.status = 'failed';
    result.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    savePartial();
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) server.kill();
}
