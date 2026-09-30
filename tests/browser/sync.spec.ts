import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/sync-test.html');
  await page.waitForFunction(() => !!window.syncTestApi);
  await page.evaluate(() => window.syncTestApi.settle());
});

test('propagates genuinely different semantic ranges bidirectionally and stops after destroy', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api;
    const sync = api.createChartSync([a, b]);
    await api.settle();
    const initial = b.getVisibleTimeRange();
    a.setVisibleTimeRange({ from: 10000, to: 15000 });
    await api.settle();
    const forward = b.getVisibleTimeRange();
    b.setVisibleTimeRange({ from: 2000, to: 6000 });
    await api.settle();
    const back = a.getVisibleTimeRange(),
      revision = a.getChangeRevision();
    await api.settle();
    const stable = a.getChangeRevision();
    sync.destroy();
    sync.destroy();
    a.setVisibleTimeRange({ from: 12000, to: 17000 });
    await api.settle();
    return { initial, forward, back, revision, stable, detached: b.getVisibleTimeRange() };
  });
  expect(result.initial).toEqual({ from: 4000, to: 8000 });
  expect(result.forward).toEqual({ from: 10000, to: 14000 });
  expect(result.back).toEqual({ from: 2000, to: 6000 });
  expect(result.stable).toBe(result.revision);
  expect(result.detached).toEqual({ from: 2000, to: 6000 });
});

test('membership fences preserve first-chart initialization through pending fit and reconnect no-ops', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      a = api.create([1000, 2000, 3000, 4000, 5000, 6000]).chart,
      b = api.create([2000, 3000, 4000, 5000]).chart;
    const sync = api.createChartSync([a, b]);
    await api.settle();
    const initial = a.getVisibleTimeRange();
    a.setVisibleTimeRange({ from: 2000, to: 6000 });
    sync.destroy();
    const next = api.createChartSync([a, b]);
    await api.settle();
    const reconnected = a.getVisibleTimeRange();
    next.destroy();
    return { initial, reconnected };
  });
  expect(result.initial).toEqual({ from: 1000, to: 6000 });
  expect(result.reconnected).toEqual({ from: 2000, to: 6000 });
});

test('time ranges use loaded boundaries, single-point expansion and atomic no-overlap validation', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      chart = api.create([1000, 3000, 7000]).chart;
    chart.setVisibleRange({ from: 0.2, to: 1.8 });
    const inside = chart.getVisibleTimeRange();
    const single = chart.setVisibleTimeRange({ from: 3000, to: 3000 });
    const tail = chart.setVisibleTimeRange({ from: 7000, to: 7000 });
    const before = chart.getVisibleRange(),
      revision = chart.getChangeRevision();
    const none = chart.setVisibleTimeRange({ from: 4000, to: 6000 });
    const failures = [];
    for (const action of [
      () => chart.setVisibleTimeRange({ from: 7000, to: 1000 }),
      () => chart.setVisibleTimeRange({ from: 1.5, to: 3000 }),
      () => chart.setVisibleTimeRange({ from: 1000, to: 3000 }, { origin: 7 } as never),
      () => chart.setVisibleTimeRange({ from: 1000, to: 3000 }, { cause: 'data' } as never),
    ]) {
      try {
        action();
        failures.push(false);
      } catch {
        failures.push(true);
      }
    }
    const solo = api.create([1000]).chart,
      empty = api.create([]).chart;
    return {
      inside,
      single,
      tail,
      none,
      before,
      after: chart.getVisibleRange(),
      revision,
      afterRevision: chart.getChangeRevision(),
      failures,
      solo: solo.setVisibleTimeRange({ from: 1000, to: 1000 }),
      soloRange: solo.getVisibleRange(),
      empty: empty.getVisibleTimeRange(),
    };
  });
  expect(result.inside).toEqual({ from: 3000, to: 3000 });
  expect(result.single).toEqual({ from: 3000, to: 7000 });
  expect(result.tail).toEqual({ from: 3000, to: 7000 });
  expect(result.none).toBeNull();
  expect(result.after).toEqual(result.before);
  expect(result.afterRevision).toBe(result.revision);
  expect(result.failures).toEqual([true, true, true, true]);
  expect(result.solo).toEqual({ from: 1000, to: 1000 });
  expect(result.soloRange).toEqual({ from: 0, to: 1 });
  expect(result.empty).toBeNull();
});

test('coalesces effective range revisions and origin identity without no-op or scene-only replacement', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a } = api,
      origin = {},
      other = {};
    const events: Array<{ revision: number; cause: string; origin: boolean; frozen: boolean }> = [];
    a.subscribeVisibleRangeChange((_, meta) =>
      events.push({
        revision: meta.revision,
        cause: meta.cause,
        origin: meta.origin === origin,
        frozen: Object.isFrozen(meta),
      }),
    );
    a.setVisibleTimeRange({ from: 2000, to: 9000 }, { origin: other });
    a.setVisibleTimeRange({ from: 4000, to: 11000 }, { origin });
    const revision = a.getChangeRevision();
    a.setVisibleTimeRange({ from: 4000, to: 11000 }, { origin: other });
    a.applyOptions({ theme: 'light' });
    const afterNoop = a.getChangeRevision();
    await api.settle();
    return { events, revision, afterNoop, originFrozen: Object.isFrozen(origin) };
  });
  expect(result.events).toEqual([{ revision: result.revision, cause: 'api', origin: true, frozen: true }]);
  expect(result.afterNoop).toBe(result.revision);
  expect(result.originFrozen).toBe(false);
});

test('native and data changes assign synchronous revisions with correct channel provenance', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, first } = api,
      origin = {};
    const range: Array<{ cause: string; origin: boolean; revision: number }> = [],
      cursor: Array<{ cause: string; origin: boolean; revision: number }> = [];
    a.subscribeVisibleRangeChange((_, m) =>
      range.push({ cause: m.cause, origin: m.origin === origin, revision: m.revision }),
    );
    a.subscribeCrosshairMove((_, m) =>
      cursor.push({ cause: m.cause, origin: m.origin === origin, revision: m.revision }),
    );
    a.setCrosshairTime(5000, { origin });
    await api.settle();
    cursor.length = 0;
    first.root.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: 250,
        clientY: first.root.getBoundingClientRect().top + 100,
        deltaY: -100,
      }),
    );
    const synchronous = a.getChangeRevision();
    await api.settle();
    const wheel = { range: range.at(-1), cursor: cursor.at(-1), synchronous, after: a.getChangeRevision() };
    first.root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 200,
        clientY: first.root.getBoundingClientRect().top + 100,
        pointerId: 1,
      }),
    );
    const nativeRevision = a.getChangeRevision();
    await api.settle();
    const native = cursor.at(-1);
    a.applyOptions({ followLatest: true });
    a.fitContent();
    await api.settle();
    first.series.update({ time: 20000, value: 30 });
    const dataRevision = a.getChangeRevision();
    await api.settle();
    return { wheel, native, nativeRevision, data: range.at(-1), dataRevision };
  });
  expect(result.wheel.range).toMatchObject({ cause: 'interaction', origin: false });
  expect(result.wheel.cursor?.origin).toBe(true);
  expect(result.wheel.after).toBe(result.wheel.synchronous);
  expect(result.native).toEqual({ cause: 'interaction', origin: false, revision: result.nativeRevision });
  expect(result.data?.cause).toBe('data');
  expect(result.data!.revision).toBeLessThanOrEqual(result.dataRevision);
});

test('controlled cursor is vertical only, preserves actual values, omits export and repaints only its canvas', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, first } = api;
    const off = a.attachPrimitive({ draw() {} });
    await api.settle();
    const baseline = Array.from(new Uint8Array(await (await a.exportImage()).arrayBuffer()));
    const before = a.getDiagnostics();
    let event: unknown;
    a.subscribeCrosshairMove((e) => (event = e));
    a.setCrosshairTime(5000);
    await api.settle();
    const after = a.getDiagnostics();
    const canvas = first.root.querySelector<HTMLCanvasElement>('[data-filtix-layer="overlay"]')!,
      pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 2).data;
    let topInk = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) topInk++;
    const exported = Array.from(new Uint8Array(await (await a.exportImage()).arrayBuffer()));
    off();
    return { baseline, exported, before, after, topInk, event };
  });
  expect(result.topInk).toBeLessThan(10);
  expect(result.event).toMatchObject({
    time: 5000,
    y: 0,
    points: { 'price-series': { time: 5000, value: 6 } },
  });
  expect(result.exported).toEqual(result.baseline);
  expect(result.after.sceneDraws).toBe(result.before.sceneDraws);
  expect(result.after.primitiveDraws).toBe(result.before.primitiveDraws);
  expect(result.after.overlayDraws).toBeGreaterThan(result.before.overlayDraws);
});

test('controlled anchors survive viewport changes and timeline replacement without index drift', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, first } = api;
    let time: unknown;
    a.subscribeCrosshairMove((e) => (time = e.time));
    const resolved = a.setCrosshairTime(0);
    await api.settle();
    const hidden = time;
    a.fitContent();
    await api.settle();
    const revealed = time;
    a.setCrosshairTime(5000);
    await api.settle();
    a.setVisibleRange({ from: 2, to: 15 });
    await api.settle();
    const panned = time;
    first.series.setData(Array.from({ length: 20 }, (_, i) => ({ time: (i - 1) * 1000, value: i + 1 })));
    await api.settle();
    const prepended = time;
    first.series.setData([
      { time: 0, value: 1 },
      { time: 10000, value: 2 },
    ]);
    a.fitContent();
    await api.settle();
    const missing = time;
    first.series.setData([
      { time: 0, value: 1 },
      { time: 5000, value: 6 },
      { time: 10000, value: 2 },
    ]);
    a.fitContent();
    await api.settle();
    return { resolved, hidden, revealed, panned, prepended, missing, restored: time };
  });
  expect(result).toEqual({
    resolved: 0,
    hidden: null,
    revealed: 0,
    panned: 5000,
    prepended: 5000,
    missing: null,
    restored: 5000,
  });
});

test('nearest business dates use calendar-day ties including years zero through ninety-nine', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const api = window.syncTestApi;
    return ['2026', '0000', '0099'].map((year) => {
      const chart = api.create([`${year}-01-31`, `${year}-02-02`], { timeDomain: 'business-date' }).chart;
      return {
        time: chart.setCrosshairTime(`${year}-02-01`, { match: 'nearest' }),
        range: chart.setVisibleTimeRange({ from: `${year}-01-31`, to: `${year}-01-31` }),
      };
    });
  });
  expect(result).toEqual(
    ['2026', '0000', '0099'].map((year) => ({
      time: `${year}-01-31`,
      range: { from: `${year}-01-31`, to: `${year}-02-02` },
    })),
  );
});

test('cursor options validate atomically and missing/clear calls do not resurrect stale native state', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, first } = api,
      origin = {};
    let time: unknown;
    a.subscribeCrosshairMove((e) => (time = e.time));
    a.setCrosshairTime(5000, { origin });
    await api.settle();
    const revision = a.getChangeRevision();
    a.setCrosshairTime(5000, { origin });
    const noop = a.getChangeRevision();
    const rejected = [];
    for (const action of [
      () => a.setCrosshairTime(null, { match: 'bad' } as never),
      () => a.setCrosshairTime(6000, { origin: 7 } as never),
      () => a.setCrosshairTime(6000, { cause: 'data' } as never),
      () => a.setCrosshairTime(6000, null as never),
    ]) {
      try {
        action();
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    await api.settle();
    const invalid = { revision: a.getChangeRevision(), time };
    a.setCrosshairTime(5555, { origin });
    const missingRevision = a.getChangeRevision();
    await api.settle();
    const missing = time;
    first.root.focus();
    first.root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 200,
        clientY: first.root.getBoundingClientRect().top + 100,
        pointerId: 1,
      }),
    );
    await api.settle();
    a.setCrosshairTime(null);
    await api.settle();
    first.root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    await api.settle();
    return { revision, noop, rejected, invalid, missing, missingRevision, afterClear: time };
  });
  expect(result.noop).toBe(result.revision);
  expect(result.rejected).toEqual([true, true, true, true]);
  expect(result.invalid).toEqual({ revision: result.revision, time: 5000 });
  expect(result.missing).toBeNull();
  expect(result.missingRevision).toBeGreaterThan(result.revision);
  expect(result.afterClear).toBeNull();
});
test('sync exact and nearest cursor policies forward real values and clear without inventing initial cursors', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api;
    a.fitContent();
    b.fitContent();
    await api.settle();
    let target: import('@filtrix.net/charts').CrosshairEvent | null = null;
    let events = 0;
    b.subscribeCrosshairMove((e) => {
      target = e;
      events++;
    });
    let sync = api.createChartSync([a, b]);
    await api.settle();
    const initialEvents = events;
    a.setCrosshairTime(5000);
    await api.settle();
    const exact = target;
    sync.destroy();
    sync = api.createChartSync([a, b], { crosshairMatch: 'nearest', viewport: false });
    a.setCrosshairTime(7000);
    await api.settle();
    const nearest = target;
    a.setCrosshairTime(null);
    await api.settle();
    const clear = target;
    sync.destroy();
    return { initialEvents, exact, nearest, clear };
  });
  expect(result.initialEvents).toBe(0);
  expect(result.exact).toMatchObject({ time: null });
  expect(result.nearest).toMatchObject({ time: 6000, points: { 'price-series': { time: 6000, value: 4 } } });
  expect(result.clear).toMatchObject({ time: null });
});

test('partial subscription and initialization failures roll back every owned listener', async ({ page }) => {
  const result = await page.evaluate(() => {
    const { a, b, createChartSync } = window.syncTestApi;
    let installed = 0,
      removed = 0;
    const wrap = (chart: typeof a) => ({
      ...chart,
      subscribeVisibleRangeChange(callback: Parameters<typeof a.subscribeVisibleRangeChange>[0]) {
        installed++;
        const off = chart.subscribeVisibleRangeChange(callback);
        return () => {
          removed++;
          off();
        };
      },
      subscribeCrosshairMove(callback: Parameters<typeof a.subscribeCrosshairMove>[0]) {
        installed++;
        const off = chart.subscribeCrosshairMove(callback);
        return () => {
          removed++;
          off();
        };
      },
    });
    const first = wrap(a),
      second = wrap(b);
    second.subscribeCrosshairMove = () => {
      throw new Error('subscription failure');
    };
    let failed = '';
    try {
      createChartSync([first, second]);
    } catch (e) {
      failed = (e as Error).message;
    }
    const subscription = { installed, removed, failed };
    installed = 0;
    removed = 0;
    const third = wrap(a),
      fourth = wrap(b);
    fourth.setVisibleTimeRange = () => {
      throw new Error('initialization failure');
    };
    try {
      createChartSync([third, fourth]);
    } catch (e) {
      failed = (e as Error).message;
    }
    return { subscription, initialization: { installed, removed, failed } };
  });
  expect(result.subscription).toEqual({ installed: 3, removed: 3, failed: 'subscription failure' });
  expect(result.initialization).toEqual({ installed: 4, removed: 4, failed: 'initialization failure' });
});

test('destroyed and domain-changed peers detach before propagation while remaining peers work', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api,
      c = api.create(Array.from({ length: 20 }, (_, i) => i * 1000)).chart;
    let domain: import('@filtrix.net/charts').TimeDomain = 'utc-ms',
      calls = 0,
      removed = 0;
    const target = {
      ...b,
      get timeDomain() {
        return domain;
      },
      setVisibleTimeRange(...args: Parameters<typeof b.setVisibleTimeRange>) {
        calls++;
        return b.setVisibleTimeRange(...args);
      },
      subscribeVisibleRangeChange(callback: Parameters<typeof b.subscribeVisibleRangeChange>[0]) {
        const off = b.subscribeVisibleRangeChange(callback);
        return () => {
          removed++;
          off();
        };
      },
      subscribeCrosshairMove(callback: Parameters<typeof b.subscribeCrosshairMove>[0]) {
        const off = b.subscribeCrosshairMove(callback);
        return () => {
          removed++;
          off();
        };
      },
    };
    const sync = api.createChartSync([a, target, c]);
    await api.settle();
    calls = 0;
    domain = 'business-date';
    a.setVisibleTimeRange({ from: 10000, to: 15000 });
    await api.settle();
    const changed = { calls, removed, remaining: c.getVisibleTimeRange() };
    b.destroy();
    a.setVisibleTimeRange({ from: 2000, to: 7000 });
    await api.settle();
    const live = c.getVisibleTimeRange();
    sync.destroy();
    return { changed, live };
  });
  expect(result.changed).toEqual({ calls: 0, removed: 2, remaining: { from: 10000, to: 15000 } });
  expect(result.live).toEqual({ from: 2000, to: 7000 });
});

test('group destroy during propagation prevents later target writes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api,
      c = api.create(Array.from({ length: 20 }, (_, i) => i * 1000)).chart;
    let sync: ReturnType<typeof api.createChartSync> | undefined;
    const target = {
      ...b,
      setVisibleTimeRange(...args: Parameters<typeof b.setVisibleTimeRange>) {
        sync?.destroy();
        return b.setVisibleTimeRange(...args);
      },
    };
    sync = api.createChartSync([a, target, c]);
    await api.settle();
    const before = c.getVisibleTimeRange();
    a.setVisibleTimeRange({ from: 10000, to: 15000 });
    await api.settle();
    return { before, after: c.getVisibleTimeRange() };
  });
  expect(result.after).toEqual(result.before);
});

test('invalid sync requests validate before subscribing and disabled channels stay disconnected', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api;
    let installed = 0;
    const source = {
      ...a,
      subscribeVisibleRangeChange(callback: Parameters<typeof a.subscribeVisibleRangeChange>[0]) {
        installed++;
        return a.subscribeVisibleRangeChange(callback);
      },
      subscribeCrosshairMove(callback: Parameters<typeof a.subscribeCrosshairMove>[0]) {
        installed++;
        return a.subscribeCrosshairMove(callback);
      },
    };
    const date = api.create(['2026-01-01'], { timeDomain: 'business-date' }).chart,
      dead = api.create([1000]).chart;
    dead.destroy();
    const actions = [
      () => api.createChartSync([source, source]),
      () => api.createChartSync([source, date]),
      () => api.createChartSync([source, dead]),
      () => api.createChartSync([source, b], { viewport: 'yes' } as never),
      () => api.createChartSync([source, b], { crosshairMatch: 'bad' } as never),
      () => api.createChartSync([source, b], { unexpected: true } as never),
    ];
    const failures = actions.map((action) => {
      try {
        action();
        return false;
      } catch {
        return true;
      }
    });
    const sync = api.createChartSync([source, b], { viewport: false, crosshair: false });
    const before = b.getVisibleTimeRange();
    a.setVisibleTimeRange({ from: 10000, to: 15000 });
    a.setCrosshairTime(12000);
    await api.settle();
    sync.destroy();
    return { failures, installed, before, after: b.getVisibleTimeRange() };
  });
  expect(result.failures).toEqual([true, true, true, true, true, true]);
  expect(result.installed).toBe(0);
  expect(result.after).toEqual(result.before);
});

test('reentrant chart destruction suppresses later range and cursor observers', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a } = api;
    let first = 0,
      later = 0;
    a.subscribeVisibleRangeChange(() => {
      first++;
      a.destroy();
    });
    a.subscribeVisibleRangeChange(() => later++);
    a.subscribeCrosshairMove(() => later++);
    a.setCrosshairTime(5000);
    a.setVisibleRange({ from: 0, to: 10 });
    await api.settle();
    let code = '';
    try {
      a.getChangeRevision();
    } catch (e) {
      code = (e as { code: string }).code;
    }
    return { first, later, code };
  });
  expect(result).toEqual({ first: 1, later: 0, code: 'DESTROYED' });
});

test('data replacement emits a semantic range change even when logical endpoints are unchanged', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      first = api.create([1000, 2000, 3000]),
      second = api.create([1000, 2000, 3000, 4000, 5000]);
    await api.settle();
    const sync = api.createChartSync([first.chart, second.chart]);
    await api.settle();
    const before = first.chart.getVisibleRange();
    let cause = '';
    first.chart.subscribeVisibleRangeChange((_, meta) => (cause = meta.cause));
    first.series.setData([
      { time: 2000, value: 1 },
      { time: 3000, value: 2 },
      { time: 4000, value: 3 },
    ]);
    const revision = first.chart.getChangeRevision();
    await api.settle();
    sync.destroy();
    return {
      before,
      after: first.chart.getVisibleRange(),
      target: second.chart.getVisibleTimeRange(),
      cause,
      revision,
    };
  });
  expect(result.after).toEqual(result.before);
  expect(result.target).toEqual({ from: 2000, to: 4000 });
  expect(result.cause).toBe('data');
});

test('cause-filtered real charts ignore data reflow and propagate an API range change', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi;
    const first = api.create([1000, 2000, 3000, 4000, 5000]);
    const second = api.create([1000, 2000, 3000, 4000, 5000]);
    await api.settle();
    const sync = api.createChartSync([first.chart, second.chart], {
      viewport: true,
      crosshair: true,
      causes: ['interaction', 'api'],
    });
    const before = second.chart.getVisibleTimeRange();
    first.series.setData([
      { time: 2000, value: 10 },
      { time: 3000, value: 11 },
      { time: 4000, value: 12 },
    ]);
    await api.settle();
    const afterData = second.chart.getVisibleTimeRange();
    first.chart.setVisibleTimeRange({ from: 2000, to: 3000 });
    await api.settle();
    const afterApi = second.chart.getVisibleTimeRange();
    sync.destroy();
    return { before, afterData, afterApi };
  });
  expect(result.afterData).toEqual(result.before);
  expect(result.afterApi).toEqual({ from: 2000, to: 3000 });
});

test('controlled cursor events hide at zero size and reappear without a stale time payload', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a } = api;
    let time: unknown;
    a.subscribeCrosshairMove((e) => (time = e.time));
    a.setCrosshairTime(5000);
    await api.settle();
    a.applyOptions({ width: 0, height: 0 });
    await api.settle();
    const hidden = time;
    a.applyOptions({ width: 600, height: 300 });
    await api.settle();
    return { hidden, shown: time };
  });
  expect(result).toEqual({ hidden: null, shown: 5000 });
});

test('same-frame range and cursor channels retain their own last effective origin and revision', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a } = api,
      rangeOrigin = {},
      cursorOrigin = {};
    let range: unknown, cursor: unknown;
    a.subscribeVisibleRangeChange(
      (_, m) => (range = { revision: m.revision, origin: m.origin === rangeOrigin, cause: m.cause }),
    );
    a.subscribeCrosshairMove(
      (e, m) =>
        (cursor = { time: e.time, revision: m.revision, origin: m.origin === cursorOrigin, cause: m.cause }),
    );
    a.setVisibleTimeRange({ from: 2000, to: 10000 }, { origin: rangeOrigin });
    const rangeRevision = a.getChangeRevision();
    a.setCrosshairTime(6000, { origin: cursorOrigin });
    const cursorRevision = a.getChangeRevision();
    a.applyOptions({ theme: 'light' });
    a.setVisibleTimeRange({ from: 2000, to: 10000 }, { origin: {} });
    a.setCrosshairTime(6000, { origin: cursorOrigin });
    await api.settle();
    return { range, cursor, rangeRevision, cursorRevision, after: a.getChangeRevision() };
  });
  expect(result.range).toEqual({ revision: result.rangeRevision, origin: true, cause: 'api' });
  expect(result.cursor).toEqual({ time: 6000, revision: result.cursorRevision, origin: true, cause: 'api' });
  expect(result.after).toBe(result.cursorRevision);
});

test('a destroyed active peer does not stop live peers and unrelated target errors are reported', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const api = window.syncTestApi,
      { a, b } = api,
      c = api.create(Array.from({ length: 20 }, (_, i) => i * 1000)).chart;
    let sync = api.createChartSync([a, b, c]);
    await api.settle();
    b.destroy();
    a.setVisibleTimeRange({ from: 10000, to: 15000 });
    await api.settle();
    const live = c.getVisibleTimeRange();
    sync.destroy();
    let fail = false;
    const target = {
      ...c,
      setVisibleTimeRange(...args: Parameters<typeof c.setVisibleTimeRange>) {
        if (fail) throw new Error('deliberate invalid target');
        return c.setVisibleTimeRange(...args);
      },
    };
    sync = api.createChartSync([a, target]);
    await api.settle();
    fail = true;
    a.setVisibleTimeRange({ from: 2000, to: 7000 });
    await api.settle();
    sync.destroy();
    return live;
  });
  expect(result).toEqual({ from: 10000, to: 15000 });
  expect(errors).toContain('deliberate invalid target');
});
