import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/terminal-grid-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalGridHarness));
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => (window as any).terminalGridHarness?.syncDestroy());
});

test('only populated current-query cells join; late hydration becomes eligible', async ({ page }) => {
  await ready(page);
  const before = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    await h.syncSetMarket('cell-2', { symbol: 'ETHUSDT', interval: '5m' });
    await h.syncSetMarket('cell-3', { symbol: 'SOLUSDT', interval: '1h' });
    h.syncSetActive('cell-3');
    return h.syncSetConfig({ viewport: true, crosshair: true });
  });
  expect(before.cells['cell-3'].feed.status).toBe('live');
  expect(before.cells['cell-3'].feed.bars).toBe(0);
  expect(before.cells['cell-3'].range).toBeNull();
  const hydrated = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    h.syncEmit({ symbol: 'SOLUSDT', interval: '1h' }, 1000, 700);
    await h.syncSettle();
    const firstReady = h.syncSnapshot();
    h.syncEmit({ symbol: 'SOLUSDT', interval: '1h' }, 3000, 701);
    h.syncEmit({ symbol: 'SOLUSDT', interval: '1h' }, 5000, 702);
    h.syncEmit({ symbol: 'SOLUSDT', interval: '1h' }, 7000, 703);
    await h.syncSettle();
    h.syncSetRange('cell-3', { from: 3000, to: 7000 });
    await h.syncSettle();
    return { firstReady, afterApi: h.syncSnapshot() };
  });
  expect(hydrated.firstReady.cells['cell-3'].feed.bars).toBe(1);
  expect(hydrated.firstReady.cells['cell-3'].range).toEqual({ from: 1000, to: 1000 });
  expect(hydrated.firstReady.cells['cell-1'].range).toEqual({ from: 1000, to: 2000 });
  expect(hydrated.firstReady.cells['cell-2'].range).toEqual({ from: 1000, to: 3000 });
  expect(hydrated.afterApi.cells['cell-3'].feed.bars).toBe(4);
  expect(hydrated.afterApi.cells['cell-1'].range).toEqual(hydrated.afterApi.cells['cell-3'].range);
  expect(hydrated.afterApi.cells['cell-2'].range).toEqual(hydrated.afterApi.cells['cell-3'].range);
});

test('pending market hydration excludes cleared old-query chart until new history is usable', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    h.syncSetConfig({ viewport: true, crosshair: false });
    const before = h.syncSnapshot();
    const pending = await h.syncBeginHeldMarket('cell-2', {
      symbol: 'ETHUSDT',
      interval: '5m',
    });
    const ready = await h.syncReleaseHeldMarket('cell-2');
    h.syncSetRange('cell-2', { from: 7000, to: 13000 });
    await h.syncSettle();
    return { before, pending, ready, afterApi: h.syncSnapshot() };
  });
  expect(result.pending.cells['cell-2'].query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
  expect(result.pending.cells['cell-2'].feed.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
  expect(result.pending.cells['cell-2'].feed.bars).toBe(0);
  expect(result.pending.cells['cell-2'].range).toBeNull();
  expect(result.pending.cells['cell-1'].range).toEqual(result.before.cells['cell-1'].range);
  expect(result.ready.cells['cell-2'].feed.bars).toBe(10);
  expect(result.afterApi.cells['cell-1'].range).toEqual(result.afterApi.cells['cell-2'].range);
});

test('active ready cell aligns on enable; feed movement cannot take over and parking releases charts', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    await h.syncSetMarket('cell-2', { symbol: 'ETHUSDT', interval: '5m' });
    h.syncSetRange('cell-1', { from: 3000, to: 9000 });
    h.syncSetRange('cell-2', { from: 7000, to: 13000 });
    await h.syncSettle();
    h.syncSetActive('cell-2');
    const aligned = h.syncSetConfig({ viewport: true, crosshair: false });
    h.syncSetActive('cell-1');
    const selected = h.syncSnapshot();
    h.syncFollowLatest('cell-1', true);
    h.syncPinLatest('cell-1');
    await h.syncSettle();
    const beforeFeed = h.syncSnapshot();
    h.syncEmit({ symbol: 'BTCUSDT', interval: '1m' }, 21000, 150);
    await h.syncSettle();
    const afterFeed = h.syncSnapshot();
    h.syncSetActive('cell-2');
    await h.syncSetLayout(1);
    const parked = h.syncSnapshot();
    await h.syncSetLayout(4);
    const remounted = h.syncSnapshot();
    const cleanup = h.syncDestroy();
    return { aligned, selected, beforeFeed, afterFeed, parked, remounted, cleanup };
  });
  expect(result.aligned.cells['cell-1'].range).toEqual(result.aligned.cells['cell-2'].range);
  expect(result.selected.cells['cell-2'].range).toEqual(result.aligned.cells['cell-2'].range);
  expect(result.afterFeed.cells['cell-1'].range).not.toEqual(result.beforeFeed.cells['cell-1'].range);
  expect(result.afterFeed.cells['cell-2'].range).toEqual(result.beforeFeed.cells['cell-2'].range);
  expect(result.parked.cells['cell-2']).toBeNull();
  expect(result.parked.state.activeCellId).toBe('cell-1');
  expect(
    result.parked.listeners
      .slice(1, 4)
      .every((item: any) => item.destroyedAt?.range === 0 && item.destroyedAt?.crosshair === 0),
  ).toBe(true);
  expect(result.remounted.cells['cell-2'].feed.bars).toBeGreaterThan(0);
  expect(result.cleanup.active).toBe(0);
  expect(
    result.cleanup.listeners.every(
      (item: any) => item.destroyedAt?.range === 0 && item.destroyedAt?.crosshair === 0,
    ),
  ).toBe(true);
});

test('retained bars stay synchronized through reconnect and backfill does not take over peers', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    await h.syncSetMarket('cell-2', { symbol: 'ADAUSDT', interval: '1d' });
    h.syncSetRange('cell-1', { from: 11000, to: 17000 });
    await h.syncSettle();
    h.syncSetConfig({ viewport: true, crosshair: false });
    const before = h.syncSnapshot();
    const closed = h.syncClose({ symbol: 'ADAUSDT', interval: '1d' });
    h.syncSetRange('cell-1', { from: 12000, to: 18000 });
    await h.syncSettle();
    const during = h.syncSnapshot();
    await h.syncWaitLive('cell-2');
    const backfilled = await h.syncLoadMore('cell-2');
    h.syncSetRange('cell-2', { from: 13000, to: 19000 });
    await h.syncSettle();
    const afterApi = h.syncSnapshot();
    return { before, closed, during, backfilled, afterApi };
  });
  expect(result.before.cells['cell-2'].feed.bars).toBe(20);
  expect(result.closed.cells['cell-2'].feed.bars).toBe(20);
  expect(result.during.cells['cell-2'].range).toEqual(result.during.cells['cell-1'].range);
  expect(result.backfilled.cells['cell-2'].feed.bars).toBe(29);
  expect(result.backfilled.cells['cell-1'].range).toEqual(result.during.cells['cell-1'].range);
  expect(result.afterApi.cells['cell-1'].range).toEqual(result.afterApi.cells['cell-2'].range);
});

test('restore rejects obsolete feed callbacks and rapid sync toggles retain current chart membership', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    h.syncSetConfig({ viewport: true, crosshair: true });
    const restored = await h.syncObsoleteAfterRestore();
    for (let index = 0; index < 20; index++)
      h.syncSetConfig({ viewport: index % 2 === 0, crosshair: index % 2 === 0 });
    h.syncSetConfig({ viewport: true, crosshair: true });
    h.syncSetRange('cell-1', { from: 7000, to: 13000 });
    await h.syncSettle();
    return { restored, afterToggle: h.syncSnapshot() };
  });
  expect(result.restored.after.cells['cell-1'].feed.bars).toBe(
    result.restored.before.cells['cell-1'].feed.bars,
  );
  expect(result.restored.after.cells['cell-1'].range).toEqual(result.restored.before.cells['cell-1'].range);
  expect(result.afterToggle.cells['cell-2'].range).toEqual(result.afterToggle.cells['cell-1'].range);
});

test('real-grid alignment callback can disable sync without retaining an obsolete group', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    return h.syncAlignmentReentry('disable');
  });
  expect(result.callbacks).toBe(1);
  expect(result.sync).toMatchObject({ viewport: false, crosshair: false });
  expect(result.after).toEqual(result.before);
});

test('real-grid destroy during initial alignment leaves no active feed or revived sync', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    return h.syncAlignmentReentry('destroy');
  });
  expect(result.callbacks).toBe(1);
  expect(result.destroyed).toBe(true);
  expect(result.provider.active).toBe(0);
  expect(
    result.listeners.every((item: any) => item.destroyedAt?.range === 0 && item.destroyedAt?.crosshair === 0),
  ).toBe(true);
});

for (const action of ['layout', 'restore'] as const) {
  test(`real-grid first alignment callback can request ${action} and retire old listeners`, async ({
    page,
  }) => {
    await ready(page);
    const result = await page.evaluate(async (requested) => {
      const h = (window as any).terminalGridHarness;
      await h.syncMount();
      const reentry = await h.syncAlignmentReentry(requested);
      return { reentry, cleanup: h.syncDestroy() };
    }, action);
    expect(result.reentry.callbacks).toBe(1);
    expect(result.reentry.state.layout).toBe(action === 'layout' ? 1 : 4);
    expect(result.reentry.provider.active).toBe(action === 'layout' ? 1 : 4);
    const retired = result.reentry.listeners.filter((item: any) => item.destroyedAt !== null);
    expect(retired).toHaveLength(action === 'layout' ? 3 : 4);
    expect(
      retired.every((item: any) => item.destroyedAt.range === 0 && item.destroyedAt.crosshair === 0),
    ).toBe(true);
    expect(result.cleanup.active).toBe(0);
    expect(
      result.cleanup.listeners.every(
        (item: any) => item.destroyedAt?.range === 0 && item.destroyedAt?.crosshair === 0,
      ),
    ).toBe(true);
  });
}

test('exact and nearest crosshair modes use target times and target prices across intervals', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).terminalGridHarness;
    await h.syncMount();
    await h.syncSetMarket('cell-2', { symbol: 'ETHUSDT', interval: '5m' });
    h.syncSetConfig({ viewport: false, crosshair: true, crosshairMatch: 'exact' });
    const exact = await h.syncCursor('cell-1', 'cell-2', 8000);
    h.syncSetConfig({ crosshairMatch: 'nearest' });
    const nearest = await h.syncCursor('cell-1', 'cell-2', 8000);
    return { exact, nearest };
  });
  expect(result.exact?.time).toBeNull();
  expect(result.nearest?.time).toBe(7000);
  expect(result.nearest?.point).toMatchObject({ time: 7000, close: 303 });
});
