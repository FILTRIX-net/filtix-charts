import {
  createFeedSession,
  getFeedSessionResourceSnapshot,
  type FeedChange,
  type FeedFailure,
  type FeedSession,
  type FeedState,
  type MarketBar,
  type MarketDataProvider,
  type MarketQuery,
} from '@filtix/datafeed';
import { alertEventId, alertIdentity } from './codec';
import { crossed } from './evaluator';
import {
  getStoreCapability,
  type ReadonlyStoreSnapshot,
  type StoreCapability,
  type StoreLifecycleChange,
} from './store';
import type { PriceAlert, PriceAlertEvent, PriceAlertStore } from './types';
import type { PreparedAlertMembership } from './membership';

export type PriceAlertTransportStatus = 'connecting' | 'monitoring' | 'reconnecting' | 'error';
export interface PriceAlertQueryState {
  query: MarketQuery;
  status: PriceAlertTransportStatus;
  error: FeedFailure | null;
}
export interface PriceAlertMonitorState {
  providerId: string;
  destroyed: boolean;
  queries: readonly PriceAlertQueryState[];
}
export interface PriceAlertMonitor {
  attach(store: PriceAlertStore): () => void;
  getState(): PriceAlertMonitorState;
  subscribe(listener: () => void): () => void;
  retry(query?: MarketQuery): Promise<void>;
  destroy(): void;
}
export interface MonitorInternals {
  getResourceSnapshot(): import('./resources').PriceAlertMonitorResourceSnapshot;
  prepare(options: {
    retire: readonly (() => void)[];
    attach: readonly PriceAlertStore[];
  }): PreparedAlertMembership;
}

interface Lease {
  member: Member;
  active: boolean;
  release: () => void;
}
interface Member {
  store: PriceAlertStore;
  capability: StoreCapability;
  scopeId: string;
  alerts: readonly PriceAlert[];
  baselines: Map<string, number>;
  leases: Set<Lease>;
  dispose: Array<() => void>;
}
interface Runtime {
  key: string;
  query: MarketQuery;
  feed: FeedSession;
  active: boolean;
  status: PriceAlertTransportStatus;
  error: FeedFailure | null;
  current: MarketBar | null;
}
interface Reservation {
  active: boolean;
  revision: number;
}

const internals = new WeakMap<PriceAlertMonitor, MonitorInternals>();
function fail(message: string): never {
  throw new TypeError(`INVALID_PRICE_ALERT_MONITOR: ${message}`);
}
function queryKey(providerId: string, query: MarketQuery): string {
  return JSON.stringify([providerId, query.symbol, query.interval]);
}
function copyQuery(query: MarketQuery): MarketQuery {
  return { symbol: query.symbol, interval: query.interval };
}
function copyFailure(error: FeedFailure | null): FeedFailure | null {
  return error ? { ...error } : null;
}
function sameFailure(left: FeedFailure | null, right: FeedFailure | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.retryable === right.retryable &&
    left.retryAfterMs === right.retryAfterMs
  );
}
function sameRule(left: PriceAlert, right: PriceAlert): boolean {
  return (
    left.status === right.status &&
    left.triggerCount === right.triggerCount &&
    left.query.symbol === right.query.symbol &&
    left.query.interval === right.query.interval &&
    left.price === right.price &&
    left.condition === right.condition &&
    left.frequency === right.frequency
  );
}

export function getMonitorInternals(monitor: PriceAlertMonitor): MonitorInternals {
  const value = internals.get(monitor);
  if (!value) fail('Monitor was not created by createPriceAlertMonitor');
  return value;
}

export function createPriceAlertMonitor(options: { provider: MarketDataProvider }): PriceAlertMonitor {
  if (!options || typeof options !== 'object' || !options.provider) fail('provider is required');
  const provider = options.provider;
  const providerId = alertIdentity(provider.id, 'providerId');
  let destroyed = false;
  let revision = 0;
  let reservation: Reservation | null = null;
  let activationPending = false;
  let retainRuntimeCallbacks = false;
  let reconciling = false;
  let dirty = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileGeneration = 0;
  const members = new Map<PriceAlertStore, Member>();
  const tokens = new WeakMap<() => void, Lease>();
  const runtimes = new Map<string, Runtime>();
  const listeners = new Set<() => void>();

  const requireAlive = (): void => {
    if (destroyed) fail('Monitor is destroyed');
  };
  const notify = (): void => {
    for (const listener of [...listeners]) {
      if (destroyed) return;
      try {
        listener();
      } catch {
        /* Isolate host observers. */
      }
    }
  };
  const keyFor = (rule: PriceAlert): string => queryKey(providerId, rule.query);
  const currentFor = (rule: PriceAlert): MarketBar | null => {
    const runtime = runtimes.get(keyFor(rule));
    return runtime?.active && runtime.status === 'monitoring' ? runtime.current : null;
  };
  const seed = (member: Member, rule: PriceAlert): void => {
    const current = currentFor(rule);
    if (rule.status === 'armed' && current) member.baselines.set(rule.id, current.close);
    else member.baselines.delete(rule.id);
  };
  const seedQuery = (key: string, current: MarketBar | null): void => {
    for (const member of members.values())
      for (const rule of member.alerts) {
        if (rule.status !== 'armed' || keyFor(rule) !== key) continue;
        if (current) member.baselines.set(rule.id, current.close);
        else member.baselines.delete(rule.id);
      }
  };
  const validateAggregate = (
    entries: readonly { store: PriceAlertStore; scopeId: string; alerts: readonly PriceAlert[] }[],
  ): void => {
    const scopes = new Map<string, PriceAlertStore>();
    const queries = new Set<string>();
    let count = 0;
    for (const entry of entries) {
      const prior = scopes.get(entry.scopeId);
      if (prior && prior !== entry.store) fail(`Duplicate attached scope: ${entry.scopeId}`);
      scopes.set(entry.scopeId, entry.store);
      if (entry.alerts.length > 100) fail('Store exceeds 100 alerts');
      count += entry.alerts.length;
      if (count > 400) fail('Monitor exceeds 400 attached rules');
      for (const rule of entry.alerts)
        if (rule.status === 'armed') {
          queries.add(keyFor(rule));
          if (queries.size > 32) fail('Monitor exceeds 32 armed queries');
        }
    }
  };
  const entriesWith = (
    store?: PriceAlertStore,
    proposed?: ReadonlyStoreSnapshot,
  ): Array<{ store: PriceAlertStore; scopeId: string; alerts: readonly PriceAlert[] }> =>
    [...members.values()].map((member) => {
      // A host listener may run before our change listener; the committed store is authoritative.
      const snapshot = member.store === store && proposed ? proposed : member.store.toJSON();
      return { store: member.store, scopeId: snapshot.scopeId, alerts: snapshot.alerts };
    });

  const onChange = (runtime: Runtime, change: FeedChange): void => {
    if (
      destroyed ||
      (activationPending && !retainRuntimeCallbacks) ||
      !runtime.active ||
      runtimes.get(runtime.key) !== runtime
    )
      return;
    if (change.type === 'reset') {
      const current =
        change.reason === 'correction' && runtime.status === 'reconnecting'
          ? null
          : (change.bars.at(-1) ?? null);
      runtime.current = current ? { ...current } : null;
      seedQuery(runtime.key, runtime.current);
      return;
    }
    const observed = change.bar;
    runtime.current = { ...observed };
    const candidates = [...members.values()].flatMap((member) =>
      member.alerts
        .filter((rule) => rule.status === 'armed' && keyFor(rule) === runtime.key)
        .map((rule) => ({ store: member.store, id: rule.id })),
    );
    for (const candidate of candidates) {
      if (
        destroyed ||
        (activationPending && !retainRuntimeCallbacks) ||
        !runtime.active ||
        runtimes.get(runtime.key) !== runtime
      )
        return;
      const member = members.get(candidate.store);
      if (!member) continue;
      const rule = member.alerts.find((item) => item.id === candidate.id);
      if (!rule || rule.status !== 'armed' || keyFor(rule) !== runtime.key) continue;
      const baseline = member.baselines.get(rule.id);
      member.baselines.set(rule.id, observed.close);
      if (baseline === undefined || !crossed(baseline, observed.close, rule.price, rule.condition)) continue;
      if (rule.triggerCount >= Number.MAX_SAFE_INTEGER) continue;
      const occurrence = rule.triggerCount + 1;
      const event: PriceAlertEvent = {
        id: alertEventId(member.scopeId, rule.id, occurrence),
        scopeId: member.scopeId,
        alertId: rule.id,
        providerId,
        query: copyQuery(rule.query),
        condition: rule.condition,
        threshold: rule.price,
        previousPrice: baseline,
        price: observed.close,
        barTime: observed.time,
        observedAt: Date.now(),
        occurrence,
      };
      try {
        member.capability.commitTrigger(rule.id, event);
      } catch {
        /* Rejected admission is atomic. */
      }
    }
  };
  const onState = (runtime: Runtime, state: FeedState): void => {
    if (
      destroyed ||
      (activationPending && !retainRuntimeCallbacks) ||
      !runtime.active ||
      runtimes.get(runtime.key) !== runtime
    )
      return;
    const previousStatus = runtime.status;
    const previousError = runtime.error;
    const status =
      state.status === 'live'
        ? 'monitoring'
        : state.status === 'error'
          ? 'error'
          : state.status === 'reconnecting' || state.status === 'stale'
            ? 'reconnecting'
            : 'connecting';
    const error = copyFailure(state.error);
    runtime.status = status;
    runtime.error = error;
    if (runtime.status !== 'monitoring') {
      runtime.current = null;
      seedQuery(runtime.key, null);
    }
    if (status !== previousStatus || !sameFailure(previousError, error)) notify();
  };
  const stopRuntime = (runtime: Runtime): void => {
    runtime.active = false;
    runtimes.delete(runtime.key);
    runtime.feed.destroy();
  };
  const startRuntime = (key: string, query: MarketQuery): void => {
    const runtime: Runtime = {
      key,
      query: copyQuery(query),
      feed: null as unknown as FeedSession,
      active: true,
      status: 'connecting',
      error: null,
      current: null,
    };
    runtime.feed = createFeedSession({
      provider,
      mode: 'latest',
      onChange: (change) => onChange(runtime, change),
      onState: (state) => onState(runtime, state),
    });
    runtimes.set(key, runtime);
    void runtime.feed.load(copyQuery(query)).catch(() => {
      /* Feed state reports provider failures. */
    });
  };
  const desiredQueries = (): Map<string, MarketQuery> => {
    const desired = new Map<string, MarketQuery>();
    for (const member of members.values())
      for (const rule of member.alerts) if (rule.status === 'armed') desired.set(keyFor(rule), rule.query);
    return desired;
  };
  const cancelReconcileContinuation = (): void => {
    reconcileGeneration++;
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    reconcileTimer = null;
  };
  const scheduleReconcileContinuation = (): void => {
    if (reconcileTimer !== null || destroyed || activationPending) return;
    const generation = reconcileGeneration;
    const timer = setTimeout(() => {
      if (reconcileTimer !== timer || generation !== reconcileGeneration) return;
      reconcileTimer = null;
      if (!destroyed && !activationPending) reconcile();
    }, 0);
    reconcileTimer = timer;
  };
  const reconcile = (): void => {
    if (destroyed || activationPending) return;
    if (reconciling) {
      dirty = true;
      return;
    }
    cancelReconcileContinuation();
    reconciling = true;
    try {
      for (let pass = 0; pass < 8; pass++) {
        dirty = false;
        const desired = desiredQueries();
        for (const [key, runtime] of [...runtimes]) {
          if (destroyed || activationPending) return;
          if (dirty) break;
          if (!desired.has(key)) stopRuntime(runtime);
        }
        if (destroyed || activationPending) return;
        if (dirty) continue;
        for (const [key, query] of desired) {
          if (destroyed || activationPending) return;
          if (dirty) break;
          if (!runtimes.has(key)) startRuntime(key, query);
        }
        if (destroyed || activationPending) return;
        if (!dirty) return;
      }
      // Yield after bounded synchronous work, then drain the latest membership snapshot.
      scheduleReconcileContinuation();
    } finally {
      reconciling = false;
    }
  };
  const disposeMember = (member: Member): void => {
    for (const release of member.dispose) release();
    member.dispose.length = 0;
  };
  const onMemberChange = (member: Member): void => {
    if (destroyed || members.get(member.store) !== member) return;
    const next = member.store.toJSON();
    const prior = new Map(member.alerts.map((rule) => [rule.id, rule]));
    member.alerts = next.alerts;
    for (const id of [...member.baselines.keys()])
      if (!next.alerts.some((rule) => rule.id === id)) member.baselines.delete(id);
    for (const rule of next.alerts) {
      const old = prior.get(rule.id);
      if (!old || !sameRule(old, rule)) seed(member, rule);
    }
    revision++;
    if (!activationPending) {
      reconcile();
      notify();
    }
  };
  const onLifecycle = (member: Member, change: StoreLifecycleChange): void => {
    if (destroyed || members.get(member.store) !== member) return;
    if (change.type === 'rearm') {
      const rule = member.store.list().find((item) => item.id === change.alertId);
      if (rule) seed(member, rule);
      revision++;
      return;
    }
    for (const lease of member.leases) lease.active = false;
    member.leases.clear();
    members.delete(member.store);
    revision++;
    disposeMember(member);
    if (!activationPending) {
      reconcile();
      notify();
    }
  };
  const registerMember = (store: PriceAlertStore, capability: StoreCapability): Member => {
    const snapshot = store.toJSON();
    if (snapshot.providerId !== providerId) fail('Store provider does not match monitor');
    const member: Member = {
      store,
      capability,
      scopeId: snapshot.scopeId,
      alerts: snapshot.alerts,
      baselines: new Map(),
      leases: new Set(),
      dispose: [],
    };
    try {
      member.dispose.push(
        capability.registerAdmission((next) => {
          if (destroyed || members.get(store) !== member) return;
          validateAggregate(entriesWith(store, next));
        }),
      );
      member.dispose.push(capability.subscribeLifecycle((change) => onLifecycle(member, change)));
      member.dispose.push(store.subscribe(() => onMemberChange(member)));
      return member;
    } catch (error) {
      disposeMember(member);
      throw error;
    }
  };
  const makeLease = (member: Member): (() => void) => {
    const lease: Lease = { member, active: true, release: null as unknown as () => void };
    const release = (): void => {
      if (!lease.active) return;
      lease.active = false;
      member.leases.delete(lease);
      if (destroyed || members.get(member.store) !== member) return;
      if (member.leases.size === 0) {
        members.delete(member.store);
        disposeMember(member);
      }
      revision++;
      if (!activationPending) {
        reconcile();
        notify();
      }
    };
    lease.release = release;
    member.leases.add(lease);
    tokens.set(release, lease);
    return release;
  };

  const prepare: MonitorInternals['prepare'] = (options) => {
    requireAlive();
    if (reservation || activationPending) fail('Another membership replacement is active');
    if (!options || !Array.isArray(options.retire) || !Array.isArray(options.attach))
      fail('Invalid replacement');
    const retired: Lease[] = [];
    const seen = new Set<Lease>();
    for (const release of options.retire) {
      const lease = tokens.get(release);
      if (!lease || !lease.active || members.get(lease.member.store) !== lease.member || seen.has(lease))
        fail('Invalid retiring lease');
      seen.add(lease);
      retired.push(lease);
    }
    const attaching = [...options.attach];
    const capabilities = new Map<PriceAlertStore, StoreCapability>();
    const versions = new Map<PriceAlertStore, number>();
    for (const member of members.values()) {
      capabilities.set(member.store, member.capability);
      versions.set(member.store, member.capability.revision);
    }
    for (const store of attaching) {
      const capability = getStoreCapability(store);
      capabilities.set(store, capability);
      versions.set(store, capability.revision);
    }
    const finalStores = (): Array<{
      store: PriceAlertStore;
      scopeId: string;
      alerts: readonly PriceAlert[];
    }> => {
      const remaining = new Map<PriceAlertStore, number>();
      for (const member of members.values()) remaining.set(member.store, member.leases.size);
      for (const lease of retired) remaining.set(lease.member.store, remaining.get(lease.member.store)! - 1);
      for (const store of attaching) remaining.set(store, (remaining.get(store) ?? 0) + 1);
      const result = [];
      for (const [store, count] of remaining)
        if (count > 0) {
          const snapshot = store.toJSON();
          if (snapshot.providerId !== providerId) fail('Store provider does not match monitor');
          result.push({ store, scopeId: snapshot.scopeId, alerts: snapshot.alerts });
        }
      return result;
    };
    validateAggregate(finalStores());
    const held: Reservation = { active: true, revision };
    reservation = held;
    let committed = false;
    let activated = false;
    let retainsStoreSet = false;
    const abort = (): void => {
      if (!committed && held.active) {
        held.active = false;
        if (reservation === held) reservation = null;
      }
    };
    const commit = (): readonly (() => void)[] => {
      if (committed || !held.active || reservation !== held || destroyed || revision !== held.revision) {
        abort();
        fail('Stale membership replacement');
      }
      for (const [store, version] of versions)
        if (capabilities.get(store)!.revision !== version) {
          abort();
          fail('Participating store changed');
        }
      const created: Member[] = [];
      try {
        const final = finalStores();
        validateAggregate(final);
        retainsStoreSet = final.length === members.size && final.every(({ store }) => members.has(store));
        for (const store of new Set(attaching))
          if (!members.has(store)) created.push(registerMember(store, capabilities.get(store)!));
        for (const [store, version] of versions)
          if (capabilities.get(store)!.revision !== version) fail('Participating store changed');
      } catch (error) {
        created.forEach(disposeMember);
        abort();
        throw error;
      }
      cancelReconcileContinuation();
      if (!retainsStoreSet)
        for (const runtime of runtimes.values()) {
          runtime.active = false;
          runtime.current = null;
        }
      for (const lease of retired) {
        lease.active = false;
        lease.member.leases.delete(lease);
      }
      for (const member of created) members.set(member.store, member);
      const releases = attaching.map((store) => makeLease(members.get(store)!));
      for (const member of [...members.values()])
        if (member.leases.size === 0) {
          members.delete(member.store);
          disposeMember(member);
        }
      revision++;
      held.active = false;
      reservation = null;
      activationPending = true;
      retainRuntimeCallbacks = retainsStoreSet;
      committed = true;
      return releases;
    };
    const activate = (): void => {
      if (!committed || activated) return;
      activated = true;
      cancelReconcileContinuation();
      if (!retainsStoreSet)
        for (const runtime of [...runtimes.values()]) {
          if (destroyed) break;
          if (runtime.active || runtimes.get(runtime.key) === runtime) stopRuntime(runtime);
        }
      activationPending = false;
      retainRuntimeCallbacks = false;
      reconcile();
      notify();
    };
    return { commit, abort, activate };
  };

  const monitor: PriceAlertMonitor = {
    attach(store) {
      requireAlive();
      if (activationPending || reservation) fail('Membership replacement is active');
      const capability = getStoreCapability(store);
      let member = members.get(store);
      if (!member) {
        const snapshot = store.toJSON();
        validateAggregate([...entriesWith(), { store, scopeId: snapshot.scopeId, alerts: snapshot.alerts }]);
        const expected = capability.revision;
        member = registerMember(store, capability);
        if (capability.revision !== expected) {
          disposeMember(member);
          fail('Store changed during attachment');
        }
        members.set(store, member);
        for (const rule of member.alerts) if (rule.status === 'armed') seed(member, rule);
      }
      const release = makeLease(member);
      revision++;
      reconcile();
      notify();
      return release;
    },
    getState() {
      return {
        providerId,
        destroyed,
        queries: [...runtimes.values()]
          .filter((runtime) => runtime.active)
          .map((runtime) => ({
            query: copyQuery(runtime.query),
            status: runtime.status,
            error: copyFailure(runtime.error),
          })),
      };
    },
    subscribe(listener) {
      requireAlive();
      if (typeof listener !== 'function') fail('Listener must be a function');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async retry(query) {
      requireAlive();
      const selected = query
        ? [runtimes.get(queryKey(providerId, query))].filter((item): item is Runtime => !!item)
        : [...runtimes.values()];
      for (const runtime of selected) {
        if (!runtime.active) continue;
        runtime.current = null;
        seedQuery(runtime.key, null);
        await runtime.feed.retry();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelReconcileContinuation();
      revision++;
      if (reservation) reservation.active = false;
      reservation = null;
      activationPending = false;
      retainRuntimeCallbacks = false;
      for (const member of members.values()) {
        for (const lease of member.leases) lease.active = false;
        member.leases.clear();
        disposeMember(member);
      }
      members.clear();
      for (const runtime of [...runtimes.values()]) stopRuntime(runtime);
      listeners.clear();
    },
  };
  internals.set(monitor, {
    prepare,
    getResourceSnapshot() {
      let leaseEntries = 0;
      let retainedMemberDisposers = 0;
      let cachedRuleEntries = 0;
      let baselineEntries = 0;
      for (const member of members.values()) {
        leaseEntries += member.leases.size;
        retainedMemberDisposers += member.dispose.length;
        cachedRuleEntries += member.alerts.length;
        baselineEntries += member.baselines.size;
      }
      let activeRuntimeEntries = 0;
      for (const runtime of runtimes.values()) if (runtime.active) activeRuntimeEntries++;
      return {
        destroyed,
        members: members.size,
        leaseEntries,
        observerListeners: listeners.size,
        retainedMemberDisposers,
        cachedRuleEntries,
        baselineEntries,
        runtimeEntries: runtimes.size,
        activeRuntimeEntries,
        reconcileTimers: reconcileTimer === null ? 0 : 1,
        reservationPending: reservation !== null && reservation.active,
        activationPending,
        runtimes: [...runtimes.values()].map((runtime) => ({
          query: copyQuery(runtime.query),
          active: runtime.active,
          feed: getFeedSessionResourceSnapshot(runtime.feed),
        })),
      };
    },
  });
  return monitor;
}
