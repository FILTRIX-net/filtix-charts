import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  assessEndpoint,
  collectEndpointReadiness,
  expectationForEndpoint,
} from '../../scripts/grid-resource-readiness.mjs';

const queries = [
  { symbol: 'BTCUSDT', interval: '1m' },
  { symbol: 'ETHUSDT', interval: '5m' },
  { symbol: 'SOLUSDT', interval: '1h' },
  { symbol: 'ETHUSDT', interval: '1m' },
];
const latest = [
  queries[0],
  { symbol: 'BTCUSDT', interval: '5m' },
  queries[3],
  queries[1],
  { symbol: 'SOLUSDT', interval: '1m' },
  { symbol: 'SOLUSDT', interval: '5m' },
  { symbol: 'BTCUSDT', interval: '1h' },
  { symbol: 'ETHUSDT', interval: '1h' },
];
const scene = {
  cells: queries.map((query, index) => ({ id: `cell-${index + 1}`, query })),
  monitorSources: latest.map((query) => ({ query })),
};
const key = (query) => JSON.stringify([query.symbol, query.interval]);

function snapshot(connected) {
  const physical = [...queries, ...(connected ? latest : [])];
  return {
    at: 1000,
    gridState: { layout: 4 },
    cells: queries.map((query, index) => ({
      cellId: `cell-${index + 1}`,
      query,
      rows: 100000,
      feed: { status: 'live', query },
    })),
    monitor: {
      runtimeEntries: 8,
      activeRuntimeEntries: 8,
      runtimes: latest.map((query) => ({
        query,
        active: true,
        feed: {
          mode: 'latest',
          query,
          status: connected ? 'live' : 'reconnecting',
          activeConnection: connected,
          pendingRequest: false,
          retryTimer: !connected,
          requestTimer: false,
        },
      })),
    },
    provider: {
      providerGeneration: 1,
      activeSubscriptions: physical.length,
      historyFeeds: 4,
      latestFeeds: connected ? 8 : 0,
      pendingRequests: 0,
      subscriptions: physical.map((query, index) => ({
        providerGeneration: 1,
        subscriptionId: index + 1,
        key: key(query),
        query,
        openedAt: 1000,
        releasedAt: null,
      })),
    },
  };
}

async function actualEndpoint(fixture) {
  const source = readFileSync(new URL('../../scripts/grid-benchmark.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function endpoint(label) {');
  const end = source.indexOf('\nasync function checkpoint(', start);
  assert.ok(start >= 0 && end > start, 'actual runner endpoint body must be present');
  let helper = {};
  if (source.includes("from './grid-resource-readiness.mjs'"))
    helper = await import('../../scripts/grid-resource-readiness.mjs');
  const report = { scene: { scopes: { maximum: scene } }, resources: [], cleanup: {}, failures: [] };
  let pageEvaluations = 0;
  const page = {
    evaluate: async () => {
      pageEvaluations++;
      if (pageEvaluations === 1) return {};
      if (pageEvaluations <= 4) return pageEvaluations;
      if (pageEvaluations === 5)
        return { consumer: { detached: 0 }, terminal: { detached: 0 }, totalOwned: { consumer: 0 } };
      return { timers: 0, observers: 0 };
    },
    waitForFunction: async () => {},
  };
  const cdp = {
    send: async (method) =>
      method === 'Memory.getDOMCounters' ? { documents: 1, nodes: 0, jsEventListeners: 0 } : { usedSize: 0 },
  };
  let time = 1000;
  const context = {
    active: () => {},
    fixture,
    page,
    cdp,
    report,
    save: () => {},
    attempt: () => {},
    nodeEpoch: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    ...helper,
  };
  const endpoint = vm.runInNewContext(`${source.slice(start, end)}\nendpoint`, context);
  await endpoint('max-mounted-initial');
  return report.resources[0];
}

test('actual resource endpoint waits past reconnecting latest feeds before accepting 4+8', async () => {
  let reads = 0;
  const result = await actualEndpoint(async (method) => {
    if (method === 'settle') return undefined;
    if (method === 'resources' || method === 'resourceReadiness') return snapshot(++reads > 1);
    throw Error(`unexpected fixture method ${method}`);
  });
  assert.equal(result.provider.historyFeeds, 4);
  assert.equal(result.provider.latestFeeds, 8);
  assert.equal(result.label, 'max-mounted-initial');
  assert.equal(Object.hasOwn(result.dom, 'cdpDetached'), false);
  assert.equal(result.monitor.runtimes.filter((item) => item.feed.activeConnection).length, 8);
});

test('shared queries require two physical subscriptions and exact mounted cell identities', () => {
  const expected = expectationForEndpoint('max-mounted-initial', scene);
  const valid = snapshot(true);
  assert.equal(assessEndpoint(valid, expected).ready, true);
  assert.equal(valid.provider.subscriptions.filter((entry) => entry.key === key(queries[0])).length, 2);
  const missing = structuredClone(valid);
  missing.provider.subscriptions.splice(4, 1);
  missing.provider.activeSubscriptions--;
  missing.provider.latestFeeds--;
  assert.equal(assessEndpoint(missing, expected).ready, false);
  const repeatedCell = structuredClone(valid);
  repeatedCell.cells[1] = structuredClone(repeatedCell.cells[0]);
  assert.equal(assessEndpoint(repeatedCell, expected).ready, false);
  const badGeneration = structuredClone(valid);
  badGeneration.provider.providerGeneration = 0;
  badGeneration.provider.subscriptions.forEach((entry) => {
    entry.providerGeneration = 0;
  });
  assert.equal(assessEndpoint(badGeneration, expected).ready, false);
});

test('same-key same-time subscription replacement during GC forces a fresh complete sample', async () => {
  const before = snapshot(true);
  const replaced = structuredClone(before);
  replaced.provider.subscriptions[0].subscriptionId = 99;
  const full = [before, replaced, before, before];
  let gcCalls = 0;
  let time = 1000;
  const result = await collectEndpointReadiness({
    label: 'max-mounted-initial',
    scene,
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
    readPoll: async () => before,
    readFull: async () => full.shift(),
    collectGc: async () => ({ gcTurns: 3, sequence: ++gcCalls }),
  });
  assert.equal(gcCalls, 2);
  assert.equal(result.readiness.gcAttempts[0].accepted, false);
  assert.equal(result.readiness.gcAttempts[1].accepted, true);
  assert.equal(result.post.provider.subscriptions[0].subscriptionId, 1);
  const duplicate = structuredClone(before);
  duplicate.provider.subscriptions[1].subscriptionId = 1;
  assert.equal(assessEndpoint(duplicate, expectationForEndpoint('max-mounted-initial', scene)).ready, false);
});

test('disconnected monitor times out with actual observations and no accepted GC sample', async () => {
  let time = 1000;
  const reconnecting = snapshot(false);
  await assert.rejects(
    collectEndpointReadiness({
      label: 'max-mounted-initial',
      scene,
      deadlineMs: 250,
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      readPoll: async () => reconnecting,
      readFull: async () => {
        throw Error('must not read a disconnected pre-GC sample');
      },
      collectGc: async () => {
        throw Error('must not run GC for a disconnected endpoint');
      },
    }),
    (error) =>
      error.readiness?.polls.length > 0 &&
      error.readiness.gcAttempts.length === 0 &&
      error.readiness.accepted === false,
  );
});

test('empty cleanup requires final zero physical subscriptions and records post-GC state', async () => {
  const empty = snapshot(true);
  empty.gridState = null;
  empty.monitor = null;
  empty.cells = empty.cells.map((cell) => ({ cellId: cell.cellId, feed: null }));
  empty.provider.subscriptions = [];
  empty.provider.activeSubscriptions = 0;
  empty.provider.historyFeeds = 0;
  empty.provider.latestFeeds = 0;
  const result = await collectEndpointReadiness({
    label: 'max-empty-final',
    scene: null,
    now: () => 1000,
    pause: async () => {},
    readPoll: async () => empty,
    readFull: async () => empty,
    collectGc: async () => ({ gcTurns: 3 }),
  });
  assert.equal(result.post.provider.activeSubscriptions, 0);
  const leaked = structuredClone(empty);
  leaked.provider.subscriptions = [snapshot(true).provider.subscriptions[0]];
  leaked.provider.activeSubscriptions = 1;
  leaked.provider.historyFeeds = 1;
  assert.equal(assessEndpoint(leaked, expectationForEndpoint('max-empty-final')).ready, false);
});

test('readiness brackets the same browser RPCs with Node request and response clocks', async () => {
  let nodeTime = 1000;
  const calls = [];
  const browser = snapshot(true);
  browser.at = 1000.0789;
  const result = await collectEndpointReadiness({
    label: 'max-mounted-initial',
    scene,
    now: () => nodeTime,
    pause: async () => {},
    readPoll: async () => {
      calls.push('poll');
      nodeTime += 1;
      return browser;
    },
    readFull: async (label) => {
      calls.push(label);
      nodeTime += 1;
      return { ...browser, at: browser.at + calls.length };
    },
    collectGc: async () => {
      calls.push('gc');
      nodeTime += 4;
      return { gcTurns: 3 };
    },
  });
  assert.deepEqual(calls, ['poll', 'max-mounted-initial-pre-gc', 'gc', 'max-mounted-initial-post-gc']);
  assert.deepEqual(result.readiness.clockDomains, {
    collector: 'node-performance-epoch-ms',
    snapshots: 'browser-performance-epoch-ms',
  });
  const poll = result.readiness.polls[0];
  const attempt = result.readiness.gcAttempts[0];
  assert.equal(poll.requestStartedAt, 1000);
  assert.equal(poll.responseReceivedAt, 1001);
  assert.equal(attempt.preRequestStartedAt, 1001);
  assert.equal(attempt.preResponseReceivedAt, 1002);
  assert.equal(attempt.postRequestStartedAt, 1006);
  assert.equal(attempt.postResponseReceivedAt, 1007);
  assert.equal(result.readiness.completedAt, 1007);
  assert.equal(result.readiness.accepted, true);
});
