import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAlertsFixture,
  buildMaxDelivery,
  buildSoakDelivery,
  expectedArchiveMembers,
  referenceEvents,
  validateAlertsEvidence,
} from '../../scripts/alerts-oracle.mjs';

const hash = 'a'.repeat(64);
const packageNames = [
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
const fixture = buildAlertsFixture();
const gcRounds = () => [1, 2, 3].map((turn) => ({ turn, observed: turn }));

function liveEndpoint(scene) {
  return {
    ...resourceSnapshot(scene),
    gcRounds: gcRounds(),
    counters: { jsEventListeners: 4 },
    heap: { usedSize: 1000 },
    owned: {
      consumer: { total: 10, connectedOutside: 0, detached: 0 },
      terminal: {
        total: 9,
        connectedOutside: 0,
        detached: 0,
        generations: [{ id: 1, rootConnected: true, total: 9 }],
      },
    },
  };
}

function resourceSnapshot(scene, destroyed = false) {
  const store = destroyed
    ? { destroyed: true, changeListeners: 0, eventListeners: 0, admissionListeners: 0, lifecycleListeners: 0 }
    : {
        destroyed: false,
        changeListeners: 1,
        eventListeners: 1,
        admissionListeners: 1,
        lifecycleListeners: 1,
      };
  const monitor = destroyed
    ? {
        destroyed: true,
        members: 0,
        leaseEntries: 0,
        observerListeners: 0,
        retainedMemberDisposers: 0,
        cachedRuleEntries: 0,
        baselineEntries: 0,
        runtimeEntries: 0,
        activeRuntimeEntries: 0,
        reconcileTimers: 0,
        reservationPending: false,
        activationPending: false,
      }
    : {
        destroyed: false,
        members: 4,
        leaseEntries: 4,
        observerListeners: 1,
        retainedMemberDisposers: 12,
        cachedRuleEntries: 400,
        baselineEntries: 400,
        runtimeEntries: 32,
        activeRuntimeEntries: 32,
        reconcileTimers: 0,
        reservationPending: false,
        activationPending: false,
      };
  return {
    stores: scene.stores.map((document) => ({ id: document.scopeId, snapshot: { ...store } })),
    monitors: [{ id: 'monitor-0', snapshot: monitor }],
    appTimers: 0,
    providerSubscriptions: destroyed ? 0 : 32,
  };
}

function record() {
  const scene = buildAlertsFixture();
  const maxPhases = Array.from({ length: 3 }, (_, phase) => ({
    phase,
    status: 'accepted',
    targetIntervalMs: 10,
    deliveries: Array.from({ length: 3125 }, (_, batch) => ({
      ...buildMaxDelivery(scene, phase, batch),
      intendedAt: phase * 40_000 + batch * 10,
      actualAt: phase * 40_000 + batch * 10 + 0.5,
      browserAt: phase * 40_000 + batch * 10 + 1,
      syncMs: 1,
      settledMs: 2,
      preparedBars: 32,
      evidenceMaterializedAfterTiming: true,
    })),
  }));
  const expected = referenceEvents(scene, maxPhases);
  for (const [phase, entry] of maxPhases.entries()) {
    entry.expectedEvents = expected.filter((event) => event.phase === phase);
    entry.observedEvents = entry.expectedEvents.map((event) => ({
      ...event,
      observedAt: 1_000 + event.batch,
      callbackAt: 1_001 + event.batch,
    }));
    entry.terminalObservedEvents = entry.observedEvents
      .filter((event) => event.scopeId === scene.stores[0].scopeId)
      .map((event) => ({
        ...event,
        browserAt: entry.deliveries[event.batch].browserAt,
        callbackAt: entry.deliveries[event.batch].browserAt + 2,
        callbackLatencyMs: 2,
      }));
    entry.subscriptions = scene.queries.map((query) => ({
      query: { ...query },
      active: 1,
      delivered: 32 + (phase + 1) * 3125,
    }));
    entry.documents = scene.stores.map((store) => ({
      ...store,
      alerts: store.alerts.map((alert) => ({ ...alert, query: { ...alert.query } })),
    }));
    const once = entry.documents[0].alerts[32];
    const onceEvent = expected.find((event) => event.alertId === once.id);
    once.status = 'triggered';
    once.triggerCount = 1;
    once.lastTrigger = { ...onceEvent, observedAt: 1_000 };
  }
  return {
    schema: 'filtix-alerts-installed-evidence',
    version: 1,
    mode: 'all',
    status: 'pass',
    source: {
      commit: 'b'.repeat(40),
      dirty: [],
      files: [{ path: 'packages/alerts/src/index.ts', sha256: hash }],
    },
    installation: {
      version: '0.10.0',
      archives: packageNames.map((name) => ({
        name: `@filtix/${name}`,
        sha256: hash,
        members: expectedArchiveMembers(name).map((path) => ({ path, sha256: hash })),
      })),
      memberCount: 42,
    },
    declared: {
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
    },
    fixture: scene,
    warmup: {
      status: 'accepted',
      deliveries: Array.from({ length: 32 }, (_, batch) => ({
        ...buildMaxDelivery(scene, -1, batch),
        intendedAt: batch * 10,
        actualAt: batch * 10 + 0.5,
        browserAt: batch * 10 + 1,
        syncMs: 1,
        settledMs: 2,
        preparedBars: 32,
        evidenceMaterializedAfterTiming: true,
      })),
    },
    maxPhases,
    soak: {
      status: 'accepted',
      targetIntervalMs: 40,
      elapsedMs: 120_001,
      ruleCycles: 25,
      mounts: 6,
      deliveries: Array.from({ length: 3000 }, (_, batch) => ({
        ...buildSoakDelivery(scene, batch),
        intendedAt: batch * 40,
        actualAt: batch * 40 + 0.5,
        browserAt: batch * 40 + 1,
        syncMs: 1,
        settledMs: 2,
        preparedBars: 32,
        evidenceMaterializedAfterTiming: true,
      })),
      cycleAttempts: Array.from({ length: 25 }, (_, index) => ({ index, actualAt: 1000 + index * 4000 })),
      mountAttempts: Array.from({ length: 6 }, (_, index) => ({ index, actualAt: 2000 + index * 15_000 })),
      initialDocuments: scene.stores,
      finalDocuments: scene.stores,
    },
    timings: {
      activationMs: 1,
      sync: { samples: maxPhases.flatMap((phase) => phase.deliveries.map(() => 1)), p95: 1, p99: 1 },
      settled: { samples: maxPhases.flatMap((phase) => phase.deliveries.map(() => 2)), p95: 2, p99: 2 },
      terminalCallbacks: {
        samples: maxPhases.flatMap((phase) =>
          phase.terminalObservedEvents.map((event) => event.callbackLatencyMs),
        ),
        p95: 2,
        p99: 2,
      },
    },
    resources: {
      gcTurns: 3,
      gcRounds: gcRounds(),
      initialObsolete: { available: false },
      initial: liveEndpoint(scene),
      final: liveEndpoint(scene),
      afterDestroy: resourceSnapshot(scene, true),
      staticBaseline: {
        gcRounds: gcRounds(),
        counters: { jsEventListeners: 4 },
        owned: { consumer: { total: 1 }, terminal: { total: 0 } },
      },
      postDestroy: {
        gcRounds: gcRounds(),
        counters: { jsEventListeners: 4 },
        owned: {
          consumer: { total: 1, detached: 0, connectedOutside: 0 },
          terminal: { total: 0, detached: 0, connectedOutside: 0 },
        },
        providerSubscriptions: 0,
        appTimers: 0,
      },
      growth: 0,
      terminalGrowth: 0,
      listenerGrowth: 0,
      retainedHeapDelta: 0,
      outside: 0,
      detached: 0,
      disposed: 0,
    },
    cleanup: {
      ownedSessions: 0,
      subscriptions: 0,
      timers: 0,
      listeners: 0,
      obsolete: {
        available: true,
        newEvents: 0,
        documentsUnchanged: true,
        monitorUnchanged: true,
        subscriptionsUnchanged: true,
      },
      browserClosed: true,
      serverClosed: true,
    },
    errors: [],
  };
}

function rejects(change, pattern) {
  const candidate = record();
  change(candidate);
  assert.throws(() => validateAlertsEvidence(candidate), pattern);
}

test('deterministic fixture is four stores, 400 rules and 32 shared exact queries with paused and once coverage', () => {
  assert.equal(fixture.stores.length, 4);
  assert.equal(
    fixture.stores.reduce((sum, store) => sum + store.alerts.length, 0),
    400,
  );
  assert.equal(fixture.queries.length, 32);
  assert.ok(fixture.stores.flatMap((store) => store.alerts).some((rule) => rule.status === 'paused'));
  assert.ok(fixture.stores.flatMap((store) => store.alerts).some((rule) => rule.frequency === 'once'));
  assert.ok(
    referenceEvents(
      fixture,
      Array.from({ length: 3 }, (_, phase) => ({
        phase,
        deliveries: Array.from({ length: 3125 }, (_, batch) => buildMaxDelivery(fixture, phase, batch)),
      })),
    ).length >= 100,
  );
});

test('installed fixture keeps its one-chart catalog separate from 32 monitored alert queries', () => {
  const source = readFileSync(
    new URL('../../examples/react-terminal/src/alerts-test.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /symbols:\s*\[chartQuery\.symbol\]/);
  assert.doesNotMatch(source, /symbols:\s*\[chartQuery\.symbol,\s*\.\.\.fixture\.queries/);
  assert.equal(fixture.queries.length, 32);
});

test('complete synthetic record passes while wrong cohort and missing member identity fail', () => {
  assert.ok(validateAlertsEvidence(record()));
  rejects((value) => {
    value.installation.archives.pop();
  }, /cohort|archive/i);
  rejects((value) => {
    value.installation.archives[0].members[0].sha256 = '';
  }, /member|sha256|identity/i);
});

test('rejects short rule/query fixture and wrong max phase or delivery cardinality', () => {
  rejects((value) => {
    value.fixture.stores[0].alerts.pop();
  }, /400|rule/i);
  rejects((value) => {
    value.fixture.queries.pop();
  }, /32|quer/i);
  rejects((value) => {
    value.maxPhases.pop();
  }, /three|phase/i);
  rejects((value) => {
    value.maxPhases[0].deliveries.pop();
  }, /3125|batch/i);
  rejects((value) => {
    value.maxPhases[0].deliveries[0].updates.pop();
  }, /32|update/i);
});

test('rejects missing cadence/raw inputs, short soak and omitted lifecycle cycles', () => {
  rejects((value) => {
    delete value.maxPhases[1].deliveries[2].intendedAt;
  }, /intended|cadence/i);
  rejects((value) => {
    delete value.maxPhases[1].deliveries[2].actualAt;
  }, /actual|cadence/i);
  rejects((value) => {
    delete value.maxPhases[1].deliveries[2].updates[0].close;
  }, /raw|close|update/i);
  rejects((value) => {
    value.soak.elapsedMs = 119_999;
  }, /120000|soak/i);
  rejects((value) => {
    value.soak.mounts = 5;
  }, /mount/i);
  rejects((value) => {
    value.soak.ruleCycles = 24;
  }, /cycle/i);
  rejects((value) => {
    value.soak.deliveries[0].updates[0].close = 101;
  }, /soak|raw|close/i);
  rejects((value) => {
    value.soak.cycleAttempts.pop();
  }, /cycle|attempt/i);
});

test('rejects wrong oracle occurrence, duplicate query subscription and nonfinite timing', () => {
  rejects((value) => {
    value.maxPhases[0].observedEvents[0].occurrence++;
  }, /occurrence|oracle|event/i);
  rejects((value) => {
    value.maxPhases[0].subscriptions[0].active = 2;
  }, /subscription|query/i);
  rejects((value) => {
    value.maxPhases[0].terminalObservedEvents.pop();
  }, /terminal|callback/i);
  rejects((value) => {
    value.maxPhases[0].subscriptions[0].delivered--;
  }, /per-query|delivery/i);
  rejects((value) => {
    value.timings.sync.p95 = Number.NaN;
  }, /p95|finite|timing/i);
});

test('rejects missing cleanup, resource proof and source identity', () => {
  rejects((value) => {
    value.cleanup.ownedSessions = 1;
  }, /session|cleanup/i);
  rejects((value) => {
    value.resources.gcTurns = 2;
  }, /three|GC|resource/i);
  rejects((value) => {
    value.resources.afterDestroy.stores[0].snapshot.admissionListeners = 1;
  }, /admissionListeners|listener/i);
  rejects((value) => {
    value.resources.outside = 1;
  }, /outside|resource/i);
  rejects((value) => {
    value.source.files = [];
  }, /source|identity/i);
});

test('rejects rare 1000ms real terminal callback latency despite passing batch percentiles', () => {
  rejects((value) => {
    for (const phase of value.maxPhases) {
      for (const event of phase.terminalObservedEvents) {
        event.callbackAt = event.browserAt + 1000;
        event.callbackLatencyMs = 1000;
        phase.deliveries[event.batch].syncMs = 1000;
        phase.deliveries[event.batch].settledMs = 1000;
      }
    }
    const batches = value.maxPhases.flatMap((phase) => phase.deliveries);
    value.timings.sync.samples = batches.map((delivery) => delivery.syncMs);
    value.timings.settled.samples = batches.map((delivery) => delivery.settledMs);
    value.timings.terminalCallbacks.samples = value.maxPhases.flatMap((phase) =>
      phase.terminalObservedEvents.map(() => 1000),
    );
    value.timings.terminalCallbacks.p95 = 1000;
    value.timings.terminalCallbacks.p99 = 1000;
    assert.equal(value.timings.sync.samples.filter((item) => item === 1000).length, 21);
    assert.equal(value.timings.settled.p95, 2);
  }, /terminal|callback|latency|budget/i);
});

test('rejects missing or nonzero post-destroy owned DOM and listener proof', () => {
  rejects((value) => {
    delete value.resources.postDestroy;
  }, /post-destroy|resource|DOM/i);
  rejects((value) => {
    value.resources.postDestroy.owned.terminal.total = 1;
  }, /terminal|DOM|node/i);
  rejects((value) => {
    value.resources.postDestroy.counters.jsEventListeners = 5;
  }, /listener/i);
  rejects((value) => {
    value.cleanup.obsolete.newEvents = 1;
  }, /obsolete|stale/i);
});

test('rejects timing boundary that includes browser bar construction or evidence materialization', () => {
  rejects((value) => {
    value.maxPhases[0].deliveries[0].preparedBars = 0;
  }, /prepared|bar|boundary/i);
  rejects((value) => {
    value.maxPhases[0].deliveries[0].evidenceMaterializedAfterTiming = false;
  }, /evidence|timing|boundary/i);
});

test('actual runner dispatch preserves fixture timing-boundary witnesses into validated raw evidence', async () => {
  const source = readFileSync(new URL('../../scripts/alerts-benchmark.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function dispatch(');
  const end = source.indexOf('\nasync function runWarmup(', start);
  assert.ok(start >= 0 && end > start);
  const exactDispatch = Function(
    'active',
    'now',
    'sleep',
    'page',
    `return (${source.slice(start, end)});`,
  )(
    () => {},
    () => 100,
    async () => {},
    {
      async evaluate() {
        return {
          browserAt: 101,
          syncMs: 1,
          settledMs: 2,
          preparedBars: 32,
          evidenceMaterializedAfterTiming: true,
          events: [],
          terminalEvents: [],
        };
      },
    },
  );
  const candidate = record();
  const raw = await exactDispatch(buildMaxDelivery(candidate.fixture, -1, 0), 100);
  assert.equal(raw.preparedBars, 32);
  assert.equal(raw.evidenceMaterializedAfterTiming, true);
  candidate.warmup.deliveries[0] = raw;
  assert.ok(validateAlertsEvidence(candidate));
});

test('rejects live endpoint raw growth hidden behind passing scalar resource summaries', () => {
  rejects((value) => {
    value.resources.final.owned.consumer.total++;
  }, /growth|resource|raw/i);
  rejects((value) => {
    value.resources.final.owned.terminal.total++;
  }, /terminal|growth|resource/i);
  rejects((value) => {
    value.resources.final.counters.jsEventListeners++;
  }, /listener|growth|resource/i);
  rejects((value) => {
    value.resources.final.heap.usedSize += 24 * 1024 * 1024;
  }, /heap|retained|resource/i);
  rejects((value) => {
    value.resources.final.owned.consumer.detached = 1;
  }, /detached|resource/i);
  rejects((value) => {
    value.resources.final.owned.terminal.generations[0].rootConnected = false;
  }, /disposed|resource/i);
});

test('rejects omitted raw endpoint proof and incorrect GC observations', () => {
  rejects((value) => {
    delete value.resources.initial.heap;
  }, /heap|resource|raw/i);
  rejects((value) => {
    delete value.resources.final.owned;
  }, /owned|resource|raw/i);
  rejects((value) => {
    value.resources.final.gcRounds[1].observed = 1;
  }, /GC|observed|resource/i);
  rejects((value) => {
    value.resources.postDestroy.gcRounds[2].observed = 0;
  }, /GC|observed|resource/i);
});

test('requires an initial retired-callback release witness with no stale semantic effect', () => {
  const unchanged = record().cleanup.obsolete;
  rejects((value) => {
    delete value.resources.initialObsolete;
  }, /initial.*obsolete|initial.*callback/i);
  for (const change of [
    { available: true },
    { ...unchanged, newEvents: 1 },
    { ...unchanged, documentsUnchanged: false },
    { ...unchanged, monitorUnchanged: false },
    { ...unchanged, subscriptionsUnchanged: false },
    { available: false, newEvents: 1 },
  ]) {
    rejects((value) => {
      value.resources.initialObsolete = change;
    }, /initial.*obsolete|initial.*callback/i);
  }
});

test('accepts initial release with no retired callback or an unchanged retired callback', () => {
  const candidate = record();
  assert.ok(validateAlertsEvidence(candidate));
  candidate.resources.initialObsolete = { ...candidate.cleanup.obsolete };
  assert.ok(validateAlertsEvidence(candidate));
});
