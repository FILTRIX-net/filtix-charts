import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-grid-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalGridHarness));
}

test('four independent slots survive 4 to 1 to 4 with retained first terminal and defensive final snapshots', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.independentSlots());
  expect(result.initial.cells).toHaveLength(4);
  expect(new Set(result.initial.cells.map((cell: any) => cell.workspace.alerts.scopeId)).size).toBe(4);
  expect(
    result.initial.cells.every((cell: any) => cell.workspace.markets[0].drawings.drawings.length === 0),
  ).toBe(true);
  expect(result.beforePark.cells.map((cell: any) => cell.workspace.query)).toEqual([
    { symbol: 'BTCUSDT', interval: '1m' },
    { symbol: 'ETHUSDT', interval: '5m' },
    { symbol: 'SOLUSDT', interval: '1h' },
    { symbol: 'ADAUSDT', interval: '1d' },
  ]);
  expect(result.beforePark.cells[0].workspace.settings.theme).toBe('light');
  expect(result.beforePark.cells[1].workspace.settings.theme).toBe('dark');
  expect(result.beforePark.cells[1].workspace.layout.studiesOpen).toBe(true);
  expect(result.beforePark.cells[2].workspace.studies.some((study: any) => study.kind === 'rsi')).toBe(true);
  expect(
    result.beforePark.cells[3].workspace.markets.some((market: any) => market.drawings.drawings.length === 1),
  ).toBe(true);
  expect(result.beforePark.sync).toEqual({ viewport: true, crosshair: true, crosshairMatch: 'nearest' });
  expect(result.parked.state).toMatchObject({ layout: 1, activeCellId: 'cell-1' });
  expect(result.parked.terminal2).toBeNull();
  expect(result.parked.terminal4).toBeNull();
  expect(result.parked.firstRetained).toBe(true);
  expect(result.parked.workspace.cells).toEqual(result.beforePark.cells);
  expect(result.expanded.cells).toEqual(result.beforePark.cells);
  expect(result.retained).toBe(true);
  expect(result.remounted).toBe(true);
  expect(result.copiesDefensive).toBe(true);
  expect(result.finalState.destroyed).toBe(true);
  expect(result.finalWorkspace.cells).toEqual(result.expanded.cells);
  expect(result.destroyedMutation).toBe(true);
  expect(result.destroyedAsync).toEqual({ layout: true, restore: true, sync: true });
  expect(result.invalidCellRejected).toBe(true);
  expect(result.children).toBe(0);
  expect(result.provider.active).toBe(0);
});

test('parked saved-query once alert fires once after displayed and active queries change, then survives save, restore and expansion', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.parkedAlerts());
  expect(result.savedBefore.layout).toBe(1);
  expect(result.savedBefore.cells[1].workspace.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
  expect(result.events).toHaveLength(2);
  expect(result.events.filter((event: any) => event.alertId === result.mountedId)).toEqual([
    expect.objectContaining({ cellId: 'cell-2', occurrence: 1 }),
  ]);
  expect(result.events.filter((event: any) => event.alertId === result.id)).toEqual([
    expect.objectContaining({ cellId: 'cell-2', occurrence: 1 }),
  ]);
  expect(result.afterCrossing.cells[1].workspace.alerts.alerts[0]).toMatchObject({
    status: 'triggered',
    triggerCount: 1,
  });
  expect(result.expanded.cells[1].workspace.alerts.alerts[0]).toMatchObject({
    status: 'triggered',
    triggerCount: 1,
  });
  expect(result.finalAlert).toMatchObject({ status: 'triggered', triggerCount: 1 });
  expect(result.provider.active).toBe(0);
});

test('initial and restore fourth real preparation failure leave no transient provider effects or staged resources', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.atomicFourthFailure());
  expect(result.initial.failure).toMatch(/injected fourth feed construction failure/);
  expect(result.initial).toMatchObject({
    counts: { charts: 0, feeds: 0 },
    provider: { history: 0, setup: 0, teardown: 0, active: 0 },
    children: 0,
  });
  expect(result.restoreFailure).toMatch(/injected fourth feed construction failure/);
  expect(result.after).toEqual(result.before);
  expect(result.sameTerminal).toBe(true);
  expect(result.sameNode).toBe(true);
  expect(result.providerAfter).toEqual(result.providerBefore);
  expect(result.counts.charts).toBe(1);
  expect(result.counts.feeds).toBe(1);
});

test('borrowed stores and monitor remain usable after final grid cleanup', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.borrowedCleanup());
  expect(result.after.monitor.destroyed).toBe(false);
  expect(result.after.stores.every((store: any) => store.destroyed === false)).toBe(true);
  expect(result.after.monitor.leaseEntries).toBe(1); // external lease only
  expect(result.stillUsable).toMatch(/^grid-fixture:cell-1:/);
  expect(result.children).toBe(0);
  expect(result.provider.active).toBe(0);
});

test('preference-only onState reentry keeps all newly mounted terminals usable', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.preferenceReentry());
  expect(result.reentered).toBe(true);
  expect(result.state).toMatchObject({ layout: 4, activeCellId: 'cell-2', sync: { viewport: true } });
  expect(result.statuses.every((status: string) => status !== 'idle' && status !== 'destroyed')).toBe(true);
  expect(result.usable).toEqual([true, true, true, true]);
});

test('incomplete supplied store records reject before provider or host effects', async ({ page }) => {
  await ready(page);
  const results = await page.evaluate(() => (window as any).terminalGridHarness.invalidSuppliedStores());
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.rejected).toBe(true);
    expect(result.failure).toMatch(/supplied.*store/i);
    expect(result.states).toBe(0);
    expect(result.provider).toEqual({ history: 0, setup: 0, teardown: 0, active: 0 });
    expect(result.monitor).toMatchObject({ destroyed: false, members: 0, leaseEntries: 0 });
    expect(result.stores.every((store: any) => store.destroyed === false)).toBe(true);
    expect(result.stillUsable).toMatch(/^incomplete:cell-1:/);
    expect(result.children).toBe(0);
  }
});

test('same-store layout changes preserve monitor transports and retained terminal callbacks', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.monitorContinuity());
  expect(result.retained).toBe(true);
  expect(result.monitorAfter).toEqual(result.monitorBefore);
  expect(result.after.monitor).toMatchObject({
    members: 4,
    leaseEntries: 5,
    runtimeEntries: 4,
    activeRuntimeEntries: 4,
  });
  expect(result.stateAfterEdit).toBeGreaterThan(result.stateBeforeEdit);
  expect(result.events).toContain('cell-4');
  expect(result.parkedRule).toMatchObject({ status: 'triggered', triggerCount: 1 });
  expect(result.final.monitor).toMatchObject({
    destroyed: false,
    members: 0,
    leaseEntries: 0,
    runtimeEntries: 0,
    activationPending: false,
  });
  expect(result.final.stores.every((store: any) => store.destroyed === false)).toBe(true);
  expect(result.final.total.active).toBe(0);
  expect(result.children).toBe(0);
});

test('invalid nested restore cannot strand already adopted visible terminals', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.invalidNestedRestore());
  expect(result.attempted).toBe(true);
  expect(result.nestedError).toMatch(/workspace/i);
  expect(result.state.layout).toBe(4);
  expect(result.usable).toEqual([true, true, true, true]);
  expect(result.statuses.every((status: string) => status !== 'idle' && status !== 'destroyed')).toBe(true);
});

test('real 400-rule 32-query restore preserves final membership and rejects a surviving same-scope lease', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.boundaryRestore());
  expect(result.saved.cells.map((cell: any) => cell.workspace.alerts.alerts.length)).toEqual([
    100, 100, 100, 100,
  ]);
  expect(result.roundTrip).toEqual(result.saved);
  expect(result.initial).toMatchObject({
    members: 5,
    leaseEntries: 9,
    cachedRuleEntries: 400,
    runtimeEntries: 32,
  });
  expect(result.afterRestore).toMatchObject({
    members: 5,
    leaseEntries: 9,
    cachedRuleEntries: 400,
    runtimeEntries: 32,
  });
  expect(result.afterConsumedRelease).toMatchObject({ members: 5, leaseEntries: 9, cachedRuleEntries: 400 });
  expect(result.fourthFailure).toMatch(/injected fourth feed construction failure/);
  expect(result.afterFourthFailure).toEqual(result.beforeFourthFailure);
  expect(result.sameFourthTerminal).toBe(true);
  expect(result.providerAfterFourth).toEqual(result.providerBeforeFourth);
  expect(result.stagedAfterFourth).toMatchObject({ charts: 4, feeds: 4 });
  expect(result.staleFailure).toMatch(/stale|changed/i);
  expect(result.afterStale).toEqual(result.beforeStale);
  expect(result.providerAfterStale).toEqual(result.providerBeforeStale);
  expect(result.afterStaleMonitor).toMatchObject({
    members: 5,
    leaseEntries: 9,
    cachedRuleEntries: 400,
    runtimeEntries: 32,
    activationPending: false,
    reservationPending: false,
  });
  const parkedOnce = result.parkedSaved.cells[3].workspace.alerts.alerts.find(
    (rule: any) => rule.id === result.onceId,
  );
  const expandedOnce = result.expanded.cells[3].workspace.alerts.alerts.find(
    (rule: any) => rule.id === result.onceId,
  );
  expect(parkedOnce).toMatchObject({ status: 'triggered', triggerCount: 1 });
  expect(expandedOnce).toMatchObject({ status: 'triggered', triggerCount: 1 });
  expect(result.events.filter((event: any) => event.alertId === result.onceId)).toEqual([
    { cellId: 'cell-4', alertId: result.onceId, occurrence: 1 },
  ]);
  expect(result.conflictError).toMatch(/scope|duplicate/i);
  expect(result.afterConflict).toEqual(result.beforeConflict);
  expect(result.sameTerminal).toBe(true);
  expect(result.providerAfterConflict).toEqual(result.providerBeforeConflict);
  expect(result.final.monitor).toMatchObject({
    destroyed: false,
    members: 0,
    leaseEntries: 0,
    activationPending: false,
  });
  expect(result.final.oldStores.every((store: any) => store.destroyed === false)).toBe(true);
  expect(result.final.unrelated.destroyed).toBe(false);
  expect(result.final.provider.active).toBe(0);
  expect(result.children).toBe(0);
});

test('old, unrelated external and grid revisions reject staged restore without adopting it', async ({
  page,
}) => {
  await ready(page);
  const results = await page.evaluate(() => (window as any).terminalGridHarness.revisionRejections());
  expect(results.map((result: any) => result.mode)).toEqual(['old-store', 'unrelated-store', 'grid']);
  for (const result of results) {
    expect(result.failure).toMatch(/stale|superseded|changed/i);
    expect(result.sameTerminal).toBe(true);
    expect(result.sameNode).toBe(true);
    expect(result.state.layout).toBe(1);
    expect(result.monitor).toMatchObject({
      members: 5,
      leaseEntries: 6,
      activationPending: false,
      reservationPending: false,
    });
    if (result.mode === 'old-store') {
      expect(result.oldStoreRules).toBe(1); // Intentional external edit remains live.
      expect(result.after.cells[2].workspace.alerts.alerts).toHaveLength(1);
    } else if (result.mode === 'unrelated-store') {
      expect(result.unrelatedRules).toBe(1); // External member changed; staged grid did not.
      expect(result.after).toEqual(result.before);
    } else {
      expect(result.state.sync.viewport).toBe(true); // Intentional nested preference change remains.
      expect(result.after.cells).toEqual(result.before.cells);
    }
  }
});

test('synchronous teardown sees coherent adopted grid and nested layout or destroy finishes C activation', async ({
  page,
}) => {
  await ready(page);
  const results = await page.evaluate(() => (window as any).terminalGridHarness.adoptionReentry());
  expect(results.map((result: any) => result.mode)).toEqual([
    'observe',
    'nested-layout',
    'nested-restore',
    'destroy',
  ]);
  for (const result of results) {
    expect(result.observations.length).toBeGreaterThan(0);
    expect(
      result.observations.every(
        (entry: any) =>
          entry.layout === 4 && entry.cells === 4 && entry.active === 'cell-1' && entry.workspaceLayout === 4,
      ),
    ).toBe(true);
    expect(result.beforeObsolete).toEqual(result.afterObsolete);
    expect(result.alertEvents).toBe(0);
    expect(result.historyResolved).toBe(1);
    expect(result.afterCleanup).toMatchObject({
      destroyed: false,
      members: 0,
      leaseEntries: 0,
      activationPending: false,
      reservationPending: false,
    });
    expect(result.provider.active).toBe(0);
    expect(result.children).toBe(0);
  }
  expect(results[0].observations.some((entry: any) => entry.phase === 'teardown')).toBe(true);
  expect(results[0].observations.some((entry: any) => entry.phase === 'setup')).toBe(true);
  expect(results.slice(1).every((result: any) => result.observations[0].phase === 'teardown')).toBe(true);
  expect(results[0].restoreError).toBe('');
  expect(results[0].finalState.layout).toBe(4);
  expect(results[1].restoreError).toMatch(/superseded/i);
  expect(results[1].nestedError).toBe('');
  expect(results[1].finalState.layout).toBe(2);
  expect(results[2].restoreError).toMatch(/superseded/i);
  expect(results[2].nestedError).toBe('');
  expect(results[2].finalState.layout).toBe(2);
  expect(results[3].restoreError).toMatch(/superseded/i);
  expect(results[3].finalState.destroyed).toBe(true);
  expect(results[3].preRestoreProvider.setup).toBe(3); // Initial chart, alert monitor and obsolete market switch.
  expect(results[3].preRestoreQueries.filter((value: string) => value === 'ETHUSDT/5m')).toHaveLength(1);
  expect(results[3].provider.setup).toBe(results[3].preRestoreProvider.setup); // Destroy starts no replacement.
});

test('onAlert may synchronously request layout, restore or destroy without duplicate delivery or stale leases', async ({
  page,
}) => {
  await ready(page);
  const results = await page.evaluate(() => (window as any).terminalGridHarness.alertReentry());
  expect(results.map((result: any) => result.mode)).toEqual(['layout', 'restore', 'destroy']);
  for (const result of results) {
    expect(result.events).toEqual([{ id: result.ruleId, occurrence: 1, immutable: true, seenLayout: 4 }]);
    expect(result.nestedError).toBe('');
    expect(result.monitor).toMatchObject({
      destroyed: false,
      members: 0,
      leaseEntries: 0,
      activationPending: false,
    });
    expect(result.provider.active).toBe(0);
    expect(result.children).toBe(0);
  }
  expect(results[0].state.layout).toBe(1);
  expect(results[1].state.layout).toBe(4);
  expect(results[1].saved.cells[1].workspace.alerts.alerts[0]).toMatchObject({
    status: 'triggered',
    triggerCount: 1,
  });
  expect(results[2].state.destroyed).toBe(true);
});

test('native DOM adoption fault rolls back old nodes and exact live grid state', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.nativeDomFailure());
  expect(result.failure).toMatch(/injected native adoption fault/);
  expect(result.after).toEqual(result.before);
  expect(result.sameTerminal).toBe(true);
  expect(result.sameChild).toBe(true);
  expect(result.providerAfter).toEqual(result.providerBefore);
});

test('owned grid cleanup releases charts, feeds, alert resources, listeners, observers and timers', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.ownedCleanup());
  console.log('D3 owned cleanup residual listeners', JSON.stringify(result.residualListeners));
  expect(result.value).toMatchObject({
    charts: 0,
    sessions: 0,
    children: 0,
    monitor: { destroyed: true, members: 0, leaseEntries: 0, activationPending: false },
  });
  expect(result.value.provider.active).toBe(0);
  expect(result.value.stores.every((store: any) => store.destroyed === true)).toBe(true);
  expect(result).toMatchObject({ listeners: 0, observers: 0, timers: 0, frames: 0 });
});

test('real observer reentry exhausts one eight-attempt grid repair budget truthfully', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.repairExhaustion());
  expect(result.callbackMutations).toBe(8);
  expect(result.state.error).toMatch(/repair did not settle within 8 attempts/i);
  expect(result.mounted).toEqual([true, true]);
});

test('fourth partial construction failures release exact listeners, observers, timers and frames', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalGridHarness.failedConstructionResources());
  console.log('D3 failure residual listeners', JSON.stringify(result.residualListeners));
  expect(result.value.initial.failure).toMatch(/injected fourth feed construction failure/);
  expect(result.value.restoreFailure).toMatch(/injected fourth feed construction failure/);
  expect(result).toMatchObject({ listeners: 0, observers: 0, timers: 0, frames: 0 });
});
