import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const {
  createChart,
  measurePaneLayout,
  darkTheme,
  ChartError: BrowserChartError,
  isChartError,
} = await import('@filtix/charts');
const {
  SeriesStore,
  ChartError: CoreChartError,
  isChartError: isCoreChartError,
} = await import('@filtix/core');
assert.ok(isChartError(new CoreChartError('CORE_FAILURE')));
assert.ok(isCoreChartError(new BrowserChartError('BROWSER_FAILURE')));
assert.equal(isChartError(new Error('unrelated')), false);
const { createChartSync, buildIndexedComparison, createHistoryReplay } = await import('@filtix/analysis');
assert.equal(typeof createChartSync, 'function');
const comparison = buildIndexedComparison([
  {
    id: 'a',
    points: [
      { time: 0, value: 5 },
      { time: 1, value: 10 },
      { time: 2, value: 20 },
    ],
  },
  {
    id: 'b',
    points: [
      { time: 1, value: 4 },
      { time: 2, value: 8 },
    ],
  },
]);
assert.deepEqual(comparison[0].baseline, { time: 1, value: 10 });
assert.equal(comparison[0].points[2].value, 200);
assert.equal(comparison[1].points[1].value, 200);
const replayEvents = [];
const replay = createHistoryReplay({
  bars: [{ time: 0, open: 1, high: 2, low: 1, close: 2 }],
  onChange: (event) => replayEvents.push(event),
});
assert.equal(replayEvents.length, 0);
assert.deepEqual(replay.getData(), []);
replay.step();
assert.equal(replay.getState().status, 'ended');
assert.equal(replayEvents[0].type, 'append');
replay.seek(0);
assert.deepEqual(replay.getData(), []);
replay.destroy();
assert.equal(replay.getState().status, 'destroyed');
const { createTerminal, createTerminalGrid } = await import('@filtix/terminal');
assert.equal(typeof createTerminal, 'function');
assert.equal(typeof createTerminalGrid, 'function', 'Terminal grid factory must resolve from built ESM');
const { ema, macd, bollingerBands, createMacd, createBollingerBands } = await import('@filtix/indicators');
for (const exported of [macd, bollingerBands, createMacd, createBollingerBands]) {
  assert.equal(typeof exported, 'function', 'New math entry points must resolve from built ESM');
}
const multiInput = [1, 3, 2, 4].map((value, time) => ({ time, value }));
const macdOptions = { fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 };
const bandOptions = { period: 2, multiplier: 2 };
for (const [batch, stream, keys] of [
  [macd(multiInput, macdOptions), createMacd(macdOptions), ['macd', 'signal', 'histogram']],
  [bollingerBands(multiInput, bandOptions), createBollingerBands(bandOptions), ['middle', 'upper', 'lower']],
]) {
  const expectedKeys = [...keys].sort();
  assert.deepEqual(Object.keys(batch).sort(), expectedKeys);
  stream.setData(multiInput);
  assert.deepEqual(Object.keys(stream.getData()).sort(), expectedKeys);
  assert.deepEqual(Object.keys(stream.update({ time: 3, value: 5 })).sort(), expectedKeys);
  for (const key of keys) assert.equal(batch[key].length, multiInput.length);
}
const { FiltixChart } = await import('@filtix/react');
const { createDrawingStore, createDrawingLayer, measureDrawing } = await import('@filtix/drawings');
assert.equal(typeof createDrawingLayer, 'function');
const drawingStore = createDrawingStore({ timeDomain: 'business-date' });
const drawingId = drawingStore.add({
  type: 'measure',
  points: [
    { time: '2024-02-28', price: 100 },
    { time: '2024-03-01', price: 110 },
  ],
});
assert.deepEqual(measureDrawing(drawingStore.get(drawingId), 'business-date'), {
  priceChange: 10,
  percentChange: 10,
  elapsedMs: 172800000,
});
const drawingCopy = createDrawingStore({ timeDomain: 'business-date' });
drawingCopy.restore(drawingStore.toJSON());
assert.deepEqual(drawingCopy.list(), drawingStore.list());
assert.equal(drawingCopy.undo(), true);
assert.equal(drawingCopy.list().length, 0);
const { createBinanceProvider, createFeedSession, getFeedSessionResourceSnapshot, BINANCE_INTERVALS } =
  await import('@filtix/datafeed');
// Construction and disposal are transport-free, including in an SSR process.
const provider = createBinanceProvider({
  fetch: () => {
    throw new Error('Unexpected SSR transport access');
  },
  webSocketFactory: () => {
    throw new Error('Unexpected SSR transport access');
  },
});
const feed = createFeedSession({ provider, onChange() {} });
assert.equal(feed.getState().status, 'idle');
assert.equal(getFeedSessionResourceSnapshot(feed).mode, 'history');
assert.equal(getFeedSessionResourceSnapshot(feed).pendingRequest, false);
assert.throws(() => getFeedSessionResourceSnapshot({}), /createFeedSession/);
assert.ok(BINANCE_INTERVALS.includes('1m'));
feed.destroy();
assert.equal(feed.getState().status, 'destroyed');
assert.equal(typeof createChart, 'function');
assert.equal(typeof measurePaneLayout, 'function');
const paneGeometry = measurePaneLayout(
  {
    panes: [
      { id: 'price', weight: 1, minHeight: 48 },
      { id: 'volume', weight: 1, minHeight: 48 },
    ],
    maximizedPaneId: null,
  },
  200,
);
assert.equal(paneGeometry.plotHeight, 172);
assert.deepEqual(paneGeometry.panes, [
  { id: 'price', top: 0, height: 83.5 },
  { id: 'volume', top: 88.5, height: 83.5 },
]);
assert.throws(() => measurePaneLayout({ panes: [], maximizedPaneId: null }, Infinity));

assert.equal(typeof darkTheme.background, 'string');
assert.match(renderToString(createElement(FiltixChart, { options: { theme: 'dark' } })), /<div/);
const store = new SeriesStore('line');
store.setData([
  { time: 0, value: 1 },
  { time: 1, value: 2 },
]);
assert.equal(store.range(0, 1).max, 2);
const bandStore = new SeriesStore('band');
bandStore.setData([{ time: 0, lower: 2, upper: 7 }]);
bandStore.update({ time: 0, lower: 1, upper: 8 });
assert.deepEqual(bandStore.pointAt(0), { time: 0, lower: 1, upper: 8 });
assert.equal(bandStore.range(0, 0).min, 1);
assert.equal(bandStore.range(0, 0).max, 8);
assert.deepEqual(
  ema(
    [
      { time: 0, value: 1 },
      { time: 1, value: 3 },
    ],
    2,
  ),
  [{ time: 0 }, { time: 1, value: 2 }],
);
const bundle = readFileSync(new URL('../packages/charts/dist/index.js', import.meta.url));
const parsedBundle = ts.createSourceFile(
  'charts.js',
  bundle.toString(),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const runtimeImports = [];
function inspectImports(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    runtimeImports.push(node.getText(parsedBundle));
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  )
    runtimeImports.push(node.getText(parsedBundle));
  ts.forEachChild(node, inspectImports);
}
inspectImports(parsedBundle);
assert.deepEqual(runtimeImports, [], 'Chart runtime must be self-contained');
for (const name of ['charts', 'core']) {
  const manifest = JSON.parse(
    readFileSync(new URL('../packages/' + name + '/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.dependencies?.['@filtix/alerts'], undefined, name + ' must not require alerts');
  assert.equal(
    manifest.peerDependencies?.['@filtix/alerts'],
    undefined,
    name + ' must not require an alerts peer',
  );
}
const coreBundle = readFileSync(new URL('../packages/core/dist/index.js', import.meta.url), 'utf8');
const parsedCore = ts.createSourceFile('core.js', coreBundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const coreImports = [];
function inspectCore(node) {
  if (
    ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) ||
    (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')))
  )
    coreImports.push(node.getText(parsedCore));
  ts.forEachChild(node, inspectCore);
}
inspectCore(parsedCore);
assert.deepEqual(coreImports, [], 'Core runtime must be self-contained without alerts');
const raw = bundle.byteLength;
const gzip = gzipSync(bundle, { level: 9 }).byteLength;
assert.ok(raw <= 180 * 1024, 'Raw chart bundle exceeds 180 KiB');
assert.ok(gzip <= 50 * 1024, 'Gzip chart bundle exceeds 50 KiB');
for (const name of [
  'core',
  'charts',
  'indicators',
  'react',
  'datafeed',
  'drawings',
  'analysis',
  'alerts',
  'terminal',
]) {
  const dts = readFileSync(new URL('../packages/' + name + '/dist/index.d.ts', import.meta.url), 'utf8');
  assert.ok(dts.length > 100, 'Missing declarations: ' + name);
}
// This config intentionally has no workspace source aliases. TypeScript resolves package exports.
const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'tests/package/tsconfig.json'],
  {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  },
);
assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr);
const internalConsumer = spawnSync(process.execPath, ['tests/package/internal.mjs'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
assert.equal(internalConsumer.status, 0, internalConsumer.stdout + internalConsumer.stderr);
const terminalBundle = readFileSync(new URL('../packages/terminal/dist/index.js', import.meta.url), 'utf8');
assert.match(
  terminalBundle,
  /from[\s]*["']@filtix\/indicators\/internal["']/,
  'Terminal must consume the installed internal entry externally',
);
assert.match(
  terminalBundle,
  /from[\s]*["']@filtix\/alerts\/internal["']/,
  'Terminal must consume the installed alerts internal entry externally',
);
assert.match(
  terminalBundle,
  /from[\s]*["']@filtix\/charts\/internal["']/,
  'Terminal must consume the same installed chart registry through the external shim',
);
const chartMap = JSON.parse(
  readFileSync(new URL('../packages/charts/dist/index.js.map', import.meta.url), 'utf8'),
);
assert.equal(
  chartMap.sources.filter((source) => source.replaceAll('\\', '/').endsWith('/core/src/store.ts')).length,
  1,
  'Chart root must bundle one core store source for public and owned ingestion',
);
console.log(
  JSON.stringify({
    esmConsumer: 'pass',
    ssrRender: 'pass',
    declarationConsumer: 'pass',
    chartsRawBytes: raw,
    chartsGzipBytes: gzip,
  }),
);
