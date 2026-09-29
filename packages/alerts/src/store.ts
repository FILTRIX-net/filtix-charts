import {
  alertEventId,
  alertIdentity,
  copyPriceAlert,
  copyPriceAlertDocument,
  copyPriceAlertEvent,
  createEmptyPriceAlertDocument,
  decodePriceAlertDocument,
  normalizePriceAlertEvent,
  normalizePriceAlertInput,
  normalizePriceAlertPatch,
} from './codec';
import { crossed } from './evaluator';
import type {
  PriceAlert,
  PriceAlertDocument,
  PriceAlertEvent,
  PriceAlertInput,
  PriceAlertStore,
} from './types';

export type ReadonlyAlert = Readonly<Omit<PriceAlert, 'query' | 'lastTrigger'>> & {
  readonly query: Readonly<PriceAlert['query']>;
  readonly lastTrigger:
    | (Readonly<Omit<PriceAlertEvent, 'query'>> & {
        readonly query: Readonly<PriceAlertEvent['query']>;
      })
    | null;
};

export interface ReadonlyStoreSnapshot {
  readonly scopeId: string;
  readonly providerId: string;
  readonly alerts: readonly ReadonlyAlert[];
}

export type StoreLifecycleChange = { type: 'destroy' } | { type: 'rearm'; alertId: string };

export interface StoreCapability {
  readonly revision: number;
  getResourceSnapshot(): import('./resources').PriceAlertStoreResourceSnapshot;
  registerAdmission(listener: (next: ReadonlyStoreSnapshot) => void): () => void;
  subscribeLifecycle(listener: (change: StoreLifecycleChange) => void): () => void;
  commitTrigger(alertId: string, event: PriceAlertEvent): boolean;
}

export interface PreparedPriceAlertStoreRestore {
  commit(host: { assertCurrent(): void; adopt(): void }): void;
  activate(): void;
  abort(): void;
}

const capabilities = new WeakMap<PriceAlertStore, StoreCapability>();
const restorePreparers = new WeakMap<PriceAlertStore, (value: unknown) => PreparedPriceAlertStoreRestore>();

function fail(message: string): never {
  throw new TypeError(`INVALID_PRICE_ALERT: ${message}`);
}

function sameDocument(left: PriceAlertDocument, right: PriceAlertDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function frozenSnapshot(document: PriceAlertDocument): ReadonlyStoreSnapshot {
  const alerts = document.alerts.map((alert) => {
    const copy = copyPriceAlert(alert);
    Object.freeze(copy.query);
    if (copy.lastTrigger) {
      Object.freeze(copy.lastTrigger.query);
      Object.freeze(copy.lastTrigger);
    }
    return Object.freeze(copy);
  });
  return Object.freeze({
    scopeId: document.scopeId,
    providerId: document.providerId,
    alerts: Object.freeze(alerts),
  });
}

export function getStoreCapability(store: PriceAlertStore): StoreCapability {
  const capability = capabilities.get(store);
  if (!capability) fail('Store was not created by createPriceAlertStore');
  return capability;
}

/** @internal Same store registry and runtime as the public alerts entry. */
export function preparePriceAlertStoreRestore(
  store: PriceAlertStore,
  value: unknown,
): PreparedPriceAlertStoreRestore {
  const prepare = restorePreparers.get(store);
  if (!prepare) fail('Store was not created by createPriceAlertStore');
  return prepare(value);
}

export function createPriceAlertStore(context: { providerId: string; scopeId: string }): PriceAlertStore {
  let document = createEmptyPriceAlertDocument(context);
  let revision = 0;
  let destroyed = false;
  const changes = new Set<() => void>();
  const events = new Set<(event: PriceAlertEvent) => void>();
  const admissions = new Set<(next: ReadonlyStoreSnapshot) => void>();
  const lifecycle = new Set<(change: StoreLifecycleChange) => void>();

  const requireAlive = (): void => {
    if (destroyed) fail('Store is destroyed');
  };
  const requireRevision = (expected: number): void => {
    requireAlive();
    if (revision !== expected) fail('Store changed during validation or admission');
  };
  const notifyChanges = (expected: number): void => {
    for (const listener of [...changes]) {
      if (destroyed || revision !== expected) return;
      try {
        listener();
      } catch {
        /* One observer cannot prevent another. */
      }
    }
  };
  const notifyEvents = (event: PriceAlertEvent): void => {
    for (const listener of [...events]) {
      if (destroyed) return;
      try {
        listener(copyPriceAlertEvent(event));
      } catch {
        /* Isolate observers. */
      }
    }
  };
  const notifyLifecycle = (change: StoreLifecycleChange, expected: number): void => {
    for (const listener of [...lifecycle]) {
      if (destroyed || revision !== expected) return;
      try {
        listener({ ...change });
      } catch {
        /* Isolate monitors. */
      }
    }
  };
  const admit = (next: PriceAlertDocument, expected: number): void => {
    const proposed = frozenSnapshot(next);
    for (const listener of [...admissions]) {
      requireRevision(expected);
      listener(proposed);
      requireRevision(expected);
    }
  };
  const commit = (next: PriceAlertDocument, expected: number, force = false): boolean => {
    requireRevision(expected);
    if (!force && sameDocument(document, next)) return false;
    admit(next, expected);
    requireRevision(expected);
    document = copyPriceAlertDocument(next);
    revision++;
    return true;
  };
  const findRule = (id: string): { index: number; rule: PriceAlert } => {
    const index = document.alerts.findIndex((rule) => rule.id === id);
    if (index < 0) fail(`Unknown alert: ${id}`);
    return { index, rule: document.alerts[index]! };
  };
  const replace = (index: number, rule: PriceAlert): PriceAlertDocument => ({
    ...document,
    alerts: document.alerts.map((item, at) => (at === index ? rule : item)),
  });

  const prepareRestore = (value: unknown): PreparedPriceAlertStoreRestore => {
    requireAlive();
    const expected = revision;
    const next = decodePriceAlertDocument(value, {
      providerId: document.providerId,
      scopeId: document.scopeId,
    });
    requireRevision(expected);
    const prepared = copyPriceAlertDocument(next);
    const changed = !sameDocument(document, prepared);
    admit(prepared, expected);
    requireRevision(expected);
    let active = true;
    let committed = false;
    let activated = false;
    let committedRevision = expected;
    return {
      commit(host) {
        if (!active || committed) fail('Prepared restore is stale');
        if (!host || typeof host.assertCurrent !== 'function' || typeof host.adopt !== 'function')
          fail('Prepared restore host is invalid');
        requireRevision(expected);
        admit(prepared, expected);
        requireRevision(expected);
        host.assertCurrent();
        requireRevision(expected);
        // Trusted host.adopt contains only staged nonthrowing assignments.
        if (changed) {
          document = prepared;
          revision++;
        }
        committedRevision = revision;
        committed = true;
        active = false;
        host.adopt();
      },
      activate() {
        if (!committed || activated) return;
        activated = true;
        if (changed) notifyChanges(committedRevision);
      },
      abort() {
        if (!committed) active = false;
      },
    };
  };

  const store: PriceAlertStore = {
    add(input) {
      requireAlive();
      const expected = revision;
      const normalized = normalizePriceAlertInput(input);
      requireRevision(expected);
      if (document.alerts.length >= 100) fail('Store capacity is 100 alerts');
      if (document.nextRuleId >= Number.MAX_SAFE_INTEGER) fail('Rule ID counter is exhausted');
      const id = `${document.scopeId}:${document.nextRuleId}`;
      const rule: PriceAlert = { ...normalized, id, status: 'armed', triggerCount: 0, lastTrigger: null };
      const next: PriceAlertDocument = {
        ...document,
        nextRuleId: document.nextRuleId + 1,
        alerts: [...document.alerts, rule],
      };
      commit(next, expected);
      notifyChanges(revision);
      return id;
    },
    update(id, patch) {
      requireAlive();
      const expected = revision;
      const normalized = normalizePriceAlertPatch(patch);
      requireRevision(expected);
      const { index, rule } = findRule(id);
      const nextRule: PriceAlert = { ...copyPriceAlert(rule), ...normalized };
      if (commit(replace(index, nextRule), expected)) notifyChanges(revision);
    },
    remove(id) {
      requireAlive();
      const expected = revision;
      const index = document.alerts.findIndex((rule) => rule.id === id);
      if (index < 0) return false;
      const next = { ...document, alerts: document.alerts.filter((_, at) => at !== index) };
      commit(next, expected);
      notifyChanges(revision);
      return true;
    },
    pause(id) {
      requireAlive();
      const expected = revision;
      const { index, rule } = findRule(id);
      if (rule.status === 'paused') return;
      commit(replace(index, { ...copyPriceAlert(rule), status: 'paused' }), expected);
      notifyChanges(revision);
    },
    rearm(id) {
      requireAlive();
      const expected = revision;
      const { index, rule } = findRule(id);
      commit(replace(index, { ...copyPriceAlert(rule), status: 'armed' }), expected, true);
      const committed = revision;
      notifyLifecycle({ type: 'rearm', alertId: id }, committed);
      notifyChanges(committed);
    },
    list() {
      return document.alerts.map(copyPriceAlert);
    },
    subscribe(listener) {
      requireAlive();
      if (typeof listener !== 'function') fail('Change listener must be a function');
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    subscribeEvents(listener) {
      requireAlive();
      if (typeof listener !== 'function') fail('Event listener must be a function');
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    toJSON() {
      return copyPriceAlertDocument(document);
    },
    restore(value) {
      requireAlive();
      const expected = revision;
      const next = decodePriceAlertDocument(value, {
        providerId: document.providerId,
        scopeId: document.scopeId,
      });
      requireRevision(expected);
      if (commit(next, expected)) notifyChanges(revision);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      revision++;
      changes.clear();
      events.clear();
      admissions.clear();
      const captured = [...lifecycle];
      lifecycle.clear();
      for (const listener of captured) {
        try {
          listener({ type: 'destroy' });
        } catch {
          /* Isolate monitor cleanup. */
        }
      }
    },
  };

  const capability: StoreCapability = {
    get revision() {
      return revision;
    },
    getResourceSnapshot() {
      return {
        destroyed,
        changeListeners: changes.size,
        eventListeners: events.size,
        admissionListeners: admissions.size,
        lifecycleListeners: lifecycle.size,
      };
    },
    registerAdmission(listener) {
      requireAlive();
      if (typeof listener !== 'function') fail('Admission listener must be a function');
      admissions.add(listener);
      return () => {
        admissions.delete(listener);
      };
    },
    subscribeLifecycle(listener) {
      requireAlive();
      if (typeof listener !== 'function') fail('Lifecycle listener must be a function');
      lifecycle.add(listener);
      return () => {
        lifecycle.delete(listener);
      };
    },
    commitTrigger(alertId, candidate) {
      if (destroyed) return false;
      const expected = revision;
      let event: PriceAlertEvent;
      try {
        event = normalizePriceAlertEvent(candidate, document.scopeId, document.providerId, alertId);
      } catch {
        return false;
      }
      if (destroyed || revision !== expected) return false;
      const index = document.alerts.findIndex((item) => item.id === alertId);
      if (index < 0) return false;
      const rule = document.alerts[index]!;
      if (rule.status !== 'armed' || rule.triggerCount >= Number.MAX_SAFE_INTEGER) {
        if (rule.triggerCount >= Number.MAX_SAFE_INTEGER) fail('Trigger count is exhausted');
        return false;
      }
      if (
        event.occurrence !== rule.triggerCount + 1 ||
        event.id !== alertEventId(document.scopeId, alertId, event.occurrence) ||
        event.query.symbol !== rule.query.symbol ||
        event.query.interval !== rule.query.interval ||
        event.condition !== rule.condition ||
        event.threshold !== rule.price ||
        !crossed(event.previousPrice, event.price, rule.price, rule.condition)
      )
        return false;
      const nextRule: PriceAlert = {
        ...copyPriceAlert(rule),
        status: rule.frequency === 'once' ? 'triggered' : 'armed',
        triggerCount: event.occurrence,
        lastTrigger: copyPriceAlertEvent(event),
      };
      if (!commit(replace(index, nextRule), expected)) return false;
      const committed = revision;
      notifyChanges(committed);
      if (!destroyed) notifyEvents(event);
      return true;
    },
  };
  capabilities.set(store, capability);
  restorePreparers.set(store, prepareRestore);
  return store;
}
