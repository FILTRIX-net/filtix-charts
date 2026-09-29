# Price alerts

The private v0.10.0 release adds persistent rules in @filtix/alerts and an Alerts editor in @filtix/terminal. The installed workload and independent reviews pass; see the [release report](releases/v0.10.md) for evidence and limits. The headless alerts package can be used without charts or React; the full terminal requires the alerts peer package. Chart/core consumers do not need alerts.

## Terminal integration

```ts
import { createTerminal } from '@filtix/terminal';
const terminal = createTerminal(host, {
  provider,
  query: { symbol: 'BTCUSDT', interval: '1m' },
  symbols: ['BTCUSDT', 'ETHUSDT'],
  intervals: ['1m', '5m'],
  onAlert(event) {
    console.log(event.query, event.price, event.threshold, event.occurrence);
  },
});
const id = terminal.getAlerts().add({
  query: { symbol: 'ETHUSDT', interval: '1m' },
  price: 2500,
  condition: 'crosses-up',
  frequency: 'once',
  label: 'ETH threshold',
});
terminal.getAlerts().pause(id);
terminal.getAlerts().rearm(id);
const saved = terminal.getWorkspace(); // canonical workspace version 5
await terminal.restoreWorkspace(saved);
terminal.destroy();
```

Every armed saved market is monitored while mounted, including markets other than the displayed chart. getAlertState() returns the monitor's aggregate query transport states; it can include other stores attached to a supplied shared monitor. Rule status (armed, paused, triggered) is separate from connecting/monitoring/reconnecting/error transport status.

The keyed native editor supports create, edit, pause, rearm and delete. Invalid focused drafts survive streaming and remain separate from saved rules until validation succeeds. The recent trigger list is bounded to20 in-memory events; each rule persists only its latest trigger and occurrence count. Opening Alerts does not request browser notification permission.

## Crossing and recovery semantics

Only accepted observed MarketBar.close values are evaluated. Prices are finite and unrounded; zero and negative thresholds are valid. crosses-up means previousPrice < threshold and price >= threshold; crosses-down means previousPrice > threshold and price <= threshold; crosses accepts either direction. An initial value exactly on the threshold does not itself fire an alert.

Initial data, history, correction and reconnect observations establish/reset baselines without replaying historical crossings. Older live samples are ignored. Rearming resets that rule's baseline before public observers run. once changes the rule to triggered after its first crossing; repeat remains armed. Events identify provider, scope, rule, query and occurrence; barTime is candle-open time and observedAt is local observation time. An arrival-ordered provider without event IDs cannot guarantee duplicate detection.

> Alerts are evaluated while this application is running and receiving data. Crossings missed during a gap are not recovered.

There is no backend monitor, browser permission prompt, sound, email or webhook delivery. Applications own any external notification workflow.

## Headless store and shared monitor

```ts
import { createPriceAlertStore, createPriceAlertMonitor } from '@filtix/alerts';
const store = createPriceAlertStore({ providerId: provider.id, scopeId: 'portfolio-A' });
const monitor = createPriceAlertMonitor({ provider });
const unsubscribe = store.subscribeEvents((event) => console.log(event));
const release = monitor.attach(store);
// Add/restore rules; each exact armed query shares one latest feed.
release();
unsubscribe();
monitor.destroy();
store.destroy();
```

Store operations are add, update, remove, pause, rearm, list, subscribe, subscribeEvents, toJSON, restore and destroy. Snapshots/documents are defensive. Destruction releases listeners and leaves bounded final saved snapshots readable; later mutations reject. The monitor provides attach, getState, subscribe, retry and destroy. Monitor subscriptions report membership and transport-state changes; steady price samples with unchanged status/error do not notify them. Subscribe to store events for price crossings. Attach returns an idempotent lease release; multiple leases for the same store share membership. Releasing the last lease stops that membership. Providers are always borrowed and are never destroyed by store, monitor or terminal.

Limits are100 saved rules per store,400 distinct attached rules per monitor and32 distinct armed provider/symbol/interval queries. Paused and triggered rules count toward rule capacity. Edits and attachment validate prospective totals before changing state. Empty stores add no monitoring feeds. Latest feed mode retains one bar and one buffered candidate; chart history remains a separate feed.

## Ownership and persistence

Terminal options alerts.store and alerts.monitor compose independently. Each supplied object is borrowed; each omitted counterpart is created and owned. A terminal releases its lease/listeners and destroys only resources it owns. A supplied store can continue being used after terminal teardown. getAlerts() returns the current store even after teardown; an owned destroyed store rejects mutations. getAlertState() reflects the current monitor, which may remain live when borrowed.

The exact alert document is schema:filtix-price-alerts, version:1, scopeId, providerId, nextRuleId and alerts. Labels are at most120 characters. Rule IDs and occurrence IDs are opaque. Save via store.toJSON() or the terminal workspace; storage is explicit and host-owned. The library never writes localStorage. Rule thresholds and last-trigger prices/timestamps are part of saved state; bar history, transport credentials and provider configuration are not.

Workspace v5 adds alerts and keeps drawing documents v2. Strict historical v1–v4 workspaces migrate with an empty alert document using the mounted store's scope. TerminalWorkspaceV4 and TerminalWorkspaceV4WithDrawingsV2 remain distinct frozen historical types. Current saves use TerminalWorkspace version5. Old packages cannot read v5 saves.

An owned terminal can restore another saved scope using a prepared membership replacement. Reacquire getAlerts() after restoration: the prior owned store can be replaced and destroyed. A borrowed store has fixed provider/scope identity, so a mismatched saved scope rejects before mutation. Restore validates aggregate capacity before coherent store/terminal adoption and observer notification. It never emits saved historical events as new crossings.

The /internal entry contains unsupported library coordination and measurement functions; applications should use the public APIs above. Accepted performance results, installed-cohort identities and measured cadence limitations are recorded in the [private v0.10 release report](releases/v0.10.md).
