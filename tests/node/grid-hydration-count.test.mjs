import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../examples/react-terminal/src/grid-test.js', import.meta.url),
  'utf8',
);
const start = source.indexOf(
  '      async function hydrate(targetRows, targetLatestQueries = scene.monitorSources.length) {',
);
const end = source.indexOf('      async function runAction(spec) {', start);
assert.ok(start >= 0 && end > start, 'fixture hydration function must be found');
const hydrateSource = source.slice(start, end);

function fixture({ rows = 99999, queryMismatch = false, error = null } = {}) {
  const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
  const query = { venue: 'spot', symbol: 'BTCUSDT', interval: '1m' };
  let dataReads = 0;
  let loadCalls = 0;
  let pauseCalls = 0;
  const terminals = ids.map((id) => {
    const feed = {
      status: 'live',
      bars: rows,
      query: queryMismatch && id === 'cell-4' ? { ...query, interval: '1h' } : query,
      hasMore: rows < 100000,
      loadingMore: false,
      error,
    };
    return {
      getState: () => ({ feed }),
      getWorkspace: () => ({ query }),
      getData: () => {
        dataReads++;
        throw Error('Hydration must not clone all bars for a count');
      },
      loadMore: async () => {
        loadCalls++;
        feed.bars = 100000;
        feed.hasMore = false;
      },
    };
  });
  const grid = { getState: () => ({ error: null }), getTerminal: (id) => terminals[ids.indexOf(id)] };
  const monitor = {
    getState: () => ({ queries: Array.from({ length: 8 }, () => ({ status: 'monitoring' })) }),
  };
  const deps = {
    grid,
    monitor,
    ids,
    scene: { monitorSources: Array.from({ length: 8 }) },
    epoch: () => Date.now(),
    keyOf: (item) => JSON.stringify(item),
    copy: (item) => structuredClone(item),
    pause: async () => {
      pauseCalls++;
      if (queryMismatch) terminals[3].getState().feed.query = query;
    },
    providerSnapshot: () => ({ requests: [] }),
    getPriceAlertMonitorResourceSnapshot: () => ({ queries: 8 }),
  };
  const hydrate = new Function(
    'deps',
    `const { grid, monitor, ids, scene, epoch, keyOf, copy, pause, providerSnapshot, getPriceAlertMonitorResourceSnapshot } = deps; ${hydrateSource}; return hydrate;`,
  )(deps);
  return {
    hydrate,
    get dataReads() {
      return dataReads;
    },
    get loadCalls() {
      return loadCalls;
    },
    get pauseCalls() {
      return pauseCalls;
    },
  };
}

test('hydration counts live public feed snapshots without cloning full data', async () => {
  const context = fixture();
  const result = await context.hydrate(100000);
  assert.equal(context.loadCalls, 4);
  assert.equal(context.dataReads, 0);
  assert.equal(result.rowsPerCell, 100000);
  assert.deepEqual(
    result.cells.map((cell) => cell.rows),
    [100000, 100000, 100000, 100000],
  );
  assert.equal(result.latestQueries, 8);
});

test('hydration still waits for exact query and reports feed errors', async () => {
  const mismatched = fixture({ rows: 100000, queryMismatch: true });
  await mismatched.hydrate(100000);
  assert.ok(mismatched.pauseCalls >= 1, 'a live feed on the wrong query is not ready');
  assert.equal(mismatched.dataReads, 0);
  const failed = fixture({ error: { message: 'history rejected' } });
  await assert.rejects(failed.hydrate(100000), /History hydration: history rejected/);
  assert.equal(failed.dataReads, 0);
});
