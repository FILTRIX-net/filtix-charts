import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateDrawingEvidence, verifyDrawingCheckpoint } from '../../scripts/drawing-tools-oracle.mjs';

const mix = {
  'trend-line': 30,
  'horizontal-line': 30,
  rectangle: 30,
  measure: 30,
  'fibonacci-retracement': 30,
  'parallel-channel': 25,
  'text-note': 25,
};
const drawing = (type, index) => ({
  id: `${type}-${index}`,
  type,
  paneId: 'price',
  visible: true,
  locked: false,
  points:
    type === 'parallel-channel'
      ? [
          { time: 0, price: 100 },
          { time: 60_000, price: 200 },
          { time: 120_000, price: 150 },
        ]
      : type === 'text-note' || type === 'horizontal-line'
        ? [{ time: 0, price: 100 }]
        : [
            { time: 0, price: 100 },
            { time: 60_000, price: 200 },
          ],
  style: { color: '#ffffff', lineWidth: 1, fillOpacity: 0.1 },
  ...(type === 'fibonacci-retracement' ? { levels: [{ ratio: 0 }] } : {}),
  ...(type === 'text-note' ? { text: 'Note', fontSize: 12 } : {}),
});
const drawings = Object.entries(mix).flatMap(([type, count]) =>
  Array.from({ length: count }, (_, index) => drawing(type, index)),
);
const finite = (n) => Array.from({ length: n }, () => 1);
const rawTiming = (details = {}) => ({
  status: 'accepted',
  synchronousMs: 1,
  settledMs: 1,
  libraryWorkMs: 2,
  renderMs: 1,
  frameSubmitted: true,
  frames: [{ renderMs: 1 }],
  ...(details.scope
    ? { operationWorkUpperBoundMs: 2, components: { processingElapsedMs: 1, finalIdleDrainMs: 0 } }
    : {}),
  ...details,
});
const sourceBar = { time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
const fixtureCallbackRelease = (phase) => ({
  phase,
  status: 'accepted',
  callbackPresent: true,
  beforeHtmlSha256: 'c'.repeat(64),
  afterHtmlSha256: 'c'.repeat(64),
  beforeCounts: {
    requests: 20,
    activeRequests: 0,
    subscriptions: 1,
    deliveries: 0,
    generation: phase === 'baseline' ? 9 : 15,
    gated: true,
    canvases: 3,
  },
  afterCounts: {
    requests: 20,
    activeRequests: 0,
    subscriptions: 1,
    deliveries: 0,
    generation: phase === 'baseline' ? 9 : 15,
    gated: true,
    canvases: 3,
  },
  secondDelivery: null,
});
const stroke = (path) => ({
  method: 'stroke',
  path,
  strokeStyle: '#ffffff',
  lineWidth: 1,
  lineDash: [],
  globalAlpha: 1,
});
const segment = (a, b) =>
  stroke([
    ['moveTo', ...a],
    ['lineTo', ...b],
  ]);
const box = [10, 20, 20, 20];
function callsFor(item) {
  if (item.type === 'trend-line') return [segment([10, 40], [30, 20])];
  if (item.type === 'horizontal-line') return [segment([0, 40], [100, 40])];
  if (item.type === 'rectangle' || item.type === 'measure')
    return [
      { method: 'fillRect', args: box, fillStyle: '#ffffff', globalAlpha: 0.1 },
      { method: 'strokeRect', args: box, strokeStyle: '#ffffff', lineWidth: 1, globalAlpha: 1 },
      ...(item.type === 'measure'
        ? [
            { method: 'fillRect', args: [10, 20, 52, 22], fillStyle: '#000000', globalAlpha: 1 },
            {
              method: 'fillText',
              args: ['100 (100%) · 0.00069444d', 16, 25],
              fillStyle: '#ffffff',
              globalAlpha: 1,
              font: '12px sans-serif',
              textBaseline: 'top',
            },
          ]
        : []),
    ];
  if (item.type === 'fibonacci-retracement')
    return [
      segment([10, 40], [30, 40]),
      {
        method: 'fillText',
        args: ['0% · 100', 4, 27, 92],
        fillStyle: '#ffffff',
        globalAlpha: 1,
        font: '11px sans-serif',
        textBaseline: 'top',
      },
    ];
  if (item.type === 'parallel-channel')
    return [
      {
        method: 'fill',
        path: [['moveTo', 10, 40], ['lineTo', 30, 20], ['lineTo', 40, 10], ['lineTo', 20, 30], ['closePath']],
        fillStyle: '#ffffff',
        globalAlpha: 0.1,
      },
      segment([10, 40], [30, 20]),
      segment([20, 30], [40, 10]),
      segment([10, 40], [20, 30]),
      segment([30, 20], [40, 10]),
    ];
  return [
    { method: 'fillRect', args: [10, 40, 36, 27], fillStyle: '#000000', globalAlpha: 0.1 },
    { method: 'strokeRect', args: [10, 40, 36, 27], strokeStyle: '#ffffff', lineWidth: 1, globalAlpha: 1 },
    {
      method: 'fillText',
      args: ['Note', 16, 46],
      fillStyle: '#ffffff',
      font: '12px sans-serif',
      textBaseline: 'top',
    },
  ];
}
const checkpoint = (id = 'mixed-initial') => ({
  id,
  full: true,
  status: 'accepted',
  market: { symbol: 'BTCUSDT', interval: '1m' },
  document: { schema: 'filtix-drawings', version: 2, timeDomain: 'utc-ms', drawings },
  source: {
    rows: 100_000,
    sha256: 'a'.repeat(64),
    expectedSha256: 'a'.repeat(64),
    bars: [sourceBar],
    expectedBars: [sourceBar],
    provenance: { fixture: 'drawing-tools-v1', firstTime: 0, events: [] },
  },
  observation: {
    canvas: 'annotation',
    groups: drawings.map((item, index) => ({
      sourceId: item.id,
      sourceIndex: index,
      calls: callsFor(item),
    })),
    projection: {
      panes: [{ id: 'price', scale: 'linear', left: 0, top: 0, right: 100, bottom: 100 }],
      theme: { background: '#000000' },
      textMetrics: Object.fromEntries(
        drawings.filter((item) => item.type === 'text-note').map((item) => [item.id, [24]]),
      ),
      measureMetrics: Object.fromEntries(
        drawings
          .filter((item) => item.type === 'measure')
          .map((item) => [item.id, { label: '100 (100%) · 0.00069444d', width: 40 }]),
      ),
      fibonacciMetrics: Object.fromEntries(
        drawings
          .filter((item) => item.type === 'fibonacci-retracement')
          .map((item) => [item.id, [{ label: '0% · 100', width: 30 }]]),
      ),
      priceBasis: {
        price: [
          { price: 100, y: 40 },
          { price: 200, y: 20 },
        ],
      },
      anchors: drawings.flatMap((item) =>
        item.points.map((_, pointIndex) => ({
          sourceId: item.id,
          pointIndex,
          x: [10, 30, 20][pointIndex],
          y: [40, 20, 30][pointIndex],
          loadedIndex: pointIndex,
        })),
      ),
    },
    pixel: {
      pngSha256: 'b'.repeat(64),
      width: 1440,
      height: 900,
      path: `benchmark-results/v0.9/drawing-tools-test/pixels/${id}.png`,
    },
  },
});

function limitCheckpoint() {
  const item = checkpoint('maximum-limits-32-levels-20-lines');
  const fibIndex = item.document.drawings.findIndex((drawing) => drawing.type === 'fibonacci-retracement');
  const noteIndex = item.document.drawings.findIndex((drawing) => drawing.type === 'text-note');
  const levels = Array.from({ length: 32 }, (_, i) => ({ ratio: i / 31 }));
  const fib = { ...item.document.drawings[fibIndex], levels };
  const note = {
    ...item.document.drawings[noteIndex],
    text: Array.from({ length: 20 }, (_, i) => 'Line ' + i).join('\n'),
  };
  item.document.drawings = item.document.drawings.map((drawing, i) =>
    i === fibIndex ? fib : i === noteIndex ? note : drawing,
  );
  item.observation.projection.fibonacciMetrics[fib.id] = levels.map((level) => {
    const price = 100 * (1 - level.ratio) + 200 * level.ratio;
    return {
      label: Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(price.toPrecision(6)),
      width: 30,
    };
  });
  item.observation.groups[fibIndex].calls = levels.flatMap((level, i) => {
    const y = 40 - 20 * level.ratio;
    const label = item.observation.projection.fibonacciMetrics[fib.id][i].label;
    return [
      segment([10, y], [30, y]),
      {
        method: 'fillText',
        args: [label, 4, Math.max(0, Math.min(89, y - 13)), 92],
        fillStyle: '#ffffff',
        globalAlpha: 1,
        font: '11px sans-serif',
        textBaseline: 'top',
      },
    ];
  });
  const lines = note.text.split('\n');
  item.observation.projection.textMetrics[note.id] = lines.map(() => 24);
  item.observation.groups[noteIndex].calls = [
    { method: 'fillRect', args: [10, 40, 36, 312], fillStyle: '#000000', globalAlpha: 0.1 },
    { method: 'strokeRect', args: [10, 40, 36, 312], strokeStyle: '#ffffff', lineWidth: 1, globalAlpha: 1 },
    ...lines.map((line, i) => ({
      method: 'fillText',
      args: [line, 16, 46 + i * 15],
      fillStyle: '#ffffff',
      font: '12px sans-serif',
      textBaseline: 'top',
    })),
  ];
  return item;
}

function actionOutcome(action) {
  const cases = {
    'selection-hide-show': [
      { visible: true, selectedId: null },
      { visible: true, selectedId: 'text-note-0', hidden: true, listed: true },
    ],
    lock: [{ locked: false }, { locked: true }],
    style: [{ color: '#c7ef57' }, { color: '#66b9c7' }],
    level: [{ color: null }, { color: '#e0af68' }],
    text: [{ text: 'Note 0' }, { text: 'Note 4\nSource' }],
    'undo-redo': [{ hashInput: 'before' }, { hashInput: 'before', middleChanged: true }],
    'save-restore': [{ hashInput: 'before' }, { hashInput: 'before' }],
    'market-isolation': [
      { drawings: 200, rows: 100000 },
      { drawings: 200, rows: 100000, isolatedDrawings: 0 },
    ],
    correction: [{ bar: { close: 1 } }, { expected: { close: 2 }, actual: { close: 2 } }],
    resize: [{ width: 1440 }, { width: 1440, duringWidth: 1390 }],
  };
  const [before, after] = cases[action];
  return { action, verified: true, before, after };
}

test('accepts a complete installed cohort with all source-order observations', () => {
  assert.doesNotThrow(() => validateDrawingEvidence(evidence()));
});
const evidence = () => ({
  installation: {
    version: '0.9.0',
    archives: 8,
    members: 35,
    sourceCommit: 'c'.repeat(40),
    identities: [{ path: 'x', sha256: 'd'.repeat(64) }],
  },
  scene: { rows: 100_000, visibleBars: 1000, series: 12, panes: 4, drawingMix: { ...mix } },
  warmup: { scope: 'full-scene', rows: 100000, series: 12, drawings: 200, operationWorkUpperBoundMs: 2 },
  maximumLimits: { levels: 32, lines: 20, checkpointId: 'maximum-limits-32-levels-20-lines' },
  raw: {
    warmup: [rawTiming({ scope: 'full-scene', rows: 100000, series: 12, drawings: 200 })],
    scenes: Array.from({ length: 3 }, () =>
      rawTiming({ scope: 'full-scene', rows: 100000, series: 12, drawings: 200 }),
    ),
    restores: Array.from({ length: 3 }, () =>
      rawTiming({ scope: 'full-workspace-restore', rows: 100000, series: 12, drawings: 200 }),
    ),
    updates: Array.from({ length: 100 }, () => rawTiming()),
    navigation: Array.from({ length: 240 }, () => rawTiming()),
    tail: Array.from({ length: 600 }, (_, i) =>
      rawTiming({
        deliveryPhase: i < 100 ? 'replace' : i < 300 ? 'append-replace' : 'mixed',
        kind: i < 100 || i >= 300 || i % 2 === 1 ? 'replace' : 'append',
        sequence: i < 100 ? i : i < 300 ? i - 100 : i - 300,
        sourceRowsBefore: i < 100 || i >= 300 ? 100000 : 99900 + Math.floor((i + 1 - 100) / 2),
        sourceRowsAfter: i < 100 || i >= 300 ? 100000 : 99900 + Math.floor((i + 2 - 100) / 2),
        browserDeliveredAt: i < 100 ? i * 100 : i < 300 ? (i - 100) * 100 : (i - 300) * 250,
        targetAt: i < 100 ? i * 100 : i < 300 ? (i - 100) * 100 : (i - 300) * 250,
        dispatchedAt: i < 100 ? i * 100 : i < 300 ? (i - 100) * 100 : (i - 300) * 250,
      }),
    ),
    wheel: Array.from({ length: 24 }, () => ({
      status: 'accepted',
      automationInclusiveMs: 1,
      beforeRange: { from: 0, to: 1000 },
      afterRange: { from: 1, to: 1001 },
    })),
  },
  samples: {
    sceneSync: Array.from({ length: 3 }, () => 2),
    sceneSettled: finite(3),
    restoreSync: Array.from({ length: 3 }, () => 2),
    restoreSettled: finite(3),
    updateWork: Array.from({ length: 100 }, () => 2),
    updateSettled: finite(100),
    navigationWork: Array.from({ length: 240 }, () => 2),
    navigationSettled: finite(240),
    tailSync: finite(300),
    tailSettled: finite(300),
    wheelInclusive: finite(24),
  },
  cadence: {
    maximum: [
      {
        phase: 'replace',
        deliveries: 100,
        targetIntervalMs: 100,
        actualAt: finite(100).map((_, i) => i * 100),
        targetAt: finite(100).map((_, i) => i * 100),
        dispatchedAt: finite(100).map((_, i) => i * 100),
      },
      {
        phase: 'append-replace',
        deliveries: 200,
        targetIntervalMs: 100,
        actualAt: finite(200).map((_, i) => i * 100),
        targetAt: finite(200).map((_, i) => i * 100),
        dispatchedAt: finite(200).map((_, i) => i * 100),
      },
    ],
    mixed: {
      elapsedMs: 120_000,
      deliveries: 300,
      targetIntervalMs: 250,
      actualAt: finite(300).map((_, i) => i * 250),
      targetAt: finite(300).map((_, i) => i * 250),
      dispatchedAt: finite(300).map((_, i) => i * 250),
      pauses: [],
    },
  },
  checkpoints: [
    'mixed-initial',
    ...Array.from({ length: 11 }, (_, i) => `mixed-${i + 1}`),
    'mixed-before-workspace-restore',
    'mixed-after-workspace-restore',
    'mixed-final',
    'maximum-limits-32-levels-20-lines',
  ].map((id) => (id === 'maximum-limits-32-levels-20-lines' ? limitCheckpoint() : checkpoint(id))),
  lifecycle: {
    addRemoveCycles: 25,
    remounts: 6,
    actions: [
      'selection-hide-show',
      'lock',
      'style',
      'level',
      'text',
      'undo-redo',
      'save-restore',
      'market-isolation',
      'correction',
      'resize',
    ].map(actionOutcome),
  },
  resources: {
    protocol: 'authored-structural-weakref-v1',
    gcTurns: 3,
    baselineDrawings: 200,
    finalDrawings: 200,
    growth: 0,
    terminalGrowth: 0,
    listenerGrowth: 0,
    retainedHeapDelta: 0,
    outside: 0,
    detached: 0,
    disposed: 0,
    obsoleteImmediateMutations: 0,
    obsoleteDelayedMutations: 0,
    secondDelivery: null,
    fixtureCallbackRelease: {
      baseline: fixtureCallbackRelease('baseline'),
      final: fixtureCallbackRelease('final'),
    },
    baselineState: {
      editorClosed: true,
      selectedId: null,
      market: { symbol: 'BTCUSDT', interval: '1m' },
      rows: 100000,
      series: 12,
      panes: 4,
      range: { from: 99000, to: 100000 },
      document: { schema: 'filtix-drawings', version: 2, drawings },
    },
    finalState: {
      editorClosed: true,
      selectedId: null,
      market: { symbol: 'BTCUSDT', interval: '1m' },
      rows: 100000,
      series: 12,
      panes: 4,
      range: { from: 99000, to: 100000 },
      document: { schema: 'filtix-drawings', version: 2, drawings },
    },
  },
  cleanup: { canvases: 0, subscriptions: 0, requests: 0, browserClosed: true, serverClosed: true },
});

test('rejects a missing source, Canvas or pixel observation at a full checkpoint', () => {
  for (const field of ['source', 'observation', 'market']) {
    const value = checkpoint();
    delete value[field];
    assert.throws(() =>
      validateDrawingEvidence({ ...evidence(), checkpoints: [value, ...evidence().checkpoints] }),
    );
  }
  const value = checkpoint();
  delete value.observation.pixel;
  assert.throws(() =>
    validateDrawingEvidence({ ...evidence(), checkpoints: [value, ...evidence().checkpoints] }),
  );
});
test('rejects wrong installed cohort, drawing count and missing new type', () => {
  const wrong = evidence();
  wrong.installation.version = '0.8.1';
  assert.throws(() => validateDrawingEvidence(wrong));
  for (const members of [32, 34, 36]) {
    const incomplete = evidence();
    incomplete.installation.members = members;
    assert.throws(() => validateDrawingEvidence(incomplete));
  }
  const short = evidence();
  short.checkpoints[0].document.drawings = drawings.slice(1);
  assert.throws(() => validateDrawingEvidence(short));
  const missing = evidence();
  missing.scene.drawingMix['text-note'] = 0;
  assert.throws(() => validateDrawingEvidence(missing));
});
test('rejects nonfinite timing and false cleanup', () => {
  const badTime = evidence();
  badTime.samples.updateWork[0] = NaN;
  assert.throws(() => validateDrawingEvidence(badTime));
  const leak = evidence();
  leak.cleanup.browserClosed = false;
  assert.throws(() => validateDrawingEvidence(leak));
});
test('independent Fibonacci and channel oracle rejects a shifted submitted segment', () => {
  const a = { time: 0, price: 100 },
    b = { time: 60_000, price: 200 },
    c = { time: 120_000, price: 150 };
  const fib = { ...drawing('fibonacci-retracement', 0), points: [a, b], levels: [{ ratio: 0.5 }] };
  const channel = { ...drawing('parallel-channel', 1), points: [a, b, c] };
  const sample = {
    document: { schema: 'filtix-drawings', version: 2, timeDomain: 'utc-ms', drawings: [fib, channel] },
    source: {
      rows: 3,
      sha256: 'a'.repeat(64),
      bars: [{ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    },
    observation: {
      canvas: 'annotation',
      pixel: { pngSha256: 'b'.repeat(64), width: 100, height: 100 },
      projection: {
        panes: [{ id: 'price', scale: 'linear', left: 0, top: 0, right: 100, bottom: 100 }],
        priceBasis: {
          price: [
            { price: 100, y: 40 },
            { price: 200, y: 20 },
          ],
        },
        fibonacciMetrics: { [fib.id]: [{ label: '50% · 150', width: 30 }] },
        anchors: [
          { sourceId: fib.id, pointIndex: 0, x: 10, y: 40 },
          { sourceId: fib.id, pointIndex: 1, x: 30, y: 20 },
          { sourceId: channel.id, pointIndex: 0, x: 10, y: 40 },
          { sourceId: channel.id, pointIndex: 1, x: 30, y: 20 },
          { sourceId: channel.id, pointIndex: 2, x: 20, y: 30 },
        ],
        priceSamples: [{ sourceId: fib.id, ratio: 0.5, price: 150, y: 30 }],
      },
      groups: [
        {
          sourceId: fib.id,
          sourceIndex: 0,
          calls: [
            segment([10, 30], [30, 30]),
            {
              method: 'fillText',
              args: ['50% · 150', 4, 17, 92],
              fillStyle: '#ffffff',
              globalAlpha: 1,
              font: '11px sans-serif',
              textBaseline: 'top',
            },
          ],
        },
        {
          sourceId: channel.id,
          sourceIndex: 1,
          calls: [
            {
              method: 'fill',
              path: [
                ['moveTo', 10, 40],
                ['lineTo', 30, 20],
                ['lineTo', 40, 10],
                ['lineTo', 20, 30],
                ['closePath'],
              ],
              fillStyle: '#ffffff',
              globalAlpha: 0.1,
            },
            segment([10, 40], [30, 20]),
            segment([20, 30], [40, 10]),
            segment([10, 40], [20, 30]),
            segment([30, 20], [40, 10]),
          ],
        },
      ],
    },
  };
  assert.doesNotThrow(() => verifyDrawingCheckpoint(sample, { full: false }));
  sample.observation.groups[1].calls[2].path[1][1] = 41;
  assert.throws(() => verifyDrawingCheckpoint(sample, { full: false }), /channel/i);
});

test('rejects drawing-store-only scene timing and missing raw attempts', () => {
  const value = evidence();
  value.warmup = { scope: 'drawing-store-only' };
  value.raw = { scenes: [], restores: [], updates: [], navigation: [], tail: [], wheel: [] };
  assert.throws(() => validateDrawingEvidence(value));
});

test('rejects absent projected anchors and shifted legacy or note geometry', () => {
  const absent = evidence();
  for (const item of absent.checkpoints) item.observation.projection.anchors = [];
  assert.throws(() => validateDrawingEvidence(absent));
  const legacy = evidence();
  for (const item of legacy.checkpoints)
    for (const group of item.observation.groups.slice(0, 120))
      group.calls = [
        {
          method: 'stroke',
          path: [
            ['moveTo', -9999, -9999],
            ['lineTo', -9998, -9998],
          ],
        },
      ];
  assert.throws(() => validateDrawingEvidence(legacy));
  const note = evidence();
  for (const item of note.checkpoints)
    for (const group of item.observation.groups.slice(175))
      for (const call of group.calls) {
        call.args = [call.args[0], -9999, -9999];
        call.font = '48px serif';
      }
  assert.throws(() => validateDrawingEvidence(note));
});

test('rejects missing channel polygon and first rail, wrong Fibonacci style, and shifted labels', () => {
  const mutate = (id, change) => {
    const item = checkpoint();
    const group = item.observation.groups.find((candidate) => candidate.sourceId === id);
    change(group, item);
    assert.throws(() => verifyDrawingCheckpoint(item), new RegExp(id));
  };
  mutate('parallel-channel-0', (group) => {
    group.calls.shift();
  });
  mutate('parallel-channel-0', (group) => {
    group.calls.splice(1, 1);
  });
  mutate('fibonacci-retracement-0', (group) => {
    group.calls[0].strokeStyle = '#ff0000';
  });
  mutate('fibonacci-retracement-0', (group) => {
    group.calls[1].args[1] += 20;
  });
  mutate('measure-0', (group) => {
    group.calls.at(-1).args[1] += 20;
  });
  mutate('text-note-0', (group) => {
    group.calls[0].fillStyle = '#ffffff';
  });
});

test('rejects expected provider source mismatch', () => {
  const value = evidence();
  for (const item of value.checkpoints) item.source.expectedSha256 = 'f'.repeat(64);
  assert.throws(() => validateDrawingEvidence(value));
});

test('rejects non-equivalent resource endpoints and nonfinite deltas', () => {
  const state = evidence();
  state.resources.baselineState = { editorClosed: true, selectedId: null, range: [0, 1000] };
  state.resources.finalState = { editorClosed: false, selectedId: 'note', range: [1, 1001] };
  assert.throws(() => validateDrawingEvidence(state));
  const finite = evidence();
  for (const key of ['growth', 'terminalGrowth', 'listenerGrowth', 'retainedHeapDelta'])
    finite.resources[key] = -Infinity;
  assert.throws(() => validateDrawingEvidence(finite));
});

test('rejects absent or asymmetric fixture callback release at resource endpoints', () => {
  const absent = evidence();
  delete absent.resources.fixtureCallbackRelease;
  assert.throws(() => validateDrawingEvidence(absent));

  const asymmetric = evidence();
  delete asymmetric.resources.fixtureCallbackRelease.final;
  assert.throws(() => validateDrawingEvidence(asymmetric));

  const wrongPhase = evidence();
  wrongPhase.resources.fixtureCallbackRelease.final.phase = 'baseline';
  assert.throws(() => validateDrawingEvidence(wrongPhase));
});

test('rejects a callback release that mutated the active host or did not drain the saved callback', () => {
  const htmlChanged = evidence();
  htmlChanged.resources.fixtureCallbackRelease.baseline.afterHtmlSha256 = 'd'.repeat(64);
  assert.throws(() => validateDrawingEvidence(htmlChanged));

  const countsChanged = evidence();
  countsChanged.resources.fixtureCallbackRelease.final.afterCounts.subscriptions = 0;
  assert.throws(() => validateDrawingEvidence(countsChanged));

  const callbackMissing = evidence();
  callbackMissing.resources.fixtureCallbackRelease.baseline.callbackPresent = false;
  assert.throws(() => validateDrawingEvidence(callbackMissing));

  const secondNotNull = evidence();
  secondNotNull.resources.fixtureCallbackRelease.final.secondDelivery = { before: {}, after: {} };
  assert.throws(() => validateDrawingEvidence(secondNotNull));
});

test('standalone soak records an actual empty first callback while all and final still reject it', async () => {
  const source = readFileSync(new URL('../../scripts/drawing-tools-benchmark.mjs', import.meta.url), 'utf8');
  const helper = source.slice(
    source.indexOf('async function releaseFixtureCallbackForResourceSample('),
    source.indexOf('function addTiming('),
  );
  const activeHtml = '<div>active terminal</div>';
  const counts = {
    requests: 10,
    activeRequests: 0,
    subscriptions: 1,
    deliveries: 0,
    generation: 1,
    gated: true,
    canvases: 3,
  };
  for (const [mode, phase, accepted] of [
    ['soak', 'baseline', true],
    ['soak', 'final', false],
    ['all', 'baseline', false],
    ['all', 'final', false],
  ]) {
    const report = { resources: {} };
    const hashedInputs = [];
    let calls = 0;
    const context = vm.createContext({
      mode,
      report,
      save() {},
      assert,
      Buffer,
      digest(bytes) {
        hashedInputs.push(Buffer.from(bytes).toString('utf8'));
        return createHash('sha256').update(bytes).digest('hex');
      },
      window: {
        terminalHarness: {
          drawingTools: {
            host: { innerHTML: activeHtml },
            counts: () => ({ ...counts }),
            obsoleteDelivery: () => {
              calls++;
              return null;
            },
          },
        },
      },
      page: { evaluate: async (fn) => fn() },
    });
    vm.runInContext(helper, context);
    const run = () => vm.runInContext(`releaseFixtureCallbackForResourceSample('${phase}')`, context);
    if (accepted) await assert.doesNotReject(run);
    else await assert.rejects(run, /obsolete callback required/);
    const attempt = report.resources.fixtureCallbackRelease[phase];
    assert.equal(attempt.callbackPresent, false);
    assert.equal(attempt.secondDelivery, null);
    assert.equal(attempt.status, accepted ? 'accepted' : 'rejected');
    assert.equal(calls, 2, `${mode}/${phase} must observe a second null delivery`);
    assert.deepEqual(hashedInputs, [activeHtml, activeHtml]);
    assert.deepEqual({ ...attempt.beforeCounts }, counts);
    assert.deepEqual({ ...attempt.afterCounts }, counts);
  }
});

test('rejects missing workload roles, semantic actions and browser delivery timestamps', () => {
  const missing = evidence();
  delete missing.raw;
  delete missing.warmup;
  delete missing.maximumLimits;
  delete missing.lifecycle.actions;
  assert.throws(() => validateDrawingEvidence(missing));
  const names = evidence();
  names.checkpoints.forEach((item) => {
    item.id = 'maximum-only';
  });
  assert.throws(() => validateDrawingEvidence(names));
  const cadence = evidence();
  cadence.cadence.mixed.actualAt = Array(300).fill(NaN);
  assert.throws(() => validateDrawingEvidence(cadence));
});

test('rejects an unretained raster artifact', () => {
  const value = evidence();
  for (const item of value.checkpoints) delete item.observation.pixel.path;
  assert.throws(() => validateDrawingEvidence(value));
});

test('persists the raw candidate before a rejecting oracle and retains its reason', async () => {
  const module = await import('../../scripts/drawing-tools-oracle.mjs');
  assert.equal(typeof module.recordEvidenceAttempt, 'function');
  const candidate = { source: { sha256: 'bad' }, status: 'collecting' };
  const attempts = [candidate];
  const seen = [];
  assert.throws(
    () =>
      module.recordEvidenceAttempt(
        attempts,
        candidate,
        () => {
          assert.equal(attempts[0], candidate);
          throw Error('source mismatch');
        },
        () => seen.push(candidate.status),
      ),
    /source mismatch/,
  );
  assert.deepEqual(seen, ['collected', 'rejected']);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].error, 'source mismatch');
});

test('rejects kickoff-only full-scene work when complete operation exceeds the unchanged ceiling', () => {
  const value = evidence();
  value.raw.scenes[0].operationWorkUpperBoundMs = 1600;
  value.raw.scenes[0].components.processingElapsedMs = 1599;
  value.raw.scenes[0].settledMs = 1599;
  value.samples.sceneSync[0] = 1600;
  value.samples.sceneSettled[0] = 1599;
  assert.throws(() => validateDrawingEvidence(value));
});

test('rejects declared maximum limits absent from the named checkpoint document', () => {
  const value = evidence();
  const index = value.checkpoints.findIndex((item) => item.id === value.maximumLimits.checkpointId);
  value.checkpoints[index] = checkpoint(value.maximumLimits.checkpointId);
  const limit = value.checkpoints[index];
  assert.equal(
    limit.document.drawings.find((item) => item.type === 'fibonacci-retracement').levels.length,
    1,
  );
  assert.throws(() => validateDrawingEvidence(value));
});

test('rejects wrong raw-aligned target grids and absent append delivery roles', () => {
  const schedule = evidence();
  for (const [phase, offset] of [
    [schedule.cadence.maximum[0], 0],
    [schedule.cadence.maximum[1], 100],
    [schedule.cadence.mixed, 300],
  ]) {
    phase.targetAt = phase.targetAt.map((_, i) => i);
    phase.targetAt.forEach((target, i) => {
      schedule.raw.tail[offset + i].targetAt = target;
    });
  }
  assert.throws(() => validateDrawingEvidence(schedule));
  const append = evidence();
  for (const item of append.raw.tail) item.kind = 'replace';
  assert.throws(() => validateDrawingEvidence(append));
});

test('rejects a second maximum phase relabeled as 200 replacements', () => {
  const value = evidence();
  value.cadence.maximum[1].phase = 'replace';
  for (const item of value.raw.tail.slice(100, 300)) {
    item.deliveryPhase = 'replace';
    item.kind = 'replace';
    item.sourceRowsBefore = 100000;
    item.sourceRowsAfter = 100000;
  }
  assert.throws(() => validateDrawingEvidence(value));
});

test('accepts a recorded mixed pause reset and rejects a displaced post-pause target', () => {
  const value = evidence();
  const pause = { kind: 'checkpoint', started: 10000, ended: 10100, afterDelivery: 40, resetTargetAt: 10350 };
  value.cadence.mixed.pauses.push(pause);
  for (let i = 40; i < value.cadence.mixed.deliveries; i++) {
    const target = pause.resetTargetAt + (i - 40) * 250;
    value.cadence.mixed.targetAt[i] = target;
    value.raw.tail[300 + i].targetAt = target;
  }
  assert.doesNotThrow(() => validateDrawingEvidence(value));
  value.cadence.mixed.targetAt[40]++;
  value.raw.tail[340].targetAt++;
  assert.throws(() => validateDrawingEvidence(value));
});

test('rejects ineffective semantic proof, identical wheel ranges, and repeated checkpoint identities', () => {
  const style = evidence();
  const action = style.lifecycle.actions.find((item) => item.action === 'style');
  action.before = { color: '#c7ef57' };
  action.after = { color: '#c7ef57' };
  assert.throws(() => validateDrawingEvidence(style));
  const wheel = evidence();
  for (const item of wheel.raw.wheel) {
    item.beforeRange = { from: 0, to: 1000 };
    item.afterRange = { from: 0, to: 1000 };
  }
  assert.throws(() => validateDrawingEvidence(wheel));
  const duplicate = evidence();
  for (const item of duplicate.checkpoints) if (/^mixed-\d+$/.test(item.id)) item.id = 'mixed-initial';
  assert.throws(() => validateDrawingEvidence(duplicate));
});

test('requires action-specific recorded effects for every semantic role', () => {
  const changes = {
    'selection-hide-show': (a) => {
      a.after.hidden = false;
    },
    lock: (a) => {
      a.after.locked = a.before.locked;
    },
    style: (a) => {
      a.after.color = a.before.color;
    },
    level: (a) => {
      a.after.color = a.before.color;
    },
    text: (a) => {
      a.after.text = a.before.text;
    },
    'undo-redo': (a) => {
      a.after.middleChanged = false;
    },
    'save-restore': (a) => {
      a.after.hashInput = 'different';
    },
    'market-isolation': (a) => {
      a.after.isolatedDrawings = 200;
    },
    correction: (a) => {
      a.after.actual.close = a.before.bar.close;
    },
    resize: (a) => {
      a.after.duringWidth = a.before.width;
    },
  };
  for (const [action, mutate] of Object.entries(changes)) {
    const value = evidence();
    mutate(value.lifecycle.actions.find((item) => item.action === action));
    assert.throws(() => validateDrawingEvidence(value), undefined, action);
  }
});

test('returns partial full-operation timing and stage after measured history setup fails', async () => {
  const source = readFileSync(
    new URL('../../examples/react-terminal/src/drawing-tools-test.js', import.meta.url),
    'utf8',
  );
  const fn = source.slice(
    source.indexOf('async function fullOperation('),
    source.indexOf('function counts()'),
  );
  let tick = 0;
  const chart = {
    applyOptions() {},
    whenIdle: async () => {},
    getDiagnostics: () => ({ sceneDraws: 0, primitiveDraws: 0, overlayDraws: 0, lastRenderMs: 0 }),
  };
  const context = vm.createContext({
    terminal: null,
    bars: { length: 100000 },
    preparedDocument: {},
    generation: 0,
    providerHistoryWork: [],
    performance: { now: () => ++tick * 10, timeOrigin: 0 },
    window: { requestAnimationFrame() {} },
    provider: {},
    query: {},
    studies: [],
    host: {},
    createTerminal: () => ({ chart, getData: () => [], getDrawings: () => ({ list: () => [] }) }),
    ready: async () => {
      throw Error('controlled history failure');
    },
  });
  vm.runInContext(fn, context);
  const result = await vm.runInContext("fullOperation('full-scene')", context);
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureStage, 'initial-history-and-study-rebuild');
  assert.match(result.error, /controlled history failure/);
  assert.ok(result.partial.components.constructorMs > 0 && result.partial.components.optionsMs > 0);
  assert.ok(Array.isArray(result.partial.frames));
  assert.ok(result.partial.elapsedMs > 0);
});

test('returns committed document and both errors when Canvas capture and cleanup fail', async () => {
  const source = readFileSync(
    new URL('../../examples/react-terminal/src/drawing-tools-test.js', import.meta.url),
    'utf8',
  );
  const fn = source.slice(
    source.indexOf('function captureCanvas('),
    source.indexOf('async function checkpoint('),
  );
  function Canvas() {}
  for (const name of [
    'clearRect',
    'save',
    'restore',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'rect',
    'clip',
    'arc',
    'stroke',
    'fill',
    'strokeRect',
    'fillRect',
    'fillText',
    'setLineDash',
  ])
    Canvas.prototype[name] = function () {};
  const target = { dataset: { filtixLayer: 'annotation' } };
  const document = {
    schema: 'filtix-drawings',
    version: 2,
    drawings: [{ id: 'known-committed-object', type: 'trend-line' }],
  };
  const chart = {
    attachPrimitive: () => () => {
      throw Error('controlled cleanup failure');
    },
    whenIdle: async () => {},
  };
  const terminal = {
    chart,
    getDrawings: () => ({ toJSON: () => document, list: () => document.drawings }),
    getData: () => [],
    getState: () => ({ feed: { query: { symbol: 'BTCUSDT', interval: '1m' } } }),
  };
  const context = vm.createContext({
    checkpointBusy: false,
    generation: 1,
    terminal,
    host: { querySelector: () => ({ querySelector: () => target }), querySelectorAll: () => [target] },
    metricSnapshot: () => ({
      document,
      data: [],
      generation: 1,
      market: { symbol: 'BTCUSDT', interval: '1m' },
      counts: {},
    }),
    CanvasRenderingContext2D: Canvas,
    copy: structuredClone,
  });
  vm.runInContext(fn, context);
  const result = await vm.runInContext("captureCanvas('controlled-missing-marker')", context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.document)), document);
  assert.match(result.captureError, /Incomplete annotation paint grouping/);
  assert.match(result.cleanupError, /controlled cleanup failure/);
  assert.equal(result.partial.beforeContext.document.drawings[0].id, 'known-committed-object');
  assert.equal(result.partial.afterContext.document.drawings[0].id, 'known-committed-object');
  assert.equal(context.checkpointBusy, false);
  const missing = vm.createContext({
    checkpointBusy: false,
    generation: 1,
    terminal,
    host: { querySelector: () => null, querySelectorAll: () => [] },
    CanvasRenderingContext2D: Canvas,
  });
  vm.runInContext(fn, missing);
  const missingResult = await vm.runInContext("captureCanvas('missing-target')", missing);
  assert.deepEqual(JSON.parse(JSON.stringify(missingResult.document)), document);
  assert.equal(missingResult.partial.beforeContext.sourceRows, 0);
});
