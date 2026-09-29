import { resolve } from 'node:path';
import { expect, test, type CDPSession } from '@playwright/test';
// @ts-expect-error The evidence fixture is a plain JavaScript Node module.
import { buildGridScene } from '../../scripts/grid-oracle.mjs';
// @ts-expect-error The evidence collector is a plain JavaScript Node module.
import { collectEndpointReadiness } from '../../scripts/grid-resource-readiness.mjs';

test('real silent latest feeds recover through readiness collection and release on close', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.setTimeout(75_000);
  const scene = buildGridScene({ rowsPerCell: 256, seed: 20260922 });
  const main = '/@fs/' + resolve('examples/react-terminal/src/main.tsx').replaceAll('\\', '/');
  // Mount the actual consumer and fixture through the source-test Vite server.
  // This is functional coverage; installed all-mode evidence remains separate.
  await page.route('**/resource-readiness-test?*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('/resource-readiness-test?source=fixture&view=grid&test&grid-test&grid-benchmark');
  await page.addScriptTag({ type: 'module', url: main });
  await page.waitForFunction(
    () => (window as any).gridBenchmark?.ready && (window as any).gridHarness?.counts().mounted,
  );

  const evidence: Record<string, any> = {
    browserName,
    qualification:
      'Actual consumer/feed/collector functional regression; not installed performance or resource-growth acceptance.',
  };
  let cdp: CDPSession | undefined;
  let failure: unknown;
  try {
    if (browserName === 'chromium') cdp = await context.newCDPSession(page);
    await page.evaluate(() => (window as any).gridBenchmark.prepareEmpty());
    await page.evaluate((input) => (window as any).gridBenchmark.prepare(input), scene);
    await page.evaluate(() =>
      (window as any).gridBenchmark.act({
        id: 'readiness-functional-construct',
        kind: 'construct',
        phase: 'full',
        targetRows: 256,
      }),
    );
    evidence.initial = await page.evaluate(() => (window as any).gridBenchmark.resources('before-silence'));
    expect(evidence.initial.provider.historyFeeds).toBe(4);
    expect(evidence.initial.provider.latestFeeds).toBe(8);
    expect(
      new Set(
        evidence.initial.provider.subscriptions.map(
          (entry: any) => `${entry.providerGeneration}:${entry.subscriptionId}`,
        ),
      ).size,
    ).toBe(12);

    // Leave the real provider silent. The product's unchanged 15-second timer
    // closes latest subscriptions; history uses its existing longer timeout.
    const transient = await page.waitForFunction(
      () => {
        const snapshot = (window as any).gridBenchmark.resourceReadiness('full-mounted-initial');
        return snapshot.provider.latestFeeds < 8 ? snapshot : null;
      },
      undefined,
      { polling: 50, timeout: 30_000 },
    );
    evidence.transient = await transient.jsonValue();
    await transient.dispose();
    expect(evidence.transient.provider.historyFeeds).toBe(4);
    expect(evidence.transient.provider.latestFeeds).toBeLessThan(8);
    expect(
      evidence.transient.monitor.runtimes.some((entry: any) => entry.active && !entry.feed.activeConnection),
    ).toBe(true);

    const clock = () => performance.timeOrigin + performance.now();
    evidence.collected = await collectEndpointReadiness({
      label: 'full-mounted-initial',
      scene,
      now: clock,
      pause: (ms: number) => new Promise((done) => setTimeout(done, ms)),
      readPoll: (label: string) =>
        page.evaluate((name) => (window as any).gridBenchmark.resourceReadiness(name), label),
      readFull: (label: string) =>
        page.evaluate((name) => (window as any).gridBenchmark.resources(name), label),
      collectGc: async () => {
        const turns: number[] = [];
        for (let turn = 0; turn < 3; turn++) {
          await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 0)));
          if (cdp) await cdp.send('HeapProfiler.collectGarbage');
          turns.push(clock());
        }
        // Firefox/WebKit exercise the live-feed boundary with event-loop turns;
        // only Chromium performs CDP GC. No resource totals are fabricated.
        return { kind: 'functional-boundary', garbageCollected: Boolean(cdp), turns };
      },
    });
    const { readiness, post } = evidence.collected;
    expect(readiness.polls.some((entry: any) => !entry.ready)).toBe(true);
    expect(readiness.accepted).toBe(true);
    expect(readiness.clockDomains).toEqual({
      collector: 'node-performance-epoch-ms',
      snapshots: 'browser-performance-epoch-ms',
    });
    const requests = [
      ...readiness.polls.map((entry: any) => ({
        start: entry.requestStartedAt,
        end: entry.responseReceivedAt,
        browserAt: entry.snapshot.at,
      })),
      ...readiness.gcAttempts.flatMap((entry: any) => [
        {
          start: entry.preRequestStartedAt,
          end: entry.preResponseReceivedAt,
          browserAt: entry.pre.at,
        },
        {
          start: entry.postRequestStartedAt,
          end: entry.postResponseReceivedAt,
          browserAt: entry.post.at,
        },
      ]),
    ].sort((a: any, b: any) => a.start - b.start);
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      expect(Number.isFinite(request.start)).toBe(true);
      expect(Number.isFinite(request.end)).toBe(true);
      expect(Number.isFinite(request.browserAt)).toBe(true);
      expect(request.end).toBeGreaterThanOrEqual(request.start);
      if (index) {
        expect(request.start).toBeGreaterThanOrEqual(requests[index - 1].end);
        expect(request.browserAt).toBeGreaterThanOrEqual(requests[index - 1].browserAt);
      }
    }
    expect(post.provider.historyFeeds).toBe(4);
    expect(post.provider.latestFeeds).toBe(8);
    expect(post.provider.activeSubscriptions).toBe(12);
    expect(post.provider.pendingRequests).toBe(0);
    expect(post.cells.map((cell: any) => cell.rows)).toEqual([256, 256, 256, 256]);
    const last = readiness.gcAttempts.at(-1);
    expect(last.preAssessment.identities).toEqual(last.postAssessment.identities);
    expect(readiness.completedAt - readiness.startedAt).toBeLessThan(30_000);
    const historyKeys = new Set(
      scene.cells.map((cell: any) => JSON.stringify([cell.query.symbol, cell.query.interval])),
    );
    for (const key of historyKeys) {
      const matching = post.provider.subscriptions.filter((entry: any) => entry.key === key);
      const expectedCount =
        1 +
        scene.monitorSources.filter(
          (entry: any) => JSON.stringify([entry.query.symbol, entry.query.interval]) === key,
        ).length;
      expect(matching).toHaveLength(expectedCount);
      expect(new Set(matching.map((entry: any) => entry.subscriptionId)).size).toBe(expectedCount);
    }
  } catch (error) {
    failure = error;
    evidence.failure = String(error);
    evidence.failedReadiness = (error as any)?.readiness ?? null;
  } finally {
    try {
      evidence.closed = await page.evaluate(() => (window as any).gridBenchmark.close());
      expect(evidence.closed.after.provider.activeSubscriptions).toBe(0);
      expect(evidence.closed.after.provider.pendingRequests).toBe(0);
      expect(evidence.closed.after.monitor).toBeNull();
      expect(evidence.closed.after.gridState).toBeNull();
      expect(evidence.closed.borrowedUsable).toBe(true);
    } catch (error) {
      failure ??= error;
      evidence.cleanupFailure = String(error);
    }
    await cdp?.detach();
    await testInfo.attach('resource-readiness.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });
  }
  if (failure) throw failure;
});
