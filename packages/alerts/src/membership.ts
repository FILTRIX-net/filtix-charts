import type { PriceAlertStore } from './types';
import { getMonitorInternals, type PriceAlertMonitor } from './monitor';

export interface PreparedAlertMembership {
  commit(): readonly (() => void)[];
  abort(): void;
  activate(): void;
}

/** @internal */
export function prepareAlertMembershipReplacement(
  monitor: PriceAlertMonitor,
  options: { retire: readonly (() => void)[]; attach: readonly PriceAlertStore[] },
): PreparedAlertMembership {
  return getMonitorInternals(monitor).prepare(options);
}
