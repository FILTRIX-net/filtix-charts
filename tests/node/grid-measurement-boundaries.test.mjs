import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fixtureSource = readFileSync(
  new URL('../../examples/react-terminal/src/grid-test.js', import.meta.url),
  'utf8',
);
const evidenceSource = readFileSync(new URL('../../scripts/grid-evidence.mjs', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../../scripts/grid-benchmark.mjs', import.meta.url), 'utf8');
const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
const slice = (source, first, last) =>
  source.slice(source.indexOf(first), source.indexOf(last, source.indexOf(first)));
const cohort = () =>
  ids.map((cellId) => ({ cellId, chartGeneration: 5, query: { symbol: cellId, interval: '1m' } }));
const frame = (id, cellId, at) => ({
  receiptId: id,
  chartGeneration: 5,
  at,
  callbackMs: 1,
  affectedCharts: [
    {
      cellId,
      chartGeneration: 5,
      before: { sceneDraws: 0, overlayDraws: 0, primitiveDraws: 0 },
      after: { sceneDraws: 0, overlayDraws: 1, primitiveDraws: 1 },
    },
  ],
});

function externalHarness({ initialPaint = false } = {}) {
  let time = 100;
  const settlements = [],
    listeners = new Map(),
    ranges = new Map(ids.map((id) => [id, { from: 0, to: 100 }]));
  const roots = new Map(
    ids.map((id) => [
      id,
      {
        addEventListener(type, callback, capture = false) {
          listeners.set(`${id}:${type}:${capture}`, callback);
        },
        removeEventListener(type, callback, capture = false) {
          assert.equal(listeners.get(`${id}:${type}:${capture}`), callback);
          listeners.delete(`${id}:${type}:${capture}`);
        },
      },
    ]),
  );
  const terminals = new Map(
    ids.map((id) => [
      id,
      {
        chart: { getVisibleRange: () => structuredClone(ranges.get(id)) },
        getWorkspace: () => ({ query: { symbol: id, interval: '1m' } }),
      },
    ]),
  );
  const body = slice(fixtureSource, 'async function beginExternal(spec)', 'async function prepare(input)');
  const api = new Function(
    'deps',
    `
    const {ids, epoch, grid, host, providerSnapshot, chartEntries, copy, settlements} = deps;
    let currentAction = null; const generation = 5;
    async function settle(affected = ids) {
      settlements.push([...affected]);
      if (deps.initialPaint) {
        currentAction?.frames.push(deps.frame('queued-before-preparation', 'cell-1', epoch()));
        deps.initialPaint = false;
      }
      deps.tick();
    }
    ${body}
    return {beginExternal, finishExternal, paint(value) { currentAction.frames.push(value); }};
  `,
  )({
    ids,
    initialPaint,
    frame,
    epoch: () => time++,
    tick: () => time++,
    settlements,
    grid: { getTerminal: (id) => terminals.get(id) },
    host: { querySelector: (selector) => roots.get(ids.find((id) => selector.includes(id))) },
    providerSnapshot: () => ({}),
    copy: structuredClone,
    chartEntries: () => ids.map((cellId) => ({ cellId, generation: 5, terminal: terminals.get(cellId) })),
  });
  return {
    ...api,
    settlements,
    listeners,
    time: () => time,
    wheel(id) {
      listeners.get(`${id}:wheel:true`)();
      time += 2;
      ranges.set(id, { from: 2, to: 102 });
      listeners.get(`${id}:wheel:false`)();
    },
  };
}

function validate(action, wheel = true) {
  const first = evidenceSource.includes('function actionTargetCell(')
    ? 'function actionTargetCell('
    : 'function validateActionReceipt(';
  const body = slice(evidenceSource, first, 'function validateActions(');
  const run = new Function(
    'deps',
    `const {expect,finite,nonnegative,CELL_IDS,same,monitorOnlyDelivery,queryKey}=deps; ${body}; return validateActionReceipt;`,
  )({
    expect: (pass, errors, message) => {
      if (!pass) errors.push(message);
    },
    finite: Number.isFinite,
    nonnegative: (v) => Number.isFinite(v) && v >= 0,
    CELL_IDS: ids,
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    monitorOnlyDelivery: () => false,
    queryKey: (q) => `${q.symbol}|${q.interval}`,
  });
  const errors = [];
  run(action, errors, wheel ? 'wheel' : 'interaction', new Set(), { wheel });
  return errors;
}

function wheelReceipt() {
  return {
    id: 'wheel-cell-2',
    kind: 'wheel',
    requested: { cellId: 'cell-2' },
    targetCellId: 'cell-2',
    affectedCellIds: ids,
    chartGeneration: 5,
    chartCohortBefore: cohort(),
    chartCohortAfter: cohort(),
    wallClock: { dispatchedAt: 1000, returnedAt: 1002, settledAt: 1010 },
    dispatchedAt: 100,
    returnedAt: 102,
    settledAt: 110,
    synchronousMs: 2,
    settledMs: 10,
    renderWorkMs: 1,
    libraryWorkMs: 3,
    frames: [frame('wheel', 'cell-2', 104)],
    armedAt: 99,
    pointerPreparation: {
      startedAt: 80,
      initialSettledAt: 85,
      pointerSetupCompletedAt: 90,
      settledAt: 98,
      frames: [frame('hover', 'cell-1', 92)],
      renderWorkMs: 1,
      chartGeneration: 5,
      chartCohortBefore: cohort(),
      chartCohortAfter: cohort(),
    },
    automationStarted: 79,
    automationCompleted: 111,
    automationInclusiveMs: 32,
    effectiveObservation: { beforeRange: { from: 0, to: 100 }, afterRange: { from: 2, to: 102 } },
  };
}

test('native pan keeps the exact target and settles collateral focus work on the current cohort', async () => {
  let clock = 100,
    range = { from: 0, to: 100 };
  const settlements = [];
  const body = slice(
    fixtureSource,
    'async function runActionCore(spec)',
    'async function beginExternal(spec)',
  );
  const run = new Function(
    'deps',
    `
    const {ids,epoch,providerSnapshot,copy,settlements,frame}=deps;
    let currentAction=null,lastFailedAction=null; const generation=5;
    const chartEntries=()=>ids.map(cellId=>({cellId,generation,terminal:{getWorkspace:()=>({query:{symbol:cellId,interval:'1m'}})}}));
    const grid={getTerminal:()=>({chart:{getVisibleRange:deps.getRange}})};
    const host={querySelector:()=>({getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),dispatchEvent(event){if(event.type==='pointerdown')deps.blur();if(event.type==='pointerup')deps.pan();}})};
    const PointerEvent=class {constructor(type,init){Object.assign(this,init,{type});}};
    async function settle(affected=ids){settlements.push([...affected]);if(currentAction){for(const id of deps.pending.splice(0))if(affected.includes(id))currentAction.frames.push(frame('focus:'+id,id,epoch()));}epoch();}
    ${body}
    return runActionCore;
  `,
  )({
    ids,
    epoch: () => clock++,
    providerSnapshot: () => ({}),
    copy: structuredClone,
    settlements,
    frame,
    pending: [],
    getRange: () => ({ ...range }),
    blur() {
      this.pending.push('cell-1');
    },
    pan() {
      this.pending.push('cell-2');
      range = { from: 2, to: 102 };
    },
  });
  const result = await run({
    id: 'pan-cell-2',
    kind: 'gesture',
    gesture: 'pan',
    phase: 'maximum-interaction',
    cellId: 'cell-2',
    affectedCellIds: ids,
  });
  assert.equal(result.targetCellId, 'cell-2');
  assert.deepEqual(
    result.frames.flatMap((f) => f.affectedCharts.map((c) => c.cellId)),
    ['cell-1', 'cell-2'],
  );
  assert.deepEqual(settlements, [ids, ids]);
  assert.deepEqual(validate(result, false), []);
});

test('real wheel preparation retains collateral hover RAF separately and settles all current charts', async () => {
  const h = externalHarness({ initialPaint: true });
  await h.beginExternal({ id: 'wheel-1', kind: 'wheel', cellId: 'cell-2', targetAt: 90 });
  h.paint(frame('hover', 'cell-1', h.time()));
  await h.beginExternal({ id: 'wheel-1', stage: 'arm' });
  h.wheel('cell-2');
  h.paint(frame('wheel', 'cell-2', h.time()));
  const result = await h.finishExternal({ startedAt: 90, completedAt: 150 });
  assert.deepEqual(
    result.pointerPreparation.frames.map((f) => f.receiptId),
    ['queued-before-preparation', 'hover'],
  );
  assert.deepEqual(
    result.frames.map((f) => f.receiptId),
    ['wheel'],
  );
  assert.deepEqual(result.affectedCellIds, ids);
  assert.equal(result.targetCellId, 'cell-2');
  assert.ok(h.settlements.every((entries) => JSON.stringify(entries) === JSON.stringify(ids)));
  assert.equal(h.listeners.size, 0);
  assert.deepEqual(validate(result), []);
});

test('wheel requires raw preparation chronology and honest operation target', () => {
  assert.deepEqual(validate(wheelReceipt()), []);
  const missing = wheelReceipt();
  delete missing.pointerPreparation;
  assert.ok(validate(missing).some((e) => /preparation/.test(e)));
  const mismatch = wheelReceipt();
  mismatch.targetCellId = 'cell-3';
  assert.ok(validate(mismatch).some((e) => /target/.test(e)));
  const late = wheelReceipt();
  late.pointerPreparation.frames[0].at = 101;
  assert.ok(validate(late).some((e) => /preparation.*interval/.test(e)));
});

test('wheel current-generation and actual dispatch interval remain strict', () => {
  const stale = wheelReceipt();
  stale.frames[0].chartGeneration = 4;
  assert.ok(validate(stale).some((e) => /generation/.test(e)));
  const early = wheelReceipt();
  early.frames[0].at = 99;
  assert.ok(validate(early).some((e) => /interval/.test(e)));
  const stalePreparation = wheelReceipt();
  stalePreparation.pointerPreparation.frames[0].affectedCharts[0].chartGeneration = 4;
  assert.ok(validate(stalePreparation).some((e) => /preparation stale/.test(e)));
  const duplicate = wheelReceipt();
  duplicate.pointerPreparation.frames[0].receiptId = 'wheel';
  assert.ok(validate(duplicate).some((e) => /duplicate/.test(e)));
  const omittedWork = wheelReceipt();
  omittedWork.pointerPreparation.renderWorkMs = 0;
  assert.ok(validate(omittedWork).some((e) => /preparation render-work/.test(e)));
});

test('automation selector initialization runs before first resource baseline and keeps native counts', async () => {
  const first = runnerSource.indexOf('async function warmAutomation(');
  assert.ok(first >= 0, 'real selector warmup must be explicit');
  const body = slice(runnerSource, 'async function warmAutomation(', 'async function fixture(');
  const calls = [],
    report = { environment: {} };
  const warm = new Function('page', 'report', 'nodeEpoch', `${body}; return warmAutomation;`)(
    {
      locator: (selector) => ({
        boundingBox: async () => {
          calls.push(selector);
          return null;
        },
      }),
    },
    report,
    () => 10,
  );
  await warm();
  assert.deepEqual(calls, ['body']);
  assert.equal(report.environment.automationPreparation.boundingBox, null);
  const start = slice(runnerSource, 'async function startBrowser(', 'async function warmAutomation(');
  assert.ok(start.includes('await warmAutomation()'));
});

test('warming a native listener baseline still rejects one genuinely retained listener', async () => {
  const { validateGridEvidence } = await import('../../scripts/grid-evidence.mjs');
  const endpoint = (label, listeners) => ({
    label,
    sampleKind: 'three-gc-endpoint',
    gcTurns: 3,
    at: 1,
    heapUsedBytes: 1,
    listeners,
    timers: 0,
    observers: 0,
    resourceTracker: { timers: 0, observers: 0 },
    gridState: null,
    cells: [],
    provider: { activeSubscriptions: 0, pendingRequests: 0, subscriptions: [] },
    dom: { nodes: 26, detached: 0, disposed: 0 },
    domOwned: { consumer: { detached: 0 }, terminal: { detached: 0 }, totalOwned: { consumer: 0 } },
    owned: { feeds: 0, listeners: 0, timers: 0, observers: 0, dom: 0 },
  });
  const record = {
    mode: 'capacity',
    resources: [endpoint('capacity-empty-baseline', 30), endpoint('capacity-final', 31)],
    cleanup: {
      finalResourceLabel: 'capacity-final',
      ownedZeroCounts: { feeds: 0, listeners: 0, timers: 0, observers: 0, dom: 0 },
    },
    failures: [],
  };
  const result = validateGridEvidence(record);
  assert.ok(
    result.errors.some((e) => /selected final raw listeners leak/.test(e)),
    result.errors.join('\n'),
  );
});

test('resource provenance requires actual selector warmup before the first empty baseline', async () => {
  const { validateGridEvidence } = await import('../../scripts/grid-evidence.mjs');
  const record = {
    mode: 'capacity',
    resources: [
      {
        label: 'capacity-empty-baseline',
        sampleKind: 'three-gc-endpoint',
        at: 1,
        readiness: { startedAt: 20 },
      },
    ],
    environment: {
      automationPreparation: {
        kind: 'selector-geometry',
        selector: 'body',
        startedAt: 1,
        completedAt: 2,
        boundingBox: null,
      },
    },
  };
  const prepErrors = () =>
    validateGridEvidence(record).errors.filter((e) => /automation preparation/.test(e));
  assert.deepEqual(prepErrors(), []);
  record.environment.automationPreparation.completedAt = 21;
  assert.equal(prepErrors().length, 1);
  delete record.environment.automationPreparation;
  assert.equal(prepErrors().length, 1);
});
