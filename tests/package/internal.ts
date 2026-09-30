import {
  prepareScalar,
  prepareMacd,
  prepareBollinger,
  prepareBatch,
  type PreparationRequest,
  type BatchPreparedOutput,
  prepareOwnedBatch,
  type OwnedBatch,
  type ScalarColumns,
} from '@filtrix.net/indicators/internal';
import type { IndicatorPoint, MacdResult, BollingerBandsResult } from '@filtrix.net/indicators';
const points: IndicatorPoint[] = [
  { time: 0, value: 1 },
  { time: 1, value: 2 },
];
const scalar = prepareScalar('ema', 2, points);
const scalarData: IndicatorPoint[] = scalar.data;
const scalarUpdate: IndicatorPoint = scalar.controller.update({ time: 1, value: 3 });
const macd = prepareMacd({ fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 }, points);
const macdData: MacdResult<IndicatorPoint[]> = macd.data;
const macdUpdate: MacdResult<IndicatorPoint> = macd.controller.update({ time: 2, value: 4 });
const bands = prepareBollinger({ period: 2, multiplier: 2 }, points);
const bandsData: BollingerBandsResult<IndicatorPoint[]> = bands.data;
const bandsUpdate: BollingerBandsResult<IndicatorPoint> = bands.controller.update({ time: 2, value: 4 });
scalar.controller.reset();
macd.controller.reset();
bands.controller.reset();
void [scalarData, scalarUpdate, macdData, macdUpdate, bandsData, bandsUpdate];

// @ts-expect-error Internal batch preparation must not appear at the public root.
import { prepareBatch as forbiddenPublicBatch } from '@filtrix.net/indicators';
// @ts-expect-error Internal request types must not appear at the public root.
import type { PreparationRequest as ForbiddenPublicRequest } from '@filtrix.net/indicators';
// @ts-expect-error Internal result types must not appear at the public root.
import type { BatchPreparedOutput as ForbiddenPublicResult } from '@filtrix.net/indicators';
const requests: PreparationRequest[] = [
  { kind: 'sma', period: 200 },
  { kind: 'ema', period: 20 },
  { kind: 'rsi', period: 14 },
  { kind: 'macd', options: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  { kind: 'bollinger', options: { period: 20, multiplier: 2 } },
];
function* typedRequests(): Iterable<PreparationRequest> {
  yield* requests;
}
const preparedBatch: BatchPreparedOutput[] = prepareBatch(typedRequests(), points, 'utc-ms');
for (const result of preparedBatch) {
  if (result.kind === 'macd') {
    const data: MacdResult<IndicatorPoint[]> = result.prepared.data;
    const tail: MacdResult<IndicatorPoint> = result.prepared.controller.update({ time: 1, value: 3 });
    void [data, tail];
  } else if (result.kind === 'bollinger') {
    const data: BollingerBandsResult<IndicatorPoint[]> = result.prepared.data;
    const tail: BollingerBandsResult<IndicatorPoint> = result.prepared.controller.update({
      time: 1,
      value: 3,
    });
    void [data, tail];
  } else {
    const data: IndicatorPoint[] = result.prepared.data;
    const tail: IndicatorPoint = result.prepared.controller.update({ time: 1, value: 3 });
    void [data, tail];
  }
  result.prepared.controller.reset();
}
// @ts-expect-error The internal request union does not accept arbitrary study kinds.
prepareBatch([{ kind: 'unknown', period: 2 }], points);
// @ts-expect-error MACD options retain their exact required shape.
prepareBatch([{ kind: 'macd', options: { fastPeriod: 2 } }], points);

import { createPriceAlertStore, createPriceAlertMonitor } from '@filtrix.net/alerts';
import type { MarketDataProvider } from '@filtrix.net/datafeed';
import {
  prepareAlertMembershipReplacement,
  preparePriceAlertStoreRestore,
  getPriceAlertStoreResourceSnapshot,
  getPriceAlertMonitorResourceSnapshot,
  type PreparedAlertMembership,
  type PreparedPriceAlertStoreRestore,
  type PriceAlertStoreResourceSnapshot,
  type PriceAlertMonitorResourceSnapshot,
} from '@filtrix.net/alerts/internal';
declare const alertProvider: MarketDataProvider;
const alertStore = createPriceAlertStore({ providerId: alertProvider.id, scopeId: 'types' });
const alertMonitor = createPriceAlertMonitor({ provider: alertProvider });
const membership: PreparedAlertMembership = prepareAlertMembershipReplacement(alertMonitor, {
  retire: [],
  attach: [alertStore],
});
const release = membership.commit();
membership.activate();
const restore: PreparedPriceAlertStoreRestore = preparePriceAlertStoreRestore(
  alertStore,
  alertStore.toJSON(),
);
restore.commit({ assertCurrent() {}, adopt() {} });
restore.activate();
const storeResources: PriceAlertStoreResourceSnapshot = getPriceAlertStoreResourceSnapshot(alertStore);
const monitorResources: PriceAlertMonitorResourceSnapshot =
  getPriceAlertMonitorResourceSnapshot(alertMonitor);
const count: number = storeResources.admissionListeners + monitorResources.runtimeEntries;
const pending: 0 | 1 = monitorResources.reconcileTimers;
void [release, count, pending];

import {
  createOwnedStudyStore,
  createOwnedVolumeStoreFromPrice,
  SeriesStore,
  type OwnedStudyColumnInput,
  type SeriesPoint,
} from '@filtrix.net/core';
import type { ChartApi, SeriesHandle } from '@filtrix.net/charts';
import {
  hasOwnedStudyColumnCapability,
  setOwnedStudyColumns,
  setOwnedPriceVolumeData,
} from '@filtrix.net/charts/internal';
declare const builtChart: ChartApi;
declare const builtHandle: SeriesHandle;
const ownedPoints: (IndicatorPoint & { time: number })[] = [
  { time: 0, value: 1 },
  { time: 1, value: 2 },
];
const ownedBatch: OwnedBatch = prepareOwnedBatch(requests, ownedPoints, 'utc-ms');
const ownedColumn: ScalarColumns = { values: new Float64Array(2), present: new Uint8Array(2) };
const ownedInput: OwnedStudyColumnInput = { kind: 'scalar', column: ownedColumn };
const candidateStore = createOwnedStudyStore('line', 'utc-ms', ownedBatch.points, ownedInput);
const capable: boolean = hasOwnedStudyColumnCapability(builtChart);
setOwnedStudyColumns(builtChart, builtHandle, ownedBatch.points, ownedInput);
declare const builtVolumeHandle: SeriesHandle;
const ownedBars: readonly SeriesPoint[] = [{ time: 0, open: 2, high: 4, low: 1, close: 3, volume: -0 }];
const installedPriceStore = new SeriesStore('candlestick', 'utc-ms');
installedPriceStore.setData(ownedBars);
const installedVolumeStore: SeriesStore = createOwnedVolumeStoreFromPrice(installedPriceStore);
setOwnedPriceVolumeData(builtChart, builtHandle, builtVolumeHandle, ownedBars);
// @ts-expect-error The private bridge requires both concrete handles and a data argument.
setOwnedPriceVolumeData(builtChart, builtHandle, ownedBars);
// @ts-expect-error Deriving volume is not a public handle mutation method.
builtHandle.setOwnedPriceVolumeData(ownedBars);
// @ts-expect-error The private copier is not a named public SeriesStore method.
installedPriceStore.deriveOwnedVolume();
// @ts-expect-error Owned batches are UTC-only.
prepareOwnedBatch(requests, ownedPoints, 'business-date');
// @ts-expect-error Owned transport does not accept calendar strings in its time source.
prepareOwnedBatch(requests, [{ time: '2026-01-01', value: 1 }], 'utc-ms');
// @ts-expect-error A prepared-store mutator is not a public SeriesStore method.
candidateStore.setOwnedStudyColumns(points, ownedInput);
// @ts-expect-error The ordinary chart handle API stays unchanged.
builtHandle.setOwnedStudyColumns(points, ownedInput);
// @ts-expect-error Owned preparation is not exported from the indicator root.
import { prepareOwnedBatch as forbiddenOwnedRoot } from '@filtrix.net/indicators';
void [capable, candidateStore, installedVolumeStore];
