import { getMonitorInternals, type PriceAlertMonitor } from './monitor';
import { getStoreCapability } from './store';
import type { PriceAlertStore } from './types';
import type { FeedSessionResourceSnapshot, MarketQuery } from '@filtrix.net/datafeed';

export interface PriceAlertStoreResourceSnapshot {
  readonly destroyed: boolean;
  readonly changeListeners: number;
  readonly eventListeners: number;
  readonly admissionListeners: number;
  readonly lifecycleListeners: number;
}

export interface PriceAlertMonitorResourceSnapshot {
  readonly destroyed: boolean;
  readonly members: number;
  readonly leaseEntries: number;
  readonly observerListeners: number;
  readonly retainedMemberDisposers: number;
  readonly cachedRuleEntries: number;
  readonly baselineEntries: number;
  readonly runtimeEntries: number;
  readonly activeRuntimeEntries: number;
  readonly reconcileTimers: 0 | 1;
  readonly reservationPending: boolean;
  readonly activationPending: boolean;
  readonly runtimes: readonly {
    readonly query: MarketQuery;
    readonly active: boolean;
    readonly feed: FeedSessionResourceSnapshot;
  }[];
}

/** @internal Unsupported package-private diagnostic; access through @filtrix.net/alerts/internal. */
export function getPriceAlertStoreResourceSnapshot(store: PriceAlertStore): PriceAlertStoreResourceSnapshot {
  return getStoreCapability(store).getResourceSnapshot();
}

/** @internal Unsupported package-private diagnostic; access through @filtrix.net/alerts/internal. */
export function getPriceAlertMonitorResourceSnapshot(
  monitor: PriceAlertMonitor,
): PriceAlertMonitorResourceSnapshot {
  return getMonitorInternals(monitor).getResourceSnapshot();
}
