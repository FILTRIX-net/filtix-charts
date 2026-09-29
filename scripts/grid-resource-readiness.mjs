// Bounded physical ownership fence for the three-GC grid resource endpoints.
const EMPTY = new Set([
  'max-empty-baseline',
  'max-empty-final',
  'max-controls-final',
  'full-empty-baseline',
  'full-empty-final',
  'full-controls-final',
  'capacity-empty-baseline',
  'capacity-final',
  'capacity-controls-final',
]);
const MAX_FOUR = new Set(['max-mounted-initial', 'max-layout-4', 'max-layout-4-return', 'max-mounted-final']);
const FULL_FOUR = new Set(['full-mounted-initial', 'full-mounted-final']);
const queryKey = (query) => JSON.stringify([query?.symbol, query?.interval]);
const queryKeys = (queries) => queries.map(queryKey).sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function expectationForEndpoint(label, scene = null) {
  let histories;
  let rows;
  if (EMPTY.has(label)) return { label, kind: 'empty', layout: null, histories: 0, latest: 0 };
  if (MAX_FOUR.has(label) || /^soak-layout-4-(?:[1-9]|10)$/.test(label)) {
    histories = 4;
    rows = 100000;
  } else if (label === 'max-layout-1' || /^soak-layout-1-(?:[1-9]|10)$/.test(label)) {
    histories = 1;
    rows = 100000;
  } else if (FULL_FOUR.has(label)) {
    histories = 4;
    rows = 256;
  } else throw Error(`Unknown resource endpoint label ${label}`);
  if (!scene || scene.cells?.length !== 4 || scene.monitorSources?.length !== 8)
    throw Error(`${label} requires the exact four-cell/eight-monitor scene`);
  const cells = scene.cells.slice(0, histories).map(({ id, query }) => ({ id, query }));
  const latestQueries = scene.monitorSources.map(({ query }) => query);
  if (new Set(queryKeys(latestQueries)).size !== 8) throw Error('Expected eight distinct monitor queries');
  return { label, kind: 'mounted', layout: histories, histories, latest: 8, rows, cells, latestQueries };
}

export function assessEndpoint(snapshot, expected) {
  const reasons = [];
  const reject = (condition, reason) => {
    if (!condition) reasons.push(reason);
  };
  const provider = snapshot?.provider;
  const subscriptions = provider?.subscriptions;
  reject(Array.isArray(subscriptions), 'raw provider subscriptions missing');
  reject(
    Number.isSafeInteger(provider?.pendingRequests) && provider.pendingRequests === 0,
    'pending provider requests',
  );
  reject(provider?.activeSubscriptions === subscriptions?.length, 'provider summary/raw count mismatch');
  if (expected.kind === 'empty') {
    reject(snapshot?.gridState === null, 'empty grid still mounted');
    reject(snapshot?.monitor === null, 'empty monitor still mounted');
    reject(
      snapshot?.cells?.length === 4 && snapshot.cells.every((cell) => cell.feed === null),
      'empty chart feed still mounted',
    );
    reject(
      provider?.activeSubscriptions === 0 &&
        provider?.historyFeeds === 0 &&
        provider?.latestFeeds === 0 &&
        subscriptions?.length === 0,
      'empty physical subscription remains',
    );
    return { ready: reasons.length === 0, reasons, identities: [] };
  }
  reject(snapshot?.gridState?.layout === expected.layout, 'wrong grid layout');
  const liveCells = snapshot?.cells?.filter((cell) => cell.feed !== null) ?? [];
  reject(snapshot?.cells?.length === 4 && liveCells.length === expected.histories, 'wrong live chart count');
  reject(
    same(liveCells.map((cell) => cell.cellId).sort(), expected.cells.map((cell) => cell.id).sort()),
    'wrong or repeated mounted cell identity',
  );
  const expectedCells = new Map(expected.cells.map((cell) => [cell.id, cell]));
  for (const cell of liveCells) {
    const target = expectedCells.get(cell.cellId);
    reject(
      Boolean(target) &&
        queryKey(cell.query) === queryKey(target.query) &&
        queryKey(cell.feed?.query) === queryKey(target.query) &&
        cell.feed?.status === 'live' &&
        cell.rows === expected.rows,
      `chart ${cell.cellId} query/feed/history mismatch`,
    );
  }
  const monitor = snapshot?.monitor;
  const runtimes = monitor?.runtimes;
  reject(
    Array.isArray(runtimes) &&
      runtimes.length === expected.latest &&
      monitor?.runtimeEntries === expected.latest &&
      monitor?.activeRuntimeEntries === expected.latest,
    'wrong monitor runtime count',
  );
  reject(
    Array.isArray(runtimes) &&
      same(queryKeys(runtimes.map((runtime) => runtime.query)), queryKeys(expected.latestQueries)),
    'wrong monitor query multiset',
  );
  for (const runtime of runtimes ?? [])
    reject(
      runtime.active === true &&
        runtime.feed?.status === 'live' &&
        runtime.feed.activeConnection === true &&
        !runtime.feed.pendingRequest &&
        !runtime.feed.retryTimer &&
        !runtime.feed.requestTimer &&
        queryKey(runtime.feed.query) === queryKey(runtime.query),
      `monitor ${queryKey(runtime.query)} has no live physical connection`,
    );
  reject(
    provider?.historyFeeds === expected.histories &&
      provider?.latestFeeds === expected.latest &&
      provider?.activeSubscriptions === expected.histories + expected.latest,
    'wrong history/latest physical counts',
  );
  reject(
    Number.isSafeInteger(provider?.providerGeneration) && provider.providerGeneration > 0,
    'invalid provider generation',
  );
  const desired = queryKeys([...expected.cells.map((cell) => cell.query), ...expected.latestQueries]);
  reject(
    Array.isArray(subscriptions) && same(queryKeys(subscriptions.map((entry) => entry.query)), desired),
    'raw subscription query multiset mismatch',
  );
  const ids = new Set();
  const identities = [];
  for (const entry of subscriptions ?? []) {
    const identity = `${entry.providerGeneration}:${entry.subscriptionId}`;
    reject(
      Number.isSafeInteger(entry.subscriptionId) &&
        entry.subscriptionId > 0 &&
        Number.isSafeInteger(entry.providerGeneration) &&
        entry.providerGeneration === provider.providerGeneration &&
        !ids.has(identity) &&
        entry.releasedAt === null &&
        entry.key === queryKey(entry.query),
      `invalid physical subscription identity ${identity}`,
    );
    ids.add(identity);
    identities.push({
      providerGeneration: entry.providerGeneration,
      subscriptionId: entry.subscriptionId,
      key: entry.key,
      query: entry.query,
    });
  }
  identities.sort(
    (a, b) => a.providerGeneration - b.providerGeneration || a.subscriptionId - b.subscriptionId,
  );
  return { ready: reasons.length === 0, reasons, identities };
}

export async function collectEndpointReadiness({
  label,
  scene,
  readPoll,
  readFull,
  collectGc,
  now,
  pause,
  onAttempt = () => {},
  deadlineMs = 30000,
  maxGcAttempts = 3,
  pollMs = 100,
}) {
  const expected = expectationForEndpoint(label, scene);
  const startedAt = now();
  const readiness = {
    label,
    expected,
    clockDomains: {
      collector: 'node-performance-epoch-ms',
      snapshots: 'browser-performance-epoch-ms',
    },
    startedAt,
    polls: [],
    gcAttempts: [],
    accepted: false,
  };
  const fail = (message) => {
    readiness.completedAt = now();
    const error = new Error(`${label} resource readiness: ${message}`);
    error.readiness = readiness;
    onAttempt({ kind: 'failed', label, readiness });
    throw error;
  };
  for (;;) {
    if (now() - startedAt >= deadlineMs) fail('deadline exceeded');
    let poll;
    const pollRequestStartedAt = now();
    try {
      poll = await readPoll(label);
    } catch (error) {
      readiness.polls.push({
        stage: 'failed',
        requestStartedAt: pollRequestStartedAt,
        responseReceivedAt: now(),
        error: String(error),
      });
      fail(`poll observation failed: ${String(error)}`);
    }
    const pollResponseReceivedAt = now();
    const observed = assessEndpoint(poll, expected);
    readiness.polls.push({
      at: pollResponseReceivedAt,
      requestStartedAt: pollRequestStartedAt,
      responseReceivedAt: pollResponseReceivedAt,
      snapshot: poll,
      ...observed,
    });
    onAttempt({ kind: 'poll', label, observation: readiness.polls.at(-1) });
    if (!observed.ready) {
      await pause(pollMs);
      continue;
    }
    let pre;
    const preRequestStartedAt = now();
    try {
      pre = await readFull(`${label}-pre-gc`);
    } catch (error) {
      readiness.gcAttempts.push({
        preRequestStartedAt,
        preResponseReceivedAt: now(),
        error: String(error),
        accepted: false,
      });
      fail(`pre-GC observation failed: ${String(error)}`);
    }
    const preObservedAt = now();
    const preAssessment = assessEndpoint(pre, expected);
    if (!preAssessment.ready) {
      readiness.polls.push({
        at: preObservedAt,
        stage: 'pre-gc',
        requestStartedAt: preRequestStartedAt,
        responseReceivedAt: preObservedAt,
        snapshot: pre,
        ...preAssessment,
      });
      onAttempt({ kind: 'poll', label, observation: readiness.polls.at(-1) });
      await pause(pollMs);
      continue;
    }
    let measurements;
    try {
      measurements = await collectGc(label);
    } catch (error) {
      readiness.gcAttempts.push({
        pre,
        preRequestStartedAt,
        preResponseReceivedAt: preObservedAt,
        preObservedAt,
        preAssessment,
        error: String(error),
        accepted: false,
      });
      fail(`three-GC collection failed: ${String(error)}`);
    }
    let post;
    const postRequestStartedAt = now();
    try {
      post = await readFull(`${label}-post-gc`);
    } catch (error) {
      readiness.gcAttempts.push({
        pre,
        preRequestStartedAt,
        preResponseReceivedAt: preObservedAt,
        preObservedAt,
        preAssessment,
        measurements,
        postRequestStartedAt,
        postResponseReceivedAt: now(),
        error: String(error),
        accepted: false,
      });
      fail(`post-GC observation failed: ${String(error)}`);
    }
    const postObservedAt = now();
    const postAssessment = assessEndpoint(post, expected);
    const completedAt = now();
    const stable =
      postAssessment.ready &&
      same(preAssessment.identities, postAssessment.identities) &&
      completedAt - startedAt < deadlineMs;
    const attempt = {
      pre,
      preRequestStartedAt,
      preResponseReceivedAt: preObservedAt,
      preObservedAt,
      preAssessment,
      measurements,
      post,
      postRequestStartedAt,
      postResponseReceivedAt: postObservedAt,
      postObservedAt,
      postAssessment,
      accepted: stable,
    };
    readiness.gcAttempts.push(attempt);
    onAttempt({ kind: 'gc-attempt', label, attempt });
    if (stable) {
      readiness.accepted = true;
      readiness.completedAt = completedAt;
      return { post, measurements, readiness };
    }
    if (readiness.gcAttempts.length >= maxGcAttempts) fail('GC attempt cap exhausted');
    await pause(pollMs);
  }
}
