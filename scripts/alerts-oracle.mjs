import assert from 'node:assert/strict';

export const ALERTS_BUDGETS = Object.freeze({
  syncP95Ms: 16,
  syncP99Ms: 32,
  settledP95Ms: 50,
  settledP99Ms: 100,
  activationMs: 2000,
  retainedHeapBytes: 12 * 1024 * 1024,
});
export const ALERTS_DECLARED = Object.freeze({
  queries: 32,
  rules: 400,
  stores: 4,
  warmupBatches: 32,
  maxBatches: 3125,
  updatesPerBatch: 32,
  maxTargetIntervalMs: 10,
  soakTargetIntervalMs: 40,
  soakMinimumMs: 120_000,
  ruleCycles: 25,
  mounts: 6,
});
const packages = [
  'analysis',
  'alerts',
  'charts',
  'core',
  'datafeed',
  'drawings',
  'indicators',
  'react',
  'terminal',
];
const hex64 = /^[a-f0-9]{64}$/;
const hex40 = /^[a-f0-9]{40}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const key = (query) => JSON.stringify([query.symbol, query.interval]);
const fail = (message) => {
  throw new Error(`INVALID_ALERTS_EVIDENCE: ${message}`);
};
const requireEvidence = (condition, message) => {
  if (!condition) fail(message);
};

export function expectedArchiveMembers(name) {
  const members = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.js.map',
    'package/dist/index.d.ts',
  ];
  if (name === 'alerts' || name === 'indicators')
    members.push('package/dist/internal.js', 'package/dist/internal.js.map', 'package/dist/internal.d.ts');
  return members.sort();
}

export function buildAlertsFixture() {
  const providerId = 'filtix-alerts-workload-v1';
  const queries = Array.from({ length: 32 }, (_, index) => ({
    symbol: `ALERT${String(index).padStart(2, '0')}`,
    interval: '1m',
  }));
  const stores = Array.from({ length: 4 }, (_, storeIndex) => {
    const scopeId = `alerts-workload-${storeIndex}`;
    const alerts = Array.from({ length: 100 }, (_, index) => {
      const query = queries[index % 32];
      const crossing = index % 32 === 0 && (storeIndex === 0 ? index <= 96 : index <= 64);
      return {
        id: `${scopeId}:${index + 1}`,
        query: { ...query },
        price: crossing ? 100 : 1000 + storeIndex * 100 + index,
        condition: 'crosses-up',
        frequency: storeIndex === 0 && index === 32 ? 'once' : 'repeat',
        status: storeIndex === 0 && index === 1 ? 'paused' : 'armed',
        triggerCount: 0,
        lastTrigger: null,
      };
    });
    return { schema: 'filtix-price-alerts', version: 1, providerId, scopeId, nextRuleId: 101, alerts };
  });
  return { providerId, queries, stores, initialClose: 99, firstTime: Date.UTC(2026, 0, 1) };
}

export function buildMaxDelivery(fixture, phase, batch) {
  const offset = phase < 0 ? batch : 32 + phase * 3125 + batch;
  return {
    phase,
    batch,
    updates: fixture.queries.map((query, index) => ({
      query: { ...query },
      time: fixture.firstTime + offset * 60_000,
      close: phase >= 0 && index === 0 && batch % 500 === 0 ? 101 : 99,
      revision: 1,
    })),
  };
}

export function buildSoakDelivery(fixture, batch) {
  const delivery = buildMaxDelivery(fixture, 3, batch);
  for (const update of delivery.updates) update.close = fixture.initialClose;
  return { ...delivery, phase: 'soak' };
}

export function referenceEvents(fixture, phases) {
  const rules = fixture.stores.flatMap((store) =>
    store.alerts.map((rule) => ({
      scopeId: store.scopeId,
      providerId: store.providerId,
      id: rule.id,
      query: rule.query,
      price: rule.price,
      condition: rule.condition,
      frequency: rule.frequency,
      status: rule.status,
      occurrence: rule.triggerCount,
      previous: fixture.initialClose,
    })),
  );
  const byQuery = new Map(fixture.queries.map((query) => [key(query), []]));
  for (const rule of rules) byQuery.get(key(rule.query))?.push(rule);
  const events = [];
  for (const phase of phases)
    for (const delivery of phase.deliveries) {
      for (const [queryIndex, update] of delivery.updates.entries()) {
        for (const rule of byQuery.get(key(update.query)) ?? []) {
          if (rule.status !== 'armed') continue;
          const previous = rule.previous;
          rule.previous = update.close;
          const above = previous < rule.price && update.close >= rule.price;
          const below = previous > rule.price && update.close <= rule.price;
          if (
            !(rule.condition === 'crosses-up'
              ? above
              : rule.condition === 'crosses-down'
                ? below
                : above || below)
          )
            continue;
          const occurrence = ++rule.occurrence;
          events.push({
            phase: phase.phase,
            batch: delivery.batch,
            queryIndex,
            id: JSON.stringify([rule.scopeId, rule.id, occurrence]),
            scopeId: rule.scopeId,
            alertId: rule.id,
            providerId: rule.providerId,
            query: { ...rule.query },
            condition: rule.condition,
            threshold: rule.price,
            previousPrice: previous,
            price: update.close,
            barTime: update.time,
            occurrence,
          });
          if (rule.frequency === 'once') rule.status = 'triggered';
        }
      }
    }
  return events;
}

export function nearestRank(values, fraction) {
  requireEvidence(
    Array.isArray(values) && values.length > 0 && values.every(nonnegative),
    'timing samples must be finite',
  );
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}

function validateIdentity(record) {
  requireEvidence(hex40.test(record.source?.commit), 'source commit identity is missing');
  requireEvidence(
    Array.isArray(record.source.dirty) && record.source.dirty.length === 0,
    'source must be clean',
  );
  requireEvidence(
    Array.isArray(record.source.files) && record.source.files.length > 0,
    'source file identities missing',
  );
  const paths = new Set();
  for (const item of record.source.files) {
    requireEvidence(
      typeof item.path === 'string' &&
        item.path.length > 0 &&
        hex64.test(item.sha256) &&
        !paths.has(item.path),
      'source file identity invalid',
    );
    paths.add(item.path);
  }
  requireEvidence(record.installation?.version === '0.10.0', 'installed cohort version must be 0.10.0');
  requireEvidence(
    Array.isArray(record.installation.archives) && record.installation.archives.length === 9,
    'nine archive cohort required',
  );
  const names = new Set();
  let total = 0;
  for (const archive of record.installation.archives) {
    const name = archive.name?.split('/')[1];
    requireEvidence(
      packages.includes(name) && archive.name === `@filtix/${name}` && !names.has(name),
      'archive cohort identity invalid',
    );
    names.add(name);
    requireEvidence(hex64.test(archive.sha256), 'archive SHA256 identity invalid');
    const expected = expectedArchiveMembers(name);
    requireEvidence(
      Array.isArray(archive.members) && archive.members.length === expected.length,
      'archive member count invalid',
    );
    requireEvidence(
      archive.members.every((member, index) => member.path === expected[index] && hex64.test(member.sha256)),
      'archive member identity invalid',
    );
    total += archive.members.length;
  }
  requireEvidence(total === 42 && record.installation.memberCount === 42, '42 archive members required');
}

function validateFixture(fixture) {
  requireEvidence(
    typeof fixture?.providerId === 'string' && fixture.providerId.length > 0,
    'fixture provider identity missing',
  );
  requireEvidence(
    Array.isArray(fixture.queries) && fixture.queries.length === 32,
    'fixture needs 32 queries',
  );
  const queryKeys = new Set(fixture.queries.map(key));
  requireEvidence(
    queryKeys.size === 32 &&
      fixture.queries.every((query) => typeof query.symbol === 'string' && query.interval === '1m'),
    'fixture exact query catalog invalid',
  );
  requireEvidence(Array.isArray(fixture.stores) && fixture.stores.length === 4, 'fixture needs four stores');
  let count = 0;
  let paused = 0;
  let once = 0;
  const scopes = new Set();
  for (const store of fixture.stores) {
    requireEvidence(
      store.schema === 'filtix-price-alerts' &&
        store.version === 1 &&
        store.providerId === fixture.providerId,
      'fixture store document invalid',
    );
    requireEvidence(
      typeof store.scopeId === 'string' && !scopes.has(store.scopeId),
      'fixture store scope invalid',
    );
    scopes.add(store.scopeId);
    requireEvidence(
      Array.isArray(store.alerts) && store.alerts.length === 100 && store.nextRuleId === 101,
      'fixture needs 100 rules per store',
    );
    for (const [index, rule] of store.alerts.entries()) {
      requireEvidence(
        rule.id === `${store.scopeId}:${index + 1}` && queryKeys.has(key(rule.query)) && finite(rule.price),
        'fixture rule identity/query/threshold invalid',
      );
      requireEvidence(
        ['armed', 'paused', 'triggered'].includes(rule.status) && ['once', 'repeat'].includes(rule.frequency),
        'fixture rule status/frequency invalid',
      );
      if (rule.status === 'paused') paused++;
      if (rule.frequency === 'once') once++;
      count++;
    }
  }
  requireEvidence(
    count === 400 && paused > 0 && once > 0,
    'fixture needs 400 rules with paused and once coverage',
  );
  requireEvidence(
    fixture.initialClose === 99 && Number.isSafeInteger(fixture.firstTime),
    'fixture baseline invalid',
  );
}

function validateDelivery(delivery, fixture, phase, batch) {
  requireEvidence(
    delivery?.phase === phase && delivery.batch === batch,
    'delivery phase/batch sequence invalid',
  );
  requireEvidence(
    nonnegative(delivery.intendedAt) && nonnegative(delivery.actualAt) && nonnegative(delivery.browserAt),
    'intended/actual/browser cadence timestamp missing',
  );
  requireEvidence(
    nonnegative(delivery.syncMs) && nonnegative(delivery.settledMs),
    'raw timing sample missing or nonfinite',
  );
  requireEvidence(
    delivery.preparedBars === 32 && delivery.evidenceMaterializedAfterTiming === true,
    'dispatch boundary must prepare 32 bars and materialize evidence after timing',
  );
  requireEvidence(
    Array.isArray(delivery.updates) && delivery.updates.length === 32,
    'delivery must contain 32 raw accepted updates',
  );
  const expected = (
    phase === 'soak' ? buildSoakDelivery(fixture, batch) : buildMaxDelivery(fixture, phase, batch)
  ).updates;
  for (let index = 0; index < 32; index++) {
    const item = delivery.updates[index];
    const truth = expected[index];
    requireEvidence(
      item?.query?.symbol === truth.query.symbol &&
        item.query.interval === truth.query.interval &&
        item.time === truth.time &&
        item.close === truth.close &&
        item.revision === truth.revision,
      'raw update/query/close sequence differs from fixture',
    );
  }
}

function validateEvents(phases, fixture) {
  const truth = referenceEvents(fixture, phases);
  requireEvidence(truth.length >= 100, 'at least 100 independent oracle crossings required');
  for (const phase of phases) {
    const expected = truth.filter((event) => event.phase === phase.phase);
    const terminalExpected = expected.filter((event) => event.scopeId === fixture.stores[0].scopeId);
    requireEvidence(
      Array.isArray(phase.expectedEvents) && phase.expectedEvents.length === expected.length,
      'expected oracle event count invalid',
    );
    requireEvidence(
      Array.isArray(phase.observedEvents) && phase.observedEvents.length === expected.length,
      'observed oracle event count invalid',
    );
    requireEvidence(
      Array.isArray(phase.terminalObservedEvents) &&
        phase.terminalObservedEvents.length === terminalExpected.length,
      'terminal callback event count invalid',
    );
    for (let index = 0; index < expected.length; index++) {
      const truthEvent = expected[index];
      const recorded = phase.expectedEvents[index];
      const observed = phase.observedEvents[index];
      for (const event of [recorded, observed]) {
        requireEvidence(
          event?.id === truthEvent.id && event.occurrence === truthEvent.occurrence,
          'event ID/occurrence differs from independent oracle',
        );
        for (const field of [
          'phase',
          'batch',
          'queryIndex',
          'scopeId',
          'alertId',
          'providerId',
          'condition',
          'threshold',
          'previousPrice',
          'price',
          'barTime',
        ])
          requireEvidence(
            event[field] === truthEvent[field],
            `event ${field} differs from independent oracle`,
          );
        requireEvidence(
          key(event.query) === key(truthEvent.query),
          'event query differs from independent oracle',
        );
      }
      requireEvidence(nonnegative(observed.observedAt), 'observed callback timestamp missing');
      requireEvidence(nonnegative(observed.callbackAt), 'store callback observation timestamp missing');
    }
    for (const [index, event] of phase.terminalObservedEvents.entries()) {
      const truthEvent = terminalExpected[index];
      const delivered = phase.deliveries[truthEvent.batch];
      requireEvidence(
        event?.id === truthEvent.id &&
          event.occurrence === truthEvent.occurrence &&
          event.phase === truthEvent.phase &&
          event.batch === truthEvent.batch &&
          event.queryIndex === truthEvent.queryIndex &&
          nonnegative(event.callbackAt) &&
          event.browserAt === delivered.browserAt &&
          nonnegative(event.callbackLatencyMs) &&
          event.callbackLatencyMs === event.callbackAt - event.browserAt,
        'terminal callback identity/latency differs from independent oracle',
      );
    }
  }
  return truth.length;
}

function validateSubscriptionsAndDocuments(phase, fixture) {
  requireEvidence(
    Array.isArray(phase.subscriptions) && phase.subscriptions.length === 32,
    '32 query subscriptions required',
  );
  const keys = new Set();
  for (const entry of phase.subscriptions) {
    const exact = key(entry.query);
    requireEvidence(
      fixture.queries.some((query) => key(query) === exact) && !keys.has(exact) && entry.active === 1,
      'duplicate/missing query subscription',
    );
    requireEvidence(
      entry.delivered === 32 + (phase.phase + 1) * 3125,
      'per-query accepted delivery count invalid',
    );
    keys.add(exact);
  }
  requireEvidence(
    Array.isArray(phase.documents) && phase.documents.length === 4,
    'phase rule/document snapshot missing',
  );
  for (let index = 0; index < 4; index++) {
    const document = phase.documents[index];
    requireEvidence(
      document?.scopeId === fixture.stores[index].scopeId &&
        document.providerId === fixture.providerId &&
        Array.isArray(document.alerts) &&
        document.alerts.length === 100,
      'phase document identity/rule count invalid',
    );
  }
  const paused = phase.documents[0].alerts[1];
  const once = phase.documents[0].alerts[32];
  requireEvidence(
    paused.status === 'paused' && paused.triggerCount === 0 && paused.lastTrigger === null,
    'paused rule must remain untriggered',
  );
  requireEvidence(
    once.status === 'triggered' &&
      once.triggerCount === 1 &&
      once.lastTrigger?.id === JSON.stringify([fixture.stores[0].scopeId, once.id, 1]),
    'once rule must trigger exactly once',
  );
}

function validateTimings(record, deliveries) {
  const expectedSync = deliveries.map((delivery) => delivery.syncMs);
  const expectedSettled = deliveries.map((delivery) => delivery.settledMs);
  const expectedCallbacks = record.maxPhases.flatMap((phase) =>
    phase.terminalObservedEvents.map((event) => event.callbackAt - phase.deliveries[event.batch].browserAt),
  );
  const summary = record.timings;
  requireEvidence(
    nonnegative(summary?.activationMs) && summary.activationMs <= ALERTS_BUDGETS.activationMs,
    'initial activation budget exceeded',
  );
  for (const [name, expected, p95Limit, p99Limit] of [
    ['sync', expectedSync, ALERTS_BUDGETS.syncP95Ms, ALERTS_BUDGETS.syncP99Ms],
    ['settled', expectedSettled, ALERTS_BUDGETS.settledP95Ms, ALERTS_BUDGETS.settledP99Ms],
    ['terminalCallbacks', expectedCallbacks, ALERTS_BUDGETS.settledP95Ms, ALERTS_BUDGETS.settledP99Ms],
  ]) {
    const group = summary[name];
    requireEvidence(
      Array.isArray(group?.samples) &&
        group.samples.length === expected.length &&
        group.samples.every((value, index) => value === expected[index]),
      `${name} raw timing samples missing`,
    );
    requireEvidence(
      nonnegative(group.p95) &&
        nonnegative(group.p99) &&
        group.p95 === nearestRank(expected, 0.95) &&
        group.p99 === nearestRank(expected, 0.99),
      `${name} p95/p99 timing summary invalid`,
    );
    requireEvidence(group.p95 <= p95Limit && group.p99 <= p99Limit, `${name} p95/p99 budget exceeded`);
  }
}

const storeFields = ['changeListeners', 'eventListeners', 'admissionListeners', 'lifecycleListeners'];
const monitorFields = [
  'members',
  'leaseEntries',
  'observerListeners',
  'retainedMemberDisposers',
  'cachedRuleEntries',
  'baselineEntries',
  'runtimeEntries',
  'activeRuntimeEntries',
  'reconcileTimers',
];
function validateSnapshot(snapshot, final) {
  requireEvidence(
    Array.isArray(snapshot?.stores) &&
      snapshot.stores.length === 4 &&
      Array.isArray(snapshot.monitors) &&
      snapshot.monitors.length === 1,
    'per-object private resource snapshots missing',
  );
  requireEvidence(
    Number.isSafeInteger(snapshot.appTimers) &&
      snapshot.appTimers >= 0 &&
      Number.isSafeInteger(snapshot.providerSubscriptions) &&
      snapshot.providerSubscriptions >= 0,
    'app timer/provider resource sample missing',
  );
  requireEvidence(
    new Set(snapshot.stores.map((item) => item.id)).size === 4,
    'distinct store resource identities required',
  );
  for (const item of snapshot.stores) {
    requireEvidence(
      typeof item.id === 'string' && typeof item.snapshot?.destroyed === 'boolean',
      'store resource identity/snapshot missing',
    );
    for (const field of storeFields)
      requireEvidence(
        Number.isSafeInteger(item.snapshot[field]) &&
          item.snapshot[field] >= 0 &&
          (!final || item.snapshot[field] === 0),
        `store ${field} resource count invalid`,
      );
    if (final) requireEvidence(item.snapshot.destroyed, 'owned store must be destroyed');
  }
  for (const item of snapshot.monitors) {
    requireEvidence(
      typeof item.id === 'string' && typeof item.snapshot?.destroyed === 'boolean',
      'monitor resource identity/snapshot missing',
    );
    for (const field of monitorFields)
      requireEvidence(
        Number.isSafeInteger(item.snapshot[field]) &&
          item.snapshot[field] >= 0 &&
          (!final || item.snapshot[field] === 0),
        `monitor ${field} resource count invalid`,
      );
    requireEvidence(
      typeof item.snapshot.reservationPending === 'boolean' &&
        typeof item.snapshot.activationPending === 'boolean',
      'monitor pending resource state missing',
    );
    if (final)
      requireEvidence(
        item.snapshot.destroyed && !item.snapshot.reservationPending && !item.snapshot.activationPending,
        'owned monitor must be destroyed and idle',
      );
  }
  if (final)
    requireEvidence(
      snapshot.appTimers === 0 && snapshot.providerSubscriptions === 0,
      'final app timers/provider subscriptions must be zero',
    );
}

function validGcRounds(rounds) {
  return (
    Array.isArray(rounds) &&
    rounds.length === 3 &&
    rounds.every((entry, index) => entry?.turn === index + 1 && entry.observed === index + 1)
  );
}

function validateLiveRawEndpoint(sample, name) {
  requireEvidence(
    Number.isSafeInteger(sample?.heap?.usedSize) &&
      sample.heap.usedSize >= 0 &&
      Number.isSafeInteger(sample.counters?.jsEventListeners) &&
      sample.counters.jsEventListeners >= 0,
    `${name} raw heap/listener resource sample missing`,
  );
  for (const scope of ['consumer', 'terminal']) {
    const owned = sample.owned?.[scope];
    requireEvidence(
      ['total', 'connectedOutside', 'detached'].every(
        (field) => Number.isSafeInteger(owned?.[field]) && owned[field] >= 0,
      ),
      `${name} raw ${scope} owned resource sample missing`,
    );
  }
  const terminal = sample.owned.terminal;
  requireEvidence(
    Array.isArray(terminal.generations) &&
      terminal.generations.length > 0 &&
      terminal.generations.every(
        (item) =>
          typeof item.rootConnected === 'boolean' && Number.isSafeInteger(item.total) && item.total >= 0,
      ) &&
      terminal.generations.reduce((sum, item) => sum + item.total, 0) === terminal.total,
    `${name} raw terminal generations missing or inconsistent`,
  );
}

function validateResources(record) {
  const resources = record.resources;
  requireEvidence(
    resources?.gcTurns === 3 && validGcRounds(resources.gcRounds),
    'fixed three GC turns required',
  );
  const initialObsolete = resources.initialObsolete;
  requireEvidence(
    (initialObsolete?.available === false && Object.keys(initialObsolete).length === 1) ||
      (initialObsolete?.available === true &&
        initialObsolete.newEvents === 0 &&
        initialObsolete.documentsUnchanged === true &&
        initialObsolete.monitorUnchanged === true &&
        initialObsolete.subscriptionsUnchanged === true),
    'initial obsolete callback release witness missing or caused a stale effect',
  );
  for (const [name, sample] of [
    ['initial', resources.initial],
    ['final', resources.final],
  ]) {
    requireEvidence(
      validGcRounds(sample?.gcRounds),
      `${name} equivalent resource endpoint requires three observed GC turns`,
    );
    validateLiveRawEndpoint(sample, name);
  }
  requireEvidence(
    JSON.stringify(resources.gcRounds) === JSON.stringify(resources.final.gcRounds),
    'reported GC turns differ from final raw observations',
  );
  const initial = resources.initial;
  const final = resources.final;
  const derived = {
    growth: final.owned.consumer.total - initial.owned.consumer.total,
    terminalGrowth: final.owned.terminal.total - initial.owned.terminal.total,
    listenerGrowth: final.counters.jsEventListeners - initial.counters.jsEventListeners,
    retainedHeapDelta: final.heap.usedSize - initial.heap.usedSize,
    outside: Math.max(
      initial.owned.consumer.connectedOutside,
      final.owned.consumer.connectedOutside,
      initial.owned.terminal.connectedOutside,
      final.owned.terminal.connectedOutside,
    ),
    detached: Math.max(
      initial.owned.consumer.detached,
      final.owned.consumer.detached,
      initial.owned.terminal.detached,
      final.owned.terminal.detached,
    ),
    disposed: final.owned.terminal.generations
      .filter((item) => !item.rootConnected)
      .reduce((sum, item) => sum + item.total, 0),
  };
  for (const [field, value] of Object.entries(derived))
    requireEvidence(resources[field] === value, `${field} resource summary differs from raw samples`);
  requireEvidence(
    derived.retainedHeapDelta <= ALERTS_BUDGETS.retainedHeapBytes,
    'retained heap budget exceeded',
  );
  for (const field of ['growth', 'terminalGrowth', 'listenerGrowth'])
    requireEvidence(derived[field] <= 0, `${field} resource growth exceeded`);
  requireEvidence(
    derived.outside === 0 && derived.detached === 0 && derived.disposed === 0,
    'outside/detached/disposed resources remain',
  );
  validateSnapshot(resources.initial, false);
  validateSnapshot(resources.final, false);
  validateSnapshot(resources.afterDestroy, true);
  const staticBaseline = resources.staticBaseline;
  const postDestroy = resources.postDestroy;
  for (const [name, sample] of [
    ['static baseline', staticBaseline],
    ['post-destroy', postDestroy],
  ]) {
    requireEvidence(validGcRounds(sample?.gcRounds), `${name} requires fixed three observed GC turns`);
    requireEvidence(
      Number.isSafeInteger(sample.counters?.jsEventListeners) &&
        sample.counters.jsEventListeners >= 0 &&
        Number.isSafeInteger(sample.owned?.consumer?.total) &&
        Number.isSafeInteger(sample.owned?.terminal?.total),
      `${name} DOM/listener resource sample missing`,
    );
  }
  requireEvidence(
    staticBaseline.owned.terminal.total === 0,
    'static baseline must have no owned terminal nodes',
  );
  requireEvidence(
    postDestroy.owned.terminal.total === 0 &&
      postDestroy.owned.terminal.detached === 0 &&
      postDestroy.owned.terminal.connectedOutside === 0 &&
      postDestroy.owned.consumer.total <= staticBaseline.owned.consumer.total &&
      postDestroy.owned.consumer.detached === 0 &&
      postDestroy.owned.consumer.connectedOutside === 0 &&
      postDestroy.counters.jsEventListeners <= staticBaseline.counters.jsEventListeners &&
      postDestroy.providerSubscriptions === 0 &&
      postDestroy.appTimers === 0,
    'post-destroy owned DOM/listener/provider/timer resources remain',
  );
  const initialIds = resources.initial.stores.map((item) => item.id).sort();
  requireEvidence(
    JSON.stringify(initialIds) === JSON.stringify(resources.final.stores.map((item) => item.id).sort()),
    'equivalent endpoint store identities required',
  );
  requireEvidence(
    resources.initial.monitors[0].id === resources.final.monitors[0].id,
    'equivalent endpoint monitor identity required',
  );
  for (const [before, after] of [[resources.initial, resources.final]]) {
    for (const field of ['appTimers', 'providerSubscriptions'])
      requireEvidence(after[field] <= before[field], `${field} resource growth exceeded`);
    for (let index = 0; index < 4; index++)
      for (const field of storeFields)
        requireEvidence(
          after.stores[index].snapshot[field] <= before.stores[index].snapshot[field],
          `store ${field} growth exceeded`,
        );
    for (const field of monitorFields)
      requireEvidence(
        after.monitors[0].snapshot[field] <= before.monitors[0].snapshot[field],
        `monitor ${field} growth exceeded`,
      );
  }
}

export function validateAlertsEvidence(record) {
  requireEvidence(
    record?.schema === 'filtix-alerts-installed-evidence' &&
      record.version === 1 &&
      record.mode === 'all' &&
      record.status === 'pass',
    'complete all-mode alerts evidence required',
  );
  requireEvidence(
    Array.isArray(record.errors) && record.errors.length === 0,
    'evidence errors must be empty',
  );
  validateIdentity(record);
  for (const [field, value] of Object.entries(ALERTS_DECLARED))
    requireEvidence(record.declared?.[field] === value, `fixed declared ${field} workload differs`);
  validateFixture(record.fixture);
  requireEvidence(
    record.warmup?.status === 'accepted' &&
      Array.isArray(record.warmup.deliveries) &&
      record.warmup.deliveries.length === 32,
    '32 warmup batches required',
  );
  for (const [index, delivery] of record.warmup.deliveries.entries())
    validateDelivery(delivery, record.fixture, -1, index);
  requireEvidence(
    Array.isArray(record.maxPhases) && record.maxPhases.length === 3,
    'exactly three measured max phases required',
  );
  const deliveries = [];
  for (const [phaseIndex, phase] of record.maxPhases.entries()) {
    requireEvidence(
      phase?.phase === phaseIndex && phase.status === 'accepted' && phase.targetIntervalMs === 10,
      'max phase/target interval invalid',
    );
    requireEvidence(
      Array.isArray(phase.deliveries) && phase.deliveries.length === 3125,
      '3125 batches per max phase required',
    );
    for (const [batch, delivery] of phase.deliveries.entries())
      validateDelivery(delivery, record.fixture, phaseIndex, batch);
    deliveries.push(...phase.deliveries);
    validateSubscriptionsAndDocuments(phase, record.fixture);
  }
  const crossings = validateEvents(record.maxPhases, record.fixture);
  const soak = record.soak;
  requireEvidence(
    soak?.status === 'accepted' &&
      soak.targetIntervalMs === 40 &&
      nonnegative(soak.elapsedMs) &&
      soak.elapsedMs >= 120_000,
    '120000ms mixed soak required',
  );
  requireEvidence(soak.ruleCycles === 25 && soak.mounts === 6, '25 rule cycles and six mounts required');
  requireEvidence(
    Array.isArray(soak.deliveries) && soak.deliveries.length === 3000,
    '3000 mixed raw deliveries required',
  );
  for (const [batch, delivery] of soak.deliveries.entries())
    validateDelivery(delivery, record.fixture, 'soak', batch);
  for (const [name, attempts, count] of [
    ['cycle', soak.cycleAttempts, 25],
    ['mount', soak.mountAttempts, 6],
  ]) {
    requireEvidence(
      Array.isArray(attempts) && attempts.length === count,
      `${count} ${name} attempts required`,
    );
    requireEvidence(
      attempts.every((attempt, index) => attempt.index === index && nonnegative(attempt.actualAt)),
      `${name} attempt sequence invalid`,
    );
  }
  requireEvidence(
    JSON.stringify(soak.initialDocuments) === JSON.stringify(soak.finalDocuments),
    'equivalent initial/final rule documents required',
  );
  validateTimings(record, deliveries);
  validateResources(record);
  const cleanup = record.cleanup;
  requireEvidence(
    cleanup?.obsolete?.available === true &&
      cleanup.obsolete.newEvents === 0 &&
      cleanup.obsolete.documentsUnchanged === true &&
      cleanup.obsolete.monitorUnchanged === true &&
      cleanup.obsolete.subscriptionsUnchanged === true,
    'obsolete callback caused a stale effect or was not exercised',
  );
  requireEvidence(
    cleanup.subscriptions === record.resources.postDestroy.providerSubscriptions &&
      cleanup.timers === record.resources.postDestroy.appTimers &&
      cleanup.ownedSessions === record.resources.afterDestroy.monitors[0].snapshot.runtimeEntries &&
      cleanup.listeners ===
        Math.max(
          0,
          record.resources.postDestroy.counters.jsEventListeners -
            record.resources.staticBaseline.counters.jsEventListeners,
        ),
    'cleanup totals differ from direct post-destroy resource evidence',
  );
  for (const field of ['ownedSessions', 'subscriptions', 'timers', 'listeners'])
    requireEvidence(cleanup?.[field] === 0, `final owned ${field} cleanup must be zero`);
  requireEvidence(
    cleanup.browserClosed === true && cleanup.serverClosed === true,
    'owned browser/server cleanup missing',
  );
  return { phases: 3, deliveries: 300_000, crossings, budgets: ALERTS_BUDGETS };
}
