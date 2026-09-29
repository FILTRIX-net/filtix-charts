import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-preparation-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalPreparationHarness));
}

test('detached preparation and pre-start destruction make no provider or host callback calls', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalPreparationHarness.prepareThenDestroy());
  console.log('D2 prepare residual listeners', JSON.stringify(result.residualListeners));
  expect(result.beforeDestroy).toEqual({ history: 0, subscriptions: 0, events: 0 });
  expect(result.afterDestroy).toEqual({ history: 0, subscriptions: 0, events: 0 });
  expect(result.remainingOwnedResources).toBe(0);
  expect(result).toMatchObject({ listeners: 0, observers: 0, store: { destroyed: true } });
  expect(result.stateBefore.feed.status).toBe('idle');
  expect(result.finalDestroyed).toBe(true);
});

test('fourth partial constructor failure cleans the first three and failed chart without provider work', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalPreparationHarness.partialFourthFailure());
  console.log('D2 fourth-failure residual listeners', JSON.stringify(result.residualListeners));
  expect(result.failure).toMatch(/fourth feed construction fault/);
  expect(result).toMatchObject({
    charts: 0,
    sessions: 0,
    events: 0,
    children: 0,
    listeners: 0,
    observers: 0,
    history: 0,
    subscriptions: 0,
  });
});

test('ordinary public createTerminal still begins the initial feed immediately', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalPreparationHarness.immediatePublicStart());
  expect(result.immediately.history).toBe(1);
  expect(result.states).toBeGreaterThan(0);
  expect(result.final.subscriptions).toBe(0);
  expect(result.destroyed).toBe(true);
  expect(result.children).toBe(0);
});

test('prepared public mutations reject before start without provider work or host callbacks', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalPreparationHarness.preStartMutations());
  expect(result.rejected).toEqual([
    'correction',
    'history',
    'layout',
    'market',
    'restore',
    'retry',
    'settings',
    'study',
    'tool',
  ]);
  expect(result.beforeDestroy).toEqual({ history: 0, subscriptions: 0, subscribes: 0, events: 0 });
  expect(result.children).toBe(0);
});

test('prepared terminal adopts the exact C lease without second monitor attachment and preserves borrowed resources', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => (window as any).terminalPreparationHarness.adoptedLease());
  expect(result.preparedSnapshot.monitor).toMatchObject({ members: 1, leaseEntries: 1 });
  expect(result.preparedSnapshot.store.eventListeners).toBe(result.before.store.eventListeners);
  expect(result.preparedSnapshot.monitor.runtimeEntries).toBe(result.before.monitor.runtimeEntries);
  expect(result.preparedSnapshot.monitor.activeRuntimeEntries).toBe(
    result.before.monitor.activeRuntimeEntries,
  );
  expect(result.preparedSnapshot.history).toBe(result.before.history);
  expect(result.preparedSnapshot.subscribes).toBe(result.before.subscribes);
  expect(result.afterStart.monitor).toMatchObject({ members: 1, leaseEntries: 1 });
  expect(result.sameLease).toBe(true);
  expect(result.afterDestroy.monitor).toMatchObject({ destroyed: false, members: 0, leaseEntries: 0 });
  expect(result.afterDestroy.store.destroyed).toBe(false);
  expect(result.afterDestroy.store).toEqual(result.unattached.store);
  expect(result.afterDestroy.monitor).toEqual(result.unattached.monitor);
  expect(result.afterDestroy.children).toBe(0);
  expect(result.stillUsable).toMatch(/^borrowed:scope:/);
});

test('saved multi-market studies/layout/drawings initialize silently while borrowed alert state stays live', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() =>
    (window as any).terminalPreparationHarness.savedAndBorrowedWorkspace(),
  );
  expect(result.beforeStart.history).toBe(0);
  expect(result.beforeStart.subscriptions).toBe(0);
  expect(result.ownedSaved).toEqual(result.expected);
  expect(result.ownedSaved.studies).toHaveLength(1);
  expect(result.ownedSaved.layout.panes.some((pane: any) => pane.id === 'price')).toBe(true);
  expect(result.ownedSaved.markets).toHaveLength(2);
  expect(result.ownedSaved.markets[1].drawings.drawings).toHaveLength(1);
  expect(result.borrowedSaved.alerts.scopeId).toBe('borrowed:scope');
  expect(result.borrowedSaved.alerts.alerts).toHaveLength(1);
  expect(result.borrowedPrepared.store.eventListeners).toBe(result.borrowedBefore.store.eventListeners);
  expect(result.borrowedPrepared.monitor.members).toBe(result.borrowedBefore.monitor.members);
  expect(result.borrowedPrepared.monitor.leaseEntries).toBe(result.borrowedBefore.monitor.leaseEntries);
  expect(result.borrowedPrepared.monitor.runtimeEntries).toBe(result.borrowedBefore.monitor.runtimeEntries);
  expect(result.borrowedPrepared.history).toBe(result.borrowedBefore.history);
  expect(result.borrowedPrepared.subscribes).toBe(result.borrowedBefore.subscribes);
  expect(result.surviving.store).toEqual(result.borrowedBefore.store);
  expect(result.surviving.monitor).toEqual(result.borrowedBefore.monitor);
  expect(result.surviving.store.destroyed).toBe(false);
  expect(result.surviving.monitor.destroyed).toBe(false);
  expect(result.ownedChildren).toBe(0);
  expect(result.borrowedChildren).toBe(0);
});

test('synchronous start callback destruction fences obsolete history and stream handlers', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() =>
    (window as any).terminalPreparationHarness.synchronousDestroyAndObsoleteHistory(),
  );
  expect(result.afterDestroy.destroyed).toBe(true);
  expect(result.afterDestroy.children).toBe(0);
  expect(result.afterDestroy.subscriptions).toBe(0);
  expect(result.afterObsolete).toEqual(result.afterDestroy);
});

test('supplied C lease is exact and released when a synchronous start callback destroys the terminal', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() =>
    (window as any).terminalPreparationHarness.synchronousDestroyWithAdoptedLease(),
  );
  expect(result.tokenIdentity).toBe(true);
  expect(result.afterDestroy).toMatchObject({
    destroyed: true,
    children: 0,
    subscriptions: 0,
    monitor: { destroyed: false, members: 0, leaseEntries: 0 },
    store: { destroyed: false, eventListeners: 0 },
  });
  expect(result.afterObsolete).toMatchObject({
    destroyed: true,
    children: 0,
    subscriptions: 0,
    states: result.afterDestroy.states,
  });
  expect(result.usableRule).toMatch(/^borrowed:reentry:/);
});
