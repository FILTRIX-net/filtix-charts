import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { buildGridScene } from '../../scripts/grid-oracle.mjs';

test('benchmark fixture provider hydrates and publishes replacement and append through real FeedSession', async () => {
  const fixture = readFileSync(
    new URL('../../examples/react-terminal/src/grid-test.js', import.meta.url),
    'utf8',
  );
  const runner = readFileSync(new URL('../../scripts/grid-benchmark.mjs', import.meta.url), 'utf8');
  const generationStart = runner.indexOf('const intervalMs = (interval) => {');
  const generationEnd = runner.indexOf(
    'async function prepareScope(scene, label, preserveEvents = false) {',
    generationStart,
  );
  assert.ok(
    generationStart >= 0 && generationEnd > generationStart,
    'runner bar generators must be extractable',
  );
  const { nextReplacement, nextAppend } = new Function(
    'assert',
    `${runner.slice(generationStart, generationEnd)} return { nextReplacement, nextAppend };`,
  )(assert);
  const start = fixture.indexOf('function buildProvider(input) {');
  const end = fixture.indexOf('function chartEntries() {', start);
  const helperStart = fixture.indexOf('function providerBar(bar) {');
  assert.ok(start >= 0 && end > start, 'fixture provider functions must be extractable');
  const helper = helperStart >= 0 && helperStart < start ? fixture.slice(helperStart, start) : '';
  const makeFixtureProvider = new Function(
    'input',
    'epoch',
    `const copy = structuredClone;
     const keyOf = (query) => JSON.stringify([query.symbol, query.interval]);
     let heldLatest = null;
     let providerGeneration = 0;
     let requestSerial = 0;
     let subscriptionSerial = 0;
     let sourceRows = new Map();
     let sourceIndices = new Map();
     const streams = new Map();
     const providerLedger = { requests: [], subscriptions: [], deliveries: [], pendingRequests: 0, historyPages: 0, latestPages: 0 };
     ${helper}
     ${fixture.slice(start, end)}
     const provider = buildProvider(input);
     return {
       provider,
       deliver,
       providerLedger,
       streams,
       rebuild: buildProvider,
       currentSources: () => sourceRows,
       currentGeneration: () => providerGeneration,
     };`,
  );
  const scene = buildGridScene({ rowsPerCell: 256 });
  const query = scene.cells[0].query;
  const { provider, deliver, providerLedger, streams, rebuild, currentSources, currentGeneration } =
    makeFixtureProvider(scene, () => Date.now());
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.ts') && url.includes('/packages/'))
        return {
          format: 'module',
          source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
            mode: 'transform',
            sourceUrl: url,
          }),
          shortCircuit: true,
        };
      return nextLoad(url, context);
    },
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@filtrix.net/')) {
        const [name, subpath] = specifier.slice('@filtrix.net/'.length).split('/');
        return nextResolve(
          new URL(`../../packages/${name}/src/${subpath ?? 'index'}.ts`, import.meta.url).href,
          context,
        );
      }
      if (specifier.startsWith('.') && context.parentURL?.includes('/packages/')) {
        const candidate = new URL(specifier + '.ts', context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  let createFeedSession;
  try {
    ({ createFeedSession } = await import('../../packages/datafeed/src/session.ts'));
  } finally {
    hooks.deregister();
  }
  const changes = [];
  const session = createFeedSession({
    provider,
    onChange: (change) => changes.push(change),
    mode: 'history',
    initialLimit: 256,
    pageSize: 256,
    maxBars: 1000,
    staleAfterMs: 120000,
  });
  try {
    await session.load(query);
    assert.equal(session.getState().status, 'live', JSON.stringify(session.getState()));
    assert.equal(session.getData().length, 256);
    assert.equal(providerLedger.historyPages, 1);
    assert.equal(session.getData().at(-1).revision, undefined);

    const last = session.getData().at(-1);
    const replacement = nextReplacement(last, 1);
    assert.equal(replacement.revision, undefined);
    deliver(query, replacement, 'focused-replacement');
    assert.deepEqual(providerLedger.deliveries.at(-1).bar, replacement);
    assert.equal(session.getData().length, 256);
    assert.equal(session.getData().at(-1).close, replacement.close);
    assert.equal(session.getData().at(-1).revision, undefined);

    const append = nextAppend(replacement, query, 1);
    assert.equal(append.revision, undefined);
    deliver(query, append, 'focused-append');
    assert.deepEqual(providerLedger.deliveries.at(-1).bar, append);
    assert.equal(session.getData().length, 257);
    assert.equal(session.getData().at(-1).time, append.time);
    assert.equal(session.getData().at(-1).close, append.close);
    assert.equal(session.getData().at(-1).revision, undefined);
    assert.equal(changes.filter((change) => change.type === 'reset').at(-1).bars.length, 256);
    assert.deepEqual(
      changes.filter((change) => change.type === 'update').map((change) => change.bar.time),
      [last.time, append.time],
    );
    assert.deepEqual(
      changes.filter((change) => change.type === 'update').map((change) => change.bar),
      [replacement, append],
    );
  } finally {
    session.destroy();
  }

  const monitor = scene.monitorSources.at(-1);
  const monitorKey = JSON.stringify([monitor.query.symbol, monitor.query.interval]);
  const latest = createFeedSession({
    provider,
    onChange() {},
    mode: 'latest',
    staleAfterMs: 120000,
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
  });
  try {
    await latest.load(monitor.query);
    assert.equal(latest.getState().status, 'live');
    assert.equal(latest.getData().length, 1);
    assert.equal(latest.getData()[0].revision, undefined);
    const first = latest.getData()[0];
    const next = {
      ...first,
      time: first.time + 3_600_000,
      open: first.close,
      close: first.close + 0.02,
      high: first.close + 0.12,
      low: first.close - 0.1,
    };
    deliver(monitor.query, next, 'transient-initial-delivery');
    assert.equal(latest.getData()[0].time, next.time);
    for (const handler of [...(streams.get(monitorKey) ?? [])]) handler.onClose();
    const deadline = Date.now() + 2000;
    while (latest.getState().status !== 'live' || providerLedger.latestPages < 2) {
      assert.ok(Date.now() < deadline, `latest reconnect failed: ${JSON.stringify(latest.getState())}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(latest.getData()[0].time, next.time);
    const afterReconnect = {
      ...next,
      time: next.time + 3_600_000,
      open: next.close,
      close: next.close + 0.03,
      high: next.close + 0.13,
      low: next.close - 0.1,
    };
    deliver(monitor.query, afterReconnect, 'transient-reconnect-delivery');
    assert.equal(latest.getData()[0].time, afterReconnect.time);
    assert.equal(latest.getData()[0].revision, undefined);
  } finally {
    latest.destroy();
  }

  const sourceKey = JSON.stringify([query.symbol, query.interval]);
  assert.equal(currentSources().get(sourceKey).length, 257);
  const oldGeneration = currentGeneration();
  const rebuiltProvider = rebuild(scene);
  assert.ok(currentGeneration() > oldGeneration);
  assert.equal(currentSources().get(sourceKey).length, 256);
  assert.deepEqual(currentSources().get(sourceKey).at(-1), scene.cells[0].rows.at(-1));
  const rebuilt = createFeedSession({
    provider: rebuiltProvider,
    onChange() {},
    mode: 'history',
    initialLimit: 256,
    pageSize: 256,
    maxBars: 1000,
    staleAfterMs: 120000,
  });
  try {
    await rebuilt.load(query);
    assert.equal(rebuilt.getState().status, 'live');
    assert.equal(rebuilt.getData().length, 256);
    assert.deepEqual(rebuilt.getData().at(-1), scene.cells[0].rows.at(-1));
  } finally {
    rebuilt.destroy();
  }
});
