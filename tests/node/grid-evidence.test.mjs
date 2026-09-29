import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildGridScene,
  expectedCheckpoint,
  fillSeriesId,
  studySeriesId,
} from '../../scripts/grid-oracle.mjs';
import { validateGridEvidence } from '../../scripts/grid-evidence.mjs';

const seed = 20260922;
const fullIds = [
  'full-initial-setup',
  'full-tail-replacement',
  'full-append-255-to-256',
  'full-drawing-edit',
  'full-study-parameter-edit',
  'full-pane-edit',
  'full-market-switch',
  'full-interval-switch',
  'full-parked-once-crossing-remount',
  'full-save-restore',
  'full-zero-size-recovery',
  'full-final-mounted',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const memberPaths = (archive) => {
  const paths = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/index.d.ts',
  ];
  if (['@filtix/alerts', '@filtix/charts', '@filtix/indicators'].includes(archive))
    paths.push('package/dist/internal.js', 'package/dist/internal.js.map', 'package/dist/internal.d.ts');
  return paths.sort();
};
function identityPair() {
  const source = {
    commit: 'a'.repeat(40),
    dirty: [],
    files: [{ path: 'src/terminal.ts', sha256: 'b'.repeat(64) }],
  };
  const archives = [
    '@filtix/analysis',
    '@filtix/alerts',
    '@filtix/charts',
    '@filtix/core',
    '@filtix/datafeed',
    '@filtix/drawings',
    '@filtix/indicators',
    '@filtix/react',
    '@filtix/terminal',
  ].map((name) => ({
    name,
    path: `dist/packages/${name.slice('@filtix/'.length)}.tgz`,
    sha256: 'c'.repeat(64),
    members: memberPaths(name).map((path) => ({ path, sha256: 'd'.repeat(64) })),
  }));
  const installRecord = { schema: 'accepted-install', version: 1, archives };
  const installPointer = 'benchmark-results/v0.11/consumer-install.json';
  const installedIdentities = [{ path: installPointer, sha256: 'e'.repeat(64) }];
  for (const archive of archives)
    for (const member of archive.members) {
      const path = `examples/react-terminal/node_modules/${archive.name}/${member.path.slice('package/'.length)}`;
      installedIdentities.push({ path, sha256: 'd'.repeat(64) });
    }
  const installed = {
    sourceCommit: source.commit,
    archives: 9,
    members: 45,
    identities: installedIdentities,
  };
  const expectedIdentity = { source, installRecord, installed };
  const identity = {
    sourceCommit: source.commit,
    sourceSha256: digest(JSON.stringify(source)),
    sourceFiles: source.files,
    consumerRoot: 'examples/react-terminal',
    installRecordPath: installPointer,
    installRecord,
    installRecordSha256: 'e'.repeat(64),
    verifications: [
      {
        phase: 'before',
        at: 10,
        sourceCommit: source.commit,
        sourceSha256: digest(JSON.stringify(source)),
        archivesSha256: '1'.repeat(64),
      },
      {
        phase: 'after',
        at: 20,
        sourceCommit: source.commit,
        sourceSha256: digest(JSON.stringify(source)),
        archivesSha256: '1'.repeat(64),
      },
    ],
    installed: true,
    sourceAliases: false,
    archives: archives.map((archive) => ({
      name: archive.name,
      path: archive.path,
      sha256: archive.sha256,
      members: archive.members.map((member) => ({
        path: member.path,
        archiveSha256: member.sha256,
        installedSha256: 'd'.repeat(64),
      })),
    })),
  };
  for (const verification of identity.verifications)
    verification.archivesSha256 = digest(JSON.stringify(identity.archives));
  return { expectedIdentity, identity };
}
function cleanup() {
  return {
    finalResourceLabel: 'synthetic-final',
    ownedZeroCounts: { feeds: 0, listeners: 0, timers: 0, observers: 0, dom: 0 },
    borrowedUsabilityObservations: [
      {
        borrowedUsable: true,
        borrowedUse: { attached: true, membersWhileAttached: 1, membersAfterRelease: 0 },
      },
    ],
    portClosed: true,
    browserClosed: true,
  };
}
function emptyActions() {
  return {
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
  };
}
function actualRendered(expected, expectedCell) {
  const studies = new Map(expectedCell.studies.map((study) => [study.kind, study]));
  return expected.rendered.map((sample) => {
    const points = {};
    points['terminal-price'] = { ...sample.ohlcv };
    points['terminal-volume'] = { time: sample.time, value: sample.ohlcv.volume };
    for (const kind of ['sma', 'ema', 'rsi']) {
      const value = sample.studies[kind];
      points[studySeriesId(studies.get(kind), 'value')] = { time: sample.time, value: value ?? undefined };
    }
    const macd = studies.get('macd');
    for (const [name, output] of [
      ['macd', 'line'],
      ['signal', 'signal'],
      ['histogram', 'histogram'],
    ])
      points[studySeriesId(macd, name)] = {
        time: sample.time,
        value: sample.studies.macd[output] ?? undefined,
      };
    const bollinger = studies.get('bollinger');
    for (const name of ['middle', 'upper', 'lower'])
      points[studySeriesId(bollinger, name)] = {
        time: sample.time,
        value: sample.studies.bollinger[name] ?? undefined,
      };
    points[fillSeriesId(bollinger)] = {
      time: sample.time,
      upper: sample.fill.upper ?? undefined,
      lower: sample.fill.lower ?? undefined,
    };
    return { index: sample.index, time: sample.time, points };
  });
}
function projectedGeometry(expected, rows) {
  const projectY = (price) => 1000 - price;
  const anchors = [];
  const geometry = expected.drawings.geometry.map((drawing) => {
    const projectedAnchors = drawing.anchors.map((point, pointIndex) => {
      const loadedIndex = rows.findIndex((bar) => bar.time === point.time);
      const anchor = {
        sourceId: drawing.id,
        pointIndex,
        time: point.time,
        price: point.price,
        x: loadedIndex,
        y: projectY(point.price),
        loadedIndex,
      };
      anchors.push(anchor);
      return { time: point.time, price: point.price, x: anchor.x, y: anchor.y };
    });
    const fibLevels = drawing.fibLevels.map((level) => ({ ...level, y: projectY(level.price) }));
    const text = drawing.text
      ? {
          ...drawing.text,
          anchorX: projectedAnchors[0].x,
          anchorY: projectedAnchors[0].y,
          bounds: {
            left: projectedAnchors[0].x,
            top: projectedAnchors[0].y,
            right: projectedAnchors[0].x + 24,
            bottom: projectedAnchors[0].y + drawing.text.lineCount * drawing.text.fontSize * 1.25 + 12,
          },
        }
      : null;
    return { ...drawing, anchors: projectedAnchors, fibLevels, text };
  });
  const result = {
    geometry,
    drawingObservation: {
      projection: {
        width: 1600,
        height: 1000,
        plotWidth: 1600,
        plotHeight: 1000,
        dpr: 1,
        theme: { background: '#000000' },
        measureMetrics: {},
        fibonacciMetrics: {},
        timeDomain: 'utc-ms',
        panes: ['price', 'terminal-volume-pane', 'terminal-study-3-pane', 'terminal-study-4-pane'].map(
          (id) => ({ id, scale: 'linear', left: 0, top: 0, right: 1600, bottom: 1000 }),
        ),
        visibleRange: { from: 0, to: rows.length - 1 },
        anchors,
        priceBasis: {
          price: [
            { price: 0, y: 1000 },
            { price: 1000, y: 0 },
          ],
        },
        textMetrics: Object.fromEntries(
          expected.drawings.geometry
            .filter((item) => item.text)
            .map((item) => [item.id, Array(item.text.lineCount).fill(10)]),
        ),
      },
      groups: expected.drawings.document.drawings.map((drawing, sourceIndex) => ({
        sourceId: drawing.id,
        sourceIndex,
        calls: [{ method: 'stroke', args: [], path: [] }],
      })),
    },
  };
  const projection = result.drawingObservation.projection;
  result.drawingObservation.groups = expected.drawings.document.drawings.map((drawing, index) => ({
    sourceId: drawing.id,
    sourceIndex: index,
    calls: paintFixture(drawing, geometry[index].anchors, projection),
  }));
  return result;
}
function makeLegacyFullRecord() {
  const { expectedIdentity, identity } = identityPair();
  const scene = buildGridScene({ rowsPerCell: 256, seed });
  const scope = {
    seed,
    providerId: scene.gridWorkspace.providerId,
    cells: scene.cells.map((cell) => ({
      ...cell,
      rows: undefined,
      rowsPerCell: 256,
      seriesCount: 12,
      paneCount: 4,
      drawingCount: 50,
      alertCount: 25,
    })),
    sourceRows: scene.cells.map((cell) => ({ cellId: cell.id, rows: cell.rows, orderedMutations: [] })),
    mutations: [],
    monitorSources: scene.monitorSources,
    alternateSources: scene.alternateSources,
  };
  const evidenceScene = {
    providerId: scene.gridWorkspace.providerId,
    host: { width: 1600, height: 1000 },
    layout: 4,
    monitorQueryCount: 8,
    gridWorkspace: scene.gridWorkspace,
    scopes: { full: scope },
  };
  const checkpoints = [];
  for (const id of fullIds) {
    const expected = expectedCheckpoint(scene, [], {
      id,
      scope: 'full-256',
      indices: Array.from({ length: 256 }, (_, index) => index),
      mutationPrefix: 0,
    });
    const observedCells = expected.cells.map((cellExpected) => {
      const rows = scope.sourceRows.find((item) => item.cellId === cellExpected.id).rows;
      const drawing = projectedGeometry(cellExpected, rows);
      return {
        id: cellExpected.id,
        query: cellExpected.query,
        source: {
          rows: 256,
          firstTime: cellExpected.source.firstTime,
          lastTime: cellExpected.source.lastTime,
          terminalDataSha256: cellExpected.source.expectedSha256,
        },
        rendered: actualRendered(cellExpected, cellExpected),
        drawings: { document: cellExpected.drawings.document, geometry: drawing.geometry },
        drawingObservation: drawing.drawingObservation,
        alerts: { document: cellExpected.alerts.document, events: cellExpected.alerts.expected },
        workspace: cellExpected.workspace,
      };
    });
    checkpoints.push({
      id,
      scope: 'full-256',
      rowsPerCell: 256,
      mutationPrefix: 0,
      expected,
      observed: { cells: observedCells },
    });
  }
  const endpoints = ['full-baseline', 'full-layout-4', 'full-final'].map((label) => ({
    label,
    sampleKind: 'three-gc-endpoint',
    gcTurns: 3,
    heapUsedBytes: 100_000_000,
    dom: { nodes: 100, detached: 0, disposed: 0 },
    listeners: 5,
    provider: { historyFeeds: 4, latestFeeds: 8 },
    monitor: { runtimes: [] },
    cells: scene.cells.map((cell) => ({ cellId: cell.id, query: cell.query })),
    gridState: { layout: 4 },
  }));
  const transient = {
    sampleKind: 'transient-feed',
    label: 'synthetic',
    cells: [],
    provider: {},
    monitor: {},
  };
  const record = {
    schema: 'filtix-grid-installed-evidence',
    version: 1,
    mode: 'full',
    status: 'pass',
    identity,
    environment: {},
    scene: evidenceScene,
    checkpoints,
    actions: emptyActions(),
    resources: [...endpoints, transient],
    capacity: {
      rules: 0,
      armedQueries: 0,
      restoreObservations: [],
      failedAtomicity: [],
      leaseObservations: [],
    },
    coverage: {
      fullCheckpoints: 12,
      fullRenderedObservations: 12 * 4 * 256,
      renderedCoverageLabels: {
        full: { scope: 'full-256', label: 'all 256 rows at 12 checkpoints', exhaustive: true },
      },
      sourceHashes: [],
      drawingsVerified: 2400,
      alertsVerified: 1200,
    },
    cleanup: cleanup(),
    failures: [],
  };
  return { record, expectedIdentity };
}
function receipt(id = 'receipt-1') {
  return {
    id,
    targetAt: 10,
    dispatchedAt: 11,
    returnedAt: 12,
    settledAt: 13,
    wallClock: { dispatchedAt: 11, returnedAt: 12, settledAt: 13 },
    synchronousMs: 1,
    settledMs: 2,
    renderWorkMs: 0,
    libraryWorkMs: 1,
    affectedCellIds: ['cell-1'],
    frames: [],
  };
}

function renderReceipt(item) {
  item.wallClock = Object.fromEntries(
    ['dispatchedAt', 'returnedAt', 'settledAt'].map((field) => [field, Math.floor(item[field])]),
  );
  item.chartGeneration = 1;
  const queries = [
    { symbol: 'BTCUSDT', interval: '1m' },
    { symbol: 'ETHUSDT', interval: '5m' },
    { symbol: 'SOLUSDT', interval: '1h' },
    { symbol: 'ETHUSDT', interval: '1m' },
  ];
  item.chartCohortBefore = queries.map((query, index) => ({
    cellId: `cell-${index + 1}`,
    chartGeneration: 1,
    query,
  }));
  item.chartCohortAfter = structuredClone(item.chartCohortBefore);
  item.chartCohort = structuredClone(item.chartCohortAfter);
  item.frames = [
    {
      receiptId: 'raf:' + item.id,
      chartGeneration: 1,
      at: item.returnedAt,
      callbackMs: 0.1,
      affectedCharts: item.affectedCellIds.map((cellId) => ({
        cellId,
        chartGeneration: 1,
        before: { sceneDraws: 0, overlayDraws: 0, primitiveDraws: 0 },
        after: { sceneDraws: 1, overlayDraws: 1, primitiveDraws: 1 },
      })),
    },
  ];
  item.renderWorkMs = 0.1;
  item.libraryWorkMs = item.synchronousMs + 0.1;
  return item;
}

function paintFixture(d, anchors, projection) {
  const [a, b, c] = anchors,
    calls = [];
  const base = {
    strokeStyle: d.style.color,
    fillStyle: d.style.color,
    lineWidth: d.style.lineWidth,
    globalAlpha: 1,
    lineDash: [],
    font: '12px sans-serif',
    textBaseline: 'top',
  };
  const call = (method, args = [], extra = {}) => calls.push({ ...base, method, args, path: [], ...extra });
  const line = (u, v, extra = {}) =>
    call('stroke', [], {
      path: [
        ['moveTo', u.x, u.y],
        ['lineTo', v.x, v.y],
      ],
      ...extra,
    });
  if (d.type === 'horizontal-line') line({ x: 0, y: a.y }, { x: 1600, y: a.y });
  if (d.type === 'trend-line') line(a, b);
  if (['rectangle', 'measure'].includes(d.type)) {
    const box = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
    call('fillRect', box, { globalAlpha: d.style.fillOpacity });
    call('strokeRect', box);
    if (d.type === 'measure') {
      const delta = d.points[1].price - d.points[0].price;
      const fmt = (v) => Number(v.toPrecision(5)).toString();
      const label =
        fmt(delta) +
        ' (' +
        fmt((delta / Math.abs(d.points[0].price)) * 100) +
        '%) · ' +
        fmt(Math.abs(d.points[1].time - d.points[0].time) / 86400000) +
        'd';
      projection.measureMetrics[d.id] = { label, width: 30 };
      const x = Math.max(0, Math.min(1600 - 42, box[0])),
        y = Math.max(0, Math.min(978, box[1]));
      call('fillRect', [x, y, 42, 22], { fillStyle: '#000000' });
      call('fillText', [label, x + 6, y + 5]);
    }
  }
  if (d.type === 'fibonacci-retracement') {
    projection.fibonacciMetrics[d.id] = [];
    for (const level of d.levels) {
      const price = d.points[0].price * (1 - level.ratio) + d.points[1].price * level.ratio,
        y = 1000 - price;
      line(
        { x: a.x, y },
        { x: b.x, y },
        {
          strokeStyle: level.color,
          lineWidth: level.lineWidth,
          lineDash: level.lineStyle === 'dashed' ? [6, 4] : [],
        },
      );
      const label = Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(price.toPrecision(6));
      projection.fibonacciMetrics[d.id].push({ label, width: 30 });
      call(
        'fillText',
        [
          label,
          Math.max(4, Math.min(1566, Math.max(a.x, b.x) - 30)),
          Math.max(0, Math.min(989, y - 13)),
          1592,
        ],
        { fillStyle: level.color, font: '11px sans-serif' },
      );
    }
  }
  if (d.type === 'parallel-channel') {
    const fourth = { x: c.x + b.x - a.x, y: c.y + b.y - a.y };
    call('fill', [], {
      path: [
        ['moveTo', a.x, a.y],
        ['lineTo', b.x, b.y],
        ['lineTo', fourth.x, fourth.y],
        ['lineTo', c.x, c.y],
        ['closePath'],
      ],
      globalAlpha: d.style.fillOpacity,
    });
    for (const [u, v] of [
      [a, b],
      [c, fourth],
      [a, c],
      [b, fourth],
    ])
      line(u, v);
  }
  if (d.type === 'text-note') {
    const lines = d.text.split('\n'),
      box = [a.x, a.y, 24, lines.length * d.fontSize * 1.25 + 12];
    call('fillRect', box, { fillStyle: '#000000', globalAlpha: d.style.fillOpacity });
    call('strokeRect', box);
    lines.forEach((text, index) =>
      call('fillText', [text, a.x + 6, a.y + 6 + index * d.fontSize * 1.25], {
        font: d.fontSize + 'px sans-serif',
      }),
    );
  }
  return calls;
}
const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
const key = (q) => JSON.stringify([q.symbol, q.interval]);
function monitorFixture(queries = [], empty = false) {
  const runtimes = queries.map((query) => ({
    query,
    active: true,
    feed: {
      mode: 'latest',
      query,
      status: 'live',
      destroyed: false,
      retainedBars: 1,
      bufferedBars: 0,
      correctionBars: 0,
      pendingBarEntries: 0,
      pendingRequest: false,
      buffering: false,
      laneKind: null,
      activeConnection: true,
      staleTimer: false,
      retryTimer: false,
      requestTimer: false,
    },
  }));
  return {
    destroyed: false,
    members: empty ? 0 : 4,
    leaseEntries: empty ? 0 : 4,
    observerListeners: 0,
    retainedMemberDisposers: empty ? 0 : 4,
    cachedRuleEntries: empty ? 0 : 100,
    baselineEntries: queries.length,
    runtimeEntries: queries.length,
    activeRuntimeEntries: queries.length,
    reconcileTimers: 0,
    reservationPending: false,
    activationPending: false,
    runtimes,
  };
}
function providerFixture(chartQueries = [], queries = []) {
  const subscriptions = [...chartQueries, ...queries].map((query, index) => ({
    subscriptionId: index + 1,
    providerGeneration: 1,
    query,
    key: key(query),
    openedAt: 1,
    releasedAt: null,
  }));
  return {
    providerGeneration: 1,
    historyFeeds: chartQueries.length,
    latestFeeds: queries.length,
    activeSubscriptions: subscriptions.length,
    pendingRequests: 0,
    subscriptions,
    requests: 0,
    historyPages: 0,
    latestPages: 0,
  };
}
function attachReadiness(endpoint) {
  const raw = structuredClone({ ...endpoint, sampleKind: 'transient-feed' });
  delete raw.readiness;
  delete raw.measuredAt;
  const before = { ...structuredClone(raw), at: 899992, label: `${endpoint.label}-pre-gc` };
  const after = { ...structuredClone(raw), label: `${endpoint.label}-post-gc` };
  const prepared = { observed: true };
  endpoint.prepared = prepared;
  const measurements = {
    gcTurns: 3,
    preparedAt: 899993,
    prepared,
    gcTurnReceipts: [
      { turn: 1, at: 899994 },
      { turn: 2, at: 899995 },
      { turn: 3, at: 899996 },
    ],
    countersAt: 899997,
    counters: {
      nodes: endpoint.dom.nodes,
      jsEventListeners: endpoint.listeners,
    },
    heapAt: 899998,
    heap: { usedSize: endpoint.heapUsedBytes },
    domOwnedAt: 899999,
    domOwned: structuredClone(endpoint.domOwned),
    resourceTrackerAt: 900000,
    resourceTracker: structuredClone(endpoint.resourceTracker),
  };
  endpoint.readiness = {
    label: endpoint.label,
    accepted: true,
    clockDomains: {
      collector: 'node-performance-epoch-ms',
      snapshots: 'browser-performance-epoch-ms',
    },
    startedAt: 899990,
    completedAt: 900010,
    polls: [
      {
        at: 899991,
        requestStartedAt: 899990,
        responseReceivedAt: 899991,
        snapshot: { ...structuredClone(before), at: 899991 },
        ready: true,
      },
    ],
    gcAttempts: [
      {
        pre: before,
        preRequestStartedAt: 899991,
        preResponseReceivedAt: 899992,
        preObservedAt: 899992,
        measurements,
        post: after,
        postRequestStartedAt: 900000,
        postResponseReceivedAt: 900001,
        postObservedAt: 900001,
        accepted: true,
      },
    ],
  };
  endpoint.measuredAt = {
    prepared: measurements.preparedAt,
    gcTurns: measurements.gcTurnReceipts,
    domCounters: measurements.countersAt,
    heap: measurements.heapAt,
    ownedDom: measurements.domOwnedAt,
    resourceTracker: measurements.resourceTrackerAt,
    providerAndMonitor: after.at,
  };
  return endpoint;
}

test('readiness accepts independent browser clock offsets but rejects broken same-domain order', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const endpoint = record.resources.find((item) => item.label === 'full-mounted-initial');
  assert.ok(endpoint);
  const offsetBrowser = (amount) => {
    const copy = structuredClone(record);
    for (const item of copy.resources.filter((entry) => entry.sampleKind === 'three-gc-endpoint')) {
      item.at += amount;
      item.measuredAt.providerAndMonitor += amount;
      for (const poll of item.readiness.polls) poll.snapshot.at += amount;
      for (const attempt of item.readiness.gcAttempts) {
        attempt.pre.at += amount;
        attempt.post.at += amount;
      }
    }
    return copy;
  };
  for (const amount of [0.0789, 10000, -10000]) {
    const result = validateGridEvidence(offsetBrowser(amount), { expectedIdentity });
    assert.equal(result.valid, true, `browser offset ${amount}: ${result.errors.join('\n')}`);
  }
  const backwards = offsetBrowser(10000);
  const target = backwards.resources.find((item) => item.label === 'full-mounted-initial');
  target.readiness.gcAttempts[0].post.at = target.readiness.gcAttempts[0].pre.at - 1;
  const invalid = validateGridEvidence(backwards, { expectedIdentity });
  assert.equal(invalid.valid, false);
  assert.ok(
    invalid.errors.some((item) => item.includes('browser snapshot chronology')),
    invalid.errors.join('\n'),
  );
});
function endpointFixture(label, scene, mounted = true, count = scene.rowsPerCell) {
  const queries = mounted ? scene.monitorSources.map((item) => item.query) : [];
  const charts = mounted ? scene.cells.map((cell) => cell.query) : [];
  return attachReadiness({
    label,
    at: 900000,
    sampleKind: 'three-gc-endpoint',
    gcTurns: 3,
    heapUsedBytes: 100000000,
    dom: { nodes: mounted ? 100 : 0, detached: 0, disposed: 0 },
    domOwned: {
      consumer: { detached: 0 },
      terminal: { detached: 0 },
      totalOwned: { consumer: mounted ? 1 : 0 },
    },
    listeners: mounted ? 5 : 0,
    timers: 0,
    observers: 0,
    resourceTracker: { timers: 0, observers: 0 },
    owned: {
      feeds: mounted ? 12 : 0,
      listeners: mounted ? 5 : 0,
      timers: 0,
      observers: 0,
      dom: mounted ? 1 : 0,
    },
    provider: providerFixture(charts, queries),
    monitor: mounted ? monitorFixture(queries) : null,
    gridState: mounted ? { layout: 4 } : null,
    cells: scene.cells.map((cell) =>
      mounted
        ? { cellId: cell.id, query: cell.query, rows: count, feed: { query: cell.query, status: 'live' } }
        : { cellId: cell.id, feed: null },
    ),
  });
}
function controlsFixture() {
  const store = {
    destroyed: false,
    changeListeners: 0,
    eventListeners: 0,
    admissionListeners: 0,
    lifecycleListeners: 0,
  };
  return {
    defaultOwned: { populated: 25, store: { ...store, destroyed: true }, provider: providerFixture() },
    supplied: {
      suppliedUsable: true,
      monitorUsable: true,
      beforeDestroy: ids.map(() => ({ ...store })),
      afterDestroy: ids.map(() => ({ ...store })),
    },
  };
}
function cleanupFixture(label) {
  const empty = monitorFixture([], true);
  return {
    ...cleanup(),
    finalResourceLabel: label,
    borrowedUsabilityObservations: [
      {
        borrowedUsable: true,
        borrowedUse: { attached: true, membersWhileAttached: 1, membersAfterRelease: 0 },
        borrowedAfterGrid: empty,
        destroyedMonitor: { ...empty, destroyed: true },
        after: { provider: providerFixture() },
      },
    ],
    ownershipControls: controlsFixture(),
  };
}
function transientFixtures(scene) {
  const query = scene.monitorSources.at(-1).query;
  return ['initial', 'reconnect'].flatMap((stage) => {
    const held = monitorFixture([query]);
    held.runtimes[0].feed = {
      ...held.runtimes[0].feed,
      pendingRequest: true,
      buffering: true,
      bufferedBars: 1,
      pendingBarEntries: 1,
      laneKind: stage === 'initial' ? 'initial' : 'recovery',
    };
    const provider = providerFixture([], [query]);
    provider.pendingRequests = 1;
    return [
      {
        sampleKind: 'transient-feed',
        label: `transient-${stage}-held-after-delivery`,
        at: 10,
        query,
        provider,
        monitor: held,
      },
      {
        sampleKind: 'transient-feed',
        label: `transient-${stage}-reconciled`,
        at: 20,
        query,
        provider: providerFixture([], [query]),
        monitor: monitorFixture([query]),
      },
    ];
  });
}
function environmentFixture() {
  return {
    automationPreparation: {
      kind: 'selector-geometry',
      selector: 'body',
      startedAt: 1,
      completedAt: 2,
      boundingBox: null,
    },
    deviceScaleFactor: 1,
    viewport: { width: 1600, height: 1000 },
    browser: 'synthetic Chromium',
    os: 'test OS',
    cpu: 'test CPU',
    platform: 'test',
    visibility: [{ state: 'visible', at: 1 }],
  };
}
function scopeFixture(scene) {
  return {
    seed: scene.seed,
    cells: scene.cells.map((cell) => ({
      ...cell,
      rows: undefined,
      rowsPerCell: scene.rowsPerCell,
      seriesCount: 12,
      paneCount: 4,
      drawingCount: 50,
      alertCount: 25,
    })),
    sourceRows: scene.cells.map((cell) => ({ cellId: cell.id, rows: cell.rows, orderedMutations: [] })),
    monitorSources: scene.monitorSources,
    alternateSources: scene.alternateSources,
    mutations: [],
  };
}
function semanticFixtures(record, scene) {
  for (const list of Object.values(record.actions))
    for (const item of list)
      if (item.kind === 'deliver') {
        item.providerBefore = providerFixture(
          scene.cells.map((cell) => cell.query),
          scene.monitorSources.map((item) => item.query),
        );
        item.providerAfter = structuredClone(item.providerBefore);
        item.requested = {
          id: item.id,
          kind: item.kind,
          deliveries: item.deliveries.map((delivery) => {
            const [symbol, interval] = JSON.parse(delivery.key);
            return { query: { symbol, interval }, bar: delivery.bar };
          }),
        };
        for (const delivery of item.deliveries)
          delivery.handlers = item.providerBefore.subscriptions.filter(
            (entry) => entry.key === delivery.key,
          ).length;
      }
  const scope = record.scene.scopes[scene.rowsPerCell === 256 ? 'full' : 'maximum'];
  for (const id of new Set(
    scope.mutations.filter((item) => item.operation === 'source-reset').map((item) => item.checkpointId),
  )) {
    const reset = scope.mutations.find(
      (item) => item.operation === 'source-reset' && item.checkpointId === id,
    );
    const proof = {
      id,
      kind: 'source-reset',
      rowCount: reset.rowCount,
      before: endpointFixture('reset-before', scene, true),
      after: endpointFixture('reset-after', scene, true, reset.rowCount),
      retirement: { after: { provider: providerFixture() } },
      setup: renderReceipt({ ...receipt(id + '-setup'), kind: 'construct' }),
    };
    const previous =
      scene.rowsPerCell === 256
        ? record.actions.lifecycle.find((item) => item.id === 'full-tail-replacement-action')
        : record.actions.tailReplace.at(-1);
    const at = previous.settledAt + 1;
    Object.assign(proof.setup, { targetAt: at, dispatchedAt: at, returnedAt: at + 1, settledAt: at + 2 });
    proof.setup.frames[0].at = at + 1;
    record.actions.lifecycle.push(proof);
  }
  let workspace = structuredClone(scene.gridWorkspace);
  const state = () => ({ layout: workspace.layout, activeCellId: workspace.activeCellId });
  const used = new Set();
  const mutations = record.scene.scopes[scene.rowsPerCell === 256 ? 'full' : 'maximum'].mutations;
  const apply = (item) => {
    if (!item?.id) return;
    if (
      !['construct', 'restore', 'layout', 'active', 'drawing', 'study', 'pane', 'market'].includes(item.kind)
    )
      return;
    const before = { state: state(), workspace: structuredClone(workspace) },
      request = { id: item.id, kind: item.kind };
    if (['drawing', 'study', 'pane', 'market'].includes(item.kind)) {
      const ops = {
        drawing: ['drawing-edit'],
        study: ['study-edit'],
        pane: ['pane-edit'],
        market: ['market-switch', 'interval-switch'],
      }[item.kind];
      const mutation = mutations.find(
        (m) =>
          ops.includes(m.operation) &&
          !used.has(m.sequence) &&
          (item.affectedCellIds.length === 4 || item.affectedCellIds.includes(m.cellId)),
      );
      if (!mutation) throw Error('Synthetic semantic mutation missing ' + item.id);
      used.add(mutation.sequence);
      request.cellId = mutation.cellId;
      const cell = workspace.cells.find((cell) => cell.id === mutation.cellId).workspace;
      if (item.kind === 'drawing') {
        request.drawingId = mutation.drawingId;
        request.patch = mutation.drawingPatch;
        Object.assign(
          cell.markets
            .find((m) => key(m.query) === key(cell.query))
            .drawings.drawings.find((d) => d.id === request.drawingId),
          structuredClone(request.patch),
        );
      }
      if (item.kind === 'study') {
        request.studyId = mutation.studyId;
        request.patch = mutation.studyPatch;
        Object.assign(
          cell.studies.find((study) => study.id === request.studyId),
          request.patch,
        );
      }
      if (item.kind === 'pane') {
        request.panes = cell.layout.panes.map((pane, i) => ({
          id: pane.id,
          weight: mutation.paneWeights[i],
        }));
        cell.layout.panes = cell.layout.panes.map((pane, i) => ({
          ...pane,
          weight: request.panes[i].weight,
        }));
      }
      if (item.kind === 'market') {
        request.query = mutation.query;
        cell.query = structuredClone(mutation.query);
      }
    }
    if (item.kind === 'layout') {
      request.layout = item.id.startsWith('unpark-') ? 4 : 1;
      workspace.layout = request.layout;
    }
    if (item.kind === 'active') {
      request.cellId = ids[(ids.indexOf(workspace.activeCellId) + 1) % 4];
      workspace.activeCellId = request.cellId;
    }
    if (['construct', 'restore'].includes(item.kind)) {
      request.workspace = structuredClone(workspace);
      if (item.kind === 'construct') {
        before.state = null;
        before.workspace = null;
      }
    }
    item.requested = request;
    item.semanticObservation = {
      requested: structuredClone(request),
      before,
      after: { state: state(), workspace: structuredClone(workspace) },
    };
  };
  for (const category of ['warmup', 'constructions', 'restores', 'interaction'])
    for (const item of record.actions[category] ?? []) apply(item);
  for (const item of record.actions.lifecycle ?? []) {
    if (item.kind === 'park-cycle') {
      apply(item.one);
      item.four.targetAt = item.one.settledAt + 1;
      item.four.dispatchedAt = item.four.targetAt;
      item.four.returnedAt = item.four.targetAt + 1;
      item.four.settledAt = item.four.targetAt + 2;
      item.four.frames[0].at = item.four.returnedAt;
      apply(item.four);
    } else if (item.kind === 'destroy-recreate') apply(item.receipt);
    else if (item.kind === 'source-reset') apply(item.setup);
    else apply(item);
  }
}

function requestFixtures(record) {
  const requests = [];
  const add = (query, limit, at, scope) =>
    requests.push({
      id: `request-${requests.length + 1}`,
      providerGeneration: 1,
      scope,
      key: key(query),
      query,
      limit,
      requestKind: limit === 1 ? 'latest-protocol' : 'history-protocol',
      before: null,
      from: null,
      startedAt: at,
      status: 'fulfilled',
      abortObservedAt: null,
      abortObservedAfterFulfillmentAt: null,
      abortReason: null,
      returned: limit,
      exhausted: false,
      finishedAt: at + 0.01,
    });
  if (record.scene.scopes.maximum)
    for (const item of [...record.actions.constructions, ...record.actions.restores]) {
      item.providerBefore = providerFixture(
        record.scene.scopes.maximum.cells.map((cell) => cell.query),
        record.scene.scopes.maximum.monitorSources.map((source) => source.query),
      );
      item.providerBefore.requests = requests.length;
      for (const cell of record.scene.scopes.maximum.cells)
        for (let page = 0; page < 10; page++) add(cell.query, 10000, item.dispatchedAt + 0.1, 'maximum');
      item.providerAfter = { ...structuredClone(item.providerBefore), requests: requests.length };
    }
  if (!requests.length)
    add(
      { symbol: 'BTCUSDT', interval: '1m' },
      256,
      1,
      record.mode === 'full' ? 'bounded-full-256' : 'capacity-400-rules-32-queries',
    );
  record.providerRequests = requests;
  const final = record.resources.find((item) => item.label === record.cleanup.finalResourceLabel);
  final.provider.requests = requests.length;
  final.readiness.gcAttempts.at(-1).post.provider.requests = requests.length;
}

function refreshCoverage(record) {
  record.coverage.sourceHashes = record.checkpoints.flatMap((cp) =>
    cp.observed.cells.map((cell) => ({
      checkpointId: cp.id,
      cellId: cell.id,
      expectedSha256: cp.expected.cells.find((item) => item.id === cell.id).source.expectedSha256,
      terminalDataSha256: cell.source.terminalDataSha256,
    })),
  );
  record.coverage.drawingsVerified = record.checkpoints.reduce(
    (sum, cp) => sum + cp.observed.cells.reduce((n, cell) => n + cell.drawings.geometry.length, 0),
    0,
  );
  record.coverage.alertsVerified = record.checkpoints.reduce(
    (sum, cp) => sum + cp.observed.cells.reduce((n, cell) => n + cell.alerts.document.alerts.length, 0),
    0,
  );
  return record;
}

function makeFullRecord() {
  const { expectedIdentity, identity } = identityPair(),
    scene = buildGridScene({ rowsPerCell: 256 }),
    scope = scopeFixture(scene);
  const record = {
    schema: 'filtix-grid-installed-evidence',
    version: 1,
    mode: 'full',
    identity,
    environment: environmentFixture(),
    scene: {
      providerId: 'filtix-grid-workload-v1',
      host: { width: 1600, height: 1000 },
      layout: 4,
      monitorQueryCount: 8,
      gridWorkspace: scene.gridWorkspace,
      scopes: { full: scope },
    },
    checkpoints: [],
    actions: emptyActions(),
    resources: [],
    coverage: {
      fullCheckpoints: 12,
      fullRenderedObservations: 12288,
      renderedCoverageLabels: {
        full: { scope: 'full-256', label: 'all256 rendered rows', exhaustive: true },
      },
    },
    cleanup: cleanupFixture('full-empty-final'),
    failures: [],
  };
  let clock = 100,
    cpId = fullIds[0];
  const rows = new Map(scene.cells.map((cell) => [cell.id, structuredClone(cell.rows)]));
  const latest = new Map(
    [...scene.monitorSources, ...scene.alternateSources, ...scene.cells].map((item) => [
      key(item.query),
      item.rows.at(-1),
    ]),
  );
  const add = (operation, cellId, detail = {}) => {
    const m = {
      checkpointId: cpId,
      sequence: scope.mutations.length,
      operation,
      cellId,
      ...structuredClone(detail),
    };
    scope.mutations.push(m);
    if (cellId) scope.sourceRows.find((item) => item.cellId === cellId).orderedMutations.push(m);
  };
  const act = (id, kind, detail = {}) => {
    clock += 40;
    const item = {
      ...receipt(id),
      kind,
      phase: 'correctness-only',
      targetAt: clock,
      dispatchedAt: clock,
      returnedAt: clock + 1,
      settledAt: clock + 2,
      affectedCellIds: ids,
      ...detail,
    };
    renderReceipt(item);
    record.actions.lifecycle.push(item);
    return item;
  };
  const deliver = (id, deliveries) => {
    const action = act(id, 'deliver', {
      deliveries: deliveries.map((item) => ({ ...item, key: key(item.query), handlers: 2 })),
    });
    deliveries.forEach((item, index) => {
      add('monitor-update', null, {
        deliveryId: `${id}:${index + 1}`,
        query: item.query,
        bar: item.bar,
        previousPrice: latest.get(key(item.query)).close,
        dispatchedAt: action.dispatchedAt,
      });
      latest.set(key(item.query), item.bar);
    });
    return action;
  };
  const capture = () => {
    const expected = expectedCheckpoint(scene, scope.mutations, {
      id: cpId,
      scope: 'full-256',
      indices: Array.from({ length: 256 }, (_, i) => i),
    });
    const cells = expected.cells.map((cell) => {
      const source =
        scene.alternateSources.find((item) => item.cellId === cell.id && key(item.query) === key(cell.query))
          ?.rows ?? rows.get(cell.id);
      const drawing = projectedGeometry(cell, source);
      const observed = structuredClone(cell);
      const stamp = (value) => {
        if (Array.isArray(value)) {
          value.forEach(stamp);
          return;
        }
        if (value && typeof value === 'object') {
          if (value.occurrence && value.observedAt === undefined) value.observedAt = clock + 1;
          Object.values(value).forEach(stamp);
        }
      };
      stamp(observed);
      return {
        id: cell.id,
        query: cell.query,
        source: {
          rows: 256,
          firstTime: cell.source.firstTime,
          lastTime: cell.source.lastTime,
          terminalDataSha256: cell.source.expectedSha256,
        },
        rendered: actualRendered(cell, cell),
        drawings: { document: cell.drawings.document, geometry: drawing.geometry },
        drawingObservation: drawing.drawingObservation,
        alerts: { document: observed.alerts.document, events: observed.alerts.expected },
        workspace: observed.workspace,
        seriesCount: 12,
        paneCount: 4,
      };
    });
    record.checkpoints.push({
      id: cpId,
      scope: 'full-256',
      rowsPerCell: 256,
      mutationPrefix: scope.mutations.length,
      expected,
      observed: { at: clock + 3, wallClockAt: clock + 3, cells },
    });
    return expected;
  };
  act('full-initial-setup-action', 'construct');
  capture();
  cpId = fullIds[1];
  const replacements = scene.cells.map((cell) => ({
    query: cell.query,
    bar: { ...rows.get(cell.id).at(-1), close: rows.get(cell.id).at(-1).close + 0.001 },
  }));
  deliver('full-tail-replacement-action', replacements);
  scene.cells.forEach((cell, i) => {
    rows.get(cell.id)[255] = replacements[i].bar;
    add('replace', cell.id, { index: 255, bar: replacements[i].bar });
  });
  capture();
  cpId = fullIds[2];
  scene.cells.forEach((cell) => {
    rows.set(cell.id, cell.rows.slice(0, 255));
    add('source-reset', cell.id, { rowCount: 255 });
    latest.set(key(cell.query), cell.rows[254]);
  });
  add('monitor-baseline-reset', null, {
    baselines: [...latest].map(([k, bar]) => {
      const [symbol, interval] = JSON.parse(k);
      return { query: { symbol, interval }, bar };
    }),
  });
  const appends = scene.cells.map((cell) => ({
    query: cell.query,
    bar: { ...cell.rows[255], close: cell.rows[255].close + 0.002 },
  }));
  deliver('full-append-255-to-256-action', appends);
  scene.cells.forEach((cell, i) => {
    rows.get(cell.id).push(appends[i].bar);
    add('append', cell.id, { bar: appends[i].bar });
  });
  capture();
  cpId = fullIds[3];
  for (const cell of scene.cells) {
    const drawing = cell.drawings.drawings[0],
      patch = { points: drawing.points.map((point) => ({ ...point, price: point.price + 0.05 })) };
    act(`full-drawing-${cell.id}`, 'drawing', { affectedCellIds: [cell.id] });
    add('drawing-edit', cell.id, { drawingId: drawing.id, drawingPatch: patch });
  }
  capture();
  cpId = fullIds[4];
  for (const cell of scene.cells) {
    act(`full-study-${cell.id}`, 'study', { affectedCellIds: [cell.id] });
    add('study-edit', cell.id, { studyId: cell.studies[0].id, studyPatch: { period: 201 } });
  }
  capture();
  cpId = fullIds[5];
  for (const cell of scene.cells) {
    act(`full-pane-${cell.id}`, 'pane', { affectedCellIds: [cell.id] });
    add('pane-edit', cell.id, { paneWeights: [0.54, 0.16, 0.16, 0.16] });
  }
  capture();
  cpId = fullIds[6];
  const market = scene.alternateSources[1];
  act('full-market-switch-action', 'market');
  add('market-switch', market.cellId, { query: market.query });
  capture();
  cpId = fullIds[7];
  const interval = scene.alternateSources[0];
  act('full-interval-switch-action', 'market');
  add('interval-switch', interval.cellId, { query: interval.query });
  const before = capture();
  cpId = fullIds[8];
  const once = scene.fullParkedOnceDelivery;
  deliver('full-parked-once-crossing', [{ query: once.query, bar: once.bar }]);
  add('parked-once-crossing', 'cell-4', { alertId: once.expectedAlertId, query: once.query });
  const after = capture();
  record.actions.lifecycle.push({
    kind: 'parked-once-proof',
    beforeParked: before.cells[3].alerts.document,
    duringParked: after.cells[3].alerts.document,
    afterParked: structuredClone(after.cells[3].alerts.document),
  });
  cpId = fullIds[9];
  act('full-save-restore-action', 'restore');
  add('save-restore', null);
  capture();
  cpId = fullIds[10];
  act('full-zero-size', 'size', { effectiveObservation: { afterRect: { width: 0, height: 0 } } });
  act('full-size-recovery', 'size', { effectiveObservation: { afterRect: { width: 1600, height: 1000 } } });
  add('zero-size-recovery', null);
  capture();
  cpId = fullIds[11];
  capture();
  record.resources = ['empty-baseline', 'mounted-initial', 'mounted-final', 'empty-final']
    .map((suffix) => endpointFixture('full-' + suffix, scene, suffix.startsWith('mounted')))
    .concat(transientFixtures(scene));
  if (scene && record.mode !== 'capacity') semanticFixtures(record, scene);
  requestFixtures(record);
  refreshCoverage(record);
  return { record, expectedIdentity };
}

test('oracle workload scenes retain exact four-cell composition, canonical alert ids, and monitor sources', () => {
  const maximum = buildGridScene({ rowsPerCell: 100_000, seed });
  const full = buildGridScene({ rowsPerCell: 256, seed });
  for (const [scene, count] of [
    [maximum, 100_000],
    [full, 256],
  ]) {
    assert.equal(scene.cells.length, 4);
    assert.equal(scene.gridWorkspace.schema, 'filtix-terminal-grid');
    assert.equal(scene.gridWorkspace.providerId, 'filtix-grid-workload-v1');
    assert.equal(scene.monitorSources.length, 8);
    for (const cell of scene.cells) {
      assert.equal(cell.rows.length, count);
      assert.equal(cell.studies.length, 5);
      assert.equal(cell.drawings.drawings.length, 50);
      assert.equal(cell.alerts.alerts.length, 25);
      assert.ok(
        cell.alerts.alerts.every((rule, index) => rule.id === `grid-workload:${cell.id}:${index + 1}`),
      );
    }
  }
  assert.equal(full.fullParkedOnceDelivery.expectedAlertId, 'grid-workload:cell-4:17');
});

test('maximum expected checkpoints retain 16 indices, full source hashes, and independent study truth', () => {
  const scene = buildGridScene({ rowsPerCell: 100_000, seed });
  const checkpoint = expectedCheckpoint(scene, scene.mutations, {
    id: 'max-construction-1',
    scope: 'maximum-sampled',
  });
  assert.equal(checkpoint.cells.length, 4);
  for (const cell of checkpoint.cells) {
    assert.equal(cell.source.rows, 100_000);
    assert.match(cell.source.expectedSha256, /^[a-f0-9]{64}$/);
    assert.equal(cell.rendered.length, 16);
    assert.equal(new Set(cell.rendered.map((sample) => sample.index)).size, 16);
    assert.deepEqual(Object.keys(cell.rendered[0].studies).sort(), [
      'bollinger',
      'ema',
      'macd',
      'rsi',
      'sma',
    ]);
    assert.deepEqual(Object.keys(cell.rendered[0].fill).sort(), ['lower', 'upper']);
    assert.equal(cell.drawings.document.drawings.length, 50);
    assert.equal(cell.alerts.document.alerts.length, 25);
  }
});

test('full oracle produces 12 checkpoints covering exactly 12,288 rows and native fill outputs', () => {
  const scene = buildGridScene({ rowsPerCell: 256, seed });
  let total = 0;
  for (let checkpointIndex = 0; checkpointIndex < 12; checkpointIndex++) {
    const checkpoint = expectedCheckpoint(scene, [], {
      id: fullIds[checkpointIndex],
      scope: 'full-256',
      indices: Array.from({ length: 256 }, (_, index) => index),
      mutationPrefix: 0,
    });
    assert.equal(checkpoint.cells.length, 4);
    total += checkpoint.cells.reduce((sum, cell) => sum + cell.rendered.length, 0);
    for (const cell of checkpoint.cells)
      assert.ok(
        cell.rendered.every((sample) => sample.fill && 'upper' in sample.fill && 'lower' in sample.fill),
      );
  }
  assert.equal(total, 12 * 4 * 256);
});

test('a complete synthetic full evidence control passes trusted identity and all 12 checkpoints', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.slice(0, 40).join('\n'));
});

test('grid evidence rejects a missing charts shim even when the trusted list also omits it', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const name = '@filtix/charts';
  const missing = 'package/dist/internal.js';
  for (const archives of [record.identity.archives, expectedIdentity.installRecord.archives]) {
    const chart = archives.find((archive) => archive.name === name);
    chart.members = chart.members.filter((member) => member.path !== missing);
  }
  expectedIdentity.installed.members = 44;
  expectedIdentity.installed.identities = expectedIdentity.installed.identities.filter(
    (item) => item.path !== 'examples/react-terminal/node_modules/@filtix/charts/dist/internal.js',
  );
  for (const verification of record.identity.verifications)
    verification.archivesSha256 = digest(JSON.stringify(record.identity.archives));
  const result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('trusted installed cohort is not nine archives and 45 members'));
  assert.ok(result.errors.includes('@filtix/charts missing member package/dist/internal.js'));
});

test('full evidence rejects each missing scalar output and native fill independently', async (t) => {
  const { record, expectedIdentity } = makeFullRecord();
  const cases = [
    ['SMA', 'terminal-study-1'],
    ['EMA', 'terminal-study-2'],
    ['RSI', 'terminal-study-3'],
    ['MACD line', 'terminal-study-4-macd'],
    ['MACD signal', 'terminal-study-4-signal'],
    ['MACD histogram', 'terminal-study-4-histogram'],
    ['Bollinger middle', 'terminal-study-5-middle'],
    ['Bollinger upper', 'terminal-study-5-upper'],
    ['Bollinger lower', 'terminal-study-5-lower'],
    ['native Bollinger fill', 'terminal-study-5-fill'],
  ];
  for (const [label, seriesId] of cases) {
    await t.test(label, () => {
      const bad = structuredClone(record);
      const point = bad.checkpoints[0].observed.cells[0].rendered.find((item) => item.index === 199);
      delete point.points[seriesId];
      const result = validateGridEvidence(bad, { expectedIdentity });
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((error) => error.toLowerCase().includes(label.toLowerCase().split(' ')[0])),
        result.errors.join('\n'),
      );
    });
  }
});

test('full evidence independently rejects source hash, row count, and installed member hash defects', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const hashBad = structuredClone(record);
  hashBad.checkpoints[0].observed.cells[0].source.terminalDataSha256 = '0'.repeat(64);
  assert.ok(
    validateGridEvidence(hashBad, { expectedIdentity }).errors.some((item) =>
      item.includes('actual terminal full OHLCV hash'),
    ),
  );
  const countBad = structuredClone(record);
  countBad.checkpoints[0].observed.cells[0].rendered.pop();
  assert.ok(
    validateGridEvidence(countBad, { expectedIdentity }).errors.some((item) =>
      item.includes('rendered observation count incomplete'),
    ),
  );
  const memberBad = structuredClone(record);
  memberBad.identity.archives[0].members[0].installedSha256 = '0'.repeat(64);
  assert.ok(
    validateGridEvidence(memberBad, { expectedIdentity }).errors.some((item) =>
      item.includes('installed bytes differ'),
    ),
  );
});

test('action evidence rejects duplicate RAF ids, inconsistent callback sums, and nonfinite timings independently', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const frame = {
    receiptId: 'raf-1',
    chartGeneration: 1,
    at: 100,
    callbackMs: 2,
    affectedCharts: [
      {
        cellId: 'cell-1',
        before: { sceneDraws: 0, overlayDraws: 0, primitiveDraws: 0 },
        after: { sceneDraws: 1, overlayDraws: 1, primitiveDraws: 1 },
      },
    ],
  };
  const first = { ...receipt('action-1'), renderWorkMs: 2, libraryWorkMs: 3, frames: [frame] };
  const duplicate = {
    ...receipt('action-2'),
    renderWorkMs: 2,
    libraryWorkMs: 3,
    frames: [structuredClone(frame)],
  };
  const duplicateBad = structuredClone(record);
  duplicateBad.actions.interaction = [first, duplicate];
  assert.ok(
    validateGridEvidence(duplicateBad, { expectedIdentity }).errors.some((item) =>
      item.includes('duplicate/missing RAF receipt ID'),
    ),
  );
  const sumBad = structuredClone(record);
  sumBad.actions.interaction = [{ ...first, libraryWorkMs: 4 }];
  assert.ok(
    validateGridEvidence(sumBad, { expectedIdentity }).errors.some((item) =>
      item.includes('library work must count each RAF callback once'),
    ),
  );
  const timingBad = structuredClone(record);
  timingBad.actions.interaction = [{ ...receipt(), synchronousMs: Number.NaN }];
  assert.ok(
    validateGridEvidence(timingBad, { expectedIdentity }).errors.some((item) =>
      item.includes('raw timing values must be finite'),
    ),
  );
});

test('resource evidence rejects independently measured structural growth', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const bad = structuredClone(record);
  bad.resources.find((item) => item.label === 'full-mounted-final').dom.nodes++;
  assert.ok(
    validateGridEvidence(bad, { expectedIdentity }).errors.some((item) =>
      item.includes('structural DOM growth must be <=0'),
    ),
  );
});

test('resource readiness rejects absent receipts, replaced physical IDs and post-GC cleanup drift', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const observed = record.resources.find((endpoint) => endpoint.label === 'full-mounted-initial');
  assert.equal(Object.hasOwn(observed.readiness.gcAttempts[0].measurements.counters, 'detachedNodes'), false);
  assert.equal(Object.hasOwn(observed.dom, 'cdpDetached'), false);
  assert.equal(validateGridEvidence(record, { expectedIdentity }).valid, true);
  const cases = [
    {
      name: 'missing raw receipt',
      change: (endpoint) => {
        delete endpoint.readiness;
      },
      message: 'raw bounded readiness receipt missing',
    },
    {
      name: 'same-query physical replacement during GC',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].post.provider.subscriptions[0].subscriptionId = 999;
      },
      message: 'physical pre/post-GC ownership identity differs',
    },
    {
      name: 'fabricated accepted post-GC provider count',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].post.provider.latestFeeds = 7;
      },
      message: 'physical pre/post-GC ownership identity differs',
    },
    {
      name: 'unrecorded endpoint subscription swap',
      change: (endpoint) => {
        endpoint.provider.subscriptions[0].subscriptionId = 999;
      },
      message: 'accepted endpoint differs from post-GC physical snapshot',
    },
    {
      name: 'raw GC DOM count differs from accepted endpoint',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.counters.nodes++;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'CDP detached field appears only in raw counters',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.counters.detachedNodes = 0;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'raw GC heap differs from accepted endpoint',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.heap.usedSize++;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'raw GC owned DOM differs from accepted endpoint',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.domOwned.totalOwned.consumer++;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'raw GC tracker differs from accepted endpoint',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.resourceTracker.timers++;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'missing raw GC counters',
      change: (endpoint) => {
        delete endpoint.readiness.gcAttempts[0].measurements.counters;
      },
      message: 'accepted endpoint differs from raw three-GC measurements',
    },
    {
      name: 'accepted receipt exceeds the thirty-second deadline',
      change: (endpoint) => {
        endpoint.readiness.completedAt = endpoint.readiness.startedAt + 30000;
      },
      message: 'raw bounded readiness receipt missing',
    },
    {
      name: 'fixture pre-GC observation predates collection',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].pre.at = endpoint.readiness.startedAt - 1;
      },
      message: 'browser snapshot chronology differs',
    },
    {
      name: 'missing Node request bracket',
      change: (endpoint) => {
        delete endpoint.readiness.polls[0].requestStartedAt;
      },
      message: 'Node readiness chronology differs',
    },
    {
      name: 'inverted Node response bracket',
      change: (endpoint) => {
        endpoint.readiness.polls[0].responseReceivedAt = endpoint.readiness.polls[0].requestStartedAt - 1;
      },
      message: 'Node readiness chronology differs',
    },
    {
      name: 'overlapping Node poll and pre-GC request',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].preRequestStartedAt = endpoint.readiness.polls[0].requestStartedAt;
      },
      message: 'Node readiness chronology differs',
    },
    {
      name: 'GC measurement before Node pre-GC response',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].measurements.preparedAt =
          endpoint.readiness.gcAttempts[0].preResponseReceivedAt - 1;
      },
      message: 'raw three-GC measurement timestamps missing/out of order',
    },
    {
      name: 'poll RPC interleaves with three-GC measurement',
      change: (endpoint) => {
        endpoint.readiness.polls.push({
          ...structuredClone(endpoint.readiness.polls[0]),
          at: 899994,
          requestStartedAt: 899993,
          responseReceivedAt: 899994,
          snapshot: { ...structuredClone(endpoint.readiness.polls[0].snapshot), at: 899993 },
        });
      },
      message: 'Node readiness chronology differs',
    },
    {
      name: 'browser clock moves backward during GC',
      change: (endpoint) => {
        endpoint.readiness.gcAttempts[0].post.at = endpoint.readiness.gcAttempts[0].pre.at - 1;
      },
      message: 'browser snapshot chronology differs',
    },
  ];
  for (const item of cases) {
    const invalid = structuredClone(record);
    item.change(invalid.resources.find((endpoint) => endpoint.label === 'full-mounted-initial'));
    const result = validateGridEvidence(invalid, { expectedIdentity });
    assert.equal(result.valid, false, item.name);
    assert.ok(
      result.errors.some((error) => error.includes(item.message)),
      `${item.name}: ${result.errors.join('\n')}`,
    );
  }
  const cleanup = structuredClone(record);
  cleanup.resources
    .find((endpoint) => endpoint.label === 'full-empty-final')
    .readiness.gcAttempts[0].post.provider.subscriptions.push({
      subscriptionId: 99,
      providerGeneration: 1,
      query: { symbol: 'BTCUSDT', interval: '1m' },
      key: '["BTCUSDT","1m"]',
      openedAt: 1,
      releasedAt: null,
    });
  const invalidCleanup = validateGridEvidence(cleanup, { expectedIdentity });
  assert.equal(invalidCleanup.valid, false);
  assert.ok(invalidCleanup.errors.some((error) => error.includes('full-empty-final')));
  const latePreparation = structuredClone(record);
  const baseline = latePreparation.resources.find((endpoint) => endpoint.label === 'full-empty-baseline');
  latePreparation.environment.automationPreparation.completedAt = baseline.readiness.startedAt + 1;
  assert.ok(
    validateGridEvidence(latePreparation, { expectedIdentity }).errors.some((error) =>
      error.includes('automation preparation must precede the first empty resource baseline'),
    ),
  );
});

test('labels-only soak is rejected and diagnoses omitted/nonfinite cadence', () => {
  const { expectedIdentity, identity } = identityPair();
  const record = {
    schema: 'filtix-grid-installed-evidence',
    version: 1,
    mode: 'soak',
    identity,
    scene: {
      providerId: 'filtix-grid-workload-v1',
      host: { width: 1600, height: 1000 },
      layout: 4,
      monitorQueryCount: 8,
    },
    checkpoints: [],
    actions: { ...emptyActions(), soak: [receipt('soak-1')] },
    resources: [{ sampleKind: 'transient-feed', cells: [], provider: {}, monitor: {} }],
    coverage: {
      soakElapsedMs: 120_000,
      soakCadence: [{ targetAt: 10, dispatchedAt: 11, completedAt: 12 }],
      lifecycleCounts: { parkCycles: 10, activeChanges: 20, restores: 10, destroyRecreates: 6 },
      renderedCoverageLabels: {},
    },
    cleanup: cleanup(),
    failures: [],
  };
  assert.equal(validateGridEvidence(record, { expectedIdentity }).valid, false);
  const omitted = structuredClone(record);
  omitted.coverage.soakCadence = [];
  assert.ok(
    validateGridEvidence(omitted, { expectedIdentity }).errors.some((item) =>
      item.includes('soak cadence evidence is omitted'),
    ),
  );
  const nonfinite = structuredClone(record);
  nonfinite.coverage.soakCadence[0].completedAt = Number.POSITIVE_INFINITY;
  assert.ok(
    validateGridEvidence(nonfinite, { expectedIdentity }).errors.some((item) =>
      item.includes('soak cadence delivery timestamps must be finite'),
    ),
  );
});

test('coverage rejects unsupported exhaustive 100k and 400/32 performance claims', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const bad = structuredClone(record);
  bad.coverage.renderedCoverageLabels.capacity = { label: '400 rules/32 queries performance accepted' };
  const result = validateGridEvidence(bad, { expectedIdentity });
  assert.ok(
    result.errors.some((item) => item.includes('capacity correctness does not prove400/32 performance')),
  );
});

test('regression: chronological drawing edits stay in their original market', () => {
  const scene = buildGridScene({ rowsPerCell: 256 });
  const cell = scene.cells[1];
  const alternate = scene.alternateSources.find((item) => item.cellId === cell.id);
  const drawing = cell.drawings.drawings[0];
  const points = drawing.points.map((point) => ({ ...point, price: point.price + 1 }));
  const mutations = [
    {
      sequence: 0,
      cellId: cell.id,
      operation: 'drawing-edit',
      drawingId: drawing.id,
      drawingPatch: { points },
    },
    { sequence: 1, cellId: cell.id, operation: 'market-switch', query: alternate.query },
  ];
  const checkpoint = expectedCheckpoint(scene, mutations, {
    id: 'test',
    scope: 'full-256',
    indices: Array.from({ length: 256 }, (_, i) => i),
  });
  const got = checkpoint.cells[1];
  assert.deepEqual(got.drawings.document, alternate.drawings);
  assert.deepEqual(
    got.workspace.markets.find((item) => JSON.stringify(item.query) === JSON.stringify(cell.query)).drawings
      .drawings[0].points,
    points,
  );
  assert.deepEqual(got.alerts.document, cell.alerts);
});

test('regression: named checkpoints cannot substitute for actual transitions', () => {
  const { record, expectedIdentity } = makeLegacyFullRecord();
  assert.equal(validateGridEvidence(record, { expectedIdentity }).valid, false);
});

test('regression: raw endpoint spans cannot be understated', () => {
  const { record, expectedIdentity } = makeFullRecord();
  record.actions.interaction.push({ ...receipt(), returnedAt: 100012, settledAt: 200013 });
  assert.ok(
    validateGridEvidence(record, { expectedIdentity }).errors.some((error) =>
      /raw.*duration|duration.*raw/.test(error),
    ),
  );
});
function makeCapacityRecord() {
  const { identity, expectedIdentity } = identityPair(),
    scene = buildGridScene({ rowsPerCell: 256 });
  const queries = Array.from({ length: 32 }, (_, index) => ({
    symbol: `CAP${String(index + 1).padStart(2, '0')}`,
    interval: '1m',
  }));
  const documents = scene.cells.map((cell, cellIndex) => ({
    ...cell.alerts,
    nextRuleId: 101,
    alerts: Array.from({ length: 100 }, (_, index) => ({
      ...cell.alerts.alerts[0],
      id: `${cell.alerts.scopeId}:${index + 1}`,
      query: queries[(cellIndex * 8 + index) % 32],
      status: 'armed',
      frequency: 'repeat',
      triggerCount: 0,
      lastTrigger: null,
    })),
  }));
  const monitor = monitorFixture(queries);
  monitor.cachedRuleEntries = 400;
  const provider = {
    ...providerFixture(
      scene.cells.map((cell) => cell.query),
      queries,
    ),
    monitor,
  };
  const workspace = {
    ...scene.gridWorkspace,
    cells: scene.cells.map((cell, index) => ({
      id: cell.id,
      workspace: { ...cell.workspace, alerts: documents[index] },
    })),
  };
  const admitted = { monitor, provider };
  const before = { workspace, state: { layout: 4 }, provider };
  const failures = ['catalog-boundary', 'rule-overflow', 'external-same-scope-lease'].map((kind) => {
    const attempted = structuredClone(workspace),
      initial = structuredClone(before);
    if (kind === 'catalog-boundary')
      attempted.cells[0].workspace.alerts.alerts[0].query = { symbol: 'CAP33', interval: '1m' };
    if (kind === 'rule-overflow')
      attempted.cells[0].workspace.alerts.alerts.push({
        ...attempted.cells[0].workspace.alerts.alerts[0],
        id: 'extra:101',
      });
    if (kind === 'external-same-scope-lease') initial.provider.monitor.leaseEntries++;
    return {
      scope: 'capacity-400-rules-32-queries',
      kind,
      attempted,
      error: 'Actual synthetic rejection for ' + kind,
      before: initial,
      after: structuredClone(initial),
    };
  });
  const record = {
    schema: 'filtix-grid-installed-evidence',
    version: 1,
    mode: 'capacity',
    identity,
    environment: environmentFixture(),
    scene: {
      providerId: 'filtix-grid-workload-v1',
      host: { width: 1600, height: 1000 },
      layout: 4,
      monitorQueryCount: 8,
      scopes: {},
    },
    checkpoints: [],
    actions: emptyActions(),
    resources: [
      endpointFixture('capacity-empty-baseline', scene, false),
      endpointFixture('capacity-final', scene, false),
    ],
    coverage: { renderedCoverageLabels: {} },
    cleanup: cleanupFixture('capacity-final'),
    failures: [],
    capacity: {
      rules: 400,
      armedQueries: 32,
      restoreObservations: [
        {
          scope: 'capacity-400-rules-32-queries',
          restored: renderReceipt({ ...receipt('capacity-restore'), kind: 'construct' }),
          admitted,
          documents,
        },
      ],
      failedAtomicity: failures,
      leaseObservations: [
        {
          scope: 'capacity-400-rules-32-queries',
          before: monitor,
          after: { monitor },
          externalLeaseAttempt: failures[2],
        },
      ],
    },
  };
  if (scene && record.mode !== 'capacity') semanticFixtures(record, scene);
  requestFixtures(record);
  refreshCoverage(record);
  return { record, expectedIdentity };
}

function makeMaximumRecord() {
  const { identity, expectedIdentity } = identityPair(),
    scene = buildGridScene({ rowsPerCell: 100000 }),
    scope = scopeFixture(scene);
  const record = {
    schema: 'filtix-grid-installed-evidence',
    version: 1,
    mode: 'soak',
    identity,
    environment: environmentFixture(),
    scene: {
      providerId: 'filtix-grid-workload-v1',
      host: { width: 1600, height: 1000 },
      layout: 4,
      monitorQueryCount: 8,
      gridWorkspace: scene.gridWorkspace,
      scopes: { maximum: scope },
    },
    checkpoints: [],
    actions: emptyActions(),
    resources: [],
    coverage: {
      maxCheckpoints: 12,
      maxRenderedObservations: 768,
      constructionSamples: 3,
      restoreSamples: 3,
      tailSamples: 200,
      interactionSamples: 240,
      wheelSamples: 24,
      syncSamples: 48,
      soakCadence: [],
      renderedCoverageLabels: {
        maximum: { scope: 'maximum-sampled', label: 'sampled100k rendered outputs', exhaustive: false },
      },
    },
    cleanup: cleanupFixture('max-empty-final'),
    failures: [],
  };
  let clock = 1000,
    cpId = 'max-construction-1';
  const rows = new Map(scene.cells.map((cell) => [cell.id, structuredClone(cell.rows)]));
  const latest = new Map(
    [...scene.monitorSources, ...scene.cells].map((item) => [key(item.query), item.rows.at(-1)]),
  );
  const add = (operation, cellId, detail = {}) => {
    const m = {
      checkpointId: cpId,
      sequence: scope.mutations.length,
      operation,
      cellId,
      ...structuredClone(detail),
    };
    scope.mutations.push(m);
    if (cellId) scope.sourceRows.find((item) => item.cellId === cellId).orderedMutations.push(m);
  };
  const act = (category, id, kind, detail = {}) => {
    clock += 40;
    const item = {
      ...receipt(id),
      kind,
      phase: category === 'soak' ? 'maximum-soak' : 'maximum',
      targetAt: clock,
      dispatchedAt: clock,
      returnedAt: clock + 1,
      settledAt: clock + 2,
      affectedCellIds: ids,
      ...detail,
    };
    renderReceipt(item);
    record.actions[category].push(item);
    return item;
  };
  const hydration = () => ({
    cells: scene.cells.map((cell) => ({
      cellId: cell.id,
      query: cell.query,
      rows: 100000,
      feed: { query: cell.query, status: 'live' },
    })),
    monitor: monitorFixture(scene.monitorSources.map((item) => item.query)),
  });
  const construct = (category, id, kind = 'construct') => {
    const item = act(category, id, kind);
    Object.assign(item, {
      restoreFulfilledAt: clock + 1.2,
      restoreFulfilledMs: 1.2,
      hydratedAt: clock + 1.5,
      hydratedMs: 1.5,
      hydration: hydration(),
    });
    return item;
  };
  const deliver = (category, id, inputs) => {
    const item = act(category, id, 'deliver', {
      deliveries: inputs.map((input) => ({ key: key(input.query), bar: input.bar, handlers: 2 })),
    });
    inputs.forEach((input, index) => {
      add('monitor-update', null, {
        deliveryId: `${id}:${index + 1}`,
        query: input.query,
        bar: input.bar,
        previousPrice: latest.get(key(input.query)).close,
        dispatchedAt: item.dispatchedAt,
      });
      latest.set(key(input.query), input.bar);
    });
    return item;
  };
  const capture = () => {
    const expected = expectedCheckpoint(scene, scope.mutations, { id: cpId, scope: 'maximum-sampled' });
    const cells = expected.cells.map((cell) => {
      const drawing = projectedGeometry(cell, rows.get(cell.id)),
        observed = structuredClone(cell);
      const stamp = (value) => {
        if (Array.isArray(value)) value.forEach(stamp);
        else if (value && typeof value === 'object') {
          if (value.occurrence && value.observedAt === undefined) value.observedAt = clock + 1;
          Object.values(value).forEach(stamp);
        }
      };
      stamp(observed);
      return {
        id: cell.id,
        query: cell.query,
        source: {
          rows: 100000,
          firstTime: cell.source.firstTime,
          lastTime: cell.source.lastTime,
          terminalDataSha256: cell.source.expectedSha256,
        },
        rendered: actualRendered(cell, cell),
        drawings: { document: cell.drawings.document, geometry: drawing.geometry },
        drawingObservation: drawing.drawingObservation,
        alerts: { document: observed.alerts.document, events: observed.alerts.expected },
        workspace: observed.workspace,
        seriesCount: 12,
        paneCount: 4,
      };
    });
    record.checkpoints.push({
      id: cpId,
      scope: 'maximum-sampled',
      rowsPerCell: 100000,
      mutationPrefix: scope.mutations.length,
      expected,
      observed: { at: clock + 3, wallClockAt: clock + 3, cells },
    });
  };
  construct('warmup', 'warmup');
  for (let i = 1; i <= 3; i++) {
    cpId = `max-construction-${i}`;
    construct('constructions', cpId);
    capture();
  }
  for (let i = 1; i <= 3; i++) {
    cpId = `max-restore-${i}`;
    construct('restores', cpId, 'restore');
    capture();
  }
  cpId = 'max-replacements';
  for (let batch = 0; batch < 100; batch++) {
    const inputs = scene.cells.map((cell) => {
      const bar = rows.get(cell.id).at(-1);
      return { query: cell.query, bar: { ...bar, close: bar.close + (batch % 2 ? -0.001 : 0.001) } };
    });
    deliver('tailReplace', `replace-${batch}`, inputs);
    scene.cells.forEach((cell, index) => {
      rows.get(cell.id)[99999] = inputs[index].bar;
      add('replace', cell.id, { index: 99999, bar: inputs[index].bar });
    });
  }
  capture();
  cpId = 'max-append-replacements';
  scene.cells.forEach((cell) => {
    rows.set(cell.id, cell.rows.slice(0, 99900));
    add('source-reset', cell.id, { rowCount: 99900 });
    latest.set(key(cell.query), cell.rows[99899]);
  });
  add('monitor-baseline-reset', null, {
    baselines: [...latest].map(([k, bar]) => {
      const [symbol, interval] = JSON.parse(k);
      return { query: { symbol, interval }, bar };
    }),
  });
  for (let batch = 0; batch < 100; batch++) {
    const inputs = scene.cells.map((cell) => ({ query: cell.query, bar: { ...cell.rows[99900 + batch] } }));
    const updates = inputs.map((input) => ({
      query: input.query,
      bar: { ...input.bar, close: input.bar.close + 0.001 },
    }));
    deliver('tailAppendReplace', `append-${batch}`, [...inputs, ...updates]);
    scene.cells.forEach((cell, index) => {
      rows.get(cell.id).push(updates[index].bar);
      add('append', cell.id, { bar: inputs[index].bar });
      add('replace', cell.id, { index: 99900 + batch, bar: updates[index].bar });
    });
  }
  capture();
  cpId = 'max-interactions';
  for (const cell of scene.cells)
    for (let index = 0; index < 60; index++) {
      const kind = index < 40 ? 'gesture' : index < 50 ? 'drawing' : 'pane';
      const detail = {
        affectedCellIds: ids,
        targetCellId: cell.id,
        requested: { cellId: cell.id, gesture: index < 20 ? 'pan' : index < 40 ? 'zoom' : undefined },
        effectiveObservation: { beforeRange: { from: 0, to: 1000 }, afterRange: { from: 1, to: 1001 } },
        semanticObservation: {
          before: { workspace: { value: index } },
          after: { workspace: { value: index + 1 } },
        },
      };
      act('interaction', `interact-${cell.id}-${index}`, kind, detail);
      if (kind === 'drawing') {
        const drawing = cell.drawings.drawings[index - 40];
        add('drawing-edit', cell.id, {
          drawingId: drawing.id,
          drawingPatch: { points: drawing.points.map((point) => ({ ...point, price: point.price + 0.01 })) },
        });
      }
      if (kind === 'pane')
        add('pane-edit', cell.id, { paneWeights: [index % 2 ? 0.53 : 0.54, 0.16, 0.16, 0.16] });
    }
  for (const cell of scene.cells)
    for (let i = 0; i < 6; i++) {
      const item = act('wheel', `wheel-${cell.id}-${i}`, 'wheel', {
        affectedCellIds: ids,
        targetCellId: cell.id,
        requested: { cellId: cell.id },
        effectiveObservation: { beforeRange: { from: 0, to: 1000 }, afterRange: { from: 1, to: 1001 } },
      });
      Object.assign(item, {
        armedAt: clock - 1,
        pointerPreparation: {
          startedAt: clock - 8,
          initialSettledAt: clock - 7,
          pointerSetupCompletedAt: clock - 6,
          settledAt: clock - 2,
          chartGeneration: item.chartGeneration,
          chartCohortBefore: structuredClone(item.chartCohortBefore),
          chartCohortAfter: structuredClone(item.chartCohortBefore),
          frames: [{ ...structuredClone(item.frames[0]), receiptId: `prep:${item.id}`, at: clock - 5 }],
          renderWorkMs: item.renderWorkMs,
        },
        automationStarted: clock - 9,
        automationCompleted: clock + 3,
        automationInclusiveMs: 12,
      });
    }
  capture();
  for (const match of ['exact', 'nearest']) {
    cpId = `max-sync-${match}`;
    const category = match === 'exact' ? 'syncExact' : 'syncNearest';
    const overlapFrom = Math.max(...scene.cells.map((cell) => rows.get(cell.id)[0].time));
    const overlapTo = Math.min(...scene.cells.map((cell) => rows.get(cell.id).at(-1).time));
    const coarseStep = 3_600_000;
    const span = coarseStep * 12;
    const firstFrom = (overlapFrom + overlapTo) / 2 - (span + coarseStep * 11) / 2;
    const visibleFor = (data, range) => {
      const selected = data.filter((bar) => bar.time >= range.from && bar.time <= range.to);
      assert.ok(selected.length >= 2, 'synthetic sync window must cover each receiver');
      return { from: selected[0].time, to: selected.at(-1).time };
    };
    const currentRanges = new Map(
      scene.cells.map((cell) => [
        cell.id,
        visibleFor(rows.get(cell.id), {
          from: firstFrom - coarseStep,
          to: firstFrom - coarseStep + span,
        }),
      ]),
    );
    let rangeOrdinal = 0;
    for (const cell of scene.cells)
      for (let index = 0; index < 6; index++) {
        const kind = index % 2 ? 'cursor' : 'range',
          sourceRows = rows.get(cell.id);
        const from = firstFrom + (kind === 'range' ? rangeOrdinal++ : rangeOrdinal - 1) * coarseStep;
        const range = { from, to: from + span };
        const center = (range.from + range.to) / 2;
        const time = sourceRows.find((bar) => bar.time >= center).time;
        const requested = {
          kind,
          match,
          sourceCellId: cell.id,
          ...(kind === 'cursor' ? { time } : { range }),
        };
        const before = scene.cells.map((target) => ({
          cellId: target.id,
          query: target.query,
          timeRange: currentRanges.get(target.id),
        }));
        const observation = {
          sourceCellId: cell.id,
          match,
          requested,
          before,
          after: structuredClone(before),
          rangeEvents: [],
          crosshairEvents: [],
          afterCrosshair: [],
        };
        if (kind === 'range') {
          const sourceRange = visibleFor(sourceRows, requested.range);
          for (const target of scene.cells) {
            const next = visibleFor(rows.get(target.id), sourceRange);
            observation.after.find((item) => item.cellId === target.id).timeRange = next;
            currentRanges.set(target.id, next);
          }
        } else
          for (const target of scene.cells) {
            const data = rows.get(target.id);
            let bar = data.find((bar) => bar.time === time);
            if (!bar && match === 'nearest')
              bar = data.reduce(
                (best, item) => (Math.abs(item.time - time) < Math.abs(best.time - time) ? item : best),
                data[0],
              );
            const visible = currentRanges.get(target.id);
            if (bar && (bar.time < visible.from || bar.time > visible.to)) bar = undefined;
            const value = {
              cellId: target.id,
              query: target.query,
              time: bar?.time ?? null,
              points: bar
                ? { 'terminal-price': bar, 'terminal-volume': null }
                : { 'terminal-price': null, 'terminal-volume': null },
            };
            observation.afterCrosshair.push(value);
          }
        const syncReceipt = act(category, `sync-${match}-${cell.id}-${index}`, kind, {
          phase: `sync-${match}`,
          syncObservation: observation,
        });
        if (kind === 'range')
          for (const target of observation.after) {
            const beforeRange = observation.before.find((item) => item.cellId === target.cellId).timeRange;
            if (JSON.stringify(beforeRange) !== JSON.stringify(target.timeRange)) {
              const data = rows.get(target.cellId);
              observation.rangeEvents.push({
                cellId: target.cellId,
                range: {
                  from: data.findIndex((bar) => bar.time === target.timeRange.from),
                  to: data.findIndex((bar) => bar.time === target.timeRange.to),
                },
                at: syncReceipt.dispatchedAt + 1,
                meta: { cause: 'api', revision: 1, hasOrigin: target.cellId !== cell.id },
              });
            }
          }
        else
          for (const value of observation.afterCrosshair)
            observation.crosshairEvents.push({
              cellId: value.cellId,
              time: value.time,
              points: structuredClone(value.points),
              at: syncReceipt.dispatchedAt + 1,
              meta: { cause: 'api', revision: 1, hasOrigin: value.cellId !== cell.id },
            });
      }
    add('sync', null, { match });
    capture();
  }
  cpId = 'max-soak';
  record.soakStartedAt = clock + 40;
  for (let index = 0; index < 360; index++) {
    const inputs = scene.cells.map((cell) => ({ query: cell.query, bar: { ...rows.get(cell.id).at(-1) } }));
    for (const monitor of scene.monitorSources)
      inputs.push({ query: monitor.query, bar: { ...latest.get(key(monitor.query)) } });
    const item = deliver('soak', `soak-${index}`, inputs);
    // This witness records missed cadence caused by lifecycle pauses; no rate claim.
    if (index === 359) {
      item.dispatchedAt += 105680;
      item.returnedAt += 105680;
      item.settledAt += 105680;
      item.frames[0].at += 105680;
      for (const mutation of scope.mutations.filter((m) => m.deliveryId?.startsWith(item.id + ':')))
        mutation.dispatchedAt = item.dispatchedAt;
    }
    scene.cells.forEach((cell) => {
      const bar = inputs.findLast((input) => key(input.query) === key(cell.query)).bar;
      rows.get(cell.id)[99999] = bar;
      add('replace', cell.id, { index: 99999, bar });
    });
    record.coverage.soakCadence.push({
      phase: 'soak',
      targetAt: item.targetAt,
      dispatchedAt: item.dispatchedAt,
      completedAt: item.settledAt,
    });
  }
  record.soakCompletedAt = record.actions.soak.at(-1).settledAt;
  record.coverage.soakElapsedMs = record.soakCompletedAt - record.soakStartedAt;
  record.soakPauses = [];
  let pauseAt = record.actions.soak[358].settledAt;
  const lifecycleReceipt = (id, kind) =>
    renderReceipt({
      ...receipt(id),
      kind,
      phase: 'soak-lifecycle',
      targetAt: pauseAt,
      dispatchedAt: pauseAt,
      returnedAt: pauseAt + 1,
      settledAt: pauseAt + 2,
      affectedCellIds: ids,
    });
  for (const [kind, count] of [
    ['park-cycle', 10],
    ['active-change', 20],
    ['save-restore', 10],
    ['destroy-recreate', 6],
  ])
    for (let i = 0; i < count; i++) {
      const duration = 1000;
      record.soakPauses.push({ kind, startedAt: pauseAt, completedAt: pauseAt + duration });
      if (kind === 'park-cycle')
        record.actions.lifecycle.push({
          kind,
          one: lifecycleReceipt(`park-${i}`, 'layout'),
          four: lifecycleReceipt(`unpark-${i}`, 'layout'),
        });
      if (kind === 'active-change') record.actions.lifecycle.push(lifecycleReceipt(`active-${i}`, 'active'));
      if (kind === 'save-restore')
        record.actions.lifecycle.push(lifecycleReceipt(`soak-restore-${i}`, 'restore'));
      if (kind === 'destroy-recreate')
        record.actions.lifecycle.push({
          kind,
          receipt: lifecycleReceipt(`recreate-${i}`, 'construct'),
          retired: { after: { provider: providerFixture() } },
        });
      pauseAt += duration;
    }
  record.soakEffectiveRunningMs =
    record.coverage.soakElapsedMs -
    record.soakPauses.reduce((sum, item) => sum + item.completedAt - item.startedAt, 0);
  record.coverage.lifecycleCounts = { parkCycles: 10, activeChanges: 20, restores: 10, destroyRecreates: 6 };
  clock = record.soakCompletedAt;
  capture();
  record.resources = ['empty-baseline', 'mounted-initial', 'mounted-final', 'empty-final']
    .map((suffix) => endpointFixture('max-' + suffix, scene, suffix.startsWith('mounted')))
    .concat(transientFixtures(scene));
  for (let index = 1; index <= 10; index++) {
    const one = endpointFixture(`soak-layout-1-${index}`, scene);
    one.gridState.layout = 1;
    one.cells = one.cells.map((cell, i) => (i ? { cellId: cell.cellId, feed: null } : cell));
    one.provider = providerFixture(
      [scene.cells[0].query],
      scene.monitorSources.map((item) => item.query),
    );
    one.owned.feeds = 9;
    record.resources.push(attachReadiness(one));
  }
  if (scene && record.mode !== 'capacity') semanticFixtures(record, scene);
  requestFixtures(record);
  refreshCoverage(record);
  return { record, expectedIdentity };
}

test('capacity has an honest admitted400/32 and atomic catalog/rule/lease control', () => {
  const { record, expectedIdentity } = makeCapacityRecord();
  const result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  const mislabeled = structuredClone(record);
  mislabeled.capacity.failedAtomicity[0].kind = 'query-overflow';
  assert.equal(
    validateGridEvidence(mislabeled, { expectedIdentity }).valid,
    false,
    'an out-of-catalog attempt must not claim to prove monitor query overflow',
  );
  const bad = structuredClone(record);
  bad.capacity.restoreObservations[0].documents[0].alerts.pop();
  assert.ok(
    validateGridEvidence(bad, { expectedIdentity }).errors.some((error) =>
      error.includes('actual documents'),
    ),
  );
});

test('complete all, max and soak controls satisfy the exact maximum workload and raw gates', () => {
  const { record, expectedIdentity } = makeMaximumRecord();
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.slice(0, 60).join('\n'));
  const full = makeFullRecord().record,
    capacity = makeCapacityRecord().record;
  const all = {
    ...record,
    mode: 'all',
    scene: { ...record.scene, scopes: { ...record.scene.scopes, ...full.scene.scopes } },
    checkpoints: [...record.checkpoints, ...full.checkpoints],
    actions: { ...record.actions, lifecycle: [...record.actions.lifecycle, ...full.actions.lifecycle] },
    resources: [...record.resources, ...full.resources, ...capacity.resources],
    capacity: capacity.capacity,
    cleanup: capacity.cleanup,
    coverage: {
      ...record.coverage,
      ...full.coverage,
      renderedCoverageLabels: {
        ...record.coverage.renderedCoverageLabels,
        ...full.coverage.renderedCoverageLabels,
      },
    },
  };
  all.providerRequests = [
    ...record.providerRequests,
    ...full.providerRequests,
    ...capacity.providerRequests,
  ].map((item, index) => ({ ...item, id: `request-${index + 1}` }));
  const allFinal = all.resources.find((item) => item.label === all.cleanup.finalResourceLabel);
  allFinal.provider.requests = all.providerRequests.length;
  allFinal.readiness.gcAttempts.at(-1).post.provider.requests = all.providerRequests.length;
  result = validateGridEvidence(refreshCoverage(all), { expectedIdentity });
  assert.equal(result.valid, true, result.errors.slice(0, 60).join('\n'));
  const max = {
    ...record,
    mode: 'max',
    checkpoints: record.checkpoints.slice(0, 11),
    actions: {
      ...record.actions,
      soak: [],
      lifecycle: record.actions.lifecycle.filter((item) => item.kind === 'source-reset'),
    },
    scene: {
      ...record.scene,
      scopes: {
        maximum: {
          ...record.scene.scopes.maximum,
          mutations: record.scene.scopes.maximum.mutations.slice(0, record.checkpoints[10].mutationPrefix),
          sourceRows: record.scene.scopes.maximum.sourceRows.map((source) => ({
            ...source,
            orderedMutations: source.orderedMutations.filter(
              (item) => item.sequence < record.checkpoints[10].mutationPrefix,
            ),
          })),
        },
      },
    },
    coverage: { ...record.coverage, maxCheckpoints: 11, maxRenderedObservations: 704 },
  };
  result = validateGridEvidence(refreshCoverage(max), { expectedIdentity });
  assert.equal(result.valid, true, result.errors.slice(0, 60).join('\n'));
});

test('independent O1-O7 regression witnesses reject raw corruption from a valid full control', async (t) => {
  const { record, expectedIdentity } = makeFullRecord();
  const cases = [
    [
      'empty Canvas paths',
      (r) => {
        r.checkpoints[0].observed.cells[0].drawingObservation.groups.forEach(
          (group) => (group.calls = [{ method: 'stroke', args: [], path: [] }]),
        );
      },
      /Canvas paint/,
    ],
    [
      'wrong note bounds',
      (r) => {
        r.checkpoints[0].observed.cells[0].drawings.geometry.find(
          (item) => item.type === 'text-note',
        ).text.bounds = { left: 0, top: 0, right: 1, bottom: 1 };
      },
      /text note bounds differ/,
    ],
    [
      'wrong channel fourth corner',
      (r) => {
        r.checkpoints[0].observed.cells[0].drawingObservation.groups.find((item) =>
          item.sourceId.includes('parallel-channel'),
        ).calls[0].path[2][1] += 50;
      },
      /Canvas paint/,
    ],
    [
      'missing Fibonacci level',
      (r) => {
        r.checkpoints[0].observed.cells[0].drawingObservation.groups
          .find((item) => item.sourceId.includes('fibonacci'))
          .calls.splice(6, 1);
      },
      /Canvas paint/,
    ],
    [
      'raw final provider leak behind zero summary',
      (r) => {
        const final = r.resources.find((item) => item.label === 'full-empty-final');
        final.provider.activeSubscriptions = 99;
      },
      /provider active|provider activeSubscriptions/,
    ],
    [
      'raw latest buffer leak',
      (r) => {
        r.resources.find(
          (item) => item.label === 'full-mounted-final',
        ).monitor.runtimes[0].feed.pendingBarEntries = 198;
      },
      /latest pendingBarEntries/,
    ],
    [
      'raw timer leak behind zero summary',
      (r) => {
        r.resources.find((item) => item.label === 'full-empty-final').timers = 99;
      },
      /raw final timers/,
    ],
    [
      'all checkpoint prefixes zero',
      (r) => {
        r.checkpoints.forEach((cp) => (cp.mutationPrefix = 0));
      },
      /transitions missing|required operation missing/,
    ],
    [
      'wrong immutable seed',
      (r) => {
        r.scene.scopes.full.seed = 1;
      },
      /fixed deterministic seed/,
    ],
    [
      'SMA1 workload reduction',
      (r) => {
        r.scene.scopes.full.cells[0].studies[0].period = 1;
      },
      /fixed initial/,
    ],
    [
      'unobserved pane',
      (r) => {
        r.checkpoints[0].observed.cells[0].drawingObservation.projection.panes.pop();
      },
      /four-pane|pane identities/,
    ],
    [
      'initial historical alert clock rewrite',
      (r) => {
        r.checkpoints[0].observed.cells[0].alerts.document.alerts[23].lastTrigger.observedAt = 0;
      },
      /alert records/,
    ],
    [
      'forged delivered previousPrice',
      (r) => {
        r.scene.scopes.full.mutations.find((item) => item.operation === 'monitor-update').previousPrice += 1;
      },
      /ordered alert baseline/,
    ],
    [
      'hidden measurement interval',
      (r) => {
        r.environment.visibility.push({ state: 'hidden', at: 20 }, { state: 'visible', at: 30 });
      },
      /hidden-tab/,
    ],
    [
      'false native zero-size',
      (r) => {
        r.actions.lifecycle.find(
          (item) => item.id === 'full-zero-size',
        ).effectiveObservation.afterRect.width = 1600;
      },
      /zero-size/,
    ],
    [
      'unresolved feeds replaced by steady zeros',
      (r) => {
        r.resources = r.resources.filter((item) => item.sampleKind !== 'transient-feed');
      },
      /unresolved latest/,
    ],
  ];
  for (const [name, mutate, pattern] of cases)
    await t.test(name, () => {
      const bad = structuredClone(record);
      mutate(bad);
      const result = validateGridEvidence(bad, { expectedIdentity });
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((error) => pattern.test(error)),
        result.errors.join('\n'),
      );
    });
});

test('raw timings reject underreported dispatch/restore/hydration/settlement and untimed rendering', async (t) => {
  const { record, expectedIdentity } = makeFullRecord();
  for (const kind of ['construct', 'restore', 'deliver', 'gesture', 'range'])
    await t.test(kind, () => {
      const bad = structuredClone(record),
        item = renderReceipt({
          ...receipt('false-duration-' + kind),
          kind,
          returnedAt: 100012,
          restoreFulfilledAt: 150012,
          restoreFulfilledMs: 1,
          hydratedAt: 180012,
          hydratedMs: 1,
          settledAt: 200013,
        });
      bad.actions.lifecycle.push(item);
      assert.ok(
        validateGridEvidence(bad, { expectedIdentity }).errors.some((error) => /raw duration/.test(error)),
      );
    });
  const bad = structuredClone(record);
  for (const action of bad.actions.lifecycle) {
    if (action.frames) {
      action.frames = [];
      action.renderWorkMs = 0;
      action.libraryWorkMs = action.synchronousMs;
    }
  }
  assert.ok(
    validateGridEvidence(bad, { expectedIdentity }).errors.some((error) => /no actual RAF work/.test(error)),
  );
});

test('market edit persists after switch back and chronological repeated crossings derive their own baselines', () => {
  const scene = buildGridScene({ rowsPerCell: 256 }),
    cell = scene.cells[1],
    alternate = scene.alternateSources[1],
    drawing = cell.drawings.drawings[0];
  const mutations = [
    {
      sequence: 0,
      cellId: cell.id,
      operation: 'drawing-edit',
      drawingId: drawing.id,
      drawingPatch: { points: drawing.points.map((point) => ({ ...point, price: point.price + 1 })) },
    },
    { sequence: 1, cellId: cell.id, operation: 'market-switch', query: alternate.query },
    { sequence: 2, cellId: cell.id, operation: 'market-switch', query: cell.query },
  ];
  const spec = { id: 'regression', scope: 'full-256', indices: Array.from({ length: 256 }, (_, i) => i) };
  let cp = expectedCheckpoint(scene, mutations, spec);
  assert.equal(cp.cells[1].drawings.document.drawings[0].points[0].price, drawing.points[0].price + 1);
  assert.deepEqual(cp.cells[1].alerts.document, cell.alerts);
  const query = scene.cells[0].query,
    base = scene.cells[0].rows.at(-1),
    threshold = scene.cells[0].alerts.alerts[0].price;
  const values = [threshold + 1, threshold - 1, threshold + 1];
  for (const price of values)
    mutations.push({
      sequence: mutations.length,
      cellId: null,
      operation: 'monitor-update',
      query,
      bar: { ...base, close: price },
    });
  cp = expectedCheckpoint(scene, mutations, spec);
  assert.equal(cp.cells[0].alerts.document.alerts[0].triggerCount, 2);
  assert.equal(
    cp.cells[0].alerts.expected.filter((event) => event.alertId === scene.cells[0].alerts.alerts[0].id)
      .length,
    2,
  );
});

test('provider lifecycle evidence rejects missing ledgers, oversized pages and fabricated abort times', async (t) => {
  const { record, expectedIdentity } = makeFullRecord();
  for (const [name, mutate, pattern] of [
    [
      'missing ledger',
      (r) => {
        delete r.providerRequests;
      },
      /request lifecycle ledger missing/,
    ],
    [
      'oversized public page',
      (r) => {
        r.providerRequests[0].limit = 100001;
      },
      /page limit/,
    ],
    [
      'abort after settled request',
      (r) => {
        r.providerRequests[0].abortObservedAt = 1000;
        r.providerRequests[0].abortReason = 'fabricated later cancellation';
      },
      /abort outside request lifetime/,
    ],
    [
      'unresolved provider request',
      (r) => {
        r.providerRequests[0].status = 'pending';
        delete r.providerRequests[0].finishedAt;
      },
      /remains unresolved/,
    ],
  ])
    await t.test(name, () => {
      const bad = structuredClone(record);
      mutate(bad);
      const verdict = validateGridEvidence(bad, { expectedIdentity });
      assert.equal(verdict.valid, false);
      assert.ok(
        verdict.errors.some((error) => pattern.test(error)),
        verdict.errors.join('\n'),
      );
    });
});

test('soak rejects coherently reordered original inputs with distinct overlapping bars', () => {
  const { record, expectedIdentity } = makeMaximumRecord();
  const scope = record.scene.scopes.maximum;
  const receipt = record.actions.soak[0];
  const positions = scope.mutations.flatMap((mutation, index) =>
    mutation.operation === 'monitor-update' && mutation.deliveryId.startsWith(`${receipt.id}:`)
      ? [index]
      : [],
  );
  const expectedKeys = [
    ...scope.cells.map((cell) => key(cell.query)),
    ...scope.monitorSources.map((source) => key(source.query)),
  ];
  assert.equal(positions.length, 12);
  assert.deepEqual(
    receipt.deliveries.map((delivery) => delivery.key),
    expectedKeys,
  );
  const overlappingIndex = expectedKeys.findIndex((value, index) => index >= 4 && value === expectedKeys[0]);
  assert.ok(overlappingIndex >= 4);

  // The chart delivery and later monitor delivery are original, distinct bars.
  // The later delivery restores the terminal volume, so checkpoint truth stays unchanged.
  const originalBar = { ...receipt.deliveries[0].bar, volume: receipt.deliveries[0].bar.volume + 1 };
  receipt.deliveries[0].bar = structuredClone(originalBar);
  receipt.requested.deliveries[0].bar = structuredClone(originalBar);
  scope.mutations[positions[0]].bar = structuredClone(originalBar);
  assert.notDeepEqual(receipt.deliveries[0].bar, receipt.deliveries[overlappingIndex].bar);
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.slice(0, 60).join('\n'));

  // Swap two independent chart queries in all three ledgers, retaining valid
  // ordinal IDs, mutation sequence numbers, counts, baselines and final outputs.
  const order = [1, 0, ...Array.from({ length: 10 }, (_, index) => index + 2)];
  const originalDeliveries = receipt.deliveries;
  const originalRequested = receipt.requested.deliveries;
  const originalMutations = positions.map((position) => scope.mutations[position]);
  receipt.deliveries = order.map((index) => originalDeliveries[index]);
  receipt.requested.deliveries = order.map((index) => originalRequested[index]);
  positions.forEach((position, index) => {
    scope.mutations[position] = {
      ...originalMutations[order[index]],
      sequence: position,
      deliveryId: `${receipt.id}:${index + 1}`,
    };
  });
  assert.equal(receipt.deliveries.length, 12);
  assert.equal(receipt.deliveries.filter((delivery) => delivery.key === expectedKeys[0]).length, 2);
  assert.deepEqual(
    receipt.deliveries.map((delivery) => delivery.key),
    order.map((index) => expectedKeys[index]),
  );
  assert.deepEqual(
    receipt.requested.deliveries.map((delivery) => key(delivery.query)),
    receipt.deliveries.map((delivery) => delivery.key),
  );
  assert.deepEqual(
    positions.map((position) => scope.mutations[position].deliveryId),
    Array.from({ length: 12 }, (_, index) => `${receipt.id}:${index + 1}`),
  );
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(
    result.valid,
    false,
    'coherently reordered soak inputs must not satisfy the canonical workload',
  );
  assert.ok(
    result.errors.some((error) => /four chart queries then eight monitor queries/.test(error)),
    result.errors.join('\n'),
  );
  for (const [label, replacementIndex] of [
    ['duplicated chart query', 0],
    ['substituted monitor query', 9],
  ]) {
    const invalidOrder = [0, replacementIndex, ...Array.from({ length: 10 }, (_, index) => index + 2)];
    receipt.deliveries = invalidOrder.map((index) => originalDeliveries[index]);
    receipt.requested.deliveries = invalidOrder.map((index) => originalRequested[index]);
    positions.forEach((position, index) => {
      scope.mutations[position] = {
        ...originalMutations[invalidOrder[index]],
        sequence: position,
        deliveryId: `${receipt.id}:${index + 1}`,
      };
    });
    assert.equal(receipt.deliveries.length, 12);
    result = validateGridEvidence(record, { expectedIdentity });
    assert.equal(result.valid, false, label);
    assert.ok(
      result.errors.some((error) => /four chart queries then eight monitor queries/.test(error)),
      result.errors.join('\n'),
    );
  }
});

test('capacity final reconciles tracker and raw counts with a nonzero empty baseline', () => {
  const { record, expectedIdentity } = makeCapacityRecord();
  const baseline = record.resources.find((item) => item.label === 'capacity-empty-baseline');
  const final = record.resources.find((item) => item.label === 'capacity-final');
  for (const endpoint of [baseline, final]) {
    endpoint.listeners = 7;
    endpoint.timers = 2;
    endpoint.observers = 1;
    endpoint.resourceTracker = { timers: 2, observers: 1 };
    endpoint.domOwned.totalOwned.consumer = 3;
    const rawGc = endpoint.readiness.gcAttempts.at(-1).measurements;
    rawGc.counters.jsEventListeners = endpoint.listeners;
    rawGc.resourceTracker = structuredClone(endpoint.resourceTracker);
    rawGc.domOwned = structuredClone(endpoint.domOwned);
  }
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  final.resourceTracker.timers = 3;
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false, 'tracker mismatch must reject even if global summary is unchanged');
  assert.ok(
    result.errors.some((error) => /selected final raw timers/.test(error)),
    result.errors.join('\n'),
  );
  final.timers = 3;
  final.listeners = 8;
  final.observers = 2;
  final.resourceTracker.observers = 2;
  final.domOwned.totalOwned.consumer = 4;
  final.domOwned.consumer.detached = 1;
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false, 'capacity raw growth must reject zero ownership summaries');
  for (const field of ['listeners', 'timers', 'observers', 'DOM'])
    assert.ok(
      result.errors.some((error) => error.includes('selected final') && error.includes(field)),
      result.errors.join('\n'),
    );
});

test('selected controls cleanup endpoint cannot hide raw leaks behind zero summaries', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const final = structuredClone(record.resources.find((item) => item.label === 'full-empty-final'));
  final.label = 'full-controls-final';
  attachReadiness(final);
  record.resources.push(final);
  record.cleanup.finalResourceLabel = final.label;
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  final.listeners = 17;
  final.timers = 3;
  final.observers = 2;
  final.resourceTracker = { timers: 3, observers: 2 };
  final.dom.nodes = 91;
  final.domOwned.totalOwned.consumer = 91;
  final.domOwned.consumer.detached = 4;
  final.domOwned.terminal.detached = 2;
  assert.deepEqual(final.owned, { feeds: 0, listeners: 0, timers: 0, observers: 0, dom: 0 });
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false, 'selected controls endpoint raw leaks must reject');
  for (const field of ['listeners', 'timers', 'observers', 'DOM'])
    assert.ok(
      result.errors.some((error) => error.includes('selected final') && error.includes(field)),
      result.errors.join('\n'),
    );
});

test('required note text cannot be invisible despite correct text and coordinates', () => {
  const { record, expectedIdentity } = makeFullRecord();
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  let changed = 0;
  for (const checkpoint of record.checkpoints)
    for (const cell of checkpoint.observed.cells)
      for (const group of cell.drawingObservation.groups)
        if (group.sourceId.includes('-text-note-'))
          for (const call of group.calls)
            if (call.method === 'fillText') {
              call.globalAlpha = 0;
              changed++;
            }
  assert.equal(changed, 672);
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false, 'transparent required note paint must reject');
  assert.ok(
    result.errors.some((error) => error.includes('note line')),
    result.errors.join('\n'),
  );
});

test('generated grid documents satisfy the real public restore schema', async (t) => {
  // Use the exact source decoders called by public restoreWorkspace. This test-only
  // resolver loads TypeScript source without a build or a numerical-oracle dependency.
  const { registerHooks, stripTypeScriptTypes } = await import('node:module');
  const { existsSync, readFileSync } = await import('node:fs');
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
      if (specifier.startsWith('@filtix/')) {
        const [name, subpath] = specifier.slice('@filtix/'.length).split('/');
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
  let decodeGridWorkspace, decodeWorkspace, resolveStoredStudies;
  try {
    ({ decodeGridWorkspace } = await import('../../packages/terminal/src/grid-codec.ts'));
    ({ decodeWorkspace } = await import('../../packages/terminal/src/codec.ts'));
    ({ resolveStoredStudies } = await import('../../packages/terminal/src/studies.ts'));
  } finally {
    hooks.deregister();
  }
  for (const rowsPerCell of [256, 100000]) {
    const scene = buildGridScene({ rowsPerCell });
    const context = {
      providerId: scene.gridWorkspace.providerId,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      intervals: ['1m', '5m', '1h'],
      legacyAlertScopeIds: Object.fromEntries(scene.cells.map((cell) => [cell.id, cell.alerts.scopeId])),
    };
    await t.test(`${rowsPerCell} complete grid and every primary/alternate workspace`, () => {
      assert.deepEqual(decodeGridWorkspace(scene.gridWorkspace, context), scene.gridWorkspace);
      const legacySetting = structuredClone(scene.gridWorkspace);
      legacySetting.cells[0].workspace.settings.emaPeriod = null;
      assert.throws(
        () => decodeGridWorkspace(legacySetting, context),
        /Unknown workspace settings field: emaPeriod/,
      );
      const invalidStudy = structuredClone(scene.gridWorkspace);
      invalidStudy.cells[0].workspace.studies[0].id = 'study-sma200';
      assert.throws(() => decodeGridWorkspace(invalidStudy, context), /canonical positive study-N/);
      const invalidDrawing = structuredClone(scene.gridWorkspace);
      invalidDrawing.cells[0].workspace.markets[0].drawings.drawings[0].id = 'cell-1:horizontal-line:01';
      assert.throws(() => decodeGridWorkspace(invalidDrawing, context), /ASCII letters, digits/);
      for (const source of [...scene.cells, ...scene.alternateSources])
        assert.deepEqual(
          decodeWorkspace(source.workspace, {
            ...context,
            legacyAlertScopeId: source.alerts.scopeId,
          }),
          source.workspace,
        );
    });
    await t.test(`${rowsPerCell} stored studies validate independently of workspace settings`, () => {
      for (const cell of scene.cells)
        assert.deepEqual(resolveStoredStudies(cell.workspace.studies, 3), cell.workspace.studies);
    });
  }
});

test('saved full-run clock offset uses real wall brackets rather than performance epoch', () => {
  const { record, expectedIdentity } = makeFullRecord();
  const receipt = record.actions.lifecycle.find((item) => item.id === 'full-parked-once-crossing');
  // Performance and event values are from grid-full-2026-09-23T21-36-06-465Z.json.
  // Wall brackets below are explicit synthetic collector observations; the failed
  // report did not collect them and is not retroactively repaired by this test.
  Object.assign(receipt, {
    dispatchedAt: 1790199524946.3,
    returnedAt: 1790199524967.4001,
    settledAt: 1790199524979.6,
    targetAt: 1790199524946.3,
    synchronousMs: 21.10009765625,
    settledMs: 33.300048828125,
    wallClock: { dispatchedAt: 1790199524943, returnedAt: 1790199524968, settledAt: 1790199524980 },
  });
  receipt.frames[0].at = receipt.returnedAt;
  receipt.libraryWorkMs = receipt.synchronousMs + receipt.renderWorkMs;
  const mutation = record.scene.scopes.full.mutations.find((item) => item.deliveryId === receipt.id + ':1');
  mutation.dispatchedAt = receipt.dispatchedAt;
  const captures = [1790199542629.8, 1790199563046.7002, 1790199582296.8, 1790199601647.3];
  const events = [1790199524944, 1790199524953, 1790199524957, 1790199524962];
  record.checkpoints.slice(8).forEach((checkpoint, index) => {
    checkpoint.observed.at = captures[index];
    checkpoint.observed.wallClockAt = Math.floor(captures[index]) - 3;
    for (const cell of checkpoint.observed.cells)
      for (const event of cell.alerts.events) event.observedAt = events[Number(cell.id.at(-1)) - 1];
  });
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  for (const timestamp of [
    receipt.wallClock.dispatchedAt - 1,
    record.checkpoints[8].observed.wallClockAt + 1,
  ]) {
    const invalid = structuredClone(record);
    invalid.checkpoints[8].observed.cells[0].alerts.events[0].observedAt = timestamp;
    result = validateGridEvidence(invalid, { expectedIdentity });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => /observedAt.*wall.clock/.test(error)),
      result.errors.join('\n'),
    );
  }
  delete receipt.wallClock;
  result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, false, 'missing actual wall bounds cannot fall back to performance epoch');
});

function monitorOnlyReceiptFixture(record) {
  const receipt = record.actions.lifecycle.find((item) => item.id === 'full-parked-once-crossing');
  const cohort = [
    { cellId: 'cell-1', chartGeneration: 2, query: { symbol: 'BTCUSDT', interval: '1h' } },
    { cellId: 'cell-2', chartGeneration: 2, query: { symbol: 'SOLUSDT', interval: '1m' } },
  ];
  receipt.chartGeneration = 2;
  receipt.chartCohortBefore = structuredClone(cohort);
  receipt.chartCohortAfter = structuredClone(cohort);
  receipt.chartCohort = structuredClone(cohort);
  const queries = record.scene.scopes.full.monitorSources.map((source) => source.query);
  receipt.providerBefore = {
    ...providerFixture(
      cohort.map((cell) => cell.query),
      queries,
    ),
    monitor: monitorFixture(queries),
  };
  receipt.providerAfter = structuredClone(receipt.providerBefore);
  receipt.deliveries[0].handlers = 1;
  receipt.frames = [];
  receipt.renderWorkMs = 0;
  receipt.libraryWorkMs = receipt.synchronousMs;
  return receipt;
}

test('saved parked monitor-only delivery needs no RAF while history or stale ownership still rejects', () => {
  const { record, expectedIdentity } = makeFullRecord();
  monitorOnlyReceiptFixture(record);
  let result = validateGridEvidence(record, { expectedIdentity });
  assert.equal(result.valid, true, result.errors.join('\n'));
  for (const corrupt of [
    (receipt) => {
      const query = receipt.requested.deliveries[0].query;
      for (const cohort of [receipt.chartCohortBefore, receipt.chartCohortAfter, receipt.chartCohort])
        cohort[0].query = query;
      for (const provider of [receipt.providerBefore, receipt.providerAfter]) {
        provider.subscriptions[0].query = query;
        provider.subscriptions[0].key = key(query);
      }
      receipt.deliveries[0].handlers = 2;
    },
    (receipt) => {
      receipt.chartCohortBefore[0].chartGeneration = 1;
      receipt.chartCohortAfter[0].chartGeneration = 1;
      receipt.chartCohort[0].chartGeneration = 1;
    },
    (receipt) => {
      receipt.providerBefore.monitor.runtimes.find(
        (runtime) => key(runtime.query) === receipt.deliveries[0].key,
      ).active = false;
    },
  ]) {
    const invalid = structuredClone(record);
    corrupt(invalid.actions.lifecycle.find((item) => item.id === 'full-parked-once-crossing'));
    result = validateGridEvidence(invalid, { expectedIdentity });
    assert.equal(result.valid, false, 'zero-RAF exception requires current monitor-only ownership');
    assert.ok(
      result.errors.some((error) => /no actual RAF work/.test(error)),
      result.errors.join('\n'),
    );
  }
  const staleFrame = makeFullRecord();
  const delivery = staleFrame.record.actions.lifecycle.find(
    (item) => item.id === 'full-tail-replacement-action',
  );
  delivery.frames[0].chartGeneration = 0;
  result = validateGridEvidence(staleFrame.record, { expectedIdentity: staleFrame.expectedIdentity });
  assert.equal(result.valid, false, 'retired generation frame must not count as current work');
  assert.ok(
    result.errors.some((error) => /frame.*generation/.test(error)),
    result.errors.join('\n'),
  );
});
