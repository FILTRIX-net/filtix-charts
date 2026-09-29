import assert from 'node:assert/strict';
import * as publicIndicators from '@filtix/indicators';
import * as internal from '@filtix/indicators/internal';
assert.deepEqual(Object.keys(publicIndicators).sort(), [
  'bollingerBands',
  'createBollingerBands',
  'createIndicator',
  'createMacd',
  'ema',
  'macd',
  'rsi',
  'sma',
]);
assert.deepEqual(Object.keys(internal).sort(), [
  'prepareBatch',
  'prepareBollinger',
  'prepareMacd',
  'prepareOwnedBatch',
  'prepareScalar',
]);
const points = Array.from({ length: 40 }, (_, time) => ({ time, value: 10 + Math.sin(time) }));
for (const [prepared, stream, scalar] of [
  [internal.prepareScalar('ema', 3, points), publicIndicators.createIndicator('ema', 3), true],
  [
    internal.prepareMacd({ fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 }, points),
    publicIndicators.createMacd({ fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 }),
    false,
  ],
  [
    internal.prepareBollinger({ period: 3, multiplier: 2 }, points),
    publicIndicators.createBollingerBands({ period: 3, multiplier: 2 }),
    false,
  ],
]) {
  stream.setData(points);
  assert.deepEqual(prepared.data, stream.getData());
  for (const values of scalar ? [prepared.data] : Object.values(prepared.data)) {
    values.at(-1).time = -100;
    values.at(-1).value = 9999;
    values.length = 0;
  }
  for (const point of [{ time: 39, value: 8 }, { time: 40, value: 9 }, { time: 40 }, { time: 40, value: 11 }])
    assert.deepEqual(prepared.controller.update(point), stream.update(point));
  prepared.controller.reset();
  stream.setData([]);
  assert.deepEqual(prepared.controller.update({ time: 0, value: 3 }), stream.update({ time: 0, value: 3 }));
}

assert.equal(Object.hasOwn(publicIndicators, 'prepareBatch'), false);
for (const key of ['window', 'document', 'HTMLElement', 'ResizeObserver'])
  assert.equal(typeof globalThis[key], 'undefined', 'Headless indicator batch import: ' + key);
const batchRequests = [
  { kind: 'sma', period: 200 },
  { kind: 'ema', period: 20 },
  { kind: 'rsi', period: 14 },
  { kind: 'macd', options: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  { kind: 'bollinger', options: { period: 20, multiplier: 2 } },
  { kind: 'sma', period: 200 },
];
const batchPoints = Array.from({ length: 256 }, (_, time) =>
  time === 17 || time === 255 ? { time } : { time, value: 500 + Math.sin(time / 3) * 20 + time / 11 },
);
const batchStreams = batchRequests.map((request) => {
  const stream =
    request.kind === 'macd'
      ? publicIndicators.createMacd(request.options)
      : request.kind === 'bollinger'
        ? publicIndicators.createBollingerBands(request.options)
        : publicIndicators.createIndicator(request.kind, request.period);
  stream.setData(batchPoints);
  return stream;
});
function* installedRequests() {
  yield* batchRequests;
}
const batch = internal.prepareBatch(installedRequests(), batchPoints);
assert.deepEqual(
  batch.map((result) => result.kind),
  batchRequests.map((request) => request.kind),
);
for (let index = 0; index < batch.length; index++)
  assert.deepEqual(batch[index].prepared.data, batchStreams[index].getData());
assert.notEqual(
  batch[0].prepared.data,
  batch[5].prepared.data,
  'Duplicate study outputs must be independently owned',
);
const untouchedDuplicate = structuredClone(batch[5].prepared.data);
batch[0].prepared.data.length = 0;
assert.deepEqual(batch[5].prepared.data, untouchedDuplicate);
// These operations happen after the operation-owned input batch has returned.
for (const point of batchPoints) {
  point.time = -1;
  point.value = -1000;
}
batchPoints.length = 0;
for (const result of batch)
  for (const values of Array.isArray(result.prepared.data)
    ? [result.prepared.data]
    : Object.values(result.prepared.data)) {
    for (const point of values) {
      point.time = -1;
      point.value = -2000;
    }
    values.length = 0;
  }
for (let index = 0; index < batch.length; index++) {
  const prepared = batch[index].prepared,
    stream = batchStreams[index];
  for (const point of [
    { time: 255, value: 620 + index },
    { time: 255 },
    { time: 255, value: 610 + index },
    { time: 256 + index, value: 630 + index },
    { time: 256 + index, value: 640 + index },
  ])
    assert.deepEqual(prepared.controller.update(point), stream.update(point));
  prepared.controller.reset();
  stream.setData([]);
  assert.deepEqual(prepared.controller.update({ time: 0, value: 3 }), stream.update({ time: 0, value: 3 }));
}
assert.deepEqual(internal.prepareBatch([], []), []);
console.log(
  'Internal installed ESM/SSR batch ownership, duplicate/tail/reset and unchanged root exports PASS',
);

import * as chartRoot from '@filtix/charts';
import * as chartInternal from '@filtix/charts/internal';
import { createOwnedStudyStore, createOwnedVolumeStoreFromPrice, SeriesStore } from '@filtix/core';
assert.deepEqual(Object.keys(chartInternal).sort(), [
  'hasOwnedStudyColumnCapability',
  'setOwnedPriceVolumeData',
  'setOwnedStudyColumns',
]);
for (const key of Object.keys(chartInternal))
  assert.equal(chartInternal[key], chartRoot[key], key + ' chart registry runtime identity');
for (const key of ['window', 'document', 'HTMLElement', 'ResizeObserver'])
  assert.equal(typeof globalThis[key], 'undefined', 'Headless charts internal import: ' + key);
const fakeChart = new Proxy(
  {},
  {
    get() {
      throw Error('A capability check must not inspect a mock');
    },
  },
);
assert.equal(chartInternal.hasOwnedStudyColumnCapability(fakeChart), false);
assert.throws(() =>
  chartInternal.setOwnedStudyColumns(fakeChart, {}, [], {
    kind: 'scalar',
    column: { values: new Float64Array(), present: new Uint8Array() },
  }),
);
assert.throws(
  () => chartInternal.setOwnedPriceVolumeData(fakeChart, {}, {}, []),
  (error) => error.code === 'INVALID_SERIES',
);
assert.equal('setOwnedStudyColumns' in SeriesStore.prototype, false);
assert.equal('deriveOwnedVolume' in SeriesStore.prototype, false);
assert.equal('setOwnedPriceVolumeData' in SeriesStore.prototype, false);
const priceSource = new SeriesStore('candlestick', 'utc-ms');
priceSource.setData([
  { time: 0, open: 2, high: 4, low: 1, close: 3, volume: -0 },
  { time: 1, open: 3, high: 5, low: 2, close: 4, volume: 0 },
  { time: 2, open: 4, high: 6, low: 3, close: 5 },
  { time: 3 },
]);
const copiedVolume = createOwnedVolumeStoreFromPrice(priceSource);
assert.ok(copiedVolume instanceof SeriesStore, 'Volume factory shares the installed core class');
const volumePoints = Array.from({ length: copiedVolume.length }, (_, index) => copiedVolume.pointAt(index));
assert.deepEqual(volumePoints, [{ time: 0, value: -0 }, { time: 1, value: 0 }, { time: 2 }, { time: 3 }]);
assert.equal(Object.is(volumePoints[0].value, -0), true);
assert.equal(Object.is(volumePoints[1].value, 0), true);
priceSource.setData([{ time: 10, open: 10, high: 12, low: 9, close: 11, volume: 99 }]);
assert.deepEqual(
  Array.from({ length: copiedVolume.length }, (_, index) => copiedVolume.pointAt(index)),
  volumePoints,
  'Installed derived volume does not alias its source storage',
);
copiedVolume.update({ time: 3, value: 7 });
copiedVolume.update({ time: 4, value: 8 });
assert.deepEqual(priceSource.pointAt(0), {
  time: 10,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 99,
});
assert.equal(Object.hasOwn(publicIndicators, 'prepareOwnedBatch'), false);
const ownedPoints = Array.from({ length: 64 }, (_, time) => ({ time, value: 20 + Math.sin(time / 3) }));
const reference = internal.prepareBatch(batchRequests, ownedPoints);
const owned = internal.prepareOwnedBatch(batchRequests, ownedPoints, 'utc-ms');
assert.equal(owned.points, ownedPoints);
for (let i = 0; i < owned.studies.length; i++) {
  const study = owned.studies[i],
    expected = reference[i].prepared;
  const outputs = Array.isArray(expected.data) ? { value: expected.data } : expected.data;
  for (const [key, column] of Object.entries(study.outputs)) {
    const store = createOwnedStudyStore('line', 'utc-ms', owned.points, { kind: 'scalar', column });
    assert.ok(store instanceof SeriesStore, 'Core internal factory shares root store identity');
    const snapshot = outputs[key];
    for (let row = 0; row < ownedPoints.length; row++) assert.deepEqual(store.pointAt(row), snapshot[row]);
    column.values.fill(-999);
    column.present.fill(0);
    for (let row = 0; row < ownedPoints.length; row++) assert.deepEqual(store.pointAt(row), snapshot[row]);
  }
  for (const point of [{ time: 63, value: 30 }, { time: 64 }, { time: 64, value: 31 }])
    assert.deepEqual(study.controller.update(point), expected.controller.update(point));
}
assert.throws(() => internal.prepareOwnedBatch([], [], 'business-date'));
console.log('Installed charts root/shim identity, SSR, owned indicator/core copies and tail isolation PASS');

import * as alertRoot from '@filtix/alerts';
import * as alertInternal from '@filtix/alerts/internal';
for (const key of ['window', 'document', 'HTMLElement', 'ResizeObserver'])
  assert.equal(typeof globalThis[key], 'undefined', 'Headless alerts import: ' + key);
assert.deepEqual(Object.keys(alertInternal).sort(), [
  'getPriceAlertMonitorResourceSnapshot',
  'getPriceAlertStoreResourceSnapshot',
  'prepareAlertMembershipReplacement',
  'preparePriceAlertStoreRestore',
]);
assert.deepEqual(
  Object.keys(alertRoot).sort(),
  [
    'copyPriceAlertDocument',
    'createEmptyPriceAlertDocument',
    'createPriceAlertMonitor',
    'createPriceAlertStore',
    'decodePriceAlertDocument',
    ...Object.keys(alertInternal),
  ].sort(),
);
for (const key of Object.keys(alertInternal))
  assert.equal(alertInternal[key], alertRoot[key], key + ' runtime identity');
const alertCounts = { histories: 0, active: 0, subscribed: 0, unsubscribed: 0, providerDestroyed: 0 };
let alertAdopted = false,
  alertHandlers;
const alertBar = (close) => ({
  time: 0,
  open: 1,
  high: Math.max(1, close),
  low: Math.min(1, close),
  close,
  volume: 1,
});
const alertProvider = {
  id: 'installed-alert-consumer',
  revisionMode: 'arrival',
  maxPageSize: 1,
  async getHistory(request) {
    assert.ok(alertAdopted);
    assert.equal(request.limit, 1);
    alertCounts.histories++;
    return { bars: [alertBar(1)], exhausted: true };
  },
  subscribe(query, handlers) {
    assert.ok(alertAdopted);
    alertHandlers = handlers;
    alertCounts.active++;
    alertCounts.subscribed++;
    handlers.onOpen();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      alertCounts.active--;
      alertCounts.unsubscribed++;
      handlers.onBar(alertBar(9));
      handlers.onClose();
    };
  },
  destroy() {
    alertCounts.providerDestroyed++;
  },
};
const oldStore = alertRoot.createPriceAlertStore({ providerId: alertProvider.id, scopeId: 'old' });
const nextStore = alertRoot.createPriceAlertStore({ providerId: alertProvider.id, scopeId: 'next' });
const candidate = alertRoot.createPriceAlertStore({ providerId: alertProvider.id, scopeId: 'next' });
const alertMonitor = alertRoot.createPriceAlertMonitor({ provider: alertProvider });
let oldLease = () => {},
  newLeases = [],
  stopEvents = () => {};
try {
  oldLease = alertMonitor.attach(oldStore);
  const replacement = alertInternal.prepareAlertMembershipReplacement(alertMonitor, {
    retire: [oldLease],
    attach: [nextStore],
  });
  newLeases = replacement.commit();
  assert.equal(alertCounts.subscribed, 0);
  replacement.activate();
  assert.equal(alertInternal.getPriceAlertStoreResourceSnapshot(oldStore).admissionListeners, 0);
  assert.equal(alertInternal.getPriceAlertStoreResourceSnapshot(nextStore).admissionListeners, 1);
  assert.equal(alertInternal.getPriceAlertMonitorResourceSnapshot(alertMonitor).leaseEntries, 1);
  candidate.add({
    query: { symbol: 'A', interval: '1m' },
    price: 2,
    condition: 'crosses-up',
    frequency: 'repeat',
  });
  const observed = [];
  stopEvents = nextStore.subscribeEvents((event) => observed.push(event));
  const restore = alertInternal.preparePriceAlertStoreRestore(nextStore, candidate.toJSON());
  restore.commit({
    assertCurrent() {},
    adopt() {
      alertAdopted = true;
    },
  });
  assert.equal(alertCounts.subscribed, 0);
  restore.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alertCounts.active, 1);
  assert.equal(alertCounts.histories, 1);
  assert.equal(observed.length, 0);
  assert.equal(alertInternal.getPriceAlertMonitorResourceSnapshot(alertMonitor).activeRuntimeEntries, 1);
  const runtime = alertInternal.getPriceAlertMonitorResourceSnapshot(alertMonitor).runtimes[0];
  assert.deepEqual(runtime.query, { symbol: 'A', interval: '1m' });
  assert.equal(runtime.active, true);
  assert.equal(runtime.feed.mode, 'latest');
  assert.equal(runtime.feed.retainedBars, 1);
  assert.equal(runtime.feed.pendingBarEntries, 0);
  assert.equal(runtime.feed.pendingRequest, false);
  alertHandlers.onBar(alertBar(2));
  assert.equal(observed.length, 1);
  assert.equal(observed[0].occurrence, 1);
} finally {
  oldLease();
  for (const release of newLeases) release();
  alertMonitor.destroy();
  stopEvents();
  oldStore.destroy();
  nextStore.destroy();
  candidate.destroy();
}
assert.equal(alertCounts.active, 0);
assert.equal(alertCounts.subscribed, alertCounts.unsubscribed);
assert.equal(alertCounts.providerDestroyed, 0);
for (const value of [oldStore, nextStore, candidate]) {
  const snapshot = alertInternal.getPriceAlertStoreResourceSnapshot(value);
  assert.equal(snapshot.destroyed, true);
  for (const [key, count] of Object.entries(snapshot)) if (key !== 'destroyed') assert.equal(count, 0, key);
}
const finalMonitor = alertInternal.getPriceAlertMonitorResourceSnapshot(alertMonitor);
assert.equal(finalMonitor.destroyed, true);
for (const [key, count] of Object.entries(finalMonitor))
  if (key === 'runtimes') assert.deepEqual(count, [], 'All monitor feed snapshots must retire');
  else if (key !== 'destroyed') assert.equal(count, typeof count === 'boolean' ? false : 0, key);
assert.throws(() => alertInternal.getPriceAlertStoreResourceSnapshot({}));
assert.throws(() => alertInternal.getPriceAlertMonitorResourceSnapshot({}));
console.log(
  'Installed alerts root/internal brands, silent adoption, latest feed, SSR and exact owned resource cleanup PASS',
);
