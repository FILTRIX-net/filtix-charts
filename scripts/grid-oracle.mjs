// Independent deterministic truth for the installed four-terminal grid workload.
// Study math is reused only from the frozen pure multi-output oracle.
import { createHash } from 'node:crypto';
import { expectedStudyOutputs } from './multi-output-oracle.mjs';

export const GRID_PROVIDER_ID = 'filtix-grid-workload-v1';
export const GRID_SEED = 20260922;
export const MAXIMUM_SAMPLE_INDICES = Object.freeze([
  0,
  1,
  13,
  14,
  19,
  20,
  25,
  26,
  33,
  199,
  200,
  (rows) => Math.floor(rows / 2),
  (rows) => rows - 4,
  (rows) => rows - 3,
  (rows) => rows - 2,
  (rows) => rows - 1,
]);
export const GRID_DRAWING_MIX = Object.freeze({
  'horizontal-line': 8,
  'trend-line': 7,
  rectangle: 7,
  measure: 7,
  'fibonacci-retracement': 7,
  'parallel-channel': 7,
  'text-note': 7,
});
const CELL_IDS = Object.freeze(['cell-1', 'cell-2', 'cell-3', 'cell-4']);
const QUERY_KEYS = Object.freeze([
  { symbol: 'BTCUSDT', interval: '1m' },
  { symbol: 'BTCUSDT', interval: '5m' },
  { symbol: 'ETHUSDT', interval: '1m' },
  { symbol: 'ETHUSDT', interval: '5m' },
  { symbol: 'SOLUSDT', interval: '1m' },
  { symbol: 'SOLUSDT', interval: '5m' },
  { symbol: 'BTCUSDT', interval: '1h' },
  { symbol: 'ETHUSDT', interval: '1h' },
]);
const INITIAL_QUERIES = Object.freeze([
  { symbol: 'BTCUSDT', interval: '1m' },
  { symbol: 'ETHUSDT', interval: '5m' },
  { symbol: 'SOLUSDT', interval: '1h' },
  { symbol: 'ETHUSDT', interval: '1m' },
]);
const STUDIES = Object.freeze([
  { id: 'study-1', kind: 'sma', period: 200, color: '#c7ef57', lineWidth: 2, visible: true },
  { id: 'study-2', kind: 'ema', period: 20, color: '#c27a50', lineWidth: 2, visible: true },
  { id: 'study-3', kind: 'rsi', period: 14, color: '#a8a0dc', lineWidth: 2, visible: true },
  {
    id: 'study-4',
    kind: 'macd',
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    color: '#7aa2f7',
    signalColor: '#e0af68',
    positiveColor: '#73c991',
    negativeColor: '#ef7c8e',
    lineWidth: 2,
    visible: true,
  },
  {
    id: 'study-5',
    kind: 'bollinger',
    period: 20,
    multiplier: 2,
    color: '#66b9c7',
    upperColor: '#7aa2f7',
    lowerColor: '#7aa2f7',
    fillColor: '#7aa2f7',
    fillOpacity: 0.12,
    lineWidth: 2,
    visible: true,
  },
]);
const FIB_RATIOS = Object.freeze([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
const queryKey = (query) => JSON.stringify([query.symbol, query.interval]);
const clone = (value) => structuredClone(value);
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const intervalMs = (interval) => {
  const amount = Number.parseInt(interval, 10);
  if (interval.endsWith('m') && Number.isFinite(amount)) return amount * 60_000;
  if (interval.endsWith('h') && Number.isFinite(amount)) return amount * 3_600_000;
  throw new TypeError(`Unsupported deterministic grid interval: ${interval}`);
};

export function sha256Rows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Rows must be an array');
  const tuples = rows.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null]);
  return createHash('sha256').update(JSON.stringify(tuples), 'utf8').digest('hex');
}

function barsFor(query, count, seed, offset = 0) {
  const step = intervalMs(query.interval);
  const firstTime = Date.UTC(2025, 0, 1) + step * (seed % 31);
  const symbolOffset = [...query.symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 37;
  const intervalOffset = step / 60_000;
  return Array.from({ length: count }, (_, index) => {
    const absolute = offset + index;
    const close =
      80 +
      symbolOffset +
      intervalOffset * 0.17 +
      Math.sin(absolute / 17) * 2.1 +
      Math.cos(absolute / 43) * 0.8 +
      absolute * 0.00002;
    const open = close + Math.sin(absolute / 7) * 0.31;
    const spread = 0.18 + (absolute % 11) * 0.012;
    return {
      time: firstTime + absolute * step,
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 100 + ((absolute * 37 + seed) % 10_000) / 10,
    };
  });
}

function expectedFibPrice(drawing, ratio) {
  const [first, second] = drawing.points;
  return first.price + (second.price - first.price) * ratio;
}

function buildDrawing(id, type, index, rows) {
  const length = rows.length;
  const first = Math.max(0, length - 900 + (index % 50) * 3);
  const second = Math.min(length - 1, first + 12 + (index % 13));
  const a = rows[first];
  const b = rows[second];
  const c = rows[Math.min(length - 1, second + 9)];
  const timePrice = (bar, price) => ({ time: bar.time, price });
  const pointA = timePrice(a, a.low + (a.high - a.low) * 0.35);
  const pointB = timePrice(b, b.low + (b.high - b.low) * 0.72);
  const pointC = timePrice(c, c.low + (c.high - c.low) * 0.58);
  const points =
    type === 'horizontal-line' || type === 'text-note'
      ? [pointA]
      : type === 'parallel-channel'
        ? [pointA, pointB, pointC]
        : [pointA, pointB];
  return {
    id,
    type,
    paneId: 'price',
    points,
    style: {
      color: ['#7aa2f7', '#e0af68', '#73c991', '#ef7c8e'][index % 4],
      lineWidth: 1 + (index % 3),
      fillOpacity: 0.15,
    },
    locked: false,
    visible: true,
    ...(type === 'fibonacci-retracement'
      ? {
          levels: FIB_RATIOS.map((ratio, level) => ({
            ratio,
            color: level % 2 ? '#e0af68' : '#7aa2f7',
            lineWidth: 1,
            lineStyle: level % 2 ? 'dashed' : 'solid',
          })),
        }
      : {}),
    ...(type === 'text-note' ? { text: `Grid note ${index + 1}\n${id}`, fontSize: 12 + (index % 3) } : {}),
  };
}

function drawingsFor(cellId, rows) {
  const drawings = [];
  for (const [type, count] of Object.entries(GRID_DRAWING_MIX))
    for (let index = 0; index < count; index++)
      drawings.push(
        buildDrawing(`${cellId}-${type}-${String(index + 1).padStart(2, '0')}`, type, index, rows),
      );
  return { schema: 'filtix-drawings', version: 2, timeDomain: 'utc-ms', drawings };
}

function alertsFor(cellId, bars, monitorSources, providerSources = []) {
  const scopeId = `grid-workload:${cellId}`;
  const alerts = [];
  for (let index = 0; index < 25; index++) {
    let queryIndex;
    let frequency;
    let status;
    let triggerCount = 0;
    if (index < 16) {
      queryIndex = Math.floor(index / 2);
      frequency = 'repeat';
      status = 'armed';
    } else if (index < 20) {
      queryIndex = index - 16;
      frequency = 'once';
      status = 'armed';
    } else if (index < 23) {
      queryIndex = index - 20;
      frequency = 'repeat';
      status = 'paused';
    } else {
      queryIndex = index - 23;
      frequency = 'once';
      status = 'triggered';
      triggerCount = 1;
    }
    const query = QUERY_KEYS[queryIndex];
    const source =
      providerSources.find((item) => queryKey(item.query) === queryKey(query)) ??
      monitorSources.find((item) => queryKey(item.query) === queryKey(query));
    const baselineBar = source?.rows?.at(-1) ?? bars.at(-2);
    const baseline = baselineBar.close;
    const price = baseline + (index + 1) * 0.025;
    const event =
      status === 'triggered'
        ? {
            id: JSON.stringify([scopeId, `${scopeId}:${index + 1}`, 1]),
            scopeId,
            alertId: `${scopeId}:${index + 1}`,
            providerId: GRID_PROVIDER_ID,
            query: clone(query),
            condition: 'crosses-up',
            threshold: price,
            previousPrice: price - 1,
            price: price + 1,
            barTime: baselineBar.time,
            observedAt: baselineBar.time,
            occurrence: 1,
          }
        : null;
    alerts.push({
      id: `${scopeId}:${index + 1}`,
      query: clone(query),
      price,
      condition: 'crosses-up',
      frequency,
      status,
      triggerCount,
      lastTrigger: event,
      label: `Grid ${cellId} rule ${index + 1}`,
    });
  }
  return {
    schema: 'filtix-price-alerts',
    version: 1,
    scopeId,
    providerId: GRID_PROVIDER_ID,
    nextRuleId: 26,
    alerts,
  };
}

function layoutFor() {
  return {
    panes: [
      { id: 'price', weight: 0.52, minHeight: 120 },
      { id: 'terminal-volume-pane', weight: 0.18, minHeight: 72 },
      { id: 'terminal-study-3-pane', weight: 0.17, minHeight: 72 },
      { id: 'terminal-study-4-pane', weight: 0.13, minHeight: 72 },
    ],
    maximizedPaneId: null,
    studiesOpen: true,
  };
}

function workspaceFor(query, drawings, alerts) {
  return {
    schema: 'filtix-terminal',
    version: 5,
    providerId: GRID_PROVIDER_ID,
    query: clone(query),
    settings: { theme: 'dark', followLatest: true, volume: true },
    studies: clone(STUDIES),
    layout: layoutFor(),
    markets: [{ query: clone(query), drawings: clone(drawings) }],
    alerts: clone(alerts),
  };
}

function alternateQuery(cellId, primary) {
  return cellId === 'cell-1'
    ? { symbol: primary.symbol, interval: '1h' }
    : cellId === 'cell-2'
      ? { symbol: 'SOLUSDT', interval: '1m' }
      : { symbol: primary.symbol === 'BTCUSDT' ? 'ETHUSDT' : 'BTCUSDT', interval: '1h' };
}

function makeMutations(rowsPerCell, cells, alternates, fullParkedOnceDelivery) {
  const mutations = [];
  let sequence = 0;
  const add = (checkpointId, operation, cellId, data = {}) =>
    mutations.push({ checkpointId, sequence: sequence++, operation, cellId, ...clone(data) });
  if (rowsPerCell === 100_000) {
    for (let batch = 0; batch < 100; batch++)
      for (const cell of cells) {
        const base = cell.rows.at(-1);
        const delta = batch % 2 === 0 ? 0.015 : -0.015;
        const close = base.close + delta;
        add('max-replacements', 'replace', cell.id, {
          index: 99_999,
          bar: {
            ...base,
            close,
            high: Math.max(base.high, close + 0.1),
            low: Math.min(base.low, close - 0.1),
            revision: batch + 1,
          },
        });
      }
    for (const cell of cells) add('max-append-replacements', 'source-reset', cell.id, { rowCount: 99_900 });
    for (let batch = 0; batch < 100; batch++)
      for (const cell of cells) {
        const prior = cell.rows[99_900 + batch];
        const time = prior.time;
        const bar = clone(prior);
        add('max-append-replacements', 'append', cell.id, { bar: { ...bar, time, volume: bar.volume } });
        const moved = { ...bar, time, close: bar.close + (batch % 2 ? -0.01 : 0.01), revision: batch + 1 };
        add('max-append-replacements', 'replace', cell.id, { index: 99_900 + batch, bar: moved });
      }
    for (let action = 0; action < 240; action++)
      add('max-interactions', 'interaction', CELL_IDS[action % 4], { index: action, after: action + 1 });
    add('max-sync-exact', 'sync', null, { mode: 'exact', samples: 24 });
    add('max-sync-nearest', 'sync', null, { mode: 'nearest', samples: 24 });
  } else {
    for (const cell of cells) {
      add('full-tail-replacement', 'replace', cell.id, {
        index: 255,
        bar: { ...cell.rows.at(-1), close: cell.rows.at(-1).close + 0.025, revision: 1 },
      });
      add('full-append-255-to-256', 'source-reset', cell.id, { rowCount: 255 });
      const bar = clone(cell.rows[255]);
      add('full-append-255-to-256', 'append', cell.id, { bar });
    }
    add('full-drawing-edit', 'drawing-edit', 'cell-1', {
      drawingId: cells[0].drawings.drawings[1].id,
      drawingPatch: { style: { color: '#e0af68' } },
    });
    add('full-study-parameter-edit', 'study-parameter-edit', 'cell-2', {
      studyId: 'study-1',
      studyPatch: { period: 199 },
    });
    add('full-pane-edit', 'pane-edit', 'cell-3', { paneWeights: [0.5, 0.18, 0.16, 0.16] });
    for (const alternate of alternates)
      add(
        alternate.cellId === 'cell-1' ? 'full-interval-switch' : 'full-market-switch',
        alternate.cellId === 'cell-1' ? 'interval-switch' : 'market-switch',
        alternate.cellId,
        { query: clone(alternate.query) },
      );
    const parked = fullParkedOnceDelivery;
    add('full-parked-once-crossing-remount', 'parked-once-crossing', 'cell-4', {
      alertId: parked.expectedAlertId,
      query: clone(parked.query),
      bar: clone(parked.bar),
    });
    add('full-save-restore', 'save-restore', null, { gridWorkspace: true });
    add('full-zero-size-recovery', 'zero-size-recovery', null, { size: [0, 0, 1600, 1000] });
  }
  return mutations;
}

export function buildGridScene({ rowsPerCell, seed = GRID_SEED } = {}) {
  if (rowsPerCell !== 100_000 && rowsPerCell !== 256)
    throw new RangeError('Grid scene rowsPerCell must be exactly 100000 or 256');
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new TypeError('Grid scene seed must be a nonnegative integer');
  const monitorSources = QUERY_KEYS.map((query, index) => ({
    query: clone(query),
    rows: [barsFor(query, 1, seed + 5_000 + index)[0]],
  }));
  const cells = CELL_IDS.map((id, index) => {
    const query = clone(INITIAL_QUERIES[index]);
    const rows = barsFor(query, rowsPerCell, seed + index * 101);
    const drawings = drawingsFor(id, rows);
    return { id, query, rows, studies: clone(STUDIES), drawings, alerts: null, workspace: null };
  });
  const alternateSources =
    rowsPerCell === 256
      ? cells.slice(0, 2).map((cell) => {
          const query = alternateQuery(cell.id, cell.query);
          const rows = barsFor(query, rowsPerCell, seed + 8_000 + CELL_IDS.indexOf(cell.id));
          const drawings = drawingsFor(cell.id, rows);
          return { cellId: cell.id, query, rows, drawings, alerts: null, workspace: null };
        })
      : [];
  const providerSources = [
    ...cells.map((cell) => ({ query: cell.query, rows: cell.rows })),
    ...alternateSources.map((item) => ({ query: item.query, rows: item.rows })),
  ];
  for (const cell of cells) {
    cell.alerts = alertsFor(cell.id, cell.rows, monitorSources, providerSources);
    cell.workspace = workspaceFor(cell.query, cell.drawings, cell.alerts);
  }
  for (const alternate of alternateSources) {
    alternate.alerts = alertsFor(alternate.cellId, alternate.rows, monitorSources, providerSources);
    alternate.workspace = workspaceFor(alternate.query, alternate.drawings, alternate.alerts);
  }
  const gridWorkspace = {
    schema: 'filtix-terminal-grid',
    version: 1,
    providerId: GRID_PROVIDER_ID,
    layout: 4,
    activeCellId: 'cell-1',
    sync: { viewport: false, crosshair: false, crosshairMatch: 'exact' },
    cells: cells.map(({ id, workspace }) => ({ id, workspace: clone(workspace) })),
  };
  const parkedBaseline = providerSources
    .find((item) => queryKey(item.query) === queryKey(QUERY_KEYS[0]))
    .rows.at(-1);
  const onceRule = cells[3].alerts.alerts.find((rule) => rule.id.endsWith(':17'));
  const fullParkedOnceDelivery = {
    query: clone(QUERY_KEYS[0]),
    bar: {
      time: parkedBaseline.time + intervalMs(QUERY_KEYS[0].interval),
      open: parkedBaseline.close,
      high: parkedBaseline.close + 1.5,
      low: parkedBaseline.close - 0.1,
      close: parkedBaseline.close + 1,
      volume: parkedBaseline.volume + 1,
      revision: 1,
    },
    expectedAlertId: onceRule.id,
    previousPrice: parkedBaseline.close,
  };
  for (const alternate of alternateSources) {
    const primary = cells.find((cell) => cell.id === alternate.cellId);
    const markets = [
      { query: clone(primary.query), drawings: clone(primary.drawings) },
      { query: clone(alternate.query), drawings: clone(alternate.drawings) },
    ];
    primary.workspace.markets = clone(markets);
    alternate.workspace.markets = clone(markets);
  }
  for (const entry of gridWorkspace.cells) {
    const primary = cells.find((cell) => cell.id === entry.id);
    entry.workspace = clone(primary.workspace);
  }
  const mutations = makeMutations(rowsPerCell, cells, alternateSources, fullParkedOnceDelivery);
  return {
    rowsPerCell,
    seed,
    cells,
    monitorSources,
    alternateSources,
    fullParkedOnceDelivery,
    gridWorkspace,
    mutations,
  };
}

function findCell(scene, id) {
  const cell = scene.cells.find((item) => item.id === id);
  if (!cell) throw new TypeError(`Unknown grid cell: ${id}`);
  return cell;
}

function getSourceRows(scene, cellId) {
  const source = scene.sourceRows?.find((item) => item.cellId === cellId);
  return source?.rows ?? findCell(scene, cellId).rows;
}

export function replayGridRows(scene, cellId, mutations) {
  let rows = [...getSourceRows(scene, cellId)];
  let query = clone(findCell(scene, cellId).query);
  const marketRows = new Map([
    [queryKey(query), rows],
    ...(scene.alternateSources ?? [])
      .filter((item) => item.cellId === cellId)
      .map((item) => [queryKey(item.query), [...item.rows]]),
  ]);
  const scopeRows = mutations.filter((item) => item.cellId === cellId);
  let revision = 0;
  for (const mutation of scopeRows) {
    revision = Math.max(revision, mutation.sequence + 1);
    if (mutation.operation === 'source-reset')
      rows = getSourceRows(scene, cellId).slice(0, mutation.rowCount);
    else if (mutation.operation === 'replace') {
      const index = Number.isInteger(mutation.index)
        ? mutation.index
        : rows.findIndex((row) => row.time === mutation.bar?.time);
      if (index !== rows.length - 1 || !mutation.bar || mutation.bar.time !== rows[index]?.time)
        throw new RangeError('Invalid ordered grid replace mutation');
      rows[index] = clone(mutation.bar);
    } else if (mutation.operation === 'append') {
      if (!mutation.bar || mutation.bar.time !== rows.at(-1)?.time + intervalMs(query.interval))
        throw new TypeError('Ordered grid append must advance exactly one interval');
      rows.push(clone(mutation.bar));
    } else if (mutation.operation === 'market-switch' || mutation.operation === 'interval-switch') {
      if (!mutation.query) throw new TypeError('Ordered grid market switch requires a query');
      marketRows.set(queryKey(query), rows);
      query = clone(mutation.query);
      if (!marketRows.has(queryKey(query)))
        throw new TypeError(`Missing independent destination source for ${cellId} ${queryKey(query)}`);
      rows = marketRows.get(queryKey(query));
    }
  }
  return { rows, query, revision };
}

function applyDocumentMutations(scene, cell, cellId, mutations, query) {
  const workspace = clone(cell.workspace);
  const markets = new Map(workspace.markets.map((item) => [queryKey(item.query), item]));
  for (const alternate of scene.alternateSources ?? []) {
    if (alternate.cellId === cellId && !markets.has(queryKey(alternate.query)))
      markets.set(queryKey(alternate.query), {
        query: clone(alternate.query),
        drawings: clone(alternate.drawings),
      });
  }
  let current = queryKey(cell.query);
  for (const mutation of mutations) {
    if (mutation.cellId !== null && mutation.cellId !== cellId) continue;
    if (mutation.operation === 'market-switch' || mutation.operation === 'interval-switch') {
      current = queryKey(mutation.query);
      if (!markets.has(current)) throw new Error('Missing saved market document: ' + current);
    } else if (mutation.operation === 'drawing-edit') {
      const drawing = markets.get(current).drawings.drawings.find((item) => item.id === mutation.drawingId);
      if (!drawing) throw new Error('Unknown edited drawing: ' + mutation.drawingId);
      const patch = clone(mutation.drawingPatch);
      if (patch.style) patch.style = { ...drawing.style, ...patch.style };
      const before = JSON.stringify(drawing);
      Object.assign(drawing, patch);
      if (before === JSON.stringify(drawing)) throw new Error('Ineffective drawing edit');
    } else if (['study-edit', 'study-parameter-edit'].includes(mutation.operation)) {
      const study = workspace.studies.find((item) => item.id === mutation.studyId);
      if (!study) throw new Error('Unknown edited study: ' + mutation.studyId);
      const before = JSON.stringify(study);
      Object.assign(study, clone(mutation.studyPatch));
      if (before === JSON.stringify(study)) throw new Error('Ineffective study edit');
    } else if (mutation.operation === 'pane-edit') {
      const before = JSON.stringify(workspace.layout.panes);
      workspace.layout.panes = workspace.layout.panes.map((pane, index) => ({
        ...pane,
        weight:
          typeof mutation.paneWeights[index] === 'number'
            ? mutation.paneWeights[index]
            : (mutation.paneWeights.find((item) => item.id === pane.id)?.weight ?? pane.weight),
      }));
      if (before === JSON.stringify(workspace.layout.panes)) throw new Error('Ineffective pane edit');
    }
  }
  workspace.query = clone(query);
  // Terminal persistence keeps market insertion order; switching does not move a market.
  workspace.markets = [...markets.values()];
  return {
    drawings: markets.get(current).drawings,
    studies: workspace.studies,
    alerts: clone(cell.alerts),
    workspace,
  };
}

function fibonacciPrices(drawing) {
  return (drawing.levels ?? []).map(({ ratio }) => ({ ratio, price: expectedFibPrice(drawing, ratio) }));
}

function expectedDrawingGeometry(document) {
  return document.drawings.map((drawing) => ({
    id: drawing.id,
    type: drawing.type,
    paneId: drawing.paneId,
    visible: drawing.visible,
    anchors: drawing.points.map(({ time, price }) => ({ time, price })),
    fibLevels: fibonacciPrices(drawing),
    text:
      drawing.type === 'text-note'
        ? {
            content: drawing.text,
            lineCount: drawing.text.split('\n').length,
            fontSize: drawing.fontSize,
          }
        : null,
  }));
}

function alertCrossings(document, scene, mutationLog) {
  const alerts = clone(document);
  const events = [];
  const baselines = new Map();
  // Match the fixture provider's documented query priority, independently of its output.
  for (const source of [
    ...scene.cells.map((cell) => ({ query: cell.query, rows: getSourceRows(scene, cell.id) })),
    ...(scene.alternateSources ?? []),
    ...scene.monitorSources,
  ])
    if (!baselines.has(queryKey(source.query)))
      baselines.set(queryKey(source.query), source.rows.at(-1).close);
  const byKey = new Map();
  for (const rule of alerts.alerts) {
    const key = queryKey(rule.query);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rule);
  }
  const recordCrossing = (rule, mutation, previousPrice, price) => {
    const crossed =
      rule.condition === 'crosses-up'
        ? previousPrice < rule.price && price >= rule.price
        : rule.condition === 'crosses-down'
          ? previousPrice > rule.price && price <= rule.price
          : (previousPrice < rule.price && price >= rule.price) ||
            (previousPrice > rule.price && price <= rule.price);
    if (rule.status !== 'armed' || !crossed) return;
    rule.triggerCount++;
    const event = {
      id: JSON.stringify([alerts.scopeId, rule.id, rule.triggerCount]),
      scopeId: alerts.scopeId,
      alertId: rule.id,
      providerId: GRID_PROVIDER_ID,
      query: clone(rule.query),
      condition: rule.condition,
      threshold: rule.price,
      previousPrice,
      price,
      barTime: mutation.bar.time,
      occurrence: rule.triggerCount,
    };
    rule.lastTrigger = event;
    if (rule.frequency === 'once') rule.status = 'triggered';
    events.push(event);
  };
  for (const mutation of mutationLog) {
    if (mutation.operation === 'monitor-baseline-reset') {
      const resetRows = new Map(
        scene.cells.map((cell) => [
          queryKey(cell.query),
          replayGridRows(scene, cell.id, mutationLog.slice(0, mutation.sequence)).rows.at(-1),
        ]),
      );
      for (const source of [...(scene.alternateSources ?? []), ...scene.monitorSources])
        if (!resetRows.has(queryKey(source.query))) resetRows.set(queryKey(source.query), source.rows.at(-1));
      if (!Array.isArray(mutation.baselines) || mutation.baselines.length !== resetRows.size)
        throw new Error('Missing complete independent reset baselines');
      for (const entry of mutation.baselines) {
        const bar = resetRows.get(queryKey(entry.query));
        if (!bar || sha256Rows([bar]) !== sha256Rows([entry.bar]))
          throw new Error('Reset baseline differs from independent current source');
        baselines.set(queryKey(entry.query), bar.close);
      }
    } else if (mutation.operation === 'baseline-reset') {
      if (!mutation.query || !mutation.bar || !number(mutation.bar.close))
        throw new Error('Invalid baseline reset');
      baselines.set(queryKey(mutation.query), mutation.bar.close);
    } else if (mutation.operation === 'monitor-update') {
      const key = queryKey(mutation.query);
      const previous = baselines.get(key);
      if (!number(previous) || !number(mutation.bar?.close))
        throw new Error('Missing independent alert baseline');
      if (mutation.previousPrice !== undefined && mutation.previousPrice !== previous)
        throw new Error('Reported previousPrice differs from ordered alert baseline');
      for (const rule of byKey.get(key) ?? []) recordCrossing(rule, mutation, previous, mutation.bar.close);
      baselines.set(key, mutation.bar.close);
    }
  }
  return { document: alerts, expected: events };
}

function normalizeStudyOutput(output, kind, index) {
  if (kind === 'macd')
    return {
      line: output.macd[index],
      signal: output.signal[index],
      histogram: output.histogram[index],
    };
  if (kind === 'bollinger')
    return {
      middle: output.middle[index],
      upper: output.upper[index],
      lower: output.lower[index],
    };
  return output.value[index];
}

function fixedIndices(rows) {
  const result = MAXIMUM_SAMPLE_INDICES.map((item) => (typeof item === 'function' ? item(rows) : item));
  if (
    new Set(result).size !== 16 ||
    result.some((index) => !Number.isInteger(index) || index < 0 || index >= rows)
  )
    throw new RangeError('Maximum-scene rendered indices must be 16 distinct in-range positions');
  return result;
}

export function expectedCheckpoint(scene, mutationLog = [], spec = {}) {
  if (!scene || !Array.isArray(scene.cells)) throw new TypeError('Grid scene cells are required');
  const scope = spec.scope;
  const rowsPerCell = scene.rowsPerCell;
  if (
    (scope === 'maximum-sampled' && rowsPerCell !== 100_000) ||
    (scope === 'full-256' && rowsPerCell !== 256)
  )
    throw new RangeError('Grid checkpoint scope does not match its fixed source rows');
  const prefix = spec.mutationPrefix ?? mutationLog.length;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > mutationLog.length)
    throw new RangeError('Grid checkpoint mutation prefix is outside the ordered log');
  const mutations = mutationLog.slice(0, prefix);
  const indices = scope === 'maximum-sampled' ? fixedIndices(rowsPerCell) : spec.indices;
  if (
    scope === 'full-256' &&
    (!Array.isArray(indices) || indices.length !== 256 || indices.some((value, index) => value !== index))
  )
    throw new RangeError('Full grid checkpoint must contain all 256 ordered row indices');
  const cells = scene.cells.map((cell) => {
    const replayed = replayGridRows(scene, cell.id, mutations);
    const documents = applyDocumentMutations(scene, cell, cell.id, mutations, replayed.query);
    const drawings = documents.drawings;
    const alerts = alertCrossings(documents.alerts, scene, mutations);
    documents.workspace.alerts = alerts.document;
    const byStudy = new Map(
      documents.studies.map((study) => [study.id, expectedStudyOutputs(replayed.rows, study)]),
    );
    const rendered = indices.map((index) => {
      const bar = replayed.rows[index];
      if (!bar) throw new RangeError(`Missing deterministic row ${index} for ${cell.id}`);
      const studyValues = {};
      for (const study of documents.studies)
        studyValues[study.kind] = normalizeStudyOutput(byStudy.get(study.id), study.kind, index);
      const bollinger = documents.studies.find((study) => study.kind === 'bollinger');
      const band = byStudy.get(bollinger.id).fill[index];
      return {
        index,
        time: bar.time,
        ohlcv: {
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume ?? null,
        },
        studies: studyValues,
        fill: band ? { upper: band.upper, lower: band.lower } : { upper: null, lower: null },
      };
    });
    const source = {
      revision: replayed.revision,
      mutationPrefix: prefix,
      rows: replayed.rows.length,
      seed: scene.seed,
      firstTime: replayed.rows[0]?.time,
      lastTime: replayed.rows.at(-1)?.time,
      expectedSha256: sha256Rows(replayed.rows),
    };
    return {
      id: cell.id,
      query: replayed.query,
      source,
      studies: clone(documents.studies),
      rendered,
      drawings: { document: drawings, geometry: expectedDrawingGeometry(drawings) },
      alerts,
      workspace: documents.workspace,
    };
  });
  return { id: spec.id, scope, rowsPerCell, cells };
}

export function compareFinite(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  return number(actual) && Math.abs(actual - expected) <= 1e-8 + 1e-8 * Math.abs(expected);
}

export function studySeriesId(study, output) {
  if (study.kind === 'macd' || study.kind === 'bollinger') return `terminal-${study.id}-${output}`;
  return `terminal-${study.id}`;
}

export function fillSeriesId(study) {
  return `terminal-${study.id}-fill`;
}
