// Loaded only by ?test&grid-test. The normal React Grid view remains mounted.
let root = null;
let current = null;
let mounts = 0;
let destroys = 0;

window.__filtixGridTestHooks = {
  mounted(grid) {
    current = grid;
    mounts++;
  },
  destroyed(grid) {
    if (current === grid) current = null;
    destroys++;
  },
};

const fixture = window.terminalHarness.fixture;
const key = `filtix:terminal-grid:v1:${fixture.provider.id}`;

window.gridHarness = {
  get grid() {
    return current;
  },
  fixture,
  storageKey: key,
  counts() {
    return {
      mounts,
      destroys,
      mounted: current !== null,
      provider: fixture.stats(),
    };
  },
  workspace() {
    return current?.getWorkspace() ?? null;
  },
  setSavedRaw(value) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  },
  savedRaw() {
    return localStorage.getItem(key);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};

export function attachRoot(value) {
  root = value;
}

// The installed benchmark has an explicit opt-in namespace. The ordinary D4
// React/StrictMode fixture above is deliberately left available unchanged.
if (new URLSearchParams(location.search).has('grid-benchmark')) {
  window.gridBenchmark = { ready: false };
  void Promise.all([import('@filtrix.net/terminal'), import('@filtrix.net/alerts')]).then(
    ([terminalPackage, alertsPackage]) => {
      const { createTerminalGrid } = terminalPackage;
      const {
        createPriceAlertMonitor,
        createPriceAlertStore,
        getPriceAlertMonitorResourceSnapshot,
        getPriceAlertStoreResourceSnapshot,
      } = alertsPackage;
      const epoch = () => performance.timeOrigin + performance.now();
      const copy = (value) => structuredClone(value);
      const ids = ['cell-1', 'cell-2', 'cell-3', 'cell-4'];
      const keyOf = (query) => JSON.stringify([query.symbol, query.interval]);
      const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const maxRows = (scene) => scene.cells[0].rows.length;
      const chartCounters = (chart) => {
        const { sceneDraws, overlayDraws, primitiveDraws } = chart.getDiagnostics();
        return { sceneDraws, overlayDraws, primitiveDraws };
      };
      let scene = null;
      let provider = null;
      let host = null;
      let grid = null;
      let monitor = null;
      let generation = 0;
      let frameSerial = 0;
      let currentAction = null;
      let lastFailedAction = null;
      let events = [];
      let sourceRows = new Map();
      let sourceIndices = new Map();
      let heldLatest = null;
      let providerGeneration = 0;
      let requestSerial = 0;
      let subscriptionSerial = 0;
      const streams = new Map();
      const providerLedger = {
        requests: [],
        subscriptions: [],
        deliveries: [],
        pendingRequests: 0,
        historyPages: 0,
        latestPages: 0,
      };

      function providerSnapshot(runtimeMonitor = monitor) {
        const subscriptions = providerLedger.subscriptions.filter((item) => item.releasedAt === null);
        const runtime = runtimeMonitor ? getPriceAlertMonitorResourceSnapshot(runtimeMonitor) : null;
        const latest = runtime?.runtimes.filter((item) => item.active) ?? [];
        const remaining = new Map();
        for (const item of subscriptions) remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
        for (const item of latest) {
          const key = keyOf(item.query);
          if (item.feed.activeConnection) remaining.set(key, (remaining.get(key) ?? 0) - 1);
        }
        return {
          providerGeneration,
          requests: providerLedger.requests.length,
          historyPages: providerLedger.historyPages,
          latestPages: providerLedger.latestPages,
          pendingRequests: providerLedger.pendingRequests,
          activeSubscriptions: subscriptions.length,
          subscriptions: copy(subscriptions),
          historyFeeds: [...remaining.values()].reduce((sum, count) => sum + count, 0),
          latestFeeds: latest.filter((item) => item.feed.activeConnection).length,
          monitor: runtime,
        };
      }

      function buildProvider(input) {
        heldLatest?.release();
        heldLatest = null;
        const generationForProvider = ++providerGeneration;
        const source = new Map();
        for (const cell of input.cells)
          source.set(
            keyOf(cell.query),
            cell.rows.map((bar) => ({ ...bar })),
          );
        for (const alternate of input.alternateSources ?? [])
          source.set(
            keyOf(alternate.query),
            alternate.rows.map((bar) => ({ ...bar })),
          );
        for (const item of input.monitorSources ?? [])
          if (!source.has(keyOf(item.query)))
            source.set(
              keyOf(item.query),
              item.rows.map((bar) => ({ ...bar })),
            );
        sourceRows = source;
        sourceIndices = new Map(
          [...source].map(([key, rows]) => [key, new Map(rows.map((bar, index) => [bar.time, index]))]),
        );
        providerLedger.subscriptions.length = 0;
        providerLedger.deliveries.length = 0;
        providerLedger.historyPages = 0;
        providerLedger.latestPages = 0;
        streams.clear();
        return {
          id: input.gridWorkspace.providerId,
          revisionMode: 'arrival',
          maxPageSize: 10000,
          async getHistory(request, signal) {
            const startedAt = epoch();
            const key = keyOf(request);
            const entry = {
              id: `request-${++requestSerial}`,
              providerGeneration: generationForProvider,
              scope: input.__benchmarkScope ?? null,
              key,
              query: { symbol: request.symbol, interval: request.interval },
              limit: request.limit,
              requestKind: request.limit === 1 ? 'latest-protocol' : 'history-protocol',
              before: request.before ?? null,
              from: request.from ?? null,
              startedAt,
              status: 'pending',
              abortObservedAt: signal.aborted ? startedAt : null,
              abortObservedAfterFulfillmentAt: null,
              abortReason: signal.aborted ? String(signal.reason ?? 'aborted') : null,
            };
            providerLedger.requests.push(entry);
            const onAbort = () => {
              if (entry.status === 'fulfilled') entry.abortObservedAfterFulfillmentAt ??= epoch();
              else entry.abortObservedAt ??= epoch();
              entry.abortReason ??= String(signal.reason ?? 'aborted');
            };
            signal.addEventListener('abort', onAbort, { once: true });
            providerLedger.pendingRequests++;
            try {
              const rows = source.get(key);
              if (!rows) throw Error('Benchmark source missing exact query ' + key);
              if (signal.aborted) throw signal.reason ?? Error('History aborted');
              if (request.limit === 1 && heldLatest?.key === key && !heldLatest.started) {
                const hold = heldLatest;
                hold.started = true;
                await hold.promise;
                if (signal.aborted) throw signal.reason ?? Error('Held history aborted');
              }
              const eligible = rows.filter(
                (bar) =>
                  (request.before === undefined || bar.time < request.before) &&
                  (request.from === undefined || bar.time >= request.from),
              );
              const selected =
                request.from === undefined
                  ? eligible.slice(-request.limit)
                  : eligible.slice(0, request.limit);
              if (request.limit === 1) providerLedger.latestPages++;
              else providerLedger.historyPages++;
              const result = {
                bars: selected.map((bar) => ({ ...bar })),
                exhausted: selected.length === eligible.length,
              };
              entry.status = 'fulfilled';
              entry.returned = selected.length;
              entry.exhausted = result.exhausted;
              entry.finishedAt = epoch();
              return result;
            } catch (error) {
              entry.status = 'rejected';
              entry.finishedAt = epoch();
              entry.error = error instanceof Error ? error.message : String(error);
              entry.rejectedAfterObservedAbort = entry.abortObservedAt !== null;
              throw error;
            } finally {
              signal.removeEventListener('abort', onAbort);
              providerLedger.pendingRequests--;
            }
          },
          subscribe(query, handlers) {
            const key = keyOf(query);
            const set = streams.get(key) ?? new Set();
            streams.set(key, set);
            set.add(handlers);
            const entry = {
              subscriptionId: ++subscriptionSerial,
              providerGeneration: generationForProvider,
              key,
              query: { ...query },
              openedAt: epoch(),
              releasedAt: null,
            };
            providerLedger.subscriptions.push(entry);
            queueMicrotask(() => {
              if (set.has(handlers)) handlers.onOpen();
            });
            return () => {
              if (entry.releasedAt !== null) return;
              entry.releasedAt = epoch();
              set.delete(handlers);
              if (!set.size) streams.delete(key);
            };
          },
        };
      }

      function stageDeliveries(deliveries) {
        return deliveries.map(({ query, bar }) => {
          const key = keyOf(query);
          const rows = sourceRows.get(key);
          const index = sourceIndices.get(key);
          if (!rows || !index) throw Error('Delivery source missing ' + key);
          const at = index.get(bar.time);
          if (at !== undefined) rows[at] = { ...bar };
          else if (rows.length === 0 || rows.at(-1).time < bar.time) {
            index.set(bar.time, rows.length);
            rows.push({ ...bar });
          } else throw Error('Out-of-order benchmark delivery ' + key);
          const handlers = [...(streams.get(key) ?? [])];
          return {
            key,
            bar: { ...bar },
            calls: handlers.map((handler) => ({ handler, bar: { ...bar } })),
            handlers: handlers.length,
          };
        });
      }

      function dispatchStaged(staged, progress = null) {
        for (let delivery = 0; delivery < staged.length; delivery++) {
          const item = staged[delivery];
          for (let handler = 0; handler < item.calls.length; handler++) {
            if (progress) {
              progress.deliveryOrdinal = delivery + 1;
              progress.handlerOrdinal = handler + 1;
            }
            const call = item.calls[handler];
            call.handler.onBar(call.bar);
            if (progress) progress.completedHandlerCalls++;
          }
          if (progress) progress.completedDeliveries++;
        }
      }

      function recordDeliveries(staged, label, dispatchedAt) {
        providerLedger.deliveries.push(
          ...staged.map(({ key, bar, handlers }) => ({ label, key, bar, dispatchedAt, handlers })),
        );
      }

      function deliver(query, bar, label) {
        const staged = stageDeliveries([{ query, bar }]);
        const dispatchedAt = epoch();
        dispatchStaged(staged);
        recordDeliveries(staged, label, dispatchedAt);
        return staged[0].handlers;
      }

      function chartEntries() {
        if (!grid) return [];
        return ids.flatMap((cellId) => {
          const terminal = grid.getTerminal(cellId);
          return terminal ? [{ cellId, terminal, chart: terminal.chart, generation }] : [];
        });
      }

      // Native RAF callbacks are timed once; chart diagnostics are read outside
      // the callback interval and only changed current chart generations attach.
      const nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        nativeRaf((timestamp) => {
          const owner = currentAction;
          const before = chartEntries().map((item) => ({ ...item, counters: chartCounters(item.chart) }));
          const startedAt = epoch();
          try {
            return callback(timestamp);
          } finally {
            const callbackMs = epoch() - startedAt;
            if (owner) {
              const after = chartEntries();
              const changed = before.flatMap((item) => {
                const current = after.find(
                  (entry) => entry.cellId === item.cellId && entry.chart === item.chart,
                );
                if (!current) return [];
                const next = chartCounters(current.chart);
                return JSON.stringify(item.counters) === JSON.stringify(next)
                  ? []
                  : [
                      {
                        cellId: item.cellId,
                        chartGeneration: current.generation,
                        before: item.counters,
                        after: next,
                      },
                    ];
              });
              if (changed.length)
                owner.frames.push({
                  receiptId: `raf-${++frameSerial}`,
                  chartGeneration: owner.chartGeneration,
                  at: startedAt,
                  callbackMs,
                  affectedCharts: changed,
                });
            }
          }
        });

      async function settle(affected = ids) {
        for (let pass = 0; pass < 2; pass++) {
          await Promise.all(
            affected.map((id) => grid?.getTerminal(id)?.chart.whenIdle() ?? Promise.resolve()),
          );
          await nextFrame();
        }
        await pause();
        await Promise.all(affected.map((id) => grid?.getTerminal(id)?.chart.whenIdle() ?? Promise.resolve()));
      }

      async function hydrate(targetRows, targetLatestQueries = scene.monitorSources.length) {
        const deadline = epoch() + 30000;
        for (;;) {
          if (!grid || !monitor) throw Error('Grid/monitor destroyed during hydration');
          const state = grid.getState();
          if (state.error) throw Error('Grid hydration: ' + state.error);
          const terminals = ids.map((id) => grid.getTerminal(id));
          const backfills = [];
          for (const terminal of terminals) {
            if (!terminal) continue;
            const feed = terminal.getState().feed;
            if (feed.error) throw Error('History hydration: ' + feed.error.message);
            if (feed.status === 'live' && feed.bars < targetRows && feed.hasMore && !feed.loadingMore)
              backfills.push(terminal.loadMore());
          }
          if (backfills.length) await Promise.all(backfills);
          const readyHistory = terminals.every(
            (terminal) =>
              terminal &&
              terminal.getState().feed.status === 'live' &&
              terminal.getState().feed.bars === targetRows &&
              terminal.getState().feed.query &&
              keyOf(terminal.getState().feed.query) === keyOf(terminal.getWorkspace().query),
          );
          const alert = monitor.getState();
          const readyLatest =
            alert.queries.length === targetLatestQueries &&
            alert.queries.every((item) => item.status === 'monitoring');
          if (readyHistory && readyLatest)
            return {
              capturedAt: epoch(),
              terminals: 4,
              rowsPerCell: targetRows,
              latestQueries: targetLatestQueries,
              cells: terminals.map((terminal, index) => ({
                cellId: ids[index],
                query: terminal.getWorkspace().query,
                rows: terminal.getState().feed.bars,
                feed: copy(terminal.getState().feed),
              })),
              latest: copy(alert.queries),
              monitor: getPriceAlertMonitorResourceSnapshot(monitor),
              provider: providerSnapshot(),
            };
          if (epoch() > deadline)
            throw Error(
              'Full hydration timeout: ' + JSON.stringify({ state, alert, provider: providerSnapshot() }),
            );
          await pause(5);
        }
      }

      async function runAction(spec) {
        lastFailedAction = null;
        try {
          return await runActionCore(spec);
        } catch (error) {
          lastFailedAction ??= {
            id: spec.id,
            kind: spec.kind,
            phase: spec.phase,
            requested: copy(spec),
            phaseReached: 'pre-dispatch',
            dispatched: false,
            failedAt: epoch(),
            error: error instanceof Error ? error.message : String(error),
          };
          throw error;
        }
      }

      async function runActionCore(spec) {
        if (currentAction) throw Error('Overlapping measured actions');
        await settle(spec.affectedCellIds ?? ids);
        const before = providerSnapshot();
        const semanticKind = new Set([
          'construct',
          'restore',
          'layout',
          'active',
          'drawing',
          'study',
          'pane',
          'market',
        ]).has(spec.kind);
        const semanticBefore = semanticKind
          ? { state: grid?.getState() ?? null, workspace: grid?.getWorkspace() ?? null }
          : undefined;
        const preparationStartedAt = spec.kind === 'deliver' ? epoch() : undefined;
        const staged = spec.kind === 'deliver' ? stageDeliveries(spec.deliveries) : null;
        const preparedAt = staged ? epoch() : undefined;
        const syncEvents = spec.phase?.startsWith('sync-') ? { range: [], crosshair: [] } : null;
        const syncBefore = syncEvents
          ? chartEntries().map(({ cellId, terminal, chart }) => ({
              cellId,
              query: terminal.getWorkspace().query,
              timeRange: chart.getVisibleTimeRange(),
            }))
          : null;
        const syncUnsubscribe = syncEvents
          ? chartEntries().flatMap(({ cellId, chart }) => [
              chart.subscribeVisibleRangeChange((range, meta) =>
                syncEvents.range.push({
                  cellId,
                  range,
                  meta: { cause: meta.cause, revision: meta.revision, hasOrigin: meta.origin !== undefined },
                  at: epoch(),
                }),
              ),
              chart.subscribeCrosshairMove((event, meta) =>
                syncEvents.crosshair.push({
                  cellId,
                  event,
                  meta: { cause: meta.cause, revision: meta.revision, hasOrigin: meta.origin !== undefined },
                  at: epoch(),
                }),
              ),
            ])
          : [];
        const chartCohortBefore = chartEntries().map(({ cellId, terminal, generation: chartGeneration }) => ({
          cellId,
          chartGeneration,
          query: copy(terminal.getWorkspace().query),
        }));
        const wallClock = { dispatchedAt: Date.now() };
        const dispatchedAt = epoch();
        const owner = {
          frames: [],
          chartGeneration: generation,
          previousGeneration: generation,
          deliveryProgress: {
            deliveryOrdinal: 0,
            handlerOrdinal: 0,
            completedHandlerCalls: 0,
            completedDeliveries: 0,
          },
        };
        currentAction = owner;
        let pending;
        let returnedAt;
        let restoreFulfilledAt;
        let hydratedAt;
        let hydration;
        let settledAt;
        try {
          switch (spec.kind) {
            case 'construct': {
              if (grid || monitor) throw Error('Retire previous grid outside measured construction');
              generation++;
              owner.chartGeneration = generation;
              monitor = createPriceAlertMonitor({ provider });
              grid = createTerminalGrid(host, {
                provider,
                query: scene.cells[0].query,
                symbols: scene.catalog?.symbols ?? [
                  ...new Set(
                    [...scene.cells, ...(scene.alternateSources ?? [])].map((cell) => cell.query.symbol),
                  ),
                ],
                intervals: scene.catalog?.intervals ?? [
                  ...new Set(
                    [...scene.cells, ...(scene.alternateSources ?? [])].map((cell) => cell.query.interval),
                  ),
                ],
                layout: 1,
                feed: {
                  initialLimit: 10000,
                  pageSize: 10000,
                  maxBars: 100000,
                  staleAfterMs: 120000,
                  requestTimeoutMs: 30000,
                },
                alerts: { monitor },
                onAlert: (cellId, event) => events.push({ cellId, event, at: epoch() }),
              });
              pending = grid.restoreWorkspace(spec.workspace ?? scene.gridWorkspace);
              break;
            }
            case 'restore':
              pending = grid.restoreWorkspace(spec.workspace ?? scene.gridWorkspace);
              break;
            case 'layout':
              pending = grid.setLayout(spec.layout);
              break;
            case 'size':
              owner.effectiveObservation = { beforeRect: copy(host.getBoundingClientRect().toJSON()) };
              host.style.width = spec.width + 'px';
              host.style.height = spec.height + 'px';
              host.style.minWidth = spec.width === 0 ? '0px' : '1600px';
              host.style.minHeight = spec.height === 0 ? '0px' : '1000px';
              owner.effectiveObservation.afterRect = copy(host.getBoundingClientRect().toJSON());
              break;
            case 'active':
              grid.setActiveCell(spec.cellId);
              break;
            case 'sync':
              grid.setSync(spec.sync);
              break;
            case 'deliver':
              dispatchStaged(staged, owner.deliveryProgress);
              break;
            case 'range':
              grid.getTerminal(spec.cellId).chart.setVisibleTimeRange(spec.range);
              break;
            case 'gesture': {
              const root = host.querySelector(`[data-filtix-grid-cell="${spec.cellId}"] [data-filtix-root]`);
              if (!root) throw Error('Native chart root missing for ' + spec.cellId);
              const bounds = root.getBoundingClientRect();
              const x = bounds.left + Math.min(120, bounds.width / 3);
              const y = bounds.top + Math.min(90, bounds.height / 3);
              const beforeRange = grid.getTerminal(spec.cellId).chart.getVisibleRange();
              if (spec.gesture === 'pan') {
                const panX = bounds.left + 30;
                const panY = bounds.top + 30;
                root.dispatchEvent(
                  new PointerEvent('pointerdown', {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 301,
                    pointerType: 'mouse',
                    button: 0,
                    clientX: panX,
                    clientY: panY,
                  }),
                );
                root.dispatchEvent(
                  new PointerEvent('pointermove', {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 301,
                    pointerType: 'mouse',
                    button: 0,
                    clientX: panX + (spec.deltaX ?? 18),
                    clientY: panY,
                  }),
                );
                root.dispatchEvent(
                  new PointerEvent('pointerup', {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 301,
                    pointerType: 'mouse',
                    button: 0,
                    clientX: panX + (spec.deltaX ?? 18),
                    clientY: panY,
                  }),
                );
              } else if (spec.gesture === 'zoom') {
                root.dispatchEvent(
                  new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaY: spec.deltaY ?? 20,
                    clientX: x,
                    clientY: y,
                  }),
                );
              } else throw Error('Unknown native gesture');
              owner.effectiveObservation = {
                beforeRange,
                afterRange: grid.getTerminal(spec.cellId).chart.getVisibleRange(),
              };
              break;
            }
            case 'cursor':
              grid.getTerminal(spec.cellId).chart.setCrosshairTime(spec.time, { match: spec.match });
              break;
            case 'drawing':
              grid.getTerminal(spec.cellId).getDrawings().update(spec.drawingId, spec.patch);
              break;
            case 'study':
              grid.getTerminal(spec.cellId).updateStudy(spec.studyId, spec.patch);
              break;
            case 'pane':
              grid.getTerminal(spec.cellId).applyLayout({ panes: spec.panes });
              break;
            case 'market':
              pending = grid.getTerminal(spec.cellId).setMarket(spec.query);
              break;
            case 'wheel': {
              const terminal = grid.getTerminal(spec.cellId);
              const root = host.querySelector(`[data-filtix-grid-cell="${spec.cellId}"] [data-filtix-root]`);
              const beforeRange = terminal.chart.getVisibleRange();
              root.dispatchEvent(
                new WheelEvent('wheel', {
                  bubbles: true,
                  cancelable: true,
                  deltaY: spec.deltaY ?? 40,
                  clientX: root.getBoundingClientRect().left + 100,
                  clientY: root.getBoundingClientRect().top + 100,
                }),
              );
              owner.effectiveObservation = { beforeRange, afterRange: terminal.chart.getVisibleRange() };
              break;
            }
            default:
              throw Error('Unknown benchmark action ' + spec.kind);
          }
          returnedAt = epoch();
          wallClock.returnedAt = Date.now();
          if (staged) recordDeliveries(staged, spec.id, dispatchedAt);
          const bookkeepingCompletedAt = staged ? epoch() : undefined;
          if (pending) await pending;
          restoreFulfilledAt = pending ? epoch() : undefined;
          if (
            spec.targetRows !== undefined &&
            ['construct', 'restore', 'market', 'layout'].includes(spec.kind)
          ) {
            hydration = await hydrate(
              spec.targetRows ?? maxRows(scene),
              spec.targetLatestQueries ?? scene.monitorSources.length,
            );
            hydratedAt = epoch();
            const target = spec.targetRows ?? maxRows(scene);
            for (const entry of chartEntries())
              entry.chart.setVisibleRange({ from: Math.max(0, target - 1000), to: target });
          }
          await settle(spec.affectedCellIds ?? ids);
          settledAt = epoch();
          wallClock.settledAt = Date.now();
          const chartCohortAfter = chartEntries().map(
            ({ cellId, terminal, generation: chartGeneration }) => ({
              cellId,
              chartGeneration,
              query: copy(terminal.getWorkspace().query),
            }),
          );
          if (
            spec.kind === 'construct' &&
            (chartCohortAfter.some((item) => item.chartGeneration !== owner.chartGeneration) ||
              owner.frames.some(
                (frame) =>
                  frame.chartGeneration !== owner.chartGeneration ||
                  frame.affectedCharts.some((item) => item.chartGeneration !== owner.chartGeneration),
              ))
          )
            throw Error('Construction frame generation differs from current chart cohort');
          const semanticAfter = semanticKind
            ? { state: grid?.getState() ?? null, workspace: grid?.getWorkspace() ?? null }
            : undefined;
          const syncObservation = syncEvents
            ? {
                requested: {
                  kind: spec.kind,
                  match: spec.match ?? grid.getState().sync.crosshairMatch,
                  sourceCellId: spec.cellId,
                  ...(spec.time !== undefined ? { time: spec.time } : {}),
                  ...(spec.range ? { range: copy(spec.range) } : {}),
                },
                sourceCellId: spec.cellId,
                match: spec.match ?? grid.getState().sync.crosshairMatch,
                before: syncBefore,
                after: chartEntries().map(({ cellId, terminal, chart }) => ({
                  cellId,
                  query: terminal.getWorkspace().query,
                  timeRange: chart.getVisibleTimeRange(),
                })),
                rangeEvents: copy(syncEvents.range),
                crosshairEvents: syncEvents.crosshair.map(({ cellId, event, meta, at }) => ({
                  cellId,
                  time: event.time,
                  logicalIndex: event.logicalIndex,
                  points: copy(event.points),
                  meta,
                  at,
                })),
                afterCrosshair: chartEntries().map(({ cellId, terminal }) => {
                  const event = syncEvents.crosshair.filter((entry) => entry.cellId === cellId).at(-1)?.event;
                  return {
                    cellId,
                    query: terminal.getWorkspace().query,
                    time: event?.time ?? null,
                    points: event ? copy(event.points) : [],
                  };
                }),
              }
            : undefined;
          const renderWorkMs = owner.frames.reduce((sum, frame) => sum + frame.callbackMs, 0);
          return {
            id: spec.id,
            kind: spec.kind,
            phase: spec.phase,
            wallClock,
            requested: copy(spec),
            targetCellId: spec.cellId,
            deliveries: staged
              ? staged.map(({ key, bar, handlers }) => ({ key, bar: copy(bar), handlers }))
              : undefined,
            targetAt: spec.targetAt ?? dispatchedAt,
            dispatchedAt,
            returnedAt,
            preparationStartedAt,
            preparedAt,
            bookkeepingCompletedAt,
            restoreFulfilledAt,
            hydratedAt,
            settledAt,
            synchronousMs: returnedAt - dispatchedAt,
            restoreFulfilledMs:
              restoreFulfilledAt === undefined ? undefined : restoreFulfilledAt - dispatchedAt,
            hydratedMs: hydratedAt === undefined ? undefined : hydratedAt - dispatchedAt,
            settledMs: settledAt - dispatchedAt,
            renderWorkMs,
            libraryWorkMs: returnedAt - dispatchedAt + renderWorkMs,
            affectedCellIds: spec.affectedCellIds ?? ids,
            frames: owner.frames,
            chartGeneration: owner.chartGeneration,
            previousGeneration: owner.previousGeneration,
            chartCohortBefore,
            chartCohortAfter,
            chartCohort: chartCohortAfter,
            hydration,
            effectiveObservation: owner.effectiveObservation,
            semanticObservation: semanticKind
              ? { requested: copy(spec), before: semanticBefore, after: semanticAfter }
              : undefined,
            syncObservation,
            providerBefore: before,
            providerAfter: providerSnapshot(),
          };
        } catch (error) {
          let providerAfter = null;
          let providerSnapshotError = null;
          try {
            providerAfter = providerSnapshot();
          } catch (snapshotError) {
            providerSnapshotError =
              snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
          }
          lastFailedAction = {
            id: spec.id,
            kind: spec.kind,
            phase: spec.phase,
            wallClock: { ...wallClock },
            chartCohortBefore: copy(chartCohortBefore),
            chartCohortAfter: chartEntries().map(({ cellId, terminal, generation: chartGeneration }) => ({
              cellId,
              chartGeneration,
              query: copy(terminal.getWorkspace().query),
            })),
            requested: copy(spec),
            phaseReached:
              returnedAt === undefined
                ? 'dispatched-no-return'
                : settledAt === undefined
                  ? 'returned-unsettled'
                  : 'settled-before-validation',
            dispatched: true,
            dispatchedAt,
            returnedAt,
            restoreFulfilledAt,
            hydratedAt,
            settledAt,
            failedAt: epoch(),
            preparedAt,
            preparationStartedAt,
            deliveryProgress: { ...owner.deliveryProgress },
            frames: copy(owner.frames),
            chartGeneration: owner.chartGeneration,
            previousGeneration: owner.previousGeneration,
            providerBefore: before,
            providerAfter,
            providerSnapshotError,
            providerRequestLifecycles: copy(providerLedger.requests.slice(before.requests)),
            error: error instanceof Error ? error.message : String(error),
          };
          throw error;
        } finally {
          for (const unsubscribe of syncUnsubscribe) unsubscribe();
          currentAction = null;
        }
      }

      async function beginExternal(spec) {
        const cohort = () =>
          chartEntries().map(({ cellId, terminal, generation: chartGeneration }) => ({
            cellId,
            chartGeneration,
            query: copy(terminal.getWorkspace().query),
          }));
        if (spec.stage !== 'arm') {
          if (currentAction) throw Error('Overlapping external action');
          if (!grid?.getTerminal(spec.cellId)) throw Error('External action target is not mounted');
          const startedAt = epoch();
          currentAction = {
            id: spec.id,
            stage: 'pointer-preparation',
            requested: copy(spec),
            startedAt,
            chartGeneration: generation,
            chartCohortBefore: cohort(),
            frames: [],
          };
          await settle();
          currentAction.initialSettledAt = epoch();
          return { startedAt, initialSettledAt: currentAction.initialSettledAt };
        }
        const preparation = currentAction;
        if (preparation?.stage !== 'pointer-preparation' || preparation.id !== spec.id)
          throw Error('External pointer preparation does not match arm request');
        const pointerSetupCompletedAt = epoch();
        await settle();
        const pointerPreparation = {
          startedAt: preparation.startedAt,
          initialSettledAt: preparation.initialSettledAt,
          pointerSetupCompletedAt,
          settledAt: epoch(),
          chartGeneration: preparation.chartGeneration,
          chartCohortBefore: preparation.chartCohortBefore,
          chartCohortAfter: cohort(),
          frames: preparation.frames,
          renderWorkMs: preparation.frames.reduce((sum, frame) => sum + frame.callbackMs, 0),
        };
        const requested = preparation.requested;
        const terminal = grid?.getTerminal(requested.cellId);
        if (!terminal) throw Error('External action target is not mounted');
        const root = host.querySelector(`[data-filtix-grid-cell="${requested.cellId}"] [data-filtix-root]`);
        if (!root) throw Error('External chart root missing');
        const armedAt = epoch();
        const capture = () => {
          if (currentAction) {
            currentAction.dispatchWallStart = Date.now();
            currentAction.dispatchStart = epoch();
          }
        };
        const bubble = () => {
          if (currentAction) {
            currentAction.dispatchEnd = epoch();
            currentAction.dispatchWallEnd = Date.now();
          }
        };
        root.addEventListener('wheel', capture, true);
        root.addEventListener('wheel', bubble);
        currentAction = {
          id: requested.id,
          kind: requested.kind,
          phase: requested.phase,
          requested,
          targetAt: requested.targetAt ?? preparation.startedAt,
          armedAt,
          pointerPreparation,
          chartGeneration: generation,
          chartCohortBefore: cohort(),
          cellId: requested.cellId,
          beforeRange: terminal.chart.getVisibleRange(),
          providerBefore: providerSnapshot(),
          frames: [],
          removeWheelObservers() {
            root.removeEventListener('wheel', capture, true);
            root.removeEventListener('wheel', bubble);
          },
        };
        return { armedAt, beforeRange: currentAction.beforeRange, pointerPreparation };
      }

      async function finishExternal(automation) {
        const owner = currentAction;
        if (!owner?.cellId) throw Error('No external action active');
        owner.removeWheelObservers();
        try {
          if (
            !Number.isFinite(owner.dispatchStart) ||
            !Number.isFinite(owner.dispatchEnd) ||
            !Number.isFinite(owner.dispatchWallStart) ||
            !Number.isFinite(owner.dispatchWallEnd)
          )
            throw Error('Real wheel event was not observed at chart root');
          const dispatchedAt = owner.dispatchStart;
          const returnedAt = owner.dispatchEnd;
          await settle();
          const settledAt = epoch();
          const settledWallAt = Date.now();
          const afterRange = grid.getTerminal(owner.cellId).chart.getVisibleRange();
          const renderWorkMs = owner.frames.reduce((sum, frame) => sum + frame.callbackMs, 0);
          return {
            id: owner.id,
            kind: owner.kind,
            phase: owner.phase,
            requested: owner.requested,
            targetCellId: owner.cellId,
            targetAt: owner.targetAt,
            armedAt: owner.armedAt,
            pointerPreparation: owner.pointerPreparation,
            chartCohortBefore: owner.chartCohortBefore,
            chartCohortAfter: chartEntries().map(({ cellId, terminal, generation: chartGeneration }) => ({
              cellId,
              chartGeneration,
              query: copy(terminal.getWorkspace().query),
            })),
            wallClock: {
              dispatchedAt: owner.dispatchWallStart,
              returnedAt: owner.dispatchWallEnd,
              settledAt: settledWallAt,
            },
            dispatchedAt,
            returnedAt,
            settledAt,
            synchronousMs: returnedAt - dispatchedAt,
            settledMs: settledAt - dispatchedAt,
            renderWorkMs,
            libraryWorkMs: returnedAt - dispatchedAt + renderWorkMs,
            affectedCellIds: owner.chartCohortBefore.map((entry) => entry.cellId),
            frames: owner.frames,
            chartGeneration: owner.chartGeneration,
            providerBefore: owner.providerBefore,
            providerAfter: providerSnapshot(),
            automationStarted: automation.startedAt,
            automationCompleted: automation.completedAt,
            automationInclusiveMs: automation.completedAt - automation.startedAt,
            effectiveObservation: { beforeRange: owner.beforeRange, afterRange },
          };
        } finally {
          currentAction = null;
        }
      }

      async function prepare(input) {
        if (currentAction) throw Error('Cannot prepare during a timed action');
        grid?.destroy();
        monitor?.destroy();
        grid = null;
        monitor = null;
        scene = copy(input);
        provider = buildProvider(scene);
        if (!input.__preserveEvents) events = [];
        window.gridHarness.unmount();
        host = document.createElement('div');
        host.id = 'grid-benchmark-host';
        host.style.cssText = 'width:1600px;height:1000px;min-width:1600px;min-height:1000px';
        document.body.replaceChildren(host);
        return {
          providerId: provider.id,
          rowsPerCell: maxRows(scene),
          cells: scene.cells.map((cell) => ({ id: cell.id, query: cell.query })),
        };
      }

      async function prepareEmpty() {
        if (grid || monitor || currentAction)
          throw Error('Empty resource baseline requires no active benchmark product');
        window.gridHarness.unmount();
        const beforeClear = fixture.stats();
        fixture.clearFaults();
        const deadline = epoch() + 1000;
        while (fixture.stats().activeRequests > 0 && epoch() < deadline) await pause(5);
        const ordinaryDemo = {
          beforeClear,
          ...fixture.stats(),
          lateDeliveryAfterClear: fixture.deliverLate(),
        };
        if (
          ordinaryDemo.activeRequests !== 0 ||
          ordinaryDemo.activeSubscriptions !== 0 ||
          ordinaryDemo.lateDeliveryAfterClear !== null
        )
          throw Error('Ordinary demo fixture remained active after fault-state teardown');
        host?.remove();
        host = null;
        document.body.replaceChildren();
        return { ...resources('prepared-empty-baseline'), ordinaryDemo };
      }

      function resources(label) {
        return {
          sampleKind: 'transient-feed',
          label,
          at: epoch(),
          provider: providerSnapshot(),
          monitor: monitor ? getPriceAlertMonitorResourceSnapshot(monitor) : null,
          cells: ids.map((cellId) => {
            const terminal = grid?.getTerminal(cellId);
            return terminal
              ? {
                  cellId,
                  feed: copy(terminal.getState().feed),
                  rows: terminal.getData().length,
                  query: terminal.getWorkspace().query,
                  alerts: getPriceAlertStoreResourceSnapshot(terminal.getAlerts()),
                }
              : { cellId, feed: null };
          }),
          gridState: grid?.getState() ?? null,
        };
      }

      // Poll public feed counts without cloning every OHLCV bar. Accepted
      // pre/post-GC snapshots still use resources() and getData().length.
      function resourceReadiness(label) {
        return {
          sampleKind: 'resource-readiness-poll',
          label,
          at: epoch(),
          provider: providerSnapshot(),
          monitor: monitor ? getPriceAlertMonitorResourceSnapshot(monitor) : null,
          cells: ids.map((cellId) => {
            const terminal = grid?.getTerminal(cellId);
            if (!terminal) return { cellId, feed: null };
            const feed = terminal.getState().feed;
            return { cellId, feed: copy(feed), rows: feed.bars, query: terminal.getWorkspace().query };
          }),
          gridState: grid ? { layout: grid.getState().layout } : null,
        };
      }

      async function probeTransientLatest() {
        if (grid || monitor || !provider || !scene)
          throw Error('Transient probe requires a closed fixed grid');
        const query = copy(scene.monitorSources.at(-1).query);
        const key = keyOf(query);
        const probeMonitor = createPriceAlertMonitor({ provider });
        const store = createPriceAlertStore({
          providerId: provider.id,
          scopeId: 'grid-benchmark-transient-probe',
        });
        const baseline = sourceRows.get(key).at(-1);
        store.add({ query, price: baseline.close + 2, condition: 'crosses-up', frequency: 'repeat' });
        const observations = [];
        const snapshot = (stage) =>
          observations.push({
            sampleKind: 'transient-feed',
            label: `transient-${stage}`,
            at: epoch(),
            query: copy(query),
            provider: providerSnapshot(probeMonitor),
            monitor: getPriceAlertMonitorResourceSnapshot(probeMonitor),
          });
        const makeHold = () => {
          let resolveHold;
          const promise = new Promise((resolve) => {
            resolveHold = resolve;
          });
          const value = { key, started: false, promise, release: resolveHold };
          heldLatest = value;
          return value;
        };
        const until = async (predicate, label) => {
          const deadline = epoch() + 10000;
          while (!predicate()) {
            if (epoch() > deadline) {
              snapshot(`${label}-timeout`);
              throw Error(`Transient latest ${label} timeout: ${JSON.stringify(observations.at(-1))}`);
            }
            await pause(10);
          }
        };
        const interval =
          { m: 60000, h: 3600000, d: 86400000 }[query.interval.at(-1)] * Number.parseInt(query.interval, 10);
        const fresh = (last, step) => ({
          ...last,
          time: last.time + interval,
          open: last.close,
          close: last.close + step,
          high: Math.max(last.close, last.close + step) + 0.1,
          low: Math.min(last.close, last.close + step) - 0.1,
        });
        let releaseMembership;
        try {
          const first = makeHold();
          releaseMembership = probeMonitor.attach(store);
          await until(() => first.started, 'initial-hold');
          snapshot('initial-held-before-delivery');
          const firstBar = fresh(sourceRows.get(key).at(-1), 0.01);
          deliver(query, firstBar, 'transient-initial-held-delivery');
          snapshot('initial-held-after-delivery');
          first.release();
          heldLatest = null;
          await until(
            () =>
              getPriceAlertMonitorResourceSnapshot(probeMonitor).runtimes.some(
                (item) => item.feed.status === 'live',
              ),
            'initial-reconcile',
          );
          snapshot('initial-reconciled');
          const second = makeHold();
          for (const handler of [...(streams.get(key) ?? [])]) handler.onClose();
          await until(() => second.started, 'reconnect-hold');
          snapshot('reconnect-held-before-delivery');
          const secondBar = fresh(sourceRows.get(key).at(-1), 0.02);
          deliver(query, secondBar, 'transient-reconnect-held-delivery');
          snapshot('reconnect-held-after-delivery');
          second.release();
          heldLatest = null;
          await until(
            () =>
              getPriceAlertMonitorResourceSnapshot(probeMonitor).runtimes.some(
                (item) => item.feed.status === 'live',
              ),
            'reconnect-reconcile',
          );
          snapshot('reconnect-reconciled');
        } finally {
          heldLatest?.release();
          heldLatest = null;
          releaseMembership?.();
          store.destroy();
          probeMonitor.destroy();
          snapshot('destroyed');
        }
        return observations;
      }

      async function drawingObservation(terminal, cellId) {
        const document = terminal.getDrawings().toJSON();
        const chart = terminal.chart;
        const cell = host.querySelector(`[data-filtix-grid-cell="${cellId}"]`);
        const target = cell?.querySelector('canvas[data-filtix-layer="annotation"]');
        if (!target) throw Error('Annotation Canvas missing for ' + cellId);
        const proto = CanvasRenderingContext2D.prototype;
        const methods = [
          'clearRect',
          'save',
          'restore',
          'beginPath',
          'moveTo',
          'lineTo',
          'closePath',
          'rect',
          'clip',
          'arc',
          'stroke',
          'fill',
          'strokeRect',
          'fillRect',
          'fillText',
          'setLineDash',
        ];
        const original = new Map();
        const groups = [];
        let depth = 0;
        let group = null;
        let path = [];
        let projection = null;
        let clearCount = 0;
        const paint = new Set(['stroke', 'fill', 'strokeRect', 'fillRect', 'fillText', 'arc']);
        let detach = null;
        try {
          for (const name of methods) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (!descriptor || typeof descriptor.value !== 'function')
              throw Error('Missing Canvas method ' + name);
            original.set(name, descriptor);
            Object.defineProperty(proto, name, {
              ...descriptor,
              value: function (...args) {
                if (this.canvas === target) {
                  if (name === 'clearRect') {
                    clearCount++;
                    groups.length = 0;
                    group = null;
                    path = [];
                    depth = 0;
                  }
                  if (name === 'save') {
                    depth++;
                    if (depth === 2) {
                      group = { sourceIndex: groups.length, calls: [] };
                      groups.push(group);
                    }
                  }
                  if (name === 'beginPath') path = [];
                  if (['moveTo', 'lineTo', 'rect', 'arc', 'closePath'].includes(name))
                    path.push([name, ...args]);
                  if (group && depth >= 2 && paint.has(name))
                    group.calls.push({
                      method: name,
                      args: copy(args),
                      path: copy(path),
                      strokeStyle: String(this.strokeStyle),
                      fillStyle: String(this.fillStyle),
                      lineWidth: this.lineWidth,
                      globalAlpha: this.globalAlpha,
                      lineDash: this.getLineDash(),
                      font: this.font,
                      textBaseline: this.textBaseline,
                    });
                  if (name === 'restore') {
                    if (depth === 2) group = null;
                    depth--;
                  }
                }
                return Reflect.apply(descriptor.value, this, args);
              },
            });
          }
          detach = chart.attachPrimitive({
            draw(ctx, value, mode) {
              if (ctx.canvas !== target || mode !== 'screen') return;
              const anchors = document.drawings.flatMap((drawing) =>
                drawing.points.map((point, pointIndex) => ({
                  sourceId: drawing.id,
                  pointIndex,
                  time: point.time,
                  price: point.price,
                  x: value.timeToX(point.time),
                  y: value.priceToY(point.price, drawing.paneId),
                  loadedIndex: value.timeToLogicalIndex(point.time),
                })),
              );
              const textMetrics = {};
              const measureMetrics = {};
              const fibonacciMetrics = {};
              const fibonacciLevels = {};
              const priceBasis = {};
              for (const pane of value.panes) {
                const prices = document.drawings
                  .filter((item) => item.paneId === pane.id)
                  .flatMap((item) => item.points.map((point) => point.price));
                if (prices.length < 2) continue;
                const low = Math.min(...prices);
                const high = Math.max(...prices);
                if (low === high) continue;
                priceBasis[pane.id] = [
                  { price: low, y: value.priceToY(low, pane.id) },
                  { price: high, y: value.priceToY(high, pane.id) },
                ];
              }
              for (const drawing of document.drawings) {
                if (drawing.type === 'text-note') {
                  ctx.font = drawing.fontSize + 'px sans-serif';
                  textMetrics[drawing.id] = drawing.text
                    .split('\n')
                    .map((line) => ctx.measureText(line).width);
                } else if (drawing.type === 'measure') {
                  const [first, second] = drawing.points;
                  const difference = second.price - first.price;
                  const percentage = first.price === 0 ? null : (difference / Math.abs(first.price)) * 100;
                  const number = (item) => (item === null ? 'n/a' : Number(item.toPrecision(5)).toString());
                  const label =
                    number(difference) +
                    ' (' +
                    number(percentage) +
                    '%) · ' +
                    number(Math.abs(second.time - first.time) / 86400000) +
                    'd';
                  ctx.font = '12px sans-serif';
                  measureMetrics[drawing.id] = { label, width: ctx.measureText(label).width };
                } else if (drawing.type === 'fibonacci-retracement') {
                  const pane = value.panes.find((item) => item.id === drawing.paneId);
                  const a = drawing.points[0].price;
                  const b = drawing.points[1].price;
                  fibonacciLevels[drawing.id] = [];
                  fibonacciMetrics[drawing.id] = drawing.levels.map((level) => {
                    const price =
                      pane?.scale === 'log'
                        ? Math.exp(Math.log(a) + level.ratio * (Math.log(b) - Math.log(a)))
                        : a * (1 - level.ratio) + b * level.ratio;
                    fibonacciLevels[drawing.id].push({
                      ratio: level.ratio,
                      price,
                      y: value.priceToY(price, drawing.paneId),
                    });
                    const label =
                      Number((level.ratio * 100).toPrecision(5)) + '% · ' + Number(price.toPrecision(6));
                    ctx.font = '11px sans-serif';
                    return { label, width: ctx.measureText(label).width };
                  });
                }
              }
              projection = {
                width: value.width,
                height: value.height,
                plotWidth: value.plotWidth,
                plotHeight: value.plotHeight,
                dpr: value.dpr,
                timeDomain: value.timeDomain,
                panes: value.panes.map((pane) => ({ ...pane })),
                visibleRange: chart.getVisibleRange(),
                theme: { background: value.theme.background },
                anchors,
                priceBasis,
                textMetrics,
                measureMetrics,
                fibonacciMetrics,
                fibonacciLevels,
              };
            },
          });
          await chart.whenIdle();
          if (!projection || clearCount !== 1 || groups.length !== document.drawings.length || depth !== 0)
            throw Error(
              'Incomplete per-cell Canvas observation: ' +
                JSON.stringify({
                  cellId,
                  clearCount,
                  groups: groups.length,
                  drawings: document.drawings.length,
                  depth,
                }),
            );
          groups.forEach((item, index) => {
            item.sourceId = document.drawings[index].id;
          });
          const geometry = document.drawings.map((drawing) => {
            const anchors = projection.anchors
              .filter((item) => item.sourceId === drawing.id)
              .sort((a, b) => a.pointIndex - b.pointIndex)
              .map(({ time, price, x, y }) => ({ time, price, x, y }));
            // Primitive coordinates remain finite outside the pane; the public
            // chart priceToCoordinate API intentionally clips those to null.
            const fibLevels = copy(projection.fibonacciLevels[drawing.id] ?? []);
            const widths = projection.textMetrics[drawing.id] ?? [];
            const lines = drawing.type === 'text-note' ? drawing.text.split('\n') : [];
            const left = anchors[0]?.x ?? null;
            const top = anchors[0]?.y ?? null;
            const text =
              drawing.type === 'text-note' && left !== null && top !== null
                ? {
                    content: drawing.text,
                    lineCount: lines.length,
                    fontSize: drawing.fontSize,
                    anchorX: left,
                    anchorY: top,
                    bounds: {
                      left,
                      top,
                      right: left + Math.max(12, ...widths) + 12,
                      bottom: top + lines.length * drawing.fontSize * 1.25 + 12,
                    },
                  }
                : null;
            return {
              id: drawing.id,
              type: drawing.type,
              paneId: drawing.paneId,
              visible: drawing.visible,
              anchors,
              fibLevels,
              text,
            };
          });
          return { document, geometry, drawingObservation: { projection, groups } };
        } finally {
          detach?.();
          for (const [name, descriptor] of original) Object.defineProperty(proto, name, descriptor);
          await chart.whenIdle();
        }
      }

      async function checkpoint(spec) {
        if (currentAction) throw Error('Checkpoint overlaps measured action');
        if (!grid) throw Error('No benchmark grid');
        await settle();
        const priorSync = grid.getState().sync;
        const ranges = Object.fromEntries(
          chartEntries().map((entry) => [entry.cellId, entry.chart.getVisibleRange()]),
        );
        grid.setSync({ viewport: false, crosshair: false });
        const cells = [];
        try {
          for (const cellId of ids) {
            const terminal = grid.getTerminal(cellId);
            if (!terminal) throw Error('Checkpoint requires mounted cell ' + cellId);
            const bars = terminal.getData().map((bar) => ({ ...bar }));
            const chart = terminal.chart;
            const rendered = [];
            let observed = null;
            const unsubscribe = chart.subscribeCrosshairMove((event) => {
              observed = event;
            });
            try {
              chart.setVisibleRange({ from: -1, to: bars.length });
              await chart.whenIdle();
              chart.setCrosshairTime(null);
              await chart.whenIdle();
              for (const index of spec.indices) {
                observed = null;
                chart.setCrosshairTime(bars[index].time);
                await chart.whenIdle();
                if (!observed || observed.time !== bars[index].time)
                  throw Error(`Missing actual rendered crosshair ${cellId}:${index}`);
                rendered.push({ index, time: observed.time, points: copy(observed.points) });
              }
            } finally {
              unsubscribe();
              chart.setCrosshairTime(null);
              chart.setVisibleRange(ranges[cellId]);
              await chart.whenIdle();
            }
            const drawing = await drawingObservation(terminal, cellId);
            cells.push({
              id: cellId,
              query: copy(terminal.getWorkspace().query),
              source: {
                rows: bars.length,
                firstTime: bars[0]?.time ?? null,
                lastTime: bars.at(-1)?.time ?? null,
                bars,
              },
              rendered,
              drawings: { document: drawing.document, geometry: drawing.geometry },
              drawingObservation: drawing.drawingObservation,
              alerts: {
                document: terminal.getAlerts().toJSON(),
                events: copy(events.filter((item) => item.cellId === cellId).map((item) => item.event)),
              },
              workspace: terminal.getWorkspace(),
              feedOwnership: {
                feed: terminal.getState().feed,
                provider: providerSnapshot(),
                monitor: getPriceAlertMonitorResourceSnapshot(monitor),
              },
              seriesCount: chart.getDiagnostics().seriesCount,
              paneCount: chart.getPaneLayout().panes.length,
            });
          }
        } finally {
          grid.setSync(priorSync);
          for (const entry of chartEntries()) entry.chart.setVisibleRange(ranges[entry.cellId]);
          await settle();
        }
        return { id: spec.id, at: epoch(), wallClockAt: Date.now(), state: grid.getState(), cells };
      }

      function close() {
        const before = resources('before-close');
        grid?.destroy();
        grid = null;
        const borrowedUsable = monitor ? !monitor.getState().destroyed : false;
        const borrowedAfterGrid = monitor ? getPriceAlertMonitorResourceSnapshot(monitor) : null;
        let borrowedUse = null;
        if (monitor) {
          const proof = createPriceAlertStore({
            providerId: provider.id,
            scopeId: `grid-benchmark-borrowed-proof-${generation}`,
          });
          const release = monitor.attach(proof);
          borrowedUse = {
            attached: monitor.getState().destroyed === false,
            membersWhileAttached: getPriceAlertMonitorResourceSnapshot(monitor).members,
          };
          release();
          borrowedUse.membersAfterRelease = getPriceAlertMonitorResourceSnapshot(monitor).members;
          proof.destroy();
        }
        const finalMonitor = monitor;
        monitor?.destroy();
        monitor = null;
        const after = resources('after-close');
        host?.remove();
        host = null;
        return {
          before,
          borrowedUsable,
          borrowedAfterGrid,
          borrowedUse,
          destroyedMonitor: finalMonitor ? getPriceAlertMonitorResourceSnapshot(finalMonitor) : null,
          after,
          events: copy(events),
        };
      }

      async function ownershipControls() {
        if (grid || monitor) throw Error('Ownership controls require closed fixed scene');
        const controlHost = document.createElement('div');
        controlHost.style.cssText = 'width:600px;height:400px';
        document.body.append(controlHost);
        const options = {
          provider,
          query: scene.cells[0].query,
          symbols: scene.catalog?.symbols ?? [...new Set(scene.cells.map((cell) => cell.query.symbol))],
          intervals: scene.catalog?.intervals ?? [...new Set(scene.cells.map((cell) => cell.query.interval))],
          layout: 1,
          feed: { initialLimit: 256, pageSize: 256, maxBars: 100000 },
        };
        let defaultGrid;
        let suppliedGrid;
        let suppliedMonitor;
        const stores = [];
        try {
          defaultGrid = createTerminalGrid(controlHost, options);
          await defaultGrid.restoreWorkspace(scene.gridWorkspace);
          const ownedStore = defaultGrid.getTerminal('cell-1').getAlerts();
          const populated = ownedStore.toJSON().alerts.length;
          defaultGrid.destroy();
          const defaultOwned = {
            populated,
            store: getPriceAlertStoreResourceSnapshot(ownedStore),
            provider: providerSnapshot(),
          };
          defaultGrid = null;

          suppliedMonitor = createPriceAlertMonitor({ provider });
          for (const id of ids)
            stores.push(
              createPriceAlertStore({ providerId: provider.id, scopeId: `grid-benchmark-supplied-${id}` }),
            );
          suppliedGrid = createTerminalGrid(controlHost, {
            ...options,
            alerts: {
              monitor: suppliedMonitor,
              stores: Object.fromEntries(ids.map((id, index) => [id, stores[index]])),
            },
          });
          const beforeDestroy = stores.map((store) => getPriceAlertStoreResourceSnapshot(store));
          suppliedGrid.destroy();
          const suppliedUsable = stores.every(
            (store) =>
              !getPriceAlertStoreResourceSnapshot(store).destroyed &&
              store.toJSON().schema === 'filtix-price-alerts',
          );
          const monitorUsable = !suppliedMonitor.getState().destroyed;
          const afterDestroy = stores.map((store) => getPriceAlertStoreResourceSnapshot(store));
          suppliedGrid = null;
          return {
            defaultOwned,
            supplied: { beforeDestroy, afterDestroy, suppliedUsable, monitorUsable },
            provider: providerSnapshot(),
          };
        } finally {
          defaultGrid?.destroy();
          suppliedGrid?.destroy();
          for (const store of stores) store.destroy();
          suppliedMonitor?.destroy();
          controlHost.remove();
        }
      }

      function retire() {
        if (currentAction) throw Error('Cannot retire during a measured action');
        const before = resources('before-retire');
        grid?.destroy();
        grid = null;
        const borrowedUsable = monitor ? !monitor.getState().destroyed : false;
        const borrowed = monitor ? getPriceAlertMonitorResourceSnapshot(monitor) : null;
        monitor?.destroy();
        monitor = null;
        return { before, borrowedUsable, borrowed, after: resources('after-retire') };
      }

      window.gridBenchmark = {
        ready: true,
        prepare,
        prepareEmpty,
        act: runAction,
        failureWitness(id) {
          return lastFailedAction?.id === id ? copy(lastFailedAction) : null;
        },
        beginExternal,
        finishExternal,
        settle,
        resources,
        resourceReadiness,
        probeTransientLatest,
        checkpoint,
        close,
        ownershipControls,
        retire,
        deliver,
        providerSnapshot,
        providerSources() {
          return {
            providerGeneration,
            sources: [...sourceRows].map(([key, rows]) => {
              const [symbol, interval] = JSON.parse(key);
              return {
                query: { symbol, interval },
                rows: rows.length,
                firstTime: rows[0]?.time ?? null,
                lastTime: rows.at(-1)?.time ?? null,
                lastBar: rows.length ? copy(rows.at(-1)) : null,
              };
            }),
          };
        },
        requestLedger() {
          return copy(providerLedger.requests);
        },
        get grid() {
          return grid;
        },
        get monitor() {
          return monitor;
        },
        get scene() {
          return scene;
        },
        get host() {
          return host;
        },
      };
    },
  );
}
