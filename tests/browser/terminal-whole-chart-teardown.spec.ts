import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const moduleUrls = Object.fromEntries(
  ['terminal/src/terminal', 'charts/src/index', 'datafeed/src/index', 'alerts/src/index'].map((name) => [
    name,
    '/@fs/' + resolve('packages', name + '.ts').replaceAll('\\', '/'),
  ]),
);

for (const throwsAfterDestroy of [false, true]) {
  test(`whole terminal retirement avoids individual removals and fences primitive reentry (destroy throws: ${throwsAfterDestroy})`, async ({
    page,
  }) => {
    await page.goto('/terminal-test.html');
    const result = await page.evaluate(
      async ({ urls, throwsAfterDestroy }) => {
        const { createTerminalWithDependencies } = await import(urls['terminal/src/terminal']!);
        const { createChart } = await import(urls['charts/src/index']!);
        const { createFeedSession } = await import(urls['datafeed/src/index']!);
        const host = document.createElement('div');
        host.style.cssText = 'width:900px;height:650px';
        document.body.append(host);
        const calls = { seriesRemove: 0, paneRemove: 0, chartDestroy: 0, cleanup: 0, subscriptions: 0 };
        const bars = Array.from({ length: 32 }, (_, i) => ({
          time: 1_700_000_000_000 + i * 60_000,
          open: i + 10,
          high: i + 12,
          low: i + 9,
          close: i + 11,
          volume: i + 1,
        }));
        const provider = {
          id: 'whole-chart-retirement',
          revisionMode: 'arrival',
          maxPageSize: 10000,
          async getHistory() {
            return { bars, exhausted: true };
          },
          subscribe() {
            calls.subscriptions++;
            return () => {
              calls.subscriptions--;
            };
          },
        };
        const chartError = new Error('post-chart-destroy failure');
        const terminal = createTerminalWithDependencies(
          host,
          {
            provider,
            query: { symbol: 'BTCUSDT', interval: '1m' },
            studies: [
              { kind: 'sma', period: 3 },
              { kind: 'rsi', period: 3 },
              { kind: 'macd', fastPeriod: 2, slowPeriod: 3, signalPeriod: 2 },
              { kind: 'bollinger', period: 3, multiplier: 2 },
            ],
          },
          {
            createFeedSession,
            createChart(...args: Parameters<typeof createChart>) {
              const chart = createChart(...args);
              return {
                ...chart,
                addSeries(...values: Parameters<typeof chart.addSeries>) {
                  const series = chart.addSeries(...values);
                  return {
                    ...series,
                    remove() {
                      calls.seriesRemove++;
                      series.remove();
                    },
                  };
                },
                addPane(...values: Parameters<typeof chart.addPane>) {
                  const pane = chart.addPane(...values);
                  return {
                    ...pane,
                    remove() {
                      calls.paneRemove++;
                      pane.remove();
                    },
                  };
                },
                destroy() {
                  calls.chartDestroy++;
                  chart.destroy();
                  if (throwsAfterDestroy) throw chartError;
                },
              };
            },
          },
        );
        for (let i = 0; i < 100 && terminal.getState().feed.status !== 'live'; i++)
          await new Promise((done) => setTimeout(done, 10));
        if (terminal.getState().feed.status !== 'live') throw new Error('history did not load');
        terminal
          .getDrawings()
          .add({ type: 'horizontal-line', paneId: 'price', points: [{ time: bars[0]!.time, price: 15 }] });
        // Ordinary live removal must still remove its series/pane before final disposal.
        const removable = terminal.getState().studies.find((study: { kind: string }) => study.kind === 'rsi');
        terminal.removeStudy(removable.id);
        const liveRemovals = { series: calls.seriesRemove, pane: calls.paneRemove };
        calls.seriesRemove = calls.paneRemove = 0;
        const before = terminal.getWorkspace();
        let reentry: any = null;
        terminal.chart.attachPrimitive({
          draw() {},
          attach() {
            return () => {
              calls.cleanup++;
              const snapshot = terminal.getWorkspace();
              let mutationRejected = false;
              try {
                terminal.addStudy({ kind: 'ema', period: 3 });
              } catch {
                mutationRejected = true;
              }
              reentry = { state: terminal.getState(), snapshot, mutationRejected };
              const writable = terminal.getWorkspace();
              writable.markets[0].drawings.drawings[0].points[0].price = -999;
              terminal.destroy();
            };
          },
        });
        let errorPreserved = false;
        try {
          terminal.destroy();
        } catch (error) {
          errorPreserved = error === chartError;
        }
        terminal.destroy();
        const after = terminal.getWorkspace();
        const state = terminal.getState();
        const children = host.childElementCount;
        host.remove();
        return { calls, liveRemovals, before, after, state, reentry, children, errorPreserved };
      },
      { urls: moduleUrls, throwsAfterDestroy },
    );
    expect(result.liveRemovals.series).toBeGreaterThan(0);
    expect(result.liveRemovals.pane).toBeGreaterThan(0);
    expect(result.calls).toEqual({
      seriesRemove: 0,
      paneRemove: 0,
      chartDestroy: 1,
      cleanup: 1,
      subscriptions: 0,
    });
    expect(result.reentry.mutationRejected).toBe(true);
    expect(result.reentry.state.destroyed).toBe(true);
    expect(result.reentry.snapshot).toEqual(result.before);
    expect(result.after).toEqual(result.before);
    expect(result.state.destroyed).toBe(true);
    expect(result.children).toBe(0);
    expect(result.errorPreserved).toBe(throwsAfterDestroy);
  });
}

test('failed construction retires the whole chart and preserves its original error and borrowed resources', async ({
  page,
}) => {
  await page.goto('/terminal-test.html');
  const result = await page.evaluate(async (urls) => {
    const { createTerminalWithDependencies } = await import(urls['terminal/src/terminal']!);
    const { createChart } = await import(urls['charts/src/index']!);
    const { createPriceAlertStore, createPriceAlertMonitor } = await import(urls['alerts/src/index']!);
    const host = document.createElement('div');
    host.style.cssText = 'width:900px;height:650px';
    document.body.append(host);
    const calls = { seriesRemove: 0, paneRemove: 0, chartDestroy: 0, cleanup: 0 };
    const provider = {
      id: 'failed-retirement',
      revisionMode: 'arrival',
      maxPageSize: 10000,
      async getHistory() {
        return { bars: [], exhausted: true };
      },
      subscribe() {
        return () => {};
      },
    };
    const store = createPriceAlertStore({ providerId: provider.id, scopeId: 'borrowed' });
    const monitor = createPriceAlertMonitor({ provider });
    const original = new Error('feed constructor failed');
    let preserved = false;
    try {
      createTerminalWithDependencies(
        host,
        {
          provider,
          query: { symbol: 'BTCUSDT', interval: '1m' },
          studies: [
            { kind: 'rsi', period: 3 },
            { kind: 'bollinger', period: 3, multiplier: 2 },
          ],
          alerts: { store, monitor },
        },
        {
          createFeedSession() {
            throw original;
          },
          createChart(...args: Parameters<typeof createChart>) {
            const chart = createChart(...args);
            chart.attachPrimitive({
              draw() {},
              attach() {
                return () => {
                  calls.cleanup++;
                };
              },
            });
            return {
              ...chart,
              addSeries(...values: Parameters<typeof chart.addSeries>) {
                const series = chart.addSeries(...values);
                return {
                  ...series,
                  remove() {
                    calls.seriesRemove++;
                    series.remove();
                  },
                };
              },
              addPane(...values: Parameters<typeof chart.addPane>) {
                const pane = chart.addPane(...values);
                return {
                  ...pane,
                  remove() {
                    calls.paneRemove++;
                    pane.remove();
                  },
                };
              },
              destroy() {
                calls.chartDestroy++;
                chart.destroy();
                throw new Error('cleanup failure');
              },
            };
          },
        },
      );
    } catch (error) {
      preserved = error === original;
    }
    const id = store.add({
      query: { symbol: 'BTCUSDT', interval: '1m' },
      price: 1,
      condition: 'crosses-up',
      frequency: 'repeat',
    });
    const release = monitor.attach(store);
    const usable =
      store.list().some((rule: { id: string }) => rule.id === id) && !monitor.getState().destroyed;
    release();
    const children = host.childElementCount;
    store.destroy();
    monitor.destroy();
    host.remove();
    return { preserved, usable, children, calls };
  }, moduleUrls);
  expect(result.preserved).toBe(true);
  expect(result.usable).toBe(true);
  expect(result.children).toBe(0);
  expect(result.calls).toEqual({ seriesRemove: 0, paneRemove: 0, chartDestroy: 1, cleanup: 1 });
});
