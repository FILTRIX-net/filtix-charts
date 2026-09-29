import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateGridEvidence } from '../../scripts/grid-evidence.mjs';

const IDS = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
const minute = 60_000;
const base = 1_700_000_000_000;
const at = (minuteIndex) => base + minuteIndex * minute;
const queries = [
  { symbol: 'BTCUSDT', interval: '1m' },
  { symbol: 'ETHUSDT', interval: '5m' },
  { symbol: 'SOLUSDT', interval: '1h' },
  { symbol: 'ETHUSDT', interval: '1m' },
];
const rows = [1, 5, 60, 1].map((step, cell) =>
  Array.from({ length: (301 / step) | 0 }, (_, index) => {
    const time = at(index * step);
    const close = 100 + cell * 10 + index;
    return { time, open: close - 1, high: close + 1, low: close - 2, close, volume: index + 1 };
  }),
);
const visible = [
  { from: at(160), to: at(179) },
  { from: at(160), to: at(175) },
  { from: at(120), to: at(240) },
  { from: at(160), to: at(179) },
];

function cursorAction(match) {
  const requestedTime = at(179);
  const resolved = match === 'exact' ? [179, null, null, 179] : [179, null, 180, 179];
  const entries = IDS.map((cellId, index) => {
    const minuteIndex = resolved[index];
    const bar = minuteIndex === null ? null : rows[index].find((item) => item.time === at(minuteIndex));
    assert.ok(minuteIndex === null || bar);
    return {
      cellId,
      query: queries[index],
      time: bar?.time ?? null,
      points: { 'terminal-price': bar ?? null, 'terminal-volume': null },
    };
  });
  const id = `sync-${match}-visible-contract`;
  return {
    id,
    kind: 'cursor',
    dispatchedAt: 10,
    settledAt: 20,
    syncObservation: {
      requested: { kind: 'cursor', match, sourceCellId: 'cell-1', time: requestedTime },
      before: IDS.map((cellId, index) => ({ cellId, query: queries[index], timeRange: visible[index] })),
      after: IDS.map((cellId, index) => ({ cellId, query: queries[index], timeRange: visible[index] })),
      rangeEvents: [],
      afterCrosshair: entries,
      crosshairEvents: entries.map((entry, index) => ({
        cellId: entry.cellId,
        time: entry.time,
        points: structuredClone(entry.points),
        at: 15,
        meta: { cause: 'api', revision: 1, hasOrigin: index !== 0 },
      })),
    },
  };
}

function recordWith(action) {
  return {
    mode: 'max',
    scene: {
      scopes: {
        maximum: {
          cells: IDS.map((id, index) => ({ id, query: queries[index] })),
          sourceRows: IDS.map((cellId, index) => ({ cellId, rows: rows[index] })),
          monitorSources: [],
          alternateSources: [],
          mutations: [],
        },
      },
    },
    checkpoints: [{ id: 'max-interactions', mutationPrefix: 0 }],
    actions: {
      syncExact: action.syncObservation.requested.match === 'exact' ? [action] : [],
      syncNearest: action.syncObservation.requested.match === 'nearest' ? [action] : [],
    },
  };
}

function cursorErrors(action) {
  return validateGridEvidence(recordWith(action)).errors.filter((error) => error.startsWith(`${action.id}/`));
}

test('exact misses retain real all-null series entries and a propagated clear event', () => {
  const action = cursorAction('exact');
  assert.deepEqual(cursorErrors(action), []);

  const nonNull = structuredClone(action);
  nonNull.syncObservation.afterCrosshair[1].points['terminal-price'] = rows[1][35];
  nonNull.syncObservation.crosshairEvents[1].points['terminal-price'] = rows[1][35];
  assert.ok(cursorErrors(nonNull).some((error) => /cleared cursor/.test(error)));

  const missingEvent = structuredClone(action);
  missingEvent.syncObservation.crosshairEvents = missingEvent.syncObservation.crosshairEvents.filter(
    (event) => event.cellId !== 'cell-2',
  );
  assert.ok(cursorErrors(missingEvent).some((error) => /event/.test(error)));

  const wrongOrigin = structuredClone(action);
  wrongOrigin.syncObservation.crosshairEvents[1].meta.hasOrigin = false;
  assert.ok(cursorErrors(wrongOrigin).some((error) => /event|origin/.test(error)));
});

test('nearest loaded result outside the settled viewport clears, while visible peers use own OHLCV', () => {
  const action = cursorAction('nearest');
  assert.deepEqual(cursorErrors(action), []);

  const wrongValue = structuredClone(action);
  wrongValue.syncObservation.afterCrosshair[2].points['terminal-price'].close += 1;
  wrongValue.syncObservation.crosshairEvents[2].points['terminal-price'].close += 1;
  assert.ok(cursorErrors(wrongValue).some((error) => /own OHLCV/.test(error)));
});

const runner = readFileSync(new URL('../../scripts/grid-benchmark.mjs', import.meta.url), 'utf8');
const extract = (from, to) => {
  const start = runner.indexOf(from);
  const end = runner.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runner function ${from} is extractable`);
  return runner.slice(start, end);
};

test('24 sync samples per mode use a recorded common visible window rather than divergent tails', async () => {
  const source = extract(
    'async function syncSamples(scene, mutation, match) {',
    'async function soakPhase(scene, mutation) {',
  );
  const cells = IDS.map((id, index) => ({ id, query: queries[index] }));
  const sourceRows = new Map(
    IDS.map((id, index) => [
      id,
      Array.from({ length: 5000 }, (_, n) => ({ time: at(n * [1, 5, 60, 1][index]) })),
    ]),
  );
  const recorded = [];
  const report = { actions: { lifecycle: [], syncExact: [], syncNearest: [] }, coverage: {} };
  const mutation = { rows: sourceRows, add() {} };
  const syncSamples = new Function(
    'deps',
    `const { fixture, action, report, mutation, ids, nodeEpoch, sleep, save, maxIndices, assert, intervalMs } = deps;
     ${source}; return syncSamples;`,
  )({
    fixture: async (_command, spec) => {
      recorded.push({ channel: 'setup', spec });
      return { ...spec, settledAt: 1 };
    },
    action: async (_category, spec) => {
      recorded.push({ channel: 'sample', spec });
      report.actions.syncNearest.push(spec);
    },
    report,
    mutation,
    ids: IDS,
    nodeEpoch: () => 1000,
    sleep: async () => {},
    save() {},
    maxIndices: () => [],
    assert,
    intervalMs: (interval) => (interval === '1h' ? 60 : Number.parseInt(interval, 10)) * minute,
  });
  await syncSamples({ cells }, mutation, 'nearest');
  const setups = recorded.filter((item) => item.channel === 'setup').map((item) => item.spec);
  const samples = recorded.filter((item) => item.channel === 'sample').map((item) => item.spec);
  assert.equal(samples.length, 24);
  assert.ok(setups.some((item) => item.kind === 'range' && item.phase === 'sync-setup-outside-samples'));
  const intersection = {
    from: Math.max(...[...sourceRows.values()].map((items) => items[0].time)),
    to: Math.min(...[...sourceRows.values()].map((items) => items.at(-1).time)),
  };
  const margin = 60 * minute;
  for (const item of samples) {
    const times = item.kind === 'cursor' ? [item.time] : [item.range.from, item.range.to];
    assert.ok(times.every((time) => time >= intersection.from + margin && time <= intersection.to - margin));
  }
});

test('20 soak active selections remain effective after layout park and restore cycles', async () => {
  const source = extract('async function soakPhase(scene, mutation) {', 'async function fullPhase(scene) {');
  const cells = IDS.map((id, index) => ({ id, query: queries[index] }));
  const monitorSources = queries.map((query, index) => ({
    query,
    rows: [{ time: at(index), close: 100 + index }],
  }));
  const queryKey = (query) => JSON.stringify([query.symbol, query.interval]);
  const mutation = {
    rows: new Map(IDS.map((id, index) => [id, [{ time: at(index), close: 100 + index }]])),
    latestByQuery: new Map(monitorSources.map((item) => [queryKey(item.query), item.rows[0]])),
    ordered: [],
    noteDeliveries() {},
    replace(_checkpoint, id, bar) {
      this.rows.get(id)[0] = bar;
    },
  };
  const report = { actions: { lifecycle: [] }, coverage: { soakCadence: [] }, resources: [] };
  let clock = 0;
  let activeCellId = 'cell-1';
  const fixture = async (command, spec) => {
    if (command === 'resources')
      return { cells: IDS.map(() => ({ rows: 100000, feed: { destroyed: false } })) };
    if (command === 'retire') return { retired: true };
    assert.equal(command, 'act');
    const before = activeCellId;
    if (spec.kind === 'layout' && spec.layout === 1) activeCellId = 'cell-1';
    if (spec.kind === 'active') activeCellId = spec.cellId;
    if (spec.kind === 'restore' || spec.kind === 'construct') activeCellId = spec.workspace.activeCellId;
    return {
      ...spec,
      semanticObservation: {
        before: { state: { activeCellId: before } },
        after: { state: { activeCellId } },
      },
    };
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    gridBenchmark: { grid: { getState: () => ({ activeCellId }), getWorkspace: () => ({ activeCellId }) } },
  };
  try {
    const soakPhase = new Function(
      'deps',
      `const { nodeEpoch, report, ids, active, sleep, nextReplacement, action, fixture,
        assert, endpoint, page, checkpoint, maxIndices, save } = deps;
       ${source}; return soakPhase;`,
    )({
      nodeEpoch: () => (clock += 1000),
      report,
      ids: IDS,
      active() {},
      sleep: async () => {},
      nextReplacement: (bar) => ({ ...bar, close: bar.close + 0.003 }),
      action: async (_category, spec) => ({ ...spec, dispatchedAt: clock, settledAt: clock + 1 }),
      fixture,
      assert,
      endpoint: async () => {},
      page: { evaluate: async (callback) => callback() },
      checkpoint: async () => {},
      maxIndices: () => [],
      save() {},
    });
    await soakPhase({ cells, monitorSources }, mutation);
  } finally {
    globalThis.window = previousWindow;
  }
  const selections = report.actions.lifecycle.filter((item) => item.kind === 'active');
  assert.equal(selections.length, 20);
  assert.ok(
    selections.every(
      (item) =>
        item.semanticObservation.before.state.activeCellId !==
        item.semanticObservation.after.state.activeCellId,
    ),
    'every recorded active change must transition the actual active cell',
  );
});
