import { expect, test, type Page } from '@playwright/test';
async function ready(page: Page) {
  await page.goto('/terminal-test.html');
  await page.waitForFunction(() => Boolean((window as any).terminalTestApi));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
}
test('public canonical v4 API validates atomically, controls editor, resets defensively and caches after destroy', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal,
      initial = t.getWorkspace();
    t.applyLayout({ panes: [{ id: 'price', weight: 2 }], studiesOpen: true });
    const committed = t.getWorkspace(),
      open = !document.querySelector<HTMLElement>('[data-terminal-studies-panel]')!.hidden;
    let rejected = false;
    try {
      await t.restoreWorkspace({
        ...committed,
        layout: {
          ...committed.layout,
          panes: [...committed.layout.panes, { id: 'foreign', weight: 1, minHeight: 48 }],
        },
      });
    } catch {
      rejected = true;
    }
    const unchanged = JSON.stringify(t.getWorkspace()) === JSON.stringify(committed);
    const copy = t.getLayout();
    copy.panes[0].weight = 999;
    const defensive = t.getLayout().panes[0].weight;
    t.resetLayout();
    const reset = t.getLayout();
    t.destroy();
    const cached = t.getLayout();
    let deadReject = false;
    try {
      t.resetLayout();
    } catch {
      deadReject = true;
    }
    return { initial, committed, open, rejected, unchanged, defensive, reset, cached, deadReject };
  });
  expect(result.initial.version).toBe(5);
  expect(result.committed.layout.panes[0].weight).toBe(2);
  expect(result.open).toBe(true);
  expect(result.rejected).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.defensive).toBe(2);
  expect(result.reset).toEqual(result.initial.layout);
  expect(result.cached).toEqual(result.reset);
  expect(result.deadReject).toBe(true);
});
test('native committed geometry is synchronous and terminal layout operations preserve runtime resources', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    const id = t.addStudy({ kind: 'rsi', period: 3 });
    await t.chart.whenIdle();
    const before = t.chart.getPaneLayout(),
      layout = t.getLayout();
    const counts = api.studyCalculatorCounts();
    const reads = api.feedDataReads?.();
    const range = t.chart.getVisibleRange();
    let seen: any = null;
    const unsub = t.chart.subscribePaneLayoutChange(() => {
      seen = t.getWorkspace().layout;
    });
    t.chart.resizePane('price', 20);
    const native = t.getLayout();
    for (let i = 0; i < 5; i++) {
      t.applyLayout({ panes: [{ id: 'price', weight: i + 2 }], maximizedPaneId: 'terminal-' + id + '-pane' });
      t.applyLayout({ maximizedPaneId: null });
      t.resetLayout();
    }
    unsub();
    return {
      before,
      after: t.chart.getPaneLayout(),
      layout,
      native,
      seen,
      range,
      afterRange: t.chart.getVisibleRange(),
      counts,
      afterCounts: api.studyCalculatorCounts(),
      reads,
      afterReads: api.feedDataReads?.(),
    };
  });
  expect(result.native.panes[0].weight).not.toBe(result.layout.panes[0].weight);
  expect(result.seen).not.toBeNull();
  expect(result.afterRange).toEqual(result.range);
  expect(result.afterCounts).toEqual(result.counts);
  expect(result.afterReads).toEqual(result.reads);
});
test('hidden oscillator preferences survive recreation and maximize clears with coherent composition', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const t = (window as any).terminalTestApi.terminal,
      id = t.addStudy({ kind: 'rsi', period: 3 }),
      paneId = 'terminal-' + id + '-pane';
    t.applyLayout({ panes: [{ id: paneId, weight: 2.5, minHeight: 123 }], maximizedPaneId: paneId });
    t.updateStudy(id, { visible: false });
    const hidden = t.getLayout();
    t.updateStudy(id, { visible: true });
    const visible = t.chart.getPaneLayout();
    await t.setMarket({ symbol: 'ETHUSDT', interval: '1m' });
    const market = t.getLayout();
    t.applySettings({ volume: false });
    t.applySettings({ volume: true });
    const toggled = t.getLayout();
    const toggledPhysical = t.chart.getPaneLayout().panes.map((pane: any) => pane.id);
    t.removeStudy(id);
    return { paneId, hidden, visible, market, toggled, toggledPhysical, removed: t.getLayout() };
  });
  expect(result.hidden.maximizedPaneId).toBeNull();
  expect(result.hidden.panes.find((p: any) => p.id === result.paneId)).toMatchObject({
    weight: 2.5,
    minHeight: 123,
  });
  expect(result.visible.panes.find((p: any) => p.id === result.paneId)).toMatchObject({
    weight: 2.5,
    minHeight: 123,
  });
  expect(result.market).toEqual(result.hidden);
  expect(result.toggled).toEqual(result.hidden);
  expect(result.toggledPhysical).toEqual(['price', 'terminal-volume-pane', result.paneId]);
  expect(result.removed.panes).toHaveLength(2);
});

for (const route of ['API', 'native', 'restore'] as const) {
  test(
    'volume enable preserves physical registry order and live study resources through ' + route,
    async ({ page }) => {
      await ready(page);
      const before = await page.evaluate(async () => {
        const api = (window as any).terminalTestApi,
          t = api.terminal;
        t.addStudy({ kind: 'rsi', period: 3 });
        t.addStudy({ kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2, visible: false });
        t.addStudy({ kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 });
        t.applyLayout({
          panes: [
            { id: 'terminal-volume-pane', weight: 0.7, minHeight: 99 },
            { id: 'terminal-study-1-pane', weight: 0.8, minHeight: 101 },
            { id: 'terminal-study-2-pane', weight: 0.9, minHeight: 102 },
            { id: 'terminal-study-3-pane', weight: 1.1, minHeight: 103 },
          ],
          maximizedPaneId: 'terminal-study-3-pane',
        });
        const caller = t.chart.addPane({ id: 'caller-volume-order', weight: 0.4, minHeight: 49.5 });
        const series = t.chart.addSeries('line', { id: 'caller-volume-order-series', paneId: caller.id });
        series.setData([{ time: t.getData().at(-1).time, value: 77 }]);
        return {
          workspace: t.getWorkspace(),
          bars: t.getData(),
          points: await api.pointsAt(t.getData().at(-1).time),
          resources: api.geometryCalls(),
          calculators: api.studyCalculatorCounts(),
          requests: api.historyRequests(),
          range: t.chart.getVisibleRange(),
        };
      });
      if (route === 'native') {
        await page.getByRole('checkbox', { name: 'Show volume', exact: true }).uncheck();
        await page.getByRole('checkbox', { name: 'Show volume', exact: true }).check();
      } else
        await page.evaluate(
          async ({ route, workspace }) => {
            const t = (window as any).terminalTestApi.terminal;
            t.applySettings({ volume: false });
            if (route === 'restore') await t.restoreWorkspace(workspace);
            else t.applySettings({ volume: true });
          },
          { route, workspace: before.workspace },
        );
      const after = await page.evaluate(async () => {
        const api = (window as any).terminalTestApi,
          t = api.terminal;
        const tail = t.getData().at(-1);
        const result = {
          workspace: t.getWorkspace(),
          bars: t.getData(),
          points: await api.pointsAt(tail.time),
          panes: t.chart.getPaneLayout().panes,
          resources: api.geometryCalls(),
          calculators: api.studyCalculatorCounts(),
          requests: api.historyRequests(),
          range: t.chart.getVisibleRange(),
          error: t.getState().error,
        };
        api.reviseTail(222, 45);
        const updated = await api.pointsAt(tail.time);
        t.updateStudy('study-2', { visible: true });
        return { ...result, updated, shown: t.chart.getPaneLayout().panes, finalLayout: t.getLayout() };
      });
      expect(after.panes.filter((p: any) => p.id !== 'caller-volume-order').map((p: any) => p.id)).toEqual([
        'price',
        'terminal-volume-pane',
        'terminal-study-1-pane',
        'terminal-study-3-pane',
      ]);
      expect(after.shown.filter((p: any) => p.id !== 'caller-volume-order').map((p: any) => p.id)).toEqual([
        'price',
        'terminal-volume-pane',
        'terminal-study-1-pane',
        'terminal-study-2-pane',
        'terminal-study-3-pane',
      ]);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.bars).toEqual(before.bars);
      expect(after.points).toEqual(before.points);
      expect(after.panes.find((p: any) => p.id === 'caller-volume-order')).toMatchObject({
        weight: 0.4,
        minHeight: 49.5,
      });
      for (const pane of before.workspace.layout.panes) {
        expect(after.finalLayout.panes.find((p: any) => p.id === pane.id)).toEqual(pane);
        const physical = after.panes.find((p: any) => p.id === pane.id);
        if (physical) expect(physical).toMatchObject(pane);
      }
      expect(after.workspace.layout.maximizedPaneId).toBe('terminal-study-3-pane');
      expect(after.calculators).toEqual(before.calculators);
      expect(after.resources.addSeries - before.resources.addSeries).toBe(1);
      expect(after.resources.removeSeries - before.resources.removeSeries).toBe(1);
      expect(after.resources.seriesSetData - before.resources.seriesSetData).toBe(1);
      expect(after.requests).toBe(before.requests);
      expect(after.range).toEqual(before.range);
      expect(after.error).toBeNull();
      expect(after.updated['terminal-price'].close).toBe(222);
      expect(after.updated['terminal-volume'].value).toBe(45);
      expect(after.updated['terminal-study-1'].value).toEqual(expect.any(Number));
      expect(after.updated['terminal-study-3-macd'].value).toEqual(expect.any(Number));
      expect(after.updated['caller-volume-order-series'].value).toBe(77);
    },
  );
}

for (const intervention of ['remove', 'market', 'failure'] as const) {
  test(
    'volume order reconciliation fences ' + intervention + ' during actual oscillator recreation',
    async ({ page }) => {
      await ready(page);
      const value = await page.evaluate(async (intervention) => {
        const api = (window as any).terminalTestApi,
          t = api.terminal;
        t.addStudy({ kind: 'rsi', period: 3 });
        t.addStudy({ kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 });
        t.applySettings({ volume: false });
        const before = t.getWorkspace();
        let fired = false,
          pending = Promise.resolve();
        const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
          const ids = snapshot.panes.map((p: any) => p.id);
          if (!fired && ids.includes('terminal-volume-pane') && !ids.includes('terminal-study-1-pane')) {
            fired = true;
            if (intervention === 'remove') t.removeStudy('study-2');
            else if (intervention === 'market') pending = t.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
            else api.failNextPane('terminal-study-1-pane');
          }
        });
        let error = '';
        try {
          t.applySettings({ volume: true });
        } catch (cause) {
          error = String(cause);
        }
        un();
        await pending;
        const state = t.getState(),
          workspace = t.getWorkspace(),
          panes = t.chart.getPaneLayout().panes.map((p: any) => p.id),
          series = t.chart.getDiagnostics().seriesCount;
        if (intervention === 'failure') await t.retry();
        return {
          fired,
          error,
          before,
          state,
          workspace,
          panes,
          series,
          recovered: t.getState(),
          points: await api.pointsAt(t.getData().at(-1).time),
        };
      }, intervention);
      expect(value.fired).toBe(true);
      expect(value.error).toMatch(intervention === 'failure' ? /fixture repair pane failure/ : /superseded/i);
      expect(value.workspace.settings.volume).toBe(false);
      expect(value.workspace.studies.map((s: any) => s.id)).toEqual(
        intervention === 'remove' ? ['terminal-ema', 'study-1'] : ['terminal-ema', 'study-1', 'study-2'],
      );
      expect(value.panes).toEqual(
        intervention === 'remove'
          ? ['price', 'terminal-study-1-pane']
          : ['price', 'terminal-study-1-pane', 'terminal-study-2-pane'],
      );
      expect(value.series).toBe(intervention === 'remove' ? 3 : 6);
      expect(value.state.feed.query).toEqual(value.workspace.query);
      expect(value.workspace.query.symbol).toBe(intervention === 'market' ? 'ETHUSDT' : 'BTCUSDT');
      if (intervention === 'failure') expect(value.state.error).toMatch(/fixture repair pane failure/);
      expect(value.recovered.error).toBeNull();
      expect(value.points['terminal-study-1'].value).toEqual(expect.any(Number));
      if (intervention !== 'remove')
        expect(value.points['terminal-study-2-macd'].value).toEqual(expect.any(Number));
    },
  );
}

test('changed-market restore enabling volume preserves oscillator order and canonical geometry', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    t.addStudy({ kind: 'rsi', period: 3 });
    t.addStudy({ kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 });
    t.applyLayout({
      panes: [
        { id: 'terminal-volume-pane', weight: 0.7, minHeight: 91 },
        { id: 'terminal-study-2-pane', weight: 0.9, minHeight: 92 },
      ],
      maximizedPaneId: 'terminal-study-2-pane',
    });
    t.applySettings({ volume: false });
    const target = api.workspaceFor({ symbol: 'ETHUSDT', interval: '5m' }, {});
    target.settings.volume = true;
    const previousIds = t.getStudies().map((s: any) => s.id);
    await t.restoreWorkspace(target);
    return {
      target,
      previousIds,
      state: t.getState(),
      workspace: t.getWorkspace(),
      effective: t.chart.getPaneLayout(),
      points: await api.pointsAt(t.getData().at(-1).time),
      tail: t.getData().at(-1),
    };
  });
  expect(value.effective.panes.map((p: any) => p.id)).toEqual([
    'price',
    'terminal-volume-pane',
    'terminal-study-1-pane',
    'terminal-study-2-pane',
  ]);
  expect(value.workspace.studies.map((s: any) => s.id)).toEqual(value.previousIds);
  expect(value.workspace.layout).toEqual(value.target.layout);
  expect(value.effective.maximizedPaneId).toBe('terminal-study-2-pane');
  for (const pane of value.workspace.layout.panes)
    expect(value.effective.panes.find((p: any) => p.id === pane.id)).toMatchObject(pane);
  expect(value.state.feed.query).toEqual(value.workspace.query);
  expect(value.workspace.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
  expect(value.state.error).toBeNull();
  expect(value.points['terminal-price'].close).toBe(value.tail.close);
  expect(value.points['terminal-volume'].value).toBe(value.tail.volume);
  expect(value.points['terminal-study-1'].value).toEqual(expect.any(Number));
  expect(value.points['terminal-study-2-macd'].value).toEqual(expect.any(Number));
});

test('mixed external deltas preserve unsupported effective fields until terminal reconciliation', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const t = (window as any).terminalTestApi.terminal,
      foreign = t.chart.addPane({ id: 'caller', weight: 7, minHeight: 42.5 });
    t.chart.applyPaneLayout({
      panes: [{ id: 'price', weight: 3, minHeight: 42.5 }],
      maximizedPaneId: 'caller',
    });
    const external = { canonical: t.getLayout(), effective: t.chart.getPaneLayout() };
    t.resetLayout();
    return { external, reset: t.chart.getPaneLayout() };
  });
  expect(result.external.canonical.panes[0]).toEqual({ id: 'price', weight: 3, minHeight: 160 });
  expect(result.external.canonical.maximizedPaneId).toBeNull();
  expect(result.external.effective.panes[0].minHeight).toBe(42.5);
  expect(result.external.effective.maximizedPaneId).toBe('caller');
  expect(result.reset.panes.find((p: any) => p.id === 'caller')).toEqual({
    id: 'caller',
    weight: 7,
    minHeight: 42.5,
  });
  expect(result.reset.maximizedPaneId).toBeNull();
});
test('external observer edits during own pane creation supersede safely without dropping layout deltas or leaking resources', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    let armed = true;
    const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
      if (armed && snapshot.panes.some((p: any) => p.id === 'terminal-study-1-pane')) {
        armed = false;
        t.chart.applyPaneLayout({ panes: [{ id: 'price', weight: 4 }] });
      }
    });
    let failure = '';
    try {
      t.addStudy({ kind: 'rsi', period: 3 });
    } catch (e) {
      failure = String(e);
    }
    un();
    const workspace = t.getWorkspace(),
      effective = t.chart.getPaneLayout(),
      resources = t.chart.getDiagnostics();
    const id = t.addStudy({ kind: 'rsi', period: 4 });
    return { failure, workspace, effective, resources, id, final: t.getWorkspace() };
  });
  expect(result.workspace.layout.panes[0].weight).toBe(4);
  expect(result.workspace.studies).toHaveLength(1);
  expect(result.effective.panes.map((p: any) => p.id)).toEqual(['price', 'terminal-volume-pane']);
  expect(result.resources.seriesCount).toBe(3);
  expect(result.id).toBe('study-1');
  expect(result.final.layout.panes[0].weight).toBe(4);
});

test('geometry never reads retained history or rebuilds live resources and maximized studies still update', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const api = (window as any).terminalTestApi;
    api.remountWithStudies([
      { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
      { kind: 'rsi', period: 3 },
    ]);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
    .toBe('live');
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    await t.chart.whenIdle();
    const resources = api.geometryCalls(),
      calcs = api.studyCalculatorCounts(),
      range = t.chart.getVisibleRange(),
      diagnostics = t.chart.getDiagnostics();
    api.setGeometryOnly(true);
    try {
      for (let i = 0; i < 12; i++) {
        t.applyLayout({ panes: [{ id: 'price', weight: i + 2 }], maximizedPaneId: 'terminal-study-1-pane' });
        t.applyLayout({ maximizedPaneId: null });
        t.chart.resizePane('price', i % 2 ? 10 : -10);
        t.resetLayout();
      }
      t.applyLayout({ maximizedPaneId: 'price' });
      api.reviseTail(222, 45);
      await t.chart.whenIdle();
    } finally {
      api.setGeometryOnly(false);
    }
    const finalCalcs = api.studyCalculatorCounts();
    t.applyLayout({ maximizedPaneId: null });
    return {
      resources,
      afterResources: api.geometryCalls(),
      calcs,
      finalCalcs,
      range,
      afterRange: t.chart.getVisibleRange(),
      diagnostics,
      afterDiagnostics: t.chart.getDiagnostics(),
      tail: await api.pointsAt(t.getData().at(-1).time),
      error: t.getState().error,
    };
  });
  expect(result.afterResources).toEqual(result.resources);
  expect(result.finalCalcs.create).toBe(result.calcs.create);
  expect(result.finalCalcs.setData).toBe(result.calcs.setData);
  expect(result.finalCalcs.getData).toBe(result.calcs.getData);
  expect(result.finalCalcs.update).toBeGreaterThan(result.calcs.update);
  expect(result.afterRange).toEqual(result.range);
  expect(result.afterDiagnostics.seriesCount).toBe(result.diagnostics.seriesCount);
  expect(result.tail['terminal-price'].close).toBe(222);
  expect(result.tail['terminal-study-2']).not.toBeNull();
  expect(result.error).toBeNull();
});
test('derived price focus does not become canonical during external weight-only changes', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(() => (window as any).terminalTestApi.derivedLayoutBridge());
  expect(value.result.canonical.maximizedPaneId).toBeNull();
  expect(value.result.canonical.panes[0].weight).toBe(2);
  expect(value.result.effective.maximizedPaneId).toBe('price');
  expect(value.restored.maximizedPaneId).toBeNull();
});
test('onState layout reset, remove, restore and destroy supersede safely with coherent defensive snapshots', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    const id = t.addStudy({ kind: 'rsi', period: 3 }),
      initial = t.getWorkspace();
    api.armLayoutObserver('reset');
    t.applyLayout({ panes: [{ id: 'price', weight: 2 }] });
    const reset = t.getLayout();
    api.armLayoutObserver('remove', id);
    t.applyLayout({ maximizedPaneId: 'terminal-' + id + '-pane' });
    const removed = t.getWorkspace();
    api.armLayoutObserver('restore', initial);
    t.applyLayout({ panes: [{ id: 'price', weight: 3 }] });
    await api.waitObserverAction();
    const restored = t.getWorkspace();
    api.armLayoutObserver('destroy');
    t.applyLayout({ studiesOpen: true });
    return {
      initial,
      reset,
      removed,
      restored,
      cached: t.getLayout(),
      state: t.getState(),
      subscriptions: api.activeSubscriptions(),
    };
  });
  expect(result.reset).toEqual(result.initial.layout);
  expect(result.removed.layout.maximizedPaneId).toBeNull();
  expect(result.removed.layout.panes).toHaveLength(2);
  expect(result.restored).toEqual(result.initial);
  expect(result.cached.studiesOpen).toBe(true);
  expect(result.state.layout).toEqual(result.cached);
  expect(result.state.destroyed).toBe(true);
  expect(result.subscriptions).toBe(0);
});
test('streaming and late invalid restore preserve a separator preview; release synchronously persists once', async ({
  page,
}) => {
  await ready(page);
  const separator = page.getByRole('separator').first(),
    box = await separator.boundingBox();
  const before = await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout());
  const initialHeight = Number(await separator.getAttribute('aria-valuenow'));
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 35);
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuenow')))
    .not.toBe(initialHeight);
  const preview = Number(await separator.getAttribute('aria-valuenow'));
  const middle = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    const doc = t.getWorkspace();
    doc.layout.panes[1].weight = 0;
    let rejected = false;
    try {
      await t.restoreWorkspace(doc);
    } catch {
      rejected = true;
    }
    api.reviseTail(220, 40);
    await t.chart.whenIdle();
    return { rejected, layout: t.getLayout() };
  });
  expect(middle.rejected).toBe(true);
  expect(middle.layout).toEqual(before);
  expect(Number(await separator.getAttribute('aria-valuenow'))).toBeCloseTo(preview, 4);
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const t = (window as any).terminalTestApi.terminal;
    return { layout: t.getLayout(), workspace: t.getWorkspace().layout };
  });
  expect(after.layout.panes[0].weight).not.toBe(before.panes[0].weight);
  expect(after.workspace).toEqual(after.layout);
});

test('explicit canonical no-op reconciles unsupported effective values and caller adjacent resizing stays private', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const t = (window as any).terminalTestApi.terminal;
    t.chart.addPane({ id: 'caller', weight: 7, minHeight: 50 });
    t.chart.applyPaneLayout({ panes: [{ id: 'price', minHeight: 42.5 }], maximizedPaneId: 'caller' });
    t.resetLayout();
    const reset = t.chart.getPaneLayout();
    t.chart.resizePane('terminal-volume-pane', 20);
    const resized = t.chart.getPaneLayout(),
      canonical = t.getLayout();
    return { reset, resized, canonical };
  });
  expect(result.reset.panes[0].minHeight).toBe(160);
  expect(result.reset.maximizedPaneId).toBeNull();
  expect(result.canonical.panes).toHaveLength(2);
  expect(result.resized.panes[2].weight).not.toBe(7);
  expect(result.canonical.panes[1].weight).toBe(result.resized.panes[1].weight);
});
test('valid same-ID RSI to MACD restore preserves layout and old version shapes remain strict', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal,
      id = t.addStudy({ kind: 'rsi', period: 3 });
    t.applyLayout({
      panes: [{ id: 'terminal-' + id + '-pane', weight: 2, minHeight: 120 }],
      maximizedPaneId: 'terminal-' + id + '-pane',
    });
    const workspace = t.getWorkspace();
    workspace.studies = workspace.studies.map((s: any) =>
      s.id === id
        ? {
            id,
            kind: 'macd',
            fastPeriod: 2,
            slowPeriod: 3,
            signalPeriod: 2,
            color: '#7aa2f7',
            signalColor: '#e0af68',
            positiveColor: '#73c991',
            negativeColor: '#ef7c8e',
            lineWidth: 2,
            visible: true,
          }
        : s,
    );
    await t.restoreWorkspace(workspace);
    const restored = t.getWorkspace(),
      effective = t.chart.getPaneLayout();
    const legacy = { ...restored, version: 3 };
    delete legacy.layout;
    delete legacy.alerts;
    await t.restoreWorkspace(legacy);
    return { restored, effective, migrated: t.getWorkspace(), series: t.chart.getDiagnostics().seriesCount };
  });
  expect(value.restored.layout.panes[2]).toMatchObject({ weight: 2, minHeight: 120 });
  expect(value.effective.panes[2]).toEqual(value.restored.layout.panes[2]);
  expect(value.effective.maximizedPaneId).toBe(value.restored.layout.maximizedPaneId);
  expect(value.migrated.layout.panes[2]).toMatchObject({ weight: 0.3, minHeight: 72 });
  expect(value.migrated.layout.maximizedPaneId).toBeNull();
  expect(value.migrated.version).toBe(5);
  expect(value.series).toBe(6);
});
test('caller exceptions and unsubscription cannot disrupt synchronous canonical native commits', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(() => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    let removedCalls = 0;
    const values: any[] = [];
    let remove = () => {};
    const un = t.chart.subscribePaneLayoutChange(() => {
      remove();
      throw new Error('caller');
    });
    remove = t.chart.subscribePaneLayoutChange(() => removedCalls++);
    const last = t.chart.subscribePaneLayoutChange(() => values.push(t.getLayout()));
    t.chart.resizePane('price', 18);
    const workspace = t.getWorkspace();
    un();
    last();
    remove();
    return { removedCalls, values, workspace };
  });
  expect(value.removedCalls).toBe(0);
  expect(value.values).toEqual([value.workspace.layout]);
});

test('hostile constructor, patch and full restore inputs reject before DOM, transport, allocator and notifications', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal,
      before = t.getWorkspace(),
      markup = document.querySelector('[data-filtix-terminal]')!.innerHTML,
      notifications = api.observedStates.length,
      history = api.historyRequests(),
      resources = api.geometryCalls(),
      reads = api.feedDataReads();
    const proto = Object.defineProperty({}, '__proto__', { value: true, enumerable: true });
    const invalid: any[] = [
      undefined,
      null,
      {
        panes: [
          { id: 'price', weight: 2 },
          { id: 'terminal-volume-pane', minHeight: 23 },
        ],
      },
      { panes: [Object.create({ id: 'price', weight: 2 })] },
      { panes: [{ id: 'price', weight: undefined }] },
      { panes: [{ id: 'price', weight: null }] },
      { panes: [{ id: 'price', minHeight: 24.5 }] },
      { panes: [{ id: 'foreign', weight: 1 }] },
      { panes: [{ id: 'price' }, { id: 'price' }] },
      proto,
      { [Symbol('bad')]: true },
      { studiesOpen: undefined },
      { maximizedPaneId: undefined },
    ];
    const errors: string[] = [];
    const constructors: any[] = [];
    api.setGeometryOnly(true);
    try {
      for (const value of invalid) {
        constructors.push(api.constructorLayout(value));
        try {
          t.applyLayout(value);
          errors.push('accepted');
        } catch (e) {
          errors.push(String(e));
        }
      }
      const docs: any[] = [
        { ...before, layout: undefined },
        { ...before, layout: Object.create(before.layout) },
        { ...before, layout: { ...before.layout, panes: before.layout.panes.slice(1) } },
        {
          ...before,
          layout: {
            ...before.layout,
            panes: [...before.layout.panes, { id: 'foreign', weight: 1, minHeight: 48 }],
          },
        },
        {
          ...before,
          markets: [
            { ...before.markets[0], drawings: { ...before.markets[0].drawings, drawings: [{ bad: true }] } },
          ],
        },
      ];
      for (const value of docs) {
        try {
          await t.restoreWorkspace(value);
          errors.push('accepted');
        } catch (e) {
          errors.push(String(e));
        }
      }
    } finally {
      api.setGeometryOnly(false);
    }
    const after = {
      workspace: t.getWorkspace(),
      markup: document.querySelector('[data-filtix-terminal]')!.innerHTML,
      notifications: api.observedStates.length,
      history: api.historyRequests(),
      resources: api.geometryCalls(),
      reads: api.feedDataReads(),
    };
    const id = t.addStudy({ kind: 'rsi', period: 3 });
    return { before, markup, notifications, history, resources, reads, after, errors, constructors, id };
  });
  expect(result.errors.every((s: string) => s !== 'accepted' && !s.includes('Geometry called'))).toBe(true);
  expect(
    result.constructors.every(
      (r: any) => r.error && !r.error.includes('Geometry called') && r.children === 0,
    ),
  ).toBe(true);
  expect(result.after).toEqual({
    workspace: result.before,
    markup: result.markup,
    notifications: result.notifications,
    history: result.history,
    resources: result.resources,
    reads: result.reads,
  });
  expect(result.id).toBe('study-1');
});
test('layout emits exactly once for effective commits and stays silent for previews, no-ops and invalid patches', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(() => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    const start = api.observedStates.length;
    t.applyLayout({});
    t.applyLayout({ panes: [{ id: 'price' }] });
    t.resetLayout();
    const noops = api.observedStates.length - start;
    try {
      t.applyLayout({ studiesOpen: true, panes: [{ id: 'price', weight: 0 }] });
    } catch {}
    const invalid = api.observedStates.length - start;
    t.applyLayout({ panes: [{ id: 'price', weight: 2 }], studiesOpen: true });
    const one = api.observedStates.length - start;
    t.chart.resizePane('price', 20);
    const two = api.observedStates.length - start;
    return { noops, invalid, one, two, states: api.observedStates.slice(start), layout: t.getLayout() };
  });
  expect(value.noops).toBe(0);
  expect(value.invalid).toBe(0);
  expect(value.one).toBe(1);
  expect(value.two).toBe(2);
  expect(value.states[1].layout).toEqual(value.layout);
});
test('valid full restore cancels an unchanged-layout preview before release', async ({ page }) => {
  await ready(page);
  const separator = page.getByRole('separator').first(),
    box = await separator.boundingBox(),
    before = await page.evaluate(() => (window as any).terminalTestApi.terminal.getWorkspace());
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 40);
  await page.evaluate(
    (workspace) => (window as any).terminalTestApi.terminal.restoreWorkspace(workspace),
    before,
  );
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).terminalTestApi.terminal.getLayout())).toEqual(
    before.layout,
  );
});

test('chart observers can remove or destroy during pane composition without stale resource resurrection', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(() => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    let armed = true;
    const unsubscribe = t.chart.subscribePaneLayoutChange((snapshot: any) => {
      if (armed && snapshot.panes.some((p: any) => p.id === 'terminal-study-1-pane')) {
        armed = false;
        t.removeStudy('terminal-ema');
      }
    });
    let error = '';
    try {
      t.addStudy({ kind: 'rsi', period: 3 });
    } catch (e) {
      error = String(e);
    }
    unsubscribe();
    const after = {
      workspace: t.getWorkspace(),
      panes: t.chart.getPaneLayout(),
      series: t.chart.getDiagnostics().seriesCount,
      error: t.getState().error,
    };
    let destroyArmed = true;
    t.chart.subscribePaneLayoutChange(() => {
      if (destroyArmed) {
        destroyArmed = false;
        t.destroy();
      }
    });
    try {
      t.addStudy({ kind: 'rsi', period: 4 });
    } catch {}
    return { error, after, dead: t.getState(), subscriptions: api.activeSubscriptions() };
  });
  expect(value.after.workspace.studies).toEqual([]);
  expect(value.after.panes.panes.map((p: any) => p.id)).toEqual(['price', 'terminal-volume-pane']);
  expect(value.after.series).toBe(2);
  expect(value.after.error).toBeNull();
  expect(value.dead.destroyed).toBe(true);
  expect(value.subscriptions).toBe(0);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('external geometry reentry during changed-market restore cannot strand the feed on the prior query', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal,
      doc = api.workspaceFor({ symbol: 'ETHUSDT', interval: '1m' }, {});
    doc.layout.panes[0].weight = 3;
    let armed = true;
    const un = t.chart.subscribePaneLayoutChange((layout: any) => {
      if (armed && layout.panes[0].weight === 3) {
        armed = false;
        t.applyLayout({ panes: [{ id: 'price', weight: 4 }] });
      }
    });
    let error = '';
    try {
      await t.restoreWorkspace(doc);
    } catch (cause) {
      error = String(cause);
    }
    un();
    return { error, workspace: t.getWorkspace(), state: t.getState(), active: api.activeQueries() };
  });
  expect(value.workspace.layout.panes[0].weight).toBe(4);
  expect(value.state.feed.query).toEqual(value.workspace.query);
  expect(value.error).toMatch(/superseded/i);
  expect(value.active).toEqual(['BTCUSDT:1m']);
});

for (const operation of ['layout', 'studies', 'settings', 'restore', 'changed-restore'] as const) {
  test(
    'precommit ' +
      operation +
      ' keeps old workspace and rejects when a chart observer commits a nested study',
    async ({ page }) => {
      await ready(page);
      const value = await page.evaluate(async (operation) => {
        const api = (window as any).terminalTestApi,
          t = api.terminal;
        let target = 'price',
          weight = 2;
        if (operation === 'studies') {
          const id = t.addStudy({ kind: 'rsi', period: 3, visible: false });
          target = 'terminal-' + id + '-pane';
          weight = 3;
          t.applyLayout({ panes: [{ id: target, weight }] });
        }
        if (operation === 'settings') {
          t.applySettings({ volume: false });
          target = 'terminal-volume-pane';
          weight = 2;
          t.applyLayout({ panes: [{ id: target, weight }] });
        }
        const before = t.getWorkspace();
        let captured: any = null,
          armed = true,
          nested = '';
        const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
          if (armed && snapshot.panes.some((p: any) => p.id === target && p.weight === weight)) {
            armed = false;
            captured = t.getWorkspace();
            nested = t.addStudy({ kind: 'sma', period: 3 });
          }
        });
        let error = '';
        try {
          if (operation === 'layout') t.applyLayout({ panes: [{ id: target, weight }] });
          else if (operation === 'studies') t.updateStudy('study-1', { visible: true });
          else if (operation === 'settings') t.applySettings({ volume: true });
          else {
            const document =
              operation === 'changed-restore'
                ? api.workspaceFor({ symbol: 'ETHUSDT', interval: '1m' }, { theme: 'light' })
                : t.getWorkspace();
            document.layout.panes[0].weight = 2;
            await t.restoreWorkspace(document);
          }
        } catch (cause) {
          error = String(cause);
        }
        un();
        return {
          before,
          captured,
          error,
          nested,
          after: t.getWorkspace(),
          state: t.getState(),
          effective: t.chart.getPaneLayout(),
          active: api.activeQueries(),
        };
      }, operation);
      expect(value.captured).toEqual(value.before);
      expect(value.error).toMatch(/superseded/i);
      expect(value.after.layout).toEqual(value.before.layout);
      expect(value.after.settings).toEqual(value.before.settings);
      expect(value.after.query).toEqual(value.before.query);
      expect(value.after.studies).toEqual([
        ...value.before.studies,
        { id: value.nested, kind: 'sma', period: 3, color: '#c7ef57', lineWidth: 2, visible: true },
      ]);
      expect(value.state.feed.query).toEqual(value.before.query);
      expect(value.active).toEqual(['BTCUSDT:1m']);
      expect(value.state.error).toBeNull();
    },
  );
}
test('repair-time oscillator removal supersedes the captured rollback registry without resurrection', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(() => {
    const api = (window as any).terminalTestApi,
      t = api.terminal,
      id = t.addStudy({ kind: 'rsi', period: 3 });
    let phase = 'candidate',
      removedDuringRepair = false,
      sawRemoval = false;
    const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
      const ids = snapshot.panes.map((p: any) => p.id);
      if (phase === 'candidate' && ids.includes('terminal-study-2-pane')) {
        phase = 'repair';
        t.applyLayout({ panes: [{ id: 'price', weight: 4 }] });
      } else if (phase === 'repair') {
        if (!ids.includes('terminal-' + id + '-pane')) sawRemoval = true;
        else if (sawRemoval) {
          phase = 'done';
          removedDuringRepair = true;
          t.removeStudy(id);
        }
      }
    });
    let error = '';
    try {
      t.addStudy({ kind: 'rsi', period: 4 });
    } catch (cause) {
      error = String(cause);
    }
    un();
    return {
      removedDuringRepair,
      error,
      workspace: t.getWorkspace(),
      effective: t.chart.getPaneLayout(),
      series: t.chart.getDiagnostics().seriesCount,
      state: t.getState(),
    };
  });
  expect(value.removedDuringRepair).toBe(true);
  expect(value.error).toMatch(/superseded/i);
  expect(value.workspace.studies.map((s: any) => s.id)).toEqual(['terminal-ema']);
  expect(value.effective.panes.map((p: any) => p.id)).toEqual(['price', 'terminal-volume-pane']);
  expect(value.series).toBe(3);
  expect(value.state.error).toBeNull();
});
for (const resource of ['volume', 'oscillator'] as const) {
  for (const route of ['API', 'native'] as const) {
    test(
      'genuine repair allocation failure recovers physical ' + resource + ' through ' + route + ' Retry',
      async ({ page }) => {
        await ready(page);
        const failed = await page.evaluate((resource) => {
          const api = (window as any).terminalTestApi,
            t = api.terminal;
          if (resource === 'oscillator') t.addStudy({ kind: 'rsi', period: 3 });
          let armed = true;
          const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
            const ids = snapshot.panes.map((p: any) => p.id);
            if (
              armed &&
              (resource === 'volume'
                ? !ids.includes('terminal-volume-pane')
                : ids.includes('terminal-study-2-pane'))
            ) {
              armed = false;
              t.applyLayout({ panes: [{ id: 'price', weight: 4 }] });
              api.failNextPane(resource === 'volume' ? 'terminal-volume-pane' : 'terminal-study-1-pane');
            }
          });
          let error = '';
          try {
            if (resource === 'volume') t.applySettings({ volume: false });
            else t.addStudy({ kind: 'rsi', period: 4 });
          } catch (cause) {
            error = String(cause);
          }
          un();
          return {
            error,
            state: t.getState(),
            workspace: t.getWorkspace(),
            panes: t.chart.getPaneLayout().panes.map((p: any) => p.id),
          };
        }, resource);
        expect(failed.error).toMatch(/fixture repair pane failure/i);
        expect(failed.state.error).toMatch(/fixture repair pane failure/i);
        expect(failed.workspace.settings.volume).toBe(true);
        expect(failed.panes).not.toContain(
          resource === 'volume' ? 'terminal-volume-pane' : 'terminal-study-1-pane',
        );
        if (route === 'API') await page.evaluate(() => (window as any).terminalTestApi.terminal.retry());
        else await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => (window as any).terminalTestApi.terminal.getState().feed.status))
          .toBe('live');
        const recovered = await page.evaluate(async () => {
          const api = (window as any).terminalTestApi,
            t = api.terminal;
          const tail = t.getData().at(-1);
          const points = await api.pointsAt(tail.time);
          api.reviseTail(222, 45);
          await t.chart.whenIdle();
          return {
            state: t.getState(),
            workspace: t.getWorkspace(),
            panes: t.chart.getPaneLayout().panes.map((p: any) => p.id),
            series: t.chart.getDiagnostics().seriesCount,
            tail,
            points,
            updated: await api.pointsAt(tail.time),
          };
        });
        expect(recovered.workspace).toEqual(failed.workspace);
        expect(recovered.panes).toEqual(
          resource === 'volume'
            ? ['price', 'terminal-volume-pane']
            : ['price', 'terminal-volume-pane', 'terminal-study-1-pane'],
        );
        expect(recovered.series).toBe(resource === 'volume' ? 3 : 4);
        expect(recovered.state.error).toBeNull();
        expect(recovered.points['terminal-price'].close).toBe(recovered.tail.close);
        expect(recovered.points['terminal-volume'].value).toBe(recovered.tail.volume);
        expect(recovered.points['terminal-ema'].value).toEqual(expect.any(Number));
        if (resource === 'oscillator')
          expect(recovered.points['terminal-study-1'].value).toEqual(expect.any(Number));
        expect(recovered.updated['terminal-price'].close).toBe(222);
        expect(recovered.updated['terminal-volume'].value).toBe(45);
        if (resource === 'oscillator')
          expect(recovered.updated['terminal-study-1'].value).toEqual(expect.any(Number));
      },
    );
  }
}

for (const reentry of ['remove-study', 'market', 'persistent-failure'] as const) {
  test('Retry repairs latest canonical resources after ' + reentry, async ({ page }) => {
    await ready(page);
    const value = await page.evaluate(async (reentry) => {
      const api = (window as any).terminalTestApi,
        t = api.terminal;
      t.addStudy({ kind: 'rsi', period: 3 });
      let armed = true;
      const first = t.chart.subscribePaneLayoutChange((snapshot: any) => {
        if (armed && snapshot.panes.some((p: any) => p.id === 'terminal-study-2-pane')) {
          armed = false;
          t.applyLayout({ panes: [{ id: 'price', weight: 4 }] });
          api.failNextPane('terminal-study-1-pane');
        }
      });
      let initialError = '';
      try {
        t.addStudy({ kind: 'rsi', period: 4 });
      } catch (cause) {
        initialError = String(cause);
      }
      first();
      let fired = 0,
        pending = Promise.resolve();
      const addPane = t.chart.addPane;
      if (reentry === 'persistent-failure')
        t.chart.addPane = (options: any) => {
          if (options.id === 'terminal-volume-pane') {
            fired++;
            throw new Error('fixture persistent repair pane failure');
          }
          return addPane(options);
        };
      const duringRetry = t.chart.subscribePaneLayoutChange((snapshot: any) => {
        const ids = snapshot.panes.map((p: any) => p.id);
        if (reentry !== 'persistent-failure' && !fired && ids.includes('terminal-study-1-pane')) {
          fired++;
          if (reentry === 'remove-study') t.removeStudy('study-1');
          else pending = t.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
        }
      });
      try {
        await t.retry();
        await pending;
      } finally {
        duringRetry();
        t.chart.addPane = addPane;
      }
      const afterFirst = {
        state: t.getState(),
        panes: t.chart.getPaneLayout().panes.map((p: any) => p.id),
        ready: document.querySelector('[data-terminal-status]')?.getAttribute('data-ready'),
      };
      if (reentry === 'persistent-failure') await t.retry();
      const tail = t.getData().at(-1);
      return {
        initialError,
        fired,
        afterFirst,
        workspace: t.getWorkspace(),
        state: t.getState(),
        panes: t.chart.getPaneLayout().panes.map((p: any) => p.id),
        series: t.chart.getDiagnostics().seriesCount,
        tail,
        points: await api.pointsAt(tail.time),
      };
    }, reentry);
    expect(value.initialError).toMatch(/fixture repair pane failure/);
    expect(value.fired).toBeGreaterThan(0);
    if (reentry === 'persistent-failure') {
      expect(value.afterFirst.state.error).toMatch(/fixture persistent repair pane failure/);
      expect(value.afterFirst.ready).toBe('false');
      expect(value.afterFirst.panes).not.toContain('terminal-volume-pane');
    }
    expect(value.state.error).toBeNull();
    expect(value.state.feed.status).toBe('live');
    expect(value.state.feed.query).toEqual(value.workspace.query);
    expect(value.workspace.query.symbol).toBe(reentry === 'market' ? 'ETHUSDT' : 'BTCUSDT');
    expect(value.workspace.studies.map((s: any) => s.id)).toEqual(
      reentry === 'remove-study' ? ['terminal-ema'] : ['terminal-ema', 'study-1'],
    );
    expect(value.panes).toEqual(
      reentry === 'remove-study'
        ? ['price', 'terminal-volume-pane']
        : ['price', 'terminal-volume-pane', 'terminal-study-1-pane'],
    );
    expect(value.series).toBe(reentry === 'remove-study' ? 3 : 4);
    expect(value.points['terminal-price'].close).toBe(value.tail.close);
    expect(value.points['terminal-volume'].value).toBe(value.tail.volume);
    expect(value.points['terminal-ema'].value).toEqual(expect.any(Number));
    if (reentry !== 'remove-study')
      expect(value.points['terminal-study-1'].value).toEqual(expect.any(Number));
  });
}

test('repeated repair-time reentry exhausts a bounded repair budget and reports failure', async ({
  page,
}) => {
  await ready(page);
  const value = await page.evaluate(async () => {
    const api = (window as any).terminalTestApi,
      t = api.terminal;
    t.addStudy({ kind: 'rsi', period: 3 });
    let phase = 'candidate',
      absent = false,
      passes = 0;
    const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
      const ids = snapshot.panes.map((p: any) => p.id);
      if (phase === 'candidate' && ids.includes('terminal-study-2-pane')) {
        phase = 'repair';
        t.applyLayout({ panes: [{ id: 'price', weight: 4 }] });
      } else if (phase === 'repair') {
        if (!ids.includes('terminal-study-1-pane')) absent = true;
        else if (absent) {
          absent = false;
          passes++;
          t.applyLayout({ panes: [{ id: 'price', weight: passes + 5 }] });
        }
      }
    });
    let error = '';
    try {
      t.addStudy({ kind: 'rsi', period: 4 });
    } catch (cause) {
      error = String(cause);
    }
    un();
    const beforeRecovery = {
      workspace: t.getWorkspace(),
      effective: t.chart.getPaneLayout(),
      series: t.chart.getDiagnostics().seriesCount,
      state: t.getState(),
    };
    await t.retry();
    return { passes, error, ...beforeRecovery, recovered: t.getState() };
  });
  expect(value.passes).toBe(8);
  expect(value.workspace.studies.map((s: any) => s.id)).toEqual(['terminal-ema', 'study-1']);
  expect(value.effective.panes.map((p: any) => p.id)).toEqual([
    'price',
    'terminal-volume-pane',
    'terminal-study-1-pane',
  ]);
  expect(value.series).toBe(4);
  expect(value.recovered.error).toBeNull();
  expect(value.recovered.feed.status).toBe('live');
  expect(value.error).toMatch(/repair.*settle/i);
  expect(value.state.error).toMatch(/repair.*settle/i);
});

for (const operation of ['layout', 'studies', 'settings', 'restore', 'changed-restore'] as const) {
  test(
    'precommit ' + operation + ' is superseded by a chart-observer market generation change',
    async ({ page }) => {
      await ready(page);
      const value = await page.evaluate(async (operation) => {
        const api = (window as any).terminalTestApi,
          t = api.terminal;
        let target = 'price',
          weight = 2;
        if (operation === 'studies') {
          t.addStudy({ kind: 'rsi', period: 3, visible: false });
          target = 'terminal-study-1-pane';
          weight = 3;
          t.applyLayout({ panes: [{ id: target, weight }] });
        }
        if (operation === 'settings') {
          t.applySettings({ volume: false });
          target = 'terminal-volume-pane';
          weight = 2;
          t.applyLayout({ panes: [{ id: target, weight }] });
        }
        const before = t.getWorkspace();
        let armed = true,
          pending = Promise.resolve();
        const un = t.chart.subscribePaneLayoutChange((snapshot: any) => {
          if (armed && snapshot.panes.some((p: any) => p.id === target && p.weight === weight)) {
            armed = false;
            pending = t.setMarket({ symbol: 'ETHUSDT', interval: '5m' });
          }
        });
        let error = '';
        try {
          if (operation === 'layout') t.applyLayout({ panes: [{ id: target, weight }] });
          else if (operation === 'studies') t.updateStudy('study-1', { visible: true });
          else if (operation === 'settings') t.applySettings({ volume: true });
          else {
            const doc =
              operation === 'changed-restore'
                ? api.workspaceFor({ symbol: 'ETHUSDT', interval: '1m' }, {})
                : t.getWorkspace();
            doc.layout.panes[0].weight = 2;
            await t.restoreWorkspace(doc);
          }
        } catch (cause) {
          error = String(cause);
        }
        await pending;
        un();
        return {
          before,
          error,
          workspace: t.getWorkspace(),
          state: t.getState(),
          active: api.activeQueries(),
        };
      }, operation);
      expect(value.error).toMatch(/superseded/i);
      expect(value.workspace.query).toEqual({ symbol: 'ETHUSDT', interval: '5m' });
      expect(value.state.feed.query).toEqual(value.workspace.query);
      expect(value.workspace.layout).toEqual(value.before.layout);
      expect(value.workspace.studies).toEqual(value.before.studies);
      expect(value.workspace.settings).toEqual(value.before.settings);
      expect(value.active).toEqual(['ETHUSDT:5m']);
    },
  );
}
for (const kind of ['invalid', 'same'] as const) {
  test('a ' + kind + ' reentrant market request does not supersede owned layout', async ({ page }) => {
    await ready(page);
    const value = await page.evaluate(async (kind) => {
      const t = (window as any).terminalTestApi.terminal;
      let armed = true,
        pending = Promise.resolve(),
        marketError = '';
      const un = t.chart.subscribePaneLayoutChange(() => {
        if (armed) {
          armed = false;
          pending = t
            .setMarket(
              kind === 'invalid'
                ? { symbol: 'foreign', interval: '1m' }
                : { symbol: 'BTCUSDT', interval: '1m' },
            )
            .catch((error: unknown) => {
              marketError = String(error);
            });
        }
      });
      let error = '';
      try {
        t.applyLayout({ panes: [{ id: 'price', weight: 2 }] });
      } catch (cause) {
        error = String(cause);
      }
      await pending;
      un();
      return { error, marketError, workspace: t.getWorkspace() };
    }, kind);
    expect(value.error).toBe('');
    expect(value.workspace.layout.panes[0].weight).toBe(2);
    expect(value.workspace.query).toEqual({ symbol: 'BTCUSDT', interval: '1m' });
    expect(Boolean(value.marketError)).toBe(kind === 'invalid');
  });
}
