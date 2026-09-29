import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}

test('unrelated rule refresh avoids rewriting unchanged native rows while actual edits remain visible', async ({
  page,
}) => {
  await ready(page);
  const ids = await page.evaluate(() => {
    const store = (window as any).terminalTestApi.terminal.getAlerts();
    return ['BTCUSDT', 'ETHUSDT'].map((symbol) =>
      store.add({
        query: { symbol, interval: '1m' },
        price: 1_000_000_000,
        condition: 'crosses-up',
        frequency: 'repeat',
        label: symbol,
      }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).terminalTestApi.terminal
          .getAlertState()
          .queries.every((entry: any) => entry.status === 'monitoring'),
      ),
    )
    .toBe(true);
  await page.locator('[data-terminal-alerts-toggle]').click();
  const unchanged = page.locator(`[data-terminal-alert-id="${ids[0]}"]`);
  await expect(unchanged).toBeVisible();
  const result = await page.evaluate(async (ruleIds) => {
    const api = (window as any).terminalTestApi;
    const row = document.querySelector(`[data-terminal-alert-id="${ruleIds[0]}"]`)!;
    let mutations = 0,
      writes = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(row, { subtree: true, childList: true, characterData: true, attributes: true });
    const fields = [...row.querySelectorAll('input,select')] as (HTMLInputElement | HTMLSelectElement)[];
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!;
      Object.defineProperty(field, 'value', {
        configurable: true,
        get() {
          return descriptor.get!.call(this);
        },
        set(value: string) {
          writes++;
          descriptor.set!.call(this, value);
        },
      });
    }
    try {
      for (const close of [101, 102, 103, 104])
        api.emitAlertBar({ symbol: 'BTCUSDT', interval: '1m' }, close);
      api.terminal.getAlerts().update(ruleIds[1], { label: 'Changed other rule' });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return {
        mutations,
        writes,
        rows: document.querySelectorAll('[data-terminal-alert-row]').length,
        dataTail: api.terminal.getData().at(-1).close,
        label: fields.find((field) => field.getAttribute('aria-label') === 'Alert label')!.value,
      };
    } finally {
      observer.disconnect();
      for (const field of fields) delete (field as unknown as { value?: string }).value;
    }
  }, ids);
  expect(result).toEqual({ mutations: 0, writes: 0, rows: 2, dataTail: 104, label: 'BTCUSDT' });
  await page.evaluate(
    (id) =>
      (window as any).terminalTestApi.terminal
        .getAlerts()
        .update(id, { price: 999_999_999, label: 'Changed own rule' }),
    ids[0],
  );
  await expect(unchanged.getByLabel('Alert threshold price')).toHaveValue('999999999');
  await expect(unchanged.getByLabel('Alert label')).toHaveValue('Changed own rule');
});

test('saved other-market rule fires while another market is displayed and persists in workspace v5', async ({
  page,
}) => {
  await ready(page);
  const query = { symbol: 'ETHUSDT', interval: '1m' };
  const id = await page.evaluate((market) => {
    const api = (window as any).terminalTestApi;
    api.clearAlertEvents();
    return api.terminal
      .getAlerts()
      .add({ query: market, price: 250, condition: 'crosses-up', frequency: 'once' });
  }, query);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).terminalTestApi.terminal
            .getAlertState()
            .queries.find((item: any) => item.query.symbol === 'ETHUSDT')?.status,
      ),
    )
    .toBe('monitoring');
  await page.evaluate((market) => {
    const api = (window as any).terminalTestApi;
    api.emitAlertBar(market, 249);
    api.emitAlertBar(market, 251);
  }, query);
  await expect.poll(() => page.evaluate(() => (window as any).terminalTestApi.alertEvents.length)).toBe(1);
  const result = await page.evaluate((ruleId) => {
    const api = (window as any).terminalTestApi;
    return { event: api.alertEvents[0], workspace: api.terminal.getWorkspace(), ruleId };
  }, id);
  expect(result.event).toMatchObject({ alertId: id, query, price: 251, occurrence: 1 });
  expect(result.workspace).toMatchObject({
    version: 5,
    alerts: { alerts: [{ id, status: 'triggered', triggerCount: 1 }] },
  });
  expect(result.workspace.query).toEqual({ symbol: 'BTCUSDT', interval: '1m' });
});

test('noncrossing alert updates leave saved rows untouched while closed and open, then crossing still updates them', async ({
  page,
}) => {
  await ready(page);
  const query = { symbol: 'ETHUSDT', interval: '5m' };
  const ruleId = await page.evaluate((market) => {
    const api = (window as any).terminalTestApi;
    api.clearAlertEvents();
    return api.terminal.getAlerts().add({
      query: market,
      price: 1_000_000_000,
      condition: 'crosses-up',
      frequency: 'once',
    });
  }, query);
  await expect
    .poll(() =>
      page.evaluate((market) => {
        const item = (window as any).terminalTestApi.terminal
          .getAlertState()
          .queries.find(
            (entry: any) => entry.query.symbol === market.symbol && entry.query.interval === market.interval,
          );
        return item?.status;
      }, query),
    )
    .toBe('monitoring');

  const toggle = page.locator('[data-terminal-alerts-toggle]');
  const panel = page.locator('[data-terminal-alerts-panel]');
  const row = page.locator(`[data-terminal-alert-id="${ruleId}"]`);
  await toggle.click();
  await expect(row).toBeVisible();
  const draft = row.getByLabel('Alert threshold price');
  await draft.fill('invalid saved draft');
  await draft.focus();
  await page.evaluate(() => {
    const rowElement = document.querySelector('[data-terminal-alert-row]')!;
    const state = { count: 0, observer: null as MutationObserver | null };
    state.observer = new MutationObserver((records) => {
      state.count += records.length;
    });
    state.observer.observe(rowElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    (window as any).__terminalAlertRowMutationState = state;
  });

  const emitAndSettle = async (closes: number[]): Promise<void> => {
    await page.evaluate(
      async ({ market, values }) => {
        const api = (window as any).terminalTestApi;
        for (const close of values) api.emitAlertBar(market, close);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      },
      { market: query, values: closes },
    );
  };
  const mutationCount = () =>
    page.evaluate(() => (window as any).__terminalAlertRowMutationState.count as number);
  const clearMutationCount = () =>
    page.evaluate(() => {
      const state = (window as any).__terminalAlertRowMutationState;
      state.observer.takeRecords();
      state.count = 0;
    });

  await emitAndSettle([101, 102, 103, 104]);
  expect(await mutationCount()).toBe(0);
  await expect(draft).toHaveValue('invalid saved draft');
  await expect(draft).toBeFocused();

  await toggle.click();
  await expect(panel).toBeHidden();
  await clearMutationCount();
  await emitAndSettle([105, 106, 107, 108]);
  expect(await mutationCount()).toBe(0);
  expect(await draft.inputValue()).toBe('invalid saved draft');

  await toggle.click();
  await expect(panel).toBeVisible();
  await draft.focus();
  await clearMutationCount();
  await emitAndSettle([109, 110, 111, 112]);
  expect(await mutationCount()).toBe(0);
  await expect(draft).toHaveValue('invalid saved draft');
  await expect(draft).toBeFocused();

  await emitAndSettle([999_999_999, 1_000_000_001]);
  await expect(row.locator('[data-terminal-alert-status]')).toContainText('triggered');
  await expect(draft).toHaveValue('invalid saved draft');
  await expect(draft).toBeFocused();
  expect(await mutationCount()).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const rule = (window as any).terminalTestApi.terminal
          .getAlerts()
          .list()
          .find((item: any) => item.id === id);
        return { status: rule?.status, triggerCount: rule?.triggerCount };
      }, ruleId),
    )
    .toEqual({ status: 'triggered', triggerCount: 1 });
  await expect.poll(() => page.evaluate(() => (window as any).terminalTestApi.alertEvents.length)).toBe(1);
  await page.evaluate(() => {
    (window as any).__terminalAlertRowMutationState.observer.disconnect();
    delete (window as any).__terminalAlertRowMutationState;
  });
});

test('native alert draft keeps invalid focused price through stream and chart market changes', async ({
  page,
}) => {
  await ready(page);
  await page.locator('[data-terminal-alerts-toggle]').click();
  const price = page.locator('[data-terminal-alert-price]');
  await price.fill('invalid price');
  await page.locator('[data-terminal-alert-add]').click();
  await expect(page.locator('[data-terminal-alert-error]')).toContainText(/price|finite|number/i);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.emitAlertBar({ symbol: 'BTCUSDT', interval: '1m' }, 123);
  });
  await page.evaluate(() =>
    (window as any).terminalTestApi.terminal.setMarket({ symbol: 'ETHUSDT', interval: '1m' }),
  );
  await expect(price).toHaveValue('invalid price');
  await expect(price).toBeFocused();
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getAlerts().list())).toEqual([]);
});

test('native controls create, edit, pause, rearm, and delete a saved other-market rule', async ({ page }) => {
  await ready(page);
  await page.locator('[data-terminal-alerts-toggle]').click();
  const form = page.locator('[data-terminal-alert-form]');
  await form.getByLabel('Alert instrument').selectOption('ETHUSDT');
  await form.getByLabel('Alert interval').selectOption('5m');
  await form.getByLabel('Alert threshold price').fill('250');
  await form.getByLabel('Alert direction').selectOption('crosses-down');
  await form.getByLabel('Alert frequency').selectOption('repeat');
  await form.getByLabel('Alert label').fill('Desk level');
  await form.locator('[data-terminal-alert-add]').click();
  const row = page.locator('[data-terminal-alert-row]');
  await expect(row).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getAlerts().list()[0]),
  ).toMatchObject({
    query: { symbol: 'ETHUSDT', interval: '5m' },
    price: 250,
    condition: 'crosses-down',
    frequency: 'repeat',
    label: 'Desk level',
  });
  await row.getByLabel('Alert threshold price').fill('245');
  await row.getByLabel('Alert label').fill('Revised level');
  await row.locator('[data-terminal-alert-save]').click();
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getAlerts().list()[0]),
  ).toMatchObject({ price: 245, label: 'Revised level' });
  await row.getByLabel('Alert label').fill('');
  await row.locator('[data-terminal-alert-save]').click();
  expect(
    await page.evaluate(() => (window as any).terminalTestApi.terminal.getAlerts().list()[0].label),
  ).toBe('');
  await row.locator('[data-terminal-alert-pause]').click();
  await expect(row.locator('[data-terminal-alert-status]')).toContainText('paused');
  await row.locator('[data-terminal-alert-pause]').click();
  await expect(row.locator('[data-terminal-alert-status]')).toContainText('armed');
  await row.locator('[data-terminal-alert-remove]').click();
  await expect(row).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getAlerts().list())).toEqual([]);
});

test('supplied alert store and monitor are independently borrowed across all four option combinations', async ({
  page,
}) => {
  await ready(page);
  for (const kind of ['neither', 'store', 'monitor', 'both'] as const) {
    const result = await page.evaluate((mode) => {
      const api = (window as any).terminalTestApi;
      api.remountWithAlertOwnership(mode);
      const store = api.terminal.getAlerts();
      const monitor = api.borrowedAlertMonitor ?? null;
      api.terminal.destroy();
      let storeWritable = true;
      try {
        store.add({
          query: { symbol: 'BTCUSDT', interval: '1m' },
          price: 0,
          condition: 'crosses',
          frequency: 'once',
        });
      } catch {
        storeWritable = false;
      }
      const monitorAlive = monitor ? !monitor.getState().destroyed : null;
      const final = api.terminal.getWorkspace();
      api.cleanupBorrowedAlerts();
      return { storeWritable, monitorAlive, finalVersion: final.version };
    }, kind);
    expect(result).toEqual({
      storeWritable: kind === 'store' || kind === 'both',
      monitorAlive: kind === 'monitor' || kind === 'both' ? true : null,
      finalVersion: 5,
    });
  }
});

test('alert option accessors are captured once for coherent ownership and constructor cleanup', async ({
  page,
}) => {
  await ready(page);
  for (const mode of ['stable-borrowed', 'first-borrowed', 'late-borrowed', 'absent'] as const) {
    const result = await page.evaluate(
      (value) => (window as any).terminalTestApi.constructorAlertGetterOwnership(value),
      mode,
    );
    expect(result.error).toBe('');
    expect(result.storeReads).toBe(1);
    expect(result.monitorReads).toBe(1);
    expect(result.selectedBorrowedStore).toBe(mode === 'stable-borrowed' || mode === 'first-borrowed');
    expect(result.borrowedMonitorQueries).toBe(
      mode === 'stable-borrowed' || mode === 'first-borrowed' ? 1 : 0,
    );
    expect(result.borrowedStoreUsable).toBe(true);
    expect(result.borrowedMonitorAlive).toBe(true);
    expect(result.subscriptionsAfter).toBe(result.subscriptionsBefore);
    expect(result.children).toBe(0);
  }
  for (const mode of ['stable-borrowed', 'late-borrowed'] as const) {
    const result = await page.evaluate(
      (value) => (window as any).terminalTestApi.constructorAlertGetterOwnership(value, true),
      mode,
    );
    expect(result.error).toMatch(/maxPageSize/i);
    expect(result.storeReads).toBe(1);
    expect(result.monitorReads).toBe(1);
    expect(result.borrowedStoreUsable).toBe(true);
    expect(result.borrowedMonitorAlive).toBe(true);
    expect(result.subscriptionsAfter).toBe(result.subscriptionsBefore);
    expect(result.children).toBe(0);
  }
});

test('alert editor stays inside a narrow 320px host in both palettes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await ready(page);
  await page.locator('[data-terminal-alerts-toggle]').click();
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(
      (value) => (window as any).terminalTestApi.terminal.applySettings({ theme: value }),
      theme,
    );
    const bounds = await page.locator('[data-terminal-alerts-panel]').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  }
});

test('detached alert controls cannot edit a surviving borrowed store after terminal destruction', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.remountWithAlertOwnership('store');
    const store = api.terminal.getAlerts();
    store.add({
      query: { symbol: 'BTCUSDT', interval: '1m' },
      price: 10,
      condition: 'crosses-up',
      frequency: 'once',
    });
    (document.querySelector('[data-terminal-alerts-toggle]') as HTMLButtonElement).click();
    const row = document.querySelector('[data-terminal-alert-row]')!;
    const staleDelete = row.querySelector<HTMLButtonElement>('[data-terminal-alert-remove]')!;
    const staleSave = row.querySelector<HTMLButtonElement>('[data-terminal-alert-save]')!;
    (row.querySelector('[data-terminal-alert-price]') as HTMLInputElement).value = '99';
    api.terminal.destroy();
    staleSave.click();
    staleDelete.click();
    const after = store.list();
    api.cleanupBorrowedAlerts();
    return after;
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ price: 10 });
});

for (const action of ['destroy', 'restore'] as const) {
  test(`earlier borrowed-store observer sees coherent restore before nested ${action}`, async ({ page }) => {
    await ready(page);
    const result = await page.evaluate(async (nestedAction) => {
      const api = (window as any).terminalTestApi;
      api.remountWithEarlyBorrowedAlertObserver();
      const store = api.terminal.getAlerts();
      store.add({
        query: { symbol: 'ETHUSDT', interval: '5m' },
        price: 10,
        condition: 'crosses-up',
        frequency: 'once',
      });
      const next = api.terminal.getWorkspace();
      next.alerts.alerts[0].price = 20;
      next.query = { symbol: 'ETHUSDT', interval: '5m' };
      next.markets.push({ query: { ...next.query }, drawings: structuredClone(next.markets[0].drawings) });
      api.armEarlyBorrowedAlertObserver(nestedAction);
      await api.terminal.restoreWorkspace(next);
      await api.earlyAlertNested;
      const observed = api.earlyAlertObservations;
      const final = api.terminal.getWorkspace();
      const feed = api.terminal.getState().feed;
      api.cleanupBorrowedAlerts();
      return { observed, final, feed };
    }, action);
    expect(result.observed).toHaveLength(1);
    expect(result.observed[0].workspace.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
    expect(result.observed[0].workspace.alerts.alerts[0].price).toBe(20);
    expect(result.observed[0].store.alerts[0].price).toBe(20);
    expect(result.final.alerts.alerts[0].price).toBe(20);
    expect(result.final.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
    if (action === 'destroy') expect(result.feed.status).toBe('destroyed');
    else {
      expect(result.final.settings.theme).toBe('light');
      expect(result.feed.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
    }
  });
}

test('borrowed scope mismatch rejects before changing terminal, store, or attached monitor', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    api.remountWithAlertOwnership('store');
    const store = api.terminal.getAlerts();
    const before = api.terminal.getWorkspace();
    const monitorBefore = api.terminal.getAlertState();
    const different = structuredClone(before);
    different.alerts.scopeId = 'different-scope';
    let error = '';
    try {
      await api.terminal.restoreWorkspace(different);
    } catch (problem) {
      error = String(problem);
    }
    const after = api.terminal.getWorkspace();
    const monitorAfter = api.terminal.getAlertState();
    api.terminal.destroy();
    api.cleanupBorrowedAlerts();
    return {
      error,
      before,
      after,
      monitorBefore,
      monitorAfter,
      sameStore: store === api.terminal.getAlerts(),
    };
  });
  expect(result.error).toMatch(/identity does not match context/i);
  expect(result.after).toEqual(result.before);
  expect(result.monitorAfter).toEqual(result.monitorBefore);
  expect(result.sameStore).toBe(true);
});

test('owned alert scope replacement adopts a new store and releases the obsolete attachment', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi;
    const oldStore = api.terminal.getAlerts();
    const next = api.terminal.getWorkspace();
    next.alerts.scopeId = 'restored-owner-scope';
    await api.terminal.restoreWorkspace(next);
    return {
      sameStore: api.terminal.getAlerts() === oldStore,
      workspace: api.terminal.getWorkspace(),
      state: api.terminal.getAlertState(),
      oldDestroyed: (() => {
        try {
          oldStore.add({
            query: { symbol: 'BTCUSDT', interval: '1m' },
            price: 1,
            condition: 'crosses',
            frequency: 'once',
          });
          return false;
        } catch {
          return true;
        }
      })(),
    };
  });
  expect(result.sameStore).toBe(false);
  expect(result.workspace.alerts.scopeId).toBe('restored-owner-scope');
  expect(result.oldDestroyed).toBe(true);
  expect(result.state.destroyed).toBe(false);
});
